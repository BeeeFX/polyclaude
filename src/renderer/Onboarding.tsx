import { useState, type ReactNode } from "react";
import { Mascot } from "./Mascot";

/**
 * First-run / empty-state screen, shown whenever there are no accounts (first
 * launch, or after deleting them all). A few quick intro slides lead to a
 * "connect your Claude account" screen; signing in links the first account and
 * the app transitions to its normal layout. Returning users (who've seen the
 * intro before) skip straight to the connect screen.
 */

const SLIDES = [
  {
    title: "Welcome to polyclaude",
    body: "Keep all your Claude accounts in one place — and switch between them without losing your conversation.",
  },
  {
    title: "Switch in a click",
    body: "Hit a limit? Flip to another account and keep going. Your chat continues; only who's billed changes.",
  },
  {
    title: "Stay ahead of limits",
    body: "Watch each account's 5-hour and weekly usage at a glance, and let polyclaude auto-switch when one runs out.",
  },
];

interface Props {
  version: string;
  /** A sign-in terminal session is live (show the embedded login). */
  connecting: boolean;
  /** Capturing the freshly signed-in account (brief spinner before the app loads). */
  finishing: boolean;
  termAvailable: boolean;
  /** The embedded sign-in terminal, rendered while connecting. */
  terminal: ReactNode;
  onConnect: () => void;
  onCancel: () => void;
}

export function Onboarding({ version, connecting, finishing, termAvailable, terminal, onConnect, onCancel }: Props) {
  // Skip the intro for returning users (e.g. they deleted all their accounts).
  const seen = typeof localStorage !== "undefined" && localStorage.getItem("poly.onboarded") === "1";
  const [slide, setSlide] = useState(seen ? SLIDES.length : 0);
  const markSeen = () => {
    try {
      localStorage.setItem("poly.onboarded", "1");
    } catch {
      /* ignore */
    }
  };

  if (finishing) {
    return (
      <div className="onboard">
        <div className="onboard-card center" key="finishing">
          <div className="mascot-pulse">
            <Mascot size={56} />
          </div>
          <h2>Setting things up…</h2>
          <p className="muted">Linking your account.</p>
        </div>
      </div>
    );
  }

  if (connecting) {
    return (
      <div className="onboard">
        <div className="onboard-card connecting" key="connecting">
          <div className="onboard-head">
            <span className="logo">
              <Mascot size={30} />
            </span>
            <div className="onboard-head-text">
              <h2>Sign in to Claude</h2>
              <p className="muted small">A browser window opens to sign in. Come back here when you're done.</p>
            </div>
          </div>
          <div className="onboard-term">{terminal}</div>
          <button className="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const onConnectScreen = slide >= SLIDES.length;

  return (
    <div className="onboard">
      <div className="onboard-card" key={onConnectScreen ? "connect" : `slide-${slide}`}>
        {onConnectScreen ? (
          <div className="onboard-connect">
            <div className="logo big">
              <Mascot size={76} />
            </div>
            <h1>polyclaude</h1>
            <p className="muted lead">Connect your Claude account to get started.</p>
            <button className="primary big" onClick={() => { markSeen(); onConnect(); }}>
              Connect Claude account
            </button>
            {!termAvailable && (
              <p className="muted small">
                Or run <code>pcc login</code> in a terminal to sign in.
              </p>
            )}
            {!seen && (
              <button className="link" onClick={() => setSlide(0)}>
                ← Back to intro
              </button>
            )}
          </div>
        ) : (
          <div className="onboard-slide">
            <div className="logo">
              <Mascot size={60} />
            </div>
            <h1>{SLIDES[slide].title}</h1>
            <p className="lead">{SLIDES[slide].body}</p>
            <div className="onboard-dots">
              {SLIDES.map((_, i) => (
                <span key={i} className={`odot ${i === slide ? "on" : ""}`} />
              ))}
            </div>
            <div className="onboard-nav">
              <button className="link" onClick={() => { markSeen(); setSlide(SLIDES.length); }}>
                Skip
              </button>
              <button className="primary" onClick={() => setSlide(slide + 1)}>
                {slide === SLIDES.length - 1 ? "Get started" : "Next"}
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="onboard-foot muted small">v{version}</div>
    </div>
  );
}
