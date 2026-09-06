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
import { resetCodexConfiguration } from "./resetConfig";
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
const WINDOW_TITLEBAR_HEIGHT = 52;

let mainWindow: BrowserWindow | null = null;
let catalogCache: ProviderCatalog | null = null;

type WindowThemeMode = "dark" | "light";

function isWindowThemeMode(value: unknown): value is WindowThemeMode {
  return value === "dark" || value === "light";
}

function nativeWindowThemeColors(themeMode?: WindowThemeMode) {
  const useDarkColors =
    themeMode === "dark" || (!themeMode && nativeTheme.shouldUseDarkColors);
  return useDarkColors
    ? { backgroundColor: "#000000", symbolColor: "#d1d5db" }
    : { backgroundColor: "#ffffff", symbolColor: "#64748b" };
}

function applyWindowTheme(themeMode: WindowThemeMode) {
  nativeTheme.themeSource = themeMode;
  const windowThemeColors = nativeWindowThemeColors(themeMode);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(windowThemeColors.backgroundColor);
  if (process.platform === "win32") {
    mainWindow.setTitleBarOverlay({
      color: windowThemeColors.backgroundColor,
      symbolColor: windowThemeColors.symbolColor,
      height: WINDOW_TITLEBAR_HEIGHT,
    });
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
  mainWindow.show();
}

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
  nativeTheme.themeSource = "dark";
  const windowThemeColors = nativeWindowThemeColors("dark");

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
            color: windowThemeColors.backgroundColor,
            symbolColor: windowThemeColors.symbolColor,
            height: WINDOW_TITLEBAR_HEIGHT,
          }
        : false,
    autoHideMenuBar: true,
    backgroundColor: windowThemeColors.backgroundColor,
    show: false,
    paintWhenInitiallyHidden: true,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.once("did-finish-load", showMainWindow);
  mainWindow.once("ready-to-show", showMainWindow);

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
  ipcMain.handle("profiles:reset", async () => {
    try {
      const { catalog, catalogError } = await getDisplayCatalog();
      const result = await resetCodexConfiguration({
        codexDir,
        store,
        runtime: {
          stop: stopChatGPTRuntime,
          start: startChatGPTRuntime,
        },
      });
      return {
        ...result,
        catalogError,
        profiles: store.listProfiles(catalog),
        active: store.readActive(),
      };
    } catch (error) {
      return asErrorResult(error);
    }
  });
  ipcMain.handle("runtime:restart-chatgpt", () => restartChatGPT());
  ipcMain.handle("runtime:open-external", (_event, url: string) =>
    openExternal(url),
  );
  ipcMain.handle("runtime:open-codex-dir", () => shell.openPath(codexDir));
  ipcMain.handle("window:set-theme", (_event, themeMode: unknown) => {
    if (!isWindowThemeMode(themeMode)) return;
    applyWindowTheme(themeMode);
  });
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
