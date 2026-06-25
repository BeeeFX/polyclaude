import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { ACTIVE_CREDENTIALS } from "./paths.js";
import type { CredentialsFile } from "../types.js";

/**
 * Read/write the *active* Claude Code credentials — the ones Claude reads at
 * startup. Where those live depends on the OS, matching Claude Code itself:
 *
 *   Windows / Linux → the ~/.claude/.credentials.json file.
 *   macOS           → the login Keychain (service "Claude Code-credentials").
 *                     Claude also reads .credentials.json if it exists, so we
 *                     write BOTH and read the file first: the file avoids a
 *                     Keychain permission prompt, and updating the Keychain too
 *                     means a switch sticks even if Claude recreates the item.
 */

const isMac = process.platform === "darwin";
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

/** Read the currently active Claude Code credentials, or null if none. */
export async function readActive(): Promise<CredentialsFile | null> {
  const fromFile = await readFile();
  if (fromFile || !isMac) return fromFile;
  return readKeychain(); // macOS, no file yet → fall back to the Keychain
}

/** Replace the active credentials. */
export async function writeActive(data: CredentialsFile): Promise<void> {
  await writeFile(data);
  if (isMac) writeKeychain(JSON.stringify(data)); // best-effort; file is primary
}

// ---- ~/.claude/.credentials.json (all platforms) -------------------------
async function readFile(): Promise<CredentialsFile | null> {
  try {
    return JSON.parse(await fs.readFile(ACTIVE_CREDENTIALS, "utf8")) as CredentialsFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Atomically replace the active credentials file (write temp + rename). */
async function writeFile(data: CredentialsFile): Promise<void> {
  await fs.mkdir(path.dirname(ACTIVE_CREDENTIALS), { recursive: true });
  const tmp = `${ACTIVE_CREDENTIALS}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, ACTIVE_CREDENTIALS);
}

// ---- macOS Keychain via the `security` CLI -------------------------------
function readKeychain(): CredentialsFile | null {
  const res = spawnSync("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE, "-w"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout.trim()) as CredentialsFile;
  } catch {
    return null;
  }
}

/** Update (or create) the Keychain item Claude reads. Best-effort: the file is
 *  authoritative, so a Keychain failure only warns. NOTE: `security` takes the
 *  secret on argv, briefly visible to a same-user `ps` — acceptable locally. */
function writeKeychain(json: string): void {
  const acct = keychainAccount() ?? os.userInfo().username;
  const res = spawnSync(
    "security",
    ["add-generic-password", "-U", "-a", acct, "-s", CLAUDE_KEYCHAIN_SERVICE, "-w", json],
    { encoding: "utf8", maxBuffer: 1024 * 1024 }
  );
  if (res.status !== 0) {
    process.stderr.write(
      `polyclaude: couldn't update the macOS Keychain (${(res.stderr || "unknown").trim()}); ` +
        "the .credentials.json file was written, which Claude reads as a fallback.\n"
    );
  }
}

/** The `acct` attribute on the existing Keychain item, so an update preserves it. */
function keychainAccount(): string | undefined {
  const res = spawnSync("security", ["find-generic-password", "-s", CLAUDE_KEYCHAIN_SERVICE], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  return out.match(/"acct"<blob>="([^"]*)"/)?.[1] || undefined;
}
