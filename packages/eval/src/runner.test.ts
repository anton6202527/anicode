/**
 * Harness 自测（离线，无需真实模型）：用脚本化 provider 驱动真实 agent loop，
 * 证明「编辑 → 校验 → 指标」这条管线本身是对的，并能区分通过/未通过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider, StreamEvent, ChatMessage } from "@anicode/core";
import { BUILTIN_TASKS } from "./tasks/builtin.js";
import { runTask, type TaskResult } from "./runner.js";
import { summarize, formatReport, mergeSummaries } from "./report.js";
import { validateNumericArgs } from "./cli.js";

/** 每次 stream() 吐出脚本里的下一条 assistant 消息（含 tool_call 时 stopReason=tool_use）。 */
function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      for (const part of content) {
        if (part.type === "text") yield { type: "text_delta", text: part.text };
        else if (part.type === "tool_call") {
          yield { type: "tool_call_start", id: part.id, name: part.name };
          yield { type: "tool_call_delta", id: part.id, argsText: JSON.stringify(part.args) };
          yield { type: "tool_call_end", part };
        }
      }
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

const addTask = BUILTIN_TASKS.find((t) => t.id === "implement-add")!;

test("harness: 正确编辑 → 任务通过，指标计数正确", async () => {
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "write",
            args: {
              path: "math.mjs",
              content: "export function add(a, b) {\n  return a + b;\n}\n",
            },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "已实现 add。" }] }],
  ]);

  const r = await runTask(addTask, { provider, model: "scripted", maxTurns: 5 });
  assert.equal(r.passed, true, `期望通过，实际未通过：${r.verifyOutput ?? r.error ?? ""}`);
  assert.ok(r.editCalls >= 1, "应记到至少一次编辑类工具调用");
  assert.equal(r.editErrors, 0, "正确编辑不应有编辑失败");
  assert.ok(r.turns >= 1);
  assert.ok(r.outputTokens > 0, "应从 done.usage 累计到 token");
  assert.equal(r.outcome.status, "passed");
  assert.equal(r.trajectory.completed, true);
  assert.equal(r.trajectory.calls[0]?.name, "write");
  assert.match(r.trajectory.calls[0]?.argumentsSha256 ?? "", /^[0-9a-f]{64}$/);
  assert.equal(r.finalResponse.present, true);
});

test("harness: 不做编辑 → 任务不通过，且编辑计数为 0", async () => {
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "我先不动手。" }] }],
  ]);
  const r = await runTask(addTask, { provider, model: "scripted", maxTurns: 5 });
  assert.equal(r.passed, false, "未实现 add，校验应失败");
  assert.equal(r.editCalls, 0);
});

test("harness: 错误编辑 → 任务不通过（校验区分对错）", async () => {
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "write",
            args: {
              path: "math.mjs",
              content: "export function add(a, b) {\n  return a - b;\n}\n",
            },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const r = await runTask(addTask, { provider, model: "scripted", maxTurns: 5 });
  assert.equal(r.passed, false, "a-b 的实现应让校验失败");
  assert.ok(r.editCalls >= 1);
  assert.equal(r.finalResponse.completionClaim, true);
  assert.equal(r.finalResponse.outcomeAligned, false);
});

test("harness: provider ignores abort but task returns at its deadline", async () => {
  const provider: Provider = {
    name: "never",
    async *stream(): AsyncIterable<StreamEvent> {
      yield* [];
      await new Promise<void>(() => undefined);
    },
  };
  const started = Date.now();
  const result = await runTask(addTask, { provider, model: "never", timeoutMs: 25 });
  assert.equal(result.outcome.status, "timeout");
  assert.ok(Date.now() - started < 500, "must not await a provider that ignores AbortSignal");
});

test("harness: verifier timeout kills a hung command", async () => {
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const task = {
    ...addTask,
    id: "verify-timeout",
    verify: { cmd: process.execPath, args: ["-e", "setTimeout(() => {}, 5000)"] },
  };
  const started = Date.now();
  const result = await runTask(task, {
    provider,
    model: "scripted",
    verifyTimeoutMs: 25,
  });
  assert.equal(result.outcome.status, "failed");
  assert.equal(result.outcome.exitCode, 124);
  assert.ok(Date.now() - started < 500, "verifier timeout should be hard");
});

test("eval CLI: rejects non-finite and out-of-range numeric input", () => {
  assert.throws(
    () => validateNumericArgs({ tolerance: Number.POSITIVE_INFINITY }),
    /finite number/,
  );
  assert.throws(() => validateNumericArgs({ trials: Number.NaN }), /integer/);
  assert.throws(() => validateNumericArgs({ shardCount: 2, shardIndex: 2 }), /shard-index/);
});

function result(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id: "a",
    title: "A",
    trial: 1,
    passed: true,
    turns: 1,
    toolCalls: 0,
    editCalls: 0,
    editErrors: 0,
    toolErrors: 0,
    inputTokens: 1,
    outputTokens: 1,
    wallMs: 1,
    outcome: { status: "passed", verified: true, evaluator: "command", exitCode: 0 },
    trajectory: {
      completed: true,
      retries: 0,
      fallbacks: 0,
      compactions: 0,
      verifications: 0,
      permissionDenials: 0,
      calls: [],
      signatureSha256: "a".repeat(64),
    },
    finalResponse: {
      present: true,
      chars: 4,
      sha256: "b".repeat(64),
      completionClaim: true,
      outcomeAligned: true,
    },
    ...overrides,
  };
}

test("report: summarize/formatReport 汇总正确", () => {
  const sum = summarize("scripted", [
    result({
      turns: 2,
      toolCalls: 1,
      editCalls: 1,
      inputTokens: 10,
      outputTokens: 4,
      wallMs: 100,
    }),
    result({
      id: "b",
      title: "B",
      passed: false,
      turns: 3,
      toolCalls: 2,
      editCalls: 1,
      editErrors: 1,
      toolErrors: 1,
      inputTokens: 20,
      outputTokens: 6,
      wallMs: 200,
      outcome: { status: "failed", verified: true, evaluator: "command", exitCode: 1 },
      finalResponse: {
        present: true,
        chars: 4,
        sha256: "c".repeat(64),
        completionClaim: true,
        outcomeAligned: false,
      },
    }),
  ]);
  assert.equal(sum.passed, 1);
  assert.equal(sum.total, 2);
  assert.equal(sum.passRate, 0.5);
  assert.equal(sum.avgTurns, 2.5);
  assert.equal(sum.editFailureRate, 0.5);
  assert.equal(sum.totalOutputTokens, 10);
  const text = formatReport(sum);
  assert.match(text, /通过率 1\/2/);
  assert.match(text, /编辑失败率 50%/);
  assert.ok(sum.passRateCi95.low < 0.5 && sum.passRateCi95.high > 0.5);
});

test("report: complete shards merge once and reject duplicate or missing shards", () => {
  const base = result();
  const settings = {
    suite: "real" as const,
    catalog: "catalog",
    catalogDigest: "c".repeat(64),
    expectedTaskIds: ["a"],
    runtimeImage: "image@sha256:abc",
    revision: "sha",
    shardCount: 2,
  };
  const first = summarize("model", [base], { ...settings, shardIndex: 0 });
  const second = summarize("model", [{ ...base, id: "b" }], {
    ...settings,
    shardIndex: 1,
    expectedTaskIds: ["b"],
  });
  assert.equal(mergeSummaries([first, second]).total, 2);
  assert.throws(() => mergeSummaries([first]), /Incomplete/);
  assert.throws(() => mergeSummaries([first, { ...second, results: [base] }]), /coverage mismatch/);
  assert.throws(
    () =>
      mergeSummaries([
        { ...first, settings: { ...first.settings, shardIndex: 2 } },
        { ...second, settings: { ...second.settings, shardIndex: 3 } },
      ]),
    /Incomplete/,
  );
  assert.throws(
    () =>
      mergeSummaries([
        { ...first, results: [{ ...base, turns: Number.POSITIVE_INFINITY }] },
        second,
      ]),
    /invalid turns/,
  );
  assert.throws(
    () =>
      mergeSummaries([
        {
          ...first,
          results: [
            {
              ...base,
              passed: false,
              outcome: { status: "passed", verified: true, evaluator: "command", exitCode: 0 },
            },
          ],
        },
        second,
      ]),
    /inconsistent deterministic outcome evidence/,
  );
  assert.throws(
    () =>
      mergeSummaries([
        {
          ...first,
          results: [
            {
              ...base,
              passed: false,
              skipped: true,
              outcome: { status: "skipped", verified: false, evaluator: "requirements" },
            },
          ],
        },
        second,
      ]),
    /skipped trials/,
  );
});

test("report: multi-trial stability distinguishes stable and flaky tasks", () => {
  const sum = summarize(
    "model",
    [
      result({ id: "stable", trial: 1 }),
      result({ id: "stable", trial: 2 }),
      result({ id: "flaky", trial: 1 }),
      result({
        id: "flaky",
        trial: 2,
        passed: false,
        outcome: { status: "failed", verified: true, evaluator: "command", exitCode: 1 },
      }),
    ],
    { suite: "offline", catalog: "offline", runtimeImage: "local", trials: 2 },
  );
  assert.equal(sum.taskCount, 2);
  assert.equal(sum.stability.stablePassRate, 0.5);
  assert.equal(sum.stability.flakyTaskRate, 0.5);
  assert.ok(sum.stability.trialPassRateStdDev > 0);
});
