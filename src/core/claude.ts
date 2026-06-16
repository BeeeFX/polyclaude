import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Auth metadata reported by `claude auth status` (JSON). */
export interface AuthStatus {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  email?: string;
  orgId?: string;
  orgName?: string;
  subscriptionType?: string;
}

let cachedBin: string | undefined;

/** Locate the Claude Code executable. */
export function resolveClaudeBin(): string {
  if (cachedBin !== undefined) return cachedBin;
  const isWin = process.platform === "win32";
  const candidates = [
    process.env.CLAUDE_BIN,
    path.join(os.homedir(), ".local", "bin", isWin ? "claude.exe" : "claude"),
  ].filter(Boolean) as string[];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedBin = c;
      return c;
    }
  }
  cachedBin = isWin ? "claude.exe" : "claude"; // fall back to PATH lookup
  return cachedBin;
}

/** Run `claude auth status` and parse the JSON, or null on failure. */
export function authStatus(): AuthStatus | null {
  const res = spawnSync(resolveClaudeBin(), ["auth", "status"], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout.trim()) as AuthStatus;
  } catch {
    return null;
  }
}
