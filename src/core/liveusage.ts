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
 */

const REFRESH_BACKOFF_MS = 10 * 60_000; // after a failed refresh, wait before retrying
const backoffUntil = new Map<string, number>();

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

  // 2a. Never refresh the ACTIVE account's token — Claude Code owns it and the
  //     refresh token rotates; competing over it can invalidate the login.
  //     It will be refreshed the next time you actually use Claude.
  if (label === activeLabel) {
    throw new Error("session token expired — open Claude to refresh");
  }

  // 2b. Inactive account → polyclaude manages it: refresh once (with backoff).
  const until = backoffUntil.get(label) ?? 0;
  if (Date.now() < until) throw new Error("usage temporarily unavailable");

  let r: oauthapi.RefreshResult;
  try {
    r = await oauthapi.refresh(creds.claudeAiOauth.refreshToken);
  } catch (e) {
    backoffUntil.set(label, Date.now() + REFRESH_BACKOFF_MS);
    throw e;
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
  if (/unauthorized|401/i.test(msg)) return "session expired — run Claude or re-add the account";
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
