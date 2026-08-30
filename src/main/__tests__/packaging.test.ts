import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("packaging configuration", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8"),
  );

  it("keeps renderer-only libraries out of packaged production dependencies", () => {
    const productionDependencies = packageJson.dependencies || {};

    expect(productionDependencies).not.toHaveProperty("react");
    expect(productionDependencies).not.toHaveProperty("react-dom");
    expect(productionDependencies).not.toHaveProperty("antd");
    expect(productionDependencies).not.toHaveProperty("@ant-design/icons");
  });

  it("runs the mac package size optimizer after packing", () => {
    const hookPath = path.resolve(__dirname, "../../../scripts/after-pack.cjs");

    expect(packageJson.build.afterPack).toBe("scripts/after-pack.cjs");
    expect(fs.existsSync(hookPath)).toBe(true);
  });

  it("optimizes mac framework duplicates and locales", () => {
    const { optimizeMacFramework } = require("../../../scripts/after-pack.cjs");
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gpt-switch-pack-"));
    const frameworkDir = path.join(tempDir, "Electron Framework.framework");

    for (const entry of [
      "Electron Framework",
      "Helpers/tool",
      "Libraries/lib.dylib",
      "Resources/fr.lproj/locale.pak",
      "Versions/A/Electron Framework",
      "Versions/A/Helpers/tool",
      "Versions/A/Libraries/lib.dylib",
      "Versions/A/Resources/en.lproj/locale.pak",
      "Versions/A/Resources/zh_CN.lproj/locale.pak",
      "Versions/A/Resources/fr.lproj/locale.pak",
      "Versions/Current/Electron Framework",
    ]) {
      const filePath = path.join(frameworkDir, entry);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, "x");
    }

    optimizeMacFramework(frameworkDir);

    expect(
      fs.lstatSync(path.join(frameworkDir, "Electron Framework")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.lstatSync(path.join(frameworkDir, "Versions", "Current")).isSymbolicLink(),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(frameworkDir, "Versions", "A", "Resources", "fr.lproj"),
      ),
    ).toBe(false);
    expect(
      fs.existsSync(
        path.join(frameworkDir, "Versions", "A", "Resources", "en.lproj"),
      ),
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(frameworkDir, "Versions", "A", "Resources", "zh_CN.lproj"),
      ),
    ).toBe(true);
  });
});
