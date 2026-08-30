import fs from "node:fs";
import path from "node:path";
import { ApplyResult, CodexConfigFile, ProviderCatalog, RuntimeActionResult, SyncProgress } from "../shared/types";
import { atomicWriteFile, ensureDir, removeFileIfExists, writeJsonFile } from "./fsUtils";
import { ProfileStore } from "./profileStore";
import { renderCodexFiles } from "./renderConfig";
import { runSyncThreadVisibilityInWorker } from "./syncWorkerClient";

function timestampSegment(now: Date) {
  return now.toISOString().replace(/[:.]/g, "-");
}

function copyIfExists(sourcePath: string, targetPath: string) {
  if (!fs.existsSync(sourcePath)) return false;
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function withdrawOwnedFiles(codexDir: string, ownedFiles: CodexConfigFile[]) {
  for (const fileName of new Set(ownedFiles)) {
    removeFileIfExists(path.join(codexDir, fileName));
  }
}

async function callRuntimeAction(action?: () => Promise<RuntimeActionResult>): Promise<RuntimeActionResult | undefined> {
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

export function snapshotCodexFiles({
  codexDir,
  snapshotsDir,
  now = new Date(),
}: {
  codexDir: string;
  snapshotsDir: string;
  now?: Date;
}) {
  const dir = path.join(snapshotsDir, timestampSegment(now));
  ensureDir(dir);
  const copied = [
    copyIfExists(path.join(codexDir, "config.toml"), path.join(dir, "config.toml")),
    copyIfExists(path.join(codexDir, "auth.json"), path.join(dir, "auth.json")),
    copyIfExists(path.join(codexDir, "models.json"), path.join(dir, "models.json")),
  ].filter(Boolean).length;
  writeJsonFile(path.join(dir, "manifest.json"), {
    createdAt: now.toISOString(),
    codexDir,
    copied,
  });
  return { dir, copied };
}

export async function applyProfile({
  codexDir,
  catalog,
  profileId,
  store,
  apiKey,
  runtime,
  onProgress,
}: {
  codexDir: string;
  catalog: ProviderCatalog;
  profileId: string;
  store: ProfileStore;
  apiKey?: string;
  runtime?: {
    stop?: () => Promise<RuntimeActionResult>;
    start?: () => Promise<RuntimeActionResult>;
  };
  onProgress?: (progress: SyncProgress) => void;
}): Promise<ApplyResult> {
  ensureDir(codexDir);
  const profile = store.resolveProfile(catalog, profileId, apiKey);
  const runtimeState: ApplyResult["runtime"] = {};
  const stopResult = await callRuntimeAction(runtime?.stop);
  if (stopResult) runtimeState.stop = stopResult;
  const previousActive = store.readActive();
  const configPath = path.join(codexDir, "config.toml");
  snapshotCodexFiles({
    codexDir,
    snapshotsDir: store.getSnapshotsDir(),
  });
  const previousOwnedFiles = previousActive?.ownedFiles?.length
    ? previousActive.ownedFiles
    : previousActive?.id
      ? store.ownedFilesForProfile(catalog, previousActive.id)
      : [];
  withdrawOwnedFiles(codexDir, previousOwnedFiles);

  const rendered = renderCodexFiles({ profile, codexDir });
  if (rendered.modelsJson) {
    atomicWriteFile(path.join(codexDir, "models.json"), rendered.modelsJson);
  }
  atomicWriteFile(configPath, rendered.configToml);
  if (rendered.authJson) {
    atomicWriteFile(path.join(codexDir, "auth.json"), rendered.authJson);
  }
  const sync = await runSyncThreadVisibilityInWorker({
    codexDir,
    targetProvider: profile.providerId,
    targetModel: profile.model,
    onProgress,
  });
  const active = store.setActiveProfile(profile.id, { model: profile.model, sync, ownedFiles: rendered.ownedFiles });
  const startResult = await callRuntimeAction(runtime?.start);
  if (startResult) runtimeState.start = startResult;
  const runtimeResult = runtimeState.stop || runtimeState.start ? runtimeState : undefined;
  return {
    success: true,
    message: startResult?.success ? "配置已启用，ChatGPT 已重启" : "配置已启用，可重启 ChatGPT 生效",
    active,
    sync,
    runtime: runtimeResult,
  };
}
