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

test("PostgreSQL snapshot upsert rejects sequence regression", async () => {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const database = {
    pool: {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, ...(params ? { params } : {}) });
        return { rows: [] };
      },
    },
  } as unknown as PostgresRuntimeDatabase;

  await new PostgresRuntimeSnapshotStore(database).put({
    version: 1,
    streamId: "snapshot-order",
    sequence: 100,
    phase: "completed",
    activeTools: [],
    events: 100,
    createdAt: "2026-08-20T00:00:00.000Z",
  });

  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /WHERE excluded\.sequence >= anicode_runtime_snapshots\.sequence/);
});

test("PostgreSQL fenced event commit: one query round-trip and stale fence fails closed", async () => {
  const calls: Array<{ sql: string; params?: readonly unknown[] }> = [];
  const eventRow = {
    id: "rte_fenced_event",
    stream_id: "session_fenced_event",
    sequence: "7",
    timestamp: "2026-08-20T00:00:00.000Z",
    type: "command.budget_checkpoint",
    data: { commandId: "command_fenced_event", snapshot: { revision: 3 } },
    correlation_id: null,
    causation_id: null,
    idempotency_key: "command:command_fenced_event:budget:3",
    trace_id: null,
    span_id: null,
  };
  const database = {
    pool: {
      async query(sql: string, params?: readonly unknown[]) {
        calls.push({ sql, ...(params ? { params } : {}) });
        return { rows: [eventRow] };
      },
    },
  } as unknown as PostgresRuntimeDatabase;
  const store = new PostgresCommandInboxStore(database);
  const committed = await store.commitFencedEvent({
    sessionId: "session_fenced_event",
    commandId: "command_fenced_event",
    owner: "checkpoint-owner",
    fencingToken: 9,
    leaseMs: 60_000,
    event: {
      streamId: "session_fenced_event",
      type: "command.budget_checkpoint",
      data: eventRow.data,
      idempotencyKey: eventRow.idempotency_key,
    },
  });
  assert.equal(calls.length, 1, "the entire fenced commit must be one pool query");
  assert.equal(committed.id, eventRow.id);
  assert.match(calls[0]!.sql, /UPDATE anicode_commands/);
  assert.match(calls[0]!.sql, /pg_advisory_xact_lock/);
  assert.match(calls[0]!.sql, /INSERT INTO anicode_runtime_events/);
  assert.match(calls[0]!.sql, /INSERT INTO anicode_outbox/);

  let staleCalls = 0;
  const staleDatabase = {
    pool: {
      async query() {
        staleCalls++;
        return { rows: [] };
      },
    },
  } as unknown as PostgresRuntimeDatabase;
  await assert.rejects(
    new PostgresCommandInboxStore(staleDatabase).commitFencedEvent({
      sessionId: "session_fenced_event",
      commandId: "command_fenced_event",
      owner: "stale-owner",
      fencingToken: 8,
      leaseMs: 60_000,
      event: {
        streamId: "session_fenced_event",
        type: "command.budget_checkpoint",
        data: eventRow.data,
        idempotencyKey: eventRow.idempotency_key,
      },
    }),
    /Stale fencing token/,
  );
  assert.equal(staleCalls, 1);

  let contendedCalls = 0;
  const contendedDatabase = {
    pool: {
      async query() {
        contendedCalls++;
        if (contendedCalls === 1) {
          throw Object.assign(new Error("concurrent stream sequence"), {
            code: "23505",
            constraint: "anicode_runtime_events_pkey",
          });
        }
        return { rows: [eventRow] };
      },
    },
  } as unknown as PostgresRuntimeDatabase;
  assert.equal(
    (
      await new PostgresCommandInboxStore(contendedDatabase).commitFencedEvent({
        sessionId: "session_fenced_event",
        commandId: "command_fenced_event",
        owner: "checkpoint-owner",
        fencingToken: 9,
        leaseMs: 60_000,
        event: {
          streamId: "session_fenced_event",
          type: "command.budget_checkpoint",
          data: eventRow.data,
          idempotencyKey: eventRow.idempotency_key,
        },
      })
    ).id,
    eventRow.id,
  );
  assert.equal(
    contendedCalls,
    2,
    "a lock-wait MVCC conflict retries with a fresh statement snapshot",
  );
});

test("PostgreSQL session store: load uses one transaction snapshot", async () => {
  const sessionId = "session_snapshot";
  const first = {
    meta: {
      id: sessionId,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      cwd: "/workspace",
      workspace_device: null,
      workspace_inode: null,
      model: "model-a",
      title: "snapshot-a",
    },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "snapshot-a" }],
      },
    ],
  };
  const replacement = {
    meta: {
      ...first.meta,
      updated_at: "2026-01-02T00:00:00.000Z",
      model: "model-b",
      title: "snapshot-b",
    },
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "snapshot-b" }],
      },
    ],
  };
  let live = structuredClone(first);
  let transactionCalls = 0;
  let poolCalls = 0;
  const database = {
    pool: {
      async query(sql: string) {
        poolCalls++;
        if (sql.startsWith("SELECT * FROM anicode_sessions")) {
          const meta = structuredClone(live.meta);
          live = structuredClone(replacement);
          return { rows: [meta] };
        }
        return { rows: live.messages.map((data) => ({ data: structuredClone(data) })) };
      },
    },
    async transaction<T>(
      work: (client: {
        query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
      }) => Promise<T> | T,
    ): Promise<T> {
      transactionCalls++;
      const snapshot = structuredClone(live);
      return work({
        async query(sql: string) {
          if (sql.startsWith("SELECT * FROM anicode_sessions")) {
            const meta = structuredClone(snapshot.meta);
            // Model a rewrite committing between the two SELECT statements. Transaction-local
            // reads must continue to observe the original metadata and transcript together.
            live = structuredClone(replacement);
            return { rows: [meta] };
          }
          return {
            rows: snapshot.messages.map((data) => ({ data: structuredClone(data) })),
          };
        },
      });
    },
  } as unknown as PostgresRuntimeDatabase;

  const store = new PostgresSessionStore(database);
  assert.equal(store.storageSemantics, "transactional-primary");
  const loaded = await store.load(sessionId);
  assert.equal(loaded.title, "snapshot-a");
  assert.equal(loaded.model, "model-a");
  assert.equal((loaded.messages[0]!.content[0] as { text: string }).text, "snapshot-a");
  assert.equal(transactionCalls, 1);
  assert.equal(poolCalls, 0, "load must not split a logical session across pool connections");
});

test("PostgreSQL session store: load never escapes a failed commit", async () => {
  const database = {
    pool: {
      async query() {
        return { rows: [] };
      },
    },
    async transaction<T>(
      work: (client: {
        query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
      }) => Promise<T> | T,
    ): Promise<T> {
      await work({
        async query(sql: string) {
          if (sql.startsWith("SELECT * FROM anicode_sessions")) {
            return {
              rows: [
                {
                  id: "session_commit_failure",
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                  cwd: "/workspace",
                  model: "model-a",
                },
              ],
            };
          }
          return { rows: [] };
        },
      });
      throw new Error("simulated commit failure");
    },
  } as unknown as PostgresRuntimeDatabase;

  await assert.rejects(
    () => new PostgresSessionStore(database).load("session_commit_failure"),
    /simulated commit failure/,
  );
});

test("PostgreSQL session store: appendMany and rewrite use one ordered bulk INSERT", async () => {
  type QueryCall = { sql: string; params: unknown[] | undefined };
  const transactions: QueryCall[][] = [];
  const database = {
    pool: {
      async query() {
        return { rows: [] };
      },
    },
    async transaction<T>(
      work: (client: {
        query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
      }) => Promise<T> | T,
    ): Promise<T> {
      const calls: QueryCall[] = [];
      transactions.push(calls);
      return work({
        async query(sql, params) {
          calls.push({ sql, params });
          const normalized = sql.replace(/\s+/g, " ").trim();
          if (normalized.startsWith("SELECT id FROM anicode_sessions")) {
            return { rows: [{ id: "session_bulk" }] };
          }
          if (normalized.startsWith("SELECT COALESCE(MAX(idx)")) {
            return { rows: [{ next_idx: "7" }] };
          }
          return { rows: [] };
        },
      });
    },
  } as unknown as PostgresRuntimeDatabase;
  const store = new PostgresSessionStore(database);
  const messages = [
    { role: "user" as const, content: [{ type: "text" as const, text: "first" }] },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "second" }] },
  ];

  await store.appendMany("session_bulk", messages);
  assert.equal(transactions.length, 1);
  const appendInserts = transactions[0]!.filter((call) =>
    call.sql.includes("INSERT INTO anicode_session_messages"),
  );
  assert.equal(appendInserts.length, 1, "the whole flush must use one INSERT round-trip");
  assert.match(appendInserts[0]!.sql, /jsonb_array_elements/);
  assert.match(appendInserts[0]!.sql, /WITH ORDINALITY/);
  assert.equal(appendInserts[0]!.params?.[1], 7);
  assert.deepEqual(JSON.parse(String(appendInserts[0]!.params?.[2])), messages);
  assert.ok(transactions[0]!.at(-1)!.sql.startsWith("UPDATE anicode_sessions"));

  await store.appendMany("session_bulk", []);
  assert.equal(transactions.length, 1, "an empty append is a no-op");

  const meta = {
    id: "session_bulk",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/workspace",
    model: "model-a",
  };
  await store.rewrite(meta, messages);
  assert.equal(transactions.length, 2);
  const rewriteInserts = transactions[1]!.filter((call) =>
    call.sql.includes("INSERT INTO anicode_session_messages"),
  );
  assert.equal(rewriteInserts.length, 1, "rewrite must not issue one INSERT per message");
  assert.equal(rewriteInserts[0]!.params?.[1], 0);
  assert.deepEqual(JSON.parse(String(rewriteInserts[0]!.params?.[2])), messages);
  assert.notEqual(meta.updatedAt, "2026-01-01T00:00:00.000Z");
});

test("PostgreSQL session store: metadata fast paths never read or rewrite messages", async () => {
  const baseRow = {
    id: "session_meta",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    cwd: "/workspace",
    workspace_device: "device-a",
    workspace_inode: "inode-a",
    model: "model-a",
    title: "before",
  };
  const poolCalls: string[] = [];
  const transactionCalls: string[] = [];
  const database = {
    pool: {
      async query(sql: string, params?: unknown[]) {
        poolCalls.push(sql);
        return { rows: params?.[0] === "missing_meta" ? [] : [baseRow] };
      },
    },
    async transaction<T>(
      work: (client: {
        query(sql: string): Promise<{ rows: Record<string, unknown>[] }>;
      }) => Promise<T> | T,
    ): Promise<T> {
      return work({
        async query(sql) {
          transactionCalls.push(sql);
          return {
            rows: [
              {
                ...baseRow,
                updated_at: "2026-01-03T00:00:00.000Z",
                model: "model-b",
                title: "after",
              },
            ],
          };
        },
      });
    },
  } as unknown as PostgresRuntimeDatabase;
  const store = new PostgresSessionStore(database);

  assert.equal((await store.getMeta("session_meta"))?.title, "before");
  assert.equal(await store.getMeta("missing_meta"), undefined);
  const updated = await store.updateMeta({
    id: "session_meta",
    createdAt: baseRow.created_at,
    updatedAt: baseRow.updated_at,
    cwd: "/workspace",
    workspaceIdentity: { device: "device-a", inode: "inode-a" },
    model: "model-b",
    title: "after",
  });
  assert.equal(updated.updatedAt, "2026-01-03T00:00:00.000Z");
  assert.equal(updated.title, "after");
  assert.equal(poolCalls.length, 2);
  assert.equal(transactionCalls.length, 1);
  assert.match(transactionCalls[0]!, /^UPDATE anicode_sessions/);
  assert.ok(
    [...poolCalls, ...transactionCalls].every((sql) => !sql.includes("anicode_session_messages")),
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
      const sessionMessages = [
        { role: "user" as const, content: [{ type: "text" as const, text: "bulk-one" }] },
        {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "bulk-two" }],
        },
      ];
      await sessions.appendMany(sessionId, sessionMessages);
      const storedMeta = await sessions.getMeta(sessionId);
      assert.ok(storedMeta);
      const updatedMeta = await sessions.updateMeta({ ...storedMeta, title: "fast-path-title" });
      assert.equal(updatedMeta.title, "fast-path-title");
      const loadedSession = await sessions.load(sessionId);
      assert.deepEqual(loadedSession.messages, sessionMessages);
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

      const postgresCommandStore = new PostgresCommandInboxStore(database);
      const inbox = new CommandInbox(postgresCommandStore);
      const command = await inbox.accept({
        sessionId,
        text: "durable",
        idempotencyKey: `command-${suffix}`,
      });
      assert.equal(
        (
          await inbox.accept({
            sessionId,
            text: "durable",
            idempotencyKey: `command-${suffix}`,
          })
        ).id,
        command.id,
      );
      await assert.rejects(
        inbox.accept({
          sessionId,
          text: "different",
          idempotencyKey: `command-${suffix}`,
        }),
        /different prompt or model/,
      );
      const commandLease = await inbox.claim(sessionId, command.id, "command-worker", 5_000);
      await inbox.finish(sessionId, command.id, "completed", undefined, {
        owner: "command-worker",
        fencingToken: commandLease.fencingToken!,
      });
      await inbox.finish(sessionId, command.id, "completed");
      await assert.rejects(
        inbox.finish(sessionId, command.id, "failed", "late overwrite"),
        /Stale fencing token/,
      );
      assert.equal((await inbox.get(sessionId, command.id))?.status, "completed");

      // PostgreSQL—not the Node host—owns every lease comparison. Explicit caller timestamps and
      // a monkey-patched application clock must neither steal live work nor revive expired work.
      const skewedCommand = await inbox.accept({
        sessionId,
        text: "clock-skew",
        idempotencyKey: `clock-skew-${suffix}`,
      });
      const skewedLease = await inbox.claim(
        sessionId,
        skewedCommand.id,
        "clock-owner-a",
        5_000,
        Number.MIN_SAFE_INTEGER,
      );
      await assert.rejects(
        inbox.claim(sessionId, skewedCommand.id, "clock-owner-b", 5_000, Number.MAX_SAFE_INTEGER),
        /leased/,
      );
      assert.equal(
        (await inbox.recoverable(sessionId, Number.MAX_SAFE_INTEGER)).some(
          (candidate) => candidate.id === skewedCommand.id,
        ),
        false,
      );
      await inbox.heartbeat(
        sessionId,
        skewedCommand.id,
        "clock-owner-a",
        60_000,
        skewedLease.fencingToken,
      );
      const checkpointKey = `command:${skewedCommand.id}:budget:1`;
      const checkpointEvent = {
        streamId: sessionId,
        type: "command.budget_checkpoint",
        data: { commandId: skewedCommand.id, snapshot: { revision: 1 } },
        idempotencyKey: checkpointKey,
      };
      await assert.rejects(
        postgresCommandStore.commitFencedEvent({
          sessionId,
          commandId: skewedCommand.id,
          owner: "clock-owner-a",
          fencingToken: skewedLease.fencingToken! + 1,
          leaseMs: 60_000,
          event: checkpointEvent,
        }),
        /Stale fencing token/,
      );
      assert.equal(
        Number(
          (
            await database.pool.query(
              "SELECT COUNT(*) AS count FROM anicode_runtime_events WHERE stream_id = $1 AND idempotency_key = $2",
              [sessionId, checkpointKey],
            )
          ).rows[0]?.count,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await database.pool.query(
              "SELECT COUNT(*) AS count FROM anicode_outbox WHERE idempotency_key = $1",
              [checkpointKey],
            )
          ).rows[0]?.count,
        ),
        0,
        "a stale command fence must commit neither side of the event/outbox pair",
      );
      const checkpoint = await postgresCommandStore.commitFencedEvent({
        sessionId,
        commandId: skewedCommand.id,
        owner: "clock-owner-a",
        fencingToken: skewedLease.fencingToken!,
        leaseMs: 60_000,
        event: checkpointEvent,
      });
      assert.equal(
        (
          await postgresCommandStore.commitFencedEvent({
            sessionId,
            commandId: skewedCommand.id,
            owner: "clock-owner-a",
            fencingToken: skewedLease.fencingToken!,
            leaseMs: 60_000,
            event: checkpointEvent,
          })
        ).id,
        checkpoint.id,
      );
      assert.equal(
        Number(
          (
            await database.pool.query(
              "SELECT COUNT(*) AS count FROM anicode_runtime_events WHERE stream_id = $1 AND idempotency_key = $2",
              [sessionId, checkpointKey],
            )
          ).rows[0]?.count,
        ),
        1,
      );
      const checkpointOutbox = await database.pool.query(
        "SELECT status, data->>'sentEventId' AS sent_event_id FROM anicode_outbox WHERE idempotency_key = $1",
        [checkpointKey],
      );
      assert.equal(checkpointOutbox.rows.length, 1);
      assert.equal(checkpointOutbox.rows[0]?.status, "sent");
      assert.equal(checkpointOutbox.rows[0]?.sent_event_id, checkpoint.id);

      const postgresOutboxStore = new PostgresOutboxStore(database);
      const skewRuntime = new DurableRuntime(new PostgresRuntimeEventStore(database));
      const skewOutbox = new DurableOutbox(postgresOutboxStore, skewRuntime);
      const skewMessage = await skewOutbox.enqueue({
        streamId: sessionId,
        type: "clock.pending",
        data: {},
        idempotencyKey: `clock-outbox-${suffix}`,
      });
      const outboxLease = await postgresOutboxStore.claimMessage("outbox-owner-a", 5_000);
      assert.equal(outboxLease?.id, skewMessage.id);

      const skewWorktree = `/tmp/anicode-postgres-clock-${suffix}`;
      const skewOwnership = new WorktreeOwnership(workerStore);
      const skewWorktreeLease = await skewOwnership.acquire(skewWorktree, "clock-owner-a", 5_000);
      const originalDateNow = Date.now;
      Date.now = () => originalDateNow() + 365 * 24 * 60 * 60_000;
      try {
        await inbox.heartbeat(
          sessionId,
          skewedCommand.id,
          "clock-owner-a",
          5_000,
          skewedLease.fencingToken,
        );
        await assert.rejects(
          () => skewOwnership.acquire(skewWorktree, "clock-owner-b", 5_000),
          /owned by clock-owner-a/,
        );
        await skewOwnership.heartbeat(
          skewWorktree,
          "clock-owner-a",
          5_000,
          skewWorktreeLease.fencingToken,
        );
        assert.equal(await postgresOutboxStore.claimMessage("outbox-owner-b", 5_000), undefined);
        await postgresOutboxStore.markFailed(outboxLease!, "outbox-owner-a", "retry");
      } finally {
        Date.now = originalDateNow;
      }

      const reclaimedOutbox = await postgresOutboxStore.claimMessage("outbox-owner-b", 5_000);
      assert.equal(reclaimedOutbox?.id, skewMessage.id);
      await database.pool.query(
        "UPDATE anicode_outbox SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
        [skewMessage.id],
      );
      await assert.rejects(
        postgresOutboxStore.markSent(reclaimedOutbox!, "outbox-owner-b", "too-late"),
        /expired fencing token/,
      );
      const finalOutboxLease = await postgresOutboxStore.claimMessage("outbox-owner-c", 5_000);
      assert.equal(finalOutboxLease?.id, skewMessage.id);
      await postgresOutboxStore.markSent(
        finalOutboxLease!,
        "outbox-owner-c",
        "clock-skew-test-sent",
      );

      await database.pool.query(
        "UPDATE anicode_commands SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE session_id = $1 AND id = $2",
        [sessionId, skewedCommand.id],
      );
      await assert.rejects(
        inbox.finish(sessionId, skewedCommand.id, "completed", undefined, {
          owner: "clock-owner-a",
          fencingToken: skewedLease.fencingToken!,
        }),
        /Stale fencing token/,
      );

      await database.pool.query(
        "UPDATE anicode_worktree_leases SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE worktree = $1",
        [skewWorktree],
      );
      await assert.rejects(
        skewOwnership.release(skewWorktree, "clock-owner-a", skewWorktreeLease.fencingToken),
        /Cannot release unowned worktree/,
      );
      assert.equal(
        (await skewOwnership.acquire(skewWorktree, "clock-owner-b", 5_000)).fencingToken,
        skewWorktreeLease.fencingToken + 1,
      );

      const snapshotStore = new PostgresRuntimeSnapshotStore(database);
      const snapshotStream = `snapshot_${suffix}`;
      await snapshotStore.put({
        version: 1,
        streamId: snapshotStream,
        sequence: 100,
        phase: "completed",
        activeTools: [],
        events: 100,
        createdAt: "2026-08-20T00:00:00.000Z",
      });
      await snapshotStore.put({
        version: 1,
        streamId: snapshotStream,
        sequence: 90,
        phase: "running",
        activeTools: ["stale-tool"],
        events: 90,
        createdAt: "2026-08-19T00:00:00.000Z",
      });
      assert.equal((await snapshotStore.get(snapshotStream))?.sequence, 100);

      const runtime = new DurableRuntime(new PostgresRuntimeEventStore(database), snapshotStore);
      const outbox = new DurableOutbox(new PostgresOutboxStore(database), runtime);
      await outbox.publish({
        streamId: sessionId,
        type: "integration.completed",
        data: { ok: true },
        idempotencyKey: `event-${suffix}`,
      });
      assert.equal((await outbox.pending()).length, 0);
      assert.equal(
        (await runtime.events(sessionId)).filter(
          (event) => event.idempotencyKey === `event-${suffix}`,
        ).length,
        1,
      );
    } finally {
      await database.close();
    }
  },
);
