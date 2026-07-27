import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnRunner } from "./turn-runner.js";
import type { AgentEvent } from "./agent.js";
import { emptyUsage, type Provider } from "./types.js";

function okProvider(text: string): Provider {
  return {
    name: "fake-ok",
    async *stream() {
      yield { type: "text_delta", text };
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text }] },
        usage: emptyUsage(),
      };
    },
  };
}

function failingProvider(err: unknown): Provider {
  return {
    name: "fake-bad",
    // eslint-disable-next-line require-yield
    async *stream() {
      throw err;
    },
  };
}

async function drain(
  gen: AsyncGenerator<AgentEvent, unknown>,
): Promise<{ events: AgentEvent[]; outcome: unknown }> {
  const events: AgentEvent[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, outcome: r.value };
}

test("TurnRunner: 主模型失败 → 按降级链切换并完成本轮；restore 还原主模型", async () => {
  const good = okProvider("hi");
  const runner = new TurnRunner({
    provider: failingProvider({ status: 400, message: "bad request" }),
    model: "main",
    retry: null,
    resolveModel: (spec) => ({ provider: good, model: spec }),
    fallbackModels: ["fb-1"],
    small: { provider: good, model: "small" },
  });
  runner.resetFallbacks();
  const { events, outcome } = await drain(
    runner.runTurn({
      system: "",
      messages: [],
      toolDefs: [],
      signal: new AbortController().signal,
    }),
  );
  assert.equal((outcome as { type: string }).type, "ok");
  const fb = events.find((e) => e.type === "model_fallback");
  assert.ok(fb && fb.type === "model_fallback" && fb.from === "main" && fb.to === "fb-1");
  assert.equal(runner.model, "fb-1"); // 降级在 drive 内生效
  runner.restore();
  assert.equal(runner.model, "main"); // send 收尾还原
});

test("TurnRunner: resetFallbacks 每次 drive 重置 —— 上一轮的降级不吞本轮候选", async () => {
  const good = okProvider("ok");
  const runner = new TurnRunner({
    provider: failingProvider({ status: 500, message: "boom" }),
    model: "main",
    retry: { maxRetries: 0, baseDelayMs: 1 },
    resolveModel: (spec) => ({ provider: good, model: spec }),
    fallbackModels: ["fb-1"],
    small: { provider: good, model: "small" },
  });
  for (let round = 1; round <= 2; round++) {
    runner.resetFallbacks();
    const { outcome } = await drain(
      runner.runTurn({
        system: "",
        messages: [],
        toolDefs: [],
        signal: new AbortController().signal,
      }),
    );
    assert.equal((outcome as { type: string }).type, "ok", `第 ${round} 次 drive 应降级成功`);
    runner.restore();
  }
});

test("TurnRunner: override 切换 active 模型与能力；canResolve 反映 resolver 配置", () => {
  const good = okProvider("x");
  const bare = new TurnRunner({
    provider: good,
    model: "m",
    retry: null,
    small: { provider: good, model: "m" },
  });
  assert.equal(bare.canResolve, false);
  assert.throws(() => bare.override("a/b"));

  const runner = new TurnRunner({
    provider: good,
    model: "m",
    retry: null,
    resolveModel: () => ({
      provider: good,
      model: "other",
      modelInfo: {
        providerId: "p",
        model: "other",
        capabilities: { tools: false, images: true },
        limits: {},
      },
    }),
    small: { provider: good, model: "m" },
  });
  runner.override("p/other");
  assert.equal(runner.model, "other");
  assert.equal(runner.supportsTools, false);
  assert.equal(runner.supportsImages, true);
  runner.restore();
  assert.equal(runner.model, "m");
  assert.equal(runner.supportsTools, true);
});

test("TurnRunner: streamText 小模型失败回退当前主模型", async () => {
  const good = okProvider("summary");
  const runner = new TurnRunner({
    provider: good,
    model: "main",
    retry: null,
    small: { provider: failingProvider(new Error("quota")), model: "small" },
  });
  let out = "";
  for await (const ev of runner.streamText([], "sys")) {
    if (ev.type === "text" && ev.text) out += ev.text;
  }
  assert.equal(out, "summary");
});
