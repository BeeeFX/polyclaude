import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AccountMeta, AccountUsage, Conversation, Settings } from "./types";
import { ago, cap, level, pctText, resetAt, resetIn } from "./format";

const MODELS: Array<{ value: string; label: string }> = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];
const EFFORTS = ["", "low", "medium", "high", "max"];
const USAGE_POLL_MS = 30_000;

export function App() {
  const [version, setVersion] = useState("");
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [switching, setSwitching] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const toastTimer = useRef<number | undefined>(undefined);

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
      const info = await window.poly.app.info();
      setVersion(info.version);
      await reload();
      setReady(true);
      void window.poly.conversations.list(6).then(setConvos);
      void refreshUsage();
    })();
    const id = window.setInterval(refreshUsage, USAGE_POLL_MS);
    return () => window.clearInterval(id);
  }, [reload, refreshUsage]);

  const active = useMemo(() => accounts.find((a) => a.label === activeLabel), [accounts, activeLabel]);
  const usage = active?.usage;
  const name =
    settings?.name?.trim() ||
    active?.fullName ||
    active?.email?.split("@")[0] ||
    "there";

  const switchTo = useCallback(
    async (label: string) => {
      if (label === activeLabel || switching) return;
      setSwitching(label);
      const r = await window.poly.accounts.switch(label);
      if (r.ok) {
        await reload();
        await refreshUsage();
        flash(`Switched to ${label}`);
      } else {
        flash(r.error);
      }
      setSwitching(null);
    },
    [activeLabel, switching, reload, refreshUsage, flash]
  );

  const patchSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = await window.poly.settings.update(patch);
    setSettings(next);
  }, []);

  if (!ready) {
    return (
      <div className="loading">
        <div className="spinner" />
        <span>polyclaude</span>
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">◆</span>
          <span className="word">polyclaude</span>
          <span className="ver">v{version}</span>
        </div>

        <div className="acct-list">
          {accounts.map((a) => (
            <AccountRow
              key={a.label}
              account={a}
              active={a.label === activeLabel}
              switching={switching === a.label}
              disabled={!!switching}
              onClick={() => void switchTo(a.label)}
            />
          ))}
        </div>

        <button className="add-acct" onClick={() => flash("Run `pcc` (or the CLI) to sign in to a new account — in-app sign-in is coming.")}>
          + Add account
        </button>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="hello">
            <h1>Welcome back, {name}</h1>
            <p className="sub">
              {active?.email ?? "no active account"}
              {active?.subscriptionType ? ` · Claude ${cap(active.subscriptionType)}` : ""}
            </p>
          </div>
          <div className="top-actions">
            <Dropdown
              label="Model"
              value={settings?.model ?? ""}
              options={MODELS}
              onChange={(v) => void patchSettings({ model: v })}
            />
            <button className="primary" onClick={() => void window.poly.claude.launch()}>
              Launch Claude →
            </button>
          </div>
        </header>

        <section className="cards">
          <UsageCard
            title="Current session"
            sub="5-hour window"
            pct={usage?.fiveHourPct}
            reset={resetIn(usage?.fiveHourResetsAt)}
            error={usage?.error}
            delay={0}
          />
          <UsageCard
            title="Weekly"
            sub="all models · 7-day"
            pct={usage?.sevenDayPct}
            reset={resetAt(usage?.sevenDayResetsAt)}
            error={usage?.error}
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
              label="Effort"
              value={settings?.effort ?? ""}
              options={EFFORTS.map((e) => ({ value: e, label: e ? cap(e) : "Default" }))}
              onChange={(v) => void patchSettings({ effort: v as Settings["effort"] })}
            />
            <Toggle label="Extended thinking" on={!!settings?.thinking} onClick={() => void patchSettings({ thinking: !settings?.thinking })} />
            <Toggle label="Auto-switch on limit" on={!!settings?.autoSwitch} onClick={() => void patchSettings({ autoSwitch: !settings?.autoSwitch })} />
          </div>
        </section>

        <section className="panel recent" style={{ animationDelay: "210ms" }}>
          <div className="panel-head">Recent conversations</div>
          {convos.length === 0 ? (
            <p className="muted">No conversations yet.</p>
          ) : (
            <ul className="convos">
              {convos.map((c) => (
                <li key={c.sessionId} className="convo" onClick={() => void window.poly.claude.launch(c.cwd)}>
                  <span className="convo-title">{c.title}</span>
                  <span className="convo-meta">
                    {ago(c.mtime)} · {c.messages} msgs
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>

      <div className={`toast ${toast ? "show" : ""}`}>{toast}</div>
    </div>
  );
}

function AccountRow({
  account,
  active,
  switching,
  disabled,
  onClick,
}: {
  account: AccountMeta;
  active: boolean;
  switching: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const pct = account.usage?.fiveHourPct;
  return (
    <button className={`acct ${active ? "active" : ""}`} onClick={onClick} disabled={disabled && !active}>
      <span className={`dot ${active ? "on" : ""}`} />
      <span className="acct-main">
        <span className="acct-label">{account.label}</span>
        <span className="acct-email">{account.email ?? "—"}</span>
      </span>
      {switching ? (
        <span className="mini-spinner" />
      ) : (
        <span className={`acct-pct lvl-${level(pct)}`}>{pctText(pct)}</span>
      )}
    </button>
  );
}

function UsageCard({
  title,
  sub,
  pct,
  reset,
  error,
  delay,
}: {
  title: string;
  sub: string;
  pct?: number | null;
  reset: string;
  error?: string;
  delay: number;
}) {
  const lvl = level(pct);
  const width = pct == null ? 0 : Math.max(2, Math.min(100, pct));
  return (
    <div className="panel card" style={{ animationDelay: `${delay}ms` }}>
      <div className="card-head">
        <span>{title}</span>
        <span className="muted small">{sub}</span>
      </div>
      {error ? (
        <p className="muted small err">usage unavailable — open Claude, then it refreshes</p>
      ) : (
        <>
          <div className="bar-track">
            <div className={`bar-fill lvl-${lvl}`} style={{ width: `${width}%` }} />
          </div>
          <div className="card-foot">
            <span className={`big lvl-${lvl}`}>{pctText(pct)}</span>
            <span className="muted small">{reset}</span>
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
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
}) {
  return (
    <label className="dd">
      <span className="dd-label">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
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
