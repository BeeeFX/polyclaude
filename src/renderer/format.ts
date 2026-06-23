// Tiny, dependency-free formatters for the renderer (mirrors the guards in
// cli/format.ts so a bad timestamp never renders as an absurd "time ago").

function isValidMs(epochMs?: number): boolean {
  return typeof epochMs === "number" && Number.isFinite(epochMs) && epochMs >= 1e12;
}

export function ago(epochMs?: number): string {
  if (!isValidMs(epochMs)) return "—";
  const ms = Date.now() - (epochMs as number);
  if (ms < 60_000) return "just now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function resetIn(epochMs?: number): string {
  if (!isValidMs(epochMs)) return "";
  const ms = (epochMs as number) - Date.now();
  if (ms <= 0) return "resetting…";
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h <= 0 ? `resets in ${m} min` : `resets in ${h}h ${m}m`;
}

export function resetAt(epochMs?: number): string {
  if (!isValidMs(epochMs)) return "";
  const d = new Date(epochMs as number);
  return `resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

export function cap(s?: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

export function pctText(pct?: number | null): string {
  return pct == null ? "—" : `${Math.round(pct)}%`;
}

/** green / amber / red bucket used for usage tinting. */
export function level(pct?: number | null): "ok" | "warn" | "high" {
  if (pct == null) return "ok";
  if (pct >= 90) return "high";
  if (pct >= 75) return "warn";
  return "ok";
}
