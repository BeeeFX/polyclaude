import React from "react";
import { render } from "ink";
import { spawn } from "node:child_process";
import { App, type DashboardResult } from "./app.js";
import * as settings from "../core/settings.js";
import * as login from "../core/login.js";
import { resolveClaudeBin } from "../core/claude.js";

/**
 * Hand the keyboard fully to a child process. After Ink, polyclaude's own stdin
 * is in raw/flowing mode with listeners attached — if we leave it that way the
 * PARENT keeps reading stdin and steals the child's keystrokes, so the child
 * (Claude's trust dialog, login prompt, etc.) appears frozen. So we detach our
 * listeners, drop raw mode, and pause our stdin so the child fully owns it.
 */
function releaseStdinToChild(): void {
  try {
    const stdin = process.stdin;
    if (stdin.isTTY && stdin.setRawMode) stdin.setRawMode(false);
    stdin.removeAllListeners("data");
    stdin.removeAllListeners("readable");
    stdin.removeAllListeners("keypress");
    stdin.pause();
  } catch {
    /* ignore */
  }
}

function spawnInteractive(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<void> {
  releaseStdinToChild();
  return new Promise((resolve) => {
    const child = spawn(resolveClaudeBin(), args, { stdio: "inherit", env, cwd });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

/**
 * The dashboard renders in a loop. Actions that don't touch the terminal (like
 * importing the current account) return to the dashboard. Actions that hand the
 * terminal to a child process (launch / resume Claude, browser sign-in) release
 * stdin to that child and then EXIT cleanly — re-rendering Ink after a child can
 * leave input frozen on Windows, so we let the user reopen with `pcc` instead.
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

    if (result.action === "import") {
      await login.addAccountInteractive("import"); // no child process — safe to loop
      continue;
    }

    if (result.action === "launch") {
      const s = await settings.load();
      const args: string[] = [];
      if (s.model) args.push("--model", s.model);
      if (s.effort) args.push("--effort", s.effort);
      const env = { ...process.env };
      if (s.thinking) env.MAX_THINKING_TOKENS = String(s.thinkingBudget);
      await spawnInteractive(args, env, result.cwd);
      continue; // Claude exited → return to the dashboard
    }
    if (result.action === "resume" && result.resumeId) {
      await spawnInteractive(["--resume", result.resumeId], { ...process.env }, result.cwd);
      continue; // Claude exited → return to the dashboard
    }
    if (result.action === "login") {
      releaseStdinToChild();
      await login.addAccountInteractive("login");
      console.log("\nReopen the dashboard with:  pcc\n");
      break;
    }
    break; // quit
  }
}
