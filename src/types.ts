/** The OAuth blob Claude Code stores in ~/.claude/.credentials.json */
export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** epoch milliseconds */
  expiresAt: number;
  scopes: string[] | string;
  subscriptionType: string;
  rateLimitTier?: string;
}

export interface CredentialsFile {
  claudeAiOauth: OAuthCredentials;
}

/** Authoritative rate-limit status from Claude Code's `rate_limit_event` stream. */
export interface RateLimitInfo {
  /** "allowed" when not limited; anything else means the window is exhausted. */
  status: string;
  /** epoch SECONDS when this window resets */
  resetsAt?: number;
  /** e.g. "five_hour", "seven_day" */
  rateLimitType?: string;
  overageStatus?: string;
  isUsingOverage?: boolean;
}

/** Real usage from /api/oauth/usage (percentages + reset times). */
export interface AccountUsage {
  /** 0–100, or null if unknown */
  fiveHourPct?: number | null;
  /** epoch ms */
  fiveHourResetsAt?: number;
  sevenDayPct?: number | null;
  sevenDayResetsAt?: number;
  /** epoch ms when this was fetched */
  fetchedAt: number;
  error?: string;
  /** true when this is a last-good cached value we couldn't refresh (e.g. the
   *  active account's token expired — Claude Code must refresh it on next use). */
  stale?: boolean;
}

/** Non-secret metadata we keep for display/selection. */
export interface AccountMeta {
  label: string;
  /** stable account id from /api/oauth/profile — used to de-dupe on re-add */
  accountUuid?: string;
  email?: string;
  /** real display name from /api/oauth/profile */
  fullName?: string;
  orgId?: string;
  orgName?: string;
  /** organization_type, e.g. "claude_pro"/"claude_max" (personal) vs team/enterprise */
  orgType?: string;
  /** seat tier when this is a member of a real org */
  seatTier?: string | null;
  subscriptionType?: string;
  rateLimitTier?: string;
  /** cached real usage (percentages + resets) */
  usage?: AccountUsage;
  /** epoch ms */
  addedAt: number;
  /** epoch ms */
  updatedAt: number;
  /** epoch ms — access-token expiry, mirrored from the secret for display */
  expiresAt?: number;
  /** last seen rate-limit windows, keyed by rateLimitType */
  rateLimits?: Record<string, RateLimitInfo>;
  /** epoch ms when rateLimits was last captured from a live run */
  rateLimitsAt?: number;
}

export interface VaultEntry {
  meta: AccountMeta;
  /** DPAPI-encrypted JSON of CredentialsFile, base64 */
  secret: string;
}

export interface VaultData {
  version: number;
  activeLabel?: string;
  accounts: Record<string, VaultEntry>;
}
