/**
 * 新增生命周期 hooks 的接线测试：SessionStart / PermissionRequest /
 * PreCompact / PostCompact / SubagentStart / SubagentStop。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, type AgentEvent } from "./agent.js";
import { ToolRegistry } from "./tools/tool.js";
import type { Provider, StreamEvent, StreamRequest, ChatMessage } from "./types.js";

function scriptedProvider(scripts: ChatMessage[][], sink?: { systems: string[] }): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
      sink?.systems.push(req.system ?? "");
      const content = scripts[turn++]?.[0]?.content ?? [{ type: "text", text: "ok" }];
      const hasTool = content.some((p) => p.type === "tool_call");
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

const sideEffectTool = {
  readOnly: false,
  def: {
    name: "sideeffect",
    description: "测试用副作用工具",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  ruleKey: () => "sideeffect",
  run: async () => "副作用已执行",
};

function toolCallScript(name: string): ChatMessage[][] {
  return [
    [{ role: "assistant", content: [{ type: "tool_call", id: "c1", name, args: {} }] }],
    [{ role: "assistant", content: [{ type: "text", text: "完成" }] }],
  ];
}

test("SessionStart: additionalContext 注入 system", async () => {
  const sink = { systems: [] as string[] };
  const agent = new Agent({
    provider: scriptedProvider([], sink),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    hooks: [
      {
        event: "SessionStart",
        handler: () => ({ additionalContext: "会话级注入：当前分支 main" }),
      },
    ],
  });
  for await (const _ of agent.send("hi")) {
    /* drain */
  }
  assert.match(sink.systems[0]!, /会话级注入：当前分支 main/);
});

async function runPermissionScenario(opts: {
  hookResult?: { decision?: "allow" | "block"; reason?: string };
  withHook: boolean;
}) {
  const confirmCalls: string[] = [];
  const tools = new ToolRegistry().register(sideEffectTool);
  const agent = new Agent({
    provider: scriptedProvider(toolCallScript("sideeffect")),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    tools,
    permission: {
      mode: "default",
      confirm: async (req) => {
        confirmCalls.push(req.toolName);
        return { behavior: "allow" };
      },
    },
    ...(opts.withHook
      ? {
          hooks: [
            {
              event: "PermissionRequest" as const,
              handler: () => opts.hookResult,
            },
          ],
        }
      : {}),
  });
  const events: AgentEvent[] = [];
  for await (const ev of agent.send("调用工具")) events.push(ev);
  const result = events.find((e) => e.type === "tool_result") as any;
  return { confirmCalls, result };
}

test("PermissionRequest hook: allow 自动批准（不弹确认）", async () => {
  const { confirmCalls, result } = await runPermissionScenario({
    withHook: true,
    hookResult: { decision: "allow" },
  });
  assert.equal(confirmCalls.length, 0, "confirm 不应被调用");
  assert.equal(result.isError ?? false, false);
  assert.match(result.content, /副作用已执行/);
});

test("PermissionRequest hook: block 自动拒绝", async () => {
  const { confirmCalls, result } = await runPermissionScenario({
    withHook: true,
    hookResult: { decision: "block", reason: "策略禁止" },
  });
  assert.equal(confirmCalls.length, 0);
  assert.equal(result.isError, true);
  assert.match(result.content, /策略禁止/);
});

test("PermissionRequest hook: 无表态则照常走 confirm", async () => {
  const { confirmCalls, result } = await runPermissionScenario({ withHook: true });
  assert.deepEqual(confirmCalls, ["sideeffect"]);
  assert.match(result.content, /副作用已执行/);
});

test("PreCompact / PostCompact: 压缩触发前后各响一次", async () => {
  const fired: string[] = [];
  const scripts: ChatMessage[][] = Array.from({ length: 4 }, (_, i) => [
    { role: "assistant", content: [{ type: "text", text: `回答${i}` }] },
  ]);
  const agent = new Agent({
    provider: scriptedProvider(scripts),
    model: "m",
    cwd: process.cwd(),
    retry: false,
    projectMemory: false,
    injectEnv: false,
    compaction: {
      triggerTokens: 1, // 立即触发
      keepRecentMessages: 1,
      summarizer: async () => "（历史摘要）",
    },
    hooks: [
      { event: "PreCompact", handler: (p) => void fired.push(`pre:${p.event}`) },
      {
        event: "PostCompact",
        handler: (p) => {
          fired.push(`post:${p.beforeTokens! >= p.afterTokens! ? "shrunk" : "grew"}`);
        },
      },
    ],
  });
  // 多轮把历史养大，直到出现一次真实压缩
  for (const text of ["一", "二", "三", "四"]) {
    for await (const _ of agent.send(text)) {
      /* drain */
    }
  }
  assert.ok(fired.some((f) => f.startsWith("pre:")), `PreCompact 未触发: ${fired.join(",")}`);
  assert.ok(fired.some((f) => f.startsWith("post:")), `PostCompact 未触发: ${fired.join(",")}`);
});

test("SubagentStart: block 阻止派生；SubagentStop 观察结果", async () => {
  const lifecycle: string[] = [];
  const makeAgent = (block: boolean) =>
    new Agent({
      provider: scriptedProvider([
        [
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "t1",
                name: "task",
                args: { description: "调研", prompt: "去调研", subagent_type: "explore" },
              },
            ],
          },
        ],
        // 子 agent 的一轮（block 场景不会消耗）
        [{ role: "assistant", content: [{ type: "text", text: "子结论" }] }],
        [{ role: "assistant", content: [{ type: "text", text: "父收尾" }] }],
      ]),
      model: "m",
      cwd: process.cwd(),
      retry: false,
      projectMemory: false,
      injectEnv: false,
      subagents: true,
      permission: { mode: "auto" },
      hooks: [
        {
          event: "SubagentStart",
          handler: (p) => {
            lifecycle.push(`start:${p.subagentType}:${p.taskDescription}`);
            return block ? { decision: "block", reason: "禁止派生" } : undefined;
          },
        },
        {
          event: "SubagentStop",
          handler: (p) => void lifecycle.push(`stop:${p.subagentType}:err=${p.isError}`),
        },
      ],
    });

  // block 场景
  const blocked = makeAgent(true);
  const evs1: AgentEvent[] = [];
  for await (const ev of blocked.send("派子任务")) evs1.push(ev);
  const r1 = evs1.find((e) => e.type === "tool_result") as any;
  assert.equal(r1.isError, true);
  assert.match(r1.content, /禁止派生/);
  assert.deepEqual(lifecycle, ["start:explore:调研"]);

  // 放行场景
  lifecycle.length = 0;
  const allowed = makeAgent(false);
  const evs2: AgentEvent[] = [];
  for await (const ev of allowed.send("派子任务")) evs2.push(ev);
  const r2 = evs2.find((e) => e.type === "tool_result") as any;
  assert.equal(r2.isError ?? false, false);
  assert.match(r2.content, /子结论/);
  assert.deepEqual(lifecycle, ["start:explore:调研", "stop:explore:err=false"]);
});
