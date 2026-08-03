import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CommandInbox, DurableOutbox } from "./commands.js";
import { DurableRuntime } from "./durable.js";
import {
  PostgresCommandInboxStore,
  PostgresOutboxStore,
  PostgresRuntimeDatabase,
  PostgresRuntimeEventStore,
  PostgresRuntimeSnapshotStore,
  PostgresSessionLifecycleStore,
  PostgresSessionStore,
  PostgresWorkerQueueStore,
} from "./postgres.js";
import { DurableWorkerQueue, WorkerQueueQuotaError, WorktreeOwnership } from "./worker.js";

const databaseUrl = process.env.ANICODE_TEST_DATABASE_URL;

test("PostgreSQL: production timeouts cannot be disabled or made unbounded", async () => {
  await assert.rejects(
    () => PostgresRuntimeDatabase.open({ statement_timeout: false }),
    /statement timeout.*100.*300000/i,
  );
  await assert.rejects(
    () => PostgresRuntimeDatabase.open({ connectionTimeoutMillis: 0 }),
    /connection timeout.*100.*300000/i,
  );
});

test(
  "PostgreSQL: normalized inbox/outbox/queue、SKIP LOCKED 与 fencing token",
  { skip: databaseUrl ? false : "ANICODE_TEST_DATABASE_URL is not configured" },
  async () => {
    const database = await PostgresRuntimeDatabase.open(databaseUrl!);
    const suffix = randomUUID().replace(/-/g, "");
    try {
      await database.healthCheck();
      const migrations = await database.pool.query(
        "SELECT version, checksum FROM anicode_schema_migrations WHERE version IN (3, 4, 5) ORDER BY version",
      );
      assert.deepEqual(
        migrations.rows.map((row) => Number(row.version)),
        [3, 4, 5],
      );
      assert.ok(migrations.rows.every((row) => /^[a-f0-9]{64}$/.test(String(row.checksum))));

      const workerStore = new PostgresWorkerQueueStore(database);
      const queue = new DurableWorkerQueue(workerStore);
      const type = `integration-${suffix}`;
      const queued = await queue.enqueue(type, { value: 1 }, { idempotencyKey: suffix });
      assert.equal(
        (await queue.enqueue(type, { value: 2 }, { idempotencyKey: suffix })).id,
        queued.id,
      );
      const firstLease = await queue.claim("worker-a", [type], 1_000);
      assert.equal(firstLease?.fencingToken, 1);
      await database.pool.query(
        "UPDATE anicode_worker_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [queued.id],
      );
      const secondLease = await queue.claim("worker-b", [type], 1_000);
      assert.equal(secondLease?.fencingToken, 2);
      await assert.rejects(
        () => queue.finish(queued.id, "worker-a", { stale: true }, firstLease?.fencingToken),
        /unowned/,
      );
      await queue.finish(queued.id, "worker-b", { ok: true }, secondLease?.fencingToken);
      assert.equal((await queue.get(queued.id))?.status, "succeeded");

      const cancellable = await queue.enqueue(
        type,
        { value: "cancel" },
        { idempotencyKey: `cancel-${suffix}` },
      );
      const cancellationLease = await queue.claim("worker-cancel", [type], 5_000);
      assert.equal(cancellationLease?.id, cancellable.id);
      assert.equal(await queue.requestCancellation(cancellable.id), "cancellation_requested");
      assert.equal((await queue.get(cancellable.id))?.status, "cancellation_requested");
      await assert.rejects(
        () =>
          queue.acknowledgeCancellation(
            cancellable.id,
            "worker-cancel",
            (cancellationLease?.fencingToken ?? 0) + 1,
          ),
        /unowned|stale/i,
      );
      await queue.acknowledgeCancellation(
        cancellable.id,
        "worker-cancel",
        cancellationLease?.fencingToken,
      );
      assert.equal((await queue.get(cancellable.id))?.status, "cancelled");

      const quota = {
        tenantId: `tenant-${suffix}`,
        actor: `actor-${suffix}`,
        maxOutstandingPerTenant: 1,
        maxQueuedPerActor: 1,
      };
      const concurrentQuota = await Promise.allSettled([
        queue.enqueue(
          type,
          { tenantId: quota.tenantId, actor: quota.actor, value: "a" },
          { idempotencyKey: `quota-a-${suffix}`, quota },
        ),
        queue.enqueue(
          type,
          { tenantId: quota.tenantId, actor: quota.actor, value: "b" },
          { idempotencyKey: `quota-b-${suffix}`, quota },
        ),
      ]);
      assert.equal(
        concurrentQuota.filter((result) => result.status === "fulfilled").length,
        1,
        "SERIALIZABLE quota check must admit only one concurrent job",
      );
      const rejected = concurrentQuota.find((result) => result.status === "rejected");
      assert.ok(rejected?.status === "rejected");
      assert.ok(rejected.reason instanceof WorkerQueueQuotaError);

      const ownership = new WorktreeOwnership(workerStore);
      const worktree = `/tmp/anicode-postgres-${suffix}`;
      const lease = await ownership.acquire(worktree, "owner-a", 5_000);
      await ownership.heartbeat(worktree, "owner-a", 5_000);
      await ownership.release(worktree, "owner-a", lease.fencingToken);
      assert.equal((await ownership.acquire(worktree, "owner-b", 5_000)).fencingToken, 2);

      const sessionId = `session_${suffix}`;
      const sessions = new PostgresSessionStore(database);
      await sessions.create({
        id: sessionId,
        cwd: "/tmp",
        workspaceIdentity: { device: "pg-device", inode: "pg-inode" },
        model: "integration",
      });
      assert.deepEqual((await sessions.load(sessionId)).workspaceIdentity, {
        device: "pg-device",
        inode: "pg-inode",
      });

      const lifecycleA = new PostgresSessionLifecycleStore(database);
      const lifecycleB = new PostgresSessionLifecycleStore(database);
      const operation = await lifecycleA.acquireOperation({
        sessionId,
        owner: `producer-${suffix}`,
        ttlMs: 5_000,
        workspace: "/tmp",
        workspaceIdentity: { device: "pg-device", inode: "pg-inode" },
      });
      const deletion = await lifecycleB.claimDeletion({
        sessionId,
        owner: `deleter-${suffix}`,
        ttlMs: 5_000,
        workspace: "/tmp",
        workspaceIdentity: { device: "pg-device", inode: "pg-inode" },
      });
      assert.equal(deletion.claimed, true);
      assert.equal(deletion.activeLeases, 1);
      await assert.rejects(
        () =>
          lifecycleB.acquireOperation({
            sessionId,
            owner: `late-${suffix}`,
            ttlMs: 5_000,
          }),
        /deleted/,
      );
      await lifecycleA.releaseOperation(operation);
      assert.equal((await lifecycleB.get(sessionId))?.activeLeases, 0);
      assert.equal(await lifecycleB.completeDeletion(deletion), true);
      assert.equal((await lifecycleA.get(sessionId))?.state, "deleted");
      assert.ok(
        (await lifecycleA.listDeleted({ limit: 1_000, workspace: "/tmp" })).some(
          (record) => record.sessionId === sessionId,
        ),
      );
      await sessions.delete(sessionId);

      const inbox = new CommandInbox(new PostgresCommandInboxStore(database));
      const command = await inbox.accept({
        sessionId,
        text: "durable",
        idempotencyKey: `command-${suffix}`,
      });
      assert.equal(
        (
          await inbox.accept({
            sessionId,
            text: "duplicate",
            idempotencyKey: `command-${suffix}`,
          })
        ).id,
        command.id,
      );
      const commandLease = await inbox.claim(sessionId, command.id, "command-worker", 5_000);
      await inbox.finish(sessionId, command.id, "completed", undefined, {
        owner: "command-worker",
        fencingToken: commandLease.fencingToken!,
      });
      assert.equal((await inbox.get(sessionId, command.id))?.status, "completed");

      const runtime = new DurableRuntime(
        new PostgresRuntimeEventStore(database),
        new PostgresRuntimeSnapshotStore(database),
      );
      const outbox = new DurableOutbox(new PostgresOutboxStore(database), runtime);
      await outbox.publish({
        streamId: sessionId,
        type: "integration.completed",
        data: { ok: true },
        idempotencyKey: `event-${suffix}`,
      });
      assert.equal((await outbox.pending()).length, 0);
      assert.equal((await runtime.events(sessionId)).length, 1);
    } finally {
      await database.close();
    }
  },
);
