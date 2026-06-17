import { spawn, spawnSync } from "node:child_process";
import { resolveClaudeBin, authStatus } from "./claude.js";
import * as credentials from "./credentials.js";
import * as vault from "./vault.js";
import * as switchlog from "./switchlog.js";
import * as settings from "./settings.js";
import * as oauthapi from "./oauthapi.js";
import type { CredentialsFile } from "../types.js";

/**
 * In-app sign-in: drives `claude auth login` (which opens the browser), then
 * captures the resulting credentials into the vault — de-duplicating so that
 * re-connecting an account UPDATES the existing entry instead of adding a copy.
 */

/** Run interactive `claude auth login`, inheriting the terminal. */
export function interactiveLogin(email?: string): Promise<number> {
  const args = ["auth", "login", "--claudeai"];
  if (email) args.push("--email", email);
  // Give the child sole ownership of stdin: drop raw mode, detach our listeners,
  // and PAUSE our own stdin (if the parent keeps reading it, it steals the
  // child's keystrokes and claude's prompt appears frozen).
  try {
    const stdin = process.stdin;
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
    stdin.removeAllListeners("data");
    stdin.removeAllListeners("readable");
    stdin.removeAllListeners("keypress");
    stdin.pause();
  } catch {
    /* ignore */
  }
  return new Promise((resolve) => {
    const child = spawn(resolveClaudeBin(), args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

export function logout(): void {
  try {
    spawnSync(resolveClaudeBin(), ["auth", "logout"], { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

/** Suggest a friendly, unique label from an email's local part. */
export function suggestLabel(email: string | undefined, existing: string[]): string {
  let base = (email?.split("@")[0] ?? "account").replace(/[^a-zA-Z0-9._-]/g, "");
  if (!base) base = "account";
  if (!existing.includes(base)) return base;
  let i = 2;
  while (existing.includes(`${base}${i}`)) i++;
  return `${base}${i}`;
}

interface Identity {
  uuid?: string;
  email?: string;
  fullName?: string;
  orgId?: string;
  orgName?: string;
  orgType?: string;
  seatTier?: string | null;
  subscriptionType?: string;
  rateLimitTier?: string;
}

/** Identify the active account (profile is most reliable; fall back to auth status). */
async function identify(creds: CredentialsFile): Promise<Identity> {
  try {
    const p = await oauthapi.getProfile(creds.claudeAiOauth.accessToken);
    return {
      uuid: p.account.uuid,
      email: p.account.email,
      fullName: p.account.full_name ?? p.account.display_name,
      orgName: p.organization.name,
      orgType: p.organization.organization_type,
      seatTier: p.organization.seat_tier ?? null,
      subscriptionType: p.account.has_claude_max ? "max" : p.account.has_claude_pro ? "pro" : undefined,
      rateLimitTier: p.organization.rate_limit_tier,
    };
  } catch {
    const st = authStatus();
    return {
      email: st?.email,
      orgId: st?.orgId,
      orgName: st?.orgName,
      subscriptionType: st?.subscriptionType,
    };
  }
}

/**
 * Capture the active credentials into the vault, de-duplicating against an
 * existing account with the same identity (uuid or email) — so re-connecting
 * updates that account instead of creating a duplicate. Returns the label and
 * whether an existing account was updated.
 */
export async function captureActive(
  opts: { primeUsage?: boolean } = {}
): Promise<{ label: string; email?: string; updated: boolean }> {
  const creds = await credentials.readActive();
  if (!creds) throw new Error("No active Claude credentials found to save.");
  const id = await identify(creds);

  const accounts = await vault.list();
  const match = accounts.find(
    (m) =>
      (id.uuid && m.accountUuid === id.uuid) ||
      (id.email && m.email && m.email.toLowerCase() === id.email.toLowerCase())
  );
  const label = match?.label ?? suggestLabel(id.email, accounts.map((m) => m.label));

  await vault.upsert(label, creds, {
    accountUuid: id.uuid,
    email: id.email,
    fullName: id.fullName,
    orgId: id.orgId,
    orgName: id.orgName,
    orgType: id.orgType,
    seatTier: id.seatTier,
    subscriptionType: id.subscriptionType ?? creds.claudeAiOauth.subscriptionType,
    rateLimitTier: id.rateLimitTier ?? creds.claudeAiOauth.rateLimitTier,
    expiresAt: creds.claudeAiOauth.expiresAt,
  });
  await vault.setActive(label);
  await switchlog.record(label, match ? "manual" : "add");

  // Prime usage so the dashboard is ready, and personalize the greeting once.
  if (opts.primeUsage !== false) {
    const liveusage = await import("./liveusage.js");
    await liveusage.fetchForLabel(label).catch(() => {});
  }
  if (id.fullName) {
    const s = await settings.load();
    if (!s.name?.trim()) await settings.update({ name: id.fullName });
  }
  return { label, email: id.email, updated: !!match };
}

/**
 * The full "add an account" flow, run on the real terminal (TUI unmounted).
 * - "import": save the account you're already signed into (no browser).
 * - "login":  sign in (browser), then save it (updating it if already known).
 */
export async function addAccountInteractive(
  mode: "login" | "import"
): Promise<{ label: string; email?: string; updated: boolean } | null> {
  if (mode === "login") {
    // Save/refresh the current account first so switching can't lose it.
    // We do NOT sign out first: a cancelled sign-in leaves you on your account.
    if (await credentials.readActive()) {
      await captureActive().catch(() => {});
    }
    console.log(
      "\nA browser window will open to sign in. Approve it (and paste the code if\n" +
        "asked), then come back here. Ctrl-C to cancel.\n"
    );
    const code = await interactiveLogin();
    if (code !== 0) {
      console.log("\nSign-in was cancelled or failed. Your current account is unchanged.\n");
      return null;
    }
  }

  const st = authStatus();
  if (!st?.loggedIn) {
    console.log("\nNo account is signed in, so nothing was saved.\n");
    return null;
  }

  process.stdout.write("Saving account…\n");
  const res = await captureActive();
  console.log(
    `\n✓ ${res.updated ? "Updated" : "Added"} "${res.label}"${res.email ? ` (${res.email})` : ""}.` +
      (res.updated ? "" : "  Rename it any time with R in the dashboard.") +
      "\n"
  );
  return res;
}
