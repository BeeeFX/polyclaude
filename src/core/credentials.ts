import { promises as fs } from "node:fs";
import path from "node:path";
import { ACTIVE_CREDENTIALS } from "./paths.js";
import type { CredentialsFile } from "../types.js";

/** Read the currently active Claude Code credentials, or null if none. */
export async function readActive(): Promise<CredentialsFile | null> {
  try {
    const raw = await fs.readFile(ACTIVE_CREDENTIALS, "utf8");
    return JSON.parse(raw) as CredentialsFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Atomically replace the active credentials (write temp + rename). */
export async function writeActive(data: CredentialsFile): Promise<void> {
  await fs.mkdir(path.dirname(ACTIVE_CREDENTIALS), { recursive: true });
  const tmp = `${ACTIVE_CREDENTIALS}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, ACTIVE_CREDENTIALS);
}
