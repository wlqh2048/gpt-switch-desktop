import { parentPort, workerData } from "node:worker_threads";
import { syncThreadVisibility } from "./syncEngine";
import { SyncWorkerInput } from "./syncWorkerClient";

function serializeError(error: unknown) {
  return {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  };
}

async function run() {
  if (!parentPort) throw new Error("sync worker requires a parent port");
  const port = parentPort;
  const input = workerData as SyncWorkerInput;
  const summary = await syncThreadVisibility({
    codexDir: input.codexDir,
    targetProvider: input.targetProvider,
    targetModel: input.targetModel,
    batchSize: input.batchSize,
    rolloutQueueLimit: input.rolloutQueueLimit,
    onProgress: (progress) => port.postMessage({ type: "progress", progress }),
  });
  port.postMessage({ type: "result", summary });
}

void run().catch((error) => {
  parentPort?.postMessage({ type: "error", error: serializeError(error) });
});
