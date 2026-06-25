# Changelog

## 0.2.0

Desktop app ships as real installers, with an optional bundled CLI.

- **Installers for Windows, macOS, and Linux** built in CI (`electron-builder`).
  Push a `v*` tag → a draft GitHub Release is filled with `.exe` (NSIS), `.dmg` +
  `.zip` (arm64/x64), and `.AppImage` artifacts.
- **Optional command-line tools** — the Windows installer asks whether to also
  install `pcc` / `polyclaude` on your PATH; macOS/Windows users can do the same
  with one click from the new *Command-line tool* card in the app. The shims run
  the app's own binary in Node mode, so there's no separate Node/npm install.
- **Account management in the desktop sidebar** — right-click to rename, re-login,
  add, or delete an account, and drag to reorder. Order persists.
- **Fix:** team/enterprise accounts were mislabeled "Pro" — the plan now reflects
  the active organization, not a personal Pro entitlement.
- CLI `--version` now tracks `package.json` instead of a hard-coded string.

## 0.1.0

Initial release: encrypted multi-account vault, one-key switching, live 5h/7d
usage, auto-fail-over with session resume, TUI dashboard, status-line integration,
and a desktop app (Electron) with an embedded Claude Code terminal.
