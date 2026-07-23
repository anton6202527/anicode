/**
 * Agent 装配：webSearch / lsp 选项应把对应工具注册进本 agent 的工具集，
 * 并作为只读工具自动放行、随请求发给模型。回归：diagnostics 曾导出却从不接线。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "./agent.js";
import { LspPool } from "./lsp.js";
import type { Provider, StreamEvent, StreamRequest } from "./types.js";

/** 捕获首次请求的工具清单后即结束（不调用任何工具）。 */
function capturingProvider(sink: { toolNames: string[] }): Provider {
  return {
    name: "capture",
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      sink.toolNames = (req.tools ?? []).map((t) => t.name);
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

async function toolsOffered(opts: Record<string, unknown> = {}) {
  const sink = { toolNames: [] as string[] };
  const agent = new Agent({
    provider: capturingProvider(sink),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    ...(opts as any),
  });
  for await (const _ of agent.send("hi")) {
    /* drain */
  }
  return sink.toolNames;
}

test("默认不含 web_search / diagnostics / browser（Agent 层为 opt-in）", async () => {
  const names = await toolsOffered();
  assert.ok(!names.includes("web_search"));
  assert.ok(!names.includes("diagnostics"));
  assert.ok(!names.includes("browser"));
});

test("browser: true → 注册 browser 工具（只读、自动放行、随请求发给模型）", async () => {
  const names = await toolsOffered({ browser: true });
  assert.ok(names.includes("browser"), `实际工具: ${names.join(",")}`);
});

test("传入 webSearch 后端 → 注册 web_search 工具", async () => {
  const names = await toolsOffered({ webSearch: async () => [] });
  assert.ok(names.includes("web_search"), `实际工具: ${names.join(",")}`);
});

test("传入 lsp 池 → 注册 diagnostics + 导航工具套件", async () => {
  const pool = new LspPool(process.cwd(), []); // 空 servers：不 spawn 任何进程
  const names = await toolsOffered({ lsp: pool });
  for (const expected of ["diagnostics", "definition", "references", "symbols"]) {
    assert.ok(names.includes(expected), `缺 ${expected}；实际工具: ${names.join(",")}`);
  }
  pool.closeAll();
});
