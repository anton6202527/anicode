/**
 * 并行子代理：验证父 agent 把多个只读（readOnly）task 调用真正并发 fan-out。
 * 用一个会记录「同时进行的 stream 数」的子 provider，若并行则峰值=2，串行则=1。全离线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "./agent.js";
import type { Provider, StreamEvent, AgentResolvedModel } from "./index.js";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 父 provider：第 1 轮发两个 explore task 调用，第 2 轮收尾。 */
function parentProvider(subagentType: string): Provider {
  let turn = 0;
  return {
    name: "parent",
    async *stream(): AsyncIterable<StreamEvent> {
      const t = turn++;
      if (t === 0) {
        const content = [
          {
            type: "tool_call" as const,
            id: "c1",
            name: "task",
            args: { description: "调研A", prompt: "A", subagent_type: subagentType },
          },
          {
            type: "tool_call" as const,
            id: "c2",
            name: "task",
            args: { description: "调研B", prompt: "B", subagent_type: subagentType },
          },
        ];
        yield {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", content },
          usage: zero,
        };
      } else {
        yield {
          type: "done",
          stopReason: "end_turn",
          message: { role: "assistant", content: [{ type: "text", text: "汇总完成" }] },
          usage: zero,
        };
      }
    },
  };
}

/** 子 provider：记录并发峰值。 */
function trackingChildProvider(state: { active: number; max: number }): Provider {
  return {
    name: "child",
    async *stream(): AsyncIterable<StreamEvent> {
      state.active++;
      state.max = Math.max(state.max, state.active);
      try {
        await delay(40);
        yield {
          type: "done",
          stopReason: "end_turn",
          message: { role: "assistant", content: [{ type: "text", text: "child ok" }] },
          usage: zero,
        };
      } finally {
        state.active--;
      }
    },
  };
}

async function runWith(readOnly: boolean): Promise<number> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-par-"));
  try {
    const state = { active: 0, max: 0 };
    const child = trackingChildProvider(state);
    const parent = parentProvider("worker");
    const resolveModel = (spec: string): AgentResolvedModel =>
      spec === "track/model"
        ? { provider: child, model: "model" }
        : { provider: parent, model: "scripted" };

    const agent = new Agent({
      provider: parent,
      model: "scripted",
      cwd: dir,
      projectMemory: false,
      injectEnv: false,
      permission: { mode: "auto" },
      resolveModel,
      subagents: [{ name: "worker", description: "调研", readOnly, model: "track/model" }],
    });

    for await (const _ of agent.send("并行调研")) {
      /* drain */
    }
    return state.max;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("并行子代理: 只读 task 并发 fan-out（峰值并发=2）", async () => {
  const max = await runWith(true);
  assert.equal(max, 2, "两个只读子 agent 应并行执行");
});

test("并行子代理: 非只读 task 保持串行（峰值并发=1）", async () => {
  const max = await runWith(false);
  assert.equal(max, 1, "非只读子 agent 必须串行");
});
