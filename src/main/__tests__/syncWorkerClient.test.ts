import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { SyncProgress, SyncSummary } from "../../shared/types";
import { runSyncThreadVisibilityInWorker } from "../syncWorkerClient";

class FakeWorker extends EventEmitter {
  terminated = false;

  async terminate() {
    this.terminated = true;
    return 0;
  }
}

function summary(): SyncSummary {
  return {
    skipped: false,
    sqliteFiles: 1,
    normalizedRows: 2,
    dedupedRows: 0,
    staleRowsRemoved: 0,
    orphanStateRefsRemoved: 0,
    rolloutPathsRepaired: 0,
    rolloutMetaScanned: 2,
    rolloutMetaUpdated: 1,
    legacyRolloutsDetected: 0,
    legacyReasoningRowsRestored: 0,
    threadHistoryProjectionsReset: 0,
    repairBackupsCreated: 0,
    indexChanged: false,
    pinnedChanged: false,
    errors: [],
  };
}

describe("syncWorkerClient", () => {
  it("runs thread visibility sync in a worker and forwards progress", async () => {
    const worker = new FakeWorker();
    const workerInputs: unknown[] = [];
    const progress: SyncProgress[] = [];
    const expectedSummary = summary();

    const result = runSyncThreadVisibilityInWorker(
      {
        codexDir: "C:\\Users\\Example\\.codex",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        batchSize: 25,
        rolloutQueueLimit: 3,
        onProgress: (entry) => progress.push(entry),
      },
      {
        createWorker: (workerData) => {
          workerInputs.push(workerData);
          return worker;
        },
      },
    );

    const progressEntry: SyncProgress = {
      runId: "sync-1",
      phase: "scan",
      processed: 5,
      message: "扫描线程记录",
    };
    worker.emit("message", { type: "progress", progress: progressEntry });
    worker.emit("message", { type: "result", summary: expectedSummary });

    await expect(result).resolves.toBe(expectedSummary);
    expect(progress).toEqual([progressEntry]);
    expect(workerInputs).toEqual([
      {
        codexDir: "C:\\Users\\Example\\.codex",
        targetProvider: "openai",
        targetModel: "gpt-5.5",
        batchSize: 25,
        rolloutQueueLimit: 3,
      },
    ]);
  });

  it("rejects when the sync worker reports an error", async () => {
    const worker = new FakeWorker();
    const result = runSyncThreadVisibilityInWorker(
      {
        codexDir: "C:\\Users\\Example\\.codex",
        targetProvider: "openai",
      },
      {
        createWorker: () => worker,
      },
    );

    worker.emit("message", { type: "error", error: { message: "sync failed" } });

    await expect(result).rejects.toThrow("sync failed");
  });
});
