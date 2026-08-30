import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop package version source", () => {
  it("keeps an independently configured desktop package version for packaging", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"),
    );
    const buildScriptPath = path.resolve(
      __dirname,
      "../../../scripts/build-electron.mjs",
    );

    expect(packageJson.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(packageJson.scripts["build:win"]).toContain("electron-builder");
    expect(packageJson.scripts["build:mac"]).toContain("electron-builder");
    expect(packageJson.scripts["build:mac"]).toContain("-c.electronDist=node_modules/electron/dist");
    expect(packageJson.scripts["build:win"]).not.toContain("scripts/build-electron.mjs");
    expect(packageJson.scripts["build:mac"]).not.toContain("scripts/build-electron.mjs");
    expect(fs.existsSync(buildScriptPath)).toBe(false);
  });

  it("packages the GPT Switch icon for Electron builds", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"),
    );
    const buildDir = path.resolve(__dirname, "../../../build");

    expect(packageJson.build.icon).toBe("build/icon");
    expect(packageJson.build.win.icon).toBe("build/icon.ico");
    expect(packageJson.build.files).toContain("build/icon.png");
    expect(packageJson.build.npmRebuild).toBe(false);
    for (const filename of ["icon.svg", "icon.png", "icon.ico", "icon.icns"]) {
      expect(fs.existsSync(path.join(buildDir, filename))).toBe(true);
    }

    const sourceIcon = fs.readFileSync(path.join(buildDir, "icon.svg"), "utf8");
    expect(sourceIcon).toContain("<title>GPT Switch</title>");
    expect(sourceIcon).toContain("#E32A4B");
  });

  it("uses the GPT Switch icon as the renderer favicon", () => {
    const publicDir = path.resolve(__dirname, "../../../public");
    const indexHtml = fs.readFileSync(
      path.resolve(__dirname, "../../../index.html"),
      "utf8",
    );

    expect(indexHtml).toContain(
      '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />',
    );
    expect(fs.existsSync(path.join(publicDir, "favicon.svg"))).toBe(true);
  });
});
