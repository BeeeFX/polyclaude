import { spawnSync } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getMasterKey } from "./keystore.js";

/**
 * At-rest encryption for stored credential blobs. The backend is per-platform,
 * mirroring how Claude Code itself protects credentials:
 *
 *   Windows → DPAPI (Data Protection API) scoped to CurrentUser, via .NET's
 *             ProtectedData. Decryptable only by the same Windows user on the
 *             same machine; plaintext is passed to PowerShell over stdin (never
 *             argv) so it can't leak via the process list.
 *   macOS / Linux → AES-256-GCM (node:crypto) with a master key from keystore.ts
 *             (Keychain on macOS, a 0600 key-file on Linux).
 *
 * Ciphertext is scheme-tagged so it's self-describing: "aesgcm:…" for the GCM
 * backend, and untagged for legacy/Windows DPAPI (so existing vaults keep
 * working with no migration).
 */

const AES_PREFIX = "aesgcm:";

const PS_ENCRYPT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($in)
$prot=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')
[Convert]::ToBase64String($prot)
`;

const PS_DECRYPT = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($in)
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,'CurrentUser')
[Convert]::ToBase64String($plain)
`;

function runPowerShell(script: string, input: string): string {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `DPAPI operation failed: ${(res.stderr || res.stdout || "unknown error").trim()}`
    );
  }
  return res.stdout.trim();
}

/** Every supported platform has a backend now (DPAPI or AES+keystore). */
export function isSupported(): boolean {
  return ["win32", "darwin", "linux"].includes(process.platform);
}

export function assertSupported(): void {
  if (!isSupported()) {
    throw new Error(`Credential encryption isn't supported on ${process.platform} yet.`);
  }
}

/** Encrypt UTF-8 plaintext, returning a (scheme-tagged) ciphertext string. */
export function encrypt(plaintext: string): string {
  if (process.platform === "win32") {
    const b64 = Buffer.from(plaintext, "utf8").toString("base64");
    return runPowerShell(PS_ENCRYPT, b64); // legacy DPAPI: untagged
  }
  return aesEncrypt(plaintext);
}

/** Decrypt a ciphertext string back to UTF-8 plaintext, by scheme tag. */
export function decrypt(ciphertext: string): string {
  if (ciphertext.startsWith(AES_PREFIX)) return aesDecrypt(ciphertext);
  // Untagged → DPAPI (Windows / legacy vaults).
  if (process.platform !== "win32") {
    throw new Error("This vault was encrypted with Windows DPAPI and can't be read here.");
  }
  const outB64 = runPowerShell(PS_DECRYPT, ciphertext);
  return Buffer.from(outB64, "base64").toString("utf8");
}

// ---- AES-256-GCM backend (macOS / Linux) ---------------------------------
function aesEncrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getMasterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return AES_PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

function aesDecrypt(ciphertext: string): string {
  const buf = Buffer.from(ciphertext.slice(AES_PREFIX.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", getMasterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
