import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Regression test for the vault corruption bug: many parallel read-modify-write
 * mutations in one process used to interleave (colliding temp files) and corrupt
 * vault.json. The mutex in vault.ts must keep it consistent. Also checks the
 * self-healing load(). Run with: npm run test:vault
 */
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pcc-vault-"));
  const dir = path.join(tmp, "poly");
  process.env.POLYCLAUDE_DIR = dir;
  await fs.mkdir(dir, { recursive: true });
  const vaultFile = path.join(dir, "vault.json");

  const seed = {
    version: 1,
    accounts: {
      a: { meta: { label: "a", addedAt: 1, updatedAt: 1 }, secret: "x" },
      b: { meta: { label: "b", addedAt: 1, updatedAt: 1 }, secret: "y" },
      c: { meta: { label: "c", addedAt: 1, updatedAt: 1 }, secret: "z" },
    },
    activeLabel: "a",
  };
  await fs.writeFile(vaultFile, JSON.stringify(seed, null, 2));

  const vault = await import("../src/core/vault.js");
  const labels = ["a", "b", "c"];

  // Hammer the vault with parallel mutations (this corrupted it pre-mutex).
  const ops: Array<Promise<unknown>> = [];
  for (let i = 0; i < 60; i++) {
    const l = labels[i % 3];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ops.push(vault.updateMeta(l, { usage: { fiveHourPct: i, fetchedAt: Date.now() } } as any));
  }
  await Promise.all(ops);

  const checks: Array<[string, boolean]> = [];

  let parses = false;
  let accountsOk = false;
  try {
    const o = JSON.parse(await fs.readFile(vaultFile, "utf8"));
    parses = true;
    accountsOk = Object.keys(o.accounts).sort().join(",") === "a,b,c";
  } catch {
    /* parses stays false */
  }
  checks.push(["vault still valid JSON after 60 parallel writes", parses]);
  checks.push(["all accounts preserved", accountsOk]);

  const left = await fs.readdir(dir);
  checks.push(["no leftover .tmp- files", !left.some((f) => f.includes(".tmp-"))]);

  // load() should self-heal trailing corruption rather than throw.
  await fs.writeFile(vaultFile, JSON.stringify(seed, null, 2) + "TRAILING-GARBAGE");
  let healed = false;
  try {
    healed = Object.keys((await vault.load()).accounts).length === 3;
  } catch {
    /* healed stays false */
  }
  checks.push(["load() self-heals trailing corruption", healed]);

  await fs.rm(tmp, { recursive: true, force: true });

  let okAll = true;
  for (const [name, ok] of checks) {
    okAll = okAll && ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(okAll ? "\nvault: OK" : "\nvault: FAILED");
  process.exit(okAll ? 0 : 1);
}

void main();
