/**
 * Thin client for the Claude subscription OAuth API — the same endpoints
 * Claude Code itself uses for its `/usage` panel and account info. All calls
 * take a subscription access token (from a stored account's credentials).
 *
 * Endpoints (discovered from the Claude Code binary):
 *   GET  https://api.anthropic.com/api/oauth/usage    → utilization % + reset times
 *   GET  https://api.anthropic.com/api/oauth/profile  → account + organization
 *   POST https://platform.claude.com/v1/oauth/token   → refresh an access token
 */

const API = "https://api.anthropic.com";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const BETA = "oauth-2025-04-20";
/** Claude Code's OAuth client id (from /api/oauth/profile → application.uuid). */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": BETA,
    "anthropic-version": "2023-06-01",
    "Content-Type": "application/json",
  };
}

export interface UsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface UsageResponse {
  five_hour: UsageWindow;
  seven_day: UsageWindow;
  seven_day_opus?: UsageWindow | null;
  seven_day_sonnet?: UsageWindow | null;
  extra_usage?: {
    is_enabled?: boolean;
    used_credits?: number;
    monthly_limit?: number | null;
    currency?: string;
  } | null;
}

export interface ProfileResponse {
  account: {
    uuid: string;
    full_name?: string;
    display_name?: string;
    email?: string;
    has_claude_max?: boolean;
    has_claude_pro?: boolean;
  };
  organization: {
    uuid: string;
    name?: string;
    /** e.g. "claude_pro" / "claude_max" (personal) vs team/enterprise types */
    organization_type?: string;
    rate_limit_tier?: string;
    seat_tier?: string | null;
  };
}

async function apiGet<T>(path: string, token: string, timeoutMs = 8000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}${path}`, { headers: headers(token), signal: ctrl.signal });
    if (res.status === 401) throw new Error("unauthorized");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export function getUsage(token: string): Promise<UsageResponse> {
  return apiGet<UsageResponse>("/api/oauth/usage", token);
}

export function getProfile(token: string): Promise<ProfileResponse> {
  return apiGet<ProfileResponse>("/api/oauth/profile", token);
}

export interface RefreshResult {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

/** Exchange a refresh token for a new access token (rotates the refresh token). */
export async function refresh(refreshToken: string): Promise<RefreshResult> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { type?: string; message?: string } };
      if (body?.error?.type === "rate_limit_error") detail = "rate-limited";
      else if (body?.error?.type) detail = body.error.type;
    } catch {
      /* keep HTTP status */
    }
    const err = new Error(`token refresh failed (${detail})`) as Error & { rateLimited?: boolean };
    err.rateLimited = res.status === 429 || detail === "rate-limited";
    throw err;
  }
  return (await res.json()) as RefreshResult;
}
