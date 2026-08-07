import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createTerminalCaretOutput, RESET_FULLSCREEN_VIEWPORT } from "./terminal-caret.js";

class MutableTty extends EventEmitter {
  readonly isTTY = true;
  rows = 24;
  columns = 80;
  readonly chunks: string[] = [];

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    return true;
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

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

test("terminal caret: resize clears the old viewport and repaints before parking the caret", () => {
  const raw = new MutableTty();
  const caret = createTerminalCaretOutput(raw as unknown as NodeJS.WriteStream, {
    resetOnResize: true,
  });
  caret.controller.setTarget({ row: 12, col: 11 });
  raw.chunks.length = 0;

  raw.resize(120, 40);
  assert.deepEqual(raw.chunks, ["\x1b[?25l\x1b[24;1H"]);

  caret.output.write("\x1b[?2026h");
  caret.output.write("\x1b[?25l");
  caret.output.write(Array.from({ length: 40 }, (_, index) => `FRAME-${index}`).join("\n"));
  caret.output.write("\x1b[?2026l");

  assert.deepEqual(raw.chunks, [
    "\x1b[?25l\x1b[24;1H",
    "\x1b[?2026h",
    "\x1b[?25l",
    RESET_FULLSCREEN_VIEWPORT,
    Array.from({ length: 40 }, (_, index) => `FRAME-${index}`).join("\n"),
    "\x1b[?2026l",
    "\x1b[12;11H\x1b[?25h",
  ]);

  raw.chunks.length = 0;
  caret.output.write("NEXT");
  assert.deepEqual(raw.chunks, ["\x1b[?25l\x1b[40;1H", "NEXT", "\x1b[12;11H\x1b[?25h"]);
  caret.controller.dispose();
  assert.equal(raw.listenerCount("resize"), 0);
});

test("terminal caret: primary-screen resize preserves scrollback and the old frame anchor", () => {
  const raw = new MutableTty();
  const caret = createTerminalCaretOutput(raw as unknown as NodeJS.WriteStream);
  caret.controller.setTarget({ row: 10, col: 7 });
  raw.chunks.length = 0;

  raw.resize(120, 40);
  caret.output.write(Array.from({ length: 40 }, () => "FRAME").join("\n"));

  assert.equal(raw.chunks[0], "\x1b[?25l\x1b[24;1H");
  assert.equal(raw.chunks.includes(RESET_FULLSCREEN_VIEWPORT), false);
  caret.controller.dispose();
});
