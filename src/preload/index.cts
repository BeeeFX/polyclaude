import { contextBridge, ipcRenderer } from "electron";

/**
 * Safe, typed surface exposed to the renderer as `window.poly`. The renderer has
 * no Node access (contextIsolation on); everything goes through these channels,
 * which map 1:1 to the handlers in main/ipc.ts.
 *
 * This is a `.cts` file on purpose: Electron loads a plain `.js` preload as
 * CommonJS, but our package is `type: module`, so a compiled `.js` would contain
 * ESM syntax and fail to load (leaving `window.poly` undefined). `.cts` compiles
 * to a real CommonJS `.cjs`, which Electron's preload loader handles reliably.
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
  terminal: {
    available: () => ipcRenderer.invoke("terminal:available"),
    start: (opts: unknown) => ipcRenderer.invoke("terminal:start", opts),
    write: (id: number, data: string) => ipcRenderer.send("terminal:input", { id, data }),
    resize: (id: number, cols: number, rows: number) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
    kill: (id: number) => ipcRenderer.send("terminal:kill", { id }),
    onData: (cb: (p: { id: number; data: string }) => void) => {
      const h = (_e: unknown, p: { id: number; data: string }) => cb(p);
      ipcRenderer.on("terminal:data", h);
      return () => ipcRenderer.removeListener("terminal:data", h);
    },
    onExit: (cb: (p: { id: number; exitCode: number }) => void) => {
      const h = (_e: unknown, p: { id: number; exitCode: number }) => cb(p);
      ipcRenderer.on("terminal:exit", h);
      return () => ipcRenderer.removeListener("terminal:exit", h);
    },
  },
};

contextBridge.exposeInMainWorld("poly", api);
