import type { Command } from "commander";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as readline from "node:readline";
import * as runner from "../../core/runner.js";
import * as settings from "../../core/settings.js";
import * as vault from "../../core/vault.js";
import * as liveusage from "../../core/liveusage.js";
import { resolveClaudeBin } from "../../core/claude.js";
import { c, ok, warn, fail, human, fmtUntil } from "../format.js";
import type { RateLimitInfo } from "../../types.js";

/** Print a compact live plan-usage line (current session + weekly %). */
async function showUsage(): Promise<void> {
  const u = await liveusage.fetchActive().catch(() => null);
  if (!u || u.fiveHourPct == null) return;
  const tint = (p: number) => (p >= 90 ? c.red : p >= 75 ? c.yellow : c.green);
  const five = Math.round(u.fiveHourPct);
  const seven = Math.round(u.sevenDayPct ?? 0);
  console.log(
    c.dim("  plan usage: ") +
      tint(five)(`${five}% session`) +
      c.dim("  ·  ") +
      tint(seven)(`${seven}% weekly`)
  );
}

function summarizeRL(rl: Record<string, RateLimitInfo>): string {
  return (
    Object.values(rl)
      .map((r) => {
        const name = (r.rateLimitType ?? "window").replace("_", "-");
        if (r.status !== "allowed") return c.red(`${name}: LIMITED`);
        return `${name}: ${c.green("ok")}${r.resetsAt ? c.dim(` (resets ${fmtUntil(r.resetsAt * 1000)})`) : ""}`;
      })
      .join("  ") || "no data"
  );
}

async function runOpts() {
  const s = await settings.load();
  return {
    model: s.model || undefined,
    effort: settings.supportsEffort(s.model) ? s.effort || undefined : undefined,
    thinking: s.thinking,
    thinkingBudget: s.thinkingBudget,
  };
}

export function registerRunCommands(program: Command): void {
  // ---- ask: one-shot with auto-failover ---------------------------------
  program
    .command("ask <prompt...>")
    .description("Send one prompt; auto-switch accounts if the active one is rate-limited")
    .action(async (promptParts: string[]) => {
      const prompt = promptParts.join(" ");
      const base = await runOpts();
      process.stdout.write(c.dim("…thinking\n"));
      const res = await runner.runWithFailover(prompt, {
        ...base,
        onSwitch: (label, reason) =>
          warn(`${reason === "auto" ? "Limit hit — switched" : "Switched"} to ${c.bold(label)}`),
      });
      if (res.switched.length) console.log();
      if (res.ok) {
        console.log(res.text + "\n");
        console.log(
          c.dim(
            `  ↳ ${c.green(res.account)}` +
              (res.usage
                ? ` · ${human(res.usage.input + res.usage.cacheRead + res.usage.cacheCreate)} in / ${human(res.usage.output)} out`
                : "")
          )
        );
        await showUsage();
      } else {
        fail(res.error ?? "Request failed.");
        if (res.exhausted.length)
          warn(`Accounts that hit a limit: ${res.exhausted.join(", ")}`);
        process.exitCode = 1;
      }
    });

  // ---- chat: multi-turn REPL with auto-failover -------------------------
  program
    .command("chat")
    .description("Interactive chat that keeps context and auto-switches accounts on limits")
    .action(async () => {
      const base = await runOpts();
      const sessionId = randomUUID();
      let started = false;
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(
        c.bold("\n  polyclaude chat") +
          c.dim("  — context is preserved across account switches. Ctrl-C to exit.\n")
      );
      const ask = () =>
        rl.question(c.cyan("you ▸ "), async (line) => {
          const prompt = line.trim();
          if (!prompt) return ask();
          if (/^(exit|quit)$/i.test(prompt)) return rl.close();
          const res = await runner.runWithFailover(prompt, {
            ...base,
            sessionId,
            resume: started,
            onSwitch: (label, reason) =>
              warn(`${reason === "auto" ? "Limit hit — switched" : "Switched"} to ${c.bold(label)}`),
          });
          started = true;
          if (res.ok) {
            console.log(c.green("\nclaude ▸ ") + res.text + "\n" + c.dim(`  ↳ ${res.account}`));
            await showUsage();
            console.log();
          } else {
            fail(res.error ?? "Request failed.");
            if (res.exhausted.length) warn(`All tried accounts limited: ${res.exhausted.join(", ")}`);
          }
          ask();
        });
      ask();
    });

  // ---- probe: refresh the active account's live rate-limit status -------
  program
    .command("probe")
    .description("Make a tiny call on the active account to refresh its live rate-limit status")
    .action(async () => {
      const data = await vault.load();
      if (!data.activeLabel) {
        warn("No active account. Use `pcc use <label>` first.");
        return;
      }
      process.stdout.write(c.dim("probing…\n"));
      const res = await runner.runOnce("hi", { model: "haiku" });
      if (res.rateLimits) {
        await vault.updateMeta(data.activeLabel, {
          rateLimits: res.rateLimits,
          rateLimitsAt: Date.now(),
        });
        ok(`${c.bold(data.activeLabel)} — ${summarizeRL(res.rateLimits)}`);
      } else if (res.limited) {
        warn(`${c.bold(data.activeLabel)} appears rate-limited.`);
      } else {
        warn("No rate-limit info returned (try again).");
      }
    });

  // ---- launch: interactive Claude Code with saved settings --------------
  program
    .command("launch")
    .alias("code")
    .description("Launch interactive Claude Code with the active account + your saved model/effort/thinking")
    .option("-c, --continue", "resume the most recent conversation in this directory")
    .allowUnknownOption(true)
    .argument("[extraArgs...]")
    .action(async (extraArgs: string[], opts: { continue?: boolean }) => {
      const s = await settings.load();
      const args: string[] = [];
      if (opts.continue) args.push("-c");
      if (s.model) args.push("--model", s.model);
      const effort = settings.supportsEffort(s.model) ? s.effort : "";
      if (effort) args.push("--effort", effort);
      args.push(...(extraArgs ?? []));
      const env = { ...process.env };
      if (s.thinking) env.MAX_THINKING_TOKENS = String(s.thinkingBudget);
      ok(`Launching Claude Code${s.model ? ` (${s.model}${effort ? `, ${effort}` : ""})` : ""}…\n`);
      const child = spawn(resolveClaudeBin(), args, { stdio: "inherit", env });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
