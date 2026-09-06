import { contextBridge, ipcRenderer } from "electron";
import { CustomProfileInput, SyncProgress } from "../shared/types";

contextBridge.exposeInMainWorld("aiModel", {
  bootstrap: {
    get: () => ipcRenderer.invoke("bootstrap:get"),
  },
  catalog: {
    refresh: () => ipcRenderer.invoke("catalog:refresh"),
  },
  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    saveOfficialKey: (payload: { providerId: string; model: string }) =>
      ipcRenderer.invoke("profiles:save-official-key", payload),
    create: (payload: CustomProfileInput) => ipcRenderer.invoke("profiles:create", payload),
    update: (id: string, payload: CustomProfileInput) => ipcRenderer.invoke("profiles:update", { id, payload }),
    delete: (id: string) => ipcRenderer.invoke("profiles:delete", { id }),
    apply: (id: string, options?: { apiKey?: string }) => ipcRenderer.invoke("profiles:apply", { id, ...options }),
    reset: () => ipcRenderer.invoke("profiles:reset"),
  },
  runtime: {
    restartChatGPT: () => ipcRenderer.invoke("runtime:restart-chatgpt"),
    openExternal: (url: string) => ipcRenderer.invoke("runtime:open-external", url),
    openCodexDir: () => ipcRenderer.invoke("runtime:open-codex-dir"),
  },
  sync: {
    onProgress: (callback: (progress: SyncProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: SyncProgress) => callback(progress);
      ipcRenderer.on("sync:progress", listener);
      return () => ipcRenderer.removeListener("sync:progress", listener);
    },
  },
  window: {
    setTheme: (themeMode: "dark" | "light") =>
      ipcRenderer.invoke("window:set-theme", themeMode),
    minimize: () => ipcRenderer.invoke("window:minimize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
});
