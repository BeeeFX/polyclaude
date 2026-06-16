import React from "react";
import { render } from "ink";
import { spawn } from "node:child_process";
import { App, type DashboardResult } from "./app.js";
import * as settings from "../core/settings.js";
import * as login from "../core/login.js";
import { resolveClaudeBin } from "../core/claude.js";

/** Put the terminal back into a normal (cooked, resumed) state after Ink, so a
 *  child process inherits sane stdin — otherwise raw mode left by Ink breaks
 *  line input (e.g. `claude auth login`'s paste-the-code prompt hangs). */
function resetStdin(): void {
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false);
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}

function spawnInteractive(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<void> {
  resetStdin();
  return new Promise((resolve) => {
    const child = spawn(resolveClaudeBin(), args, { stdio: "inherit", env, cwd });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

/**
 * The dashboard runs in a loop: render the TUI, and when the user triggers an
 * action that needs the real terminal (sign in, launch/resume Claude Code), we
 * unmount, do it with inherited stdio, then return to the dashboard.
 */
export async function runDashboard(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error("The dashboard needs an interactive terminal (TTY).");
    process.exitCode = 1;
    return;
  }

  for (;;) {
    const result: DashboardResult = {};
    const instance = render(React.createElement(App, { result }));
    await instance.waitUntilExit();

    if (result.action === "launch") {
      const s = await settings.load();
      const args: string[] = [];
      if (s.model) args.push("--model", s.model);
      if (s.effort) args.push("--effort", s.effort);
      const env = { ...process.env };
      if (s.thinking) env.MAX_THINKING_TOKENS = String(s.thinkingBudget);
      await spawnInteractive(args, env, result.cwd);
      continue;
    }
    if (result.action === "resume" && result.resumeId) {
      await spawnInteractive(["--resume", result.resumeId], { ...process.env }, result.cwd);
      continue;
    }
    if (result.action === "login" || result.action === "import") {
      resetStdin();
      const saved = await login.addAccountInteractive(result.action);
      // After a browser sign-in the terminal/stdin can be left in a state where
      // re-rendering Ink freezes input on Windows — so we exit cleanly here and
      // let the user reopen a fresh dashboard rather than loop back into a UI
      // that won't accept keystrokes.
      if (result.action === "login") {
        if (saved) console.log("Open the dashboard again with:  pcc\n");
        break;
      }
      // Import has no child process, so looping back to the dashboard is safe.
      continue;
    }
    break; // quit
  }
}
