import type { Command } from "commander";
import * as vault from "../../core/vault.js";
import * as credentials from "../../core/credentials.js";
import * as switchlog from "../../core/switchlog.js";
import { switchTo } from "../../core/switcher.js";
import { authStatus } from "../../core/claude.js";
import { ACTIVE_CREDENTIALS } from "../../core/paths.js";
import * as liveusage from "../../core/liveusage.js";
import * as settings from "../../core/settings.js";
import { c, cell, ok, warn, fail, isPersonalOrg } from "../format.js";

function pct(n?: number | null): string {
  if (n == null) return c.dim("—");
  const s = `${Math.round(n)}%`;
  return n >= 90 ? c.red(s) : n >= 75 ? c.yellow(s) : c.green(s);
}

export function registerAccountCommands(program: Command): void {
  // ---- login -----------------------------------------------------------
  program
    .command("login")
    .description("Sign in to a Claude account (opens your browser) and save it to the vault")
    .action(async () => {
      const { addAccountInteractive } = await import("../../core/login.js");
      await addAccountInteractive("login");
    });

  // ---- add -------------------------------------------------------------
  program
    .command("add <label>")
    .description("Snapshot the currently logged-in Claude account into the vault")
    .action(async (label: string) => {
      const creds = await credentials.readActive();
      if (!creds) {
        fail(
          `No active Claude credentials at ${ACTIVE_CREDENTIALS}.\n` +
            `  Log in first with:  claude auth login   (or  claude /login )`
        );
        process.exitCode = 1;
        return;
      }
      const status = authStatus();
      await vault.upsert(label, creds, {
        email: status?.email,
        orgId: status?.orgId,
        orgName: status?.orgName,
        subscriptionType:
          status?.subscriptionType ?? creds.claudeAiOauth.subscriptionType,
        rateLimitTier: creds.claudeAiOauth.rateLimitTier,
        expiresAt: creds.claudeAiOauth.expiresAt,
      });
      // If this is now the active account, anchor usage attribution from here.
      if ((await vault.load()).activeLabel === label) {
        await switchlog.record(label, "add");
      }
      // Pull the real profile (name, org, plan) + usage from Claude's API.
      process.stdout.write(c.dim("fetching account details…\r"));
      await liveusage.fetchProfileForLabel(label).catch(() => {});
      await liveusage.fetchForLabel(label).catch(() => {});
      process.stdout.write("                          \r");
      const meta = (await vault.list()).find((m) => m.label === label);
      const s = await settings.load();
      if (!s.name?.trim() && meta?.fullName) await settings.update({ name: meta.fullName });

      ok(
        `Saved account ${c.bold(label)}` +
          (meta?.email ?? status?.email ? ` (${meta?.email ?? status?.email})` : "") +
          `.`
      );
      console.log(
        c.dim(
          "  Tip: to add another, run `claude auth logout` then `claude auth login`\n" +
            "       into the other account, then `pcc add <other-label>`."
        )
      );
    });

  // ---- list ------------------------------------------------------------
  program
    .command("list")
    .alias("ls")
    .description("List saved accounts with live usage")
    .option("--no-refresh", "use cached usage instead of fetching live")
    .action(async (opts: { refresh?: boolean }) => {
      let accounts = await vault.list();
      const data = await vault.load();
      if (accounts.length === 0) {
        warn("No accounts saved yet. Add one with: pcc add <label>");
        return;
      }
      if (opts.refresh !== false) {
        process.stdout.write(c.dim("fetching usage…\r"));
        await liveusage.fetchAll().catch(() => {});
        accounts = await vault.list();
        process.stdout.write("                  \r");
      }
      console.log(
        c.dim(
          "  " +
            cell("", 2) +
            cell("LABEL", 13) +
            cell("EMAIL", 30) +
            cell("PLAN", 6) +
            cell("5H", 7) +
            cell("7D", 7) +
            "ORG / PERSONAL"
        )
      );
      for (const a of accounts) {
        const active = data.activeLabel === a.label;
        const marker = active ? c.green("●") : c.dim("○");
        const org = isPersonalOrg(a.orgType) ? c.dim("personal") : c.magenta(a.orgName ?? "organization");
        console.log(
          "  " +
            cell(marker, 2) +
            cell(active ? c.green(a.label) : a.label, 13) +
            cell(a.email ?? "—", 30) +
            cell(a.subscriptionType ? a.subscriptionType : "—", 6) +
            cell(pct(a.usage?.fiveHourPct), 7) +
            cell(pct(a.usage?.sevenDayPct), 7) +
            org
        );
      }
      console.log(c.dim(`\n  ● = active · 5H/7D = plan usage · switch with: pcc use <label>`));
    });

  // ---- rename ----------------------------------------------------------
  program
    .command("rename <oldLabel> <newLabel>")
    .alias("mv")
    .description("Change an account's label")
    .action(async (oldLabel: string, newLabel: string) => {
      try {
        await vault.rename(oldLabel, newLabel);
        ok(`Renamed ${c.bold(oldLabel)} → ${c.bold(newLabel)}.`);
      } catch (e) {
        fail((e as Error).message);
        process.exitCode = 1;
      }
    });

  // ---- use / switch ----------------------------------------------------
  program
    .command("use <label>")
    .alias("switch")
    .description("Make a saved account the active Claude credentials")
    .action(async (label: string) => {
      try {
        await switchTo(label, "manual");
      } catch (e) {
        fail((e as Error).message);
        process.exitCode = 1;
        return;
      }
      const meta = (await vault.list()).find((m) => m.label === label);
      ok(
        `Switched to ${c.bold(label)}` +
          (meta?.email ? ` (${meta.email})` : "") +
          `.`
      );
      if (meta?.expiresAt && meta.expiresAt < Date.now()) {
        warn(
          "This account's access token looks expired — Claude Code will refresh " +
            "it on next run. Run `pcc sync` afterwards to store the new token."
        );
      }
      console.log(
        c.dim(
          "  Note: a Claude session already running won't pick this up — start a\n" +
            "  new one, or resume the same conversation with `claude -c` / `--resume`."
        )
      );
    });

  // ---- remove ----------------------------------------------------------
  program
    .command("remove <label>")
    .alias("rm")
    .description("Delete a saved account from the vault")
    .action(async (label: string) => {
      try {
        await vault.remove(label);
        ok(`Removed ${c.bold(label)} from the vault.`);
      } catch (e) {
        fail((e as Error).message);
        process.exitCode = 1;
      }
    });

  // ---- status / whoami -------------------------------------------------
  program
    .command("status")
    .alias("whoami")
    .description("Show the active account (vault + live Claude auth)")
    .action(async () => {
      const data = await vault.load();
      const live = authStatus();
      console.log(
        `  Vault active: ${
          data.activeLabel ? c.green(data.activeLabel) : c.dim("none")
        }`
      );
      if (live?.loggedIn) {
        console.log(
          `  Claude Code:  ${c.bold(live.email ?? "?")}  ` +
            c.dim(`[${live.subscriptionType ?? "?"}]`)
        );
        if (live.orgName) console.log(c.dim(`  Org: ${live.orgName}`));
      } else {
        warn("Claude Code reports no active login.");
      }
    });

  // ---- sync ------------------------------------------------------------
  program
    .command("sync")
    .description(
      "Re-capture the active credentials into the active label (persists refreshed tokens)"
    )
    .action(async () => {
      const data = await vault.load();
      if (!data.activeLabel) {
        warn("No active label set. Use `pcc use <label>` first.");
        return;
      }
      const creds = await credentials.readActive();
      if (!creds) {
        fail("No active credentials to sync.");
        process.exitCode = 1;
        return;
      }
      const status = authStatus();
      await vault.upsert(data.activeLabel, creds, {
        email: status?.email,
        orgId: status?.orgId,
        orgName: status?.orgName,
        subscriptionType:
          status?.subscriptionType ?? creds.claudeAiOauth.subscriptionType,
        rateLimitTier: creds.claudeAiOauth.rateLimitTier,
        expiresAt: creds.claudeAiOauth.expiresAt,
      });
      ok(`Synced latest tokens into ${c.bold(data.activeLabel)}.`);
    });
}
