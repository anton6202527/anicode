/**
 * subagent 派生权限：验证子 agent 的工具面被收窄（排除 task 防递归、排除 todo_write 去噪），
 * 并继承父级沙箱策略。用假 makeAgent 捕获子 agent 的构造选项，纯离线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskTool } from "./subagent.js";
import { ToolRegistry, type Tool } from "./tools/tool.js";
import type { AgentOptions } from "./agent.js";

function fakeTool(name: string, readOnly = true): Tool {
  return {
    readOnly,
    def: { name, description: name, parameters: { type: "object" } },
    ruleKey: () => name,
    async run() {
      return "ok";
    },
  };
}

function parentRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register(fakeTool("read"))
    .register(fakeTool("bash", false))
    .register(fakeTool("todo_write", false))
    .register(fakeTool("task", false));
}

/** 捕获子 agent 构造选项，返回一个立即产出结论的 stub Agent。 */
function capturingMakeAgent(sink: { opts?: AgentOptions }) {
  return (opts: AgentOptions) => {
    sink.opts = opts;
    return {
      messages: [{ role: "assistant", content: [{ type: "text", text: "child conclusion" }] }],
      totalUsage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      async *send() {
        /* 无事件；结论从 messages 读取 */
      },
    } as any;
  };
}

test("subagent: 子 agent 工具面排除 task 与 todo_write，保留其余", async () => {
  const sink: { opts?: AgentOptions } = {};
  const tool = createTaskTool({
    makeAgent: capturingMakeAgent(sink),
    provider: { name: "p", async *stream() {} },
    model: "m",
    cwd: "/x",
    tools: parentRegistry(),
    sandbox: "workspace-write",
  });

  const signal = new AbortController().signal;
  await tool.run(
    { description: "调研", prompt: "干活", subagent_type: "general" },
    { cwd: "/x", signal },
  );

  const childTools = sink.opts!.tools!.names();
  assert.ok(!childTools.includes("task"), "子 agent 不得有 task（防递归）");
  assert.ok(!childTools.includes("todo_write"), "子 agent 默认排除 todo_write（隔离清单是噪声）");
  assert.ok(childTools.includes("read") && childTools.includes("bash"), "其余工具保留");
  // 沙箱策略继承，子 agent 的 bash 不能成为绕过沙箱的通道。
  assert.equal(sink.opts!.sandbox, "workspace-write");
  // 子 agent 未开启 subagents → 不会再注册 task 工具（深度固定为 1）。
  assert.equal(sink.opts!.subagents, undefined);
});

test("subagent: readOnly 类型只保留只读工具，且标记为可并发", async () => {
  const sink: { opts?: AgentOptions } = {};
  const tool = createTaskTool({
    makeAgent: capturingMakeAgent(sink),
    provider: { name: "p", async *stream() {} },
    model: "m",
    cwd: "/x",
    tools: parentRegistry(), // read(只读) + bash/todo_write/task(非只读)
  });
  // explore 是内置只读类型
  assert.equal(tool.isConcurrencySafe!({ subagent_type: "explore" }), true);
  assert.equal(tool.isConcurrencySafe!({ subagent_type: "general" }), false);

  const signal = new AbortController().signal;
  await tool.run(
    { description: "查", prompt: "调研", subagent_type: "explore" },
    { cwd: "/x", signal },
  );
  const childTools = sink.opts!.tools!.names();
  // 只读子 agent 只应拿到只读工具（read），写工具（bash）被剔除。
  assert.ok(childTools.includes("read"));
  assert.ok(!childTools.includes("bash"), "只读子 agent 不得有写/执行工具");
});

test("subagent: 显式 def.tools 也强制剔除 task", async () => {
  const sink: { opts?: AgentOptions } = {};
  const tool = createTaskTool({
    makeAgent: capturingMakeAgent(sink),
    provider: { name: "p", async *stream() {} },
    model: "m",
    cwd: "/x",
    tools: parentRegistry(),
    definitions: [{ name: "explorer", description: "只读探索", tools: ["read", "task", "bash"] }],
  });
  const signal = new AbortController().signal;
  await tool.run(
    { description: "x", prompt: "y", subagent_type: "explorer" },
    { cwd: "/x", signal },
  );
  const childTools = sink.opts!.tools!.names();
  assert.ok(!childTools.includes("task"), "显式列出 task 也要剔除");
  assert.deepEqual(childTools.sort(), ["bash", "read"]);
});
