import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createTaskTools,
  TaskRegistry,
  type PersistedTaskRecord,
  type TaskUsageCredit,
} from "./subagent.js";
import { HookRunner } from "./hooks.js";
import { ToolRegistry, type ToolContext } from "./tools/tool.js";
import type { Agent, AgentOptions } from "./agent.js";

const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function context(): ToolContext {
  return { cwd: "/tmp", signal: new AbortController().signal };
}

function blockingChild() {
  let finish!: (text: string | null) => void;
  const messages: unknown[] = [];
  const totalUsage = { ...zero };
  const agent = {
    messages,
    totalUsage,
    async *send(_prompt: string, signal?: AbortSignal) {
      const text = await new Promise<string | null>((resolve) => {
        finish = resolve;
        signal?.addEventListener("abort", () => resolve(null), { once: true });
      });
      if (text === null) {
        yield { type: "error", message: "aborted" };
        return;
      }
      messages.push({ role: "assistant", content: [{ type: "text", text }] });
      totalUsage.outputTokens += 5;
    },
  } as unknown as Agent;
  return { agent, finish: (text: string) => finish(text) };
}

test("subagent finalization: run abort 不取消 durable usage credit，awaitIdle 跟踪到真实 settle", async () => {
  const child = blockingChild();
  const registry = new TaskRegistry();
  let creditStarted!: () => void;
  const didStart = new Promise<void>((resolve) => (creditStarted = resolve));
  let releaseCredit!: () => void;
  const creditGate = new Promise<void>((resolve) => (releaseCredit = resolve));
  const credits: TaskUsageCredit[] = [];
  const tools = createTaskTools({
    makeAgent: (_options: AgentOptions) => child.agent,
    provider: { name: "p", async *stream() {} },
    model: "m",
    cwd: "/tmp",
    tools: new ToolRegistry(),
    registry,
    notifyTaskDone: () => undefined,
    recordUsage: () => undefined,
    onTaskUsageCredited: async (credit) => {
      credits.push(credit);
      creditStarted();
      await creditGate;
    },
  });
  await tools.task.run({ description: "bg", prompt: "work", background: true }, context());
  await tools.taskStop!.run({ id: "t1" }, context());
  await didStart;
  assert.equal(credits.length, 1);
  assert.equal(credits[0]?.signal.aborted, false, "durability signal must not inherit run abort");

  let idle = false;
  const drained = registry.awaitIdle().then(() => (idle = true));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(idle, false, "raw host durability Promise must remain in the shutdown fence");
  releaseCredit();
  await drained;
  assert.equal(idle, true);
  assert.equal(registry.get("t1")?.status, "stopped");
});

test("subagent finalization: usage/state/stop hook 只结算一次", async () => {
  const child = blockingChild();
  const terminal: PersistedTaskRecord[] = [];
  const registry = new TaskRegistry([], (record) => {
    if (record.status === "done") terminal.push(record);
  });
  let credits = 0;
  let stops = 0;
  const tools = createTaskTools({
    makeAgent: () => child.agent,
    provider: { name: "p", async *stream() {} },
    model: "m",
    cwd: "/tmp",
    tools: new ToolRegistry(),
    registry,
    notifyTaskDone: () => undefined,
    recordUsage: () => undefined,
    onTaskUsageCredited: async () => {
      credits++;
    },
    parentHooks: new HookRunner([
      {
        event: "SubagentStop",
        handler: () => {
          stops++;
        },
      },
    ]),
  });
  await tools.task.run({ description: "bg", prompt: "work", background: true }, context());
  child.finish("answer");
  await registry.awaitIdle();
  assert.equal(credits, 1);
  assert.equal(stops, 1);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0]?.usage?.outputTokens, 5);
});

test("TaskRegistry: recovery normalization 与 eviction tombstone 都精确一次", async () => {
  const initial: PersistedTaskRecord[] = Array.from({ length: 34 }, (_, index) => ({
    id: `t${index + 1}`,
    type: "general",
    description: `task ${index + 1}`,
    status: index === 33 ? "running" : "done",
    background: index === 33,
    messages: [],
  }));
  const changed: string[] = [];
  const evicted: string[] = [];
  const registry = new TaskRegistry(
    initial,
    (record) => changed.push(`${record.id}:${record.status}`),
    (taskId) => evicted.push(taskId),
  );
  await Promise.resolve();
  assert.equal(registry.list().length, 32);
  assert.deepEqual(evicted.sort(), ["t1", "t2"]);
  await registry.persistRecoveredNormalization();
  await registry.persistRecoveredNormalization();
  assert.deepEqual(
    changed.filter((value) => value === "t34:stopped"),
    ["t34:stopped"],
  );
});

test("TaskRegistry.awaitIdle: 外部等待取消不会永久丢失底层 durability fence", async () => {
  const registry = new TaskRegistry();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  registry.trackDurability(pending);
  const controller = new AbortController();
  const first = registry.awaitIdle(controller.signal);
  controller.abort(new Error("caller stopped waiting"));
  await assert.rejects(first, /caller stopped waiting/);
  release();
  await registry.awaitIdle();
});
