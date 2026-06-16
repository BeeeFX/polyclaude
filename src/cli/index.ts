#!/usr/bin/env node
import { Command } from "commander";
import { registerAccountCommands } from "./commands/account.js";
import { registerUsageCommands } from "./commands/usage.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerRunCommands } from "./commands/run.js";
import { registerConversationCommands } from "./commands/conversations.js";
import { isSupported } from "../core/crypto.js";
import { fail } from "./format.js";

const program = new Command();

program
  .name("polyclaude")
  .description(
    "Multi-account manager and seamless session switcher for Claude Code.\n" +
      "Store several logged-in accounts, watch usage, switch with one key, and\n" +
      "auto-fail-over when an account hits its limit. Run with no command for the dashboard."
  )
  .version("0.1.0");

registerAccountCommands(program);
registerUsageCommands(program);
registerConfigCommands(program);
registerRunCommands(program);
registerConversationCommands(program);

program
  .command("dashboard")
  .alias("ui")
  .description("Open the interactive dashboard (default when no command is given)")
  .action(async () => {
    const { runDashboard } = await import("../tui/index.js");
    await runDashboard();
  });

// Bare `pcc` → dashboard.
program.action(async () => {
  const { runDashboard } = await import("../tui/index.js");
  await runDashboard();
});

if (!isSupported()) {
  fail("polyclaude currently requires Windows (uses DPAPI for at-rest credential encryption).");
  process.exit(1);
}

program.parseAsync(process.argv).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
