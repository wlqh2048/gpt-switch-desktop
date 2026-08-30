import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  createDefaultThreadHistoryAdapter,
  inspectLegacyRollout,
  repairLegacyThreadHistory,
  rewriteLegacyRollout,
  ThreadHistoryAdapterLike,
  ThreadHistoryDatabaseLike,
  ThreadHistoryProjection,
} from "../threadHistoryRepair";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "thread-history-repair-"));
}

function record(ordinal: number, type: string, payload: Record<string, unknown>, timestamp?: string) {
  return JSON.stringify({
    timestamp: timestamp || `2026-08-30T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
    ordinal,
    type,
    payload,
  });
}

function session(ordinal = 0, id = "thread-a") {
  return record(ordinal, "session_meta", { id, model_provider: "openai" });
}

function writeRollout(lines: string[], trailingNewline = true) {
  const filePath = path.join(tempDir(), "rollout.jsonl");
  fs.writeFileSync(filePath, `${lines.join("\n")}${trailingNewline ? "\n" : ""}`, "utf8");
  return filePath;
}

function lineStart(filePath: string, ordinal: number) {
  const content = fs.readFileSync(filePath);
  const needle = Buffer.from(`\"ordinal\":${ordinal}`);
  const match = content.indexOf(needle);
  if (match < 0) throw new Error(`ordinal ${ordinal} not found`);
  const priorNewline = content.lastIndexOf(0x0a, match);
  return priorNewline < 0 ? 0 : priorNewline + 1;
}

describe("inspectLegacyRollout", () => {
  it("recognizes a contiguous rollout with a matching projection as healthy", async () => {
    const filePath = writeRollout([
      session(),
      record(1, "response_item", { type: "message", role: "user", content: "你好" }),
      record(2, "response_item", { type: "message", role: "assistant", content: "你好" }),
    ]);
    const projection: ThreadHistoryProjection = {
      nextRolloutOrdinal: 2,
      nextRolloutByteOffset: lineStart(filePath, 2),
    };

    await expect(inspectLegacyRollout(filePath, projection)).resolves.toMatchObject({
      eligible: false,
      threadId: "thread-a",
      gaps: [],
      finalOrdinal: 2,
      projectionMatches: true,
    });
  });

  it("detects one missing ordinal and a stale projection offset", async () => {
    const eventId = "reasoning-from-event";
    const filePath = writeRollout([
      session(),
      record(1, "event_msg", {
        type: "item_completed",
        item: { id: eventId, type: "Reasoning" },
      }),
      record(3, "response_item", { type: "message", role: "assistant", content: "保留" }),
    ]);

    await expect(
      inspectLegacyRollout(filePath, {
        nextRolloutOrdinal: 2,
        nextRolloutByteOffset: lineStart(filePath, 3) + 8,
      }),
    ).resolves.toMatchObject({
      eligible: true,
      threadId: "thread-a",
      finalOrdinal: 3,
      projectionMatches: false,
      gaps: [
        {
          ordinal: 2,
          insertBeforeOffset: lineStart(filePath, 3),
          reasoningId: eventId,
        },
      ],
    });
  });

  it("uses a deterministic reasoning id when the preceding event is unrelated", async () => {
    const filePath = writeRollout([
      session(),
      record(1, "event_msg", { type: "task_started" }),
      record(3, "response_item", { type: "message", role: "assistant" }),
    ]);

    const result = await inspectLegacyRollout(filePath, null);

    expect(result.eligible).toBe(true);
    expect(result.gaps[0]?.reasoningId).toBe("sync-repair-thread-a-2");
  });

  it("accepts an end projection only at the physical file size", async () => {
    const filePath = writeRollout([session(), record(1, "event_msg", { type: "task_complete" })]);
    const fileSize = fs.statSync(filePath).size;

    const matching = await inspectLegacyRollout(filePath, {
      nextRolloutOrdinal: 2,
      nextRolloutByteOffset: fileSize,
    });
    const stale = await inspectLegacyRollout(filePath, {
      nextRolloutOrdinal: 2,
      nextRolloutByteOffset: fileSize - 1,
    });

    expect(matching).toMatchObject({ eligible: false, projectionMatches: true });
    expect(stale).toMatchObject({ eligible: true, projectionMatches: false, gaps: [] });
  });

  it("ignores older rollout formats that do not use ordinals", async () => {
    const filePath = writeRollout([
      JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
    ]);

    const result = await inspectLegacyRollout(filePath, null);

    expect(result).toMatchObject({ eligible: false, threadId: "thread-a", gaps: [] });
    expect(result.rejectionReason).toBeUndefined();
  });

  it("measures projection offsets in bytes before Chinese text", async () => {
    const filePath = writeRollout([
      session(),
      record(1, "response_item", { type: "message", role: "user", content: "这是一段中文" }),
      record(2, "response_item", { type: "message", role: "assistant", content: "收到" }),
    ]);
    const offset = lineStart(filePath, 2);

    const result = await inspectLegacyRollout(filePath, {
      nextRolloutOrdinal: 2,
      nextRolloutByteOffset: offset,
    });

    const text = fs.readFileSync(filePath, "utf8");
    const ordinalCharacterIndex = text.indexOf('"ordinal":2');
    const characterLineStart = text.lastIndexOf("\n", ordinalCharacterIndex) + 1;
    expect(offset).toBeGreaterThan(characterLineStart);
    expect(result.projectionMatches).toBe(true);
  });

  it.each([
    {
      name: "malformed JSON",
      lines: [session(), "not-json", record(2, "event_msg", { type: "task_complete" })],
      reason: "invalid JSON",
    },
    {
      name: "an interior blank line",
      lines: [session(), "", record(2, "event_msg", { type: "task_complete" })],
      reason: "blank line",
    },
    {
      name: "a duplicate ordinal",
      lines: [session(), record(1, "event_msg", {}), record(1, "event_msg", {})],
      reason: "duplicate ordinal",
    },
    {
      name: "a backwards ordinal",
      lines: [session(), record(2, "event_msg", {}), record(1, "event_msg", {})],
      reason: "backwards ordinal",
    },
    {
      name: "a nonzero first ordinal",
      lines: [session(1), record(2, "event_msg", {})],
      reason: "first ordinal must be 0",
    },
    {
      name: "a gap larger than one",
      lines: [session(), record(3, "event_msg", {})],
      reason: "unsupported ordinal gap",
    },
    {
      name: "a missing session id",
      lines: [session(0, ""), record(1, "event_msg", {})],
      reason: "session_meta",
    },
  ])("rejects $name without making it eligible", async ({ lines, reason }) => {
    const filePath = writeRollout(lines);

    const result = await inspectLegacyRollout(filePath, null);

    expect(result.eligible).toBe(false);
    expect(result.rejectionReason).toContain(reason);
  });
});

function rawLines(filePath: string) {
  const content = fs.readFileSync(filePath);
  const lines: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== 0x0a) continue;
    lines.push(Buffer.from(content.subarray(start, index)));
    start = index + 1;
  }
  if (start < content.length) lines.push(Buffer.from(content.subarray(start)));
  return lines;
}

describe("rewriteLegacyRollout", () => {
  it("inserts neutral reasoning rows while preserving every existing line byte-for-byte", async () => {
    const reasoningId = "reasoning-event-id";
    const lines = [
      session(),
      record(1, "event_msg", {
        type: "item_completed",
        item: { id: reasoningId, type: "Reasoning" },
      }, "2026-08-30T00:00:01.123Z"),
      record(3, "response_item", { type: "message", role: "user", content: "你好" }),
      record(5, "response_item", { type: "message", role: "assistant", content: "保留回答" }),
    ];
    const filePath = writeRollout(lines);
    const originals = rawLines(filePath);
    const inspection = await inspectLegacyRollout(filePath, null);

    const restored = await rewriteLegacyRollout(filePath, inspection);

    expect(restored).toBe(2);
    const outputLines = rawLines(filePath);
    let outputIndex = 0;
    for (const original of originals) {
      outputIndex = outputLines.findIndex((candidate, index) => index >= outputIndex && candidate.equals(original));
      expect(outputIndex).toBeGreaterThanOrEqual(0);
      outputIndex += 1;
    }
    const entries = outputLines.map((line) => JSON.parse(line.toString("utf8")));
    expect(entries.map((entry) => entry.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(entries.find((entry) => entry.ordinal === 2)).toEqual({
      timestamp: "2026-08-30T00:00:01.123Z",
      ordinal: 2,
      type: "response_item",
      payload: {
        type: "reasoning",
        id: reasoningId,
        summary: [],
        content: [],
      },
    });
    expect(entries.find((entry) => entry.ordinal === 4)?.payload).toEqual({
      type: "reasoning",
      id: "sync-repair-thread-a-4",
      summary: [],
      content: [],
    });
    expect(entries.some((entry) => Object.hasOwn(entry.payload, "encrypted_content"))).toBe(false);
    const reinspected = await inspectLegacyRollout(filePath, null);
    expect(reinspected).toMatchObject({
      eligible: false,
      gaps: [],
    });
    expect(reinspected.rejectionReason).toBeUndefined();
  });

  it("retains a rollout without a final newline", async () => {
    const filePath = writeRollout([
      session(),
      record(2, "response_item", { type: "message", role: "assistant" }),
    ], false);
    const inspection = await inspectLegacyRollout(filePath, null);

    await rewriteLegacyRollout(filePath, inspection);

    expect(fs.readFileSync(filePath).at(-1)).not.toBe(0x0a);
  });

  it("leaves the source unchanged and removes its temporary sibling when replacement fails", async () => {
    const filePath = writeRollout([session(), record(2, "event_msg", { type: "task_complete" })]);
    const before = fs.readFileSync(filePath);
    const inspection = await inspectLegacyRollout(filePath, null);

    await expect(
      rewriteLegacyRollout(filePath, inspection, {
        rename: () => {
          throw new Error("injected rename failure");
        },
      }),
    ).rejects.toThrow("injected rename failure");

    expect(fs.readFileSync(filePath).equals(before)).toBe(true);
    expect(fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes(".repair-tmp."))).toEqual([]);
  });
});

function fakeHistoryAdapter(
  dbPath: string,
  projection: ThreadHistoryProjection | null,
  resetCalls: string[],
  closeCalls: string[],
  onReset?: (threadId: string) => void,
): ThreadHistoryAdapterLike {
  return {
    discover: () => [dbPath],
    open: (): ThreadHistoryDatabaseLike => ({
      dbPath,
      getProjection: () => projection,
      resetThread(threadId) {
        onReset?.(threadId);
        resetCalls.push(threadId);
      },
      close() {
        closeCalls.push(dbPath);
      },
    }),
  };
}

describe("repairLegacyThreadHistory", () => {
  it("backs up every material file before rewriting and resetting one thread", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, `${session()}\n${record(2, "event_msg", { type: "task_complete" })}\n`);
    const before = fs.readFileSync(rolloutPath);
    const dbPath = path.join(codexDir, "thread_history_1.sqlite");
    fs.writeFileSync(dbPath, "database");
    fs.writeFileSync(`${dbPath}-wal`, "wal");
    fs.writeFileSync(`${dbPath}-shm`, "shm");
    const resetCalls: string[] = [];
    const closeCalls: string[] = [];
    let backupDirSeen = "";
    const adapter = fakeHistoryAdapter(
      dbPath,
      { nextRolloutOrdinal: 1, nextRolloutByteOffset: lineStart(rolloutPath, 2) + 1 },
      resetCalls,
      closeCalls,
      () => {
        const backupRoot = path.join(codexDir, "ai-model-v2", "repair-backups");
        const timestampDir = fs.readdirSync(backupRoot)[0];
        backupDirSeen = path.join(backupRoot, timestampDir, "thread-a");
        expect(fs.existsSync(path.join(backupDirSeen, path.basename(rolloutPath)))).toBe(true);
        expect(fs.existsSync(path.join(backupDirSeen, path.basename(dbPath)))).toBe(true);
        expect(fs.existsSync(path.join(backupDirSeen, `${path.basename(dbPath)}-wal`))).toBe(true);
        expect(fs.existsSync(path.join(backupDirSeen, `${path.basename(dbPath)}-shm`))).toBe(true);
        expect(fs.existsSync(path.join(backupDirSeen, "manifest.json"))).toBe(true);
      },
    );

    const result = await repairLegacyThreadHistory({
      codexDir,
      rolloutPath,
      historyAdapter: adapter,
      now: () => new Date("2026-08-30T08:09:10.123Z"),
    });

    expect(result).toMatchObject({
      detected: true,
      reasoningRowsRestored: 1,
      projectionReset: true,
      backupCreated: true,
      backupDir: backupDirSeen,
    });
    expect(resetCalls).toEqual(["thread-a"]);
    expect(closeCalls).toEqual([dbPath]);
    expect(fs.readFileSync(path.join(backupDirSeen, path.basename(rolloutPath))).equals(before)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(backupDirSeen, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({
      threadId: "thread-a",
      createdAt: "2026-08-30T08:09:10.123Z",
      rollout: { sourcePath: rolloutPath, size: before.length },
      historyDatabase: { sourcePath: dbPath },
      gaps: [{ ordinal: 1 }],
      projection: { nextRolloutOrdinal: 1 },
    });
  });

  it("does not mutate the rollout or reset projection when a database backup fails", async () => {
    const codexDir = tempDir();
    const rolloutPath = writeRollout([session(), record(2, "event_msg", {})]);
    const before = fs.readFileSync(rolloutPath);
    const missingDbPath = path.join(codexDir, "thread_history_1.sqlite");
    const resetCalls: string[] = [];
    const closeCalls: string[] = [];
    const adapter = fakeHistoryAdapter(
      missingDbPath,
      { nextRolloutOrdinal: 1, nextRolloutByteOffset: 999 },
      resetCalls,
      closeCalls,
    );

    await expect(
      repairLegacyThreadHistory({ codexDir, rolloutPath, historyAdapter: adapter }),
    ).rejects.toThrow();

    expect(fs.readFileSync(rolloutPath).equals(before)).toBe(true);
    expect(resetCalls).toEqual([]);
    expect(closeCalls).toEqual([missingDbPath]);
  });

  it("does not mutate rollout or projection when the backup directory cannot be created", async () => {
    const codexDir = tempDir();
    const rolloutPath = writeRollout([session(), record(2, "event_msg", {})]);
    const before = fs.readFileSync(rolloutPath);
    fs.writeFileSync(path.join(codexDir, "ai-model-v2"), "blocks backup directory creation");
    const dbPath = path.join(codexDir, "thread_history_1.sqlite");
    fs.writeFileSync(dbPath, "database");
    const resetCalls: string[] = [];
    const closeCalls: string[] = [];
    const adapter = fakeHistoryAdapter(
      dbPath,
      { nextRolloutOrdinal: 1, nextRolloutByteOffset: 999 },
      resetCalls,
      closeCalls,
    );

    await expect(
      repairLegacyThreadHistory({ codexDir, rolloutPath, historyAdapter: adapter }),
    ).rejects.toThrow();

    expect(fs.readFileSync(rolloutPath).equals(before)).toBe(true);
    expect(resetCalls).toEqual([]);
    expect(closeCalls).toEqual([dbPath]);
  });

  it("does not mutate rollout or projection when a WAL backup fails", async () => {
    const codexDir = tempDir();
    const rolloutPath = writeRollout([session(), record(2, "event_msg", {})]);
    const before = fs.readFileSync(rolloutPath);
    const dbPath = path.join(codexDir, "thread_history_1.sqlite");
    fs.writeFileSync(dbPath, "database");
    fs.mkdirSync(`${dbPath}-wal`);
    const resetCalls: string[] = [];
    const closeCalls: string[] = [];
    const adapter = fakeHistoryAdapter(
      dbPath,
      { nextRolloutOrdinal: 1, nextRolloutByteOffset: 999 },
      resetCalls,
      closeCalls,
    );

    await expect(
      repairLegacyThreadHistory({ codexDir, rolloutPath, historyAdapter: adapter }),
    ).rejects.toThrow();

    expect(fs.readFileSync(rolloutPath).equals(before)).toBe(true);
    expect(resetCalls).toEqual([]);
    expect(closeCalls).toEqual([dbPath]);
  });

  it("repairs a verified gap without resetting projection when no history database exists", async () => {
    const codexDir = tempDir();
    const rolloutPath = writeRollout([session(), record(2, "event_msg", {})]);

    const result = await repairLegacyThreadHistory({
      codexDir,
      rolloutPath,
      historyAdapter: null,
      now: () => new Date("2026-08-30T08:09:10.456Z"),
    });

    expect(result).toMatchObject({
      detected: true,
      reasoningRowsRestored: 1,
      projectionReset: false,
      backupCreated: true,
    });
    await expect(inspectLegacyRollout(rolloutPath, null)).resolves.toMatchObject({ gaps: [], eligible: false });
    const manifest = JSON.parse(fs.readFileSync(path.join(result.backupDir!, "manifest.json"), "utf8"));
    expect(manifest.historyDatabase).toBeNull();
    expect(manifest.copiedFiles).toHaveLength(1);
  });

  it("does not reset projection when rollout replacement fails", async () => {
    const codexDir = tempDir();
    const rolloutPath = writeRollout([session(), record(2, "event_msg", {})]);
    const before = fs.readFileSync(rolloutPath);
    const dbPath = path.join(codexDir, "thread_history_1.sqlite");
    fs.writeFileSync(dbPath, "database");
    const resetCalls: string[] = [];
    const closeCalls: string[] = [];
    const adapter = fakeHistoryAdapter(
      dbPath,
      { nextRolloutOrdinal: 1, nextRolloutByteOffset: 999 },
      resetCalls,
      closeCalls,
    );

    await expect(
      repairLegacyThreadHistory({
        codexDir,
        rolloutPath,
        historyAdapter: adapter,
        rewriteRollout: async () => {
          throw new Error("injected rewrite failure");
        },
      }),
    ).rejects.toThrow("injected rewrite failure");

    expect(fs.readFileSync(rolloutPath).equals(before)).toBe(true);
    expect(resetCalls).toEqual([]);
    expect(closeCalls).toEqual([dbPath]);
  });

  it("creates no backup and performs no mutation for a healthy rollout", async () => {
    const codexDir = tempDir();
    const rolloutPath = writeRollout([session(), record(1, "event_msg", {})]);
    const dbPath = path.join(codexDir, "thread_history_1.sqlite");
    fs.writeFileSync(dbPath, "database");
    const resetCalls: string[] = [];
    const closeCalls: string[] = [];
    const adapter = fakeHistoryAdapter(
      dbPath,
      { nextRolloutOrdinal: 2, nextRolloutByteOffset: fs.statSync(rolloutPath).size },
      resetCalls,
      closeCalls,
    );

    const result = await repairLegacyThreadHistory({ codexDir, rolloutPath, historyAdapter: adapter });

    expect(result).toMatchObject({
      detected: false,
      reasoningRowsRestored: 0,
      projectionReset: false,
      backupCreated: false,
    });
    expect(resetCalls).toEqual([]);
    expect(closeCalls).toEqual([dbPath]);
    expect(fs.existsSync(path.join(codexDir, "ai-model-v2", "repair-backups"))).toBe(false);
  });
});

function hasSqlite3() {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("default thread history adapter", () => {
  it.skipIf(!hasSqlite3())("resets only the selected thread in all four projection tables", () => {
    const codexDir = tempDir();
    const dbPath = path.join(codexDir, "thread_history_1.sqlite");
    const tables = [
      "thread_realtime_items",
      "thread_items",
      "thread_turns",
      "thread_history_projection_state",
    ];
    const schema = tables
      .map((table) =>
        table === "thread_history_projection_state"
          ? `create table ${table} (thread_id text, next_rollout_byte_offset integer, next_rollout_ordinal integer);`
          : `create table ${table} (thread_id text);`,
      )
      .join("\n");
    const inserts = tables
      .flatMap((table) => ["thread-a", "thread-b"].map((id) =>
        table === "thread_history_projection_state"
          ? `insert into ${table} values ('${id}', 10, 2);`
          : `insert into ${table} values ('${id}');`,
      ))
      .join("\n");
    execFileSync("sqlite3", ["-batch", dbPath, `${schema}\n${inserts}`]);
    const adapter = createDefaultThreadHistoryAdapter();
    expect(adapter).not.toBeNull();
    expect(adapter?.discover(codexDir)).toEqual([dbPath]);
    const db = adapter!.open(dbPath);

    expect(db.getProjection("thread-a")).toEqual({
      nextRolloutByteOffset: 10,
      nextRolloutOrdinal: 2,
    });
    db.resetThread("thread-a");
    db.close();

    for (const table of tables) {
      const rows = execFileSync("sqlite3", ["-batch", "-noheader", dbPath, `select thread_id from ${table}`], {
        encoding: "utf8",
      }).trim();
      expect(rows).toBe("thread-b");
    }
  });
});
