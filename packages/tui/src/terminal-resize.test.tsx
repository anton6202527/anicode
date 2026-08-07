import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import React from "react";
import { Box, Text, render, useWindowSize } from "ink";
import { fullscreenViewportOutput, TUI_INCREMENTAL_RENDERING } from "./cli.js";
import { createTerminalCaretOutput, RESET_FULLSCREEN_VIEWPORT } from "./terminal-caret.js";

class MutableOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 80;
  rows = 24;
  readonly chunks: string[] = [];
  destroyed = false;
  writable = true;
  writableEnded = false;

  write(
    chunk: string | Buffer,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
    const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    done?.();
    return true;
  }

  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit("resize");
  }
}

class TestInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  readonly destroyed = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  read(): null {
    return null;
  }
}

function ResizeProbe() {
  const { columns, rows } = useWindowSize();
  return (
    <Box width={columns} height={rows} flexDirection="column">
      <Text>{`ANICODE ${columns}x${rows}`}</Text>
      <Box flexGrow={1} />
      <Text>COMPOSER</Text>
    </Box>
  );
}

test("terminal resize: growing the alternate viewport resets and writes one complete frame", async () => {
  const raw = new MutableOutput();
  const stderr = new MutableOutput();
  const fullscreen = fullscreenViewportOutput(raw as unknown as NodeJS.WriteStream, true);
  const terminal = createTerminalCaretOutput(fullscreen, {
    enabled: false,
    resetOnResize: true,
  });
  const input = new TestInput();
  const instance = render(<ResizeProbe />, {
    stdout: terminal.output,
    stdin: input as unknown as NodeJS.ReadStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    alternateScreen: true,
    incrementalRendering: TUI_INCREMENTAL_RENDERING,
    interactive: true,
    patchConsole: false,
    exitOnCtrlC: false,
    maxFps: 1_000,
  });

  try {
    await instance.waitUntilRenderFlush();
    for (const [columns, rows] of [
      [120, 40],
      [56, 18],
      [110, 32],
    ] as const) {
      const start = raw.chunks.length;
      raw.resize(columns, rows);
      await instance.waitUntilRenderFlush();
      const resizeChunks = raw.chunks.slice(start);
      assert.ok(
        resizeChunks.includes(RESET_FULLSCREEN_VIEWPORT),
        `missing viewport reset at ${columns}x${rows}`,
      );
      const frame = resizeChunks
        .filter((chunk) => chunk.includes(`ANICODE ${columns}x${rows}`))
        .sort((left, right) => right.length - left.length)[0];
      assert.ok(frame, `missing resized frame at ${columns}x${rows}`);
      assert.equal(
        frame.split("\n").length,
        rows,
        `resize at ${columns}x${rows} must repaint the complete viewport`,
      );
      assert.equal(frame.match(/ANICODE/g)?.length, 1);
      assert.equal(frame.match(/COMPOSER/g)?.length, 1);
    }
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    terminal.controller.dispose();
  }
});
