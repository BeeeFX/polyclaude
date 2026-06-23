import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * Unit smoke test for the status-line rendering + install/uninstall logic.
 * Points POLYCLAUDE_DIR / CLAUDE_CONFIG_DIR at a throwaway temp dir BEFORE
 * importing the modules (paths.ts reads those envs at load), so we exercise an
 * empty vault and a clean settings.json without touching the real ones.
 * Run with: npm run test:statusline
 */
async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pcc-sl-"));
  process.env.POLYCLAUDE_DIR = path.join(tmp, "poly"); // empty → no accounts
  process.env.CLAUDE_CONFIG_DIR = path.join(tmp, "claude"); // isolated settings.json
  delete process.env.POLYCLAUDE_HOST;

  const sl = await import("../src/cli/commands/statusline.js");
  const core = await import("../src/core/statusline.js");
  const settingsFile = path.join(process.env.CLAUDE_CONFIG_DIR, "settings.json");
  const foreign = JSON.stringify({ statusLine: { type: "command", command: "my-custom-line" } }, null, 2);

  const checks: Array<[string, boolean]> = [];

  // renderHint — adapts to how Claude was launched
  delete process.env.POLYCLAUDE_HOST;
  checks.push(["hint (direct) says 'run polyclaude'", sl.renderHint("work", 10).includes("run polyclaude → g")]);
  process.env.POLYCLAUDE_HOST = "1";
  checks.push(["hint (hosted) says 'press g'", sl.renderHint("work", 10).includes("press g")]);
  delete process.env.POLYCLAUDE_HOST;
  const warned = sl.renderHint("work", 92);
  checks.push(["hint ≥85 warns + names account", warned.includes("near limit") && warned.includes("work")]);

  // renderLine — empty vault renders nothing (suppresses the bar cleanly)
  checks.push(["renderLine empty vault → ''", (await sl.renderLine()) === ""]);

  // install / uninstall lifecycle
  checks.push(["not installed initially", (await core.isInstalled()) === false]);
  checks.push(["install succeeds", (await core.install()).ok === true]);
  checks.push(["isInstalled after install", (await core.isInstalled()) === true]);

  await fs.writeFile(settingsFile, foreign);
  const blocked = await core.install();
  checks.push(["refuses to clobber foreign", blocked.ok === false && blocked.reason === "foreign-exists"]);
  checks.push(["--force overwrites foreign", (await core.install({ force: true })).ok === true]);

  const un = await core.uninstall();
  checks.push(["uninstall removes ours", un.ok === true && un.removed === true]);
  checks.push(["not installed after uninstall", (await core.isInstalled()) === false]);

  await fs.writeFile(settingsFile, foreign);
  const unForeign = await core.uninstall();
  checks.push(["uninstall leaves foreign untouched", unForeign.removed === false && unForeign.foreign === true]);

  await fs.rm(tmp, { recursive: true, force: true });

  let okAll = true;
  for (const [name, ok] of checks) {
    okAll = okAll && ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(okAll ? "\nstatusline: OK" : "\nstatusline: FAILED");
  process.exit(okAll ? 0 : 1);
}

void main();
