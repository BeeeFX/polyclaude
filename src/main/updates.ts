import { app, shell } from "electron";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Per-platform update strategy:
 *   - Windows / Linux: real silent auto-update via electron-updater (downloads the
 *     new build and relaunches into it — no manual re-download). Works unsigned.
 *   - macOS: notify-only. Squirrel refuses to update an unsigned app, so we just
 *     check GitHub and let the UI open the Releases page for a manual download.
 *
 * Everything degrades to "null / no banner" on failure (offline, dev, no release).
 */

const AUTO = process.platform === "win32" || process.platform === "linux";

export interface UpdateInfo {
  mode: "auto" | "notify";
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

function releasesUrl(): string {
  const slug = repoSlug();
  return slug ? `https://github.com/${slug}/releases/latest` : "https://github.com";
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

/** macOS / fallback path: ask GitHub's API for the latest published release. */
async function githubLatest(current: string): Promise<{ latest: string; newer: boolean } | null> {
  const slug = repoSlug();
  if (!slug) return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `polyclaude/${current}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const rel = (await res.json()) as { tag_name?: string };
    const latest = (rel.tag_name ?? "").replace(/^v/, "");
    if (!latest) return null;
    return { latest, newer: cmpVersion(latest, current) > 0 };
  } catch {
    return null;
  }
}

// electron-updater is CommonJS; grab the singleton through interop.
async function loadUpdater(): Promise<import("electron-updater").AppUpdater> {
  const mod = (await import("electron-updater")) as unknown as {
    autoUpdater?: import("electron-updater").AppUpdater;
    default?: { autoUpdater?: import("electron-updater").AppUpdater };
  };
  const au = mod.autoUpdater ?? mod.default?.autoUpdater;
  if (!au) throw new Error("electron-updater unavailable");
  return au;
}

export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const current = app.getVersion();
  const url = releasesUrl();

  // Windows / Linux packaged → electron-updater (it reads latest*.yml from the release).
  if (AUTO && app.isPackaged) {
    try {
      const autoUpdater = await loadUpdater();
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      const res = await autoUpdater.checkForUpdates();
      const latest = res?.updateInfo?.version ?? current;
      return { mode: "auto", current, latest, url, newer: cmpVersion(latest, current) > 0 };
    } catch {
      /* fall through to notify */
    }
  }

  // macOS, dev, or a failed auto-check → notify-only via the GitHub API.
  const gh = await githubLatest(current);
  if (!gh) return null;
  return { mode: "notify", current, latest: gh.latest, url, newer: gh.newer };
}

/**
 * Auto-update path (Windows/Linux): download the pending update, then relaunch
 * into it. Resolves with an error message if the download fails so the UI can
 * fall back to a manual download. On success the app quits and reopens.
 */
export async function downloadAndInstall(): Promise<{ ok: boolean; error?: string }> {
  try {
    const autoUpdater = await loadUpdater();
    await autoUpdater.downloadUpdate(); // resolves once the file is downloaded
    setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export async function openRelease(url: string): Promise<void> {
  await shell.openExternal(url);
}
