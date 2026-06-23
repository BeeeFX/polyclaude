import type { Command } from "commander";
import * as vault from "../../core/vault.js";
import * as liveusage from "../../core/liveusage.js";
import * as statusline from "../../core/statusline.js";
import { c, ok, warn, fail } from "../format.js";

/**
 * A status line for Claude Code. Claude runs the configured `statusLine` command
 * and shows its stdout at the bottom of its UI — so this lets you watch every
 * account's usage WHILE you're working in Claude.
 *
 * Add it with `polyclaude statusline --install` (remove with `--uninstall`), or
 * by hand in ~/.claude/settings.json:
 *   "statusLine": { "type": "command", "command": "polyclaude statusline" }
 *
 * Install/detect/remove logic lives in core/statusline.ts (shared with the TUI's
 * first-run offer); this file owns the rendering and the CLI wiring.
 */

// Raw ANSI so colors show even though Claude runs us without a TTY.
const A = (s: string, code: string) => `\x1b[${code}m${s}\x1b[0m`;

function tintPct(pct?: number | null): string {
  if (pct == null) return A("—", "90");
  const s = `${Math.round(pct)}%`;
  return pct >= 90 ? A(s, "31") : pct >= 75 ? A(s, "33") : A(s, "32");
}

// When the active account is this close to its 5h limit, the hint turns into a
// near-limit warning (matches the dashboard's own ≥85% warning prompt).
const NUDGE_AT = 85;

/** Second status-line row: a reminder of how to switch accounts. The keys act in
 *  polyclaude, not inside Claude (Claude owns the keyboard while you're chatting),
 *  so this is an honest "how to act" hint, not a live hotkey. Exported for tests. */
export function renderHint(activeLabel: string | undefined, activePct?: number | null): string {
  // When Claude was launched from polyclaude (POLYCLAUDE_HOST set, inherited
  // through Claude into this status-line process), exiting Claude drops straight
  // back to the dashboard — so the user just presses `g`. Launched directly,
  // they need to open polyclaude first.
  const exit = "exit Claude (Ctrl+C twice)";
  const flow = process.env.POLYCLAUDE_HOST ? `${exit} → press g` : `${exit} → run polyclaude → g`;
  if (activePct != null && activePct >= NUDGE_AT) {
    const code = activePct >= 90 ? "31" : "33";
    const who = activeLabel ? `${activeLabel} ` : "";
    return `  ${A(`⚠ ${who}near limit — to switch: ${flow}`, code)}`;
  }
  return `  ${A("↳", "35")} ${A(`to switch account: ${flow}`, "90")}`;
}

/** Build the full (two-row) status line. Exported for tests. May throw if the
 *  vault can't be read — callers should use the guarded path below. */
export async function renderLine(): Promise<string> {
  const data = await vault.load();
  if (Object.keys(data.accounts).length === 0) return "";

  // Keep the active account's numbers fresh while in Claude, but throttle hard
  // (at most ~once every 90s) so we never hammer the usage endpoint.
  if (data.activeLabel) {
    const m = data.accounts[data.activeLabel]?.meta;
    const age = m?.usage?.fetchedAt ? Date.now() - m.usage.fetchedAt : Infinity;
    if (age > 90_000) await liveusage.fetchActive().catch(() => {});
  }

  const metas = await vault.list();
  const parts = metas.map((m) => {
    const active = m.label === data.activeLabel;
    const dot = active ? A("●", "32") : A("○", "90");
    const name = active ? A(m.label, "1") : A(m.label, "90");
    return `${dot} ${name} ${tintPct(m.usage?.fiveHourPct)}`;
  });
  let line1 = `${A("polyclaude", "35")} ${parts.join(A(" · ", "90"))}${A("  · 5h", "90")}`;

  // Append the active account's weekly (7d) usage — the window that bites Max
  // users — only for the active account, to keep the line readable.
  const activeMeta = data.activeLabel ? metas.find((m) => m.label === data.activeLabel) : undefined;
  const weekly = activeMeta?.usage?.sevenDayPct;
  if (activeMeta && weekly != null) {
    line1 += `${A(" · ", "90")}${A(`${activeMeta.label} 7d`, "90")} ${tintPct(weekly)}`;
  }

  return `${line1}\n${renderHint(data.activeLabel, activeMeta?.usage?.fiveHourPct)}`;
}

/** Render guarded so a corrupt vault never blanks the status line in Claude:
 *  on any failure we still print the branding + static switch hint. */
async function renderLineSafe(): Promise<string> {
  try {
    return await renderLine();
  } catch {
    return `${A("polyclaude", "35")}\n${renderHint(undefined, null)}`;
  }
}

async function runInstall(force: boolean): Promise<void> {
  const r = await statusline.install({ force });
  if (!r.ok && r.reason === "foreign-exists") {
    warn(`A different status line is already configured in ${r.path}:`);
    console.log(c.dim(`  ${r.existingCommand ?? "(custom command)"}`));
    console.log(c.dim("  Re-run with --force to replace it with polyclaude's."));
    process.exitCode = 1;
    return;
  }
  if (!r.ok) {
    fail(`Couldn't install the status line: ${r.message ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  ok(`Installed the polyclaude status line into ${r.path}.`);
  if (r.pathWarning) {
    warn("`polyclaude` doesn't appear to be on your PATH yet —");
    console.log(c.dim("  Claude Code can't run the status line until it resolves in your shell."));
  }
  console.log(
    c.dim(
      "  Open Claude Code and you'll see every account's usage at the bottom,\n" +
        "  plus a reminder of how to switch accounts mid-chat.\n" +
        "  Remove it any time with:  polyclaude statusline --uninstall"
    )
  );
}

async function runUninstall(): Promise<void> {
  const r = await statusline.uninstall();
  if (!r.ok) {
    fail(`Couldn't update ${r.path}: ${r.message ?? "unknown error"}`);
    process.exitCode = 1;
    return;
  }
  if (r.removed) {
    ok(`Removed the polyclaude status line from ${r.path}.`);
  } else if (r.foreign) {
    warn(`Left the existing (non-polyclaude) status line in ${r.path} untouched.`);
  } else {
    ok("No polyclaude status line was configured; nothing to remove.");
  }
}

export function registerStatuslineCommand(program: Command): void {
  program
    .command("statusline")
    .description("Status line for Claude Code showing every account's usage (use --install to set it up)")
    .option("--install", "add this as your Claude Code status line in ~/.claude/settings.json")
    .option("--uninstall", "remove the polyclaude status line from ~/.claude/settings.json")
    .option("--force", "with --install, overwrite an existing (non-polyclaude) status line")
    .action(async (opts: { install?: boolean; uninstall?: boolean; force?: boolean }) => {
      if (opts.uninstall) return runUninstall();
      if (opts.install) return runInstall(!!opts.force);
      process.stdout.write(await renderLineSafe());
    });
}
