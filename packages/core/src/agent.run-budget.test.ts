import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, RunBudgetLedger, type AgentEvent, type RunBudgetSnapshot } from "./agent.js";
import { SessionStore } from "./session.js";
import { TurnRunner } from "./turn-runner.js";
import { ToolRegistry, type Tool } from "./tools/tool.js";
import type { Provider, StreamEvent, StreamRequest, Usage } from "./types.js";

const zero: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function terminal(text: string, usage: Usage = zero): StreamEvent {
  return {
    type: "done",
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage,
  };
}

async function collect(agent: Agent, prompt: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of agent.send(prompt)) events.push(event);
  return events;
}

function limits(maxTotalTokens: number) {
  return {
    maxWallTimeMs: 5_000,
    maxTotalTokens,
    maxCostUSD: 25,
    maxToolCalls: 100,
    maxConcurrentTools: 4,
    toolTimeoutMs: 5_000,
  };
}

test("run budget: provider 忽略 AbortSignal 且永不返回时仍硬终止，迟到结果不入历史", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const provider: Provider = {
    name: "hung",
    async *stream() {
      await gate;
      yield terminal("迟到结果", { ...zero, inputTokens: 1, outputTokens: 1 });
    },
  };
  const agent = new Agent({
    provider,
    model: "m",
    modelInfo: {
      providerId: "test",
      model: "m",
      capabilities: { tools: false },
      limits: { maxOutputTokens: 32 },
    },
    cwd: process.cwd(),
    system: "",
    projectMemory: false,
    injectEnv: false,
    retry: false,
    runBudget: { maxWallTimeMs: 30 },
  });

  const started = Date.now();
  const events = await collect(agent, "x");
  assert.ok(Date.now() - started < 500);
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
  );
  assert.match(
    (events.find((event) => event.type === "error") as { message: string }).message,
    /最大执行时间/,
  );
  assert.equal(
    agent.messages.some((message) => message.role === "assistant"),
    false,
  );

  release();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(
    agent.messages.some((message) => message.role === "assistant"),
    false,
  );
  assert.deepEqual(agent.totalUsage, zero);
});

test("run budget: provider dispatch 前原子预留并收窄 maxTokens；并发预留总和不越界", async () => {
  const ledger = new RunBudgetLedger(limits(10));
  const release = ledger.hold();
  let seenMaxTokens: number | undefined;
  const provider: Provider = {
    name: "bounded",
    async *stream(req) {
      seenMaxTokens = req.maxTokens;
      yield terminal("ok", { ...zero, inputTokens: 1, outputTokens: 1 });
    },
  };
  const runner = new TurnRunner({
    provider,
    model: "m",
    retry: null,
    maxTokens: 100,
    small: { provider, model: "m" },
  });
  const events: AgentEvent[] = [];
  const turn = runner.runTurn({
    system: "",
    messages: [],
    toolDefs: [],
    signal: new AbortController().signal,
    estimatedInputTokens: 2,
    reserveModelCall: (request) => ledger.reserveModelCall(request),
  });
  let next = await turn.next();
  while (!next.done) {
    events.push(next.value);
    next = await turn.next();
  }
  assert.equal((next.value as { type: string }).type, "ok");
  assert.equal(seenMaxTokens, 8);

  const concurrent = new RunBudgetLedger(limits(10));
  const releaseConcurrent = concurrent.hold();
  const first = await concurrent.reserveModelCall({
    estimatedInputTokens: 2,
    requestedMaxTokens: 3,
    model: "a",
  });
  const second = await concurrent.reserveModelCall({
    estimatedInputTokens: 2,
    requestedMaxTokens: 99,
    model: "b",
  });
  assert.equal(first.maxTokens, 3);
  assert.equal(second.maxTokens, 3);
  await assert.rejects(
    async () =>
      concurrent.reserveModelCall({
        estimatedInputTokens: 1,
        requestedMaxTokens: 1,
        model: "c",
      }),
    /Token 上限/,
  );
  await first.cancel().catch(() => undefined);
  await second.cancel().catch(() => undefined);
  releaseConcurrent();
  release();
  void events;
});

test("run budget: 已 dispatch 的 partial 失败按最坏预留扣账，重试不能免费放大", async () => {
  let calls = 0;
  const provider: Provider = {
    name: "partial-failure",
    async *stream() {
      calls++;
      yield { type: "text_delta", text: "partial" };
      throw Object.assign(new Error("overloaded"), { status: 500 });
    },
  };
  const ledger = new RunBudgetLedger(limits(10));
  const release = ledger.hold();
  const runner = new TurnRunner({
    provider,
    model: "m",
    retry: { maxRetries: 3, baseDelayMs: 0 },
    maxTokens: 8,
    small: { provider, model: "m" },
  });
  const turn = runner.runTurn({
    system: "",
    messages: [],
    toolDefs: [],
    signal: new AbortController().signal,
    estimatedInputTokens: 2,
    reserveModelCall: (request) => ledger.reserveModelCall(request),
  });
  let next = await turn.next();
  while (!next.done) next = await turn.next();
  assert.equal((next.value as { type: string }).type, "error");
  assert.equal(calls, 1, "首个已 dispatch 的最坏预留耗尽预算，不得继续免费重试");
  release();
});

test("run budget: compaction 小模型用量计入预算，超额后不调用下一轮主模型", async () => {
  let mainCalls = 0;
  const main: Provider = {
    name: "main",
    async *stream() {
      mainCalls++;
      yield terminal(`main-${mainCalls}`, { ...zero, inputTokens: 1, outputTokens: 1 });
    },
  };
  let smallCalls = 0;
  const small: Provider = {
    name: "small",
    async *stream() {
      smallCalls++;
      yield { type: "text_delta", text: "summary" };
      yield terminal("summary", { ...zero, inputTokens: 6_000 });
    },
  };
  const agent = new Agent({
    provider: main,
    model: "main",
    modelInfo: {
      providerId: "test",
      model: "main",
      capabilities: { tools: false },
      limits: { contextWindow: 10_000, maxOutputTokens: 100 },
    },
    resolveModel: (spec) => ({
      provider: spec === "test/small" ? small : main,
      model: spec,
      modelInfo: {
        providerId: "test",
        model: spec,
        capabilities: { tools: false },
        limits: { maxOutputTokens: 100 },
      },
    }),
    smallModel: "test/small",
    cwd: process.cwd(),
    system: "",
    projectMemory: false,
    injectEnv: false,
    retry: false,
    compaction: { triggerTokens: 1, keepRecentMessages: 0 },
    runBudget: { maxTotalTokens: 5_000 },
  });
  assert.ok((await collect(agent, "a")).some((event) => event.type === "done"));
  const second = await collect(agent, "b");
  assert.equal(smallCalls, 1);
  assert.equal(mainCalls, 1, "摘要超预算后不得继续调用主模型");
  assert.equal(
    second.some((event) => event.type === "done"),
    false,
  );
  assert.match(
    (second.find((event) => event.type === "error") as { message: string }).message,
    /Token 上限|超过预留/,
  );
  assert.equal(agent.totalUsage.inputTokens, 6_001);
});

test("run budget: detached child 共享原根任务预算，完成用量不串入下一次 drive", async () => {
  let parentTurn = 0;
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => (releaseChild = resolve));
  const provider: Provider = {
    name: "tree",
    async *stream(req: StreamRequest) {
      const isParent = req.system === "PARENT";
      if (!isParent) {
        await childGate;
        yield terminal("child", { ...zero, inputTokens: 100_000 });
        return;
      }
      parentTurn++;
      if (parentTurn === 1) {
        const call = {
          type: "tool_call" as const,
          id: "task-1",
          name: "task",
          args: { description: "bg", prompt: "work", background: true },
        };
        yield {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", content: [call] },
          usage: { ...zero, inputTokens: 1_000 },
        };
        return;
      }
      yield terminal(`parent-${parentTurn}`, { ...zero, inputTokens: 1_000 });
    },
  };
  const agent = new Agent({
    provider,
    model: "m",
    modelInfo: {
      providerId: "test",
      model: "m",
      capabilities: { tools: true },
      limits: { maxOutputTokens: 1_000 },
    },
    cwd: process.cwd(),
    system: "PARENT",
    projectMemory: false,
    injectEnv: false,
    tools: new ToolRegistry(),
    subagents: true,
    permission: { mode: "auto" },
    retry: false,
    runBudget: { maxTotalTokens: 100_000 },
  });

  assert.ok((await collect(agent, "start")).some((event) => event.type === "done"));
  assert.equal(agent.backgroundTasks[0]?.status, "running");
  releaseChild();
  while (agent.backgroundTasks[0]?.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(agent.backgroundTasks[0]?.status, "stopped");
  assert.equal(
    agent.backgroundTasks[0]?.usage?.inputTokens,
    100_000,
    JSON.stringify(agent.backgroundTasks[0]),
  );
  assert.equal(agent.totalUsage.inputTokens, 102_000);

  const nextDrive = await collect(agent, "new root task");
  assert.ok(
    nextDrive.some((event) => event.type === "done"),
    "新 drive 应有独立根预算",
  );
  assert.equal(agent.totalUsage.inputTokens, 103_000);
});

test("run budget: overlap drive 的 command-bound callbacks 精确归属，detached child 沿用原 command", async () => {
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => (releaseChild = resolve));
  let childStarted!: () => void;
  const didStartChild = new Promise<void>((resolve) => (childStarted = resolve));
  let releaseSecond!: () => void;
  const secondGate = new Promise<void>((resolve) => (releaseSecond = resolve));
  let secondWaiting!: () => void;
  const didWaitSecond = new Promise<void>((resolve) => (secondWaiting = resolve));

  const mutation: Tool = {
    def: { name: "mutate", description: "side effect", parameters: { type: "object" } },
    readOnly: false,
    ruleKey: () => "mutate",
    async run() {
      return "mutated";
    },
  };
  const provider: Provider = {
    name: "overlap-tree",
    async *stream(req) {
      const hasResult = (toolName: string) =>
        req.messages.some((message) =>
          message.content.some((part) => part.type === "tool_result" && part.toolName === toolName),
        );
      if (req.system !== "PARENT") {
        if (!hasResult("mutate")) {
          childStarted();
          await childGate;
          yield {
            type: "done",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "child-a",
                  name: "mutate",
                  args: {},
                },
              ],
            },
            usage: { ...zero, inputTokens: 1 },
          };
          return;
        }
        yield terminal("child done", { ...zero, inputTokens: 1 });
        return;
      }

      const isSecond = req.messages.some(
        (message) =>
          message.role === "user" &&
          message.content.some((part) => part.type === "text" && part.text === "second"),
      );
      if (isSecond) {
        if (!hasResult("mutate")) {
          yield {
            type: "done",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_call",
                  id: "root-b",
                  name: "mutate",
                  args: {},
                },
              ],
            },
            usage: { ...zero, inputTokens: 1 },
          };
          return;
        }
        secondWaiting();
        await secondGate;
        yield terminal("second done", { ...zero, inputTokens: 1 });
        return;
      }

      if (!hasResult("task")) {
        yield {
          type: "done",
          stopReason: "tool_use",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "task-a",
                name: "task",
                args: { description: "background A", prompt: "work", background: true },
              },
            ],
          },
          usage: { ...zero, inputTokens: 1 },
        };
        return;
      }
      yield terminal("first done", { ...zero, inputTokens: 1 });
    },
  };
  const tools = new ToolRegistry();
  tools.register(mutation);
  let fallbackFenceCalls = 0;
  let fallbackCheckpointCalls = 0;
  const agent = new Agent({
    provider,
    model: "m",
    modelInfo: {
      providerId: "test",
      model: "m",
      capabilities: { tools: true },
      limits: { maxOutputTokens: 32 },
    },
    cwd: process.cwd(),
    system: "PARENT",
    projectMemory: false,
    injectEnv: false,
    retry: false,
    tools,
    subagents: true,
    permission: { mode: "auto" },
    beforeToolExecution: () => {
      fallbackFenceCalls++;
    },
    internalBeforeToolExecution: (request) => {
      fences.push(`local:${request.toolCallId}`);
    },
    onRunBudgetCheckpoint: () => {
      fallbackCheckpointCalls++;
    },
  });
  const checkpoints: Array<{ owner: "A" | "B"; revision: number }> = [];
  const fences: string[] = [];
  const drive = async (text: string, owner: "A" | "B"): Promise<AgentEvent[]> => {
    const events: AgentEvent[] = [];
    for await (const event of agent.send(text, undefined, {
      beforeToolExecution: (request) => {
        fences.push(`${owner}:${request.toolCallId}`);
      },
      onRunBudgetCheckpoint: (snapshot) => {
        checkpoints.push({ owner, revision: snapshot.revision });
      },
    })) {
      events.push(event);
    }
    return events;
  };

  assert.ok((await drive("first", "A")).some((event) => event.type === "done"));
  await didStartChild;
  const second = drive("second", "B");
  await didWaitSecond;
  releaseChild();
  await agent.awaitBackgroundTasksIdle();
  releaseSecond();
  assert.ok((await second).some((event) => event.type === "done"));

  assert.ok(fences.includes("B:root-b"));
  assert.ok(fences.includes("A:child-a"), "detached child must retain command A's fence");
  for (const [owner, toolCallId] of [
    ["B", "root-b"],
    ["A", "child-a"],
  ] as const) {
    assert.ok(
      fences.indexOf(`${owner}:${toolCallId}`) < fences.indexOf(`local:${toolCallId}`),
      "mandatory local/worktree-style guards must run after the exact command guard",
    );
  }
  assert.equal(fallbackFenceCalls, 0, "per-drive fence replaces constructor fallback");
  assert.equal(fallbackCheckpointCalls, 0, "per-drive checkpoint sink replaces fallback");
  assert.ok(checkpoints.some((entry) => entry.owner === "A"));
  assert.ok(checkpoints.some((entry) => entry.owner === "B"));
  for (const owner of ["A", "B"] as const) {
    const revisions = checkpoints
      .filter((entry) => entry.owner === owner)
      .map((entry) => entry.revision);
    assert.deepEqual(
      revisions,
      [...revisions].sort((left, right) => left - right),
    );
  }
});

test("run budget: persistence append 永不返回也不能绕过 wall deadline 或启动 provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-hung-store-"));
  try {
    const store = new SessionStore(path.join(dir, "sessions"));
    const meta = await store.create({ id: "s_hung", cwd: dir, model: "m" });
    let providerCalls = 0;
    const provider: Provider = {
      name: "never-called",
      async *stream() {
        providerCalls++;
        yield terminal("unexpected");
      },
    };
    store.append = async () => new Promise<void>(() => undefined);
    const agent = new Agent({
      provider,
      model: "m",
      modelInfo: {
        providerId: "test",
        model: "m",
        capabilities: { tools: false },
        limits: { maxOutputTokens: 16 },
      },
      cwd: dir,
      system: "",
      projectMemory: false,
      injectEnv: false,
      persistence: { store, meta },
      runBudget: { maxWallTimeMs: 30 },
    });
    const events = await collect(agent, "x");
    assert.equal(providerCalls, 0);
    assert.equal(
      events.some((event) => event.type === "done"),
      false,
    );
    assert.match(
      (events.find((event) => event.type === "error") as { message: string }).message,
      /最大执行时间/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run budget: 挂起的 PreToolUse/授权确认受根 deadline，迟到放行不能执行工具", async () => {
  for (const stage of ["hook", "confirm"] as const) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), `anicode-hung-${stage}-`));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider: Provider = {
      name: stage,
      async *stream() {
        const call = {
          type: "tool_call" as const,
          id: "write-1",
          name: "write",
          args: { path: "late.txt", content: "must-not-exist" },
        };
        yield {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", content: [call] },
          usage: { ...zero, inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const agent = new Agent({
      provider,
      model: "m",
      modelInfo: {
        providerId: "test",
        model: "m",
        capabilities: { tools: true },
        limits: { maxOutputTokens: 32 },
      },
      cwd: dir,
      system: "",
      projectMemory: false,
      injectEnv: false,
      retry: false,
      permission: {
        mode: "default",
        ...(stage === "confirm"
          ? {
              confirm: async () => {
                await gate;
                return { behavior: "allow" as const };
              },
            }
          : {}),
      },
      hooks:
        stage === "hook"
          ? [
              {
                event: "PreToolUse",
                handler: async () => {
                  await gate;
                  return { decision: "allow" as const };
                },
              },
            ]
          : [],
      runBudget: { maxWallTimeMs: 30 },
    });
    const events = await collect(agent, "write");
    assert.equal(
      events.some((event) => event.type === "done"),
      false,
    );
    await assert.rejects(fs.access(path.join(dir, "late.txt")));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(fs.access(path.join(dir, "late.txt")));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("run budget: reservation checkpoint 单调持久化，恢复后遗留 reservation 继续占额度", async () => {
  const checkpoints: RunBudgetSnapshot[] = [];
  const ledger = new RunBudgetLedger(limits(100), false, undefined, async (snapshot) => {
    checkpoints.push(structuredClone(snapshot));
  });
  const reservation = await ledger.reserveModelCall({
    estimatedInputTokens: 10,
    requestedMaxTokens: 20,
    model: "m",
  });
  assert.deepEqual(
    checkpoints.map((snapshot) => snapshot.revision),
    [1],
  );
  assert.equal(checkpoints[0]?.reservedTokens, 30);

  const restoredCheckpoints: RunBudgetSnapshot[] = [];
  const restored = new RunBudgetLedger(limits(100), false, checkpoints[0], async (snapshot) => {
    restoredCheckpoints.push(structuredClone(snapshot));
  });
  const second = await restored.reserveModelCall({
    estimatedInputTokens: 50,
    requestedMaxTokens: 20,
    model: "m",
  });
  assert.equal(restoredCheckpoints[0]?.revision, 2);
  assert.equal(restoredCheckpoints[0]?.reservedTokens, 100);
  await assert.rejects(
    restored.reserveModelCall({
      estimatedInputTokens: 1,
      requestedMaxTokens: 1,
      model: "m",
    }),
    /Token 上限/,
  );
  await second.cancel().catch(() => undefined);
  await reservation.cancel();
});

test("run budget: checkpoint 失败在 provider dispatch 前 fail-closed", async () => {
  let providerCalls = 0;
  const provider: Provider = {
    name: "must-not-run",
    async *stream() {
      providerCalls++;
      yield terminal("unexpected");
    },
  };
  const agent = new Agent({
    provider,
    model: "m",
    modelInfo: {
      providerId: "test",
      model: "m",
      capabilities: { tools: false },
      limits: { maxOutputTokens: 16 },
    },
    cwd: process.cwd(),
    system: "",
    projectMemory: false,
    injectEnv: false,
    onRunBudgetCheckpoint: async () => {
      throw new Error("durable store unavailable");
    },
  });
  const events = await collect(agent, "x");
  assert.equal(providerCalls, 0);
  assert.match(
    (events.find((event) => event.type === "error") as { message: string }).message,
    /checkpoint.*durable store unavailable/,
  );
});

test("run budget: terminal stop reason 持久化，崩溃恢复后不能重新开放命令", async () => {
  const checkpoints: RunBudgetSnapshot[] = [];
  const ledger = new RunBudgetLedger(limits(10), false, undefined, (snapshot) => {
    checkpoints.push(structuredClone(snapshot));
  });
  await assert.rejects(
    ledger.reserveModelCall({
      estimatedInputTokens: 10,
      requestedMaxTokens: 1,
      model: "m",
    }),
    /Token 上限/,
  );
  await ledger.whenCheckpointed();
  const terminal = checkpoints.at(-1)!;
  assert.match(terminal.terminalReason ?? "", /Token 上限/);

  const restored = new RunBudgetLedger(limits(10), false, terminal);
  assert.equal(restored.signal.aborted, true);
  await assert.rejects(
    restored.reserveModelCall({
      estimatedInputTokens: 1,
      requestedMaxTokens: 1,
      model: "m",
    }),
    /Token 上限/,
  );
});

test("run budget: 不合作的 checkpoint callback 也受 root wall deadline", async () => {
  let providerCalls = 0;
  const provider: Provider = {
    name: "must-not-run",
    async *stream() {
      providerCalls++;
      yield terminal("unexpected");
    },
  };
  const agent = new Agent({
    provider,
    model: "m",
    modelInfo: {
      providerId: "test",
      model: "m",
      capabilities: { tools: false },
      limits: { maxOutputTokens: 16 },
    },
    cwd: process.cwd(),
    system: "",
    projectMemory: false,
    injectEnv: false,
    runBudget: { maxWallTimeMs: 30 },
    onRunBudgetCheckpoint: () => new Promise<void>(() => undefined),
  });
  const started = Date.now();
  const events = await collect(agent, "x");
  assert.ok(Date.now() - started < 500);
  assert.equal(providerCalls, 0);
  assert.match(
    (events.find((event) => event.type === "error") as { message: string }).message,
    /最大执行时间/,
  );
});

test("run budget: invalid provider usage 不可用 NaN/负数毒化账本", async () => {
  for (const invalid of [
    { ...zero, inputTokens: Number.NaN },
    { ...zero, outputTokens: -1 },
    { ...zero, cacheReadTokens: Number.POSITIVE_INFINITY },
  ]) {
    const checkpoints: RunBudgetSnapshot[] = [];
    const provider: Provider = {
      name: "invalid-usage",
      async *stream() {
        yield terminal("invalid", invalid);
      },
    };
    const agent = new Agent({
      provider,
      model: "m",
      modelInfo: {
        providerId: "test",
        model: "m",
        capabilities: { tools: false },
        limits: { maxOutputTokens: 32 },
      },
      cwd: process.cwd(),
      system: "",
      projectMemory: false,
      injectEnv: false,
      retry: false,
      runBudget: { maxTotalTokens: 10_000 },
      onRunBudgetCheckpoint: (snapshot) => {
        checkpoints.push(structuredClone(snapshot));
      },
    });
    const events = await collect(agent, "x");
    assert.match(
      (events.find((event) => event.type === "error") as { message: string }).message,
      /无效 usage/,
    );
    assert.equal(
      agent.messages.some((message) => message.role === "assistant"),
      false,
    );
    const durable = checkpoints.at(-1)!;
    assert.ok(validFiniteUsage(durable.chargedUsage));
    assert.equal(durable.reservedTokens, 0);
  }
});

test("run budget: 工具上报 invalid usage 会 fail-closed 且不污染 Conversation", async () => {
  let providerCalls = 0;
  const provider: Provider = {
    name: "invalid-tool-usage",
    async *stream() {
      providerCalls++;
      yield {
        type: "done",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [{ type: "tool_call", id: "bad-usage", name: "bad_usage", args: {} }],
        },
        usage: { ...zero, inputTokens: 1 },
      };
    },
  };
  const tools = new ToolRegistry();
  tools.register({
    def: { name: "bad_usage", description: "bad usage", parameters: { type: "object" } },
    readOnly: true,
    ruleKey: () => "bad_usage",
    async run(_input, ctx) {
      ctx.addUsage?.({ ...zero, inputTokens: Number.NaN });
      return "must not succeed";
    },
  });
  const checkpoints: RunBudgetSnapshot[] = [];
  const agent = new Agent({
    provider,
    model: "m",
    modelInfo: {
      providerId: "test",
      model: "m",
      capabilities: { tools: true },
      limits: { maxOutputTokens: 32 },
    },
    cwd: process.cwd(),
    system: "",
    projectMemory: false,
    injectEnv: false,
    retry: false,
    tools,
    permission: { mode: "auto" },
    onRunBudgetCheckpoint: (snapshot) => {
      checkpoints.push(structuredClone(snapshot));
    },
  });

  const events = await collect(agent, "x");
  assert.equal(providerCalls, 1);
  assert.equal(
    events.some((event) => event.type === "done"),
    false,
  );
  assert.match(
    (events.find((event) => event.type === "error") as { message: string }).message,
    /usage.*非负安全整数|usage.*安全整数/i,
  );
  assert.ok(validFiniteUsage(agent.totalUsage));
  assert.deepEqual(agent.totalUsage, { ...zero, inputTokens: 1 });
  assert.ok(checkpoints.every((snapshot) => validFiniteUsage(snapshot.chargedUsage)));
});

test("run budget: 模型价格必填字段无效时 fail-closed", async () => {
  const ledger = new RunBudgetLedger(limits(100), true);
  await assert.rejects(
    ledger.reserveModelCall({
      estimatedInputTokens: 1,
      requestedMaxTokens: 1,
      model: "bad-cost",
      cost: { input: undefined, output: 1 } as unknown as { input: number; output: number },
    }),
    /价格配置无效/,
  );
});

test("run budget: Agent 显式 maxCostUSD 缺输出上限时不派发 provider", async () => {
  let providerCalls = 0;
  const provider: Provider = {
    name: "must-not-run",
    async *stream() {
      providerCalls++;
      yield terminal("unexpected");
    },
  };
  const agent = new Agent({
    provider,
    model: "unbounded-priced-model",
    modelInfo: {
      providerId: "test",
      model: "unbounded-priced-model",
      capabilities: { tools: false },
      limits: {},
      cost: { input: 3, output: 15 },
    },
    cwd: process.cwd(),
    system: "",
    projectMemory: false,
    injectEnv: false,
    retry: false,
    runBudget: { maxCostUSD: 1 },
  });

  const events = await collect(agent, "x");
  assert.equal(providerCalls, 0);
  assert.match(
    (events.find((event) => event.type === "error") as { message: string }).message,
    /没有可信输出上限.*成本硬上限/,
  );
});

test("run budget: 显式成本硬上限要求输出边界，默认预算兼容缺失模型元数据", async () => {
  const cost = { input: 3, output: 15 };
  const compatible = new RunBudgetLedger(limits(100));
  const reservation = await compatible.reserveModelCall({
    estimatedInputTokens: 2,
    model: "compatible-proxy",
    cost,
  });
  assert.equal(reservation.maxTokens, undefined, "不得向兼容端点伪造 provider 输出上限");
  await reservation.commit({ ...zero, inputTokens: 2, outputTokens: 3 });
  assert.ok(Math.abs(compatible.snapshot().chargedCostUSD - (2 * 3 + 3 * 15) / 1_000_000) < 1e-12);
  assert.equal(compatible.snapshot().reservedCostUSD, 0);

  const hard = new RunBudgetLedger(limits(100), true);
  await assert.rejects(
    hard.reserveModelCall({
      estimatedInputTokens: 2,
      model: "unbounded-priced-model",
      cost,
    }),
    /没有可信输出上限.*成本硬上限/,
  );
  assert.equal(hard.signal.aborted, true, "显式硬成本上限必须在 provider dispatch 前停止");

  const bounded = new RunBudgetLedger({ ...limits(1_000), maxCostUSD: 0.0001 }, true);
  const boundedReservation = await bounded.reserveModelCall({
    estimatedInputTokens: 10,
    requestedMaxTokens: 100,
    model: "bounded-priced-model",
    cost: { input: 1, output: 10 },
  });
  assert.equal(boundedReservation.maxTokens, 8, "成本预算收窄后的输出上限必须实际传给 provider");
  await boundedReservation.cancel();
});

test("run budget: tree-global tool semaphore 对共享 ledger 统一背压", async () => {
  const ledger = new RunBudgetLedger({ ...limits(1_000), maxConcurrentTools: 2 });
  const signal = new AbortController().signal;
  const release1 = await ledger.acquireToolSlot(signal);
  const release2 = await ledger.acquireToolSlot(signal);
  let thirdAcquired = false;
  const third = ledger.acquireToolSlot(signal).then((release) => {
    thirdAcquired = true;
    return release;
  });
  await Promise.resolve();
  assert.equal(thirdAcquired, false);
  release1();
  const release3 = await third;
  assert.equal(thirdAcquired, true);
  release2();
  release3();
});

test("run budget: 多个 detached child 的工具并发也受同一个 tree semaphore", async () => {
  let active = 0;
  let peak = 0;
  const blocker: Tool = {
    def: { name: "block", description: "block", parameters: { type: "object" } },
    readOnly: true,
    ruleKey: () => "block",
    async run() {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active--;
      return "released";
    },
  };
  let parentTurns = 0;
  let childCall = 0;
  const provider: Provider = {
    name: "tree-tools",
    async *stream(req) {
      if (req.system === "PARENT") {
        parentTurns++;
        if (parentTurns === 1) {
          const calls = ["one", "two"].map((name, index) => ({
            type: "tool_call" as const,
            id: `task-${index}`,
            name: "task",
            args: { description: name, prompt: name, background: true },
          }));
          yield {
            type: "done",
            stopReason: "tool_use",
            message: { role: "assistant", content: calls },
            usage: { ...zero, inputTokens: 1 },
          };
          return;
        }
        yield terminal("parent done", { ...zero, inputTokens: 1 });
        return;
      }
      const hasResult = req.messages.some((message) =>
        message.content.some((part) => part.type === "tool_result"),
      );
      if (!hasResult) {
        const call = {
          type: "tool_call" as const,
          id: `child-block-${++childCall}`,
          name: "block",
          args: {},
        };
        yield {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", content: [call] },
          usage: { ...zero, inputTokens: 1 },
        };
        return;
      }
      yield terminal("child done", { ...zero, inputTokens: 1 });
    },
  };
  const agent = new Agent({
    provider,
    model: "m",
    modelInfo: {
      providerId: "test",
      model: "m",
      capabilities: { tools: true },
      limits: { maxOutputTokens: 100 },
    },
    cwd: process.cwd(),
    system: "PARENT",
    projectMemory: false,
    injectEnv: false,
    tools: new ToolRegistry().register(blocker),
    subagents: true,
    permission: { mode: "auto" },
    retry: false,
    runBudget: { maxConcurrentTools: 1 },
  });
  await collect(agent, "start");
  await agent.awaitBackgroundTasksIdle();
  assert.equal(agent.backgroundTasks.length, 2);
  assert.ok(agent.backgroundTasks.every((task) => task.status === "done"));
  assert.equal(peak, 1);
});

test("run budget: 非有限配置不会静默回落默认值", () => {
  const provider: Provider = { name: "p", async *stream() {} };
  assert.throws(
    () =>
      new Agent({
        provider,
        model: "m",
        cwd: process.cwd(),
        runBudget: { maxTotalTokens: Number.NaN },
      }),
    /maxTotalTokens/,
  );
});

function validFiniteUsage(usage: Usage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}
