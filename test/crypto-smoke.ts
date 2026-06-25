import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Round-trips the at-rest crypto on the CURRENT platform — so each OS exercises
 * its own backend (DPAPI on Windows, AES-256-GCM + keystore on macOS/Linux).
 * Uses a temp POLYCLAUDE_DIR so a Linux key-file (if created) is throwaway.
 * Run with: npm run test:crypto
 */
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pcc-crypto-"));
  process.env.POLYCLAUDE_DIR = path.join(tmp, "poly");

  const crypto = await import("../src/core/crypto.js");
  const checks: Array<[string, boolean]> = [];

  checks.push([`supported on ${process.platform}`, crypto.isSupported() === true]);

  const samples = ["hello", JSON.stringify({ claudeAiOauth: { refreshToken: "sk-ant-ort01-xyz", n: 42 } }), "🔐 unicode ✓"];
  for (const s of samples) {
    let roundTrips = false;
    try {
      roundTrips = crypto.decrypt(crypto.encrypt(s)) === s;
    } catch (e) {
      console.log(`  (encrypt/decrypt threw: ${(e as Error).message})`);
    }
    checks.push([`round-trips ${JSON.stringify(s.slice(0, 24))}`, roundTrips]);
  }

  // A tampered AES ciphertext must fail authentication (GCM), not silently decrypt.
  if (process.platform !== "win32") {
    const ct = crypto.encrypt("secret");
    const tampered = ct.slice(0, -2) + (ct.endsWith("A") ? "B" : "A");
    let rejected = false;
    try {
      crypto.decrypt(tampered);
    } catch {
      rejected = true;
    }
    checks.push(["tampered ciphertext is rejected", rejected]);
  }

  await fs.rm(tmp, { recursive: true, force: true });

  let okAll = true;
  for (const [name, ok] of checks) {
    okAll = okAll && ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(okAll ? "\ncrypto: OK" : "\ncrypto: FAILED");
  process.exit(okAll ? 0 : 1);
}

void main();
