import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CommandInbox, DurableOutbox, FileCommandInboxStore, FileOutboxStore } from "./commands.js";
import { DurableRuntime, FileRuntimeEventStore, FileRuntimeSnapshotStore } from "./durable.js";

test("command inbox: 幂等接收、租约过期恢复与终态持久化", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-command-inbox-"));
  try {
    const inbox = new CommandInbox(new FileCommandInboxStore(path.join(dir, "commands")));
    const first = await inbox.accept({
      sessionId: "s_1",
      text: "修复测试",
      idempotencyKey: "request-1",
      messageCountBefore: 3,
    });
    const duplicate = await inbox.accept({
      sessionId: "s_1",
      text: "修复测试",
      idempotencyKey: "request-1",
    });
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.text, "修复测试");
    await assert.rejects(
      inbox.accept({
        sessionId: "s_1",
        text: "不能偷换的请求",
        idempotencyKey: "request-1",
      }),
      /different prompt or model/,
    );

    const running = await inbox.claim("s_1", first.id, "worker-a", 1_000);
    assert.equal(running.status, "running");
    assert.equal(running.attempts, 1);
    assert.equal((await inbox.recoverable("s_1", Date.now())).length, 0);
    assert.equal((await inbox.recoverable("s_1", Date.now() + 2_000)).length, 1);

    await inbox.claim("s_1", first.id, "worker-b", 1_000, Date.now() + 2_000);
    await inbox.finish("s_1", first.id, "completed");
    await inbox.finish("s_1", first.id, "completed");
    await assert.rejects(
      inbox.finish("s_1", first.id, "failed", "late overwrite"),
      /already completed/,
    );
    const reloaded = new CommandInbox(new FileCommandInboxStore(path.join(dir, "commands")));
    assert.equal((await reloaded.get("s_1", first.id))?.status, "completed");
    assert.equal((await reloaded.recoverable("s_1", Date.now() + 10_000)).length, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("durable outbox + snapshot: 待发事件可重放，snapshot 后只投影增量", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-outbox-"));
  try {
    const runtime = new DurableRuntime(
      new FileRuntimeEventStore(path.join(dir, "events")),
      new FileRuntimeSnapshotStore(path.join(dir, "snapshots")),
      2,
    );
    const store = new FileOutboxStore(path.join(dir, "outbox", "events.json"));
    const outbox = new DurableOutbox(store, runtime);
    await outbox.enqueue({
      streamId: "s_1",
      type: "prompt.accepted",
      data: { commandId: "c1" },
      idempotencyKey: "c1:accepted",
    });
    assert.equal((await outbox.pending()).length, 1);

    // 模拟进程重启：新实例读取同一 outbox 后重放。
    const restarted = new DurableOutbox(store, runtime);
    await restarted.flush();
    assert.equal((await restarted.pending()).length, 0);
    await restarted.publish({
      streamId: "s_1",
      type: "tool.started",
      data: { id: "tool-1" },
      idempotencyKey: "tool-1:start",
    });
    const before = await runtime.recover("s_1");
    assert.deepEqual(before.activeTools, ["tool-1"]);

    await runtime.reconcileInterrupted("s_1");
    const after = await runtime.recover("s_1");
    assert.deepEqual(after.activeTools, []);
    assert.ok((await fs.readdir(path.join(dir, "snapshots"))).includes("s_1.json"));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
