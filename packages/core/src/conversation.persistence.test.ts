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
