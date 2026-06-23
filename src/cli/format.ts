import pc from "picocolors";

/** Human-friendly "time until" for an epoch-ms timestamp. */
export function fmtUntil(epochMs?: number): string {
  if (!epochMs) return "—";
  const ms = epochMs - Date.now();
  if (ms <= 0) return pc.red("expired");
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ${min % 60}m`;
  const day = Math.floor(hr / 24);
  return `${day}d ${hr % 24}h`;
}

/** Remove ANSI SGR color escape codes (ESC[ … m) so we can measure width. */
function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27);
  const re = new RegExp(ESC + "\\[[0-9;]*m", "g");
  return s.replace(re, "");
}

/** Visible length, ignoring ANSI color escape codes. */
function visibleLen(s: string): number {
  return stripAnsi(s).length;
}

/** Pad/truncate a string to a fixed *visible* width (color-code aware). */
export function cell(s: string, width: number): string {
  const str = s ?? "";
  const vis = visibleLen(str);
  if (vis > width) {
    // Truncating mid-color would corrupt escape codes, so drop color on overflow.
    return stripAnsi(str).slice(0, width - 1) + "…";
  }
  return str + " ".repeat(width - vis);
}

/** Best-effort friendly name from an email's local part (capitalized). */
export function nameFromEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const local = email.split("@")[0] ?? "";
  // split on separators/digits, prefer the longest alphabetic token
  const tokens = local.split(/[^a-zA-Z]+/).filter((t) => t.length >= 2);
  const pick = tokens.sort((a, b) => b.length - a.length)[0];
  if (!pick) return undefined;
  return pick[0].toUpperCase() + pick.slice(1).toLowerCase();
}

/** True for a plausible epoch-MS timestamp. Guards against 0, NaN/Infinity, and
 *  values that are clearly seconds (or otherwise pre-2001), which would otherwise
 *  render as an absurd "time ago" (e.g. "481507h ago"). 1e12 ms ≈ Sep 2001. */
function isValidMs(epochMs?: number): boolean {
  return typeof epochMs === "number" && Number.isFinite(epochMs) && epochMs >= 1e12;
}

/** Short "time ago" with seconds granularity for the first minute. */
export function fmtAgoShort(epochMs: number): string {
  if (!isValidMs(epochMs)) return "—";
  const s = Math.round((Date.now() - epochMs) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${Math.min(55, Math.round(s / 5) * 5)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Human-friendly "time ago" for a past epoch-ms timestamp. */
export function fmtAgo(epochMs: number): string {
  if (!isValidMs(epochMs)) return "—";
  const ms = Date.now() - epochMs;
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** "1 hr 58 min" style countdown to a reset (for the 5-hour session). */
export function fmtResetIn(epochMs?: number): string {
  if (!epochMs) return "";
  const ms = epochMs - Date.now();
  if (ms <= 0) return "resetting…";
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h <= 0) return `${m} min`;
  return `${h} hr${h > 1 ? "s" : ""} ${m} min`;
}

/** "Sun 1:00 AM" style absolute reset time (for the weekly window). */
export function fmtResetAt(epochMs?: number): string {
  if (!epochMs) return "";
  const d = new Date(epochMs);
  const day = d.toLocaleDateString(undefined, { weekday: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return `${day} ${time}`;
}

/** Personal subscription orgs vs real team/enterprise orgs. */
export function isPersonalOrg(orgType?: string): boolean {
  return !orgType || orgType === "claude_pro" || orgType === "claude_max";
}

/** Compact token count: 942, 12.3k, 1.20M. */
export function human(n: number): string {
  if (!isFinite(n)) return "—";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10_000 ? 1 : 0) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

/** A unicode progress bar of the given visible width. */
export function bar(fraction: number, width: number): string {
  const f = Math.max(0, Math.min(1, isFinite(fraction) ? fraction : 0));
  const filled = Math.round(f * width);
  return "█".repeat(filled) + "░".repeat(Math.max(0, width - filled));
}

export function ok(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${pc.yellow("!")} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${pc.red("✗")} ${msg}`);
}

export const c = pc;
