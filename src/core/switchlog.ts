import { promises as fs } from "node:fs";
import path from "node:path";
import { POLY_DIR } from "./paths.js";

/** Append-only record of which account was made active and when, so we can
 *  attribute token usage (from Claude Code transcripts) to the right account. */

const FILE = path.join(POLY_DIR, "switches.jsonl");

export interface SwitchEvent {
  ts: number;
  label: string;
  /** "manual" | "auto" | "add" */
  reason?: string;
}

export async function record(label: string, reason = "manual"): Promise<void> {
  await fs.mkdir(POLY_DIR, { recursive: true });
  await fs.appendFile(FILE, JSON.stringify({ ts: Date.now(), label, reason }) + "\n");
}

export async function history(): Promise<SwitchEvent[]> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SwitchEvent)
      .sort((a, b) => a.ts - b.ts);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** The label that was active at time `t`, or undefined if before any record. */
export function labelAt(hist: SwitchEvent[], t: number): string | undefined {
  let cur: string | undefined;
  for (const e of hist) {
    if (e.ts <= t) cur = e.label;
    else break;
  }
  return cur;
}
