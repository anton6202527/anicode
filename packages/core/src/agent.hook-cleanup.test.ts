import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { commandHook } from "./hooks-exec.js";
import { HookExecutionBoundaryError } from "./hooks.js";
import {
  RuntimeTerminationError,
  type ExecutionRuntime,
  type IsolatedRunRequest,
} from "./runtime/isolated-runtime.js";
import type { Provider, StreamEvent } from "./types.js";

const completedProvider: Provider = {
  name: "completed",
  async *stream(): AsyncIterable<StreamEvent> {
    yield {
      type: "done",
      stopReason: "end_turn",
      message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

function failingCleanupRuntime(): {
  runtime: ExecutionRuntime;
  started: Promise<void>;
  aborted: Promise<void>;
  releaseCleanup: () => void;
} {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => (markAborted = resolve));
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
  const runtime: ExecutionRuntime = {
    async run(request: IsolatedRunRequest) {
      markStarted();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      markAborted();
      await cleanupGate;
      throw new RuntimeTerminationError();
    },
  };
  return { runtime, started, aborted, releaseCleanup };
}

function isTerminationBoundary(error: unknown): boolean {
  return (
    error instanceof HookExecutionBoundaryError && error.cause instanceof RuntimeTerminationError
  );
}

test("Agent.send: abort waits for command-hook cleanup proof and propagates failure", async () => {
  const boundary = failingCleanupRuntime();
  const controller = new AbortController();
  const agent = new Agent({
    provider: completedProvider,
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    hooks: [
      commandHook(
        { event: "Stop", command: "project-hook" },
        { executionRuntime: boundary.runtime },
      ),
    ],
  });

  const drain = (async () => {
    for await (const _ of agent.send("run", controller.signal)) void _;
  })();
  await boundary.started;
  controller.abort(new Error("cancel drive"));
  await boundary.aborted;

  let settled = false;
  void drain.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "drive must retain its durable fence until cleanup proof settles");

  boundary.releaseCleanup();
  await assert.rejects(drain, isTerminationBoundary);
  assert.equal(agent.isRunning, false);
  await assert.rejects(agent.awaitToolExecutionsIdle(), isTerminationBoundary);
  await assert.rejects(agent.closeToolResources(), isTerminationBoundary);
});

test("Agent.compactNow: budget abort drains close-confirmed command hook before rejecting", async () => {
  const boundary = failingCleanupRuntime();
  const agent = new Agent({
    provider: completedProvider,
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    runBudget: { maxWallTimeMs: 10 },
    compaction: {
      summarizer: async () => "summary",
    },
    hooks: [
      commandHook(
        { event: "PreCompact", command: "project-hook" },
        { executionRuntime: boundary.runtime },
      ),
    ],
  });

  const compact = agent.compactNow();
  await boundary.started;
  await boundary.aborted;

  let settled = false;
  void compact.then(
    () => (settled = true),
    () => (settled = true),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "compactNow must retain the hook cleanup proof fence");

  boundary.releaseCleanup();
  await assert.rejects(compact, isTerminationBoundary);
});
