import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { testCatalog } from "./fixtures/catalog";
import { ProfileStore } from "../profileStore";

function tempStore() {
  return new ProfileStore({
    storeDir: fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-profile-")),
    now: () => new Date("2026-08-25T08:00:00.000Z"),
  });
}

describe("ProfileStore", () => {
  it("lists local custom profiles when the official catalog is empty", () => {
    const store = tempStore();
    store.createCustomProfile({
      title: "Local Only",
      providerId: "local-only",
      baseUrl: "https://local-only.example.com/v1",
      model: "local-only-model",
      apiKey: "local-api-key",
    });

    const profiles = store.listProfiles({ version: 1, updated_at: "1970-01-01T00:00:00.000Z", providers: [] });

    expect(profiles).toHaveLength(1);
    expect(profiles[0].title).toBe("Local Only");
    expect(profiles[0].source).toBe("custom");
  });

  it("lists locked official providers before custom profiles", () => {
    const store = tempStore();
    store.createCustomProfile({
      title: "Local",
      providerId: "local",
      baseUrl: "https://local.example.com/v1",
      model: "local-model",
      apiKey: "local-api-key",
    });

    const profiles = store.listProfiles(testCatalog);

    expect(profiles[0].id).toBe("fixture-official");
    expect(profiles[0].locked).toBe(true);
    expect(profiles[0].apiKeyState).toBe("missing");
    expect(profiles[1].title).toBe("Local");
    expect(profiles[1].apiKeyState).toBe("saved");
  });

  it("allows official provider to save model selection", () => {
    const store = tempStore();

    const saved = store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-pro",
    });

    expect(saved.model).toBe("fixture-pro");
    expect(store.listProfiles(testCatalog)[0].model).toBe("fixture-pro");
    expect(() =>
      store.saveOfficialOverride(testCatalog, {
        providerId: "fixture-official",
        apiKey: "test-api-key",
        model: "not-in-catalog",
      }),
    ).toThrow(/model is not allowed/);
  });

  it("does not persist official api keys when saving official selections", () => {
    const store = tempStore();

    store.saveOfficialOverride(testCatalog, {
      providerId: "fixture-official",
      apiKey: "test-api-key",
      model: "fixture-fast",
    });

    const stored = fs.readFileSync(path.join(store.getOfficialOverridesDir(), "fixture-official.json"), "utf8");
    expect(stored).not.toContain("test-api-key");
    expect(() => store.resolveProfile(testCatalog, "fixture-official")).toThrow(/API Key is required/);
    expect(store.resolveProfile(testCatalog, "fixture-official", "api-key-from-localstorage").apiKey).toBe(
      "api-key-from-localstorage",
    );
  });

  it("ignores unversioned official model overrides from older app builds", () => {
    const store = tempStore();
    store.ensure();
    fs.writeFileSync(
      path.join(store.getOfficialOverridesDir(), "fixture-official.json"),
      JSON.stringify({
        providerId: "fixture-official",
        model: "fixture-pro",
        updatedAt: "2026-08-24T00:00:00.000Z",
      }),
      "utf8",
    );

    expect(store.listProfiles(testCatalog)[0].model).toBe("fixture-fast");
    expect(store.resolveProfile(testCatalog, "fixture-official", "api-key-from-localstorage").model).toBe(
      "fixture-fast",
    );
  });

  it("rejects delete and template update for official provider", () => {
    const store = tempStore();

    expect(() => store.deleteProfile(testCatalog, "fixture-official")).toThrow(/official profile cannot be deleted/);
    expect(() =>
      store.updateCustomProfile(testCatalog, "fixture-official", {
        title: "Hacked",
        providerId: "changed",
        baseUrl: "https://example.com",
        model: "changed",
        apiKey: "sk",
      }),
    ).toThrow(/official profile cannot be edited/);
  });

  it("supports custom create update delete and active state", () => {
    const store = tempStore();
    const created = store.createCustomProfile({
      title: "Local A",
      providerId: "local-a",
      baseUrl: "https://local-a.example.com/v1",
      model: "local-a-model",
      apiKey: "api-key-a",
    });

    const updated = store.updateCustomProfile(testCatalog, created.id, {
      title: "Local B",
      providerId: "local-b",
      baseUrl: "https://local-b.example.com/v1",
      model: "local-b-model",
      apiKey: "api-key-b",
    });
    store.setActiveProfile(updated.id, { model: updated.model });

    expect(store.resolveProfile(testCatalog, updated.id).providerId).toBe("local-b");
    expect(store.readActive()?.id).toBe(updated.id);
    store.deleteProfile(testCatalog, updated.id);
    expect(store.listProfiles(testCatalog).some((profile) => profile.id === updated.id)).toBe(false);
  });

  it("keeps a custom api key when editing with an empty key", () => {
    const store = tempStore();
    const created = store.createCustomProfile({
      title: "Local A",
      providerId: "local-a",
      baseUrl: "https://local-a.example.com/v1",
      model: "local-a-model",
      apiKey: "api-key-a",
    });

    store.updateCustomProfile(testCatalog, created.id, {
      title: "Local B",
      providerId: "local-b",
      baseUrl: "https://local-b.example.com/v1",
      model: "local-b-model",
      apiKey: "",
    });

    expect(store.resolveProfile(testCatalog, created.id).apiKey).toBe("api-key-a");
  });

  it("keeps a custom note as the user-facing description", () => {
    const store = tempStore();
    store.createCustomProfile({
      title: "Local With Note",
      providerId: "local-note",
      baseUrl: "https://local-note.example.com/v1",
      model: "local-note-model",
      apiKey: "note-api-key",
      note: "日常备用线路",
    });

    const profiles = store.listProfiles(testCatalog);

    expect(profiles.find((profile) => profile.title === "Local With Note")?.description).toBe("日常备用线路");
  });

  it("stores ChatGPT raw profiles with config and auth files only", () => {
    const store = tempStore();
    const created = store.createCustomProfile({
      configMode: "chatgpt",
      title: "ChatGPT 账号",
      configToml: 'model = "gpt-5"\nmodel_provider = "corp-openai"\n',
      authJson: '{"auth_mode":"chatgpt"}',
    } as any);

    const listed = store.listProfiles(testCatalog).find((profile) => profile.id === created.id);
    const resolved = store.resolveProfile(testCatalog, created.id);

    expect(listed?.configMode).toBe("chatgpt");
    expect(listed?.providerId).toBe("corp-openai");
    expect(listed?.model).toBe("gpt-5");
    expect(listed?.apiKeyState).toBe("saved");
    expect(listed?.description).toBe("ChatGPT 配置");
    expect(resolved.configMode).toBe("chatgpt");
    expect(resolved.providerId).toBe("corp-openai");
    expect(resolved.model).toBe("gpt-5");
    expect(resolved.rawConfig?.configToml).toContain('model = "gpt-5"');
    expect(resolved.ownedFiles).toEqual(["config.toml", "auth.json"]);
  });

  it("defaults ChatGPT raw profiles without model_provider to openai", () => {
    const store = tempStore();
    const created = store.createCustomProfile({
      configMode: "chatgpt",
      title: "ChatGPT 账号",
      configToml: 'model = "gpt-5.5"\n',
      authJson: '{"auth_mode":"chatgpt"}',
    } as any);

    const listed = store.listProfiles(testCatalog).find((profile) => profile.id === created.id);
    const resolved = store.resolveProfile(testCatalog, created.id);

    expect(listed?.providerId).toBe("openai");
    expect(resolved.providerId).toBe("openai");
    expect(resolved.model).toBe("gpt-5.5");
  });
});
