import { app, shell } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Lightweight "update available" check — no auto-updater. Asks GitHub for the
 * latest published release and compares its tag to this build's version. Returns
 * null on any failure (offline, rate-limited, no release yet) so the UI just
 * stays quiet. The renderer shows a dismissible banner when `newer` is true and
 * opens the Releases page in the browser; nothing is downloaded automatically.
 */

export interface UpdateInfo {
  current: string;
  latest: string;
  url: string;
  newer: boolean;
}

/** "owner/repo" parsed from package.json repository.url (no hard-coding). */
function repoSlug(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(app.getAppPath(), "package.json"), "utf8")) as {
      repository?: string | { url?: string };
    };
    const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
    const m = url?.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Compare dotted versions numerically; >0 if a is newer than b. */
function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const slug = repoSlug();
  if (!slug) return null;
  const current = app.getVersion();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `polyclaude/${current}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null; // 404 = no published release yet, 403 = rate-limited, etc.
    const rel = (await res.json()) as { tag_name?: string; html_url?: string };
    const latest = (rel.tag_name ?? "").replace(/^v/, "");
    if (!latest) return null;
    return {
      current,
      latest,
      url: rel.html_url ?? `https://github.com/${slug}/releases/latest`,
      newer: cmpVersion(latest, current) > 0,
    };
  } catch {
    return null; // offline / DNS / abort — stay quiet
  }
}

export async function openRelease(url: string): Promise<void> {
  await shell.openExternal(url);
}
