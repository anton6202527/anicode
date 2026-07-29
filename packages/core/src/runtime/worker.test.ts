import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DurableWorkerQueue, FileWorkerQueueStore, WorktreeOwnership } from "./worker.js";

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
