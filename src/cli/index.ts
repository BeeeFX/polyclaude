#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { registerAccountCommands } from "./commands/account.js";
import { registerUsageCommands } from "./commands/usage.js";
import { registerConfigCommands } from "./commands/config.js";
import { registerRunCommands } from "./commands/run.js";
import { registerConversationCommands } from "./commands/conversations.js";
import { registerStatuslineCommand } from "./commands/statusline.js";
import { isSupported } from "../core/crypto.js";
import { fail } from "./format.js";

// Single source of truth for the version: package.json (../../ from dist/cli).
function pkgVersion(): string {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("polyclaude")
  .description(
    "Multi-account manager and seamless session switcher for Claude Code.\n" +
      "Store several logged-in accounts, watch usage, switch with one key, and\n" +
      "auto-fail-over when an account hits its limit. Run with no command for the dashboard."
  )
  .version(pkgVersion());

registerAccountCommands(program);
registerUsageCommands(program);
registerConfigCommands(program);
registerRunCommands(program);
registerConversationCommands(program);
registerStatuslineCommand(program);

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
  fail(`polyclaude doesn't support ${process.platform} yet (no at-rest credential store).`);
  process.exit(1);
}

program.parseAsync(process.argv).catch((e) => {
  fail(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
