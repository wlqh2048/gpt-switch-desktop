import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface ThreadHistoryProjection {
  nextRolloutByteOffset: number;
  nextRolloutOrdinal: number;
}

export interface LegacyRolloutGap {
  ordinal: number;
  insertBeforeOffset: number;
  timestamp: string;
  reasoningId: string;
}

export interface LegacyRolloutInspection {
  eligible: boolean;
  threadId: string;
  gaps: LegacyRolloutGap[];
  finalOrdinal: number;
  fileSize: number;
  projectionMatches: boolean;
  rejectionReason?: string;
}

export interface ThreadHistoryDatabaseLike {
  dbPath: string;
  getProjection(threadId: string): ThreadHistoryProjection | null;
  resetThread(threadId: string): void;
  close(): void;
}

export interface ThreadHistoryAdapterLike {
  discover(codexDir: string): string[];
  open(dbPath: string): ThreadHistoryDatabaseLike;
}

export interface LegacyThreadRepairResult {
  detected: boolean;
  reasoningRowsRestored: number;
  projectionReset: boolean;
  backupCreated: boolean;
  backupDir?: string;
  rejectionReason?: string;
}

interface RawJsonlLine {
  raw: Buffer;
  startOffset: number;
  endOffset: number;
  hadNewline: boolean;
}

interface JsonRecord {
  timestamp?: unknown;
  ordinal?: unknown;
  type?: unknown;
  payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function writeAllSync(fd: number, content: Buffer) {
  let offset = 0;
  while (offset < content.length) {
    const written = fs.writeSync(fd, content, offset, content.length - offset);
    if (written <= 0) throw new Error("failed to advance rollout repair write");
    offset += written;
  }
}

async function* readRawJsonlLines(filePath: string): AsyncGenerator<RawJsonlLine> {
  let pending = Buffer.alloc(0);
  let pendingStartOffset = 0;
  for await (const rawChunk of fs.createReadStream(filePath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
    const dataStartOffset = pendingStartOffset;
    let lineStart = 0;
    while (true) {
      const newline = data.indexOf(0x0a, lineStart);
      if (newline < 0) break;
      yield {
        raw: data.subarray(lineStart, newline),
        startOffset: dataStartOffset + lineStart,
        endOffset: dataStartOffset + newline + 1,
        hadNewline: true,
      };
      lineStart = newline + 1;
    }
    pending = Buffer.from(data.subarray(lineStart));
    pendingStartOffset = dataStartOffset + lineStart;
  }
  if (pending.length > 0) {
    yield {
      raw: pending,
      startOffset: pendingStartOffset,
      endOffset: pendingStartOffset + pending.length,
      hadNewline: false,
    };
  }
}

function completedReasoningId(entry: JsonRecord) {
  if (entry.type !== "event_msg" || !isRecord(entry.payload) || entry.payload.type !== "item_completed") {
    return "";
  }
  const item = entry.payload.item;
  if (!isRecord(item) || String(item.type || "").toLowerCase() !== "reasoning") return "";
  return typeof item.id === "string" ? item.id.trim() : "";
}

function rejectedInspection({
  threadId,
  gaps,
  finalOrdinal,
  fileSize,
  projectionMatches,
  rejectionReason,
}: Omit<LegacyRolloutInspection, "eligible">): LegacyRolloutInspection {
  return {
    eligible: false,
    threadId,
    gaps,
    finalOrdinal,
    fileSize,
    projectionMatches,
    rejectionReason,
  };
}

export async function inspectLegacyRollout(
  filePath: string,
  projection: ThreadHistoryProjection | null,
): Promise<LegacyRolloutInspection> {
  const fileSize = fs.statSync(filePath).size;
  const gaps: LegacyRolloutGap[] = [];
  let threadId = "";
  let finalOrdinal = -1;
  let previousEntry: JsonRecord | null = null;
  let previousOrdinal: number | null = null;
  let projectionOrdinalOffset: number | null = null;
  let lineIndex = 0;

  for await (const line of readRawJsonlLines(filePath)) {
    const parseBuffer = line.raw.length > 0 && line.raw[line.raw.length - 1] === 0x0d
      ? line.raw.subarray(0, line.raw.length - 1)
      : line.raw;
    if (parseBuffer.length === 0 || !parseBuffer.toString("utf8").trim()) {
      return rejectedInspection({
        threadId,
        gaps,
        finalOrdinal,
        fileSize,
        projectionMatches: false,
        rejectionReason: `blank line at byte ${line.startOffset}`,
      });
    }

    let entry: JsonRecord;
    try {
      entry = JSON.parse(parseBuffer.toString("utf8")) as JsonRecord;
    } catch (error) {
      return rejectedInspection({
        threadId,
        gaps,
        finalOrdinal,
        fileSize,
        projectionMatches: false,
        rejectionReason: `invalid JSON at byte ${line.startOffset}: ${(error as Error).message}`,
      });
    }

    if (!isRecord(entry)) {
      return rejectedInspection({
        threadId,
        gaps,
        finalOrdinal,
        fileSize,
        projectionMatches: false,
        rejectionReason: `invalid JSON record at byte ${line.startOffset}`,
      });
    }
    if (lineIndex === 0) {
      const payload = entry.payload;
      threadId = entry.type === "session_meta" && isRecord(payload)
        ? String(payload.id || payload.thread_id || "").trim()
        : "";
      if (!threadId) {
        return rejectedInspection({
          threadId: "",
          gaps,
          finalOrdinal,
          fileSize,
          projectionMatches: false,
          rejectionReason: "first record is not a usable session_meta",
        });
      }
    }

    const ordinal = entry.ordinal;
    if (lineIndex === 0 && ordinal === undefined) {
      return {
        eligible: false,
        threadId,
        gaps: [],
        finalOrdinal: -1,
        fileSize,
        projectionMatches: false,
      };
    }
    if (!Number.isSafeInteger(ordinal) || Number(ordinal) < 0) {
      return rejectedInspection({
        threadId,
        gaps,
        finalOrdinal,
        fileSize,
        projectionMatches: false,
        rejectionReason: `invalid ordinal at byte ${line.startOffset}`,
      });
    }
    const currentOrdinal = Number(ordinal);
    if (lineIndex === 0 && currentOrdinal !== 0) {
      return rejectedInspection({
        threadId,
        gaps,
        finalOrdinal,
        fileSize,
        projectionMatches: false,
        rejectionReason: `first ordinal must be 0, got ${currentOrdinal}`,
      });
    }
    if (projection && currentOrdinal === projection.nextRolloutOrdinal) {
      projectionOrdinalOffset = line.startOffset;
    }
    if (previousOrdinal !== null) {
      if (currentOrdinal === previousOrdinal) {
        return rejectedInspection({
          threadId,
          gaps,
          finalOrdinal,
          fileSize,
          projectionMatches: false,
          rejectionReason: `duplicate ordinal ${currentOrdinal}`,
        });
      }
      if (currentOrdinal < previousOrdinal) {
        return rejectedInspection({
          threadId,
          gaps,
          finalOrdinal,
          fileSize,
          projectionMatches: false,
          rejectionReason: `backwards ordinal ${previousOrdinal} -> ${currentOrdinal}`,
        });
      }
      const difference = currentOrdinal - previousOrdinal;
      if (difference > 2) {
        return rejectedInspection({
          threadId,
          gaps,
          finalOrdinal,
          fileSize,
          projectionMatches: false,
          rejectionReason: `unsupported ordinal gap ${previousOrdinal} -> ${currentOrdinal}`,
        });
      }
      if (difference === 2) {
        const missingOrdinal = previousOrdinal + 1;
        const eventReasoningId = previousEntry ? completedReasoningId(previousEntry) : "";
        gaps.push({
          ordinal: missingOrdinal,
          insertBeforeOffset: line.startOffset,
          timestamp: String(previousEntry?.timestamp || entry.timestamp || ""),
          reasoningId: eventReasoningId || `sync-repair-${threadId}-${missingOrdinal}`,
        });
      }
    }

    previousEntry = entry;
    previousOrdinal = currentOrdinal;
    finalOrdinal = currentOrdinal;
    lineIndex += 1;
  }

  if (lineIndex === 0) {
    return rejectedInspection({
      threadId: "",
      gaps,
      finalOrdinal,
      fileSize,
      projectionMatches: false,
      rejectionReason: "rollout is empty and has no session_meta",
    });
  }

  const projectionMatches = projection
    ? projectionOrdinalOffset !== null
      ? projection.nextRolloutByteOffset === projectionOrdinalOffset
      : projection.nextRolloutOrdinal === finalOrdinal + 1 && projection.nextRolloutByteOffset === fileSize
    : false;
  const hasLegacyEvidence = gaps.length > 0 || Boolean(projection && !projectionMatches);
  const projectionAllowsRepair = !projection || !projectionMatches;
  return {
    eligible: hasLegacyEvidence && projectionAllowsRepair,
    threadId,
    gaps,
    finalOrdinal,
    fileSize,
    projectionMatches,
  };
}

export async function rewriteLegacyRollout(
  filePath: string,
  inspection: LegacyRolloutInspection,
  options: { rename?: (source: string, target: string) => void } = {},
) {
  if (!inspection.eligible || inspection.rejectionReason) {
    throw new Error(inspection.rejectionReason || "rollout is not eligible for legacy repair");
  }
  if (inspection.gaps.length === 0) return 0;

  const tempPath = `${filePath}.repair-tmp.${process.pid}.${Date.now()}`;
  const gapsByOffset = new Map(inspection.gaps.map((gap) => [gap.insertBeforeOffset, gap]));
  let output: number | null = null;
  let restored = 0;
  try {
    output = fs.openSync(tempPath, "wx");
    for await (const line of readRawJsonlLines(filePath)) {
      const gap = gapsByOffset.get(line.startOffset);
      if (gap) {
        const placeholder = {
          timestamp: gap.timestamp,
          ordinal: gap.ordinal,
          type: "response_item",
          payload: {
            type: "reasoning",
            id: gap.reasoningId,
            summary: [],
            content: [],
          },
        };
        writeAllSync(output, Buffer.from(`${JSON.stringify(placeholder)}\n`, "utf8"));
        restored += 1;
      }
      writeAllSync(output, line.raw);
      if (line.hadNewline) writeAllSync(output, Buffer.from("\n"));
    }
    if (restored !== inspection.gaps.length) {
      throw new Error(`expected to restore ${inspection.gaps.length} reasoning rows, restored ${restored}`);
    }
    fs.fsyncSync(output);
    fs.closeSync(output);
    output = null;
    (options.rename || fs.renameSync)(tempPath, filePath);
    return restored;
  } catch (error) {
    if (output !== null) {
      try {
        fs.closeSync(output);
      } catch {}
    }
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {}
    throw error;
  }
}

function discoverThreadHistoryDatabases(codexDir: string) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(codexDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /^thread_history_(\d+)\.sqlite$/.test(entry.name))
    .map((entry) => {
      const suffix = Number(entry.name.match(/^thread_history_(\d+)\.sqlite$/)?.[1] || 0);
      return { suffix, filePath: path.resolve(codexDir, entry.name) };
    })
    .sort((left, right) => left.suffix - right.suffix || left.filePath.localeCompare(right.filePath))
    .map((entry) => entry.filePath);
}

function sqliteLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function createNodeThreadHistoryAdapter(): ThreadHistoryAdapterLike | null {
  let DatabaseSync: any;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  return {
    discover: discoverThreadHistoryDatabases,
    open(dbPath) {
      const db = new DatabaseSync(dbPath);
      return {
        dbPath,
        getProjection(threadId) {
          const row = db.prepare(
            `select next_rollout_byte_offset, next_rollout_ordinal
             from thread_history_projection_state
             where thread_id = ?`,
          ).get(threadId) as Record<string, unknown> | undefined;
          if (!row) return null;
          return {
            nextRolloutByteOffset: Number(row.next_rollout_byte_offset),
            nextRolloutOrdinal: Number(row.next_rollout_ordinal),
          };
        },
        resetThread(threadId) {
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const table of [
              "thread_realtime_items",
              "thread_items",
              "thread_turns",
              "thread_history_projection_state",
            ]) {
              db.prepare(`delete from ${table} where thread_id = ?`).run(threadId);
            }
            db.exec("COMMIT");
          } catch (error) {
            try {
              db.exec("ROLLBACK");
            } catch {}
            throw error;
          }
        },
        close() {
          db.close();
        },
      };
    },
  };
}

function readSqliteJson(dbPath: string, sql: string) {
  const output = execFileSync("sqlite3", ["-batch", "-json", dbPath, sql], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) as Array<Record<string, unknown>> : [];
}

function createCliThreadHistoryAdapter(): ThreadHistoryAdapterLike | null {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  return {
    discover: discoverThreadHistoryDatabases,
    open(dbPath) {
      return {
        dbPath,
        getProjection(threadId) {
          const rows = readSqliteJson(
            dbPath,
            `select next_rollout_byte_offset, next_rollout_ordinal
             from thread_history_projection_state
             where thread_id = ${sqliteLiteral(threadId)} limit 1`,
          );
          if (!rows[0]) return null;
          return {
            nextRolloutByteOffset: Number(rows[0].next_rollout_byte_offset),
            nextRolloutOrdinal: Number(rows[0].next_rollout_ordinal),
          };
        },
        resetThread(threadId) {
          const id = sqliteLiteral(threadId);
          execFileSync("sqlite3", [
            "-batch",
            dbPath,
            `BEGIN IMMEDIATE;
             delete from thread_realtime_items where thread_id = ${id};
             delete from thread_items where thread_id = ${id};
             delete from thread_turns where thread_id = ${id};
             delete from thread_history_projection_state where thread_id = ${id};
             COMMIT;`,
          ], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
        },
        close() {},
      };
    },
  };
}

export function createDefaultThreadHistoryAdapter() {
  return createNodeThreadHistoryAdapter() || createCliThreadHistoryAdapter();
}

function safePathSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function createRepairBackup(options: {
  codexDir: string;
  rolloutPath: string;
  databasePath?: string;
  inspection: LegacyRolloutInspection;
  projection: ThreadHistoryProjection | null;
  now: Date;
}) {
  const createdAt = options.now.toISOString();
  const timestamp = createdAt.replace(/[:.]/g, "-");
  const backupDir = path.join(
    options.codexDir,
    "ai-model-v2",
    "repair-backups",
    timestamp,
    safePathSegment(options.inspection.threadId),
  );
  fs.mkdirSync(backupDir, { recursive: true });
  const copiedFiles: Array<{ sourcePath: string; backupPath: string; size: number }> = [];
  const copy = (sourcePath: string) => {
    const backupPath = path.join(backupDir, path.basename(sourcePath));
    fs.copyFileSync(
      sourcePath,
      backupPath,
      fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE,
    );
    const item = { sourcePath, backupPath, size: fs.statSync(sourcePath).size };
    copiedFiles.push(item);
    return item;
  };

  const rollout = copy(options.rolloutPath);
  let historyDatabase: ReturnType<typeof copy> | null = null;
  if (options.databasePath) {
    historyDatabase = copy(options.databasePath);
    for (const suffix of ["-wal", "-shm"]) {
      const sibling = `${options.databasePath}${suffix}`;
      if (fs.existsSync(sibling)) copy(sibling);
    }
  }

  const manifest = {
    version: 1,
    createdAt,
    threadId: options.inspection.threadId,
    rollout,
    historyDatabase,
    copiedFiles,
    gaps: options.inspection.gaps,
    projection: options.projection,
  };
  const manifestPath = path.join(backupDir, "manifest.json");
  const tempManifestPath = `${manifestPath}.tmp.${process.pid}.${Date.now()}`;
  try {
    fs.writeFileSync(tempManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(tempManifestPath, manifestPath);
  } catch (error) {
    try {
      if (fs.existsSync(tempManifestPath)) fs.unlinkSync(tempManifestPath);
    } catch {}
    throw error;
  }
  return backupDir;
}

export async function repairLegacyThreadHistory(options: {
  codexDir: string;
  rolloutPath: string;
  historyAdapter?: ThreadHistoryAdapterLike | null;
  historyDatabase?: ThreadHistoryDatabaseLike;
  now?: () => Date;
  rewriteRollout?: typeof rewriteLegacyRollout;
}): Promise<LegacyThreadRepairResult> {
  const adapter = options.historyDatabase
    ? null
    : options.historyAdapter === undefined
      ? createDefaultThreadHistoryAdapter()
      : options.historyAdapter;
  let database: ThreadHistoryDatabaseLike | null = options.historyDatabase || null;
  let ownsDatabase = false;
  try {
    if (adapter) {
      const paths = adapter.discover(options.codexDir);
      const databasePath = paths.at(-1);
      if (databasePath) {
        database = adapter.open(databasePath);
        ownsDatabase = true;
      }
    }
    const sessionIdInspection = await inspectLegacyRollout(options.rolloutPath, null);
    if (sessionIdInspection.rejectionReason) {
      return {
        detected: sessionIdInspection.gaps.length > 0,
        reasoningRowsRestored: 0,
        projectionReset: false,
        backupCreated: false,
        rejectionReason: sessionIdInspection.rejectionReason,
      };
    }
    const projection = database?.getProjection(sessionIdInspection.threadId) || null;
    const inspection = projection
      ? await inspectLegacyRollout(options.rolloutPath, projection)
      : sessionIdInspection;
    if (inspection.rejectionReason) {
      return {
        detected: inspection.gaps.length > 0,
        reasoningRowsRestored: 0,
        projectionReset: false,
        backupCreated: false,
        rejectionReason: inspection.rejectionReason,
      };
    }
    if (!inspection.eligible) {
      return {
        detected: false,
        reasoningRowsRestored: 0,
        projectionReset: false,
        backupCreated: false,
      };
    }

    const backupDir = createRepairBackup({
      codexDir: options.codexDir,
      rolloutPath: options.rolloutPath,
      databasePath: database?.dbPath,
      inspection,
      projection,
      now: (options.now || (() => new Date()))(),
    });
    const reasoningRowsRestored = inspection.gaps.length > 0
      ? await (options.rewriteRollout || rewriteLegacyRollout)(options.rolloutPath, inspection)
      : 0;
    if (database && projection) database.resetThread(inspection.threadId);
    return {
      detected: true,
      reasoningRowsRestored,
      projectionReset: Boolean(database && projection),
      backupCreated: true,
      backupDir,
    };
  } finally {
    if (ownsDatabase) {
      try {
        database?.close();
      } catch {}
    }
  }
}
