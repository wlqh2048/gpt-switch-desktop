import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import path from "node:path";
import { applyProfile } from "./applyProfile";
import {
  fetchProviderCatalog,
  loadProviderCatalogForDisplay,
  loadServerVersionForDisplay,
} from "./catalog";
import { resolveCodexDir, resolveStoreDir } from "./codexDir";
import { ProfileStore } from "./profileStore";
import { restartChatGPT, startChatGPTRuntime, stopChatGPTRuntime } from "./runtime";
import { resolveServerBase } from "./serverBase";
import {
  CustomProfileInput,
  ProviderCatalog,
  SyncProgress,
} from "../shared/types";

const codexDir = resolveCodexDir();
const storeDir = resolveStoreDir(codexDir);
const serverBase = resolveServerBase();
const store = new ProfileStore({ storeDir });
const appIconPath = path.join(__dirname, "..", "..", "build", "icon.png");

let mainWindow: BrowserWindow | null = null;
let catalogCache: ProviderCatalog | null = null;

function sendSyncProgress(progress: SyncProgress) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("sync:progress", progress);
}

async function getCatalog() {
  catalogCache = await fetchProviderCatalog({ serverBase, storeDir });
  return catalogCache;
}

async function getDisplayCatalog() {
  const result = await loadProviderCatalogForDisplay({ serverBase, storeDir });
  if (!result.catalogError) catalogCache = result.catalog;
  return result;
}

async function getDisplayServerVersion() {
  return loadServerVersionForDisplay({ serverBase });
}

async function bootstrap() {
  const [
    { catalog, catalogError },
    { serverVersion, serverVersionError },
  ] = await Promise.all([getDisplayCatalog(), getDisplayServerVersion()]);
  return {
    version: app.getVersion(),
    serverVersion,
    serverVersionError,
    codexDir,
    storeDir,
    serverBase,
    catalog,
    catalogError,
    profiles: store.listProfiles(catalog),
    active: store.readActive(),
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 760,
    minHeight: 520,
    title: "GPT Switch",
    titleBarStyle:
      process.platform === "darwin"
        ? "hiddenInset"
        : process.platform === "win32"
          ? "hidden"
          : "default",
    trafficLightPosition:
      process.platform === "darwin" ? { x: 18, y: 18 } : undefined,
    titleBarOverlay:
      process.platform === "win32"
        ? {
            color: "#ffffff",
            symbolColor: "#64748b",
            height: 48,
          }
        : false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  nativeTheme.themeSource = "system";
  mainWindow.setMenuBarVisibility(false);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file://")) return;
    event.preventDefault();
    openExternal(url);
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL;
  if (devServerUrl) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  }
}

function openExternal(rawUrl: string) {
  return shell.openExternal(rawUrl);
}

function asErrorResult(error: unknown) {
  return {
    success: false,
    message: error instanceof Error ? error.message : String(error),
  };
}

function registerIpc() {
  ipcMain.handle("bootstrap:get", () => bootstrap());
  ipcMain.handle("catalog:refresh", async () => {
    const catalog = await getCatalog();
    return { success: true, catalog, profiles: store.listProfiles(catalog) };
  });
  ipcMain.handle("profiles:list", async () => {
    const { catalog, catalogError } = await getDisplayCatalog();
    return {
      success: true,
      catalogError,
      profiles: store.listProfiles(catalog),
      active: store.readActive(),
    };
  });
  ipcMain.handle("profiles:save-official-key", async (_event, payload) => {
    try {
      const catalog = await getCatalog();
      store.saveOfficialOverride(catalog, payload);
      return { success: true, profiles: store.listProfiles(catalog) };
    } catch (error) {
      return asErrorResult(error);
    }
  });
  ipcMain.handle(
    "profiles:create",
    async (_event, payload: CustomProfileInput) => {
      try {
        const { catalog, catalogError } = await getDisplayCatalog();
        const profile = store.createCustomProfile(payload);
        return {
          success: true,
          catalogError,
          profile,
          profiles: store.listProfiles(catalog),
        };
      } catch (error) {
        return asErrorResult(error);
      }
    },
  );
  ipcMain.handle("profiles:update", async (_event, { id, payload }) => {
    try {
      const { catalog, catalogError } = await getDisplayCatalog();
      const profile = store.updateCustomProfile(catalog, id, payload);
      return {
        success: true,
        catalogError,
        profile,
        profiles: store.listProfiles(catalog),
      };
    } catch (error) {
      return asErrorResult(error);
    }
  });
  ipcMain.handle("profiles:delete", async (_event, { id }) => {
    try {
      const { catalog, catalogError } = await getDisplayCatalog();
      store.deleteProfile(catalog, id);
      return {
        success: true,
        catalogError,
        profiles: store.listProfiles(catalog),
        active: store.readActive(),
      };
    } catch (error) {
      return asErrorResult(error);
    }
  });
  ipcMain.handle(
    "profiles:apply",
    async (_event, payload: { id: string; apiKey?: string }) => {
      try {
        const { catalog, catalogError } = await getDisplayCatalog();
        const result = await applyProfile({
          codexDir,
          catalog,
          profileId: payload.id,
          store,
          apiKey: payload.apiKey,
          runtime: {
            stop: stopChatGPTRuntime,
            start: startChatGPTRuntime,
          },
          onProgress: sendSyncProgress,
        });
        return {
          ...result,
          catalogError,
          profiles: store.listProfiles(catalog),
        };
      } catch (error) {
        return asErrorResult(error);
      }
    },
  );
  ipcMain.handle("runtime:restart-chatgpt", () => restartChatGPT());
  ipcMain.handle("runtime:open-external", (_event, url: string) =>
    openExternal(url),
  );
  ipcMain.handle("runtime:open-codex-dir", () => shell.openPath(codexDir));
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:close", () => mainWindow?.close());
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
