import fs from "node:fs";
import path from "node:path";

type PackagedBuildConfig = {
  serverBase?: unknown;
};

function normalizeServerBase(rawValue: unknown) {
  return String(rawValue || "").trim().replace(/\/+$/, "");
}

export function readPackagedServerBase(
  configPath = path.join(__dirname, "build-config.json"),
) {
  try {
    const config = JSON.parse(
      fs.readFileSync(configPath, "utf8"),
    ) as PackagedBuildConfig;
    return normalizeServerBase(config.serverBase);
  } catch {
    return "";
  }
}

export function resolveServerBase(
  rawValue = process.env.GPT_SWITCH_SERVER_BASE || "",
  packagedValue = readPackagedServerBase(),
) {
  return normalizeServerBase(rawValue) || normalizeServerBase(packagedValue);
}
