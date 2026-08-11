import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@anicode/core";
import { createSessionEventBatcher } from "./useSession.js";

function textEvent(text: string): SessionEvent {
  return { type: "agent", event: { type: "text", text } };
}

function fakeFrames() {
  let nextId = 1;
  const callbacks = new Map<number, () => void>();
  return {
    schedule(callback: () => void): number {
      const id = nextId++;
      callbacks.set(id, callback);
      return id;
    },
    cancel(id: number): void {
      callbacks.delete(id);
    },
    runAll(): void {
      const pending = [...callbacks.values()];
      callbacks.clear();
      for (const callback of pending) callback();
    },
    get size(): number {
      return callbacks.size;
    },
  };
}

test("session event batcher: many adjacent text deltas cause one render update per frame", () => {
  const actions: unknown[] = [];
  const frames = fakeFrames();
  const batcher = createSessionEventBatcher(
    (action) => actions.push(action),
    (callback) => frames.schedule(callback),
    (id) => frames.cancel(id),
  );

  for (let i = 0; i < 1_000; i++) batcher.push(textEvent("x"));

  assert.equal(frames.size, 1);
  assert.equal(actions.length, 0);
  frames.runAll();
  assert.deepEqual(actions, [{ t: "live", delta: "x".repeat(1_000) }]);
});

test("session event batcher: a boundary flushes text first and preserves event ordering", () => {
  const actions: unknown[] = [];
  const frames = fakeFrames();
  const batcher = createSessionEventBatcher(
    (action) => actions.push(action),
    (callback) => frames.schedule(callback),
    (id) => frames.cancel(id),
  );

  batcher.push(textEvent("hello"));
  batcher.push({ type: "state", running: false });

  assert.equal(frames.size, 0);
  assert.deepEqual(actions, [
    { t: "live", delta: "hello" },
    { t: "running", v: false },
    { t: "flushLive" },
  ]);
});

test("session event batcher: close drops a pending frame and future events", () => {
  const actions: unknown[] = [];
  const frames = fakeFrames();
  const batcher = createSessionEventBatcher(
    (action) => actions.push(action),
    (callback) => frames.schedule(callback),
    (id) => frames.cancel(id),
  );

  batcher.push(textEvent("stale"));
  batcher.close();
  batcher.push(textEvent("ignored"));
  frames.runAll();

  assert.equal(frames.size, 0);
  assert.deepEqual(actions, []);
});
