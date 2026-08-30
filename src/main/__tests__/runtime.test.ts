import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { restartChatGPT, startChatGPTRuntime, stopChatGPTRuntime } from "../runtime";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(),
    },
  };
});

const execFileSyncMock = vi.mocked(execFileSync);
const spawnMock = vi.mocked(spawn);
const existsSyncMock = vi.mocked(fs.existsSync);

function setPlatform(platform: NodeJS.Platform) {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: platform });
  return () => {
    if (original) Object.defineProperty(process, "platform", original);
  };
}

describe("restartChatGPT", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(false);
    execFileSyncMock.mockReturnValue(Buffer.from(""));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits after closing ChatGPT before starting it on macOS", async () => {
    const restorePlatform = setPlatform("darwin");
    try {
      const restart = restartChatGPT();

      expect(execFileSyncMock).toHaveBeenCalledWith("osascript", ["-e", 'quit app "ChatGPT"'], {
        stdio: "ignore",
      });
      expect(spawnMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1499);
      expect(spawnMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await expect(restart).resolves.toEqual({ success: true, message: "ChatGPT 已启动" });
      expect(spawnMock).toHaveBeenCalledWith("open", ["-a", "ChatGPT"], {
        detached: true,
        stdio: "ignore",
      });
    } finally {
      restorePlatform();
    }
  });

  it("stops both ChatGPT and Codex before config files are changed on macOS", async () => {
    const restorePlatform = setPlatform("darwin");
    try {
      const stop = stopChatGPTRuntime();

      expect(execFileSyncMock).toHaveBeenCalledWith("osascript", ["-e", 'quit app "ChatGPT"'], {
        stdio: "ignore",
      });
      expect(execFileSyncMock).toHaveBeenCalledWith("osascript", ["-e", 'quit app "Codex"'], {
        stdio: "ignore",
      });
      expect(spawnMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      await expect(stop).resolves.toEqual({ success: true, message: "ChatGPT/Codex 已关闭" });
    } finally {
      restorePlatform();
    }
  });

  it("starts ChatGPT without closing apps again on macOS", async () => {
    const restorePlatform = setPlatform("darwin");
    try {
      await expect(startChatGPTRuntime()).resolves.toEqual({ success: true, message: "ChatGPT 已启动" });

      expect(execFileSyncMock).not.toHaveBeenCalled();
      expect(spawnMock).toHaveBeenCalledWith("open", ["-a", "ChatGPT"], {
        detached: true,
        stdio: "ignore",
      });
    } finally {
      restorePlatform();
    }
  });

  it("finds ChatGPT from Windows app aliases and uppercase env vars", async () => {
    const restorePlatform = setPlatform("win32");
    const exePath = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\ChatGPT.exe";
    existsSyncMock.mockImplementation((candidate) => String(candidate) === exePath);
    execFileSyncMock.mockImplementation((command) => {
      if (command === "where") throw new Error("not in PATH");
      return Buffer.from("");
    });

    try {
      const restart = restartChatGPT({
        LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
        PROGRAMFILES: "C:\\Program Files",
        "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        USERPROFILE: "C:\\Users\\tester",
      });

      await vi.advanceTimersByTimeAsync(1500);
      await expect(restart).resolves.toEqual({ success: true, message: "ChatGPT 已启动" });
      expect(spawnMock).toHaveBeenCalledWith(exePath, [], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } finally {
      restorePlatform();
    }
  });
});
