import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolveClaudeBin } from "./claude.js";
import * as vault from "./vault.js";
import { switchTo } from "./switcher.js";
import * as settings from "./settings.js";
import type { RateLimitInfo } from "../types.js";

/**
 * Drives Claude Code in headless stream-json mode so we can (a) capture the
 * assistant text + token usage and (b) detect a real usage/rate-limit error and
 * fail over to another account, resuming the same session so context survives.
 *
 * Limit detection is structured, not text-matched: Claude Code emits
 * `rate_limit_event` messages whose `rate_limit_info.status` is "allowed" until
 * the window is exhausted. We only fall back to a stderr text check for hard
 * errors that exit non-zero (e.g. a 429 before any stream is produced).
 */

const STDERR_LIMIT_RE =
  /(rate.?limit|usage limit|usage cap|limit reached|exceeded your|out of (usage|tokens)|429|too many requests|plan limit)/i;

export interface RunOpts {
  sessionId?: string;
  resume?: boolean;
  model?: string;
  effort?: string;
  thinking?: boolean;
  thinkingBudget?: number;
  cwd?: string;
  /** stream assistant text chunks as they arrive */
  onText?: (chunk: string) => void;
}

export interface RunResult {
  ok: boolean;
  text: string;
  limited: boolean;
  error?: string;
  usage?: { input: number; output: number; cacheCreate: number; cacheRead: number };
  /** rate-limit windows seen during the run, keyed by rateLimitType */
  rateLimits?: Record<string, RateLimitInfo>;
  sessionId: string;
}

/** Run a single prompt through the *currently active* account. */
export function runOnce(prompt: string, opts: RunOpts = {}): Promise<RunResult> {
  const sessionId = opts.sessionId ?? randomUUID();

  // Dev/test hook: simulate a limit without spending real tokens.
  if (process.env.POLYCLAUDE_SIMULATE_LIMIT) {
    const exhausted = process.env.POLYCLAUDE_SIMULATE_LIMIT.split(",");
    return vault.load().then((d) => {
      const active = d.activeLabel ?? "";
      if (exhausted.includes(active) || exhausted.includes("*")) {
        return { ok: false, text: "", limited: true, error: "simulated usage limit", sessionId };
      }
      const text = `[simulated reply from ${active}] ${prompt}`;
      opts.onText?.(text);
      return { ok: true, text, limited: false, usage: { input: 4, output: 8, cacheCreate: 0, cacheRead: 0 }, sessionId };
    });
  }

  const args = ["-p", prompt, "--output-format", "stream-json", "--verbose"];
  if (opts.resume) args.push("--resume", sessionId);
  else args.push("--session-id", sessionId);
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);

  const env = { ...process.env };
  if (opts.thinking) env.MAX_THINKING_TOKENS = String(opts.thinkingBudget ?? 31999);

  return new Promise<RunResult>((resolve) => {
    // stdin: "ignore" so claude doesn't wait on an empty pipe for stdin input.
    const child = spawn(resolveClaudeBin(), args, {
      env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let text = "";
    let usage: RunResult["usage"];
    const rateLimits: Record<string, RateLimitInfo> = {};
    let resultIsError = false;

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) =>
      resolve({ ok: false, text: "", limited: false, error: e.message, sessionId })
    );
    child.on("close", (code) => {
      for (const line of stdout.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let d: {
          type?: string;
          subtype?: string;
          is_error?: boolean;
          message?: { content?: Array<{ type?: string; text?: string }> };
          usage?: Record<string, number>;
          rate_limit_info?: RateLimitInfo;
          result?: unknown;
        };
        try {
          d = JSON.parse(t);
        } catch {
          continue;
        }
        if (d.type === "assistant" && d.message?.content) {
          for (const b of d.message.content) {
            if (b.type === "text" && b.text) {
              text += b.text;
              opts.onText?.(b.text);
            }
          }
        }
        if (d.type === "rate_limit_event" && d.rate_limit_info) {
          const info = d.rate_limit_info;
          rateLimits[info.rateLimitType ?? "unknown"] = info;
        }
        if (d.type === "result") {
          if (d.is_error) resultIsError = true;
          if (d.usage) {
            usage = {
              input: d.usage.input_tokens ?? 0,
              output: d.usage.output_tokens ?? 0,
              cacheCreate: d.usage.cache_creation_input_tokens ?? 0,
              cacheRead: d.usage.cache_read_input_tokens ?? 0,
            };
          }
          if (typeof d.result === "string" && !text) text = d.result;
        }
      }

      // A window is exhausted when any rate_limit_info.status != "allowed".
      const limitedByEvent = Object.values(rateLimits).some(
        (r) => r.status && r.status !== "allowed"
      );
      // Hard failure with no usable text → check stderr for a limit phrase.
      const noText = text.trim().length === 0;
      const limitedByError =
        (code !== 0 || resultIsError) && noText && STDERR_LIMIT_RE.test(stderr);
      const limited = limitedByEvent || limitedByError;

      const ok = code === 0 && !limited && !resultIsError && text.trim().length > 0;
      resolve({
        ok,
        text: text.trim(),
        limited,
        error: ok ? undefined : stderr.trim() || `claude exited with code ${code}`,
        usage,
        rateLimits: Object.keys(rateLimits).length ? rateLimits : undefined,
        sessionId,
      });
    });
  });
}

export interface FailoverResult extends RunResult {
  account: string;
  /** labels we switched to during failover, in order */
  switched: string[];
  /** labels that reported a limit */
  exhausted: string[];
}

async function activate(label: string, reason: "manual" | "auto"): Promise<void> {
  await switchTo(label, reason);
}

/** Preferred account order for failover. */
export async function orderedLabels(): Promise<string[]> {
  const s = await settings.load();
  const all = (await vault.list()).map((m) => m.label);
  if (s.switchOrder.length) {
    const pref = s.switchOrder.filter((l) => all.includes(l));
    return [...pref, ...all.filter((l) => !pref.includes(l))];
  }
  return all;
}

/**
 * Run a prompt, automatically switching to the next account (and resuming the
 * same session) whenever the active one reports a usage/rate limit.
 */
export async function runWithFailover(
  prompt: string,
  opts: RunOpts & { onSwitch?: (label: string, reason: string) => void } = {}
): Promise<FailoverResult> {
  // `opts.resume` forces resume from the first attempt (used for chat turns 2+).
  const forceResume = !!opts.resume && !!opts.sessionId;
  const data = await vault.load();
  const order = await orderedLabels();
  if (order.length === 0) {
    return {
      ok: false,
      text: "",
      limited: false,
      error: "No accounts in the vault. Add one with `pcc add <label>`.",
      sessionId: opts.sessionId ?? randomUUID(),
      account: "",
      switched: [],
      exhausted: [],
    };
  }

  const start =
    data.activeLabel && order.includes(data.activeLabel) ? data.activeLabel : order[0];
  const queue = [start, ...order.filter((l) => l !== start)];

  const switched: string[] = [];
  const exhausted: string[] = [];
  let last: RunResult | undefined;
  let firstAttempt = true;

  for (const label of queue) {
    const cur = (await vault.load()).activeLabel;
    if (cur !== label) {
      await activate(label, firstAttempt ? "manual" : "auto");
      switched.push(label);
      opts.onSwitch?.(label, firstAttempt ? "manual" : "auto");
    }
    // Resume the same session if forced (later chat turn) or after a failover,
    // so the conversation continues seamlessly on the new account.
    const res = await runOnce(prompt, {
      ...opts,
      resume: !!opts.sessionId && (forceResume || !firstAttempt),
    });
    firstAttempt = false;
    last = res;
    if (res.rateLimits) {
      await vault.updateMeta(label, { rateLimits: res.rateLimits, rateLimitsAt: Date.now() });
    }
    if (res.ok || !res.limited) {
      return { ...res, account: label, switched, exhausted };
    }
    exhausted.push(label);
  }

  return {
    ...(last as RunResult),
    account: queue[queue.length - 1],
    switched,
    exhausted,
  };
}
