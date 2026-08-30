import path from "node:path";
import { RuntimeActionResult } from "../shared/types";
import { ensureDir, removeFileIfExists } from "./fsUtils";
import { ProfileStore } from "./profileStore";
import { snapshotCodexFiles } from "./applyProfile";

const RESET_FILES = ["config.toml", "models.json", "auth.json"] as const;

async function callRuntimeAction(
  action?: () => Promise<RuntimeActionResult>,
): Promise<RuntimeActionResult | undefined> {
  if (!action) return undefined;
  try {
    return await action();
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function resetCodexConfiguration({
  codexDir,
  store,
  runtime,
}: {
  codexDir: string;
  store: ProfileStore;
  runtime?: {
    stop?: () => Promise<RuntimeActionResult>;
    start?: () => Promise<RuntimeActionResult>;
  };
}) {
  ensureDir(codexDir);
  const runtimeState: {
    stop?: RuntimeActionResult;
    start?: RuntimeActionResult;
  } = {};
  const stopResult = await callRuntimeAction(runtime?.stop);
  if (stopResult) runtimeState.stop = stopResult;

  snapshotCodexFiles({
    codexDir,
    snapshotsDir: store.getSnapshotsDir(),
  });
  for (const fileName of RESET_FILES) {
    removeFileIfExists(path.join(codexDir, fileName));
  }
  store.clearActiveProfile();

  const startResult = await callRuntimeAction(runtime?.start);
  if (startResult) runtimeState.start = startResult;
  const runtimeResult =
    runtimeState.stop || runtimeState.start ? runtimeState : undefined;
  return {
    success: true,
    message: startResult?.success
      ? "已重置为未登录状态，ChatGPT 已重启"
      : "已重置为未登录状态，可重启 ChatGPT 生效",
    active: null,
    runtime: runtimeResult,
  };
}
