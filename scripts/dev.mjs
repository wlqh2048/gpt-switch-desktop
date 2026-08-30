import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const children = new Set();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");

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

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

function runOnce(command, args) {
  return new Promise((resolve, reject) => {
    const child = run(command, args);
    child.on("exit", (code) => {
      if (code) reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      else resolve();
    });
  });
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findPort(startPort) {
  for (let port = startPort; port < startPort + 20; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No available port from ${startPort}`);
}

function normalizeServerBase(value) {
  return String(value || "").replace(/\/+$/, "");
}

function resolveCatalogService() {
  return normalizeServerBase(process.env.GPT_SWITCH_SERVER_BASE);
}

function shutdown() {
  for (const child of children) child.kill();
}

process.on("SIGINT", () => {
  shutdown();
  process.exit(130);
});
process.on("SIGTERM", () => {
  shutdown();
  process.exit(143);
});

loadLocalEnv();

await runOnce("pnpm", ["exec", "tsc", "-p", "tsconfig.main.json"]);

const catalogServerBase = resolveCatalogService();
const port = await findPort(Number(process.env.VITE_PORT || 5174));
const devServerUrl = `http://127.0.0.1:${port}`;
const devEnv = {
  ...process.env,
};
if (catalogServerBase) {
  devEnv.GPT_SWITCH_SERVER_BASE = catalogServerBase;
}
const tsc = run("pnpm", ["exec", "tsc", "-p", "tsconfig.main.json", "--watch", "--preserveWatchOutput"], {
  env: devEnv,
});
const vite = run("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", String(port)], {
  env: devEnv,
});

setTimeout(() => {
  const electron = run("pnpm", ["exec", "electron", "."], {
    env: {
      ...devEnv,
      VITE_DEV_SERVER_URL: devServerUrl,
    },
  });
  electron.on("exit", (code) => {
    shutdown();
    process.exit(code || 0);
  });
}, 2200);

tsc.on("exit", (code) => {
  if (code) {
    shutdown();
    process.exit(code);
  }
});
vite.on("exit", (code) => {
  if (code) {
    shutdown();
    process.exit(code);
  }
});
