import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render } from "ink-testing-library";
import { MarkdownText } from "./markdown.js";

test("MarkdownText: headings, inline styles and fenced code remain readable", async () => {
  const view = render(
    <MarkdownText text={"# Title\n- **bold** and `code`\n```ts\nconst x = 1\n```"} />,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Title/);
  assert.match(frame, /bold and code/);
  assert.match(frame, /┌─ ts/);
  assert.match(frame, /const x = 1/);
  view.unmount();
});

test("MarkdownText: terminal control sequences are stripped", async () => {
  const view = render(<MarkdownText text={"safe\u001b]52;c;secret\u0007 text"} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(view.lastFrame(), "safe text");
  view.unmount();
});

test("MarkdownText: prose rows are spaced while table rows stay compact", async () => {
  const view = render(<MarkdownText text={"Summary\nDetails\n| A | B |\n| - | - |\n| 1 | 2 |"} />);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const lines = (view.lastFrame() ?? "").split("\n");
  assert.equal(lines[0], "Summary");
  assert.equal(lines[1]?.trim(), "");
  assert.equal(lines[2], "Details");
  assert.equal(lines[3]?.trim(), "");
  assert.deepEqual(lines.slice(4), ["| A | B |", "| - | - |", "| 1 | 2 |"]);
  view.unmount();
});
