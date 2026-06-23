import { contextBridge, ipcRenderer } from "electron";

/**
 * Safe, typed surface exposed to the renderer as `window.poly`. The renderer has
 * no Node access (contextIsolation on); everything goes through these channels,
 * which map 1:1 to the handlers in main/ipc.ts.
 */
const api = {
  app: { info: () => ipcRenderer.invoke("app:info") },
  auth: { status: () => ipcRenderer.invoke("auth:status") },
  accounts: {
    list: () => ipcRenderer.invoke("accounts:list"),
    active: () => ipcRenderer.invoke("accounts:active"),
    switch: (label: string) => ipcRenderer.invoke("accounts:switch", label),
    rename: (oldLabel: string, newLabel: string) => ipcRenderer.invoke("accounts:rename", oldLabel, newLabel),
    remove: (label: string) => ipcRenderer.invoke("accounts:remove", label),
  },
  usage: {
    active: () => ipcRenderer.invoke("usage:active"),
    all: () => ipcRenderer.invoke("usage:all"),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (patch: unknown) => ipcRenderer.invoke("settings:update", patch),
  },
  conversations: { list: (limit?: number) => ipcRenderer.invoke("conversations:list", limit) },
  claude: { launch: (cwd?: string) => ipcRenderer.invoke("claude:launch", cwd) },
};

contextBridge.exposeInMainWorld("poly", api);
