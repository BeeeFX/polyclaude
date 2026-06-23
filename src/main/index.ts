import { app, BrowserWindow, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { registerIpc } from "./ipc.js";
import { registerTerminalIpc } from "./terminal.js";

/**
 * Electron main process. It reuses polyclaude's existing Node core directly
 * (vault, switcher, crypto, usage) via the IPC handlers in ipc.ts — no logic is
 * duplicated. The renderer is a Vite React app served from the dev server in
 * development and from dist/renderer in a packaged build.
 */

const dir = path.dirname(fileURLToPath(import.meta.url));
// Set by `npm run gui:dev` so the window loads the Vite dev server (HMR);
// unset for `npm run gui` and packaged builds, which load the built files.
const DEV_URL = process.env.POLY_DEV_SERVER;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1060,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#16131e",
    show: false,
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(dir, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());

  // Open external links in the system browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    void win.loadFile(path.join(dir, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  registerIpc();
  registerTerminalIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
