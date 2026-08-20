import { test } from "node:test";
import assert from "node:assert/strict";
import { Conversation } from "./conversation.js";
import type { ISessionStore, SessionMeta } from "./session.js";

const meta: SessionMeta = {
  id: "s_persist",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  cwd: "/tmp",
  model: "m",
};

test("Conversation persistence: caller abort 后底层迟到失败仍由 shutdown fence 报告", async () => {
  let rejectAppend!: (error: Error) => void;
  const append = new Promise<void>((_resolve, reject) => (rejectAppend = reject));
  const store: ISessionStore = {
    async create() {
      return meta;
    },
    async append() {
      await append;
    },
    async rewrite() {},
    async load() {
      return { ...meta, messages: [] };
    },
    async list() {
      return [meta];
    },
    async delete() {},
  };
  const conversation = new Conversation({ store, meta });
  conversation.pushUser("must persist");
  const controller = new AbortController();
  const flush = conversation.flush(controller.signal);
  await Promise.resolve();
  controller.abort(new Error("drive deadline"));
  await assert.rejects(flush, /drive deadline/);

  rejectAppend(new Error("disk unavailable"));
  await assert.rejects(
    conversation.whenPersisted(),
    (error: unknown) =>
      error instanceof AggregateError &&
      error.errors.some(
        (cause) => cause instanceof Error && /disk unavailable/.test(cause.message),
      ),
  );
});

test("Conversation persistence: metadata rewrite queues behind append and becomes active atomically", async () => {
  let releaseAppend!: () => void;
  const gate = new Promise<void>((resolve) => (releaseAppend = resolve));
  const order: string[] = [];
  const store: ISessionStore = {
    async create() {
      return meta;
    },
    async append() {
      order.push("append:start");
      await gate;
      order.push("append:end");
    },
    async rewrite(nextMeta) {
      order.push(`rewrite:${nextMeta.title}`);
    },
    async load() {
      return { ...meta, messages: [] };
    },
    async list() {
      return [meta];
    },
    async delete() {},
  };
  const conversation = new Conversation({ store, meta });
  conversation.pushUser("x");
  const flush = conversation.flush();
  await Promise.resolve();
  const title = conversation.updatePersistenceMeta({ ...meta, title: "new" });
  await Promise.resolve();
  assert.deepEqual(order, ["append:start"]);
  releaseAppend();
  await Promise.all([flush, title, conversation.whenPersisted()]);
  assert.deepEqual(order, ["append:start", "append:end", "rewrite:new"]);
});

test("Conversation persistence: an in-flight append keeps a stable high-water mark", async () => {
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
  const persisted: string[] = [];
  const store: ISessionStore = {
    async create() {
      return meta;
    },
    async append(_id, message) {
      const text = message.content.find((part) => part.type === "text")?.text ?? "";
      if (persisted.length === 0) await firstGate;
      persisted.push(text);
    },
    async rewrite() {},
    async load() {
      return { ...meta, messages: [] };
    },
    async list() {
      return [meta];
    },
    async delete() {},
  };
  const conversation = new Conversation({ store, meta });
  conversation.pushUser("first");
  const firstFlush = conversation.flush();
  await Promise.resolve();
  conversation.pushUser("second");
  const secondFlush = conversation.flush();

  releaseFirst();
  await Promise.all([firstFlush, secondFlush, conversation.whenPersisted()]);

  assert.deepEqual(persisted, ["first", "second"]);
});

test("Conversation persistence: transactional stores receive one ordered batch per flush", async () => {
  const batches: string[][] = [];
  const store: ISessionStore = {
    async create() {
      return meta;
    },
    async append() {
      assert.fail("appendMany-capable stores must not fall back to per-message commits");
    },
    async appendMany(_id, messages) {
      batches.push(
        messages.map((message) => message.content.find((part) => part.type === "text")?.text ?? ""),
      );
    },
    async rewrite() {},
    async load() {
      return { ...meta, messages: [] };
    },
    async list() {
      return [meta];
    },
    async delete() {},
  };
  const conversation = new Conversation({ store, meta });
  conversation.pushUser("one");
  conversation.pushAssistant({
    role: "assistant",
    content: [{ type: "text", text: "two" }],
  });
  await conversation.flush();
  conversation.pushUser("three");
  await conversation.flush();

  assert.deepEqual(batches, [["one", "two"], ["three"]]);
});

test("Conversation persistence: metadata fast path never rewrites the transcript", async () => {
  const updates: SessionMeta[] = [];
  const store: ISessionStore = {
    async create() {
      return meta;
    },
    async append() {},
    async updateMeta(nextMeta) {
      updates.push(nextMeta);
      return { ...nextMeta, updatedAt: "2026-08-20T00:00:00.000Z" };
    },
    async rewrite() {
      assert.fail("metadata-only updates must not rewrite transcript rows");
    },
    async load() {
      return { ...meta, messages: [] };
    },
    async list() {
      return [meta];
    },
    async delete() {},
  };
  const conversation = new Conversation({ store, meta });

  await conversation.updatePersistenceMeta({ ...meta, title: "fast title" });
  await conversation.whenPersisted();

  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.title, "fast title");
});
