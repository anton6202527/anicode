/**
 * Harness 自测（离线，无需真实模型）：用脚本化 provider 驱动真实 agent loop，
 * 证明「编辑 → 校验 → 指标」这条管线本身是对的，并能区分通过/未通过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Provider, StreamEvent, ChatMessage } from "@anicode/core";
import { BUILTIN_TASKS } from "./tasks/builtin.js";
import { runTask } from "./runner.js";
import { summarize, formatReport } from "./report.js";

/** 每次 stream() 吐出脚本里的下一条 assistant 消息（含 tool_call 时 stopReason=tool_use）。 */
function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
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
});

test("report: summarize/formatReport 汇总正确", () => {
  const sum = summarize("scripted", [
    {
      id: "a",
      title: "A",
      passed: true,
      turns: 2,
      toolCalls: 1,
      editCalls: 1,
      editErrors: 0,
      toolErrors: 0,
      inputTokens: 10,
      outputTokens: 4,
      wallMs: 100,
    },
    {
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
    },
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
});
