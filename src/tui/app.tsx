import { useState, useEffect, useCallback, useRef } from "react";
import { Box, Text, useApp, useInput } from "ink";
import os from "node:os";
import path from "node:path";
import * as vault from "../core/vault.js";
import * as settings from "../core/settings.js";
import * as conversations from "../core/conversations.js";
import * as liveusage from "../core/liveusage.js";
import { switchTo } from "../core/switcher.js";
import { authStatus, type AuthStatus } from "../core/claude.js";
import type { AccountMeta, AccountUsage } from "../types.js";
import { bar, fmtAgo, fmtAgoShort, fmtResetIn, fmtResetAt, nameFromEmail, isPersonalOrg } from "../cli/format.js";
import { Mascot, POLY_PURPLE } from "./mascot.js";

export interface DashboardResult {
  action?: "quit" | "launch" | "login" | "import" | "resume";
  cwd?: string;
  resumeId?: string;
}

const MODEL_CYCLE = ["", "opus", "sonnet", "haiku"];
const EFFORT_CYCLE: Array<settings.Effort | ""> = ["", "low", "medium", "high", "max"];
const CONV_WINDOW = 12;
const USAGE_REFRESH_MS = 5 * 60_000;

function cap(s?: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}
function col(s: string, w: number): string {
  const str = s ?? "";
  if (str.length >= w) return str.slice(0, w - 1) + " ";
  return str.padEnd(w);
}
function shortCwd(): string {
  const home = os.homedir();
  let p = process.cwd();
  if (p.toLowerCase().startsWith(home.toLowerCase())) p = "~" + p.slice(home.length);
  return p.length > 34 ? "…" + p.slice(p.length - 33) : p;
}
function usageColor(pct?: number | null): string {
  if (pct == null) return "gray";
  if (pct >= 90) return "red";
  if (pct >= 75) return "yellow";
  return "green";
}
function pctText(pct?: number | null): string {
  return pct == null ? "—" : `${Math.round(pct)}%`;
}

const SHORTCUTS: Array<[string, string]> = [
  ["↑ / ↓", "move the selection up and down the account list"],
  ["⏎ / s", "switch to the selected account — your conversation keeps going"],
  ["a", "add or re-connect an account (opens your browser to sign in)"],
  ["l", "start a NEW conversation in Claude Code on the active account"],
  ["c", "past conversations: ⏎ reopens one, n starts a new one"],
  ["g", "continue your latest chat on another account (switch + resume)"],
  ["R", "rename the selected account's label"],
  ["d", "remove the selected account (does not sign you out of Claude)"],
  ["m / e", "cycle the model / reasoning effort for launched sessions"],
  ["t / f", "toggle extended thinking / auto-switch on limits"],
  ["r", "refresh the usage numbers now"],
  ["?", "show / hide this help"],
  ["q", "quit"],
];

export function App({ result }: { result: DashboardResult }) {
  const { exit } = useApp();
  const [accounts, setAccounts] = useState<AccountMeta[]>([]);
  const [activeLabel, setActiveLabel] = useState<string | undefined>();
  const [cfg, setCfg] = useState<settings.Settings | null>(null);
  const [live, setLive] = useState<AuthStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sel, setSel] = useState(0);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"dashboard" | "conversations">("dashboard");
  const [convos, setConvos] = useState<conversations.Conversation[] | null>(null);
  const [convSel, setConvSel] = useState(0);
  const [recents, setRecents] = useState<conversations.Conversation[]>([]);
  const [showHelp, setShowHelp] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ label: string; value: string } | null>(null);
  const [activeUsage, setActiveUsage] = useState<AccountUsage | null>(null);
  const [picking, setPicking] = useState(false); // "continue on which account?" picker
  const [pickSel, setPickSel] = useState(0);
  const [, setTick] = useState(0); // forces re-render so "updated …s ago" counts up
  const fetchingAll = useRef(false);

  const reload = useCallback(async () => {
    const [data, s] = await Promise.all([vault.load(), settings.load()]);
    const metas = Object.values(data.accounts)
      .map((e) => e.meta)
      .sort((a, b) => a.label.localeCompare(b.label));
    setAccounts(metas);
    setActiveLabel(data.activeLabel);
    setCfg(s);
    setLoaded(true);
  }, []);

  const refreshActiveUsage = useCallback(async () => {
    setBusy(true);
    try {
      const u = await liveusage.fetchActive();
      setActiveUsage(u);
    } catch {
      /* ignore */
    }
    await reload();
    setBusy(false);
  }, [reload]);

  const refreshAllUsage = useCallback(async () => {
    if (fetchingAll.current) return;
    fetchingAll.current = true;
    setBusy(true);
    try {
      const all = await liveusage.fetchAll();
      const data = await vault.load();
      if (data.activeLabel && all[data.activeLabel]) setActiveUsage(all[data.activeLabel]);
    } catch {
      /* ignore */
    }
    await reload();
    setBusy(false);
    fetchingAll.current = false;
  }, [reload]);

  useEffect(() => {
    void reload();
    setLive(authStatus());
    void conversations.list(3).then(setRecents);
    void refreshAllUsage();
    const id = setInterval(() => {
      if (view === "dashboard" && !showHelp) void refreshActiveUsage();
    }, USAGE_REFRESH_MS);
    return () => clearInterval(id);
  }, [reload, refreshAllUsage, refreshActiveUsage, view, showHelp]);

  // Tick every 15s so relative timestamps ("updated …s ago") stay current.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const loadConvos = useCallback(async () => {
    setConvos(null);
    const list = await conversations.list(40);
    setConvos(list);
    setConvSel(0);
  }, []);

  const flash = (msg: string) => {
    setStatus(msg);
    setTimeout(() => setStatus(""), 2500);
  };

  /** The other account with the most 5-hour headroom (lowest usage); unknown = treated as fresh. */
  const pickNextAccount = (): string | undefined => {
    const others = accounts.filter((a) => a.label !== activeLabel);
    if (others.length === 0) return undefined;
    others.sort((a, b) => (a.usage?.fiveHourPct ?? 0) - (b.usage?.fiveHourPct ?? 0));
    return others[0].label;
  };

  /** Switch to the chosen account and resume the most recent conversation on it. */
  const continueOn = async (target: string) => {
    try {
      await switchTo(target, "manual");
    } catch (e) {
      flash((e as Error).message);
      setPicking(false);
      return;
    }
    const [latest] = await conversations.list(1);
    if (latest) {
      result.action = "resume";
      result.resumeId = latest.sessionId;
      result.cwd = latest.cwd;
    } else {
      result.action = "launch";
      result.cwd = process.cwd();
    }
    exit();
  };

  const isEmpty = loaded && accounts.length === 0;
  const activeMeta = accounts.find((a) => a.label === activeLabel);
  const name = cfg?.name?.trim() || activeMeta?.fullName || nameFromEmail(activeMeta?.email) || "there";

  useInput((input, key) => {
    if (input === "q" || (key.ctrl && input === "c")) {
      result.action = "quit";
      exit();
      return;
    }
    if (showHelp) {
      setShowHelp(false);
      return;
    }
    if (isEmpty) {
      if (input === "?") {
        setShowHelp(true);
      } else if (live?.loggedIn) {
        if (key.return) {
          result.action = "import";
          exit();
        } else if (input === "n") {
          result.action = "login";
          exit();
        }
      } else if (input === "a" || key.return) {
        result.action = "login";
        exit();
      }
      return;
    }
    if (view === "conversations") {
      const n = convos?.length ?? 0;
      if (key.upArrow) setConvSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setConvSel((s) => Math.min(Math.max(0, n - 1), s + 1));
      else if (key.return && convos && convos[convSel]) {
        result.action = "resume";
        result.resumeId = convos[convSel].sessionId;
        result.cwd = convos[convSel].cwd;
        exit();
      } else if (input === "n") {
        // Start a fresh conversation (a new Claude Code session in this folder).
        result.action = "launch";
        result.cwd = process.cwd();
        exit();
      } else if (key.escape || input === "b") setView("dashboard");
      return;
    }

    // Dashboard — "continue on which account?" picker
    if (picking) {
      if (key.escape || input === "b") setPicking(false);
      else if (key.upArrow) setPickSel((s) => Math.max(0, s - 1));
      else if (key.downArrow) setPickSel((s) => Math.min(accounts.length - 1, s + 1));
      else if (key.return) {
        const target = accounts[pickSel]?.label;
        if (target) void continueOn(target);
      }
      return;
    }
    // Dashboard — inline rename input
    if (renaming) {
      if (key.escape) setRenaming(null);
      else if (key.return) {
        const { label, value } = renaming;
        const next = value.trim();
        if (next && next !== label) {
          void vault
            .rename(label, next)
            .then(() => {
              flash(`Renamed to ${next}`);
              void reload();
            })
            .catch((e) => flash((e as Error).message));
        }
        setRenaming(null);
      } else if (key.backspace || key.delete) {
        setRenaming((r) => (r ? { ...r, value: r.value.slice(0, -1) } : r));
      } else if (input && !key.ctrl && !key.meta) {
        setRenaming((r) => (r ? { ...r, value: r.value + input } : r));
      }
      return;
    }
    // Dashboard — inline delete confirmation
    if (confirmingDelete) {
      if (input === "y" || input === "Y") {
        const label = confirmingDelete;
        void vault.remove(label).then(() => {
          flash(`Deleted ${label}`);
          setSel(0);
          void reload();
        });
      }
      setConfirmingDelete(null);
      return;
    }

    // Dashboard
    if (input === "?") setShowHelp(true);
    else if (key.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (key.downArrow) setSel((s) => Math.min(accounts.length - 1, s + 1));
    else if (key.return || input === "s") {
      const label = accounts[sel]?.label;
      if (label && label !== activeLabel) {
        void switchTo(label, "manual").then(() => {
          flash(`Switched to ${label}`);
          void refreshActiveUsage();
        });
      }
    } else if (input === "l") {
      result.action = "launch";
      result.cwd = process.cwd();
      exit();
    } else if (input === "a") {
      result.action = "login";
      exit();
    } else if (input === "c") {
      setView("conversations");
      void loadConvos();
    } else if (input === "g") {
      // Open the "continue on which account?" picker, defaulting to the one with
      // the most headroom.
      const def = pickNextAccount();
      const idx = def ? accounts.findIndex((a) => a.label === def) : sel;
      setPickSel(Math.max(0, idx));
      setPicking(true);
    } else if (input === "R") {
      const label = accounts[sel]?.label;
      if (label) setRenaming({ label, value: label });
    } else if (input === "d") {
      const label = accounts[sel]?.label;
      if (label) setConfirmingDelete(label);
    } else if (input === "m") {
      const i = MODEL_CYCLE.indexOf(cfg?.model ?? "");
      void settings.update({ model: MODEL_CYCLE[(i + 1) % MODEL_CYCLE.length] }).then(reload);
    } else if (input === "e") {
      const i = EFFORT_CYCLE.indexOf(cfg?.effort ?? "");
      void settings.update({ effort: EFFORT_CYCLE[(i + 1) % EFFORT_CYCLE.length] }).then(reload);
    } else if (input === "t") {
      void settings.update({ thinking: !cfg?.thinking }).then(reload);
    } else if (input === "f") {
      void settings.update({ autoSwitch: !cfg?.autoSwitch }).then(reload);
    } else if (input === "r") {
      flash("Refreshing usage…");
      void refreshActiveUsage();
    }
  });

  const Title = () => (
    <Text>
      {" "}
      <Text bold color={POLY_PURPLE}>
        polyclaude
      </Text>{" "}
      <Text dimColor>v0.1.0</Text>
    </Text>
  );

  // ---- Help overlay -------------------------------------------------------
  if (showHelp) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Title />
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={POLY_PURPLE} paddingX={2} paddingY={1}>
          <Text bold color={POLY_PURPLE}>
            polyclaude — quick guide
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>Keep several Claude accounts in one place and switch between them so</Text>
            <Text>you can keep working when one hits its usage limit. Each switch keeps</Text>
            <Text>your conversation, because the transcript lives on your machine.</Text>
            <Box marginTop={1}>
              <Text dimColor>
                The <Text color="cyan">Plan usage</Text> box shows your real session (5h) and weekly (7d) usage
              </Text>
            </Box>
            <Text dimColor>with reset times. It refreshes on its own and when you press r.</Text>
          </Box>
          <Box marginTop={1}>
            <Text bold color={POLY_PURPLE}>
              What the keys do
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            {SHORTCUTS.map(([k, d]) => (
              <Text key={k}>
                <Text color="cyan">{k.padEnd(8)}</Text>
                <Text dimColor>{d}</Text>
              </Text>
            ))}
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>press any key to close</Text>
        </Box>
      </Box>
    );
  }

  // ---- "Continue on which account?" picker -------------------------------
  if (picking) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Title />
        <Box marginTop={1}>
          <Text bold>Continue your conversation on which account?</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Text dimColor>
              {"  "}
              {col("LABEL", 14)}
              {col("EMAIL", 30)}
              {col("PLAN", 6)}
              {col("5H", 7)}
              {"7D"}
            </Text>
          </Box>
          {accounts.map((a, i) => {
            const isSel = i === pickSel;
            const isActive = a.label === activeLabel;
            const au = a.usage;
            return (
              <Box key={a.label}>
                <Text color={isSel ? "cyan" : undefined}>
                  {isSel ? "▸ " : "  "}
                  {isActive ? "● " : "○ "}
                </Text>
                <Text color={isSel ? "cyan" : isActive ? "green" : undefined}>{col(a.label, 12)}</Text>
                <Text dimColor>{col(a.email ?? "—", 30)}</Text>
                <Text>{col(cap(a.subscriptionType) || "—", 6)}</Text>
                <Text color={usageColor(au?.fiveHourPct)}>{col(pctText(au?.fiveHourPct), 7)}</Text>
                <Text color={usageColor(au?.sevenDayPct)}>{pctText(au?.sevenDayPct)}</Text>
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            ↑/↓ select · ⏎ continue here (resumes your latest chat) · Esc cancel
          </Text>
        </Box>
      </Box>
    );
  }

  // ---- Welcome / first run ------------------------------------------------
  if (isEmpty) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Title />
        <Box marginTop={1} borderStyle="round" borderColor={POLY_PURPLE} paddingX={2} paddingY={1}>
          <Box flexDirection="column">
            <Text bold>Welcome to polyclaude!</Text>
            <Box marginTop={1}>
              <Mascot />
            </Box>
            <Box marginTop={1}>
              <Text dimColor>All your Claude accounts, in one friendly place.</Text>
            </Box>
          </Box>
          <Box
            flexDirection="column"
            marginLeft={3}
            paddingLeft={3}
            borderStyle="round"
            borderColor={POLY_PURPLE}
            borderTop={false}
            borderRight={false}
            borderBottom={false}
          >
            <Text bold color={POLY_PURPLE}>
              Let's get you set up
            </Text>
            <Box marginTop={1} flexDirection="column">
              {live?.loggedIn ? (
                <>
                  <Text>
                    You're signed in as <Text color="green">{live.email}</Text>{" "}
                    <Text dimColor>({cap(live.subscriptionType)})</Text>
                  </Text>
                  <Box marginTop={1} flexDirection="column">
                    <Text>
                      <Text color="cyan">▸ Enter</Text> <Text>add this account</Text>
                    </Text>
                    <Text>
                      <Text color="cyan">▸ n</Text>     <Text>sign in to a different one</Text>
                    </Text>
                  </Box>
                </>
              ) : (
                <Text>
                  <Text color="cyan">▸ a</Text> sign in to your Claude account
                  <Text dimColor> (opens your browser)</Text>
                </Text>
              )}
            </Box>
          </Box>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            <Text color="cyan">?</Text> help · q quit
          </Text>
        </Box>
      </Box>
    );
  }

  // ---- Conversations browser ---------------------------------------------
  if (view === "conversations") {
    const n = convos?.length ?? 0;
    const start = Math.max(0, Math.min(Math.max(0, n - CONV_WINDOW), convSel - Math.floor(CONV_WINDOW / 2)));
    const visible = convos?.slice(start, start + CONV_WINDOW) ?? [];
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>Conversations</Text>
          <Text dimColor>on {activeLabel ?? "active account"}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="cyan">＋ n</Text>
          <Text dimColor>  start a new conversation</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {convos === null ? (
            <Text dimColor>loading…</Text>
          ) : n === 0 ? (
            <Text dimColor>No past conversations found yet.</Text>
          ) : (
            visible.map((cv, idx) => {
              const i = start + idx;
              const isSel = i === convSel;
              return (
                <Box key={cv.sessionId}>
                  <Text color={isSel ? "cyan" : undefined}>{isSel ? "▸ " : "  "}</Text>
                  <Text color={isSel ? "cyan" : undefined}>{col(cv.title, 48)}</Text>
                  <Text dimColor>{col(fmtAgo(cv.mtime), 9)}</Text>
                  <Text dimColor>{col(path.basename(cv.cwd ?? cv.project), 16)}</Text>
                  <Text dimColor>{`${cv.messages} msgs`}</Text>
                </Box>
              );
            })
          )}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>↑/↓ select · ⏎ continue · n new conversation · b/Esc back · q quit</Text>
        </Box>
      </Box>
    );
  }

  // ---- Dashboard ----------------------------------------------------------
  const u = activeUsage ?? activeMeta?.usage;
  const usageUnavailable = !!u && (u.error != null || (u.fiveHourPct == null && u.sevenDayPct == null));
  const activePct = u && u.error == null ? u.fiveHourPct ?? null : null;
  const nextAcct = pickNextAccount();
  const runningLow = activePct != null && activePct >= 85 && !!nextAcct;
  const planName = cap(activeMeta?.subscriptionType) || cap(live?.subscriptionType) || "Plan";
  const orgLabel = activeMeta
    ? isPersonalOrg(activeMeta.orgType)
      ? "Personal"
      : `Org · ${activeMeta.orgName ?? "organization"}`
    : "";

  const UsageRow = ({ title, pct, reset }: { title: string; pct?: number | null; reset: string }) => (
    <Box flexDirection="column">
      <Box>
        <Text>{col(title, 21)}</Text>
        <Text color={usageColor(pct)}>{bar((pct ?? 0) / 100, 26)}</Text>
        <Text color={usageColor(pct)}> {pctText(pct)} used</Text>
      </Box>
      {reset ? (
        <Text dimColor>
          {col("", 21)}
          {reset}
        </Text>
      ) : null}
    </Box>
  );

  return (
    <Box flexDirection="column" paddingX={1}>
      <Title />

      {/* Welcome / identity box */}
      <Box marginTop={1} borderStyle="round" borderColor={POLY_PURPLE} paddingX={2} paddingY={0}>
        <Box flexDirection="column">
          <Text bold>Welcome back, {name}!</Text>
          <Box marginTop={1}>
            <Mascot />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              Claude {planName}
              {orgLabel ? ` · ${orgLabel}` : ""}
            </Text>
            <Text dimColor>{shortCwd()}</Text>
          </Box>
        </Box>

        <Box
          flexDirection="column"
          marginLeft={3}
          paddingLeft={3}
          borderStyle="round"
          borderColor={POLY_PURPLE}
          borderTop={false}
          borderRight={false}
          borderBottom={false}
        >
          <Text bold color={POLY_PURPLE}>
            Tips
          </Text>
          <Text dimColor>• press l for a new chat · c to continue a past one</Text>
          <Text dimColor>• running low? g continues your chat on another account</Text>
          <Text dimColor>• press a to add another account</Text>
          <Box marginTop={1}>
            <Text bold color={POLY_PURPLE}>
              Recent activity
            </Text>
          </Box>
          {recents.length === 0 ? (
            <Text dimColor>No recent activity</Text>
          ) : (
            recents.map((cv) => (
              <Text key={cv.sessionId} dimColor>
                • {col(cv.title, 28)} {fmtAgo(cv.mtime)}
              </Text>
            ))
          )}
        </Box>
      </Box>

      {/* active + toggles */}
      <Box marginTop={1}>
        <Text dimColor>active: </Text>
        <Text bold color="green">
          {activeLabel ?? "none"}
        </Text>
        <Text dimColor>
          {"   "}model <Text color="cyan">{cfg?.model || "default"}</Text> · effort{" "}
          <Text color="cyan">{cfg?.effort || "default"}</Text> · thinking{" "}
          <Text color={cfg?.thinking ? "green" : "gray"}>{cfg?.thinking ? "on" : "off"}</Text> · auto{" "}
          <Text color={cfg?.autoSwitch ? "green" : "yellow"}>{cfg?.autoSwitch ? "on" : "off"}</Text>
        </Text>
      </Box>

      {/* Plan usage (real, Claude-style) */}
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold>
            Plan usage <Text dimColor>· {planName}</Text>
          </Text>
          <Text dimColor>
            {busy ? "updating…" : u?.fetchedAt ? `updated ${fmtAgoShort(u.fetchedAt)}` : ""}
          </Text>
        </Box>
        {!u ? (
          <Text dimColor>loading usage…</Text>
        ) : usageUnavailable ? (
          <Text color="yellow">
            usage unavailable
            <Text dimColor> — run </Text>
            <Text color="cyan">claude auth login</Text>
            <Text dimColor> then press </Text>
            <Text color="cyan">r</Text>
            <Text dimColor> (or a to sign in here)</Text>
          </Text>
        ) : (
          <>
            <UsageRow
              title="Current session"
              pct={u.fiveHourPct}
              reset={u.fiveHourResetsAt ? `Resets in ${fmtResetIn(u.fiveHourResetsAt)}` : ""}
            />
            <UsageRow
              title="Weekly · all models"
              pct={u.sevenDayPct}
              reset={u.sevenDayResetsAt ? `Resets ${fmtResetAt(u.sevenDayResetsAt)}` : ""}
            />
          </>
        )}
      </Box>

      {/* accounts */}
      <Box flexDirection="column" marginTop={1}>
        <Text bold>Accounts</Text>
        <Box>
          <Text dimColor>
            {"  "}
            {col("LABEL", 13)}
            {col("EMAIL", 26)}
            {col("PLAN", 5)}
            {col("5H", 6)}
            {col("7D", 6)}
            {"ORG / PERSONAL"}
          </Text>
        </Box>
        {accounts.map((a, i) => {
          const isActive = a.label === activeLabel;
          const isSel = i === sel;
          const au = a.usage;
          const personal = isPersonalOrg(a.orgType);
          return (
            <Box key={a.label}>
              <Text color={isSel ? "cyan" : undefined}>
                {isSel ? "▸ " : "  "}
                {isActive ? "● " : "○ "}
              </Text>
              <Text color={isActive ? "green" : isSel ? "cyan" : undefined}>{col(a.label, 11)}</Text>
              <Text dimColor>{col(a.email ?? "—", 26)}</Text>
              <Text>{col(cap(a.subscriptionType) || "—", 5)}</Text>
              <Text color={usageColor(au?.fiveHourPct)}>{col(pctText(au?.fiveHourPct), 6)}</Text>
              <Text color={usageColor(au?.sevenDayPct)}>{col(pctText(au?.sevenDayPct), 6)}</Text>
              {personal ? (
                <Text dimColor>personal</Text>
              ) : (
                <Text color="magenta">{a.orgName ?? "organization"}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* footer */}
      <Box marginTop={1} flexDirection="column">
        {renaming ? (
          <Text>
            Rename <Text color="green">{renaming.label}</Text> to:{" "}
            <Text color="cyan">{renaming.value}</Text>
            <Text inverse> </Text>
            <Text dimColor>  (Enter to save · Esc to cancel)</Text>
          </Text>
        ) : confirmingDelete ? (
          <Text>
            Delete <Text color="red">{confirmingDelete}</Text> from polyclaude?{" "}
            <Text dimColor>(won't sign you out of Claude) — press </Text>
            <Text color="red">y</Text>
            <Text dimColor> to confirm, any other key to cancel</Text>
          </Text>
        ) : status ? (
          <Text color="yellow">{status}</Text>
        ) : runningLow ? (
          <Text color="yellow">
            ⚠ {activeLabel} is at {Math.round(activePct as number)}% — press{" "}
            <Text color="cyan">g</Text> to continue your chat on {nextAcct}
          </Text>
        ) : (
          <Text> </Text>
        )}
        <Text dimColor>↑/↓ select · ⏎ switch · l new chat · g continue elsewhere · c chats</Text>
        <Text dimColor>a add · R rename · d delete · m/e/t/f settings · r refresh</Text>
        <Text dimColor>
          <Text color="cyan">?</Text> for shortcuts · q quit
        </Text>
      </Box>
    </Box>
  );
}
