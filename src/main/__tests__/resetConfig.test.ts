import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProfileStore } from "../profileStore";
import { resetCodexConfiguration } from "../resetConfig";

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function emptyCatalog() {
  return {
    version: 1,
    updated_at: "1970-01-01T00:00:00.000Z",
    providers: [],
  };
}

describe("resetCodexConfiguration", () => {
  it("snapshots and removes GPT Switch config files without deleting saved profiles", async () => {
    const codexDir = tempDir("ai-model-reset-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-30T08:00:00.000Z"),
    });
    const profile = store.createCustomProfile({
      configMode: "chatgpt",
      title: "GPT 账号",
      configToml: 'model = "gpt-5"\nmodel_provider = "openai"\n',
      authJson: '{"auth_mode":"chatgpt"}',
    });
    store.setActiveProfile(profile.id, {
      model: "gpt-5",
      ownedFiles: ["config.toml", "auth.json"],
    });
    fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "deepseek"\n', "utf8");
    fs.writeFileSync(path.join(codexDir, "models.json"), '{"models":[]}\n', "utf8");
    fs.writeFileSync(path.join(codexDir, "auth.json"), '{"auth_mode":"chatgpt"}\n', "utf8");

    const result = await resetCodexConfiguration({ codexDir, store });

    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(codexDir, "config.toml"))).toBe(false);
    expect(fs.existsSync(path.join(codexDir, "models.json"))).toBe(false);
    expect(fs.existsSync(path.join(codexDir, "auth.json"))).toBe(false);
    expect(store.readActive()).toBeNull();
    expect(store.listProfiles(emptyCatalog()).find((item) => item.id === profile.id)).toBeTruthy();
    const snapshots = fs.readdirSync(store.getSnapshotsDir());
    expect(snapshots).toHaveLength(1);
    expect(fs.existsSync(path.join(store.getSnapshotsDir(), snapshots[0], "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(store.getSnapshotsDir(), snapshots[0], "models.json"))).toBe(true);
    expect(fs.existsSync(path.join(store.getSnapshotsDir(), snapshots[0], "auth.json"))).toBe(true);
  });

  it("stops ChatGPT before resetting files and starts it after reset", async () => {
    const codexDir = tempDir("ai-model-reset-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-30T08:00:00.000Z"),
    });
    const configPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(configPath, 'model = "deepseek"\n', "utf8");
    const events: string[] = [];

    const result = await resetCodexConfiguration({
      codexDir,
      store,
      runtime: {
        stop: async () => {
          events.push(`stop:${fs.existsSync(configPath)}`);
          return { success: true, message: "stopped" };
        },
        start: async () => {
          events.push(`start:${fs.existsSync(configPath)}`);
          return { success: true, message: "started" };
        },
      },
    });

    expect(events).toEqual(["stop:true", "start:false"]);
    expect(result.runtime?.stop?.success).toBe(true);
    expect(result.runtime?.start?.success).toBe(true);
  });
});
