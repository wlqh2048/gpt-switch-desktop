import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const outputPath = path.join(appRoot, "dist", "main", "build-config.json");

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const separatorIndex = trimmed.indexOf("=");
  if (separatorIndex < 1) return null;
  const key = trimmed.slice(0, separatorIndex).trim();
  let value = trimmed.slice(separatorIndex + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadLocalEnv() {
  const inheritedEnv = new Set(Object.keys(process.env));
  const localEnv = {};
  for (const filename of [".env", ".env.local"]) {
    const filePath = path.join(appRoot, filename);
    if (!fs.existsSync(filePath)) continue;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      localEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(localEnv)) {
    if (!inheritedEnv.has(key)) process.env[key] = value;
  }
}

function normalizeServerBase(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

loadLocalEnv();

const serverBase = normalizeServerBase(process.env.GPT_SWITCH_SERVER_BASE);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify({ serverBase }, null, 2)}\n`);

if (serverBase) {
  console.log(`Wrote packaged server base: ${serverBase}`);
} else {
  console.warn("GPT_SWITCH_SERVER_BASE is empty; packaged catalog APIs are disabled.");
}
