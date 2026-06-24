import { promises as fs } from "node:fs";
import path from "node:path";
import { POLY_DIR } from "./paths.js";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** Haiku doesn't support the reasoning-effort parameter; Opus/Sonnet (and the
 *  Claude-default model) do — including "xhigh" (Claude Code's "Ultracode") and
 *  "max". Used to avoid passing an unsupported --effort flag. */
export function supportsEffort(model: string | undefined): boolean {
  return model !== "haiku";
}

export interface Settings {
  /** What polyclaude calls you ("Welcome back, <name>!"); "" = auto-derive. */
  name: string;
  /** Model alias or full id; "" = let Claude Code decide. */
  model: string;
  /** Reasoning effort passed as --effort; "" = default. */
  effort: Effort | "";
  /** Extended thinking: when on, MAX_THINKING_TOKENS is set for launched sessions. */
  thinking: boolean;
  thinkingBudget: number;
  /** Runner auto-switches accounts when the active one hits a limit. */
  autoSwitch: boolean;
  /** Preferred failover order of labels; empty = vault order. */
  switchOrder: string[];
  /** Optional token caps purely for the dashboard's % bars (real plan caps aren't exposed locally). */
  budget5hTokens?: number;
  budget7dTokens?: number;
  /** Whether we've already offered to install the Claude Code status line (so we ask once). */
  statuslineOffered?: boolean;
}

export const MODELS = ["opus", "sonnet", "haiku"] as const;
export const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const DEFAULTS: Settings = {
  name: "",
  model: "",
  effort: "",
  thinking: false,
  thinkingBudget: 31999,
  autoSwitch: true,
  switchOrder: [],
};

const FILE = path.join(POLY_DIR, "settings.json");

export async function load(): Promise<Settings> {
  try {
    const raw = await fs.readFile(FILE, "utf8");
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULTS };
    throw e;
  }
}

export async function save(s: Settings): Promise<void> {
  await fs.mkdir(POLY_DIR, { recursive: true });
  const tmp = `${FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(s, null, 2));
  await fs.rename(tmp, FILE);
}

export async function update(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await load()), ...patch };
  await save(next);
  return next;
}
