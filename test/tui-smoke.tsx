import React from "react";
import { render } from "ink-testing-library";
import { App } from "../src/tui/app.js";

// Headless render smoke test: confirms the Ink dashboard mounts and renders
// without runtime errors, and that async data loading doesn't crash it.
// Run with: npm run smoke
const { lastFrame, unmount } = render(React.createElement(App, { result: {} }));

setTimeout(() => {
  const frame = lastFrame() ?? "";
  unmount();
  // Checks common to both the first-run welcome and the dashboard, so the test
  // is robust whether or not the vault has accounts.
  const checks = [
    ["wordmark", /polyclaude/],
    ["mascot", /██/],
    ["quit hint", /quit/],
  ] as const;
  let okAll = true;
  for (const [name, re] of checks) {
    const ok = re.test(frame);
    okAll = okAll && ok;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  }
  console.log(okAll ? "\nTUI render: OK" : "\nTUI render: FAILED");
  process.exit(okAll ? 0 : 1);
}, 1800);
