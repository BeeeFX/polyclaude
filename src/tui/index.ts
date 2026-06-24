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
 * The dashboard renders in a loop. Launch / resume Claude run it as a child and
 * then loop back to the dashboard when Claude exits, so polyclaude stays the hub
 * (this is why the status-line hint can just say "exit Claude → press g"). Only
 * the browser sign-in (`login`) exits cleanly afterwards — re-rendering Ink after
 * that flow can leave input frozen on Windows, so we let the user reopen with `pcc`.
 *
 * Claude is spawned with POLYCLAUDE_HOST set so the status line (a grandchild via
 * Claude) knows it was launched from polyclaude and tailors its switch-account hint.
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
      if (s.effort && settings.supportsEffort(s.model)) args.push("--effort", s.effort);
      const env: NodeJS.ProcessEnv = { ...process.env, POLYCLAUDE_HOST: "1" };
      if (s.thinking) env.MAX_THINKING_TOKENS = String(s.thinkingBudget);
      await spawnInteractive(args, env, result.cwd);
      continue; // Claude exited → return to the dashboard
    }
    if (result.action === "resume" && result.resumeId) {
      await spawnInteractive(["--resume", result.resumeId], { ...process.env, POLYCLAUDE_HOST: "1" }, result.cwd);
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
