import { promises as fs } from "node:fs";
import { VAULT_FILE, POLY_DIR } from "./paths.js";
import type { VaultData, AccountMeta, CredentialsFile } from "../types.js";
import * as crypto from "./crypto.js";

const EMPTY: VaultData = { version: 1, accounts: {} };

/**
 * Serialize read-modify-write sequences. Several callers mutate the vault
 * concurrently (e.g. the GUI refreshes every account's usage in parallel), and
 * without this their load→modify→save sequences interleave — which previously
 * corrupted vault.json (two writes racing on one temp file / lost updates).
 */
let writeChain: Promise<unknown> = Promise.resolve();
function mutate<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Best-effort recovery of the first complete JSON object from a file that has
 *  trailing garbage (the old corruption signature). Returns null if unparseable. */
function recoverFirstObject(raw: string): VaultData | null {
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(0, i + 1)) as VaultData;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export async function load(): Promise<VaultData> {
  let raw: string;
  try {
    raw = await fs.readFile(VAULT_FILE, "utf8");
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, accounts: {} };
    throw e;
  }
  try {
    return JSON.parse(raw) as VaultData;
  } catch {
    // Self-heal rather than crash: recover the valid leading object if possible.
    const recovered = recoverFirstObject(raw);
    if (recovered) {
      process.stderr.write("polyclaude: vault.json had trailing corruption; recovered the valid portion.\n");
      return recovered;
    }
    throw new Error("vault.json is corrupted and could not be parsed");
  }
}

let tmpSeq = 0;
export async function save(data: VaultData): Promise<void> {
  await fs.mkdir(POLY_DIR, { recursive: true });
  // Unique temp per write so parallel saves in one process never collide.
  const tmp = `${VAULT_FILE}.tmp-${process.pid}-${Date.now()}-${tmpSeq++}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, VAULT_FILE);
}

/** Add or update an account entry from a credentials blob + metadata. */
export async function upsert(
  label: string,
  creds: CredentialsFile,
  meta: Partial<AccountMeta>
): Promise<void> {
  return mutate(async () => {
    const data = await load();
    const now = Date.now();
    const existing = data.accounts[label];
    const secret = crypto.encrypt(JSON.stringify(creds));
    const merged: AccountMeta = {
      ...(existing?.meta ?? { label, addedAt: now, updatedAt: now }),
      ...meta,
      label,
      addedAt: existing?.meta.addedAt ?? now,
      updatedAt: now,
    };
    data.accounts[label] = { meta: merged, secret };
    if (!data.activeLabel) data.activeLabel = label;
    await save(data);
  });
}

/** Patch an account's metadata without touching its encrypted secret. */
export async function updateMeta(label: string, patch: Partial<AccountMeta>): Promise<void> {
  return mutate(async () => {
    const data = await load();
    const entry = data.accounts[label];
    if (!entry) return;
    entry.meta = { ...entry.meta, ...patch, label, updatedAt: Date.now() };
    await save(data);
  });
}

/** Replace an account's encrypted credentials (e.g. after a token refresh). */
export async function replaceCredentials(label: string, creds: CredentialsFile): Promise<void> {
  return mutate(async () => {
    const data = await load();
    const entry = data.accounts[label];
    if (!entry) throw new Error(`No account labeled "${label}".`);
    entry.secret = crypto.encrypt(JSON.stringify(creds));
    entry.meta = {
      ...entry.meta,
      expiresAt: creds.claudeAiOauth.expiresAt,
      updatedAt: Date.now(),
    };
    await save(data);
  });
}

/** Rename an account label, preserving its credentials and active state. */
export async function rename(oldLabel: string, newLabel: string): Promise<void> {
  return mutate(async () => {
    const data = await load();
    if (!data.accounts[oldLabel]) throw new Error(`No account labeled "${oldLabel}".`);
    if (data.accounts[newLabel]) throw new Error(`An account named "${newLabel}" already exists.`);
    const entry = data.accounts[oldLabel];
    entry.meta = { ...entry.meta, label: newLabel };
    data.accounts[newLabel] = entry;
    delete data.accounts[oldLabel];
    if (data.activeLabel === oldLabel) data.activeLabel = newLabel;
    await save(data);
  });
}

export async function getCredentials(label: string): Promise<CredentialsFile> {
  const data = await load();
  const entry = data.accounts[label];
  if (!entry) throw new Error(`No account labeled "${label}".`);
  return JSON.parse(crypto.decrypt(entry.secret)) as CredentialsFile;
}

export async function remove(label: string): Promise<void> {
  return mutate(async () => {
    const data = await load();
    if (!data.accounts[label]) throw new Error(`No account labeled "${label}".`);
    delete data.accounts[label];
    if (data.activeLabel === label) data.activeLabel = undefined;
    await save(data);
  });
}

export async function setActive(label: string): Promise<void> {
  return mutate(async () => {
    const data = await load();
    if (!data.accounts[label]) throw new Error(`No account labeled "${label}".`);
    data.activeLabel = label;
    await save(data);
  });
}

export async function list(): Promise<AccountMeta[]> {
  const data = await load();
  return Object.values(data.accounts)
    .map((e) => e.meta)
    .sort((a, b) => a.label.localeCompare(b.label));
}
