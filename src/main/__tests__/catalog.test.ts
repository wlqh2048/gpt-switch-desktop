import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fetchLatestDownload,
  fetchProviderCatalog,
  fetchServerVersion,
  loadProviderCatalogForDisplay,
  loadServerVersionForDisplay,
} from "../catalog";

function providerTemplate(model = "remote-model") {
  return {
    config_toml: "template.model={{model}}\ntemplate.secret={{apiKey}}",
    models_json: { models: [{ slug: model, display_name: model }] },
  };
}

describe("catalog fixtures", () => {
  it("keeps the shared provider fixture free of rendered config templates", () => {
    const fixtureSource = fs.readFileSync(path.resolve(__dirname, "fixtures/catalog.ts"), "utf8");

    expect(fixtureSource).not.toContain("config_template");
    expect(fixtureSource).not.toContain("config_toml");
    expect(fixtureSource).not.toContain("models_json");
    expect(fixtureSource).not.toContain("[model_providers.");
  });
});

describe("fetchProviderCatalog", () => {
  it("returns an empty display catalog without fetching when server base is empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(loadProviderCatalogForDisplay({ serverBase: "", fetchImpl })).resolves.toEqual({
      catalog: {
        version: 1,
        updated_at: "1970-01-01T00:00:00.000Z",
        providers: [],
      },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns an empty display version without fetching when server base is empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(loadServerVersionForDisplay({ serverBase: "", fetchImpl })).resolves.toEqual({
      serverVersion: "",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses server catalog without writing an official catalog cache", async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-catalog-"));
    const catalog = await fetchProviderCatalog({
      serverBase: "https://catalog.example.com",
      storeDir,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            catalog: {
              version: 1,
              providers: [
                {
                  id: "remote-official",
                  title: "Remote",
                  locked: true,
                  provider_id: "remote",
                  base_url: "https://remote.example.com/",
                  wire_api: "responses",
                  auth: { type: "bearer_token", config_key: "experimental_bearer_token" },
                  default_model: "remote-model",
                  models: [{ slug: "remote-model", display_name: "Remote Model" }],
                  config_template: providerTemplate(),
                  editable_fields: ["apiKey", "model"],
                },
              ],
            },
          }),
        ),
    });

    expect(catalog.providers[0].id).toBe("remote-official");
    expect(fs.existsSync(path.join(storeDir, "catalog-cache.json"))).toBe(false);
  });

  it("does not use stale official cache when the server is unavailable", async () => {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-catalog-"));
    fs.writeFileSync(
      path.join(storeDir, "catalog-cache.json"),
      JSON.stringify({
        version: 1,
        providers: [
          {
            id: "cached-official",
            title: "Cached",
            locked: true,
            provider_id: "cached",
            base_url: "https://cached.example.com/",
            wire_api: "responses",
            auth: { type: "bearer_token", config_key: "experimental_bearer_token" },
            default_model: "cached-model",
            models: [{ slug: "cached-model", display_name: "Cached Model" }],
            editable_fields: ["apiKey", "model"],
          },
        ],
      }),
      "utf8",
    );

    await expect(
      fetchProviderCatalog({
        serverBase: "https://catalog.example.com",
        storeDir,
        fetchImpl: async () => {
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow(/服务器异常/);
  });

  it("reports invalid server catalog as a service error", async () => {
    await expect(
      fetchProviderCatalog({
        serverBase: "https://catalog.example.com",
        storeDir: fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-catalog-")),
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              success: true,
              catalog: {
                version: 1,
                providers: [],
              },
            }),
          ),
      }),
    ).rejects.toThrow(/catalog\.providers must not be empty/);
  });

  it("throws when the catalog endpoint returns an error", async () => {
    await expect(
      fetchProviderCatalog({
        serverBase: "https://catalog.example.com",
        storeDir: fs.mkdtempSync(path.join(os.tmpdir(), "ai-model-catalog-")),
        fetchImpl: async () => new Response("nope", { status: 503 }),
      }),
    ).rejects.toThrow(/catalog http 503/);
  });

  it("returns an empty official catalog for display when the server is unavailable", async () => {
    const result = await loadProviderCatalogForDisplay({
      serverBase: "https://catalog.example.com",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });

    expect(result.catalog.providers).toEqual([]);
    expect(result.catalogError).toMatch(/服务器异常/);
  });

  it("fetches only the displayed version from the backend", async () => {
    const result = await fetchServerVersion({
      serverBase: "https://catalog.example.com",
      fetchImpl: async (input) => {
        expect(String(input)).toBe("https://catalog.example.com/api/catalog/v1/version");
        return new Response(
          JSON.stringify({
            success: true,
            version: "9.8.7",
            update_url: "https://example.com/download",
            downloads: {
              windows: { label: "Windows", url: "https://example.com/GPT-Switch.exe" },
              macos: { label: "macOS", url: "https://example.com/GPT-Switch.dmg" },
            },
          }),
        );
      },
    });

    expect(result.version).toBe("9.8.7");
    expect("updateUrl" in (result as Record<string, unknown>)).toBe(false);
    expect("downloads" in (result as Record<string, unknown>)).toBe(false);
  });

  it("fetches the latest platform download from the dynamic download endpoint", async () => {
    const result = await fetchLatestDownload({
      serverBase: "https://catalog.example.com",
      platform: "macos",
      fetchImpl: async (input) => {
        expect(String(input)).toBe("https://catalog.example.com/api/downloads/v1/latest?platform=macos");
        return new Response(
          JSON.stringify({
            success: true,
            platform: "macos",
            version: "9.8.7",
            name: "GPT-Switch-9.8.7.dmg",
            url: "https://download.example.com/GPT-Switch-9.8.7.dmg",
            expires_in: 300,
          }),
        );
      },
    });

    expect(result).toEqual({
      platform: "macos",
      version: "9.8.7",
      name: "GPT-Switch-9.8.7.dmg",
      url: "https://download.example.com/GPT-Switch-9.8.7.dmg",
      expiresIn: 300,
    });
  });

  it("rejects invalid dynamic download responses", async () => {
    await expect(
      fetchLatestDownload({
        serverBase: "https://catalog.example.com",
        platform: "windows",
        fetchImpl: async () =>
          new Response(
            JSON.stringify({
              success: true,
              platform: "windows",
              version: "9.8.7",
              name: "GPT-Switch.exe",
              url: "ftp://download.example.com/GPT-Switch.exe",
              expires_in: 300,
            }),
          ),
      }),
    ).rejects.toThrow(/download.url must be http or https/);
  });

  it("ignores legacy update links from the version manifest", async () => {
    const result = await fetchServerVersion({
      serverBase: "https://catalog.example.com",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            success: true,
            version: "9.8.7",
            update_url: "www.baidu.com",
            updateUrl: "https://example.com/download",
          }),
        ),
    });

    expect(result.version).toBe("9.8.7");
    expect("updateUrl" in (result as Record<string, unknown>)).toBe(false);
  });

  it("returns an empty display version when the backend version endpoint is unavailable", async () => {
    const result = await loadServerVersionForDisplay({
      serverBase: "https://catalog.example.com",
      fetchImpl: async () => new Response("nope", { status: 503 }),
    });

    expect(result.serverVersion).toBe("");
    expect("serverVersionUpdateUrl" in (result as Record<string, unknown>)).toBe(false);
    expect("serverVersionDownloads" in (result as Record<string, unknown>)).toBe(false);
    expect(result.serverVersionError).toMatch(/服务器异常/);
  });
});
