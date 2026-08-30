import fs from "node:fs";
import path from "node:path";

export function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

export function atomicWriteFile(filePath: string, content: string) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function writeJsonFile(filePath: string, data: unknown) {
  atomicWriteFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function removeFileIfExists(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (error) {
    throw new Error(`remove ${filePath} failed: ${(error as Error).message}`);
  }
}

export function toTomlPath(filePath: string) {
  return filePath.replace(/\\/g, "/");
}
