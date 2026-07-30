import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizeTerminalText } from "./terminal-text.js";

test("terminal sanitizer removes CSI, OSC and control strings", () => {
  const hostile = [
    "before",
    "\x1b]52;c;SGVsbG8=\x07",
    "\x1b]8;;https://evil.invalid\x1b\\link\x1b]8;;\x1b\\",
    "\x1b[2J\x1b[H\x1b[31mred\x1b[0m",
    "\x1bPmalicious-dcs\x1b\\",
    "\x1b_hidden-apc\x1b\\",
    "after",
  ].join("");
  assert.equal(sanitizeTerminalText(hostile), "beforelinkredafter");
});

test("terminal sanitizer removes C0/C1, bidi spoofing and unterminated controls", () => {
  assert.equal(sanitizeTerminalText("a\rb\bc\x7fd\u202ee\u2066f"), "abcdef");
  assert.equal(sanitizeTerminalText("safe\x1b]0;hidden title"), "safe");
  assert.equal(sanitizeTerminalText("safe\u009b2Jvisible"), "safevisible");
});

test("terminal sanitizer preserves newlines, tabs and Unicode graphemes", () => {
  const value = "第一行\n\t👨‍💻 e\u0301 🇨🇳";
  assert.equal(sanitizeTerminalText(value), value);
});
