import type { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import * as vault from "../../core/vault.js";
import * as liveusage from "../../core/liveusage.js";
import { CLAUDE_DIR } from "../../core/paths.js";
import { c, ok, fail } from "../format.js";

/**
 * A status line for Claude Code. Claude runs the configured `statusLine` command
 * and shows its stdout at the bottom of its UI — so this lets you watch every
 * account's usage WHILE you're working in Claude.
 *
 * Add it with `polyclaude statusline --install`, or by hand in
 * ~/.claude/settings.json:  "statusLine": { "type": "command", "command": "polyclaude statusline" }
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
 *  so this is an honest "how to act" hint, not a live hotkey. */
function renderHint(activeLabel: string | undefined, activePct?: number | null): string {
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

async function renderLine(): Promise<string> {
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
  const usage = `${A("polyclaude", "35")} ${parts.join(A(" · ", "90"))}${A("  · 5h", "90")}`;

  const activePct = data.activeLabel
    ? metas.find((m) => m.label === data.activeLabel)?.usage?.fiveHourPct
    : null;
  return `${usage}\n${renderHint(data.activeLabel, activePct)}`;
}

async function install(): Promise<void> {
  const file = path.join(CLAUDE_DIR, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      fail(`Couldn't read ${file}: ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }
  // refreshInterval keeps usage current while the session is idle (Claude's own
  // event-driven update only fires on assistant messages). Safe to refresh often:
  // renderLine throttles the live fetch to ~90s and otherwise reads cached usage.
  settings.statusLine = { type: "command", command: "polyclaude statusline", refreshInterval: 60 };
  await fs.mkdir(CLAUDE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(settings, null, 2));
  ok(`Installed the polyclaude status line into ${file}.`);
  console.log(
    c.dim(
      "  Open Claude Code and you'll see every account's usage at the bottom,\n" +
        "  plus a reminder of how to switch accounts mid-chat.\n" +
        "  Remove it by deleting the \"statusLine\" key from that file."
    )
  );
}

export function registerStatuslineCommand(program: Command): void {
  program
    .command("statusline")
    .description("Status line for Claude Code showing every account's usage (use --install to set it up)")
    .option("--install", "add this as your Claude Code status line in ~/.claude/settings.json")
    .action(async (opts: { install?: boolean }) => {
      if (opts.install) {
        await install();
        return;
      }
      process.stdout.write(await renderLine());
    });
}
