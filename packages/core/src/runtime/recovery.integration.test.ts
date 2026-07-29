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
