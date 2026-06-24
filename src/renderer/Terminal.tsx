import { useEffect, useRef } from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TermStartOpts } from "./types";

/**
 * An xterm.js view bound to a main-process pty running Claude Code. Mounted with
 * a `key` so a "restart" simply remounts it with a fresh session. The pty's bytes
 * stream in over IPC; keystrokes stream back out.
 */
export function TerminalView({
  opts,
  onExit,
  onReady,
}: {
  opts: TermStartOpts;
  onExit?: () => void;
  onReady?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Xterm({
      fontFamily: "'JetBrains Mono', 'Cascadia Code', 'SF Mono', Menlo, Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#16131e",
        foreground: "#ece9f3",
        cursor: "#a78bfa",
        selectionBackground: "rgba(167,139,250,0.3)",
        black: "#2a2438",
        brightBlack: "#6f667f",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* not laid out yet */
    }
    term.focus();

    let disposed = false;
    let id: number | null = null;
    const unsubs: Array<() => void> = [];

    void (async () => {
      const res = await window.poly.terminal.start({ ...opts, cols: term.cols, rows: term.rows });
      if (!res.ok) {
        term.writeln("");
        term.writeln(`  \x1b[33mEmbedded terminal unavailable\x1b[0m: ${res.error}`);
        term.writeln("  Use \x1b[36mLaunch in terminal\x1b[0m instead.");
        return;
      }
      if (disposed) {
        window.poly.terminal.kill(res.id);
        return;
      }
      id = res.id;
      let readyFired = false;
      unsubs.push(
        window.poly.terminal.onData((p) => {
          if (p.id !== id) return;
          term.write(p.data);
          if (!readyFired) {
            readyFired = true;
            onReady?.(); // first output → the session is up (clears any "switching…" overlay)
          }
        })
      );
      unsubs.push(
        window.poly.terminal.onExit((p) => {
          if (p.id === id) {
            term.writeln("\r\n\x1b[90m[session ended — press Restart or New session]\x1b[0m");
            onExit?.();
          }
        })
      );
      term.onData((d) => {
        if (id != null) window.poly.terminal.write(id, d);
      });
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        if (id != null) window.poly.terminal.resize(id, term.cols, term.rows);
      } catch {
        /* mid-teardown */
      }
    });
    ro.observe(host);

    // Image paste: xterm only forwards text, so intercept (capture phase, before
    // xterm) — if the clipboard holds an image, save it to a temp file and type
    // its path into the pty, which Claude Code loads as an image.
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.startsWith("image/")) {
          e.preventDefault();
          e.stopPropagation();
          const file = items[i].getAsFile();
          if (!file) return;
          void file.arrayBuffer().then(async (ab) => {
            const p = await window.poly.clipboard.saveImage(new Uint8Array(ab));
            if (p && id != null) window.poly.terminal.write(id, p + " ");
          });
          return;
        }
      }
    };
    host.addEventListener("paste", onPaste, true);

    return () => {
      disposed = true;
      ro.disconnect();
      host.removeEventListener("paste", onPaste, true);
      unsubs.forEach((u) => u());
      if (id != null) window.poly.terminal.kill(id);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="term-host" ref={hostRef} />;
}
