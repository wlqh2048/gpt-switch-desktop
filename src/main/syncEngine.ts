import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { SyncProgress, SyncSummary } from "../shared/types";
import { atomicWriteFile, ensureDir } from "./fsUtils";
import {
  createDefaultThreadHistoryAdapter,
  repairLegacyThreadHistory,
  ThreadHistoryAdapterLike,
  ThreadHistoryDatabaseLike,
} from "./threadHistoryRepair";

export interface ThreadRow {
  id: string;
  rollout_path: string;
  model_provider: string;
  cwd?: string;
  title?: string;
  first_user_message?: string;
  source?: string;
  updated_at?: number;
  updated_at_ms?: number;
  [key: string]: unknown;
}

export interface SqliteDatabaseLike {
  dbPath: string;
  hasThreads(): boolean;
  getColumns(): string[];
  readRows(options: { columns: string[]; offset: number; limit: number }): ThreadRow[];
  exec(sql: string): void;
  run(sql: string, values: unknown[]): void;
  close(): void;
}

export interface SqliteAdapterLike {
  discover(codexDir: string): string[];
  open(dbPath: string): SqliteDatabaseLike;
}

const REQUIRED_THREAD_COLUMNS = ["id", "rollout_path", "model_provider"];

interface ThreadStore {
  dbPath: string;
  db: SqliteDatabaseLike;
  columns: string[];
  rows: ThreadRow[];
  staleIds: string[];
  rolloutPathRepairs: Array<{ id: string; rolloutPath: string }>;
}

interface ThreadRecord {
  store: ThreadStore;
  row: ThreadRow;
  originalId: string;
  key: string;
}

interface SessionIndexCandidate {
  id: string;
  thread_name: string;
  updated_at: string;
}

const ROLLOUT_META_READ_BYTES = 128 * 1024;

function stripWindowsPrefix(value: string) {
  return value.startsWith("\\\\?\\") ? value.slice(4) : value;
}

function quoteIdent(name: string) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function rolloutBaseName(rolloutPath: string) {
  const parsed = path.parse(stripWindowsPrefix(String(rolloutPath || "")));
  const match = parsed.name.match(/^(rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-/);
  return match ? match[1] : parsed.name;
}

function normalizeCwd(cwd: unknown) {
  return String(cwd || "")
    .replace(/^\\\\\?\\/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

function groupKey(row: ThreadRow) {
  const base = rolloutBaseName(row.rollout_path);
  if (!base) return "";
  const createdMs = rowCreatedMs(row);
  if (createdMs > 0) {
    return `${base}\u0001${normalizeCwd(row.cwd)}\u0001${createdMs}`;
  }
  const rolloutPath = normalizeRolloutPath(row.rollout_path);
  return `${rolloutPath || base}\u0001${normalizeCwd(row.cwd)}`;
}

function rowUpdatedMs(row: ThreadRow) {
  const ms = Number(row.updated_at_ms || 0);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const sec = Number(row.updated_at || 0);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

function rowCreatedMs(row: ThreadRow) {
  const ms = Number(row.created_at_ms || 0);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const sec = Number(row.created_at || 0);
  return Number.isFinite(sec) && sec > 0 ? sec * 1000 : 0;
}

function normalizeRolloutPath(rolloutPath: unknown) {
  const rawPath = stripWindowsPrefix(String(rolloutPath || "").trim());
  return rawPath ? path.resolve(rawPath) : "";
}

function pickCanonical(rows: ThreadRow[]) {
  return rows.reduce((best, row) => {
    if (!best) return row;
    const diff = rowUpdatedMs(row) - rowUpdatedMs(best);
    if (diff !== 0) return diff > 0 ? row : best;
    return String(row.id) >= String(best.id) ? row : best;
  }, rows[0]);
}

function pickCanonicalRecord(records: ThreadRecord[]) {
  return records.reduce((best, record) => {
    if (!best) return record;
    const diff = rowUpdatedMs(record.row) - rowUpdatedMs(best.row);
    if (diff !== 0) return diff > 0 ? record : best;
    return String(record.row.id) >= String(best.row.id) ? record : best;
  }, records[0]);
}

function pickThreadName(row: ThreadRow) {
  return String(row.title || row.first_user_message || "").trim();
}

function candidateFromRow(row: ThreadRow): SessionIndexCandidate | null {
  const id = String(row.id || "").trim();
  const threadName = pickThreadName(row);
  if (!id || !threadName) return null;
  const updatedMs = rowUpdatedMs(row);
  return {
    id,
    thread_name: threadName,
    updated_at: updatedMs > 0 ? new Date(updatedMs).toISOString() : new Date().toISOString(),
  };
}

function canonicalIdForRow(row: ThreadRow, rolloutIndex: Awaited<ReturnType<typeof indexRolloutFiles>>) {
  const rowId = String(row.id || "").trim();
  const rolloutPath = normalizeRolloutPath(row.rollout_path);
  return rolloutIndex.sessionIdByPath.get(rolloutPath) || rowId;
}

function sourceValueForColumn(
  source: ThreadRow,
  target: ThreadRow | null,
  column: string,
  targetProvider: string,
  targetModel = "",
) {
  if (column === "model_provider") return targetProvider;
  if (column === "model" && targetModel) return targetModel;
  if (Object.prototype.hasOwnProperty.call(source, column)) return source[column] ?? null;
  if (target && Object.prototype.hasOwnProperty.call(target, column)) return target[column] ?? null;
  if (column === "source") return "cli";
  if (column === "cwd" || column === "title" || column === "sandbox_policy") return "";
  if (column === "approval_mode") return "never";
  if (
    column === "tokens_used" ||
    column === "has_user_event" ||
    column === "archived" ||
    column === "recency_at" ||
    column === "recency_at_ms" ||
    column === "is_pinned"
  ) {
    return 0;
  }
  if (column === "cli_version" || column === "first_user_message" || column === "preview") return "";
  if (column === "memory_mode") return "enabled";
  if (column === "history_mode") return "legacy";
  return null;
}

function insertRecord(store: ThreadStore, source: ThreadRecord, targetProvider: string, targetModel = "") {
  const values = store.columns.map((column) => sourceValueForColumn(source.row, null, column, targetProvider, targetModel));
  const updatableColumns = store.columns.filter((column) => column !== "id");
  const sql = `insert into threads (${store.columns.map(quoteIdent).join(", ")}) values (${store.columns
    .map(() => "?")
    .join(", ")}) on conflict(${quoteIdent("id")}) do update set ${updatableColumns
    .map((column) => `${quoteIdent(column)} = excluded.${quoteIdent(column)}`)
    .join(", ")}`;
  store.db.run(sql, values);
  store.rows.push(Object.fromEntries(store.columns.map((column, index) => [column, values[index]])) as ThreadRow);
}

function updateRecord(store: ThreadStore, target: ThreadRecord, source: ThreadRecord, targetProvider: string, targetModel = "") {
  const setColumns = store.columns.filter((column) => column !== "id");
  const values = setColumns.map((column) => sourceValueForColumn(source.row, target.row, column, targetProvider, targetModel));
  const sql = `update threads set ${setColumns.map((column) => `${quoteIdent(column)} = ?`).join(", ")} where id = ?`;
  store.db.run(sql, [...values, target.row.id]);
  for (const [index, column] of setColumns.entries()) {
    target.row[column] = values[index];
  }
}

function discoverSqliteFiles(codexDir: string) {
  const roots = [codexDir, path.join(codexDir, "sqlite")].map((item) => path.resolve(item));
  const out: string[] = [];
  const seen = new Set<string>();
  const sqliteExt = new Set([".sqlite", ".sqlite3", ".db"]);
  function walk(dirPath: string) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(fullPath);
      } else if (entry.isFile() && sqliteExt.has(path.extname(entry.name))) {
        const normalized = path.resolve(fullPath);
        if (!seen.has(normalized)) {
          seen.add(normalized);
          out.push(normalized);
        }
      }
    }
  }
  for (const root of roots) walk(root);
  return out.sort();
}

async function visitRolloutFiles(codexDir: string, visitor: (filePath: string) => Promise<void>) {
  const roots = ["sessions", "archived_sessions"].map((name) => path.join(codexDir, name));
  async function walk(dirPath: string) {
    let dir: fs.Dir | null = null;
    try {
      dir = fs.opendirSync(dirPath);
    } catch {
      return;
    }
    try {
      while (true) {
        const entry = dir.readSync();
        if (!entry) break;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
          await visitor(path.resolve(fullPath));
        }
      }
    } finally {
      try {
        dir.closeSync();
      } catch {}
    }
  }
  for (const root of roots) await walk(root);
}

async function indexRolloutFiles(codexDir: string) {
  const paths: string[] = [];
  const byBaseName = new Map<string, string[]>();
  const bySessionId = new Map<string, string[]>();
  const sessionIdByPath = new Map<string, string>();
  await visitRolloutFiles(codexDir, async (filePath) => {
    const normalized = path.resolve(filePath);
    paths.push(normalized);
    const baseName = path.basename(normalized);
    const baseBucket = byBaseName.get(baseName) || [];
    baseBucket.push(normalized);
    byBaseName.set(baseName, baseBucket);
    const sessionId = readRolloutSessionId(normalized);
    if (sessionId) {
      sessionIdByPath.set(normalized, sessionId);
      const idBucket = bySessionId.get(sessionId) || [];
      idBucket.push(normalized);
      bySessionId.set(sessionId, idBucket);
    }
  });
  return { paths, byBaseName, bySessionId, sessionIdByPath };
}

function readRolloutSessionId(filePath: string) {
  const rawPath = stripWindowsPrefix(String(filePath || ""));
  if (!rawPath || !fs.existsSync(rawPath)) return "";
  let fd: number | null = null;
  try {
    const stat = fs.statSync(rawPath);
    const size = Math.min(ROLLOUT_META_READ_BYTES, stat.size);
    if (size <= 0) return "";
    fd = fs.openSync(rawPath, "r");
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    for (const line of buffer.toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
          return String(entry.payload.id || entry.payload.thread_id || "").trim();
        }
      } catch {}
    }
  } catch {
    return "";
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
    }
  }
  return "";
}

function pickRolloutPath(
  candidates: string[] | undefined,
  rowId: string,
  originalPath: string,
  rolloutIndex: Awaited<ReturnType<typeof indexRolloutFiles>>,
) {
  const originalBase = path.basename(originalPath);
  const compatible = [...new Set(candidates || [])].filter((candidate) => {
    if (!fs.existsSync(candidate)) return false;
    const sessionId = rolloutIndex.sessionIdByPath.get(candidate);
    return !rowId || !sessionId || sessionId === rowId;
  });
  if (compatible.length === 0) return "";
  const sameBase = compatible.find((candidate) => path.basename(candidate) === originalBase);
  if (sameBase) return sameBase;
  return compatible.reduce((best, candidate) => {
    const bestMtime = fs.statSync(best).mtimeMs || 0;
    const candidateMtime = fs.statSync(candidate).mtimeMs || 0;
    if (candidateMtime !== bestMtime) return candidateMtime > bestMtime ? candidate : best;
    return candidate > best ? candidate : best;
  }, compatible[0]);
}

function resolveExistingRolloutPath(row: ThreadRow, rolloutIndex: Awaited<ReturnType<typeof indexRolloutFiles>>) {
  const normalized = normalizeRolloutPath(row.rollout_path);
  if (!normalized) return "";
  if (fs.existsSync(normalized)) return normalized;
  const rowId = String(row.id || "").trim();
  const relocatedByName = pickRolloutPath(rolloutIndex.byBaseName.get(path.basename(normalized)), rowId, normalized, rolloutIndex);
  if (relocatedByName) return relocatedByName;
  return pickRolloutPath(rolloutIndex.bySessionId.get(rowId), rowId, normalized, rolloutIndex);
}

function createNodeSqliteAdapter(): SqliteAdapterLike | null {
  let DatabaseSync: any = null;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  return {
    discover: discoverSqliteFiles,
    open(dbPath: string): SqliteDatabaseLike {
      const db = new DatabaseSync(dbPath);
      return {
        dbPath,
        hasThreads() {
          return Boolean(
            db.prepare("select name from sqlite_schema where type='table' and name='threads'").get(),
          );
        },
        getColumns() {
          return db.prepare("pragma table_info(threads)").all().map((column: { name: string }) => column.name);
        },
        readRows({ columns, offset, limit }) {
          return db
            .prepare(`select ${columns.map(quoteIdent).join(", ")} from threads limit ? offset ?`)
            .all(limit, offset);
        },
        exec(sql) {
          db.exec(sql);
        },
        run(sql, values) {
          db.prepare(sql).run(...values);
        },
        close() {
          db.close();
        },
      };
    },
  };
}

function sqliteLiteral(value: unknown) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function bindSqliteValues(sql: string, values: unknown[]) {
  let index = 0;
  const bound = sql.replace(/\?/g, () => {
    if (index >= values.length) throw new Error("sqlite bind value missing");
    const value = sqliteLiteral(values[index]);
    index += 1;
    return value;
  });
  if (index !== values.length) throw new Error("sqlite bind value count mismatch");
  return bound;
}

function readSqliteJson(dbPath: string, sql: string) {
  const output = execFileSync("sqlite3", ["-batch", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function execSqlite(dbPath: string, sql: string) {
  execFileSync("sqlite3", ["-batch", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
}

function createCliSqliteAdapter(): SqliteAdapterLike | null {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  return {
    discover: discoverSqliteFiles,
    open(dbPath: string): SqliteDatabaseLike {
      return {
        dbPath,
        hasThreads() {
          return readSqliteJson(
            dbPath,
            "select name from sqlite_schema where type='table' and name='threads' limit 1",
          ).length > 0;
        },
        getColumns() {
          return readSqliteJson(dbPath, "pragma table_info(threads)").map((column: { name: string }) => column.name);
        },
        readRows({ columns, offset, limit }) {
          return readSqliteJson(
            dbPath,
            `select ${columns.map(quoteIdent).join(", ")} from threads limit ${sqliteLiteral(limit)} offset ${sqliteLiteral(
              offset,
            )}`,
          );
        },
        exec(sql) {
          if (/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) return;
          execSqlite(dbPath, sql);
        },
        run(sql, values) {
          execSqlite(dbPath, bindSqliteValues(sql, values));
        },
        close() {},
      };
    },
  };
}

function createDefaultSqliteAdapter() {
  return createNodeSqliteAdapter() || createCliSqliteAdapter();
}

function parseTimestamp(line: string) {
  try {
    const obj = JSON.parse(line);
    const parsed = Date.parse(obj?.timestamp || "");
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function setField(record: Record<string, any>, field: string, value: string, existingOnly = false) {
  if (!value) return false;
  if (existingOnly && !Object.prototype.hasOwnProperty.call(record, field)) return false;
  if (record[field] === value) return false;
  record[field] = value;
  return true;
}

function normalizeNestedModel(record: unknown, model: string) {
  return isRecord(record) ? setField(record, "model", model, true) : false;
}

function providerId(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function sanitizeForeignReasoningItem(item: unknown) {
  if (!isRecord(item) || item.type !== "reasoning" || !Array.isArray(item.content)) return false;
  let changed = false;
  if (item.content.length > 0) {
    item.content = [];
    changed = true;
  }
  if (Object.prototype.hasOwnProperty.call(item, "encrypted_content")) {
    delete item.encrypted_content;
    changed = true;
  }
  return changed;
}

function sanitizeForeignReasoningItems(items: unknown) {
  if (!Array.isArray(items)) return false;
  let changed = false;
  for (const item of items) {
    changed = sanitizeForeignReasoningItem(item) || changed;
  }
  return changed;
}

export async function readRolloutInfo(filePath: string) {
  const rawPath = stripWindowsPrefix(String(filePath || ""));
  if (!rawPath || !fs.existsSync(rawPath)) {
    return { exists: false, lineCount: 0, latestMs: 0, mtimeMs: 0 };
  }
  const stat = fs.statSync(rawPath);
  let lineCount = 0;
  let latestMs = 0;
  const reader = readline.createInterface({
    input: fs.createReadStream(rawPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (!line.trim()) continue;
    lineCount += 1;
    const ts = parseTimestamp(line);
    if (ts > 0) latestMs = ts;
  }
  return { exists: true, lineCount, latestMs, mtimeMs: stat.mtimeMs || 0 };
}

export async function normalizeRolloutMetaProvider(
  filePath: string,
  targetProvider: string,
  targetModel = "",
) {
  const rawPath = stripWindowsPrefix(String(filePath || ""));
  const provider = String(targetProvider || "").trim();
  const model = String(targetModel || "").trim();
  if (!rawPath || !provider || !fs.existsSync(rawPath)) {
    return { scanned: false, changed: false };
  }
  const tmpPath = `${rawPath}.tmp.${process.pid}.${Date.now()}`;
  let changed = false;
  let scanned = 0;
  let sourceProvider = "";
  let providerChanged = false;
  ensureDir(path.dirname(rawPath));
  const writer = fs.createWriteStream(tmpPath, { encoding: "utf8" });
  const reader = readline.createInterface({
    input: fs.createReadStream(rawPath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        writer.write("\n");
        continue;
      }
      scanned += 1;
      let nextLine = line;
      try {
        const entry = JSON.parse(line);
        let lineChanged = false;
        if (entry?.type === "session_meta" && entry.payload && typeof entry.payload === "object") {
          const currentProvider = providerId(entry.payload.model_provider);
          if (!sourceProvider && currentProvider) {
            sourceProvider = currentProvider;
            providerChanged = currentProvider !== provider;
          }
          lineChanged = setField(entry.payload, "model_provider", provider) || lineChanged;
          if (isRecord(entry.payload.base_instructions?.provenance)) {
            lineChanged = setField(entry.payload.base_instructions.provenance, "model", model, true) || lineChanged;
          }
        } else if (providerChanged && entry?.type === "response_item" && entry.payload?.type === "reasoning") {
          lineChanged = sanitizeForeignReasoningItem(entry.payload) || lineChanged;
        } else if (entry?.type === "event_msg" && entry.payload && typeof entry.payload === "object") {
          const threadSettings = entry.payload.thread_settings;
          if (threadSettings && typeof threadSettings === "object" && !Array.isArray(threadSettings)) {
            lineChanged = setField(threadSettings, "model_provider_id", provider) || lineChanged;
            lineChanged = setField(threadSettings, "model_provider", provider, true) || lineChanged;
            lineChanged = setField(threadSettings, "model", model) || lineChanged;
            const collaborationSettings = threadSettings.collaboration_mode?.settings;
            lineChanged = normalizeNestedModel(collaborationSettings, model) || lineChanged;
          }
        } else if (providerChanged && entry?.type === "compacted" && isRecord(entry.payload)) {
          lineChanged = sanitizeForeignReasoningItems(entry.payload.replacement_history) || lineChanged;
        } else if (entry?.type === "world_state" && entry.payload && typeof entry.payload === "object") {
          const state = entry.payload.state;
          if (isRecord(state)) {
            lineChanged = normalizeNestedModel(state, model) || lineChanged;
            lineChanged = normalizeNestedModel(state.collaboration_mode, model) || lineChanged;
            lineChanged = normalizeNestedModel(state.personality, model) || lineChanged;
          }
        } else if (entry?.type === "turn_context" && entry.payload && typeof entry.payload === "object") {
          lineChanged = normalizeNestedModel(entry.payload, model) || lineChanged;
          const collaborationSettings = entry.payload.collaboration_mode?.settings;
          lineChanged = normalizeNestedModel(collaborationSettings, model) || lineChanged;
        }
        if (lineChanged) {
          changed = true;
          nextLine = JSON.stringify(entry);
          const removedBytes = Buffer.byteLength(line) - Buffer.byteLength(nextLine);
          if (removedBytes > 0) nextLine += " ".repeat(removedBytes);
        }
      } catch {
        nextLine = line;
      }
      writer.write(`${nextLine}\n`);
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writer.end(() => resolve());
      writer.on("error", reject);
    });
  }

  if (!changed) {
    fs.unlinkSync(tmpPath);
    return { scanned: true, changed: false, scannedLines: scanned };
  }
  fs.renameSync(tmpPath, rawPath);
  return { scanned: true, changed: true, scannedLines: scanned };
}

function newerIndexEntry(left: Record<string, unknown>, right: Record<string, unknown>) {
  const leftTime = Date.parse(String(left.updated_at || "")) || 0;
  const rightTime = Date.parse(String(right.updated_at || "")) || 0;
  return rightTime >= leftTime ? right : left;
}

export async function rebuildSessionIndex(
  codexDir: string,
  aliases: Map<string, string>,
  candidates: SessionIndexCandidate[] = [],
  removedIds: Set<string> = new Set(),
) {
  const indexPath = path.join(codexDir, "session_index.jsonl");
  if (!fs.existsSync(indexPath) && aliases.size === 0 && candidates.length === 0 && removedIds.size === 0) {
    return { changed: false, entries: 0 };
  }
  const byId = new Map<string, Record<string, unknown>>();
  let changed = false;
  let backfilled = 0;

  if (fs.existsSync(indexPath)) {
    const reader = readline.createInterface({
      input: fs.createReadStream(indexPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of reader) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        const oldId = String(entry.id || "");
        if (!oldId) continue;
        const nextId = aliases.get(oldId) || oldId;
        if (removedIds.has(oldId) || removedIds.has(nextId)) {
          changed = true;
          continue;
        }
        if (nextId !== oldId) changed = true;
        const nextEntry = { ...entry, id: nextId };
        const previous = byId.get(nextId);
        byId.set(nextId, previous ? newerIndexEntry(previous, nextEntry) : nextEntry);
      } catch {
        changed = true;
      }
    }
  }

  for (const candidate of candidates) {
    const oldId = String(candidate.id || "").trim();
    const nextId = aliases.get(oldId) || oldId;
    const threadName = String(candidate.thread_name || "").trim();
    if (removedIds.has(oldId) || removedIds.has(nextId)) continue;
    if (!nextId || !threadName) continue;
    const nextEntry = {
      id: nextId,
      thread_name: threadName,
      updated_at: candidate.updated_at || new Date().toISOString(),
    };
    const previous = byId.get(nextId);
    if (!previous) {
      byId.set(nextId, nextEntry);
      changed = true;
      backfilled += 1;
      continue;
    }
    const newer = newerIndexEntry(previous, nextEntry);
    if (newer !== previous) {
      byId.set(nextId, newer);
      changed = true;
    }
  }

  if (!changed) {
    return { changed: false, entries: byId.size, backfilled };
  }
  const payload = [...byId.values()].map((entry) => JSON.stringify(entry)).join("\n");
  atomicWriteFile(indexPath, payload ? `${payload}\n` : "");
  return { changed: true, entries: byId.size, backfilled };
}

function readGlobalState(codexDir: string) {
  const statePath = path.join(codexDir, ".codex-global-state.json");
  if (!fs.existsSync(statePath)) return null;
  try {
    return { path: statePath, value: JSON.parse(fs.readFileSync(statePath, "utf8")) as Record<string, unknown> };
  } catch {
    return null;
  }
}

function addThreadId(out: Set<string>, value: unknown) {
  const id = String(value || "").trim();
  if (id) out.add(id);
}

function addThreadIdsFromArray(out: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item === "string") addThreadId(out, item);
  }
}

function addThreadIdsFromMapKeys(out: Set<string>, value: unknown) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) addThreadId(out, key);
}

function addThreadIdsFromArrayMap(out: Set<string>, value: unknown) {
  if (!isRecord(value)) return;
  for (const ids of Object.values(value)) addThreadIdsFromArray(out, ids);
}

function extractAtomThreadId(key: string) {
  const rawKey = String(key || "");
  const decodedKey = (() => {
    try {
      return decodeURIComponent(rawKey);
    } catch {
      return rawKey;
    }
  })();
  for (const prefix of ["thread-tab-routes-v1:", "thread-reference-capability:"]) {
    if (decodedKey.startsWith(prefix)) return decodedKey.slice(prefix.length).trim();
  }
  const clientPrefix = "thread-client-id-v1:";
  if (decodedKey.startsWith(clientPrefix)) {
    const suffix = decodedKey.slice(clientPrefix.length).trim();
    const parts = suffix.split(":").filter(Boolean);
    return (parts[parts.length - 1] || suffix).trim();
  }
  return "";
}

function collectSessionIndexIds(codexDir: string) {
  const ids = new Set<string>();
  const indexPath = path.join(codexDir, "session_index.jsonl");
  if (!fs.existsSync(indexPath)) return ids;
  for (const line of fs.readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      addThreadId(ids, entry?.id);
    } catch {}
  }
  return ids;
}

function collectGlobalThreadReferenceIds(codexDir: string) {
  const ids = new Set<string>();
  const globalState = readGlobalState(codexDir);
  if (!globalState) return ids;
  const state = globalState.value;
  for (const key of ["pinned-thread-ids", "projectless-thread-ids"]) {
    addThreadIdsFromArray(ids, state[key]);
  }
  for (const key of [
    "thread-project-assignments",
    "thread-workspace-root-hints",
    "thread-projectless-output-directories",
    "electron-remote-hosted-pip-task-visibility-state",
  ]) {
    addThreadIdsFromMapKeys(ids, state[key]);
  }
  for (const key of ["app-server-migrated-pinned-thread-ids-by-host", "sidebar-project-thread-orders"]) {
    addThreadIdsFromArrayMap(ids, state[key]);
  }

  const atomState = state["electron-persisted-atom-state"];
  if (!isRecord(atomState)) return ids;
  for (const key of ["heartbeat-thread-permissions-by-id", "prompt-history"]) {
    addThreadIdsFromMapKeys(ids, atomState[key]);
  }
  for (const key of Object.keys(atomState)) {
    addThreadId(ids, extractAtomThreadId(key));
  }
  return ids;
}

function collectOrphanThreadReferenceIds(codexDir: string, knownIds: Set<string>) {
  const ids = new Set([...collectSessionIndexIds(codexDir), ...collectGlobalThreadReferenceIds(codexDir)]);
  const out = new Set<string>();
  for (const id of ids) {
    if (!knownIds.has(id)) out.add(id);
  }
  return out;
}

function mapThreadId(id: string, aliases: Map<string, string>, removedIds: Set<string>) {
  const rawId = String(id || "");
  if (!rawId) return { changed: false, removed: false, id: rawId };
  const mappedId = aliases.get(rawId) || rawId;
  if (removedIds.has(rawId) || removedIds.has(mappedId)) {
    return { changed: true, removed: true, id: "" };
  }
  return { changed: mappedId !== rawId, removed: false, id: mappedId };
}

function remapEmbeddedThreadKey(key: string, aliases: Map<string, string>, removedIds: Set<string>) {
  const affectedIds = new Set([...aliases.keys(), ...aliases.values(), ...removedIds]);
  let nextKey = key;
  let changed = false;
  for (const id of affectedIds) {
    if (!id || !nextKey.includes(id)) continue;
    const mappedId = aliases.get(id) || id;
    if (removedIds.has(id) || removedIds.has(mappedId)) {
      return { changed: true, removed: true, key: "" };
    }
    if (mappedId !== id) {
      nextKey = nextKey.split(id).join(mappedId);
      changed = true;
    }
  }
  return { changed, removed: false, key: nextKey };
}

function remapThreadReferences(
  value: unknown,
  aliases: Map<string, string>,
  removedIds: Set<string>,
): { value: unknown; changed: boolean; removed: boolean } {
  if (typeof value === "string") {
    const mapped = mapThreadId(value, aliases, removedIds);
    return { value: mapped.id, changed: mapped.changed, removed: mapped.removed };
  }
  if (Array.isArray(value)) {
    const next: unknown[] = [];
    const seenStrings = new Set<string>();
    let changed = false;
    for (const item of value) {
      const mapped = remapThreadReferences(item, aliases, removedIds);
      changed = changed || mapped.changed || mapped.removed;
      if (mapped.removed) continue;
      if (typeof mapped.value === "string") {
        if (seenStrings.has(mapped.value)) {
          changed = true;
          continue;
        }
        seenStrings.add(mapped.value);
      }
      next.push(mapped.value);
    }
    if (next.length !== value.length) changed = true;
    return { value: next, changed, removed: false };
  }
  if (!isRecord(value)) {
    return { value, changed: false, removed: false };
  }

  const next: Record<string, unknown> = {};
  let changed = false;
  for (const [key, child] of Object.entries(value)) {
    const mappedKey = remapEmbeddedThreadKey(key, aliases, removedIds);
    changed = changed || mappedKey.changed || mappedKey.removed;
    if (mappedKey.removed) continue;
    const mappedValue = remapThreadReferences(child, aliases, removedIds);
    changed = changed || mappedValue.changed || mappedValue.removed;
    if (mappedValue.removed) continue;
    if (Object.prototype.hasOwnProperty.call(next, mappedKey.key)) {
      changed = true;
    }
    next[mappedKey.key] = mappedValue.value;
  }
  return { value: next, changed, removed: false };
}

function remapGlobalThreadIds(codexDir: string, aliases: Map<string, string>, removedIds: Set<string> = new Set()) {
  if (aliases.size === 0 && removedIds.size === 0) return false;
  const globalState = readGlobalState(codexDir);
  if (!globalState) return false;
  const result = remapThreadReferences(globalState.value, aliases, removedIds);
  if (!result.changed || !isRecord(result.value)) return false;
  globalState.value = result.value;
  atomicWriteFile(globalState.path, `${JSON.stringify(globalState.value, null, 2)}\n`);
  return true;
}

function rssMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

export async function syncThreadVisibility({
  codexDir,
  targetProvider,
  targetModel,
  sqliteAdapter,
  threadHistoryAdapter,
  batchSize = 250,
  rolloutQueueLimit = 50,
  onProgress,
}: {
  codexDir: string;
  targetProvider: string;
  targetModel?: string;
  sqliteAdapter?: SqliteAdapterLike | null;
  threadHistoryAdapter?: ThreadHistoryAdapterLike | null;
  batchSize?: number;
  rolloutQueueLimit?: number;
  onProgress?: (progress: SyncProgress) => void;
}): Promise<SyncSummary> {
  const provider = String(targetProvider || "").trim();
  const model = String(targetModel || "").trim();
  const runId = `sync-${Date.now()}`;
  const errors: string[] = [];
  const summary: SyncSummary = {
    skipped: false,
    sqliteFiles: 0,
    normalizedRows: 0,
    dedupedRows: 0,
    staleRowsRemoved: 0,
    orphanStateRefsRemoved: 0,
    rolloutPathsRepaired: 0,
    rolloutMetaScanned: 0,
    rolloutMetaUpdated: 0,
    legacyRolloutsDetected: 0,
    legacyReasoningRowsRestored: 0,
    threadHistoryProjectionsReset: 0,
    repairBackupsCreated: 0,
    indexChanged: false,
    pinnedChanged: false,
    errors,
  };
  if (!provider) {
    return { ...summary, skipped: true };
  }
  const adapter = sqliteAdapter === undefined ? createDefaultSqliteAdapter() : sqliteAdapter;
  if (!adapter) {
    errors.push("sqlite is not available");
  }
  const repairAdapter = threadHistoryAdapter === undefined
    ? createDefaultThreadHistoryAdapter()
    : threadHistoryAdapter;
  let historyDatabase: ThreadHistoryDatabaseLike | null = null;
  if (repairAdapter) {
    try {
      const historyPaths = repairAdapter.discover(codexDir);
      const historyPath = historyPaths.at(-1);
      if (historyPath) historyDatabase = repairAdapter.open(historyPath);
    } catch (error) {
      errors.push(`open thread history: ${(error as Error).message}`);
    }
  }

  const progress = (phase: string, message: string, processed: number, currentPath = "") => {
    onProgress?.({ runId, phase, processed, currentPath, rssMb: rssMb(), message });
  };

  let dbPaths: string[] = [];
  if (adapter) {
    try {
      dbPaths = adapter.discover(codexDir);
    } catch (error) {
      errors.push(`discover sqlite: ${(error as Error).message}`);
    }
  }
  summary.sqliteFiles = dbPaths.length;
  const aliases = new Map<string, string>();
  const stores: ThreadStore[] = [];
  const records: ThreadRecord[] = [];
  const indexCandidates: SessionIndexCandidate[] = [];
  const rolloutQueue: string[] = [];
  const queuedRolloutPaths = new Set<string>();
  const maxRolloutQueue = Math.max(1, Math.floor(Number(rolloutQueueLimit) || 50));
  const rolloutPathIndex = await indexRolloutFiles(codexDir);
  const staleIds = new Set<string>();
  const validIds = new Set<string>();
  let rolloutIndex = 0;
  progress("scan", "扫描 ChatGPT 线程数据库", 0);

  const flushRolloutQueue = async () => {
    while (rolloutQueue.length > 0) {
      const rolloutPath = rolloutQueue.shift()!;
      rolloutIndex += 1;
      progress("rollout", "同步消息文件元数据", rolloutIndex, rolloutPath);
      try {
        const result = await normalizeRolloutMetaProvider(rolloutPath, provider, model);
        if (result.scanned) summary.rolloutMetaScanned += 1;
        if (result.changed) summary.rolloutMetaUpdated += 1;
        progress("repair", "检查旧版消息投影", rolloutIndex, rolloutPath);
        const repair = await repairLegacyThreadHistory({
          codexDir,
          rolloutPath,
          historyAdapter: null,
          historyDatabase: historyDatabase || undefined,
        });
        if (repair.detected) summary.legacyRolloutsDetected += 1;
        summary.legacyReasoningRowsRestored += repair.reasoningRowsRestored;
        if (repair.projectionReset) summary.threadHistoryProjectionsReset += 1;
        if (repair.backupCreated) summary.repairBackupsCreated += 1;
        if (repair.rejectionReason) errors.push(`${rolloutPath}: ${repair.rejectionReason}`);
      } catch (error) {
        errors.push(`${rolloutPath}: ${(error as Error).message}`);
      }
    }
  };

  const queueRolloutPath = async (rolloutPath: string) => {
    const rawPath = stripWindowsPrefix(String(rolloutPath || "")).trim();
    if (!rawPath) return;
    const normalized = path.resolve(rawPath);
    if (queuedRolloutPaths.has(normalized)) return;
    queuedRolloutPaths.add(normalized);
    rolloutQueue.push(normalized);
    if (rolloutQueue.length >= maxRolloutQueue) {
      await flushRolloutQueue();
    }
  };

  if (adapter) {
    for (const dbPath of dbPaths) {
      let db: SqliteDatabaseLike | null = null;
      try {
        db = adapter.open(dbPath);
        if (!db.hasThreads()) {
          db.close();
          db = null;
          continue;
        }
        const columns = db.getColumns();
        if (!REQUIRED_THREAD_COLUMNS.every((column) => columns.includes(column))) {
          db.close();
          db = null;
          continue;
        }
        const store: ThreadStore = { dbPath, db, columns, rows: [], staleIds: [], rolloutPathRepairs: [] };
        let offset = 0;
        while (true) {
          const rows = db.readRows({ columns, offset, limit: batchSize });
          if (!rows.length) break;
          for (const row of rows) {
            summary.normalizedRows += 1;
            const id = String(row.id || "").trim();
            const originalRolloutPath = normalizeRolloutPath(row.rollout_path);
            const resolvedRolloutPath = resolveExistingRolloutPath(row, rolloutPathIndex);
            if (!resolvedRolloutPath) {
              if (id) {
                staleIds.add(id);
                store.staleIds.push(id);
              }
              continue;
            }
            const resolvedRow: ThreadRow = { ...row, rollout_path: resolvedRolloutPath };
            const canonicalId = canonicalIdForRow(resolvedRow, rolloutPathIndex) || id;
            if (id && canonicalId && id !== canonicalId) {
              aliases.set(id, canonicalId);
            }
            if (canonicalId) validIds.add(canonicalId);
            if (originalRolloutPath !== resolvedRolloutPath) {
              if (id) store.rolloutPathRepairs.push({ id, rolloutPath: resolvedRolloutPath });
            }
            resolvedRow.id = canonicalId;
            store.rows.push(resolvedRow);
            const key = groupKey(resolvedRow);
            if (key) {
              records.push({ store, row: resolvedRow, originalId: id, key });
            }
            const candidate = candidateFromRow(resolvedRow);
            if (candidate) {
              indexCandidates.push(candidate);
            }
            await queueRolloutPath(resolvedRolloutPath);
          }
          offset += rows.length;
          progress("scan", "扫描线程记录", summary.normalizedRows, dbPath);
          if (rows.length < batchSize) break;
        }
        stores.push(store);
        db = null;
      } catch (error) {
        errors.push(`${dbPath}: ${(error as Error).message}`);
        try {
          db?.close();
        } catch {}
      }
    }

    const groups = new Map<string, ThreadRecord[]>();
    for (const record of records) {
      const bucket = groups.get(record.key) || [];
      bucket.push(record);
      groups.set(record.key, bucket);
    }

    try {
      for (const store of stores) store.db.exec("BEGIN");
      for (const store of stores) {
        for (const repair of store.rolloutPathRepairs) {
          store.db.run("update threads set rollout_path = ? where id = ?", [repair.rolloutPath, repair.id]);
          summary.rolloutPathsRepaired += 1;
        }
        for (const id of store.staleIds) {
          store.db.run("delete from threads where id = ?", [id]);
          summary.staleRowsRemoved += 1;
        }
      }
      for (const group of groups.values()) {
        const source = pickCanonicalRecord(group);
        const recordsByStore = new Map<string, ThreadRecord[]>();
        for (const record of group) {
          const bucket = recordsByStore.get(record.store.dbPath) || [];
          bucket.push(record);
          recordsByStore.set(record.store.dbPath, bucket);
        }

        for (const store of stores) {
          const localRecords = recordsByStore.get(store.dbPath) || [];
          if (localRecords.length === 0) {
            insertRecord(store, source, provider, model);
            continue;
          }
          const canonicalId = String(source.row.id || "").trim();
          const keeper = localRecords.find((record) => record.originalId === canonicalId);
          if (keeper) {
            updateRecord(store, keeper, source, provider, model);
          } else {
            insertRecord(store, source, provider, model);
          }
          for (const record of localRecords) {
            if (record.originalId === canonicalId) continue;
            aliases.set(record.originalId, canonicalId);
            store.db.run("delete from threads where id = ?", [record.originalId]);
            summary.dedupedRows += 1;
          }
        }
      }
      for (const store of stores) {
        if (model && store.columns.includes("model")) {
          store.db.run("update threads set model_provider = ?, model = ?", [provider, model]);
        } else {
          store.db.run("update threads set model_provider = ?", [provider]);
        }
      }
      for (const store of stores) store.db.exec("COMMIT");
    } catch (error) {
      errors.push(`sync sqlite stores: ${(error as Error).message}`);
      for (const store of stores) {
        try {
          store.db.exec("ROLLBACK");
        } catch {}
      }
    } finally {
      for (const store of stores) {
        try {
          store.db.close();
        } catch {}
      }
    }
  }

  for (const rolloutPath of rolloutPathIndex.paths) {
    await queueRolloutPath(rolloutPath);
  }
  await flushRolloutQueue();

  const knownIds = new Set<string>([
    ...validIds,
    ...rolloutPathIndex.sessionIdByPath.values(),
    ...aliases.keys(),
    ...aliases.values(),
  ]);
  const removedIds = new Set([...staleIds].filter((id) => !validIds.has(id)));
  const orphanIds = collectOrphanThreadReferenceIds(codexDir, knownIds);
  for (const id of orphanIds) {
    if (removedIds.has(id)) continue;
    removedIds.add(id);
    summary.orphanStateRefsRemoved += 1;
  }
  const index = await rebuildSessionIndex(codexDir, aliases, indexCandidates, removedIds);
  summary.indexChanged = index.changed;
  summary.pinnedChanged = remapGlobalThreadIds(codexDir, aliases, removedIds);
  try {
    historyDatabase?.close();
  } catch (error) {
    errors.push(`close thread history: ${(error as Error).message}`);
  }
  progress("done", "消息同步完成", summary.normalizedRows);
  return summary;
}
