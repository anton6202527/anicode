import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminalCaretOutput } from "./terminal-caret.js";

test("terminal caret: each Ink write starts at the bottom and ends at the absolute IME cell", () => {
  const chunks: string[] = [];
  const raw = {
    isTTY: true,
    rows: 24,
    columns: 80,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream;
  const caret = createTerminalCaretOutput(raw);

  caret.controller.setTarget({ row: 12, col: 11 });
  assert.equal(chunks.pop(), "\x1b[12;11H\x1b[?25h");

  caret.output.write("FRAME");
  assert.deepEqual(chunks, ["\x1b[?25l\x1b[24;1H", "FRAME", "\x1b[12;11H\x1b[?25h"]);

  chunks.length = 0;
  caret.controller.pause();
  caret.output.write("EDITOR");
  assert.deepEqual(chunks, ["\x1b[?25l\x1b[24;1H", "EDITOR"]);
  caret.controller.resume();
  assert.equal(chunks.at(-1), "\x1b[12;11H\x1b[?25h");

  caret.controller.dispose();
  caret.controller.dispose();
  chunks.length = 0;
  caret.output.write("DONE");
  assert.deepEqual(chunks, ["DONE"]);
});
