import { app } from "electron";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";

/**
 * Installs the `pcc` / `polyclaude` command-line tools alongside the desktop
 * app — the VS Code "Install 'code' command" model. The shim re-runs THIS app's
 * bundled binary in Node mode (ELECTRON_RUN_AS_NODE) against the packaged CLI
 * entry, so there's no separate Node install or npm step.
 *
 * Used from two places:
 *   - the Windows installer (NSIS asks, then runs `polyclaude.exe --install-cli`)
 *   - an in-app button (covers macOS, whose .dmg can't prompt at install time)
 */

const HOME = os.homedir();
const NAMES = ["pcc", "polyclaude"] as const;
/** Where Windows shims live (added to the user PATH). Aligns with ~/.polyclaude. */
const WIN_BIN_DIR = path.join(HOME, ".polyclaude", "bin");
/** Candidate PATH dirs on macOS/Linux, best first (all normally on PATH except the last). */
const UNIX_DIRS = ["/usr/local/bin", "/opt/homebrew/bin", path.join(HOME, ".local", "bin")];

export interface CliStatus {
  installed: boolean;
  /** The directory the shims were written to (so the UI can show where). */
  location?: string;
  /** False only when we had to fall back to a dir that isn't on PATH. */
  onPath: boolean;
  /** A short hint when onPath is false (e.g. add ~/.local/bin to PATH). */
  hint?: string;
}

/** Absolute path to the packaged CLI entry (works packaged and in `electron .`). */
function cliEntry(): string {
  return path.join(app.getAppPath(), "dist", "cli", "index.js");
}

function winShim(): string {
  // %* forwards all args; quoting handles spaces in the install path.
  return `@echo off\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${process.execPath}" "${cliEntry()}" %*\r\n`;
}

function unixShim(): string {
  return `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${cliEntry()}" "$@"\n`;
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map((d) => path.resolve(d));
}

async function writable(dir: string): Promise<boolean> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, (await import("node:fs")).constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// ---- Windows ---------------------------------------------------------------

async function runPowerShell(script: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { env: { ...process.env, POLY_BIN: WIN_BIN_DIR }, windowsHide: true },
      (e) => (e ? reject(e) : resolve())
    );
  });
}

/** Add WIN_BIN_DIR to the user PATH (idempotent). New shells pick it up. */
function addToUserPath(): Promise<void> {
  return runPowerShell(
    "$d=$env:POLY_BIN;" +
      "$p=[Environment]::GetEnvironmentVariable('Path','User');" +
      "if(-not $p){$p=''};" +
      "$parts=@($p.Split(';') | Where-Object {$_ -ne ''});" +
      "if($parts -notcontains $d){[Environment]::SetEnvironmentVariable('Path',($parts + $d -join ';'),'User')}"
  );
}

function removeFromUserPath(): Promise<void> {
  return runPowerShell(
    "$d=$env:POLY_BIN;" +
      "$p=[Environment]::GetEnvironmentVariable('Path','User');" +
      "if($p){$parts=@($p.Split(';') | Where-Object {$_ -ne '' -and $_ -ne $d});" +
      "[Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User')}"
  );
}

async function installWindows(): Promise<CliStatus> {
  await fs.mkdir(WIN_BIN_DIR, { recursive: true });
  for (const name of NAMES) await fs.writeFile(path.join(WIN_BIN_DIR, `${name}.cmd`), winShim());
  await addToUserPath();
  return { installed: true, location: WIN_BIN_DIR, onPath: true };
}

async function uninstallWindows(): Promise<void> {
  for (const name of NAMES) await fs.rm(path.join(WIN_BIN_DIR, `${name}.cmd`), { force: true });
  await removeFromUserPath().catch(() => {});
}

// ---- macOS / Linux ---------------------------------------------------------

async function installUnix(): Promise<CliStatus> {
  let target: string | undefined;
  for (const dir of UNIX_DIRS) {
    if (await writable(dir)) {
      target = dir;
      break;
    }
  }
  if (!target) throw new Error("No writable directory found on PATH (tried /usr/local/bin, /opt/homebrew/bin, ~/.local/bin).");

  const shim = unixShim();
  for (const name of NAMES) {
    const p = path.join(target, name);
    await fs.rm(p, { force: true });
    await fs.writeFile(p, shim, { mode: 0o755 });
    await fs.chmod(p, 0o755);
  }

  const onPath = pathDirs().includes(path.resolve(target));
  return {
    installed: true,
    location: target,
    onPath,
    hint: onPath ? undefined : `Add ${target} to your PATH (e.g. add 'export PATH="${target}:$PATH"' to your shell profile).`,
  };
}

async function uninstallUnix(): Promise<void> {
  for (const dir of UNIX_DIRS) {
    for (const name of NAMES) await fs.rm(path.join(dir, name), { force: true });
  }
}

// ---- Public API ------------------------------------------------------------

export async function status(): Promise<CliStatus> {
  if (process.platform === "win32") {
    const exists = await fs
      .stat(path.join(WIN_BIN_DIR, "pcc.cmd"))
      .then(() => true)
      .catch(() => false);
    if (!exists) return { installed: false, onPath: false };
    const onPath = pathDirs().includes(path.resolve(WIN_BIN_DIR));
    return { installed: true, location: WIN_BIN_DIR, onPath };
  }
  for (const dir of UNIX_DIRS) {
    const p = path.join(dir, "pcc");
    if (await fs.stat(p).then(() => true).catch(() => false)) {
      return { installed: true, location: dir, onPath: pathDirs().includes(path.resolve(dir)) };
    }
  }
  return { installed: false, onPath: false };
}

export async function install(): Promise<CliStatus> {
  return process.platform === "win32" ? installWindows() : installUnix();
}

export async function uninstall(): Promise<void> {
  return process.platform === "win32" ? uninstallWindows() : uninstallUnix();
}

/**
 * Entry for the installer flag: `polyclaude --install-cli` / `--uninstall-cli`.
 * Runs the action and reports ok so the caller (NSIS) can react.
 */
export async function runCliAction(action: "install" | "uninstall"): Promise<{ ok: boolean; error?: string }> {
  try {
    if (action === "install") await install();
    else await uninstall();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
