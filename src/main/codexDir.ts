import os from "node:os";
import path from "node:path";

export function resolveCodexDir(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.CODEX_HOME || env.CODEX_DIR;
  if (explicit && explicit.trim()) return path.resolve(explicit);
  return path.join(os.homedir(), ".codex");
}

export function resolveStoreDir(codexDir: string) {
  return path.join(codexDir, "ai-model-v2");
}
