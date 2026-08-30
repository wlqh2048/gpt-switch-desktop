import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("renderer dev mock", () => {
  const oldLocalCatalogFallback = `http://${["127", "0", "0", "1"].join(".")}:${[
    "44",
    "66",
  ].join("")}`;
  const productionCatalogHost = `https://${["switch", "eting", "com"].join(".")}`;
  const hostedAnalyticsHost = ["cloud", "um" + "ami", "is"].join(".");

  it("does not install a local renderer mock API", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../main.tsx"),
      "utf8",
    );

    expect(source).not.toContain("installMockApi");
    expect(source).not.toContain("VITE_ENABLE_MOCK_API");
  });

  it("does not keep a renderer mock API file", () => {
    expect(fs.existsSync(path.resolve(__dirname, "../mockApi.ts"))).toBe(false);
  });

  it("uses a server-backed browser preview API when the Electron bridge is missing", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../App.tsx"),
      "utf8",
    );

    expect(source).toContain("createBrowserPreviewApi");
    expect(source).toContain("BROWSER_SERVER_BASE");
    expect(source).not.toContain(`|| "${oldLocalCatalogFallback}"`);
    expect(source).not.toContain(productionCatalogHost);
    expect(source).toContain("/api/catalog/v1/providers");
    expect(source).toContain("/api/catalog/v1/version");
    expect(source).toContain("const aiModel = window.aiModel");
    expect(source).toContain("return aiModel || createBrowserPreviewApi(t)");
    expect(source).not.toContain('message.error(t("clientOnlyError")');
  });

  it("does not auto-start the catalog server from electron dev", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../scripts/dev.mjs"),
      "utf8",
    );

    expect(source).not.toContain("AUTO_START_CATALOG_SERVER");
    expect(source).not.toContain("startLocalCatalogService");
    expect(source).not.toContain('run("pnpm", ["start"]');
  });

  it("loads ignored local env values without keeping a catalog fallback", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../scripts/dev.mjs"),
      "utf8",
    );

    expect(source).toContain("loadLocalEnv");
    expect(source).toContain('".env.local"');
    expect(source).not.toContain(oldLocalCatalogFallback);
    expect(source).not.toContain(productionCatalogHost);
  });

  it("uses one catalog service env var for main and renderer code", () => {
    const appSource = fs.readFileSync(
      path.resolve(__dirname, "../App.tsx"),
      "utf8",
    );
    const devSource = fs.readFileSync(
      path.resolve(__dirname, "../../../scripts/dev.mjs"),
      "utf8",
    );
    const viteSource = fs.readFileSync(
      path.resolve(__dirname, "../../../vite.config.mts"),
      "utf8",
    );

    expect(appSource).toContain("import.meta.env.GPT_SWITCH_SERVER_BASE");
    expect(appSource).not.toContain("VITE_AI_MODEL_SERVER_BASE");
    expect(devSource).toContain("process.env.GPT_SWITCH_SERVER_BASE");
    expect(devSource).not.toContain("process.env.SERVER_BASE");
    expect(devSource).not.toContain("VITE_AI_MODEL_SERVER_BASE");
    expect(viteSource).toContain("loadEnv");
    expect(viteSource).toContain('"import.meta.env.GPT_SWITCH_SERVER_BASE"');
    expect(viteSource).not.toContain("envPrefix");
  });

  it("keeps real local env values out of committable env files", () => {
    const gitignore = fs.readFileSync(
      path.resolve(__dirname, "../../../.gitignore"),
      "utf8",
    );
    const envExample = fs.readFileSync(
      path.resolve(__dirname, "../../../.env.example"),
      "utf8",
    );

    expect(gitignore).toContain(".env.local");
    expect(envExample).toContain("GPT_SWITCH_SERVER_BASE=");
    expect(envExample).not.toContain("VITE_AI_MODEL_SERVER_BASE");
    expect(envExample).not.toMatch(/^SERVER_BASE=/m);
    expect(envExample).toContain("VITE_ANALYTICS_SCRIPT_URL=");
    expect(envExample).toContain("VITE_ANALYTICS_WEBSITE_ID=");
    expect(envExample).not.toContain(productionCatalogHost);
    expect(envExample).not.toContain(hostedAnalyticsHost);
  });
});
