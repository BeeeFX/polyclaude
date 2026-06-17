# polyclaude

A multi-account manager, usage dashboard, and seamless session switcher for
**Claude Code**.

Log into several Claude accounts once, watch their usage in one place, switch the
active one with a single keystroke — and keep talking in the same conversation,
because Claude Code stores your transcript locally and resends it each turn. The
account only governs auth and billing, so swapping it mid-conversation just
changes *who pays* while your context carries on.

> **Platform:** Windows (credential encryption uses DPAPI). macOS/Linux key
> storage is on the roadmap.

> **Disclaimer:** polyclaude is an unofficial, community project and is **not
> affiliated with, authorized, or endorsed by Anthropic**. It talks to
> undocumented Claude subscription endpoints (discovered from the Claude Code
> client) that may change or stop working at any time. Using several accounts to
> work *past* a plan's usage limits may conflict with Anthropic's terms — that's
> your call. Provided as-is, with no warranty. Use at your own risk.

```
   ██           ██     Meet Poly — polyclaude's purple block mascot, in the
     ██       ██       spirit of Claude's pixel creature. On a dark terminal
    █████████████      she's purple with dark eye-holes. She greets you on the
    ████  ███  ██      home screen with a friendly "Welcome back", next to
    █████████████      Tips, Recent activity, and a "? for shortcuts" hint.
  █████████████████
  █████████████████
    █████████████
      ██     ██
     ███     ███
```


The home screen mirrors Claude Code's welcome: a purple-bordered box with
"Welcome back, &lt;name&gt;!", your plan + working directory, a **Tips** panel, and
**Recent activity** (your latest conversations). polyclaude asks your name the
first time you sign in — change it any time with `pcc set name <you>`.

---

## Highlights

- **Encrypted multi-account vault** — store many logged-in accounts; tokens are
  encrypted at rest with Windows DPAPI (per-user, no master password).
- **One-key switch** — flip the active account; resume your chat with `claude -c`.
- **Live usage dashboard** (Ink TUI) — rolling 5-hour / 7-day token usage per
  account, authoritative rate-limit status + reset times, and model / effort /
  thinking toggles.
- **Auto-fail-over** — `pcc ask` / `pcc chat` automatically switch to the next
  account when the active one is rate-limited, and resume the same session so
  context is preserved.
- **All local** — nothing is sent anywhere; usage is read from Claude Code's own
  transcripts and rate-limit events.

## How it works

- Claude Code keeps the active account in `~/.claude/.credentials.json` (an OAuth
  blob). On Windows this file is the source of truth — no competing OS vault.
- polyclaude keeps an encrypted vault (`~/.polyclaude/vault.json`) of several
  blobs and swaps the active one on demand (backing up the previous first).
- **Plan usage** (current-session and weekly **percentages** + reset times) is
  read from the same endpoint Claude's own `/usage` panel uses
  (`/api/oauth/usage`), per account. Expired access tokens are refreshed
  automatically. Account name / plan / org come from `/api/oauth/profile`.

## Install

Requires [Node.js](https://nodejs.org) 18+ and [Claude Code](https://claude.com/claude-code)
installed and signed in.

```sh
git clone https://github.com/BeeeFX/polyclaude.git
cd polyclaude
npm install             # also builds (via the prepare script)
```

### Run `polyclaude` from anywhere

To use `polyclaude` (and the short alias `pcc`) in any terminal — just like
typing `claude`:

```sh
npm link                # registers global `polyclaude` and `pcc` commands
```

Now open any PowerShell window and run `polyclaude`. After pulling updates,
`npm run build` refreshes the global command (it points at the build). Remove it
later with `npm uninstall -g polyclaude`. Prefer a fixed copy over a live link?
Use `npm install -g .` instead.

You can also run it without installing, straight from the repo:

```sh
npm run pcc -- <command> [args]
```

## Quick start (beginner-friendly)

Just open the app — it walks you through everything:

```sh
npm run pcc            # bare `pcc` opens the dashboard
```

On first run it greets you and, if you're already signed into Claude Code, lets
you add that account with a single **Enter**. To add more accounts, press **a**
inside the dashboard (or **n** on the welcome screen) — a browser window opens to
sign in, then you give the account a name and you're back in the dashboard. No
separate login commands required.

Prefer commands? They still exist: `pcc login`, `pcc add <label>`.

## Commands

| Command | What it does |
| --- | --- |
| `pcc` / `pcc dashboard` | Interactive TUI: accounts, usage, limits, chats, toggles |
| `pcc login` | Sign in to an account (opens browser) and save it |
| `pcc add <label>` | Snapshot the currently logged-in account into the vault |
| `pcc list` | List accounts with live usage % + personal/org |
| `pcc use <label>` | Make a saved account active (then `claude -c` to resume) |
| `pcc rename <old> <new>` | Change an account's label |
| `pcc status` | Show the active account (vault + live Claude auth) |
| `pcc sync` | Re-store refreshed tokens into the active label |
| `pcc remove <label>` | Forget an account |
| `pcc usage [--all] [--watch]` | Real plan usage (session + weekly %), like Claude's `/usage` |
| `pcc conversations` / `history` | List your recent (resumable) conversations |
| `pcc resume [id]` | Resume a past conversation (latest if no id) |
| `pcc ask <prompt>` | One prompt; auto-switches accounts on a limit |
| `pcc chat` | Multi-turn chat that keeps context and auto-switches |
| `pcc probe` | Tiny call to refresh the active account's live limit status |
| `pcc launch` / `pcc code` | Launch interactive Claude Code with your saved settings |
| `pcc statusline [--install]` | Show every account's usage in Claude Code's status line |
| `pcc config` | Show settings |
| `pcc set <key> <value>` | Set model / effort / thinking / autoswitch / budgets |
| `pcc order <labels...>` | Set the failover order |

### Dashboard keys

```
↑/↓ select   ⏎/s switch   l launch Claude   c chats   a add account
R rename   d delete   m model   e effort   t thinking   f auto-switch
r refresh usage   ? shortcuts   q quit
```

Press **c** to browse past conversations and continue any of them on the current
account.

## Auto-switch: two modes

- **Automatic** — `pcc ask` and `pcc chat` run Claude Code headlessly, detect a
  real rate-limit, switch to the next account, and resume the same session. This
  is the hands-off "keep going when one runs out" experience.
- **Assisted** — for the full interactive Claude Code TUI (`pcc launch`), switch
  with one key in the dashboard (or `pcc use`), then `claude -c` to continue the
  same conversation on the new account.

## Watch usage inside Claude Code

Claude Code is full-screen, so it covers the dashboard while you work. To keep an
eye on **every account's usage from within Claude**, add polyclaude to Claude
Code's status line:

```sh
pcc statusline --install
```

Now the bottom of Claude Code shows e.g. `polyclaude ● work 92% · ○ personal 12% · 5h`
(active account in bold; red/yellow/green by level). It reads cached usage and
refreshes the active account at most once every ~90s, so it never hammers the API.

Prefer a separate view? Run `pcc usage --all --watch` in a split pane.

## Settings

```sh
pcc set model sonnet        # or opus / haiku / a full id / "default"
pcc set effort high         # low | medium | high | max | default
pcc set thinking on         # sets MAX_THINKING_TOKENS for launched sessions
pcc set autoswitch on       # enable/disable failover
pcc set budget5h 50000000   # optional cap to turn usage into % bars
pcc order work personal     # failover preference order
```

## Data & security

- Vault: `~/.polyclaude/vault.json` — every account's credentials are
  DPAPI-encrypted (decryptable only by your Windows user on this machine).
  Tokens are **never** written to disk in plaintext by polyclaude.
- Before switching, the currently-signed-in account is captured into the
  encrypted vault if it isn't already there, so a switch can't lose an account —
  there are no plaintext backup files.
- Switch log (for usage attribution): `~/.polyclaude/switches.jsonl`.
- Settings: `~/.polyclaude/settings.json`.
- The live active account lives in Claude Code's own `~/.claude/.credentials.json`
  (plaintext, by Claude Code's design — not something polyclaude controls).

## A note on usage limits

Storing multiple accounts you own and switching between them is ordinary account
management. Be aware that rotating accounts specifically to get *past* a plan's
weekly/monthly usage limits may conflict with Anthropic's terms — that part is
your call. The vault, switcher, and usage views work regardless of how you use
them.

> Usage figures are tokens *observed by this tool* from local transcripts, not an
> official server-side quota; the rate-limit **status/reset** comes straight from
> Claude Code's own `rate_limit_event`, so auto-switch keys off the real signal.

## Tests

```sh
npm run typecheck   # full TS typecheck
npm run smoke       # headless render check of the dashboard
```

## Roadmap

- [x] Encrypted multi-account vault + manual switch
- [x] Live usage tracking (rolling 5h / 7d, per-account attribution)
- [x] Authoritative rate-limit status + reset times
- [x] Headless runner with auto-switch on limit + session resume
- [x] TUI dashboard with model / effort / thinking toggles
- [x] In-app sign-in + first-run onboarding (no pre-commands)
- [x] Conversation history browser (resume past chats)
- [ ] macOS / Linux credential encryption
- [ ] Background limit watcher with desktop notifications
- [ ] Optional VS Code panel sharing the same core

## Contributing

Issues and pull requests are welcome. This is an early project — expect rough
edges, especially around the undocumented endpoints it relies on.

## License

[MIT](LICENSE) © BeeeFX. Not affiliated with Anthropic.
