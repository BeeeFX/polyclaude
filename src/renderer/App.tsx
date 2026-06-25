import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import type { AccountMeta, AccountUsage, CliStatus, Conversation, Settings, TermStartOpts, UpdateInfo } from "./types";
import { ago, cap, level, pctText, resetAt, resetIn } from "./format";
import { TerminalView } from "./Terminal";
import { Mascot } from "./Mascot";

const MODELS: Array<{ value: string; label: string }> = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const EFFORTS: Array<{ value: string; label: string }> = [
  { value: "", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "xhigh", label: "Ultracode (xhigh)" },
  { value: "max", label: "Max" },
];
const USAGE_POLL_MS = 90_000;

/** A usage error that means the login is no longer valid (needs /login), vs a
 *  transient "couldn't refresh" staleness (which auto-resolves). */
function isAuthError(u?: AccountUsage): boolean {
  return !!u?.error && /sign in again|\/login|invalid_grant|invalid_request|unauthor/i.test(u.error);
}

export function App() {
  const [version, setVersion] = useState("");
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<"home" | "claude">("home");
  const [termAvailable, setTermAvailable] = useState(true);
  const [termOpts, setTermOpts] = useState<TermStartOpts>({});
  const [termKey, setTermKey] = useState(0);
  const [sessionLive, setSessionLive] = useState(false);
  const [restarting, setRestarting] = useState<string | null>(null); // label being resumed onto
  const [renaming, setRenaming] = useState<{ label: string; value: string } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const loginSessionRef = useRef(false); // the live terminal session is a sign-in flow
  const [menu, setMenu] = useState<{ x: number; y: number; label: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const dragLabel = useRef<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [cliStatus, setCliStatus] = useState<CliStatus | null>(null);
  const [cliBusy, setCliBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  const reload = useCallback(async () => {
    const [accts, active, s] = await Promise.all([
      window.poly.accounts.list(),
      window.poly.accounts.active(),
      window.poly.settings.get(),
    ]);
    setAccounts(accts);
    setActiveLabel(active);
    setSettings(s);
  }, []);

  const refreshUsage = useCallback(async () => {
    try {
      const all = await window.poly.usage.all();
      setAccounts((prev) => prev.map((a) => (all[a.label] ? { ...a, usage: all[a.label] } : a)));
    } catch {
      /* keep last known */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        if (!window.poly) throw new Error("bridge unavailable (preload failed to load)");
        const info = await window.poly.app.info();
        setVersion(info.version);
        await reload();
        setReady(true);
        void window.poly.conversations.list(6).then(setConvos);
        void window.poly.terminal.available().then(setTermAvailable);
        void window.poly.cli.status().then(setCliStatus);
        void window.poly.updates.check().then(setUpdate);
        void refreshUsage();
      } catch (e) {
        setLoadError((e as Error).message);
      }
    })();
    const id = window.setInterval(refreshUsage, USAGE_POLL_MS);
    return () => window.clearInterval(id);
  }, [reload, refreshUsage]);

  // Safety net: never leave the "switching…" overlay up forever if the resumed
  // session produces no output (e.g. it errored before printing anything).
  useEffect(() => {
    if (!restarting) return;
    const t = window.setTimeout(() => setRestarting(null), 8000);
    return () => window.clearTimeout(t);
  }, [restarting]);

  const active = useMemo(() => accounts.find((a) => a.label === activeLabel), [accounts, activeLabel]);

  // Apply the user's custom sidebar order (labels not in it fall to the end, A→Z).
  const orderedAccounts = useMemo(() => {
    const order = settings?.accountOrder ?? [];
    const rank = (l: string) => {
      const i = order.indexOf(l);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...accounts].sort((a, b) => rank(a.label) - rank(b.label) || a.label.localeCompare(b.label));
  }, [accounts, settings?.accountOrder]);

  const reorder = useCallback(
    (from: string, to: string) => {
      if (from === to) return;
      const labels = orderedAccounts.map((a) => a.label);
      const fi = labels.indexOf(from);
      const ti = labels.indexOf(to);
      if (fi === -1 || ti === -1) return;
      labels.splice(fi, 1);
      labels.splice(ti, 0, from);
      void window.poly.settings.update({ accountOrder: labels }).then(setSettings);
    },
    [orderedAccounts]
  );

  const doDelete = useCallback(
    async (label: string) => {
      setConfirmDelete(null);
      const r = await window.poly.accounts.remove(label);
      if (r.ok) {
        await reload();
        await refreshUsage();
        flash(`Deleted ${label}`);
      } else {
        flash(r.error);
      }
    },
    [reload, refreshUsage, flash]
  );

  const toggleCli = useCallback(async () => {
    setCliBusy(true);
    try {
      if (cliStatus?.installed) {
        const r = await window.poly.cli.uninstall();
        if (r.ok) {
          setCliStatus(await window.poly.cli.status());
          flash("Removed the pcc command");
        } else flash(r.error);
      } else {
        const r = await window.poly.cli.install();
        if (r.ok) {
          setCliStatus(r.status);
          flash(r.status.onPath ? "Installed pcc — open a new terminal" : "Installed pcc (see the note)");
        } else flash(r.error);
      }
    } finally {
      setCliBusy(false);
    }
  }, [cliStatus, flash]);

  // Close the context menu on Escape.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu]);
  const usage = active?.usage;
  const name =
    settings?.name?.trim() ||
    active?.fullName ||
    active?.email?.split("@")[0] ||
    "there";

  const launchClaude = useCallback(
    (opts: TermStartOpts) => {
      if (!termAvailable) {
        if (opts.login) flash("Run `pcc login` in a terminal to sign in (embedded terminal unavailable here).");
        else {
          void window.poly.claude.launch(opts.cwd);
          flash("Opened Claude in your terminal (embedded terminal unavailable here).");
        }
        return;
      }
      loginSessionRef.current = !!opts.login;
      setTermOpts(opts);
      setTermKey((k) => k + 1); // remount = fresh session
      setSessionLive(true);
      setView("claude");
    },
    [termAvailable, flash]
  );

  // When a sign-in terminal session ends, capture the new credentials into the
  // vault (de-duped to the matching account) and refresh.
  const onTermExit = useCallback(() => {
    if (!loginSessionRef.current) return;
    loginSessionRef.current = false;
    void window.poly.accounts.captureActive().then((r) => {
      if (r.ok) {
        void reload();
        void refreshUsage();
        flash(`Signed in${r.email ? ` as ${r.email}` : ""}`);
      } else {
        flash(r.error || "sign-in not completed");
      }
    });
  }, [reload, refreshUsage, flash]);

  /** Re-login an account: opens the browser sign-in in the embedded terminal;
   *  captureActive (on exit) maps the result to the matching account by identity. */
  const relogin = useCallback(() => launchClaude({ login: true }), [launchClaude]);

  const switchTo = useCallback(
    async (label: string) => {
      if (label === activeLabel || switching) return;
      setSwitching(label);
      const r = await window.poly.accounts.switch(label);
      if (r.ok) {
        await reload();
        await refreshUsage();
        if (sessionLive && termAvailable) {
          // Seamless: resume the same conversation on the new account in the
          // background — no manual restart. The TerminalView remount kills the
          // old pty and starts `claude -c`; an overlay covers the swap.
          setRestarting(label);
          launchClaude({ resume: true });
        } else {
          flash(`Switched to ${label}`);
        }
      } else {
        flash(r.error);
      }
      setSwitching(null);
    },
    [activeLabel, switching, reload, refreshUsage, flash, sessionLive, termAvailable, launchClaude]
  );

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.poly.settings.update(patch);
    setSettings(next);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renaming) return;
    const from = renaming.label;
    const to = renaming.value.trim();
    setRenaming(null);
    if (!to || to === from) return;
    const r = await window.poly.accounts.rename(from, to);
    if (r.ok) {
      await reload();
      await refreshUsage();
      flash(`Renamed to ${to}`);
    } else {
      flash(r.error);
    }
  }, [renaming, reload, refreshUsage, flash]);

  if (loadError) {
    return (
      <div className="loading">
        <span style={{ color: "var(--high)", fontWeight: 600 }}>polyclaude couldn't start</span>
        <span className="small" style={{ maxWidth: 420, textAlign: "center" }}>{loadError}</span>
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="loading">
        <div className="mascot-pulse">
          <Mascot size={48} />
        </div>
        <span>polyclaude</span>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">
            <Mascot size={22} />
          </span>
          <span className="word">polyclaude</span>
          <span className="ver">v{version}</span>
        </div>

        <div className="acct-list">
          {orderedAccounts.map((a) => (
            <AccountRow
              key={a.label}
              account={a}
              active={a.label === activeLabel}
              switching={switching === a.label}
              disabled={!!switching || !!renaming}
              renameValue={renaming?.label === a.label ? renaming.value : null}
              dragOver={dragOver === a.label}
              onClick={() => void switchTo(a.label)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, label: a.label });
              }}
              onStartRename={() => setRenaming({ label: a.label, value: a.label })}
              onRenameChange={(v) => setRenaming((r) => (r ? { ...r, value: v } : r))}
              onRenameCommit={() => void commitRename()}
              onRenameCancel={() => setRenaming(null)}
              onRelogin={() => relogin()}
              onDragStartRow={() => (dragLabel.current = a.label)}
              onDragOverRow={() => dragOver !== a.label && setDragOver(a.label)}
              onDropRow={() => {
                if (dragLabel.current) reorder(dragLabel.current, a.label);
                dragLabel.current = null;
                setDragOver(null);
              }}
              onDragEndRow={() => {
                dragLabel.current = null;
                setDragOver(null);
              }}
            />
          ))}
        </div>

        <button className="add-acct" onClick={() => launchClaude({ login: true })}>
          + Add account
        </button>
      </aside>

      <main className="main">
        {update?.newer && !updateDismissed && (
          <div className="update-bar">
            <span className="update-msg">
              <span className="update-dot">⬆</span> polyclaude <b>{update.latest}</b> is available
              <span className="muted"> — you have {update.current}.</span>
            </span>
            <span className="update-actions">
              <button className="ghost accent" onClick={() => void window.poly.updates.open(update.url)}>
                Download
              </button>
              <button className="update-x" title="Dismiss" onClick={() => setUpdateDismissed(true)}>
                ✕
              </button>
            </span>
          </div>
        )}
        <header className="topbar">
          <div className="hello">
            <h1>Welcome back, {name}</h1>
            <p className="sub">
              {active?.email ?? "no active account"}
              {active?.subscriptionType ? ` · Claude ${cap(active.subscriptionType)}` : ""}
            </p>
            {isAuthError(usage) ? (
              <button className="auth-chip" onClick={() => relogin()} title="Sign in again (opens the browser)">
                ⚠ {usage?.error ?? "sign in again"} — click to re-login
              </button>
            ) : usage?.stale ? (
              <button
                className="stale-chip"
                onClick={() => relogin()}
                title={`Last updated ${ago(usage.fetchedAt)} · click to re-login`}
              >
                ⟳ {usage?.error ?? "usage stale"} — click to re-login
              </button>
            ) : null}
          </div>
          <div className="top-actions">
            <Dropdown
              label="Model"
              value={settings?.model ?? ""}
              options={MODELS}
              onChange={(v) => void patchSettings({ model: v })}
            />
            <button className="primary" onClick={() => launchClaude({})}>
              Launch Claude →
            </button>
          </div>
        </header>

        <div className="tabs">
          <button className={`tab ${view === "home" ? "on" : ""}`} onClick={() => setView("home")}>
            Home
          </button>
          <button
            className={`tab ${view === "claude" ? "on" : ""}`}
            onClick={() => sessionLive && setView("claude")}
            disabled={!sessionLive}
          >
            Claude {sessionLive ? <span className="live-dot" /> : null}
          </button>
        </div>

        {/* Home pane (hidden, not unmounted, so a running session survives a peek) */}
        <div className="pane home-pane" style={{ display: view === "home" ? "flex" : "none" }}>
          <section className="cards">
            <UsageCard
              title="Current session"
              sub="5-hour window"
              pct={usage?.fiveHourPct}
              reset={resetIn(usage?.fiveHourResetsAt)}
              error={usage?.error}
              stale={usage?.stale}
              delay={0}
            />
            <UsageCard
              title="Weekly"
              sub="all models · 7-day"
              pct={usage?.sevenDayPct}
              reset={resetAt(usage?.sevenDayResetsAt)}
              error={usage?.error}
              stale={usage?.stale}
              delay={70}
            />
          </section>

          <section className="panel controls" style={{ animationDelay: "140ms" }}>
            <div className="panel-head">Session defaults</div>
            <div className="control-row">
              <Dropdown
                label="Model"
                value={settings?.model ?? ""}
                options={MODELS}
                onChange={(v) => void patchSettings({ model: v })}
              />
              <Dropdown
                label={settings?.model === "haiku" ? "Effort (n/a for Haiku)" : "Effort"}
                value={settings?.effort ?? ""}
                options={EFFORTS}
                disabled={settings?.model === "haiku"}
                onChange={(v) => void patchSettings({ effort: v as Settings["effort"] })}
              />
              <Toggle label="Extended thinking" on={!!settings?.thinking} onClick={() => void patchSettings({ thinking: !settings?.thinking })} />
              <Toggle label="Auto-switch on limit" on={!!settings?.autoSwitch} onClick={() => void patchSettings({ autoSwitch: !settings?.autoSwitch })} />
            </div>
          </section>

          {cliStatus && (
            <section className="panel cli-panel" style={{ animationDelay: "175ms" }}>
              <div className="cli-row">
                <div className="cli-info">
                  <div className="panel-head">Command-line tool</div>
                  <p className="muted small">
                    {cliStatus.installed ? (
                      <>
                        <code>pcc</code> is installed
                        {cliStatus.location ? (
                          <>
                            {" "}
                            in <code>{cliStatus.location}</code>
                          </>
                        ) : null}
                        . {cliStatus.onPath ? "Run it from any terminal." : cliStatus.hint}
                      </>
                    ) : (
                      <>
                        Use polyclaude from any terminal — installs <code>pcc</code> and <code>polyclaude</code> commands
                        that run this app in CLI mode.
                      </>
                    )}
                  </p>
                </div>
                <button className={cliStatus.installed ? "ghost" : "ghost accent"} disabled={cliBusy} onClick={() => void toggleCli()}>
                  {cliBusy ? "Working…" : cliStatus.installed ? "Remove" : "Install pcc"}
                </button>
              </div>
            </section>
          )}

          <section className="panel recent" style={{ animationDelay: "210ms" }}>
            <div className="panel-head">Recent conversations</div>
            {convos.length === 0 ? (
              <p className="muted">No conversations yet.</p>
            ) : (
              <ul className="convos">
                {convos.map((c) => (
                  <li key={c.sessionId} className="convo" onClick={() => launchClaude({ resumeId: c.sessionId, cwd: c.cwd })}>
                    <span className="convo-title">{c.title}</span>
                    <span className="convo-meta">
                      {ago(c.mtime)} · {c.messages} msgs
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        {/* Claude pane — kept mounted while a session is live */}
        {sessionLive && (
          <div className="pane claude-pane" style={{ display: view === "claude" ? "flex" : "none" }}>
            <div className="term-toolbar">
              <span className="muted small">
                Running on <b className="run-acct">{activeLabel}</b>
                <span className="muted small"> · switch accounts in the sidebar to resume here</span>
              </span>
              <div className="term-actions">
                <button className="ghost" onClick={() => launchClaude({ resume: true })} title="Resume this conversation on the active account">
                  ⟳ Restart
                </button>
                <button className="ghost" onClick={() => launchClaude({})}>
                  + New session
                </button>
                <button className="ghost danger" onClick={() => { setSessionLive(false); setView("home"); }}>
                  Stop
                </button>
              </div>
            </div>
            <div className="term-wrap">
              <TerminalView key={termKey} opts={termOpts} onExit={onTermExit} onReady={() => setRestarting(null)} />
              {restarting && (
                <div className="term-overlay">
                  <div className="spinner" />
                  <span>
                    Switching to <b className="run-acct">{restarting}</b> · resuming your conversation…
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {menu && (
        <>
          <div className="ctx-backdrop" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            className="ctx-menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 200),
              top: Math.min(menu.y, window.innerHeight - 200),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="ctx-item"
              onClick={() => {
                setRenaming({ label: menu.label, value: menu.label });
                setMenu(null);
              }}
            >
              ✎ Rename
            </button>
            <button
              className="ctx-item"
              onClick={() => {
                relogin();
                setMenu(null);
              }}
            >
              ↻ Re-login
            </button>
            <div className="ctx-sep" />
            <button
              className="ctx-item"
              onClick={() => {
                launchClaude({ login: true });
                setMenu(null);
              }}
            >
              ＋ Add account…
            </button>
            <div className="ctx-sep" />
            <button
              className="ctx-item danger"
              onClick={() => {
                setConfirmDelete(menu.label);
                setMenu(null);
              }}
            >
              🗑 Delete
            </button>
          </div>
        </>
      )}

      {confirmDelete && (
        <div className="dialog-backdrop" onClick={() => setConfirmDelete(null)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Delete “{confirmDelete}”?</h3>
            <p className="muted small">
              Removes this profile from polyclaude. It won’t sign you out of Claude — you can re-add it any time.
            </p>
            <div className="dialog-actions">
              <button className="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </button>
              <button className="ghost danger" onClick={() => void doDelete(confirmDelete)}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </div>
  );
}

function AccountRow({
  account,
  active,
  switching,
  disabled,
  renameValue,
  dragOver,
  onClick,
  onContextMenu,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onRelogin,
  onDragStartRow,
  onDragOverRow,
  onDropRow,
  onDragEndRow,
}: {
  account: AccountMeta;
  active: boolean;
  switching: boolean;
  disabled: boolean;
  renameValue: string | null;
  dragOver: boolean;
  onClick: () => void;
  onContextMenu: (e: ReactMouseEvent) => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onRelogin: () => void;
  onDragStartRow: () => void;
  onDragOverRow: () => void;
  onDropRow: () => void;
  onDragEndRow: () => void;
}) {
  const u = account.usage;
  const renaming = renameValue != null;
  return (
    <div
      className={`acct ${active ? "active" : ""} ${renaming ? "is-renaming" : ""} ${dragOver ? "drag-over" : ""}`}
      draggable={!renaming}
      onClick={() => !renaming && !disabled && onClick()}
      onContextMenu={onContextMenu}
      onDragStart={onDragStartRow}
      onDragOver={(e) => {
        e.preventDefault();
        onDragOverRow();
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropRow();
      }}
      onDragEnd={onDragEndRow}
    >
      <span className={`dot ${active ? "on" : ""}`} />
      <span className="acct-main">
        {renaming ? (
          <input
            className="acct-rename"
            autoFocus
            value={renameValue}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onRenameChange(e.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(e) => {
              if (e.key === "Enter") onRenameCommit();
              else if (e.key === "Escape") onRenameCancel();
            }}
          />
        ) : (
          <>
            <span className="acct-label">{account.label}</span>
            <span className="acct-email">{account.email ?? "—"}</span>
          </>
        )}
      </span>
      {!renaming && (
        <button
          className="rename-btn"
          title="Rename"
          onClick={(e) => {
            e.stopPropagation();
            onStartRename();
          }}
        >
          ✎
        </button>
      )}
      {switching ? (
        <span className="mini-spinner" />
      ) : u?.error || u?.stale ? (
        // Anything that can't fetch live usage (auth-expired, rate-limited, …) —
        // re-login is the universal fix (a fresh token avoids the failing refresh).
        <button
          className={`relogin-btn ${isAuthError(u) ? "" : "soft"}`}
          title="Sign in again (opens the browser)"
          onClick={(e) => {
            e.stopPropagation();
            onRelogin();
          }}
        >
          ↻ Re-login
        </button>
      ) : (
        <UsageRing pct={u?.fiveHourPct} />
      )}
    </div>
  );
}

function UsageRing({ pct, warn }: { pct?: number | null; warn?: boolean }) {
  if (warn) {
    return (
      <span className="acct-warn" title="sign-in expired — open Claude to run /login">
        !
      </span>
    );
  }
  const v = pct == null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <span className={`ring lvl-${level(pct)}`} style={{ ["--pct"]: v } as CSSProperties}>
      <span className="ring-num">{pct == null ? "—" : Math.round(v)}</span>
    </span>
  );
}

function UsageCard({
  title,
  sub,
  pct,
  reset,
  error,
  stale,
  delay,
}: {
  title: string;
  sub: string;
  pct?: number | null;
  reset: string;
  error?: string;
  stale?: boolean;
  delay: number;
}) {
  const lvl = level(pct);
  const width = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  const noData = pct == null;
  return (
    <div className="panel card" style={{ animationDelay: `${delay}ms` }}>
      <div className="card-head">
        <span>{title}</span>
        <span className="muted small">{sub}</span>
      </div>
      {noData ? (
        <p className="muted small err">
          {error ? "usage unavailable — open Claude to sign in / refresh" : "loading…"}
        </p>
      ) : (
        <>
          <div className={`bar-track ${stale ? "is-stale" : ""}`}>
            <div className={`bar-fill lvl-${lvl}`} style={{ width: `${width}%` }} />
          </div>
          <div className="card-foot">
            <span className={`big lvl-${lvl}`}>{pctText(pct)}</span>
            <span className="muted small">{stale ? "stale · open Claude to refresh" : reset}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Dropdown({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className={`dd ${disabled ? "is-disabled" : ""}`}>
      <span className="dd-label">{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Toggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button className={`toggle ${on ? "on" : ""}`} onClick={onClick} type="button">
      <span className="knob" />
      <span className="toggle-label">{label}</span>
    </button>
  );
}
