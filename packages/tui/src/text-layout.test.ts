import assert from "node:assert/strict";
import test from "node:test";
import {
  clampGraphemeIndex,
  graphemes,
  nextGraphemeIndex,
  previousGraphemeIndex,
  sliceTerminalColumns,
  terminalWidth,
  truncateTerminalWidth,
} from "./text-layout.js";

test("text layout: complex Unicode sequences remain atomic", () => {
  const values = ["👨‍💻", "e\u0301", "🇨🇳", "👍🏽", "क्ष"];
  for (const value of values) {
    assert.equal(graphemes(value).length, 1, value);
    assert.equal(nextGraphemeIndex(value, 0), value.length, value);
    assert.equal(previousGraphemeIndex(value, value.length), 0, value);
    for (let i = 1; i < value.length; i++) assert.equal(clampGraphemeIndex(value, i), 0, value);
  }
});

test("text layout: display width uses terminal width semantics", () => {
  assert.equal(terminalWidth("abc"), 3);
  assert.equal(terminalWidth("中文"), 4);
  assert.equal(terminalWidth("👨‍💻"), 2);
  assert.equal(terminalWidth("e\u0301"), 1);
  assert.equal(terminalWidth("🇨🇳"), 2);
});

test("text layout: slicing and truncation never emit half a grapheme", () => {
  assert.equal(sliceTerminalColumns("a👨‍💻b", 1, 3), "👨‍💻");
  assert.equal(sliceTerminalColumns("a👨‍💻b", 2, 4), " b");
  assert.equal(truncateTerminalWidth("a👨‍💻b", 3), "a…");
});
