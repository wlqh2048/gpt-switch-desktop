import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { SyncProgress, SyncSummary } from "../shared/types";
import { syncThreadVisibility } from "./syncEngine";

export interface SyncWorkerInput {
  codexDir: string;
  targetProvider: string;
  targetModel?: string;
  batchSize?: number;
  rolloutQueueLimit?: number;
}

type SyncWorkerMessage =
  | { type: "progress"; progress: SyncProgress }
  | { type: "result"; summary: SyncSummary }
  | { type: "error"; error?: { message?: string; stack?: string } };

interface WorkerLike {
  on(event: "message", listener: (message: SyncWorkerMessage) => void): WorkerLike;
  on(event: "error", listener: (error: Error) => void): WorkerLike;
  on(event: "exit", listener: (code: number) => void): WorkerLike;
  off?(event: "message", listener: (message: SyncWorkerMessage) => void): WorkerLike;
  off?(event: "error", listener: (error: Error) => void): WorkerLike;
  off?(event: "exit", listener: (code: number) => void): WorkerLike;
}

interface SyncWorkerClientDependencies {
  createWorker?: (workerData: SyncWorkerInput) => WorkerLike;
}

export interface SyncWorkerClientOptions extends SyncWorkerInput {
  onProgress?: (progress: SyncProgress) => void;
}

function syncWorkerPath() {
  return path.join(__dirname, "syncWorker.js");
}

function createSyncWorker(workerData: SyncWorkerInput) {
  return new Worker(syncWorkerPath(), { workerData });
}

function canUseDirectSyncFallback() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

export function runSyncThreadVisibilityInWorker(
  { onProgress, ...workerData }: SyncWorkerClientOptions,
  dependencies: SyncWorkerClientDependencies = {},
): Promise<SyncSummary> {
  if (!dependencies.createWorker && !fs.existsSync(syncWorkerPath()) && canUseDirectSyncFallback()) {
    return syncThreadVisibility({ ...workerData, onProgress });
  }
  const worker = (dependencies.createWorker || createSyncWorker)(workerData);
  let settled = false;

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.off?.("message", onMessage);
      worker.off?.("error", onError);
      worker.off?.("exit", onExit);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onMessage = (message: SyncWorkerMessage) => {
      if (message.type === "progress") {
        onProgress?.(message.progress);
        return;
      }
      if (message.type === "result") {
        finish(() => resolve(message.summary));
        return;
      }
      if (message.type === "error") {
        const error = new Error(message.error?.message || "sync worker failed");
        if (message.error?.stack) error.stack = message.error.stack;
        finish(() => reject(error));
      }
    };
    const onError = (error: Error) => finish(() => reject(error));
    const onExit = (code: number) => {
      if (code !== 0) finish(() => reject(new Error(`sync worker exited with code ${code}`)));
    };

    worker.on("message", onMessage);
    worker.on("error", onError);
    worker.on("exit", onExit);
  });
}
