/**
 * per-prompt 模型覆盖：send(text, signal, { model }) 仅让这一次 drive 走覆盖模型，
 * 结束后还原主模型；解析失败给出错误事件且不动主配置。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { Agent, type AgentEvent } from "./agent.js";
import { scriptedProvider } from "./testutil/scripted-provider.js";
import type { ChatMessage } from "./types.js";

const text = (s: string): ChatMessage[] => [
  { role: "assistant", content: [{ type: "text", text: s }] },
];

async function collect(
  gen: AsyncGenerator<AgentEvent>,
): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

test("per-prompt 覆盖：该 drive 走覆盖 provider/model，下一次 send 还原主模型", async () => {
  const main = scriptedProvider([text("主模型答"), text("主模型答2")]);
  const alt = scriptedProvider([text("覆盖模型答")]);
  const agent = new Agent({
    provider: main,
    model: "main-model",
    cwd: os.tmpdir(),
    projectMemory: false,
    injectEnv: false,
    resolveModel: (spec) => {
      assert.equal(spec, "alt/fast");
      return { provider: alt, model: "fast" };
    },
  });

  // 第一条：覆盖 → 请求应打到 alt，且 model 字段为解析后的 "fast"
  await collect(agent.send("用快模型答", undefined, { model: "alt/fast" }));
  assert.equal(alt.calls.length, 1);
  assert.equal(alt.calls[0]!.model, "fast");
  assert.equal(main.calls.length, 0);

  // 第二条：不覆盖 → 回到主模型
  await collect(agent.send("正常问"));
  assert.equal(main.calls.length, 1);
  assert.equal(main.calls[0]!.model, "main-model");
  // 历史连续：主模型这次请求里能看到上一轮（覆盖模型）的问答
  const historyTexts = JSON.stringify(main.calls[0]!.messages);
  assert.match(historyTexts, /用快模型答/);
  assert.match(historyTexts, /覆盖模型答/);
});

test("per-prompt 覆盖：解析失败 → error 事件，主模型不受影响", async () => {
  const main = scriptedProvider([text("ok")]);
  const agent = new Agent({
    provider: main,
    model: "main-model",
    cwd: os.tmpdir(),
    projectMemory: false,
    injectEnv: false,
    resolveModel: () => {
      throw new Error("未知 provider");
    },
  });

  const events = await collect(agent.send("hi", undefined, { model: "nope/x" }));
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error" && /nope\/x/.test(err.message));
  assert.equal(main.calls.length, 0, "解析失败不应发起请求");

  // 随后正常 send 不受影响
  await collect(agent.send("hi again"));
  assert.equal(main.calls.length, 1);
  assert.equal(main.calls[0]!.model, "main-model");
});

test("per-prompt 覆盖：未配置 resolveModel → 明确报错事件", async () => {
  const main = scriptedProvider([text("ok")]);
  const agent = new Agent({
    provider: main,
    model: "main-model",
    cwd: os.tmpdir(),
    projectMemory: false,
    injectEnv: false,
  });
  const events = await collect(agent.send("hi", undefined, { model: "alt/fast" }));
  const err = events.find((e) => e.type === "error");
  assert.ok(err && err.type === "error" && /resolveModel/.test(err.message));
  assert.equal(main.calls.length, 0);
});
