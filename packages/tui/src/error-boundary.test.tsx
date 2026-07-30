import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { TuiErrorBoundary } from "./error-boundary.js";

function Crash(): React.ReactNode {
  throw new Error("boom\u001b]52;c;secret\u0007");
}

test("TUI error boundary: renders a safe fallback and reports diagnostics", async () => {
  const original = console.error;
  console.error = () => {};
  let reported: Error | undefined;
  try {
    const view = render(
      <TuiErrorBoundary onError={(error) => (reported = error)}>
        <Crash />
      </TuiErrorBoundary>,
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const frame = view.lastFrame() ?? "";
    assert.match(frame, /unexpected rendering error/);
    assert.match(frame, /boom/);
    assert.doesNotMatch(frame, /\u001b]52/);
    assert.equal(reported?.message.includes("boom"), true);
    view.unmount();
  } finally {
    console.error = original;
  }
});
