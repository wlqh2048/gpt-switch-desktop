import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  normalizeRolloutMetaProvider,
  rebuildSessionIndex,
  readRolloutInfo,
  syncThreadVisibility,
} from "../syncEngine";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-sync-"));
}

function sqlite3(dbPath: string, sql: string) {
  return execFileSync("sqlite3", ["-batch", dbPath, sql], { encoding: "utf8" });
}

describe("syncEngine", () => {
  it("reads rollout info without loading the whole file into memory", async () => {
    const filePath = path.join(tempDir(), "rollout-2026-08-25T10-00-00-a.jsonl");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const fd = fs.openSync(filePath, "w");
    for (let index = 0; index < 5000; index += 1) {
      fs.writeSync(
        fd,
        `${JSON.stringify({ timestamp: new Date(1000 + index).toISOString(), type: "message", payload: { index } })}\n`,
      );
    }
    fs.closeSync(fd);

    const info = await readRolloutInfo(filePath);

    expect(info.exists).toBe(true);
    expect(info.lineCount).toBe(5000);
    expect(info.latestMs).toBeGreaterThan(0);
  });

  it("normalizes session_meta provider through a streaming rewrite", async () => {
    const filePath = path.join(tempDir(), "rollout.jsonl");
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "old", model_provider: "openai" } }),
        JSON.stringify({ type: "message", payload: { content: "hello" } }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await normalizeRolloutMetaProvider(filePath, "fixture-provider");

    expect(result.changed).toBe(true);
    expect(fs.readFileSync(filePath, "utf8")).toContain('"model_provider":"fixture-provider"');
  });

  it("preserves provider-specific reasoning rows and event links when switching rollout providers", async () => {
    const filePath = path.join(tempDir(), "rollout.jsonl");
    const summary = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "portable compacted summary" }],
    };
    const assistant = {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "visible answer" }],
      },
    };
    const input =
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "fixture-provider" } }),
        JSON.stringify({ type: "compacted", payload: { replacement_history: [summary], message: "summary" } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "developer", content: [] } }),
        JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            id: "example-reasoning",
            type: "reasoning",
            content: [{ type: "reasoning_text", text: "provider-private reasoning" }],
            summary: [],
            encrypted_content: "example-placeholder",
            internal_chat_message_metadata_passthrough: { source: "fixture-provider" },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: { type: "item_completed", item: { id: "example-reasoning" } },
        }),
        JSON.stringify(assistant),
        "not-json",
      ].join("\n") + "\n";
    fs.writeFileSync(filePath, input, "utf8");

    const result = await normalizeRolloutMetaProvider(filePath, "openai", "gpt-5.5");
    const output = fs.readFileSync(filePath, "utf8");
    const jsonLines = output
      .trim()
      .split("\n")
      .filter((line) => line !== "not-json")
      .map((line) => JSON.parse(line));

    expect(result.changed).toBe(true);
    expect(jsonLines[0].payload.model_provider).toBe("openai");
    const reasoningEntry = jsonLines.find(
      (entry) => entry.type === "response_item" && entry.payload?.type === "reasoning",
    );
    expect(reasoningEntry?.payload).toMatchObject({
      id: "example-reasoning",
      type: "reasoning",
      content: [],
      summary: [],
      internal_chat_message_metadata_passthrough: { source: "fixture-provider" },
    });
    expect(reasoningEntry?.payload.encrypted_content).toBeUndefined();
    expect(
      jsonLines.some(
        (entry) => entry.type === "event_msg" && entry.payload?.item?.id === "example-reasoning",
      ),
    ).toBe(true);
    expect(jsonLines.some((entry) => entry.type === "response_item" && entry.payload?.role === "assistant")).toBe(
      true,
    );
    expect(jsonLines.find((entry) => entry.type === "compacted")?.payload.replacement_history).toEqual([summary]);
    expect(output).toContain("not-json\n");
    expect(Buffer.byteLength(output)).toBe(Buffer.byteLength(input));
  });

  it("preserves and neutralizes reasoning in compacted replacement history across providers", async () => {
    const filePath = path.join(tempDir(), "rollout.jsonl");
    const summary = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "portable summary" }],
    };
    const reasoning = {
      id: "example-compacted-reasoning",
      type: "reasoning",
      content: [{ type: "reasoning_text", text: "private" }],
      summary: [],
      encrypted_content: "example-placeholder",
      internal_chat_message_metadata_passthrough: { source: "fixture-provider" },
    };
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "fixture-provider" } }),
        JSON.stringify({
          type: "compacted",
          payload: { replacement_history: [summary, reasoning], message: "summary" },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    await normalizeRolloutMetaProvider(filePath, "openai", "gpt-5.5");
    const lines = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines[1].payload.replacement_history).toHaveLength(2);
    expect(lines[1].payload.replacement_history[0]).toEqual(summary);
    expect(lines[1].payload.replacement_history[1]).toMatchObject({
      id: "example-compacted-reasoning",
      type: "reasoning",
      content: [],
      summary: [],
      internal_chat_message_metadata_passthrough: { source: "fixture-provider" },
    });
    expect(lines[1].payload.replacement_history[1].encrypted_content).toBeUndefined();
  });

  it("preserves official-style reasoning without a content field across providers", async () => {
    const filePath = path.join(tempDir(), "rollout.jsonl");
    const officialReasoning = {
      id: "official-reasoning",
      type: "reasoning",
      summary: [{ type: "summary_text", text: "official summary" }],
      encrypted_content: "official-encrypted-content",
    };
    fs.writeFileSync(
      filePath,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } }),
        JSON.stringify({ type: "response_item", payload: officialReasoning }),
      ].join("\n") + "\n",
      "utf8",
    );

    await normalizeRolloutMetaProvider(filePath, "fixture-provider", "fixture-fast");
    const lines = fs
      .readFileSync(filePath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(lines[1].payload).toEqual(officialReasoning);
  });

  it("preserves reasoning when the rollout provider does not change", async () => {
    const filePath = path.join(tempDir(), "rollout.jsonl");
    const original =
      [
        JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } }),
        JSON.stringify({
          type: "response_item",
          payload: {
            id: "rs_001",
            type: "reasoning",
            summary: [{ type: "summary_text", text: "official summary" }],
            encrypted_content: "official-encrypted-content",
          },
        }),
      ].join("\n") + "\n";
    fs.writeFileSync(filePath, original, "utf8");

    const result = await normalizeRolloutMetaProvider(filePath, "openai");

    expect(result.changed).toBe(false);
    expect(fs.readFileSync(filePath, "utf8")).toBe(original);
  });

  it.each([123, true, {}, ["fixture-provider"]])(
    "preserves reasoning when the source provider is not a string: %j",
    async (invalidProvider) => {
      const filePath = path.join(tempDir(), "rollout.jsonl");
      fs.writeFileSync(
        filePath,
        [
          JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: invalidProvider } }),
          JSON.stringify({
            type: "response_item",
            payload: {
              id: "provider-private-reasoning",
              type: "reasoning",
              content: [{ type: "reasoning_text", text: "keep when provider is unknown" }],
            },
          }),
        ].join("\n") + "\n",
        "utf8",
      );

      await normalizeRolloutMetaProvider(filePath, "openai");
      const lines = fs
        .readFileSync(filePath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));

      expect(lines.some((entry) => entry.type === "response_item" && entry.payload?.type === "reasoning")).toBe(true);
    },
  );

  it("rebuilds session_index with aliases without duplicate target ids", async () => {
    const codexDir = tempDir();
    fs.writeFileSync(
      path.join(codexDir, "session_index.jsonl"),
      [
        JSON.stringify({ id: "old", thread_name: "Old", updated_at: "2026-08-25T00:00:00.000Z" }),
        JSON.stringify({ id: "new", thread_name: "New", updated_at: "2026-08-25T01:00:00.000Z" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await rebuildSessionIndex(codexDir, new Map([["old", "new"]]));
    const lines = fs.readFileSync(path.join(codexDir, "session_index.jsonl"), "utf8").trim().split("\n");

    expect(result.changed).toBe(true);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe("new");
    expect(JSON.parse(lines[0]).thread_name).toBe("New");
  });

  it("syncs sqlite stores in batches through the adapter", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-25T10-00-00-openai.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } })}\n`,
      "utf8",
    );
    const calls: string[] = [];
    const adapter = {
      discover: () => [path.join(codexDir, "state.sqlite")],
      open: () => ({
        dbPath: "state.sqlite",
        hasThreads: () => true,
        getColumns: () => ["id", "rollout_path", "model_provider", "cwd", "updated_at"],
        readRows: ({ offset }: { offset: number }) =>
          offset === 0
            ? [
                {
                  id: "thread-a",
                  rollout_path: rolloutPath,
                  model_provider: "openai",
                  cwd: "/repo",
                  updated_at: 1,
                },
              ]
            : [],
        exec: (sql: string) => calls.push(sql),
        run: (sql: string, values: unknown[]) => calls.push(`${sql} ${JSON.stringify(values)}`),
        close: () => calls.push("close"),
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
      batchSize: 100,
    });

    expect(result.skipped).toBe(false);
    expect(result.normalizedRows).toBe(1);
    expect(result.rolloutMetaUpdated).toBe(1);
    expect(calls.some((call) => call.includes("update threads set model_provider"))).toBe(true);
  });

  it("normalizes rollout files even when sqlite is unavailable", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(
      codexDir,
      "sessions",
      "2026",
      "08",
      "12",
      "rollout-2026-08-12T16-37-20-019ff51e-6f41-74c1-83d0-bdb608023615.jsonl",
    );
    const archivedPath = path.join(
      codexDir,
      "archived_sessions",
      "rollout-2026-08-12T14-15-04-019ff49c-31bf-7122-b9c2-2f2f266c587a.jsonl",
    );
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.mkdirSync(path.dirname(archivedPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai-custom" } })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      archivedPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-b", model_provider: "openai-custom" } })}\n`,
      "utf8",
    );

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: null,
      rolloutQueueLimit: 1,
    });

    expect(result.skipped).toBe(false);
    expect(result.rolloutMetaScanned).toBe(2);
    expect(result.rolloutMetaUpdated).toBe(2);
    expect(fs.readFileSync(rolloutPath, "utf8")).toContain('"model_provider":"fixture-provider"');
    expect(fs.readFileSync(archivedPath, "utf8")).toContain('"model_provider":"fixture-provider"');
  });

  it("normalizes rollout thread settings provider and model for continued conversations", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-25T13-00-00-openai.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "thread-openai", model_provider: "chatgpt" },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            thread_settings: {
              model: "gpt-5.5",
              model_provider_id: "openai",
              collaboration_mode: {
                settings: {
                  model: "gpt-5.5",
                },
              },
            },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      targetModel: "fixture-fast",
      sqliteAdapter: null,
    });
    const lines = fs
      .readFileSync(rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.rolloutMetaUpdated).toBe(1);
    expect(lines[0].payload.model_provider).toBe("fixture-provider");
    expect(lines[1].payload.thread_settings.model_provider_id).toBe("fixture-provider");
    expect(lines[1].payload.thread_settings.model).toBe("fixture-fast");
    expect(lines[1].payload.thread_settings.collaboration_mode.settings.model).toBe("fixture-fast");
  });

  it("normalizes rollout world state and turn context models before Codex resumes", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-25T13-30-00-openai.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          type: "session_meta",
          payload: { id: "thread-openai", model_provider: "chatgpt" },
        }),
        JSON.stringify({
          type: "world_state",
          payload: {
            state: {
              model: "gpt-5.5",
              collaboration_mode: {
                model: "gpt-5.5",
              },
              personality: {
                model: "gpt-5.5",
              },
            },
          },
        }),
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5.5",
            collaboration_mode: {
              settings: {
                model: "gpt-5.5",
              },
            },
          },
        }),
        JSON.stringify({
          type: "event_msg",
          payload: {
            thread_settings: {
              model: "gpt-5.5",
              model_provider_id: "chatgpt",
              collaboration_mode: {
                settings: {
                  model: "gpt-5.5",
                },
              },
            },
          },
        }),
      ].join("\n") + "\n",
      "utf8",
    );

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      targetModel: "fixture-fast",
      sqliteAdapter: null,
    });
    const lines = fs
      .readFileSync(rolloutPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    expect(result.rolloutMetaUpdated).toBe(1);
    expect(lines[0].payload.model_provider).toBe("fixture-provider");
    expect(lines[1].payload.state.model).toBe("fixture-fast");
    expect(lines[1].payload.state.collaboration_mode.model).toBe("fixture-fast");
    expect(lines[1].payload.state.personality.model).toBe("fixture-fast");
    expect(lines[2].payload.model).toBe("fixture-fast");
    expect(lines[2].payload.collaboration_mode.settings.model).toBe("fixture-fast");
    expect(lines[3].payload.thread_settings.model_provider_id).toBe("fixture-provider");
    expect(lines[3].payload.thread_settings.model).toBe("fixture-fast");
  });

  it("dedupes duplicate thread rows for the same rollout and cwd", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-25T11-00-00-openai.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-new", model_provider: "openai" } })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexDir, "session_index.jsonl"),
      [
        JSON.stringify({ id: "thread-old", thread_name: "Old", updated_at: "2026-08-25T00:00:00.000Z" }),
        JSON.stringify({ id: "thread-new", thread_name: "New", updated_at: "2026-08-25T01:00:00.000Z" }),
        "",
      ].join("\n"),
      "utf8",
    );
    const calls: string[] = [];
    const adapter = {
      discover: () => [path.join(codexDir, "state.sqlite")],
      open: () => ({
        dbPath: "state.sqlite",
        hasThreads: () => true,
        getColumns: () => ["id", "rollout_path", "model_provider", "cwd", "updated_at_ms"],
        readRows: ({ offset }: { offset: number }) =>
          offset === 0
            ? [
                {
                  id: "thread-old",
                  rollout_path: rolloutPath,
                  model_provider: "openai",
                  cwd: "/repo",
                  updated_at_ms: 1000,
                },
                {
                  id: "thread-new",
                  rollout_path: rolloutPath,
                  model_provider: "openai-custom",
                  cwd: "/repo",
                  updated_at_ms: 2000,
                },
              ]
            : [],
        exec: (sql: string) => calls.push(sql),
        run: (sql: string, values: unknown[]) => calls.push(`${sql} ${JSON.stringify(values)}`),
        close: () => calls.push("close"),
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
      batchSize: 100,
    });

    expect(result.dedupedRows).toBe(1);
    expect(calls.some((call) => call.includes("delete from threads where id = ?") && call.includes("thread-old"))).toBe(
      true,
    );
    const indexLine = fs.readFileSync(path.join(codexDir, "session_index.jsonl"), "utf8").trim();
    expect(JSON.parse(indexLine).id).toBe("thread-new");
  });

  it("keeps distinct same-second rollout files instead of deduping unrelated threads", async () => {
    const codexDir = tempDir();
    const dbPath = path.join(codexDir, "state.sqlite");
    const firstRollout = path.join(codexDir, "sessions", "rollout-2026-08-25T11-00-00-thread-a.jsonl");
    const secondRollout = path.join(codexDir, "sessions", "rollout-2026-08-25T11-00-00-thread-b.jsonl");
    fs.mkdirSync(path.dirname(firstRollout), { recursive: true });
    fs.writeFileSync(
      firstRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      secondRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-b", model_provider: "openai" } })}\n`,
      "utf8",
    );
    const rows: any[] = [
      {
        id: "thread-a",
        rollout_path: firstRollout,
        model_provider: "openai",
        cwd: "/repo",
        title: "First thread",
        created_at_ms: 1000,
        updated_at_ms: 1500,
      },
      {
        id: "thread-b",
        rollout_path: secondRollout,
        model_provider: "openai",
        cwd: "/repo",
        title: "Second thread",
        created_at_ms: 2000,
        updated_at_ms: 2500,
      },
    ];
    const columns = ["id", "rollout_path", "model_provider", "cwd", "title", "created_at_ms", "updated_at_ms"];
    const adapter = {
      discover: () => [dbPath],
      open: () => ({
        dbPath,
        hasThreads: () => true,
        getColumns: () => columns,
        readRows: ({ offset, limit }: { offset: number; limit: number }) => rows.slice(offset, offset + limit),
        exec: () => {},
        run: (sql: string, values: unknown[]) => {
          if (sql.startsWith("delete from threads")) {
            const index = rows.findIndex((row) => row.id === values[0]);
            if (index >= 0) rows.splice(index, 1);
          }
          if (sql.startsWith("update threads set")) {
            const id = values[values.length - 1];
            const target = rows.find((row) => row.id === id);
            if (target && sql.includes("model_provider")) target.model_provider = values[0];
          }
        },
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
    });

    expect(result.dedupedRows).toBe(0);
    expect(rows.map((row) => row.id).sort()).toEqual(["thread-a", "thread-b"]);
  });

  it("keeps sqlite thread ids aligned with rollout session ids when deduping provider rows", async () => {
    const codexDir = tempDir();
    const dbPath = path.join(codexDir, "state.sqlite");
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-25T11-30-00-source-thread.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "source-thread", model_provider: "openai" } })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexDir, ".codex-global-state.json"),
      `${JSON.stringify(
        {
          "projectless-thread-ids": ["target-provider-old-id"],
          "thread-project-assignments": {
            "target-provider-old-id": { projectKind: "local", projectId: "project-a" },
          },
          "app-server-migrated-pinned-thread-ids-by-host": {
            "local:/tmp/codex": ["target-provider-old-id"],
          },
          "electron-persisted-atom-state": {
            "thread-tab-routes-v1:target-provider-old-id": {
              routes: [{ params: { conversationId: "target-provider-old-id" } }],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const rows: any[] = [
      {
        id: "target-provider-old-id",
        rollout_path: rolloutPath,
        model_provider: "fixture-provider",
        cwd: "/repo",
        title: "Old target provider row",
        updated_at_ms: 1000,
      },
      {
        id: "source-thread",
        rollout_path: rolloutPath,
        model_provider: "openai",
        cwd: "/repo",
        title: "Source row",
        updated_at_ms: 2000,
      },
    ];
    const columns = ["id", "rollout_path", "model_provider", "cwd", "title", "updated_at_ms"];
    const adapter = {
      discover: () => [dbPath],
      open: () => ({
        dbPath,
        hasThreads: () => true,
        getColumns: () => columns,
        readRows: ({ offset, limit }: { offset: number; limit: number }) => rows.slice(offset, offset + limit),
        exec: () => {},
        run: (sql: string, values: unknown[]) => {
          if (sql.startsWith("delete from threads")) {
            const index = rows.findIndex((row) => row.id === values[0]);
            if (index >= 0) rows.splice(index, 1);
          }
          if (sql.startsWith("insert into threads")) {
            const next = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
            const existingIndex = rows.findIndex((row) => row.id === next.id);
            if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...next };
            else rows.push(next);
          }
          if (sql.startsWith("update threads set")) {
            const id = values[values.length - 1];
            const target = rows.find((row) => row.id === id);
            if (!target) return;
            const setColumns = columns.filter((column) => column !== "id");
            setColumns.forEach((column, index) => {
              target[column] = values[index];
            });
          }
        },
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
    });

    expect(result.dedupedRows).toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["source-thread"]);
    expect(rows[0]).toMatchObject({
      rollout_path: rolloutPath,
      model_provider: "fixture-provider",
    });
    const globalState = JSON.parse(fs.readFileSync(path.join(codexDir, ".codex-global-state.json"), "utf8"));
    expect(globalState["projectless-thread-ids"]).toEqual(["source-thread"]);
    expect(Object.keys(globalState["thread-project-assignments"])).toEqual(["source-thread"]);
    expect(globalState["app-server-migrated-pinned-thread-ids-by-host"]["local:/tmp/codex"]).toEqual([
      "source-thread",
    ]);
    expect(globalState["electron-persisted-atom-state"]["thread-tab-routes-v1:target-provider-old-id"]).toBeUndefined();
    expect(
      globalState["electron-persisted-atom-state"]["thread-tab-routes-v1:source-thread"].routes[0].params
        .conversationId,
    ).toBe("source-thread");
  });

  it("removes stale sqlite rows and all UI state references when rollout files are gone", async () => {
    const codexDir = tempDir();
    const dbPath = path.join(codexDir, "state.sqlite");
    const existingRollout = path.join(codexDir, "sessions", "rollout-2026-08-25T12-00-00-existing.jsonl");
    const missingRollout = path.join(codexDir, "sessions", "2026", "08", "12", "rollout-2026-08-12T16-37-20-missing.jsonl");
    fs.mkdirSync(path.dirname(existingRollout), { recursive: true });
    fs.writeFileSync(
      existingRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "existing-thread", model_provider: "openai" } })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexDir, "session_index.jsonl"),
      [
        JSON.stringify({ id: "missing-thread", thread_name: "Missing", updated_at: "2026-08-25T11:00:00.000Z" }),
        JSON.stringify({ id: "existing-thread", thread_name: "Existing", updated_at: "2026-08-25T12:00:00.000Z" }),
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexDir, ".codex-global-state.json"),
      `${JSON.stringify(
        {
          "pinned-thread-ids": ["missing-thread", "existing-thread"],
          "projectless-thread-ids": ["missing-thread", "existing-thread"],
          "thread-project-assignments": {
            "missing-thread": { projectKind: "local", projectId: "project-a" },
            "existing-thread": { projectKind: "local", projectId: "project-a" },
          },
          "electron-remote-hosted-pip-task-visibility-state": {
            "missing-thread": "shown",
            "existing-thread": "shown",
          },
          "app-server-migrated-pinned-thread-ids-by-host": {
            "local:/tmp/codex": ["missing-thread", "existing-thread"],
          },
          "electron-persisted-atom-state": {
            "heartbeat-thread-permissions-by-id": {
              "missing-thread": "allowed",
              "existing-thread": "allowed",
            },
            "thread-tab-routes-v1:missing-thread": {
              routes: [{ params: { conversationId: "missing-thread" } }],
            },
            "thread-tab-routes-v1:existing-thread": {
              routes: [{ params: { conversationId: "existing-thread" } }],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const rows: any[] = [
      {
        id: "missing-thread",
        rollout_path: missingRollout,
        model_provider: "openai",
        cwd: "/repo",
        title: "Missing",
        updated_at_ms: 1000,
      },
      {
        id: "existing-thread",
        rollout_path: existingRollout,
        model_provider: "openai",
        cwd: "/repo",
        title: "Existing",
        updated_at_ms: 2000,
      },
    ];
    const columns = ["id", "rollout_path", "model_provider", "cwd", "title", "updated_at_ms"];
    const adapter = {
      discover: () => [dbPath],
      open: () => ({
        dbPath,
        hasThreads: () => true,
        getColumns: () => columns,
        readRows: ({ offset, limit }: { offset: number; limit: number }) => rows.slice(offset, offset + limit),
        exec: () => {},
        run: (sql: string, values: unknown[]) => {
          if (sql.startsWith("delete from threads")) {
            const index = rows.findIndex((row) => row.id === values[0]);
            if (index >= 0) rows.splice(index, 1);
          }
          if (sql.startsWith("update threads set")) {
            const id = values[values.length - 1];
            const target = rows.find((row) => row.id === id);
            if (target && sql.includes("model_provider")) target.model_provider = values[0];
          }
        },
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
    });

    expect(result.staleRowsRemoved).toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["existing-thread"]);
    const indexEntries = fs
      .readFileSync(path.join(codexDir, "session_index.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(indexEntries.map((entry) => entry.id)).toEqual(["existing-thread"]);
    const globalState = JSON.parse(fs.readFileSync(path.join(codexDir, ".codex-global-state.json"), "utf8"));
    expect(globalState["pinned-thread-ids"]).toEqual(["existing-thread"]);
    expect(globalState["projectless-thread-ids"]).toEqual(["existing-thread"]);
    expect(Object.keys(globalState["thread-project-assignments"])).toEqual(["existing-thread"]);
    expect(Object.keys(globalState["electron-remote-hosted-pip-task-visibility-state"])).toEqual(["existing-thread"]);
    expect(globalState["app-server-migrated-pinned-thread-ids-by-host"]["local:/tmp/codex"]).toEqual([
      "existing-thread",
    ]);
    expect(Object.keys(globalState["electron-persisted-atom-state"]["heartbeat-thread-permissions-by-id"])).toEqual([
      "existing-thread",
    ]);
    expect(globalState["electron-persisted-atom-state"]["thread-tab-routes-v1:missing-thread"]).toBeUndefined();
    expect(
      globalState["electron-persisted-atom-state"]["thread-tab-routes-v1:existing-thread"].routes[0].params
        .conversationId,
    ).toBe("existing-thread");
  });

  it("cleans orphan UI state and session index entries after stale sqlite rows were already removed", async () => {
    const codexDir = tempDir();
    const dbPath = path.join(codexDir, "state.sqlite");
    const existingRollout = path.join(codexDir, "sessions", "rollout-2026-08-25T12-30-00-existing.jsonl");
    fs.mkdirSync(path.dirname(existingRollout), { recursive: true });
    fs.writeFileSync(
      existingRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "existing-thread", model_provider: "openai" } })}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexDir, "session_index.jsonl"),
      [
        JSON.stringify({ id: "already-removed-thread", thread_name: "Gone", updated_at: "2026-08-25T11:00:00.000Z" }),
        JSON.stringify({ id: "existing-thread", thread_name: "Existing", updated_at: "2026-08-25T12:00:00.000Z" }),
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(codexDir, ".codex-global-state.json"),
      `${JSON.stringify(
        {
          "projectless-thread-ids": ["already-removed-thread", "existing-thread"],
          "thread-project-assignments": {
            "already-removed-thread": { projectKind: "local", projectId: "project-a" },
            "existing-thread": { projectKind: "local", projectId: "project-a" },
          },
          "electron-persisted-atom-state": {
            "thread-tab-routes-v1:already-removed-thread": {
              routes: [{ params: { conversationId: "already-removed-thread" } }],
            },
            "thread-tab-routes-v1:existing-thread": {
              routes: [{ params: { conversationId: "existing-thread" } }],
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    const rows: any[] = [
      {
        id: "existing-thread",
        rollout_path: existingRollout,
        model_provider: "openai",
        cwd: "/repo",
        title: "Existing",
        updated_at_ms: 2000,
      },
    ];
    const columns = ["id", "rollout_path", "model_provider", "cwd", "title", "updated_at_ms"];
    const adapter = {
      discover: () => [dbPath],
      open: () => ({
        dbPath,
        hasThreads: () => true,
        getColumns: () => columns,
        readRows: ({ offset, limit }: { offset: number; limit: number }) => rows.slice(offset, offset + limit),
        exec: () => {},
        run: () => {},
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
    });

    expect(result.staleRowsRemoved).toBe(0);
    expect(result.orphanStateRefsRemoved).toBe(1);
    const indexEntries = fs
      .readFileSync(path.join(codexDir, "session_index.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(indexEntries.map((entry) => entry.id)).toEqual(["existing-thread"]);
    const globalState = JSON.parse(fs.readFileSync(path.join(codexDir, ".codex-global-state.json"), "utf8"));
    expect(globalState["projectless-thread-ids"]).toEqual(["existing-thread"]);
    expect(Object.keys(globalState["thread-project-assignments"])).toEqual(["existing-thread"]);
    expect(globalState["electron-persisted-atom-state"]["thread-tab-routes-v1:already-removed-thread"]).toBeUndefined();
  });

  it("repairs stale sqlite rollout paths by matching the rollout session id", async () => {
    const codexDir = tempDir();
    const dbPath = path.join(codexDir, "state.sqlite");
    const missingRollout = path.join(
      codexDir,
      "sessions",
      "2026",
      "08",
      "12",
      "rollout-2026-08-12T16-37-20-wrong-old-name.jsonl",
    );
    const actualRollout = path.join(
      codexDir,
      "archived_sessions",
      "rollout-2026-08-12T16-37-20-thread-a.jsonl",
    );
    fs.mkdirSync(path.dirname(actualRollout), { recursive: true });
    fs.writeFileSync(
      actualRollout,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } })}\n`,
      "utf8",
    );
    const rows: any[] = [
      {
        id: "thread-a",
        rollout_path: missingRollout,
        model_provider: "openai",
        cwd: "/repo",
        title: "Repair me",
        updated_at_ms: 1000,
      },
    ];
    const columns = ["id", "rollout_path", "model_provider", "cwd", "title", "updated_at_ms"];
    const adapter = {
      discover: () => [dbPath],
      open: () => ({
        dbPath,
        hasThreads: () => true,
        getColumns: () => columns,
        readRows: ({ offset, limit }: { offset: number; limit: number }) => rows.slice(offset, offset + limit),
        exec: () => {},
        run: (sql: string, values: unknown[]) => {
          if (sql === "update threads set rollout_path = ? where id = ?") {
            const target = rows.find((row) => row.id === values[1]);
            if (target) target.rollout_path = values[0];
          }
          if (sql.startsWith("update threads set model_provider")) {
            const id = values[values.length - 1];
            const target = rows.find((row) => row.id === id);
            if (target) target.model_provider = values[0];
          }
        },
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
    });

    expect(result.rolloutPathsRepaired).toBe(1);
    expect(result.staleRowsRemoved).toBe(0);
    expect(rows[0].rollout_path).toBe(actualRollout);
    expect(fs.readFileSync(actualRollout, "utf8")).toContain('"model_provider":"fixture-provider"');
  });

  it("backfills session_index from sqlite thread rows without loading message files", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-25T12-00-00-openai.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-from-db", model_provider: "openai" } })}\n`,
      "utf8",
    );
    const adapter = {
      discover: () => [path.join(codexDir, "state.sqlite")],
      open: () => ({
        dbPath: "state.sqlite",
        hasThreads: () => true,
        getColumns: () => ["id", "rollout_path", "model_provider", "cwd", "title", "first_user_message", "updated_at_ms"],
        readRows: ({ offset }: { offset: number }) =>
          offset === 0
            ? [
                {
                  id: "thread-from-db",
                  rollout_path: rolloutPath,
                  model_provider: "openai",
                  cwd: "/repo",
                  title: "Recovered title",
                  first_user_message: "Recovered prompt",
                  updated_at_ms: 2000,
                } as any,
              ]
            : [],
        exec: () => {},
        run: () => {},
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
    });

    const indexLine = fs.readFileSync(path.join(codexDir, "session_index.jsonl"), "utf8").trim();
    expect(result.indexChanged).toBe(true);
    expect(JSON.parse(indexLine)).toEqual({
      id: "thread-from-db",
      thread_name: "Recovered title",
      updated_at: "1970-01-01T00:00:02.000Z",
    });
  });

  it("copies missing thread rows between sqlite stores like the legacy electron sync", async () => {
    const codexDir = tempDir();
    const sourceDb = path.join(codexDir, "state_5.sqlite");
    const targetDb = path.join(codexDir, "sqlite", "state_5.sqlite");
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-25T13-00-00-openai.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } })}\n`,
      "utf8",
    );
    const columns = [
      "id",
      "rollout_path",
      "model_provider",
      "cwd",
      "title",
      "first_user_message",
      "updated_at_ms",
      "source",
      "approval_mode",
    ];
    const stores = new Map<string, any[]>([
      [
        sourceDb,
        [
          {
            id: "thread-a",
            rollout_path: rolloutPath,
            model_provider: "openai",
            cwd: "/repo",
            title: "Long history",
            first_user_message: "hello",
            updated_at_ms: 3000,
            source: "cli",
            approval_mode: "never",
          },
        ],
      ],
      [targetDb, []],
    ]);
    const adapter = {
      discover: () => [sourceDb, targetDb],
      open: (dbPath: string) => ({
        dbPath,
        hasThreads: () => true,
        getColumns: () => columns,
        readRows: ({ offset, limit }: { offset: number; limit: number }) =>
          (stores.get(dbPath) || []).slice(offset, offset + limit),
        exec: () => {},
        run: (sql: string, values: unknown[]) => {
          const rows = stores.get(dbPath)!;
          if (sql.startsWith("insert into threads")) {
            const next = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
            const existingIndex = rows.findIndex((row) => row.id === next.id);
            if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...next };
            else rows.push(next);
          }
          if (sql.startsWith("update threads set model_provider")) {
            for (const row of rows) row.model_provider = values[0];
          }
        },
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "fixture-provider",
      sqliteAdapter: adapter,
    });

    expect(result.skipped).toBe(false);
    expect(stores.get(targetDb)).toHaveLength(1);
    expect(stores.get(targetDb)?.[0]).toMatchObject({
      id: "thread-a",
      model_provider: "fixture-provider",
      title: "Long history",
    });
  });

  it("fills newer not-null sqlite columns when copying rows from older stores", async () => {
    const codexDir = tempDir();
    const sourceDb = path.join(codexDir, "sqlite", "state_5.sqlite");
    const targetDb = path.join(codexDir, "state_5.sqlite");
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-29T20-53-57-thread-a.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "fixture-provider" } })}\n`,
      "utf8",
    );
    const sourceColumns = ["id", "rollout_path", "model_provider", "cwd", "title", "updated_at_ms", "model"];
    const targetColumns = [
      "id",
      "rollout_path",
      "model_provider",
      "cwd",
      "title",
      "updated_at_ms",
      "model",
      "recency_at",
      "recency_at_ms",
      "history_mode",
      "is_pinned",
    ];
    const sourceRows = [
      {
        id: "thread-a",
        rollout_path: rolloutPath,
        model_provider: "fixture-provider",
        cwd: "/repo",
        title: "你好",
        updated_at_ms: 1000,
        model: "fixture-fast",
      },
    ];
    const targetRows: any[] = [];
    const adapter = {
      discover: () => [sourceDb, targetDb],
      open: (dbPath: string) => ({
        dbPath,
        hasThreads: () => true,
        getColumns: () => (dbPath === sourceDb ? sourceColumns : targetColumns),
        readRows: ({ offset }: { offset: number }) =>
          offset === 0 ? (dbPath === sourceDb ? sourceRows : targetRows) : [],
        exec: () => {},
        run: (sql: string, values: unknown[]) => {
          if (!sql.startsWith("insert into threads")) return;
          const next = Object.fromEntries(targetColumns.map((column, index) => [column, values[index]]));
          if (next.recency_at == null || next.recency_at_ms == null || next.history_mode == null || next.is_pinned == null) {
            throw new Error("NOT NULL constraint failed: threads.recency_at");
          }
          targetRows.push(next);
        },
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "chatgpt",
      targetModel: "gpt-5.5",
      sqliteAdapter: adapter,
    });

    expect(result.errors).toEqual([]);
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]).toMatchObject({
      model_provider: "chatgpt",
      model: "gpt-5.5",
      recency_at: 0,
      recency_at_ms: 0,
      history_mode: "legacy",
      is_pinned: 0,
    });
  });

  it("normalizes real sqlite rows through the default adapter when node sqlite is unavailable", async () => {
    const codexDir = tempDir();
    const dbPath = path.join(codexDir, "state_5.sqlite");
    const rolloutPath = path.join(codexDir, "sessions", "rollout-2026-08-29T20-53-57-thread-a.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({ type: "session_meta", payload: { id: "thread-a", model_provider: "fixture-provider" } })}\n`,
      "utf8",
    );
    sqlite3(
      dbPath,
      [
        "create table threads (id text primary key, rollout_path text not null, model_provider text not null, cwd text not null, title text not null, updated_at_ms integer, model text);",
        `insert into threads values ('thread-a', '${rolloutPath.replace(/'/g, "''")}', 'example', '/repo', '你好', 1000, 'fixture-fast');`,
      ].join("\n"),
    );

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "chatgpt",
      targetModel: "gpt-5.5",
    });
    const row = sqlite3(dbPath, "select model_provider || '|' || model from threads where id = 'thread-a';").trim();

    expect(result.errors).toEqual([]);
    expect(result.sqliteFiles).toBe(1);
    expect(row).toBe("chatgpt|gpt-5.5");
  });

  it("repairs a legacy one-ordinal gap after provider normalization and reports repair progress", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout-legacy-thread-a.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({
          timestamp: "2026-08-30T00:00:00.000Z",
          ordinal: 0,
          type: "session_meta",
          payload: { id: "thread-a", model_provider: "fixture-provider" },
        }),
        JSON.stringify({
          timestamp: "2026-08-30T00:00:01.000Z",
          ordinal: 1,
          type: "event_msg",
          payload: { type: "item_completed", item: { id: "reasoning-a", type: "Reasoning" } },
        }),
        JSON.stringify({
          timestamp: "2026-08-30T00:00:03.000Z",
          ordinal: 3,
          type: "response_item",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "保留" }] },
        }),
        "",
      ].join("\n"),
      "utf8",
    );
    const dbPath = path.join(codexDir, "thread_history_1.sqlite");
    fs.writeFileSync(dbPath, "database");
    const resetCalls: string[] = [];
    const progress: Array<{ phase: string }> = [];
    const threadHistoryAdapter = {
      discover: () => [dbPath],
      open: () => ({
        dbPath,
        getProjection: () => ({ nextRolloutOrdinal: 2, nextRolloutByteOffset: 999 }),
        resetThread: (threadId: string) => resetCalls.push(threadId),
        close: () => {},
      }),
    };

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "openai",
      targetModel: "gpt-5.5",
      sqliteAdapter: null,
      threadHistoryAdapter,
      onProgress: (entry) => progress.push(entry),
    });

    expect(result).toMatchObject({
      legacyRolloutsDetected: 1,
      legacyReasoningRowsRestored: 1,
      threadHistoryProjectionsReset: 1,
      repairBackupsCreated: 1,
    });
    expect(resetCalls).toEqual(["thread-a"]);
    expect(progress.some((entry) => entry.phase === "repair")).toBe(true);
    const entries = fs.readFileSync(rolloutPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.ordinal)).toEqual([0, 1, 2, 3]);
    expect(entries[2].payload).toEqual({
      type: "reasoning",
      id: "reasoning-a",
      summary: [],
      content: [],
    });
  });

  it("reports an unsafe legacy shape without mutating it or blocking queue completion", async () => {
    const codexDir = tempDir();
    const rolloutPath = path.join(codexDir, "sessions", "rollout-unsafe-thread-a.jsonl");
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      [
        JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: "thread-a", model_provider: "openai" } }),
        JSON.stringify({ ordinal: 3, type: "event_msg", payload: { type: "task_complete" } }),
        "",
      ].join("\n"),
      "utf8",
    );
    const before = fs.readFileSync(rolloutPath);

    const result = await syncThreadVisibility({
      codexDir,
      targetProvider: "openai",
      sqliteAdapter: null,
      threadHistoryAdapter: null,
    });

    expect(result.legacyRolloutsDetected).toBe(0);
    expect(result.legacyReasoningRowsRestored).toBe(0);
    expect(result.threadHistoryProjectionsReset).toBe(0);
    expect(result.repairBackupsCreated).toBe(0);
    expect(result.errors.some((error) => error.includes("unsupported ordinal gap"))).toBe(true);
    expect(fs.readFileSync(rolloutPath).equals(before)).toBe(true);
  });
});
