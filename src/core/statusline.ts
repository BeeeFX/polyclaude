import { promises as fs } from "node:fs";
import path from "node:path";
import { CLAUDE_DIR } from "./paths.js";

/**
 * Install/detect/remove the polyclaude status line in Claude Code's settings
 * (~/.claude/settings.json). Kept presentation-free (returns structured results,
 * never prints) so both the CLI command and the TUI first-run offer can reuse it.
 */

const SETTINGS_FILE = path.join(CLAUDE_DIR, "settings.json");
/** The command we register; detection matches on this substring. */
export const STATUSLINE_COMMAND = "polyclaude statusline";

interface StatusLineEntry {
  type?: string;
  command?: string;
  refreshInterval?: number;
}

/** Read settings.json; {} when absent. Throws only on a real read/parse error. */
async function readSettings(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

async function writeSettings(data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(CLAUDE_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, SETTINGS_FILE);
}

function isOurs(entry: StatusLineEntry | undefined): boolean {
  return typeof entry?.command === "string" && entry.command.includes(STATUSLINE_COMMAND);
}

export interface CurrentStatusLine {
  /** A statusLine entry exists (ours or someone else's). */
  present: boolean;
  /** The existing entry is polyclaude's. */
  ours: boolean;
  command?: string;
}

export async function current(): Promise<CurrentStatusLine> {
  const entry = (await readSettings()).statusLine as StatusLineEntry | undefined;
  return { present: !!entry, ours: isOurs(entry), command: entry?.command };
}

/** True when polyclaude's status line is the configured one. Never throws. */
export async function isInstalled(): Promise<boolean> {
  try {
    return (await current()).ours;
  } catch {
    return false;
  }
}

export interface InstallResult {
  ok: boolean;
  /** Why the install was declined / failed. */
  reason?: "foreign-exists" | "error";
  message?: string;
  /** A non-polyclaude statusLine we refused to overwrite without force. */
  existingCommand?: string;
  /** Install succeeded but `polyclaude` doesn't look resolvable on PATH. */
  pathWarning?: boolean;
  path: string;
}

export async function install(opts: { force?: boolean } = {}): Promise<InstallResult> {
  let settings: Record<string, unknown>;
  try {
    settings = await readSettings();
  } catch (e) {
    return { ok: false, reason: "error", message: (e as Error).message, path: SETTINGS_FILE };
  }

  const existing = settings.statusLine as StatusLineEntry | undefined;
  if (existing && !isOurs(existing) && !opts.force) {
    return { ok: false, reason: "foreign-exists", existingCommand: existing.command, path: SETTINGS_FILE };
  }

  // refreshInterval keeps usage fresh while the session is idle (Claude's own
  // event-driven update only fires on assistant messages).
  settings.statusLine = { type: "command", command: STATUSLINE_COMMAND, refreshInterval: 60 };
  try {
    await writeSettings(settings);
  } catch (e) {
    return { ok: false, reason: "error", message: (e as Error).message, path: SETTINGS_FILE };
  }
  return { ok: true, pathWarning: !(await onPath("polyclaude")), path: SETTINGS_FILE };
}

export interface UninstallResult {
  ok: boolean;
  /** We removed our entry. */
  removed: boolean;
  /** A non-polyclaude statusLine was present; we left it untouched. */
  foreign?: boolean;
  message?: string;
  path: string;
}

export async function uninstall(): Promise<UninstallResult> {
  let settings: Record<string, unknown>;
  try {
    settings = await readSettings();
  } catch (e) {
    return { ok: false, removed: false, message: (e as Error).message, path: SETTINGS_FILE };
  }

  const existing = settings.statusLine as StatusLineEntry | undefined;
  if (!existing) return { ok: true, removed: false, path: SETTINGS_FILE };
  if (!isOurs(existing)) return { ok: true, removed: false, foreign: true, path: SETTINGS_FILE };

  delete settings.statusLine;
  try {
    await writeSettings(settings);
  } catch (e) {
    return { ok: false, removed: false, message: (e as Error).message, path: SETTINGS_FILE };
  }
  return { ok: true, removed: true, path: SETTINGS_FILE };
}

/** Best-effort check that an executable named `bin` is resolvable on PATH. */
async function onPath(bin: string): Promise<boolean> {
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";")]
      : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        await fs.access(path.join(dir, bin + ext));
        return true;
      } catch {
        /* keep looking */
      }
    }
  }
  return false;
}
