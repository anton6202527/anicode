import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session.js";
import { MemoryArtifactStore } from "./runtime/artifacts.js";
import { DurableRuntime, MemoryRuntimeEventStore } from "./runtime/durable.js";
import type { Provider, StreamEvent, StreamRequest } from "./types.js";

const usage = { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

/** Parent launches one detached task and finishes; child remains blocked until shutdown aborts it. */
function interruptedTaskProvider(): Provider {
  let parentTurns = 0;
  return {
    name: "scripted",
    async *stream(request: StreamRequest): AsyncIterable<StreamEvent> {
      const parent = request.tools?.some((tool) => tool.name === "task") ?? false;
      if (!parent) {
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) return resolve();
          request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("child interrupted");
      }
      parentTurns++;
      if (parentTurns === 1) {
        const part = {
          type: "tool_call" as const,
          id: "call_task",
          name: "task",
          args: {
            description: "耐久任务",
            prompt: "必须跨重启保存的子任务 prompt",
            background: true,
          },
        };
        yield { type: "tool_call_start", id: part.id, name: part.name };
        yield { type: "tool_call_end", part };
        yield {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", content: [part] },
          usage,
        };
        return;
      }
      yield { type: "text_delta", text: "父任务已继续" };
      yield {
        type: "done",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "父任务已继续" }],
        },
        usage,
      };
    },
  };
}

test("background subagent: 状态与子会话 checkpoint 跨 SessionManager 重启恢复", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-subagent-durable-"));
  const store = new SessionStore(path.join(root, "sessions"));
  const artifacts = new MemoryArtifactStore();
  const runtime = new DurableRuntime(new MemoryRuntimeEventStore());
  try {
    const first = new SessionManager({
      store,
      artifacts,
      runtime,
      resolveProvider: () => ({ provider: interruptedTaskProvider(), model: "scripted" }),
      subagents: true,
      permission: { mode: "auto" },
    });
    const created = await first.createSession({ cwd: root, model: "scripted" });
    await first.send(created.id, "启动后台任务");
    assert.equal((await first.resumeSession(created.id)).backgroundTasks?.[0]?.status, "running");
    for (let attempt = 0; attempt < 100; attempt++) {
      const candidates = await artifacts.list(created.id);
      const hasPrompt = (
        await Promise.all(
          candidates.map(async (artifact) => {
            const record = await artifacts.get(created.id, artifact.id);
            return record ? new TextDecoder().decode(record.data) : "";
          }),
        )
      ).some((body) => body.includes("必须跨重启保存的子任务 prompt"));
      if (hasPrompt) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const privateStates = (await artifacts.list(created.id)).filter(
      (artifact) => artifact.mediaType === "application/vnd.anicode.subagent-state+json",
    );
    assert.ok(privateStates.length >= 1);
    assert.ok(privateStates.length <= 2, "每个 task 最多保留两代 last-known-good checkpoint");
    const privateId = privateStates[0]!.id;
    assert.deepEqual(await first.listArtifacts(created.id), []);
    assert.equal(await first.getArtifact(created.id, privateId), undefined);
    assert.equal(await first.openArtifact(created.id, privateId), undefined);
    assert.equal(await first.deleteArtifact(created.id, privateId), false);
    assert.equal(
      (await first.runtimeEvents(created.id)).some((event) => event.type === "subagent.state"),
      false,
      "private artifact locator must not cross the public runtime API",
    );
    await first.shutdown();

    const events = await runtime.events(created.id);
    assert.ok(events.some((event) => event.type === "subagent.state"));
    const stored = await artifacts.list(created.id);
    const states = stored.filter(
      (artifact) => artifact.mediaType === "application/vnd.anicode.subagent-state+json",
    );
    assert.ok(states.length >= 1);
    const bodies = await Promise.all(
      states.map(async (artifact) => {
        const record = await artifacts.get(created.id, artifact.id);
        return record ? new TextDecoder().decode(record.data) : "";
      }),
    );
    assert.ok(bodies.some((body) => body.includes("必须跨重启保存的子任务 prompt")));

    const restarted = new SessionManager({
      store,
      artifacts,
      runtime,
      resolveProvider: () => ({ provider: interruptedTaskProvider(), model: "scripted" }),
      subagents: true,
      permission: { mode: "auto" },
    });
    const resumed = await restarted.resumeSession(created.id);
    assert.equal(resumed.backgroundTasks?.length, 1);
    assert.equal(resumed.backgroundTasks?.[0]?.id, "t1");
    assert.equal(resumed.backgroundTasks?.[0]?.status, "stopped");
    await restarted.shutdown();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("background subagent: detached usage credit 幂等落盘并在重启后恢复", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-subagent-usage-"));
  const store = new SessionStore(path.join(root, "sessions"));
  const artifacts = new MemoryArtifactStore();
  const runtime = new DurableRuntime(new MemoryRuntimeEventStore());
  let releaseChild!: () => void;
  const childGate = new Promise<void>((resolve) => (releaseChild = resolve));
  let parentTurn = 0;
  const parentUsage = {
    inputTokens: 2,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  const childUsage = {
    inputTokens: 7,
    outputTokens: 5,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
  };
  const provider: Provider = {
    name: "durable-usage",
    async *stream(request): AsyncIterable<StreamEvent> {
      const child = request.messages.some((message) =>
        message.content.some((part) => part.type === "text" && part.text === "后台计费子任务"),
      );
      if (child) {
        await childGate;
        yield {
          type: "done",
          stopReason: "end_turn",
          message: { role: "assistant", content: [{ type: "text", text: "子任务完成" }] },
          usage: childUsage,
        };
        return;
      }
      const turn = parentTurn++;
      if (turn === 0) {
        const part = {
          type: "tool_call" as const,
          id: "spawn_usage",
          name: "task",
          args: {
            description: "后台计费",
            prompt: "后台计费子任务",
            background: true,
          },
        };
        yield { type: "tool_call_start", id: part.id, name: part.name };
        yield { type: "tool_call_end", part };
        yield {
          type: "done",
          stopReason: "tool_use",
          message: { role: "assistant", content: [part] },
          usage: parentUsage,
        };
        return;
      }
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: `父轮${turn}` }] },
        usage: parentUsage,
      };
    },
  };

  try {
    const first = new SessionManager({
      store,
      artifacts,
      runtime,
      resolveProvider: () => ({ provider, model: "durable-usage" }),
      subagents: true,
      permission: { mode: "auto" },
    });
    const created = await first.createSession({ cwd: root, model: "durable-usage" });
    await first.send(created.id, "启动计费");
    releaseChild();

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      const hasCredit = (await runtime.events(created.id)).some(
        (event) => event.type === "subagent.usage_credited",
      );
      const snapshot = first.peek(created.id);
      if (
        hasCredit &&
        snapshot?.backgroundTasks?.[0]?.status === "done" &&
        snapshot.running === false
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const beforeRestart = first.peek(created.id)!;
    assert.equal(beforeRestart.backgroundTasks?.[0]?.status, "done");
    assert.ok(
      (await runtime.events(created.id)).some((event) => event.type === "subagent.usage_credited"),
    );
    await first.shutdown();

    const restarted = new SessionManager({
      store,
      artifacts,
      runtime,
      resolveProvider: () => ({ provider, model: "durable-usage" }),
      subagents: true,
      permission: { mode: "auto" },
      recoverCommands: false,
    });
    const resumed = await restarted.resumeSession(created.id);
    assert.deepEqual(resumed.usage, beforeRestart.usage);
    assert.equal(resumed.backgroundTasks?.[0]?.status, "done");
    await restarted.shutdown();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("background subagent: recovery 绑定 envelope version、event task 与 artifact metadata", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-subagent-integrity-"));
  const store = new SessionStore(path.join(root, "sessions"));
  const artifacts = new MemoryArtifactStore();
  const runtime = new DurableRuntime(new MemoryRuntimeEventStore());
  const provider = interruptedTaskProvider();
  try {
    const creator = new SessionManager({
      store,
      artifacts,
      runtime,
      resolveProvider: () => ({ provider, model: "scripted" }),
      recoverCommands: false,
    });
    const created = await creator.createSession({ cwd: root, model: "scripted" });
    await creator.shutdown();
    const task = {
      id: "t1",
      type: "general",
      description: "integrity",
      status: "done",
      background: true,
      messages: [],
      result: "must not restore",
    } as const;
    const future = await artifacts.put({
      sessionId: created.id,
      kind: "other",
      name: "future.json",
      mediaType: "application/vnd.anicode.subagent-state+json",
      data: JSON.stringify({ version: 2, task }),
      metadata: { taskId: "t1" },
    });
    const legacy = await artifacts.put({
      sessionId: created.id,
      kind: "other",
      name: "legacy.json",
      mediaType: "application/vnd.anicode.subagent-state+json",
      data: JSON.stringify({ version: 0, task }),
      metadata: { taskId: "t1" },
    });
    const substituted = await artifacts.put({
      sessionId: created.id,
      kind: "other",
      name: "substituted.json",
      mediaType: "application/vnd.anicode.subagent-state+json",
      data: JSON.stringify({ version: 1, task }),
      metadata: { taskId: "t2" },
    });
    await runtime.record({
      streamId: created.id,
      type: "subagent.state",
      data: { taskId: "t1", status: "done", artifactId: future.id },
      idempotencyKey: "integrity:future",
    });
    await runtime.record({
      streamId: created.id,
      type: "subagent.state",
      data: { taskId: "t1", status: "done", artifactId: legacy.id },
      idempotencyKey: "integrity:legacy",
    });
    await runtime.record({
      streamId: created.id,
      type: "subagent.state",
      data: { taskId: "t1", status: "done", artifactId: substituted.id },
      idempotencyKey: "integrity:substitution",
    });

    const restarted = new SessionManager({
      store,
      artifacts,
      runtime,
      resolveProvider: () => ({ provider, model: "scripted" }),
      subagents: true,
      recoverCommands: false,
    });
    const resumed = await restarted.resumeSession(created.id);
    assert.deepEqual(resumed.backgroundTasks ?? [], []);
    await restarted.shutdown();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
