/**
 * 模型降级链（fallbackModels）与会话成本估算。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, type AgentEvent } from "./agent.js";
import { estimateCostUSD } from "./provider/registry.js";
import type { Provider, StreamEvent } from "./types.js";

function failingProvider(calls: { count: number }): Provider {
  return {
    name: "failing",
    // eslint-disable-next-line require-yield
    async *stream(): AsyncIterable<StreamEvent> {
      calls.count++;
      const err = new Error("HTTP 500 internal error") as Error & { status: number };
      err.status = 500;
      throw err;
    },
  };
}

function okProvider(name: string, calls?: { count: number }): Provider {
  return {
    name,
    async *stream(): AsyncIterable<StreamEvent> {
      if (calls) calls.count++;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: `answer from ${name}` }] },
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5 },
      };
    },
  };
}

test("fallback: 主模型重试耗尽后切换到降级模型完成本轮", async () => {
  const primaryCalls = { count: 0 };
  const backupCalls = { count: 0 };
  const backup = okProvider("backup", backupCalls);
  const agent = new Agent({
    provider: failingProvider(primaryCalls),
    model: "primary-model",
    cwd: process.cwd(),
    retry: { maxRetries: 1, baseDelayMs: 1 },
    projectMemory: false,
    injectEnv: false,
    fallbackModels: ["backup/backup-model"],
    resolveModel: (spec) => {
      assert.equal(spec, "backup/backup-model");
      return { provider: backup, model: "backup-model" };
    },
  });

  const events: AgentEvent[] = [];
  for await (const ev of agent.send("hi")) events.push(ev);

  const fb = events.find((e) => e.type === "model_fallback") as any;
  assert.ok(fb, "应有 model_fallback 事件");
  assert.equal(fb.from, "primary-model");
  assert.equal(fb.to, "backup-model");
  assert.equal(primaryCalls.count, 2, "主模型应尝试 1+1 次");
  assert.equal(backupCalls.count, 1);
  assert.ok(events.some((e) => e.type === "done"), "降级后应正常完成");
  assert.ok(!events.some((e) => e.type === "error"));

  // 下一次 drive 回到主模型（降级是 drive 局部的），链重置后仍可再次降级。
  const events2: AgentEvent[] = [];
  for await (const ev of agent.send("again")) events2.push(ev);
  assert.equal(primaryCalls.count, 4, "新 drive 应重新从主模型开始");
  assert.ok(events2.some((e) => e.type === "model_fallback"));
  assert.ok(events2.some((e) => e.type === "done"));
});

test("fallback: 无降级链时行为不变（error 收尾）", async () => {
  const calls = { count: 0 };
  const agent = new Agent({
    provider: failingProvider(calls),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
  });
  const events: AgentEvent[] = [];
  for await (const ev of agent.send("hi")) events.push(ev);
  assert.ok(events.some((e) => e.type === "error"));
  assert.ok(!events.some((e) => e.type === "model_fallback"));
});

test("fallback: 解析失败的候选被跳过，用下一个", async () => {
  const backup = okProvider("backup2");
  const agent = new Agent({
    provider: failingProvider({ count: 0 }),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    fallbackModels: ["bad/unresolvable", "good/model"],
    resolveModel: (spec) => {
      if (spec === "bad/unresolvable") throw new Error("no credentials");
      return { provider: backup, model: "good-model" };
    },
  });
  const events: AgentEvent[] = [];
  for await (const ev of agent.send("hi")) events.push(ev);
  const fb = events.find((e) => e.type === "model_fallback") as any;
  assert.equal(fb?.to, "good-model");
  assert.ok(events.some((e) => e.type === "done"));
});

test("成本估算：estimateCostUSD 与 Agent.estimatedCostUSD", async () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
  // $5/MTok input + $25/MTok output → 5 + 2.5
  assert.equal(estimateCostUSD(usage, { input: 5, output: 25 }), 7.5);
  assert.equal(estimateCostUSD(usage, undefined), undefined);
  // cache 默认价：读 0.1×input、写 1.25×input
  const cacheUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 };
  assert.equal(estimateCostUSD(cacheUsage, { input: 4, output: 20 }), 4 * 0.1 + 4 * 1.25);

  const agent = new Agent({
    provider: okProvider("ok"),
    model: "priced",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    modelInfo: {
      providerId: "test",
      model: "priced",
      capabilities: { tools: true },
      limits: {},
      cost: { input: 3, output: 15 },
    },
  });
  assert.equal(agent.estimatedCostUSD, 0, "未产生用量时为 0");
  for await (const _ of agent.send("hi")) {
    /* drain */
  }
  // 100 in × $3 + 50 out × $15 + 10 cacheRead × $0.3 + 5 cacheWrite × $3.75（每 MTok）
  const expected = (100 * 3 + 50 * 15 + 10 * 0.3 + 5 * 3.75) / 1_000_000;
  assert.ok(Math.abs((agent.estimatedCostUSD ?? 0) - expected) < 1e-12);

  const unpriced = new Agent({
    provider: okProvider("ok"),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
  });
  assert.equal(unpriced.estimatedCostUSD, undefined);
});
