import { promises as fs } from "node:fs";
import { VAULT_FILE, POLY_DIR } from "./paths.js";
import type { VaultData, AccountMeta, CredentialsFile } from "../types.js";
import * as crypto from "./crypto.js";

const EMPTY: VaultData = { version: 1, accounts: {} };

export async function load(): Promise<VaultData> {
  try {
    const raw = await fs.readFile(VAULT_FILE, "utf8");
    return JSON.parse(raw) as VaultData;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY, accounts: {} };
    throw e;
  }
}

export async function save(data: VaultData): Promise<void> {
  await fs.mkdir(POLY_DIR, { recursive: true });
  const tmp = `${VAULT_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, VAULT_FILE);
}

/** Add or update an account entry from a credentials blob + metadata. */
export async function upsert(
  label: string,
  creds: CredentialsFile,
  meta: Partial<AccountMeta>
): Promise<void> {
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
}

/** Patch an account's metadata without touching its encrypted secret. */
export async function updateMeta(label: string, patch: Partial<AccountMeta>): Promise<void> {
  const data = await load();
  const entry = data.accounts[label];
  if (!entry) return;
  entry.meta = { ...entry.meta, ...patch, label, updatedAt: Date.now() };
  await save(data);
}

/** Replace an account's encrypted credentials (e.g. after a token refresh). */
export async function replaceCredentials(label: string, creds: CredentialsFile): Promise<void> {
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
}

/** Rename an account label, preserving its credentials and active state. */
export async function rename(oldLabel: string, newLabel: string): Promise<void> {
  const data = await load();
  if (!data.accounts[oldLabel]) throw new Error(`No account labeled "${oldLabel}".`);
  if (data.accounts[newLabel]) throw new Error(`An account named "${newLabel}" already exists.`);
  const entry = data.accounts[oldLabel];
  entry.meta = { ...entry.meta, label: newLabel };
  data.accounts[newLabel] = entry;
  delete data.accounts[oldLabel];
  if (data.activeLabel === oldLabel) data.activeLabel = newLabel;
  await save(data);
}

export async function getCredentials(label: string): Promise<CredentialsFile> {
  const data = await load();
  const entry = data.accounts[label];
  if (!entry) throw new Error(`No account labeled "${label}".`);
  return JSON.parse(crypto.decrypt(entry.secret)) as CredentialsFile;
}

export async function remove(label: string): Promise<void> {
  const data = await load();
  if (!data.accounts[label]) throw new Error(`No account labeled "${label}".`);
  delete data.accounts[label];
  if (data.activeLabel === label) data.activeLabel = undefined;
  await save(data);
}

export async function setActive(label: string): Promise<void> {
  const data = await load();
  if (!data.accounts[label]) throw new Error(`No account labeled "${label}".`);
  data.activeLabel = label;
  await save(data);
}

export async function list(): Promise<AccountMeta[]> {
  const data = await load();
  return Object.values(data.accounts)
    .map((e) => e.meta)
    .sort((a, b) => a.label.localeCompare(b.label));
}
