import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyProfile } from "../applyProfile";
import { testCatalog } from "./fixtures/catalog";
import { ProfileStore } from "../profileStore";

function tempDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("applyProfile", () => {
  it("snapshots existing codex files then writes selected official profile", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    fs.writeFileSync(path.join(codexDir, "config.toml"), 'model = "old"\n', "utf8");
    fs.writeFileSync(path.join(codexDir, "auth.json"), '{"OPENAI_API_KEY":"old"}\n', "utf8");
    fs.writeFileSync(path.join(codexDir, "models.json"), '{"models":[]}\n', "utf8");
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });

    const result = await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8")).toContain(
      'experimental_bearer_token = "test-api-key"',
    );
    expect(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")).toBe('{"OPENAI_API_KEY":"old"}\n');
    expect(JSON.parse(fs.readFileSync(path.join(codexDir, "models.json"), "utf8")).models.length).toBeGreaterThan(0);
    const snapshots = fs.readdirSync(store.getSnapshotsDir());
    expect(snapshots).toHaveLength(1);
    expect(fs.existsSync(path.join(store.getSnapshotsDir(), snapshots[0], "config.toml"))).toBe(true);
  });

  it("keeps official server templates clean when old provider blocks exist", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        'model_provider = "openai-custom"',
        "",
        "[model_providers.openai-custom]",
        'name = "Custom"',
        'base_url = "https://legacy.example.test/v1"',
        'wire_api = "responses"',
        "requires_openai_auth = true",
        "",
      ].join("\n"),
      "utf8",
    );
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
    });

    const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    expect(config).toContain("[model_providers.fixture-provider]");
    expect(config).not.toContain("[model_providers.openai-custom]");
    expect(config).toContain('base_url = "https://provider.invalid"');
    expect(config).not.toContain("https://legacy.example.test/v1");
  });

  it("does not write compatibility aliases into official server templates", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    store.createCustomProfile({
      title: "Local V2",
      providerId: "local-v2",
      baseUrl: "https://local-v2.example.com/v1",
      model: "local-v2-model",
      apiKey: "local-api-key",
    });
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
    });

    const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    expect(config).toContain("[model_providers.fixture-provider]");
    expect(config).not.toContain("[model_providers.openai-custom]");
    expect(config).not.toContain("[model_providers.local-v2]");
  });

  it("applies official profiles with the api key supplied by the renderer", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "api-key-that-should-not-be-written",
      model: "fixture-fast",
    });

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "api-key-from-localstorage",
    });

    const config = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    expect(config).toContain('model = "fixture-fast"');
    expect(config).toContain('experimental_bearer_token = "api-key-from-localstorage"');
    expect(config).not.toContain("api-key-that-should-not-be-written");
  });

  it("stops runtime before writing config and starts after applying the profile", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    const configPath = path.join(codexDir, "config.toml");
    fs.writeFileSync(configPath, 'model = "gpt-5.5"\nmodel_provider = "chatgpt"\n', "utf8");
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });
    const events: string[] = [];

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
      runtime: {
        stop: async () => {
          events.push(`stop:${fs.readFileSync(configPath, "utf8")}`);
          return { success: true, message: "stopped" };
        },
        start: async () => {
          events.push(`start:${fs.readFileSync(configPath, "utf8")}`);
          return { success: true, message: "started" };
        },
      },
    } as any);

    expect(events).toHaveLength(2);
    expect(events[0]).toContain('model = "gpt-5.5"');
    expect(events[1]).toContain('model = "fixture-fast"');
  });

  it("keeps auth json when no active profile owns it", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    fs.writeFileSync(path.join(codexDir, "auth.json"), '{"auth_mode":"chatgpt"}\n', "utf8");
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
    });

    expect(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")).toBe('{"auth_mode":"chatgpt"}\n');
  });

  it("withdraws files owned by the active profile before applying the next profile", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    const chatgptProfile = store.createCustomProfile({
      configMode: "chatgpt",
      title: "ChatGPT 账号",
      configToml: 'model = "gpt-5"\nmodel_provider = "openai"\n',
      authJson: '{"auth_mode":"chatgpt"}',
    } as any);
    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
    });
    expect(fs.existsSync(path.join(codexDir, "models.json"))).toBe(true);

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: chatgptProfile.id,
      store,
    });
    expect(fs.existsSync(path.join(codexDir, "models.json"))).toBe(false);
    expect(fs.readFileSync(path.join(codexDir, "auth.json"), "utf8")).toBe('{"auth_mode":"chatgpt"}\n');

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: "fixture-official",
      store,
      apiKey: "test-api-key",
    });
    expect(fs.existsSync(path.join(codexDir, "auth.json"))).toBe(false);
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8")).toContain(
      'model = "fixture-fast"',
    );
    expect(JSON.parse(fs.readFileSync(path.join(codexDir, "models.json"), "utf8")).models.length).toBeGreaterThan(0);
  });

  it("syncs omitted ChatGPT model_provider as openai", async () => {
    const codexDir = tempDir("ai-model-apply-codex-");
    const store = new ProfileStore({
      storeDir: path.join(codexDir, "ai-model-v2"),
      now: () => new Date("2026-08-25T08:00:00.000Z"),
    });
    const rolloutPath = path.join(
      codexDir,
      "sessions",
      "2026",
      "08",
      "29",
      "rollout-2026-08-29T20-53-57-thread-a.jsonl",
    );
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(
      rolloutPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-a", model_provider: "fixture-provider" },
      })}\n`,
      "utf8",
    );
    const profile = store.createCustomProfile({
      configMode: "chatgpt",
      title: "ChatGPT 账号",
      configToml: 'model = "gpt-5.5"\n',
      authJson: '{"auth_mode":"chatgpt"}',
    } as any);

    await applyProfile({
      codexDir,
      catalog: testCatalog,
      profileId: profile.id,
      store,
    });

    const sessionMeta = JSON.parse(fs.readFileSync(rolloutPath, "utf8").trim());
    expect(sessionMeta.payload.model_provider).toBe("openai");
    expect(fs.readFileSync(path.join(codexDir, "config.toml"), "utf8")).not.toContain("model_provider");
  });
});
