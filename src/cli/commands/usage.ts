import type { Command } from "commander";
import * as liveusage from "../../core/liveusage.js";
import * as vault from "../../core/vault.js";
import type { AccountUsage } from "../../types.js";
import { c, bar, cell, fmtResetIn, fmtResetAt, warn } from "../format.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function colorFor(pct?: number | null) {
  if (pct == null) return c.gray;
  if (pct >= 90) return c.red;
  if (pct >= 75) return c.yellow;
  return c.green;
}

function usageLine(title: string, pct: number | null | undefined, reset: string): void {
  const color = colorFor(pct);
  const used = pct == null ? "—" : `${Math.round(pct)}% used`;
  console.log(`  ${cell(title, 21)}${color(bar((pct ?? 0) / 100, 26))} ${color(used)}`);
  if (reset) console.log(`  ${" ".repeat(21)}${c.dim(reset)}`);
}

function printPanel(usage: AccountUsage): void {
  if (usage.error) {
    warn(`couldn't load usage (${usage.error})`);
    return;
  }
  usageLine(
    "Current session",
    usage.fiveHourPct,
    usage.fiveHourResetsAt ? `Resets in ${fmtResetIn(usage.fiveHourResetsAt)}` : ""
  );
  console.log();
  usageLine(
    "Weekly · all models",
    usage.sevenDayPct,
    usage.sevenDayResetsAt ? `Resets ${fmtResetAt(usage.sevenDayResetsAt)}` : ""
  );
}

export function registerUsageCommands(program: Command): void {
  program
    .command("usage")
    .description("Show real plan usage (current session + weekly), like Claude's /usage")
    .option("--all", "show every saved account")
    .option("--watch", "refresh every 10 seconds until Ctrl-C")
    .option("--json", "output raw JSON")
    .action(async (opts: { all?: boolean; watch?: boolean; json?: boolean }) => {
      const run = async () => {
        if (opts.all) {
          const all = await liveusage.fetchAll();
          if (opts.json) {
            console.log(JSON.stringify(all, null, 2));
            return;
          }
          const labels = (await vault.list()).map((m) => m.label);
          if (!labels.length) {
            warn("No accounts yet — add one with `pcc add <label>`.");
            return;
          }
          console.log(c.bold("\n  Plan usage — all accounts\n"));
          console.log(c.dim("  " + cell("ACCOUNT", 16) + cell("SESSION (5h)", 16) + "WEEKLY (7d)"));
          for (const l of labels) {
            const u = all[l];
            const s = u?.error ? c.red("error") : u?.fiveHourPct == null ? "—" : `${Math.round(u.fiveHourPct)}%`;
            const w = u?.error ? "" : u?.sevenDayPct == null ? "—" : `${Math.round(u.sevenDayPct)}%`;
            console.log("  " + cell(l, 16) + cell(s, 16) + w);
          }
          console.log();
        } else {
          const u = await liveusage.fetchActive();
          if (!u) {
            warn("No active account. Use `pcc use <label>` first.");
            return;
          }
          if (opts.json) {
            console.log(JSON.stringify(u, null, 2));
            return;
          }
          const data = await vault.load();
          console.log(c.bold(`\n  Plan usage — ${c.green(data.activeLabel ?? "active")}\n`));
          printPanel(u);
          console.log(c.dim(`\n  Updated just now.\n`));
        }
      };

      if (opts.watch) {
        // eslint-disable-next-line no-constant-condition
        for (;;) {
          process.stdout.write("\x1b[2J\x1b[H"); // clear screen
          await run();
          console.log(c.dim("  watching — Ctrl-C to stop"));
          await sleep(10_000);
        }
      } else {
        await run();
      }
    });
}
