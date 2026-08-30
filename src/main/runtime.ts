import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeActionResult } from "../shared/types";

export const RESTART_DELAY_MS = 1500;

const APP_TARGETS = [
  {
    label: "ChatGPT",
    macAppName: "ChatGPT",
    windowsWhereName: "ChatGPT",
    windowsProcessNames: ["ChatGPT.exe", "chatgpt.exe"],
    windowsStoreQuery: "*ChatGPT*",
    windowsStoreSuffixes: ["!App", "!ChatGPT", ""],
    windowsCandidates: (env: NodeJS.ProcessEnv) => [
      path.win32.join(envValue(env, "LOCALAPPDATA"), "Microsoft", "WindowsApps", "ChatGPT.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "Programs", "ChatGPT", "ChatGPT.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "Programs", "OpenAI ChatGPT", "ChatGPT.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "Programs", "OpenAI", "ChatGPT", "ChatGPT.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "chatgpt", "ChatGPT.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "ChatGPT", "ChatGPT.exe"),
      path.win32.join(programFiles(env), "ChatGPT", "ChatGPT.exe"),
      path.win32.join(programFiles(env), "OpenAI ChatGPT", "ChatGPT.exe"),
      path.win32.join(programFiles(env), "OpenAI", "ChatGPT", "ChatGPT.exe"),
      path.win32.join(programFilesX86(env), "ChatGPT", "ChatGPT.exe"),
      path.win32.join(programFilesX86(env), "OpenAI ChatGPT", "ChatGPT.exe"),
      path.win32.join(programFilesX86(env), "OpenAI", "ChatGPT", "ChatGPT.exe"),
      path.win32.join(programFiles(env), "WindowsApps", "OpenAI.ChatGPT", "ChatGPT.exe"),
      path.win32.join(envValue(env, "USERPROFILE"), "scoop", "apps", "chatgpt", "current", "ChatGPT.exe"),
    ],
  },
  {
    label: "Codex",
    macAppName: "Codex",
    windowsWhereName: "Codex",
    windowsProcessNames: ["Codex.exe", "codex.exe"],
    windowsStoreQuery: "*Codex*",
    windowsStoreSuffixes: ["!App", "!Codex", ""],
    windowsCandidates: (env: NodeJS.ProcessEnv) => [
      path.win32.join(envValue(env, "LOCALAPPDATA"), "Microsoft", "WindowsApps", "Codex.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "Programs", "Codex", "Codex.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "codex", "Codex.exe"),
      path.win32.join(envValue(env, "LOCALAPPDATA"), "Codex", "Codex.exe"),
      path.win32.join(programFiles(env), "Codex", "Codex.exe"),
      path.win32.join(programFiles(env), "codex", "Codex.exe"),
      path.win32.join(programFilesX86(env), "Codex", "Codex.exe"),
      path.win32.join(programFilesX86(env), "codex", "Codex.exe"),
      path.win32.join(programFiles(env), "WindowsApps", "OpenAI.Codex", "Codex.exe"),
      path.win32.join(envValue(env, "USERPROFILE"), "scoop", "apps", "codex", "current", "Codex.exe"),
    ],
  },
];

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function envValue(env: NodeJS.ProcessEnv, key: string, fallback = "") {
  const exact = env[key];
  if (exact) return exact;
  const lower = key.toLowerCase();
  const foundKey = Object.keys(env).find((item) => item.toLowerCase() === lower);
  return foundKey ? String(env[foundKey] || "") : fallback;
}

function programFiles(env: NodeJS.ProcessEnv) {
  return envValue(env, "PROGRAMFILES", "C:\\Program Files");
}

function programFilesX86(env: NodeJS.ProcessEnv) {
  return (
    envValue(env, "PROGRAMFILES(X86)") ||
    envValue(env, "ProgramFiles(x86)") ||
    "C:\\Program Files (x86)"
  );
}

function existingPath(candidates: string[]) {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

function killMacApp(appName: string) {
  try {
    execFileSync("osascript", ["-e", `quit app "${appName}"`], { stdio: "ignore" });
  } catch {}
}

function startMacApp(appName: string) {
  spawn("open", ["-a", appName], { detached: true, stdio: "ignore" }).unref();
}

function killWindowsProcesses(names: string[]) {
  for (const name of names) {
    try {
      execFileSync("taskkill", ["/IM", name, "/F"], { stdio: "ignore" });
    } catch {}
  }
}

function startWindowsApp(exePath: string) {
  spawn(exePath, [], { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

function startWindowsShellApp(shellPath: string) {
  spawn("cmd.exe", ["/c", "start", "", shellPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  }).unref();
}

function startWindowsFromPath(target: (typeof APP_TARGETS)[number]) {
  try {
    const whereResult = String(
      execFileSync("where", [target.windowsWhereName], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ).trim();
    const exePath = whereResult
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (!exePath) return null;
    startWindowsApp(exePath);
    return { success: true, message: `${target.label} 已启动` };
  } catch {
    return null;
  }
}

function startWindowsFromStore(target: (typeof APP_TARGETS)[number]) {
  try {
    const packageFamily = String(
      execFileSync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `$pkg = Get-AppxPackage -Name '${target.windowsStoreQuery}' | Select-Object -First 1; if ($pkg) { $pkg.PackageFamilyName }`,
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    )
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && !line.includes("PackageFamilyName"));
    if (!packageFamily) return null;
    const suffix = target.windowsStoreSuffixes[0] || "";
    startWindowsShellApp(`shell:AppsFolder\\${packageFamily}${suffix}`);
    return { success: true, message: `${target.label} 已启动` };
  } catch {
    return null;
  }
}

function startWindowsFromCandidates(target: (typeof APP_TARGETS)[number], env: NodeJS.ProcessEnv) {
  const exePath = existingPath(target.windowsCandidates(env));
  if (!exePath) return null;
  startWindowsApp(exePath);
  return { success: true, message: `${target.label} 已启动` };
}

function startWindowsTarget(env: NodeJS.ProcessEnv): RuntimeActionResult {
  for (const target of APP_TARGETS) {
    const result =
      startWindowsFromPath(target) ||
      startWindowsFromCandidates(target, env) ||
      startWindowsFromStore(target);
    if (result) return result;
  }
  return { success: false, message: "未找到 ChatGPT 或 Codex 安装路径" };
}

export async function stopChatGPTRuntime(): Promise<RuntimeActionResult> {
  if (process.platform === "darwin") {
    for (const target of APP_TARGETS) {
      killMacApp(target.macAppName);
    }
    await sleep(RESTART_DELAY_MS);
    return { success: true, message: "ChatGPT/Codex 已关闭" };
  }
  if (process.platform === "win32") {
    for (const target of APP_TARGETS) {
      killWindowsProcesses(target.windowsProcessNames);
    }
    await sleep(RESTART_DELAY_MS);
    return { success: true, message: "ChatGPT/Codex 已关闭" };
  }
  return {
    success: false,
    message: `当前系统暂不支持自动关闭: ${os.platform()}`,
  };
}

export async function startChatGPTRuntime(env: NodeJS.ProcessEnv = process.env): Promise<RuntimeActionResult> {
  if (process.platform === "darwin") {
    startMacApp("ChatGPT");
    return { success: true, message: "ChatGPT 已启动" };
  }
  if (process.platform === "win32") {
    return startWindowsTarget(env);
  }
  return {
    success: false,
    message: `当前系统暂不支持自动启动: ${os.platform()}`,
  };
}

export async function restartChatGPT(env: NodeJS.ProcessEnv = process.env) {
  const stopResult = await stopChatGPTRuntime();
  if (!stopResult.success) {
    return {
      success: false,
      message: `当前系统暂不支持自动重启: ${os.platform()}`,
    };
  }
  return startChatGPTRuntime(env);
}
