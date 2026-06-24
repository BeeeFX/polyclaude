import { ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron";
import type { IPty } from "node-pty";
import { resolveClaudeBin } from "../core/claude.js";
import * as settings from "../core/settings.js";
import { setActiveSessionBusy } from "../core/liveusage.js";

/**
 * Runs Claude Code inside the desktop app via a real pseudo-terminal (node-pty),
 * so the full interactive TUI — including image paste — works just like a normal
 * terminal. node-pty ships N-API prebuilds, so this needs no native compile.
 *
 * The pty is owned by the main process; bytes stream to the renderer's xterm.js
 * over IPC and keystrokes stream back. Account switching still can't hot-swap a
 * live session's token, so the UI offers a one-click restart (`claude -c`).
 */

interface StartOpts {
  cols?: number;
  rows?: number;
  cwd?: string;
  /** Resume the most recent conversation (`claude -c`). */
  resume?: boolean;
  /** Resume a specific session id (`claude --resume <id>`). */
  resumeId?: string;
}
type StartResult = { ok: true; id: number } | { ok: false; error: string };

// Lazily load the native module so a missing/incompatible binary degrades to a
// clear message instead of crashing the app at startup.
let ptyMod: typeof import("node-pty") | null = null;
let loadError: string | null = null;
async function getPty(): Promise<typeof import("node-pty") | null> {
  if (ptyMod || loadError) return ptyMod;
  try {
    ptyMod = await import("node-pty");
  } catch (e) {
    loadError = (e as Error).message;
  }
  return ptyMod;
}

const sessions = new Map<number, { pty: IPty; wc: WebContents }>();
let nextId = 1;

/** Tell liveusage whether a Claude session is live on the active account, so it
 *  won't refresh that account's token out from under the running process. */
function syncBusy(): void {
  setActiveSessionBusy(sessions.size > 0);
}

async function buildArgs(opts: StartOpts): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const s = await settings.load();
  const args: string[] = [];
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  else if (opts.resume) args.push("-c");
  if (s.model) args.push("--model", s.model);
  if (s.effort) args.push("--effort", s.effort);
  const env: NodeJS.ProcessEnv = { ...process.env, POLYCLAUDE_HOST: "1" };
  if (s.thinking) env.MAX_THINKING_TOKENS = String(s.thinkingBudget);
  return { args, env };
}

async function start(event: IpcMainInvokeEvent, opts: StartOpts): Promise<StartResult> {
  const mod = await getPty();
  if (!mod) return { ok: false, error: `embedded terminal unavailable (${loadError ?? "node-pty failed to load"})` };

  const wc = event.sender;
  const { args, env } = await buildArgs(opts);
  let term: IPty;
  try {
    term = mod.spawn(resolveClaudeBin(), args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd || process.cwd(),
      env,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  const id = nextId++;
  sessions.set(id, { pty: term, wc });
  syncBusy();

  term.onData((data) => {
    if (!wc.isDestroyed()) wc.send("terminal:data", { id, data });
  });
  term.onExit(({ exitCode }) => {
    sessions.delete(id);
    syncBusy();
    if (!wc.isDestroyed()) wc.send("terminal:exit", { id, exitCode });
  });

  // Clean up if the window goes away mid-session.
  wc.once("destroyed", () => kill(id));
  return { ok: true, id };
}

function kill(id: number): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  syncBusy();
  try {
    s.pty.kill();
  } catch {
    /* already gone */
  }
}

export function registerTerminalIpc(): void {
  ipcMain.handle("terminal:available", async () => (await getPty()) != null);
  ipcMain.handle("terminal:start", (e, opts: StartOpts) => start(e, opts));
  ipcMain.on("terminal:input", (_e, { id, data }: { id: number; data: string }) => {
    try {
      sessions.get(id)?.pty.write(data);
    } catch {
      /* session ended */
    }
  });
  ipcMain.on("terminal:resize", (_e, { id, cols, rows }: { id: number; cols: number; rows: number }) => {
    try {
      sessions.get(id)?.pty.resize(Math.max(1, cols), Math.max(1, rows));
    } catch {
      /* session ended */
    }
  });
  ipcMain.on("terminal:kill", (_e, { id }: { id: number }) => kill(id));
}
