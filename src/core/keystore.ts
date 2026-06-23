import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { POLY_DIR } from "./paths.js";

/**
 * The AES master key used to encrypt the vault on macOS and Linux (Windows uses
 * DPAPI directly and never calls this). The key is created once and persisted:
 *
 *   macOS  → the login Keychain (its own item, separate from Claude's), so the
 *            key is protected at rest by the OS, like Claude Code's own creds.
 *   Linux  → a 0600 key-file in ~/.polyclaude (matches Claude Code's own
 *            plaintext-0600 credential posture on Linux).
 *
 * Returns 32 raw bytes. Synchronous to match crypto.ts (which is spawnSync-based).
 */

const KEY_BYTES = 32;
const KEYCHAIN_SERVICE = "polyclaude-vault-key";
const KEY_FILE = path.join(POLY_DIR, "vault.key");

let cached: Buffer | undefined;

export function getMasterKey(): Buffer {
  if (cached) return cached;
  cached = process.platform === "darwin" ? macKey() : fileKey();
  return cached;
}

// ---- macOS: login Keychain via the `security` CLI ------------------------
function macKey(): Buffer {
  const existing = run("security", [
    "find-generic-password",
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (existing.status === 0) {
    const key = Buffer.from(existing.stdout.trim(), "base64");
    if (key.length === KEY_BYTES) return key;
  }
  // Not found (or malformed) → create and store a fresh key.
  const key = randomBytes(KEY_BYTES);
  const res = run("security", [
    "add-generic-password",
    "-U",
    "-a",
    os.userInfo().username,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
    key.toString("base64"),
  ]);
  if (res.status !== 0) {
    throw new Error(
      `Couldn't store the vault key in the macOS Keychain: ${(res.stderr || "unknown error").trim()}`
    );
  }
  return key;
}

// ---- Linux (and any non-darwin fallback): 0600 key-file ------------------
function fileKey(): Buffer {
  if (existsSync(KEY_FILE)) {
    const key = Buffer.from(readFileSync(KEY_FILE, "utf8").trim(), "base64");
    if (key.length === KEY_BYTES) return key;
  }
  const key = randomBytes(KEY_BYTES);
  mkdirSync(POLY_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key.toString("base64"), { mode: 0o600 });
  // stderr (never stdout — stdout feeds the Claude Code status line).
  process.stderr.write(
    `polyclaude: created an encryption key at ${KEY_FILE} (mode 0600). ` +
      "Keep this file private; it protects your stored accounts.\n"
  );
  return key;
}

function run(cmd: string, args: string[]) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1024 * 1024 });
}
