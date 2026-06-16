import type { Command } from "commander";
import { spawn } from "node:child_process";
import path from "node:path";
import * as conversations from "../../core/conversations.js";
import { resolveClaudeBin } from "../../core/claude.js";
import { c, cell, fmtAgo, warn } from "../format.js";

export function registerConversationCommands(program: Command): void {
  program
    .command("conversations")
    .alias("history")
    .description("List your recent Claude Code conversations (resumable)")
    .option("-n, --limit <n>", "how many to show", "20")
    .action(async (opts: { limit?: string }) => {
      const convos = await conversations.list(Number(opts.limit) || 20);
      if (!convos.length) {
        warn("No past conversations found yet.");
        return;
      }
      console.log(c.bold("\n  Recent conversations\n"));
      convos.forEach((cv, i) => {
        console.log(
          "  " +
            c.dim(`${String(i + 1).padStart(2)}.`) +
            " " +
            cell(cv.title, 50) +
            c.dim(cell(fmtAgo(cv.mtime), 10) + cell(path.basename(cv.cwd ?? cv.project), 18))
        );
        console.log("      " + c.dim(`${cv.sessionId}  ·  ${cv.messages} msgs`));
      });
      console.log(
        c.dim("\n  Continue one with:  pcc resume <id>   (or `pcc resume` for the latest)\n")
      );
    });

  program
    .command("resume [sessionId]")
    .description("Resume a past conversation on the active account (latest if no id given)")
    .action(async (sessionId?: string) => {
      let cwd: string | undefined;
      if (!sessionId) {
        const [latest] = await conversations.list(1);
        if (!latest) {
          warn("No conversations to resume.");
          return;
        }
        sessionId = latest.sessionId;
        cwd = latest.cwd;
      } else {
        const all = await conversations.list(200);
        const match = all.find((x) => x.sessionId === sessionId || x.sessionId.startsWith(sessionId!));
        if (match) {
          sessionId = match.sessionId;
          cwd = match.cwd;
        }
      }
      const child = spawn(resolveClaudeBin(), ["--resume", sessionId], { stdio: "inherit", cwd });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
