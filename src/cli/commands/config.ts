import type { Command } from "commander";
import * as settings from "../../core/settings.js";
import { c, ok, fail } from "../format.js";

function parseBool(v: string): boolean {
  return /^(on|true|yes|1)$/i.test(v.trim());
}

export function registerConfigCommands(program: Command): void {
  program
    .command("config")
    .description("Show current settings (model, effort, thinking, auto-switch…)")
    .action(async () => {
      const s = await settings.load();
      const row = (k: string, v: string) => console.log(`  ${c.dim(k.padEnd(16))} ${v}`);
      console.log(c.bold("\n  polyclaude settings\n"));
      row("name", s.name || c.dim("(auto)"));
      row("model", s.model || c.dim("(claude default)"));
      row("effort", s.effort || c.dim("(claude default)"));
      row("thinking", s.thinking ? c.green(`on (${s.thinkingBudget} tokens)`) : c.dim("off"));
      row("autoSwitch", s.autoSwitch ? c.green("on") : c.yellow("off"));
      row("switchOrder", s.switchOrder.length ? s.switchOrder.join(" → ") : c.dim("(vault order)"));
      row("budget5h", s.budget5hTokens ? String(s.budget5hTokens) : c.dim("(unset)"));
      row("budget7d", s.budget7dTokens ? String(s.budget7dTokens) : c.dim("(unset)"));
      console.log();
    });

  program
    .command("set <key> <value>")
    .description(
      "Set a setting. Keys: name, model, effort, thinking, autoswitch, thinkingBudget, budget5h, budget7d"
    )
    .action(async (key: string, value: string) => {
      const k = key.toLowerCase();
      try {
        switch (k) {
          case "name":
            await settings.update({ name: value === "default" ? "" : value });
            break;
          case "model":
            await settings.update({ model: value === "default" ? "" : value });
            break;
          case "effort": {
            if (value !== "default" && !settings.EFFORTS.includes(value as settings.Effort))
              throw new Error(`effort must be one of: ${settings.EFFORTS.join(", ")} (or "default")`);
            await settings.update({ effort: value === "default" ? "" : (value as settings.Effort) });
            break;
          }
          case "thinking":
            await settings.update({ thinking: parseBool(value) });
            break;
          case "thinkingbudget":
            await settings.update({ thinkingBudget: Number(value) });
            break;
          case "autoswitch":
            await settings.update({ autoSwitch: parseBool(value) });
            break;
          case "budget5h":
            await settings.update({ budget5hTokens: Number(value) || undefined });
            break;
          case "budget7d":
            await settings.update({ budget7dTokens: Number(value) || undefined });
            break;
          default:
            throw new Error(`Unknown key "${key}".`);
        }
        ok(`Set ${c.bold(k)} = ${c.bold(value)}.`);
      } catch (e) {
        fail((e as Error).message);
        process.exitCode = 1;
      }
    });

  program
    .command("order [labels...]")
    .description("Set the account failover order (no args = clear, use vault order)")
    .action(async (labels: string[]) => {
      await settings.update({ switchOrder: labels ?? [] });
      ok(labels?.length ? `Failover order: ${labels.join(" → ")}` : "Failover order cleared.");
    });
}
