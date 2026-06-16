import { spawnSync } from "node:child_process";

/**
 * At-rest encryption for stored credential blobs.
 *
 * On Windows we use DPAPI (Data Protection API) scoped to the CurrentUser, via
 * .NET's ProtectedData. The ciphertext can only be decrypted by the same
 * Windows user on the same machine — no master password to manage, and tokens
 * are never written to disk in plaintext. Plaintext is passed to PowerShell
 * over stdin (never argv) so it can't leak via the process list.
 *
 * Non-Windows platforms are not yet supported for encryption (see README).
 */

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

export function isSupported(): boolean {
  return process.platform === "win32";
}

export function assertSupported(): void {
  if (!isSupported()) {
    throw new Error(
      "Credential encryption currently requires Windows (DPAPI). " +
        "Cross-platform key storage is on the roadmap."
    );
  }
}

/** Encrypt UTF-8 plaintext, returning a base64 ciphertext string. */
export function encrypt(plaintext: string): string {
  assertSupported();
  const b64 = Buffer.from(plaintext, "utf8").toString("base64");
  return runPowerShell(PS_ENCRYPT, b64);
}

/** Decrypt a base64 ciphertext string back to UTF-8 plaintext. */
export function decrypt(ciphertextB64: string): string {
  assertSupported();
  const outB64 = runPowerShell(PS_DECRYPT, ciphertextB64);
  return Buffer.from(outB64, "base64").toString("utf8");
}
