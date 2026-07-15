/**
 * MCP 客户端测试：以子进程启动假 MCP server，验证
 *   initialize 握手 → tools/list 包装 → tools/call 往返（含错误路径），
 * 并把 MCP 工具挂进真实 Agent，端到端跑一次工具调用。全离线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { McpClient } from "./mcp.js";
import { Agent } from "./agent.js";
import { defaultTools } from "./tools/index.js";
import type { Provider, StreamEvent, ChatMessage, AgentEvent } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "testutil", "fake-mcp-server.ts");

// 用 tsx 直接跑 TS server 脚本
const serverCfg = {
  name: "fake",
  command: process.execPath, // node
  args: ["--import", "tsx", serverPath],
};

test("MCP: 握手 → 列工具 → 调用 → 错误路径", async () => {
  const client = await McpClient.start(serverCfg);
  const tools = await client.listTools();

  // 工具被以 "<server>__<tool>" 命名，且非只读（走权限门）
  const echo = tools.find((t) => t.def.name === "fake__echo");
  assert.ok(echo, "应有 fake__echo 工具");
  assert.equal(echo!.readOnly, false);
  assert.match(echo!.def.description, /回显/);

  // 正常调用
  const out = await echo!.run({ text: "你好" }, { cwd: ".", signal: new AbortController().signal });
  assert.equal(out, "echo: 你好");

  // 错误路径：fail 工具抛 ToolError
  const fail = tools.find((t) => t.def.name === "fake__fail")!;
  await assert.rejects(
    () => fail.run({}, { cwd: ".", signal: new AbortController().signal }),
    /故意失败/,
  );

  client.close();
});

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
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

test("MCP: 工具挂进 Agent，端到端调用", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mcp-"));
  const client = await McpClient.start(serverCfg);
  const mcpTools = await client.listTools();

  // 内置工具 + MCP 工具合并进一个 registry
  const registry = defaultTools();
  for (const t of mcpTools) registry.register(t);

  const agent = new Agent({
    provider: scriptedProvider([
      [{ role: "assistant", content: [
        { type: "tool_call", id: "c1", name: "fake__echo", args: { text: "从 agent 调 MCP" } },
      ] }],
      [{ role: "assistant", content: [{ type: "text", text: "MCP 工具返回了内容" }] }],
    ]),
    model: "scripted",
    cwd: dir,
    tools: registry,
    projectMemory: false,
    permission: { mode: "auto" }, // 自动放行以便断言执行
  });

  const events: AgentEvent[] = [];
  for await (const ev of agent.send("用 echo 工具")) events.push(ev);

  const res = events.find((e) => e.type === "tool_result") as any;
  assert.equal(res.name, "fake__echo");
  assert.match(res.content, /echo: 从 agent 调 MCP/);
  assert.ok(events.some((e) => e.type === "done"));

  client.close();
  await fs.rm(dir, { recursive: true, force: true });
});
