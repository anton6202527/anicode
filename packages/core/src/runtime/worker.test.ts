import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DurableWorkerQueue,
  FileWorkerQueueStore,
  PersistentWorker,
  WorktreeOwnership,
} from "./worker.js";

test("PersistentWorker: lease/cancel loss aborts the handler and cannot overwrite cancelled", async () => {
  const queue = new DurableWorkerQueue();
  const job = await queue.enqueue("blocking", {});
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  let aborted = false;
  const worker = new PersistentWorker(
    "worker-cancel",
    queue,
    {
      async blocking(_payload, signal) {
        started();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        aborted = signal.aborted;
        return "late";
      },
    },
    1_000,
  );
  const running = worker.runOnce();
  await didStart;
  assert.equal(await queue.cancel(job.id), true);
  await running;
  assert.equal(aborted, true);
  assert.equal((await queue.get(job.id))?.status, "cancelled");
});

test("Worker: 过期 lease 被另一个 worker 续跑，heartbeat 保持所有权", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-worker-"));
  try {
    const store = new FileWorkerQueueStore(path.join(root, "queue.json"));
    const queue = new DurableWorkerQueue(store);
    const original = await queue.enqueue("eval", { task: 1 }, { idempotencyKey: "same" });
    assert.equal((await queue.enqueue("eval", {}, { idempotencyKey: "same" })).id, original.id);
    const first = await queue.claim("worker-a", undefined, 1_000);
    assert.equal(first?.attempts, 1);
    await assert.rejects(() => queue.heartbeat(original.id, "worker-b", 1_000), /unowned/);
    // 用持久文档模拟 worker-a 崩溃后 lease 到期。
    const raw = JSON.parse(await fs.readFile(path.join(root, "queue.json"), "utf8"));
    raw.jobs[0].leaseExpiresAt = new Date(Date.now() - 1).toISOString();
    await fs.writeFile(path.join(root, "queue.json"), JSON.stringify(raw));
    const second = await queue.claim("worker-b", undefined, 1_000);
    assert.equal(second?.id, original.id);
    assert.equal(second?.attempts, 2);
    await queue.finish(original.id, "worker-b", { ok: true });
    assert.equal((await queue.list())[0]?.status, "succeeded");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FileWorkerQueueStore: stale mtime never steals an existing lock", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-worker-lock-"));
  try {
    const queueFile = path.join(root, "queue.json");
    const lockFile = `${queueFile}.lock`;
    const owner = {
      version: 1,
      ownerToken: "c".repeat(64),
      pid: process.pid,
      host: "live-owner",
      acquiredAt: new Date(0).toISOString(),
    };
    await fs.writeFile(lockFile, JSON.stringify(owner), { mode: 0o600 });
    await fs.utimes(lockFile, new Date(0), new Date(0));
    const queue = new DurableWorkerQueue(
      new FileWorkerQueueStore(queueFile, { lockTimeoutMs: 40, lockRetryMs: 5 }),
    );

    await assert.rejects(() => queue.enqueue("blocked", {}), /Worker queue lock timeout/);
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, "utf8")), owner);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("FileWorkerQueueStore: release is conditional on the owner token", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-worker-token-"));
  try {
    const queueFile = path.join(root, "queue.json");
    const lockFile = `${queueFile}.lock`;
    const replacement = {
      version: 1,
      ownerToken: "d".repeat(64),
      pid: process.pid,
      host: "replacement",
      acquiredAt: new Date().toISOString(),
    };
    const store = new FileWorkerQueueStore(queueFile);
    await store.transact(async () => {
      await fs.writeFile(lockFile, JSON.stringify(replacement));
    });

    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, "utf8")), replacement);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("WorktreeOwnership: 活跃租约独占，释放后可转移", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ownership-"));
  try {
    const store = new FileWorkerQueueStore(path.join(root, "queue.json"));
    const ownership = new WorktreeOwnership(store);
    await ownership.acquire("/tmp/anicode-wt", "one");
    await assert.rejects(() => ownership.acquire("/tmp/anicode-wt", "two"), /owned by one/);
    // ownership 与普通队列共享持久文档，但绝不能被一个未限定 type 的 worker 误领。
    assert.equal(await new DurableWorkerQueue(store).claim("worker"), undefined);
    await ownership.release("/tmp/anicode-wt", "one");
    assert.equal((await ownership.acquire("/tmp/anicode-wt", "two")).owner, "two");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
