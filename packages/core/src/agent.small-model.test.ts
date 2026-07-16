/**
 * 小模型路由测试：配置 smallModel 时，压缩摘要这类杂活应走小模型而非主模型；
 * 小模型解析失败时静默回退主模型。全离线（脚本化 provider）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, type AgentEvent } from "./agent.js";
import { scriptedProvider } from "./testutil/scripted-provider.js";
import type { ChatMessage } from "./types.js";

async function drive(agent: Agent, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const e of agent.send(text)) events.push(e);
  return events;
}

const reply = (text: string): ChatMessage[] => [
  { role: "assistant", content: [{ type: "text", text }] },
];

test("Agent: 配置 smallModel 时，压缩摘要走小模型", async () => {
  const main = scriptedProvider([reply("好的一"), reply("好的二"), reply("好的三")]);
  const small = scriptedProvider([reply("[摘要] 关键点")]);
  const agent = new Agent({
    provider: main,
    model: "main",
    cwd: process.cwd(),
    resolveModel: (spec) =>
      spec === "small/x" ? { provider: small, model: "x" } : { provider: main, model: spec },
    smallModel: "small/x",
    compaction: { triggerTokens: 5, keepRecentMessages: 1 },
  });

  await drive(agent, "第一条消息".repeat(10));
  await drive(agent, "第二条消息".repeat(10));
  const evs = await drive(agent, "第三条消息".repeat(10));

  assert.ok(
    evs.some((e) => e.type === "compacted"),
    "应发生压缩",
  );
  assert.ok(small.calls.length >= 1, "摘要应调用小模型");
  // 主模型只用于对话回合，不应被用于摘要（其调用次数 = send 次数）。
  assert.equal(main.calls.length, 3);
});

test("Agent: smallModel 解析失败时静默回退主模型，压缩仍成功", async () => {
  const main = scriptedProvider([reply("一"), reply("二"), reply("三")]);
  const agent = new Agent({
    provider: main,
    model: "main",
    cwd: process.cwd(),
    // resolveModel 对小模型 spec 抛错 → 应回退主模型
    resolveModel: (spec) => {
      if (spec === "bad/model") throw new Error("无法解析");
      return { provider: main, model: spec };
    },
    smallModel: "bad/model",
    compaction: { triggerTokens: 5, keepRecentMessages: 1 },
  });

  await drive(agent, "第一条".repeat(10));
  await drive(agent, "第二条".repeat(10));
  const evs = await drive(agent, "第三条".repeat(10));

  assert.ok(
    evs.some((e) => e.type === "compacted"),
    "回退主模型后压缩仍应成功",
  );
  // 主模型承担了 3 个对话回合 + 1 次摘要 = 4 次。
  assert.equal(main.calls.length, 4);
});
