import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentEvent } from "./agent.js";
import { SessionManager, type SessionEvent } from "./session-manager.js";
import { SessionStore } from "./session.js";
import { ToolError, ToolRegistry, type Tool } from "./tools/tool.js";
import type { ChatMessage, Provider, StreamEvent } from "./types.js";
import { scriptedProvider } from "./testutil/scripted-provider.js";

const assistant = (...content: ChatMessage["content"]): ChatMessage[] => [
  { role: "assistant", content },
];

async function collect(agent: Agent, text: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.send(text)) events.push(event);
  return events;
}

test("Agent features: 动态发现的 skill 保持只读并注入清单", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-skill-agent-"));
  const skillDir = path.join(dir, ".claude", "skills", "review");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: review\ndescription: 审查代码\n---\n先运行测试，再检查差异。",
  );
  const provider = scriptedProvider([
    assistant({ type: "tool_call", id: "s1", name: "skill", args: { name: "review" } }),
    assistant({ type: "text", text: "已加载" }),
  ]);
  let confirmCalled = false;
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    skills: true,
    permission: {
      confirm: async () => {
        confirmCalled = true;
        return { behavior: "deny" };
      },
    },
  });

  const events = await collect(agent, "使用 review skill");
  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result" && !result.isError);
  assert.match(result.content, /先运行测试/);
  assert.equal(confirmCalled, false);
  assert.match(provider.calls[0]!.system ?? "", /review: 审查代码/);
  assert.ok(provider.calls[0]!.tools?.some((t) => t.name === "skill"));

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: steering 同样经过 UserPromptSubmit hook，内部 context 不冒充用户原话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-steer-"));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (started = resolve));
  let turn = 0;
  const calls: ChatMessage[][] = [];
  const provider: Provider = {
    name: "gated",
    async *stream(req): AsyncIterable<StreamEvent> {
      calls.push(structuredClone(req.messages));
      if (turn++ === 0) {
        started();
        await gate;
      }
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: `reply-${turn}` }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const seen: string[] = [];
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    hooks: [{
      event: "UserPromptSubmit",
      handler: ({ prompt }) => {
        seen.push(prompt ?? "");
        if (prompt === "blocked") return { decision: "block", reason: "policy" };
        if (prompt === "second") return { additionalContext: "secret-policy-context" };
      },
    }],
  });

  const events: AgentEvent[] = [];
  const running = (async () => {
    for await (const event of agent.send("first")) events.push(event);
  })();
  await entered;
  assert.equal(agent.queue("blocked"), true);
  assert.equal(agent.queue("second"), true);
  release();
  await running;

  assert.deepEqual(seen, ["first", "blocked", "second"]);
  assert.ok(events.some((e) => e.type === "error" && /排队输入被 hook 拦截/.test(e.message)));
  const shown = events.filter((e) => e.type === "user_message").map((e) => e.text);
  assert.deepEqual(shown, ["first", "second"]);
  assert.ok(!shown.some((text) => text.includes("secret-policy-context")));
  const second = [...calls[1]!].reverse().find((m) => m.role === "user")!;
  assert.equal(second.content[0]?.type, "text");
  assert.equal(second.content[0]?.type === "text" ? second.content[0].text : "", "second");
  assert.ok(second.content.some((p) => p.type === "text" && p.internal && /secret-policy/.test(p.text)));

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: steering 全被 hook 拦截时不会空跑额外模型轮", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-steer-block-"));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const entered = new Promise<void>((resolve) => (started = resolve));
  let calls = 0;
  const provider: Provider = {
    name: "gated-block",
    async *stream(): AsyncIterable<StreamEvent> {
      calls++;
      started();
      await gate;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    hooks: [{ event: "UserPromptSubmit", handler: ({ prompt }) =>
      prompt === "blocked" ? { decision: "block", reason: "policy" } : undefined }],
  });
  const running = collect(agent, "first");
  await entered;
  assert.equal(agent.queue("blocked"), true);
  release();
  const events = await running;
  assert.equal(calls, 1);
  assert.ok(events.some((event) => event.type === "done"));

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: 并行工具准备阶段抛错仍为每个 tool_call 生成配对结果", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tool-pair-"));
  const bad: Tool = {
    readOnly: true,
    def: { name: "bad", description: "bad", parameters: { type: "object" } },
    ruleKey: () => { throw new Error("ruleKey boom"); },
    async run() { return "never"; },
  };
  const good: Tool = {
    readOnly: true,
    def: { name: "good", description: "good", parameters: { type: "object" } },
    ruleKey: () => "good",
    async run() { return "ok"; },
  };
  const provider = scriptedProvider([
    assistant(
      { type: "tool_call", id: "bad-1", name: "bad", args: {} },
      { type: "tool_call", id: "good-1", name: "good", args: {} },
    ),
    assistant({ type: "text", text: "finished" }),
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    tools: new ToolRegistry().register(bad).register(good),
  });

  const events = await collect(agent, "run both");
  const results = events.filter((e) => e.type === "tool_result");
  assert.equal(results.length, 2);
  const firstResult = results[0]!;
  assert.equal(firstResult.type === "tool_result" && firstResult.isError, true);
  const replay = provider.calls[1]!.messages.at(-1)!;
  assert.deepEqual(
    replay.content.filter((p) => p.type === "tool_result").map((p) => p.toolCallId),
    ["bad-1", "good-1"],
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: 部分流失败重试前发 turn_reset，历史只保留成功尝试", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-retry-"));
  let attempt = 0;
  const provider: Provider = {
    name: "flaky",
    async *stream(): AsyncIterable<StreamEvent> {
      if (attempt++ === 0) {
        yield { type: "text_delta", text: "partial" };
        const error = Object.assign(new Error("overloaded"), { status: 503 });
        throw error;
      }
      yield { type: "text_delta", text: "final" };
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "final" }] },
        usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    retry: { maxRetries: 1, baseDelayMs: 0 },
  });
  const events = await collect(agent, "go");
  assert.deepEqual(
    events.filter((e) => e.type === "text" || e.type === "turn_reset" || e.type === "retry").map((e) => e.type),
    ["text", "turn_reset", "retry", "text"],
  );
  const last = agent.messages.at(-1)!;
  assert.equal(last.content[0]?.type === "text" ? last.content[0].text : "", "final");

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: 部分流最终失败也发 turn_reset，不把残影留在 UI", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-terminal-reset-"));
  const provider: Provider = {
    name: "terminal-failure",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "not-committed" };
      throw Object.assign(new Error("bad request"), { status: 400 });
    },
  };
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    retry: false,
  });

  const events = await collect(agent, "go");
  assert.deepEqual(
    events
      .filter((event) => event.type === "text" || event.type === "turn_reset" || event.type === "error")
      .map((event) => event.type),
    ["text", "turn_reset", "error"],
  );
  assert.equal(agent.messages.some((m) => m.role === "assistant"), false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: confirm 改写后的最终动作仍受 deny 规则约束", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-updated-policy-"));
  let runs = 0;
  const actionTool: Tool = {
    readOnly: false,
    def: { name: "action", description: "action", parameters: { type: "object" } },
    ruleKey: (input) => String(input["name"] ?? ""),
    async run() {
      runs++;
      return "executed";
    },
  };
  const provider = scriptedProvider([
    assistant({ type: "tool_call", id: "a1", name: "action", args: { name: "safe" } }),
    assistant({ type: "text", text: "handled" }),
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    tools: new ToolRegistry().register(actionTool),
    permission: {
      denyRules: ["Action(danger*)"],
      confirm: async () => ({
        behavior: "allow",
        updatedInput: { name: "dangerous" },
        remember: true,
      }),
    },
  });

  const events = await collect(agent, "run");
  assert.equal(runs, 0);
  assert.ok(events.some((event) =>
    event.type === "tool_permission" && event.decision === "deny"));
  const result = events.find((event) => event.type === "tool_result");
  assert.ok(result && result.type === "tool_result" && result.isError);
  assert.match(result.content, /修改后的操作被 deny 规则禁止/);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: PostToolUse 可观察错误，PreToolUse context 不丢失", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-hook-tool-"));
  const failing: Tool = {
    readOnly: true,
    def: { name: "fail", description: "fail", parameters: { type: "object" } },
    ruleKey: () => "fail",
    async run() { throw new ToolError("tool failed"); },
  };
  let sawError = false;
  const provider = scriptedProvider([
    assistant({ type: "tool_call", id: "f1", name: "fail", args: {} }),
    assistant({ type: "text", text: "handled" }),
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    tools: new ToolRegistry().register(failing),
    hooks: [
      { event: "PreToolUse", handler: () => ({ additionalContext: "pre-context" }) },
      {
        event: "PostToolUse",
        handler: ({ isError }) => {
          sawError = isError === true;
          return { additionalContext: "post-context" };
        },
      },
    ],
  });

  const events = await collect(agent, "fail");
  const result = events.find((e) => e.type === "tool_result");
  assert.ok(result && result.type === "tool_result" && result.isError);
  assert.match(result.content, /tool failed/);
  assert.match(result.content, /pre-context/);
  assert.match(result.content, /post-context/);
  assert.equal(sawError, true);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: 子 agent 串行 task 的用量汇总进父会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-subagent-"));
  const provider = scriptedProvider([
    assistant({
      type: "tool_call",
      id: "task-1",
      name: "task",
      args: { description: "调研", prompt: "给出结论", subagent_type: "general" },
    }),
    assistant({ type: "text", text: "child conclusion" }),
    assistant({ type: "text", text: "parent done" }),
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    subagents: true,
    permission: { mode: "auto" },
  });

  const events = await collect(agent, "delegate");
  const taskResult = events.find((e) => e.type === "tool_result" && e.name === "task");
  assert.ok(taskResult && taskResult.type === "tool_result" && !taskResult.isError);
  assert.match(taskResult.content, /child conclusion/);
  const done = [...events].reverse().find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.usage.inputTokens, 30);
  assert.equal(done.usage.outputTokens, 15);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: 子 agent 继承父级 PreToolUse，task 不能绕过写入拦截", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-subagent-hooks-"));
  const target = path.join(dir, "blocked.txt");
  let blocks = 0;
  const provider = scriptedProvider([
    assistant({
      type: "tool_call",
      id: "task-hook",
      name: "task",
      args: { description: "写文件", prompt: "写 blocked.txt", subagent_type: "general" },
    }),
    assistant({
      type: "tool_call",
      id: "child-write",
      name: "write",
      args: { path: "blocked.txt", content: "must not exist" },
    }),
    assistant({ type: "text", text: "write was blocked" }),
    assistant({ type: "text", text: "parent done" }),
  ]);
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    subagents: true,
    permission: { mode: "auto" },
    hooks: [{
      event: "PreToolUse",
      matcher: "write",
      handler: () => {
        blocks++;
        return { decision: "block", reason: "writes disabled" };
      },
    }],
  });

  await collect(agent, "delegate");
  assert.equal(blocks, 1);
  await assert.rejects(fs.access(target));

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent features: 复用 ToolRegistry 时 task 注册与有状态工具实例互不污染", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-registry-clone-"));
  const createCounter = (): Tool => {
    let count = 0;
    return {
      readOnly: true,
      def: { name: "counter", description: "counter", parameters: { type: "object" } },
      ruleKey: () => "counter",
      fork: createCounter,
      async run() {
        return String(++count);
      },
    };
  };
  const registry = new ToolRegistry().register(createCounter());
  const providerOne = scriptedProvider([
    assistant({ type: "tool_call", id: "c1", name: "counter", args: {} }),
    assistant({ type: "text", text: "one" }),
  ]);
  const providerTwo = scriptedProvider([
    assistant({ type: "tool_call", id: "c2", name: "counter", args: {} }),
    assistant({ type: "text", text: "two" }),
  ]);
  const one = new Agent({
    provider: providerOne,
    model: "x",
    cwd: dir,
    tools: registry,
    projectMemory: false,
    subagents: true,
    permission: { mode: "auto" },
  });
  const two = new Agent({
    provider: providerTwo,
    model: "x",
    cwd: dir,
    tools: registry,
    projectMemory: false,
  });

  const [eventsOne, eventsTwo] = await Promise.all([collect(one, "one"), collect(two, "two")]);
  assert.equal(registry.get("task"), undefined);
  const resultOne = eventsOne.find((e) => e.type === "tool_result" && e.name === "counter");
  const resultTwo = eventsTwo.find((e) => e.type === "tool_result" && e.name === "counter");
  assert.ok(resultOne && resultOne.type === "tool_result");
  assert.ok(resultTwo && resultTwo.type === "tool_result");
  assert.equal(resultOne.content, "1");
  assert.equal(resultTwo.content, "1");

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: done 事件回调中的新消息进入下一 drive，不丢失不乱序", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-done-race-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const provider = scriptedProvider([
    assistant({ type: "text", text: "reply-A" }),
    assistant({ type: "text", text: "reply-B" }),
  ]);
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider, model: "x" }),
  });
  const session = await manager.createSession({ cwd: dir, model: "x" });
  let second: Promise<void> | undefined;
  let doneCount = 0;
  const events: SessionEvent[] = [];
  await manager.open(session.id, (event) => {
    events.push(event);
    if (event.type === "agent" && event.event.type === "done" && doneCount++ === 0) {
      second = manager.send(session.id, "B");
    }
  });

  await manager.send(session.id, "A");
  assert.ok(second);
  await second;
  const loaded = await store.load(session.id);
  const texts = loaded.messages.flatMap((m) =>
    m.content.flatMap((p) => p.type === "text" && !p.internal ? [p.text] : []),
  );
  assert.deepEqual(texts, ["A", "reply-A", "B", "reply-B"]);
  assert.equal(events.filter((e) => e.type === "agent" && e.event.type === "done").length, 2);

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: steering send Promise 等到输入已处理且持久化后才完成", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-steer-promise-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  let release!: () => void;
  let markStarted!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let turn = 0;
  const provider: Provider = {
    name: "gated-session",
    async *stream(): AsyncIterable<StreamEvent> {
      if (turn++ === 0) {
        markStarted();
        await gate;
      }
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: `reply-${turn}` }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider, model: "x" }),
  });
  const session = await manager.createSession({ cwd: dir, model: "x" });
  const first = manager.send(session.id, "A");
  await started;
  let steeringResolved = false;
  const steering = manager.send(session.id, "B").then(() => { steeringResolved = true; });
  await Promise.resolve();
  assert.equal(steeringResolved, false);
  release();
  await Promise.all([first, steering]);
  assert.equal(steeringResolved, true);
  const loaded = await store.load(session.id);
  assert.deepEqual(
    loaded.messages.flatMap((m) =>
      m.content.flatMap((p) => p.type === "text" && !p.internal ? [p.text] : []),
    ),
    ["A", "reply-1", "B", "reply-2"],
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: interrupt 后同 tick 的新 send 进入下一 drive", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-interrupt-race-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const calls: ChatMessage[][] = [];
  let turn = 0;
  const provider: Provider = {
    name: "interruptible-session",
    async *stream(req): AsyncIterable<StreamEvent> {
      calls.push(structuredClone(req.messages));
      if (turn++ === 0) {
        markStarted();
        await new Promise<void>((_resolve, reject) => {
          const abort = () => reject(new Error("provider aborted"));
          if (req.signal?.aborted) abort();
          else req.signal?.addEventListener("abort", abort, { once: true });
        });
        return;
      }
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "reply-B" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider, model: "x" }),
  });
  const session = await manager.createSession({ cwd: dir, model: "x" });
  const events: SessionEvent[] = [];
  await manager.open(session.id, (event) => events.push(event));

  const first = manager.send(session.id, "A");
  await started;
  const oldSteering = manager.send(session.id, "old steering");
  // SessionManager.send 先异步解析 live session；让旧 steering 真正进入当前 generation。
  await Promise.resolve();
  const oldRejected = assert.rejects(oldSteering, /会话已中断/);
  const interruption = manager.interrupt(session.id);
  // 不让出事件循环：interrupt 返回后的 B 必须排入下一 drive。
  const second = manager.send(session.id, "B");

  await Promise.all([first, interruption, second, oldRejected]);
  assert.equal(calls.length, 2);
  const secondCallUsers = calls[1]!.filter((message) => message.role === "user");
  assert.ok(secondCallUsers.some((message) =>
    message.content.some((part) => part.type === "text" && part.text === "B")));
  const shownB = events.find((event) =>
    event.type === "agent" && event.event.type === "user_message" && event.event.text === "B");
  assert.ok(shownB && shownB.type === "agent" && shownB.event.type === "user_message");
  assert.equal(shownB.event.queued, false);

  const loaded = await store.load(session.id);
  assert.deepEqual(
    loaded.messages.flatMap((message) =>
      message.content.flatMap((part) => part.type === "text" && !part.internal ? [part.text] : []),
    ),
    ["A", "B", "reply-B"],
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: 主输入 hook 阻塞期间的新消息不会随主输入丢失", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-hook-race-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  let releaseHook!: () => void;
  let markHookStarted!: () => void;
  const hookGate = new Promise<void>((resolve) => (releaseHook = resolve));
  const hookStarted = new Promise<void>((resolve) => (markHookStarted = resolve));
  const seen: string[] = [];
  const provider = scriptedProvider([assistant({ type: "text", text: "reply-B" })]);
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider, model: "x" }),
    hooks: [{
      event: "UserPromptSubmit",
      async handler({ prompt }) {
        seen.push(prompt ?? "");
        if (prompt !== "A") return;
        markHookStarted();
        await hookGate;
        return { decision: "block", reason: "blocked A" };
      },
    }],
  });
  const session = await manager.createSession({ cwd: dir, model: "x" });
  const events: SessionEvent[] = [];
  await manager.open(session.id, (event) => events.push(event));

  const first = manager.send(session.id, "A");
  await hookStarted;
  const second = manager.send(session.id, "B");
  releaseHook();
  await Promise.all([first, second]);

  assert.deepEqual(seen, ["A", "B"]);
  assert.equal(provider.calls.length, 1);
  const shownB = events.find((event) =>
    event.type === "agent" && event.event.type === "user_message" && event.event.text === "B");
  assert.ok(shownB && shownB.type === "agent" && shownB.event.type === "user_message");
  assert.equal(shownB.event.queued, false);
  const loaded = await store.load(session.id);
  assert.deepEqual(
    loaded.messages.flatMap((message) =>
      message.content.flatMap((part) => part.type === "text" && !part.internal ? [part.text] : []),
    ),
    ["B", "reply-B"],
  );

  await fs.rm(dir, { recursive: true, force: true });
});
