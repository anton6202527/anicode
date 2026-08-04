import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Provider, StreamEvent } from "../types.js";
import { SessionManager } from "../session-manager.js";
import { SessionStore } from "../session.js";
import { CommandInbox, DurableOutbox, FileCommandInboxStore, FileOutboxStore } from "./commands.js";
import { DurableRuntime, FileRuntimeEventStore, FileRuntimeSnapshotStore } from "./durable.js";

const provider: Provider = {
  name: "recovery-test",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", text: "resumed" };
    yield {
      type: "done",
      stopReason: "end_turn",
      message: { role: "assistant", content: [{ type: "text", text: "resumed" }] },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

test("SessionManager: 启动扫描过期 inbox lease 并真正续跑到 completed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-recovery-"));
  try {
    const sessions = new SessionStore(path.join(root, "sessions"));
    const seed = new SessionManager({
      store: sessions,
      resolveProvider: () => ({ provider, model: "test" }),
      recoverCommands: false,
    });
    const created = await seed.createSession({ cwd: root, model: "test" });
    seed.dispose();

    const inbox = new CommandInbox(new FileCommandInboxStore(path.join(root, "inbox")));
    const command = await inbox.accept({
      sessionId: created.id,
      text: "finish after crash",
      idempotencyKey: "crash-command",
      messageCountBefore: 0,
    });
    await inbox.claim(created.id, command.id, "dead-worker", 1_000, Date.now() - 2_000);
    const runtime = new DurableRuntime(
      new FileRuntimeEventStore(path.join(root, "events")),
      new FileRuntimeSnapshotStore(path.join(root, "snapshots")),
      1,
    );
    const manager = new SessionManager({
      store: sessions,
      resolveProvider: () => ({ provider, model: "test" }),
      commandInbox: inbox,
      runtime,
      outbox: new DurableOutbox(new FileOutboxStore(path.join(root, "outbox")), runtime),
    });
    await manager.recoverAllCommands();
    assert.equal((await inbox.get(created.id, command.id))?.status, "completed");
    const opened = await manager.open(created.id, () => {});
    assert.equal(
      opened.snapshot.messages.filter((message) => message.role === "user").length,
      1,
      "原始 prompt 只能进入历史一次",
    );
    assert.match(
      opened.snapshot.messages
        .flatMap((message) => message.content)
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
      /finish after crash.*resumed/s,
    );
    const state = await runtime.recover(created.id);
    assert.equal(state.phase, "completed");
    manager.dispose();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SessionManager: inbox 终态与 outbox 之间崩溃后由重试/启动幂等补齐规范事件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-terminal-reconcile-"));
  try {
    const sessions = new SessionStore(path.join(root, "sessions"));
    const seed = new SessionManager({
      store: sessions,
      resolveProvider: () => ({ provider, model: "test" }),
      recoverCommands: false,
    });
    const created = await seed.createSession({ cwd: root, model: "test" });
    await seed.shutdown();

    const inbox = new CommandInbox(new FileCommandInboxStore(path.join(root, "inbox")));
    const terminalCommands = await Promise.all(
      (["completed", "failed", "cancelled"] as const).map(async (status) => {
        const command = await inbox.accept({
          sessionId: created.id,
          text: `terminal-${status}`,
          idempotencyKey: `terminal-${status}`,
        });
        const lease = await inbox.claim(created.id, command.id, "crashed-worker", 60_000);
        await inbox.finish(
          created.id,
          command.id,
          status,
          status === "completed" ? undefined : `terminal ${status}`,
          { owner: "crashed-worker", fencingToken: lease.fencingToken! },
        );
        return { ...command, status };
      }),
    );

    const runtime = new DurableRuntime(
      new FileRuntimeEventStore(path.join(root, "events")),
      new FileRuntimeSnapshotStore(path.join(root, "snapshots")),
      1,
    );
    const outbox = new DurableOutbox(
      new FileOutboxStore(path.join(root, "outbox", "events.json")),
      runtime,
    );
    const manager = new SessionManager({
      store: sessions,
      resolveProvider: () => ({ provider, model: "test" }),
      commandInbox: inbox,
      runtime,
      outbox,
      recoverCommands: false,
    });

    // Same-idempotency HTTP/TUI retries reconcile a terminal inbox row even when the original
    // process crashed before enqueueing its terminal event.
    await manager.send(created.id, "terminal-completed", {
      idempotencyKey: "terminal-completed",
    });
    await assert.rejects(
      manager.send(created.id, "terminal-failed", { idempotencyKey: "terminal-failed" }),
      /terminal failed/,
    );
    await assert.rejects(
      manager.send(created.id, "terminal-cancelled", { idempotencyKey: "terminal-cancelled" }),
      /terminal cancelled/,
    );

    // Startup reconciliation is independently safe to repeat and must not append duplicates.
    await manager.recoverAllCommands();
    await manager.recoverAllCommands();
    const events = await runtime.events(created.id);
    for (const command of terminalCommands) {
      const key = `command:${command.id}:${command.status}`;
      const matches = events.filter((event) => event.idempotencyKey === key);
      assert.equal(matches.length, 1, `${key} must exist exactly once`);
      assert.equal(matches[0]?.type, `prompt.${command.status}`);
      assert.equal((matches[0]?.data as { commandId?: string }).commandId, command.id);
    }
    await manager.shutdown();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SessionManager: crash recovery restores reserved budget and cannot reset the hard cap", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-budget-recovery-"));
  try {
    const sessions = new SessionStore(path.join(root, "sessions"));
    const seed = new SessionManager({
      store: sessions,
      resolveProvider: () => ({ provider, model: "test" }),
      recoverCommands: false,
    });
    const created = await seed.createSession({ cwd: root, model: "test" });
    await seed.shutdown();

    const inbox = new CommandInbox(new FileCommandInboxStore(path.join(root, "inbox")));
    const command = await inbox.accept({
      sessionId: created.id,
      text: "must not receive a fresh budget",
      idempotencyKey: "budget-crash-command",
    });
    await inbox.claim(created.id, command.id, "dead-worker", 1_000, Date.now() - 2_000);
    const runtime = new DurableRuntime(
      new FileRuntimeEventStore(path.join(root, "events")),
      new FileRuntimeSnapshotStore(path.join(root, "snapshots")),
      1,
    );
    await runtime.record({
      streamId: created.id,
      type: "command.budget_checkpoint",
      data: {
        commandId: command.id,
        snapshot: {
          version: 1,
          revision: 1,
          startedAt: Date.parse(command.createdAt),
          chargedUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
          },
          chargedCostUSD: 0,
          reservedTokens: 10,
          reservedCostUSD: 0,
          toolCalls: 0,
        },
      },
      idempotencyKey: `command:${command.id}:budget:1`,
    });
    let providerCalls = 0;
    const countedProvider: Provider = {
      name: "counted-recovery",
      async *stream(): AsyncIterable<StreamEvent> {
        providerCalls++;
        yield* provider.stream({ model: "test", messages: [] });
      },
    };
    const manager = new SessionManager({
      store: sessions,
      resolveProvider: () => ({ provider: countedProvider, model: "test" }),
      commandInbox: inbox,
      runtime,
      outbox: new DurableOutbox(new FileOutboxStore(path.join(root, "outbox")), runtime),
      runBudget: { maxTotalTokens: 10 },
      recoverCommands: false,
    });
    await manager.recoverAllCommands();
    assert.equal(providerCalls, 0, "a crashed reservation must still consume the recovered cap");
    assert.equal((await inbox.get(created.id, command.id))?.status, "failed");
    await manager.shutdown();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
