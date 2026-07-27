/**
 * Agent 级后台任务集成：验证完成通知的两条注入路径 ——
 *   A) 空闲期完成 → 积压，下一次 send 开始时注入（bare Agent 无 onTaskNotice 出口）；
 *   B) drive 运行中完成 → turn 边界注入，模型当轮消化（loop 因通知续跑一轮）。
 * 父/子共用一个 provider，按 req.system 是否含子 agent 提示词分流脚本。全离线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import type { Provider, StreamEvent, StreamRequest, ChatMessage } from "./types.js";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function done(content: ChatMessage["content"], stop: "tool_use" | "end_turn"): StreamEvent {
  return {
    type: "done",
    stopReason: stop,
    message: { role: "assistant", content },
    usage: zero,
  };
}

/** 父 Agent 显式 system="PARENT"；非 PARENT 开头的请求即子 agent（默认子提示词）。 */
function isChildReq(req: StreamRequest): boolean {
  return !(req.system ?? "").startsWith("PARENT");
}

test("后台任务空闲期完成：通知积压，下一次 send 注入并广播 task_notice", async () => {
  let parentTurn = 0;
  const parentSeen: StreamRequest[] = [];
  let releaseChild!: () => void;
  const childGate = new Promise<void>((r) => (releaseChild = r));

  const provider: Provider = {
    name: "p",
    async *stream(req): AsyncIterable<StreamEvent> {
      if (isChildReq(req)) {
        await childGate; // 压住子 agent，确保父 drive 先收尾（空闲路径）
        yield done([{ type: "text", text: "孩子结论X" }], "end_turn");
        return;
      }
      parentSeen.push({ ...req, messages: structuredClone(req.messages) });
      const turn = parentTurn++;
      if (turn === 0) {
        yield done(
          [
            {
              type: "tool_call",
              id: "c1",
              name: "task",
              args: { description: "后台活", prompt: "去干", background: true },
            },
          ],
          "tool_use",
        );
      } else {
        yield done([{ type: "text", text: `第${turn}轮收尾` }], "end_turn");
      }
    },
  };

  const agent = new Agent({
    provider,
    model: "m",
    cwd: "/x",
    system: "PARENT",
    subagents: true,
    injectEnv: false,
    projectMemory: false,
    permission: { mode: "auto" },
  });
  for await (const _ of agent.send("开始")) {
    /* drive 1 */
  }
  assert.equal(agent.backgroundTasks.length, 1);

  releaseChild();
  // 等后台任务收尾（无 onTaskNotice 出口 → 通知积压在 Agent 内部）
  while (agent.backgroundTasks[0]!.status === "running") await new Promise((r) => setTimeout(r, 5));
  assert.equal(agent.backgroundTasks[0]!.status, "done");

  const events: string[] = [];
  for await (const ev of agent.send("下一步")) {
    events.push(ev.type);
  }
  assert.ok(events.includes("task_notice"), "第二次 drive 应广播 task_notice");
  const lastReq = parentSeen.at(-1)!;
  const flat = lastReq.messages
    .flatMap((m) => m.content)
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  assert.match(flat, /<task-notification id="t1">/, "模型应看到通知信封");
  assert.match(flat, /孩子结论X/);
});

test("后台任务 drive 中完成：turn 边界注入，loop 续跑让模型当轮消化", async () => {
  let parentTurn = 0;
  const parentSeen: StreamRequest[] = [];
  let releaseChild!: () => void;
  const childGate = new Promise<void>((r) => (releaseChild = r));
  let childDone!: () => void;
  const childDoneGate = new Promise<void>((r) => (childDone = r));

  const provider: Provider = {
    name: "p",
    async *stream(req): AsyncIterable<StreamEvent> {
      if (isChildReq(req)) {
        await childGate;
        yield done([{ type: "text", text: "孩子结论Y" }], "end_turn");
        childDone();
        return;
      }
      parentSeen.push({ ...req, messages: structuredClone(req.messages) });
      const turn = parentTurn++;
      if (turn === 0) {
        yield done(
          [
            {
              type: "tool_call",
              id: "c1",
              name: "task",
              args: { description: "后台活", prompt: "去干", background: true },
            },
          ],
          "tool_use",
        );
      } else if (turn === 1) {
        // 模拟父 agent 干别的活儿期间子任务完成：放行子 agent 并等它收尾，
        // 通知在本轮结束前进入 noticeQueue → turn 边界注入。
        releaseChild();
        await childDoneGate;
        await new Promise((r) => setTimeout(r, 20)); // 等 finish/notify 异步链走完
        yield done([{ type: "text", text: "本想收尾" }], "end_turn");
      } else {
        yield done([{ type: "text", text: "消化了通知" }], "end_turn");
      }
    },
  };

  const agent = new Agent({
    provider,
    model: "m",
    cwd: "/x",
    system: "PARENT",
    subagents: true,
    injectEnv: false,
    projectMemory: false,
    permission: { mode: "auto" },
  });
  const events: string[] = [];
  for await (const ev of agent.send("开始")) {
    events.push(ev.type);
  }
  assert.ok(events.includes("task_notice"), "同一 drive 内应广播 task_notice");
  assert.equal(parentTurn, 3, "通知注入后 loop 应续跑一轮");
  const lastReq = parentSeen.at(-1)!;
  const flat = lastReq.messages
    .flatMap((m) => m.content)
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  assert.match(flat, /孩子结论Y/, "续跑的一轮应看到通知内容");
});
