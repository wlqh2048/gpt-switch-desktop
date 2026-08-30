import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SyncProgress, SyncSummary } from "../../shared/types";
import { ProfileStore } from "../profileStore";
import { testCatalog } from "./fixtures/catalog";

const { progressEntry, runSyncMock, workerSummary } = vi.hoisted(() => {
  const progressEntry: SyncProgress = {
    runId: "sync-worker-test",
    phase: "scan",
    processed: 1,
    message: "扫描线程记录",
  };
  const workerSummary: SyncSummary = {
    skipped: false,
    sqliteFiles: 0,
    normalizedRows: 1,
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
    errors: [],
  };
  const runSyncMock = vi.fn(async (options: { onProgress?: (progress: SyncProgress) => void }) => {
    options.onProgress?.(progressEntry);
    return workerSummary;
  });
  return { progressEntry, runSyncMock, workerSummary };
});

vi.mock("../syncWorkerClient", () => ({
  runSyncThreadVisibilityInWorker: runSyncMock,
}));

describe("applyProfile worker sync", () => {
  it("runs message sync through the worker client by default", async () => {
    const { applyProfile } = await import("../applyProfile");
    const codexDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-apply-worker-"));
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    });
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });
    const progress: SyncProgress[] = [];

    const result = await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
      onProgress: (entry) => progress.push(entry),
    });

    expect(runSyncMock).toHaveBeenCalledTimes(1);
    expect(runSyncMock).toHaveBeenCalledWith({
      codexDir,
      targetProvider: "fixture-provider",
      targetModel: "fixture-fast",
      onProgress: expect.any(Function),
    });
    expect(progress).toEqual([progressEntry]);
    expect(result.sync).toBe(workerSummary);
  });
});
