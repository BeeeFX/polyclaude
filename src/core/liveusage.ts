import * as oauthapi from "./oauthapi.js";
import * as vault from "./vault.js";
import * as credentials from "./credentials.js";
import type { AccountUsage, CredentialsFile } from "../types.js";

/**
 * Fetches real subscription usage (the same numbers as Claude's `/usage`).
 *
 * Token handling is deliberately gentle: we try the call with the existing
 * access token FIRST and only refresh on a genuine 401. The OAuth token-refresh
 * endpoint is rate-limited and rotates the refresh token, so over-refreshing
 * (or retrying a failing refresh in a tight loop) gets the whole account
 * rate-limited. When a refresh fails we back off and keep showing the last
 * known usage instead of hammering.
 *
 * The active account is refreshed too (so usage updates without "open Claude"),
 * EXCEPT while polyclaude is running a Claude session on it (see
 * setActiveSessionBusy) — then we leave the rotating token to the live process.
 * Refreshed tokens are written back to .credentials.json so Claude stays in sync.
 */

const REFRESH_BACKOFF_MS = 10 * 60_000; // after a failed refresh, wait before retrying
const backoffUntil = new Map<string, number>();
/** Friendly reason of the last refresh failure per label, so we keep reporting
 *  the real cause (e.g. "sign in again") while backed off. */
const lastFailReason = new Map<string, string>();

/** True while polyclaude is itself running a Claude session on the active account
 *  (set by the desktop app's pty manager). We avoid refreshing the active token
 *  during that window so we don't race the live process over the rotating token;
 *  when idle it's safe for polyclaude to refresh and write the new token back. */
let activeSessionBusy = false;
export function setActiveSessionBusy(busy: boolean): void {
  activeSessionBusy = busy;
}

/** For the active account use the live credentials file (Claude Code keeps it
 *  fresh); otherwise use the vault copy. */
async function loadCreds(label: string, activeLabel?: string): Promise<CredentialsFile | null> {
  if (label === activeLabel) {
    const live = await credentials.readActive();
    if (live) return live;
  }
  try {
    return await vault.getCredentials(label);
  } catch {
    return null;
  }
}

async function persist(label: string, activeLabel: string | undefined, creds: CredentialsFile) {
  await vault.replaceCredentials(label, creds).catch(() => {});
  if (label === activeLabel) await credentials.writeActive(creds).catch(() => {});
}

/** Run an authed call, refreshing once on 401 (subject to a backoff window). */
async function callWithAuth<T>(label: string, call: (token: string) => Promise<T>): Promise<T> {
  const activeLabel = (await vault.load()).activeLabel;
  const creds = await loadCreds(label, activeLabel);
  if (!creds) throw new Error("no credentials");

  // 1. Try with whatever token we already have.
  try {
    return await call(creds.claudeAiOauth.accessToken);
  } catch (e) {
    if ((e as Error).message !== "unauthorized") throw e;
  }

  // 2a. For the ACTIVE account, only hold off while polyclaude is itself running
  //     a Claude session on it (don't race the live process over the rotating
  //     token). When idle, fall through and refresh like any other account,
  //     writing the new token back to .credentials.json so Claude stays in sync.
  if (label === activeLabel && activeSessionBusy) {
    throw new Error("open Claude to refresh");
  }

  // 2b. Refresh once (with backoff), then retry the call. While backed off, keep
  //     reporting the REAL reason of the last failure (e.g. "sign in again") so an
  //     invalid login isn't masked as generic staleness for the next 10 minutes.
  const until = backoffUntil.get(label) ?? 0;
  if (Date.now() < until) throw new Error(lastFailReason.get(label) ?? "usage temporarily unavailable");

  let r: oauthapi.RefreshResult;
  try {
    r = await oauthapi.refresh(creds.claudeAiOauth.refreshToken);
  } catch (e) {
    const reason = friendly((e as Error).message);
    lastFailReason.set(label, reason);
    backoffUntil.set(label, Date.now() + REFRESH_BACKOFF_MS);
    throw new Error(reason);
  }
  const fresh: CredentialsFile = {
    ...creds,
    claudeAiOauth: {
      ...creds.claudeAiOauth,
      accessToken: r.access_token,
      refreshToken: r.refresh_token ?? creds.claudeAiOauth.refreshToken,
      expiresAt: Date.now() + r.expires_in * 1000,
    },
  };
  await persist(label, activeLabel, fresh);
  backoffUntil.delete(label);
  lastFailReason.delete(label);
  return await call(r.access_token);
}

function toAccountUsage(u: oauthapi.UsageResponse): AccountUsage {
  const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : undefined);
  return {
    fiveHourPct: u.five_hour?.utilization ?? null,
    fiveHourResetsAt: ms(u.five_hour?.resets_at),
    sevenDayPct: u.seven_day?.utilization ?? null,
    sevenDayResetsAt: ms(u.seven_day?.resets_at),
    fetchedAt: Date.now(),
  };
}

function friendly(msg: string): string {
  if (/rate-limited|rate_limit/i.test(msg)) return "usage temporarily unavailable (rate-limited)";
  // A failed refresh with an invalid/expired refresh token means the login is no
  // longer valid — only a real re-login (`/login`) fixes it.
  if (/invalid_grant|invalid_request|invalid_token|unauthorized|401/i.test(msg)) {
    return "sign in again — run /login in Claude";
  }
  return msg;
}

/** Fetch + cache usage for a stored account label, keeping the last value on failure. */
export async function fetchForLabel(label: string): Promise<AccountUsage> {
  try {
    const u = await callWithAuth(label, oauthapi.getUsage);
    const usage = toAccountUsage(u);
    await vault.updateMeta(label, { usage });
    // For the active account, keep the vault's stored credentials in sync with
    // the live file — so reconnecting via `claude auth login` updates this entry
    // (no duplicate) and switching back later won't restore a stale token. But
    // only when the token actually rotated: the live `expiresAt` differs from the
    // one we recorded. Tokens last ~8h, so without this guard a status line would
    // spawn a DPAPI encrypt + extra vault write on every ~90s refresh for no gain.
    const data = await vault.load();
    if (data.activeLabel === label) {
      const live = await credentials.readActive();
      const storedExpiresAt = data.accounts[label]?.meta.expiresAt;
      if (live && live.claudeAiOauth.expiresAt !== storedExpiresAt) {
        await vault.replaceCredentials(label, live).catch(() => {});
      }
    }
    return usage;
  } catch (e) {
    const data = await vault.load();
    const existing = data.accounts[label]?.meta.usage;
    // Keep showing the last good numbers, but flag them stale + carry the reason
    // so the UI can distinguish "couldn't refresh" from "sign-in expired" (401).
    if (existing && existing.fiveHourPct != null) {
      return { ...existing, stale: true, error: friendly((e as Error).message) };
    }
    return { fetchedAt: Date.now(), error: friendly((e as Error).message) };
  }
}

/** Fetch the account profile (name, org, plan) and cache it on the account meta. */
export async function fetchProfileForLabel(label: string): Promise<void> {
  try {
    const p = await callWithAuth(label, oauthapi.getProfile);
    await vault.updateMeta(label, {
      fullName: p.account.full_name ?? p.account.display_name,
      email: p.account.email,
      orgName: p.organization.name,
      orgType: p.organization.organization_type,
      seatTier: p.organization.seat_tier ?? null,
      subscriptionType: p.account.has_claude_max ? "max" : p.account.has_claude_pro ? "pro" : undefined,
      rateLimitTier: p.organization.rate_limit_tier,
    });
  } catch {
    /* leave existing meta as-is */
  }
}

export async function fetchActive(): Promise<AccountUsage | null> {
  const data = await vault.load();
  if (!data.activeLabel) return null;
  return fetchForLabel(data.activeLabel);
}

export async function fetchAll(): Promise<Record<string, AccountUsage>> {
  const labels = (await vault.list()).map((m) => m.label);
  const results = await Promise.all(labels.map(async (l) => [l, await fetchForLabel(l)] as const));
  return Object.fromEntries(results);
}
