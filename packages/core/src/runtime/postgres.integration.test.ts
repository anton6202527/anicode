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
  PostgresWorkerQueueStore,
} from "./postgres.js";
import { DurableWorkerQueue, WorktreeOwnership } from "./worker.js";

const databaseUrl = process.env.ANICODE_TEST_DATABASE_URL;

test(
  "PostgreSQL: normalized inbox/outbox/queue、SKIP LOCKED 与 fencing token",
  { skip: databaseUrl ? false : "ANICODE_TEST_DATABASE_URL is not configured" },
  async () => {
    const database = await PostgresRuntimeDatabase.open(databaseUrl!);
    const suffix = randomUUID().replace(/-/g, "");
    try {
      await database.healthCheck();
      const migration = await database.pool.query(
        "SELECT checksum FROM anicode_schema_migrations WHERE version = 3",
      );
      assert.match(String(migration.rows[0]?.checksum), /^[a-f0-9]{64}$/);

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

      const ownership = new WorktreeOwnership(workerStore);
      const worktree = `/tmp/anicode-postgres-${suffix}`;
      const lease = await ownership.acquire(worktree, "owner-a", 5_000);
      await ownership.heartbeat(worktree, "owner-a", 5_000);
      await ownership.release(worktree, "owner-a", lease.fencingToken);
      assert.equal((await ownership.acquire(worktree, "owner-b", 5_000)).fencingToken, 2);

      const sessionId = `session_${suffix}`;
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
