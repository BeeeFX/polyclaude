import { ipcMain, app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as vault from "../core/vault.js";
import * as liveusage from "../core/liveusage.js";
import * as conversations from "../core/conversations.js";
import * as settings from "../core/settings.js";
import { authStatus } from "../core/claude.js";
import { switchTo } from "../core/switcher.js";

/**
 * The bridge between the desktop UI and polyclaude's existing core. Every handler
 * is a thin wrapper over a core function — the same logic the CLI and TUI use.
 * Mutations return { ok, error? } so the renderer can surface failures cleanly.
 */
type Result = { ok: true } | { ok: false; error: string };
const ok = (): Result => ({ ok: true });
const err = (e: unknown): Result => ({ ok: false, error: (e as Error).message });

export function registerIpc(): void {
  ipcMain.handle("app:info", () => ({ version: app.getVersion(), platform: process.platform }));
  ipcMain.handle("auth:status", () => authStatus());

  ipcMain.handle("accounts:list", () => vault.list());
  ipcMain.handle("accounts:active", async () => (await vault.load()).activeLabel ?? null);
  ipcMain.handle("accounts:switch", async (_e, label: string) => {
    try {
      await switchTo(label, "manual");
      return ok();
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("accounts:rename", async (_e, oldL: string, newL: string) => {
    try {
      await vault.rename(oldL, newL);
      return ok();
    } catch (e) {
      return err(e);
    }
  });
  ipcMain.handle("accounts:remove", async (_e, label: string) => {
    try {
      await vault.remove(label);
      return ok();
    } catch (e) {
      return err(e);
    }
  });
  // After an in-app `claude auth login`, capture the now-active credentials into
  // the vault (de-duped by identity — updates the matching account, no copy).
  ipcMain.handle("accounts:captureActive", async () => {
    try {
      const login = await import("../core/login.js");
      const res = await login.captureActive({ primeUsage: false });
      return { ok: true as const, ...res };
    } catch (e) {
      return err(e);
    }
  });

  ipcMain.handle("usage:active", () => liveusage.fetchActive());
  ipcMain.handle("usage:all", () => liveusage.fetchAll());

  ipcMain.handle("settings:get", () => settings.load());
  ipcMain.handle("settings:update", (_e, patch: Partial<settings.Settings>) => settings.update(patch));

  ipcMain.handle("conversations:list", (_e, limit?: number) => conversations.list(limit ?? 20));

  // Best-effort: open Claude Code in the user's terminal (the GUI can't host an
  // interactive TTY yet — that's the planned embedded-terminal phase).
  ipcMain.handle("claude:launch", (_e, cwd?: string) => {
    try {
      launchClaudeInTerminal(cwd);
      return ok();
    } catch (e) {
      return err(e);
    }
  });

  // Let the renderer drag-resize-less window controls if we go frameless later.
  ipcMain.handle("window:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());

  // Save a pasted image to a temp PNG and return its path, so the renderer can
  // type that path into the embedded terminal and Claude Code loads the image.
  ipcMain.handle("clipboard:saveImage", async (_e, bytes: Uint8Array) => {
    try {
      const buf = Buffer.from(bytes);
      if (!buf.length) return null;
      const file = path.join(os.tmpdir(), `polyclaude-paste-${Date.now()}.png`);
      await fsp.writeFile(file, buf);
      return file;
    } catch {
      return null;
    }
  });
}

function launchClaudeInTerminal(cwd?: string): void {
  const dir = cwd || process.cwd();
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", "cmd", "/k", "claude -c"], { cwd: dir, detached: true, shell: false });
  } else if (process.platform === "darwin") {
    spawn("open", ["-a", "Terminal", dir], { detached: true });
  } else {
    spawn("x-terminal-emulator", ["-e", "claude -c"], { cwd: dir, detached: true });
  }
}
