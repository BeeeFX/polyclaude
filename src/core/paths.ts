import os from "node:os";
import path from "node:path";

export const HOME = os.homedir();

/** Where Claude Code keeps its config + active credentials. */
export const CLAUDE_DIR =
  process.env.CLAUDE_CONFIG_DIR ?? path.join(HOME, ".claude");

/** The single "active account" credential file Claude Code reads at startup. */
export const ACTIVE_CREDENTIALS = path.join(CLAUDE_DIR, ".credentials.json");

/** polyclaude's own state directory. */
export const POLY_DIR =
  process.env.POLYCLAUDE_DIR ?? path.join(HOME, ".polyclaude");

export const VAULT_FILE = path.join(POLY_DIR, "vault.json");
