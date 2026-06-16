import { promises as fs } from "node:fs";
import path from "node:path";
import { CLAUDE_DIR } from "./paths.js";
import * as switchlog from "./switchlog.js";

/**
 * Usage is read from Claude Code's own session transcripts
 * (~/.claude/projects/<project>/<sessionId>.jsonl). Each assistant message
 * carries a `usage` object with real token counts + a timestamp, so we can
 * sum them over rolling windows entirely locally — no network, no guessing.
 *
 * Note: transcripts don't record which account produced them, so we attribute
 * each record to whichever account polyclaude had active at that time (switch
 * log). The plan's true server-side cap isn't exposed locally; these are the
 * tokens *observed through this tool*. Auto-switch keys off real limit errors.
 */

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");

export interface UsageRecord {
  ts: number;
  model: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
}

export interface WindowSummary {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** input + output + cacheCreate + cacheRead */
  total: number;
  /** message count */
  count: number;
}

async function* walkJsonl(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

/** Collect every usage record at or after `sinceMs`. */
export async function collect(sinceMs: number): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const file of walkJsonl(PROJECTS_DIR)) {
    // Records are appended, so a file last modified before the window opened
    // cannot contain anything inside it — skip for speed.
    try {
      const st = await fs.stat(file);
      if (st.mtimeMs < sinceMs) continue;
    } catch {
      continue;
    }
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.includes('"usage"')) continue;
      let d: { message?: { model?: string; usage?: Record<string, number> }; timestamp?: string };
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      const u = d.message?.usage;
      if (!u) continue;
      const ts = Date.parse(d.timestamp ?? "");
      if (!ts || ts < sinceMs) continue;
      out.push({
        ts,
        model: d.message?.model ?? "?",
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheCreate: u.cache_creation_input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function summarize(records: UsageRecord[]): WindowSummary {
  const s: WindowSummary = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, count: 0 };
  for (const r of records) {
    s.input += r.input;
    s.output += r.output;
    s.cacheCreate += r.cacheCreate;
    s.cacheRead += r.cacheRead;
    s.count++;
  }
  s.total = s.input + s.output + s.cacheCreate + s.cacheRead;
  return s;
}

/** Attribute records to accounts using the switch log. */
export async function byAccount(records: UsageRecord[]): Promise<Record<string, WindowSummary>> {
  const hist = await switchlog.history();
  const buckets: Record<string, UsageRecord[]> = {};
  for (const r of records) {
    const label = switchlog.labelAt(hist, r.ts) ?? "(unattributed)";
    (buckets[label] ??= []).push(r);
  }
  const res: Record<string, WindowSummary> = {};
  for (const k of Object.keys(buckets)) res[k] = summarize(buckets[k]);
  return res;
}

export interface UsageWindows {
  fiveHour: WindowSummary;
  sevenDay: WindowSummary;
  fiveHourByAccount: Record<string, WindowSummary>;
  sevenDayByAccount: Record<string, WindowSummary>;
  /** epoch ms when the oldest record in the 5h window ages out (rolling reset). */
  fiveHourResetAt?: number;
}

/** One call that powers the dashboard: both windows, global + per account. */
export async function snapshot(now = Date.now()): Promise<UsageWindows> {
  const sevenDayRecords = await collect(now - SEVEN_DAYS_MS);
  const fiveHourRecords = sevenDayRecords.filter((r) => r.ts >= now - FIVE_HOURS_MS);
  const oldest5h = fiveHourRecords[0]?.ts;
  return {
    fiveHour: summarize(fiveHourRecords),
    sevenDay: summarize(sevenDayRecords),
    fiveHourByAccount: await byAccount(fiveHourRecords),
    sevenDayByAccount: await byAccount(sevenDayRecords),
    fiveHourResetAt: oldest5h ? oldest5h + FIVE_HOURS_MS : undefined,
  };
}
