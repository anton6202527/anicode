import { test } from "node:test";
import assert from "node:assert/strict";
import { HookRunner, type HookRegistration } from "./hooks.js";

test("HookRunner: matcher 命中，updatedInput 链式传递并拼接 context", async () => {
  const seen: Record<string, unknown>[] = [];
  let unmatchedCalled = false;
  const registrations: HookRegistration[] = [
    {
      event: "PreToolUse",
      matcher: "ba*",
      handler(payload) {
        seen.push(payload.toolInput!);
        return {
          updatedInput: { command: "git status", stage: 1 },
          additionalContext: "first context",
        };
      },
    },
    {
      event: "PreToolUse",
      matcher: "bash",
      handler(payload) {
        seen.push(payload.toolInput!);
        return {
          decision: "allow",
          updatedInput: { ...payload.toolInput, stage: 2 },
          additionalContext: "second context",
        };
      },
    },
    {
      event: "PreToolUse",
      matcher: "read",
      handler() {
        unmatchedCalled = true;
      },
    },
  ];

  const outcome = await new HookRunner(registrations).run({
    event: "PreToolUse",
    cwd: "/tmp/project",
    toolName: "bash",
    toolInput: { command: "npm test" },
  });

  assert.deepEqual(seen, [{ command: "npm test" }, { command: "git status", stage: 1 }]);
  assert.equal(unmatchedCalled, false);
  assert.deepEqual(outcome, {
    blocked: false,
    allowed: true,
    updatedInput: { command: "git status", stage: 2 },
    additionalContext: "first context\nsecond context",
  });
});

test("HookRunner: block 一票否决、保留此前 context，并停止后续 hook", async () => {
  const calls: string[] = [];
  const runner = new HookRunner([
    {
      event: "PostToolUse",
      handler() {
        calls.push("first");
        return { decision: "allow", additionalContext: "before block" };
      },
    },
    {
      event: "PostToolUse",
      handler() {
        calls.push("block");
        return { decision: "block", reason: "result rejected" };
      },
    },
    {
      event: "PostToolUse",
      handler() {
        calls.push("never");
        return { additionalContext: "after block" };
      },
    },
  ]);

  const outcome = await runner.run({
    event: "PostToolUse",
    cwd: "/tmp/project",
    toolName: "write",
    toolInput: { path: "a.ts" },
    toolResult: "ok",
    isError: false,
  });

  assert.deepEqual(calls, ["first", "block"]);
  assert.deepEqual(outcome, {
    blocked: true,
    allowed: false,
    reason: "result rejected",
    additionalContext: "before block",
  });
});

test("HookRunner: 单个 hook 抛错时隔离异常并继续执行", async () => {
  let afterThrowCalled = false;
  const runner = new HookRunner([
    {
      event: "Stop",
      async handler() {
        throw new Error("hook exploded");
      },
    },
    {
      event: "Stop",
      handler() {
        afterThrowCalled = true;
        return { additionalContext: "still running" };
      },
    },
  ]);

  const outcome = await runner.run({ event: "Stop", cwd: "/tmp/project" });

  assert.equal(afterThrowCalled, true);
  assert.deepEqual(outcome, {
    blocked: false,
    allowed: false,
    additionalContext: "still running",
  });
});
