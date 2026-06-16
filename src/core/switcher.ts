import * as vault from "./vault.js";
import * as credentials from "./credentials.js";
import * as switchlog from "./switchlog.js";
import * as crypto from "./crypto.js";

/**
 * Make a saved account the active Claude Code credentials.
 *
 * Before overwriting the live credentials, we make sure the account currently
 * signed in is captured in the (encrypted) vault — so a switch can never lose an
 * account, even one you logged into directly with `claude auth login`. There are
 * no plaintext backups; everything stays in the DPAPI-encrypted vault.
 */
export async function switchTo(
  label: string,
  reason: "manual" | "auto" | "add" = "manual"
): Promise<void> {
  await preserveCurrentAccount();
  const creds = await vault.getCredentials(label);
  await credentials.writeActive(creds);
  await vault.setActive(label);
  await switchlog.record(label, reason);
}

/** If the live active credentials aren't the ones the vault tracks as active,
 *  capture them into the vault (encrypted) so switching away won't lose them. */
async function preserveCurrentAccount(): Promise<void> {
  const live = await credentials.readActive();
  if (!live) return;

  const data = await vault.load();
  const activeEntry = data.activeLabel ? data.accounts[data.activeLabel] : undefined;
  if (activeEntry) {
    try {
      const stored = JSON.parse(crypto.decrypt(activeEntry.secret)) as {
        claudeAiOauth?: { refreshToken?: string };
      };
      // Already saved as the active account → nothing to preserve.
      if (stored?.claudeAiOauth?.refreshToken === live.claudeAiOauth.refreshToken) return;
    } catch {
      /* fall through and capture */
    }
  }

  // The live account isn't tracked → save/update it (de-duped by identity).
  const login = await import("./login.js");
  await login.captureActive({ primeUsage: false }).catch(() => {});
}
