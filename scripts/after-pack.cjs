const fs = require("node:fs");
const path = require("node:path");

const KEEP_LOCALES = new Set(["en.lproj", "zh_CN.lproj"]);

function replaceWithSymlink(targetPath, linkTarget, type) {
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.symlinkSync(linkTarget, targetPath, type);
}

function pruneLocales(resourcesDir) {
  if (!fs.existsSync(resourcesDir)) return;
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.endsWith(".lproj")) continue;
    if (KEEP_LOCALES.has(entry.name)) continue;
    fs.rmSync(path.join(resourcesDir, entry.name), {
      recursive: true,
      force: true,
    });
  }
}

function optimizeMacFramework(frameworkDir) {
  const versionDir = path.join(frameworkDir, "Versions", "A");
  if (!fs.existsSync(versionDir)) return;

  pruneLocales(path.join(versionDir, "Resources"));

  replaceWithSymlink(
    path.join(frameworkDir, "Versions", "Current"),
    "A",
    "dir",
  );
  replaceWithSymlink(
    path.join(frameworkDir, "Electron Framework"),
    path.join("Versions", "Current", "Electron Framework"),
    "file",
  );
  replaceWithSymlink(
    path.join(frameworkDir, "Helpers"),
    path.join("Versions", "Current", "Helpers"),
    "dir",
  );
  replaceWithSymlink(
    path.join(frameworkDir, "Libraries"),
    path.join("Versions", "Current", "Libraries"),
    "dir",
  );
  replaceWithSymlink(
    path.join(frameworkDir, "Resources"),
    path.join("Versions", "Current", "Resources"),
    "dir",
  );
}

function optimizeMacPackage(appOutDir, productFilename) {
  const frameworkDir = path.join(
    appOutDir,
    `${productFilename}.app`,
    "Contents",
    "Frameworks",
    "Electron Framework.framework",
  );
  optimizeMacFramework(frameworkDir);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  optimizeMacPackage(context.appOutDir, context.packager.appInfo.productFilename);
};

module.exports.optimizeMacFramework = optimizeMacFramework;
module.exports.optimizeMacPackage = optimizeMacPackage;
