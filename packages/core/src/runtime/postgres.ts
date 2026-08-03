/**
 * PostgreSQL 共享控制面后端。长事务使用 SERIALIZABLE + 自动重试；文档型队列在
 * SELECT ... FOR UPDATE 下更新，跨主机 worker 不会再发生 JSON 最后写入者覆盖。
 * 可选 pgvector 表由 code-index 的 PostgresVectorStore 使用。
 */

import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import type { Artifact, ArtifactInput, ArtifactRecord, ArtifactStore } from "./artifacts.js";
import type { CommandInboxStore, DurableCommand, OutboxMessage, OutboxStore } from "./commands.js";
import type { ISessionStore, SessionData, SessionMeta } from "../session.js";
import type { ChatMessage } from "../types.js";
import type {
  AppendRuntimeEvent,
  RuntimeEvent,
  RuntimeEventStore,
  RuntimeSnapshot,
  RuntimeSnapshotStore,
} from "./durable.js";
import type { RuntimeAuditRecord } from "./sqlite.js";
import {
  WorkerQueueQuotaError,
  type WorkerCancellationResult,
  type WorkerEnqueueQuota,
  type WorkerJob,
  type WorkerQueueStore,
} from "./worker.js";
import {
  SessionLifecycleUnavailableError,
  assertLifecycleId,
  assertLifecycleTtl,
  type AcquireSessionOperationInput,
  type ClaimSessionDeletionInput,
  type SessionDeletionClaim,
  type SessionLifecycleRecord,
  type SessionLifecycleStore,
  type SessionOperationLease,
} from "./session-lifecycle.js";

type Row = Record<string, unknown>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function transient(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "40001" || code === "40P01";
}

function boundedPostgresTimeout(
  value: number | boolean | undefined,
  fallback: number,
  label: string,
): number {
  const timeout = value ?? fallback;
  if (
    typeof timeout !== "number" ||
    !Number.isInteger(timeout) ||
    timeout < 100 ||
    timeout > 300_000
  ) {
    throw new Error(`${label} must be an integer from 100 to 300000 ms`);
  }
  return timeout;
}

export class PostgresRuntimeDatabase {
  readonly pool: Pool;

  private constructor(config: PoolConfig) {
    this.pool = new Pool({
      ...config,
      connectionTimeoutMillis: boundedPostgresTimeout(
        config.connectionTimeoutMillis,
        5_000,
        "PostgreSQL connection timeout",
      ),
      query_timeout: boundedPostgresTimeout(
        config.query_timeout,
        30_000,
        "PostgreSQL query timeout",
      ),
      statement_timeout: boundedPostgresTimeout(
        config.statement_timeout,
        25_000,
        "PostgreSQL statement timeout",
      ),
      lock_timeout: boundedPostgresTimeout(config.lock_timeout, 5_000, "PostgreSQL lock timeout"),
      idle_in_transaction_session_timeout: boundedPostgresTimeout(
        config.idle_in_transaction_session_timeout,
        15_000,
        "PostgreSQL idle transaction timeout",
      ),
    });
  }

  static async open(config: string | PoolConfig): Promise<PostgresRuntimeDatabase> {
    const database = new PostgresRuntimeDatabase(
      typeof config === "string" ? { connectionString: config } : config,
    );
    await database.migrate();
    return database;
  }

  private async migrate(): Promise<void> {
    const migrationSql = `
      CREATE TABLE IF NOT EXISTS anicode_runtime_events (
        stream_id text NOT NULL,
        sequence bigint NOT NULL,
        id text NOT NULL UNIQUE,
        timestamp timestamptz NOT NULL,
        type text NOT NULL,
        data jsonb NOT NULL,
        correlation_id text,
        causation_id text,
        idempotency_key text,
        trace_id text,
        span_id text,
        PRIMARY KEY(stream_id, sequence)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_anicode_event_idempotency
        ON anicode_runtime_events(stream_id, idempotency_key)
        WHERE idempotency_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_anicode_events_type
        ON anicode_runtime_events(type, timestamp);

      CREATE TABLE IF NOT EXISTS anicode_runtime_snapshots (
        stream_id text PRIMARY KEY,
        sequence bigint NOT NULL,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS anicode_sessions (
        id text PRIMARY KEY,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        cwd text NOT NULL,
        model text NOT NULL,
        title text
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_sessions_updated
        ON anicode_sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS anicode_session_messages (
        session_id text NOT NULL REFERENCES anicode_sessions(id) ON DELETE CASCADE,
        idx bigint NOT NULL,
        data jsonb NOT NULL,
        PRIMARY KEY(session_id, idx)
      );

      CREATE TABLE IF NOT EXISTS anicode_documents (
        namespace text NOT NULL,
        key text NOT NULL,
        version bigint NOT NULL DEFAULT 0,
        data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(namespace, key)
      );

      CREATE TABLE IF NOT EXISTS anicode_worker_jobs (
        id text PRIMARY KEY,
        type text NOT NULL,
        idempotency_key text NOT NULL UNIQUE,
        payload jsonb NOT NULL,
        status text NOT NULL CHECK (status IN ('queued', 'leased', 'succeeded', 'failed', 'cancelled')),
        attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL,
        lease_owner text,
        lease_expires_at timestamptz,
        fencing_token bigint NOT NULL DEFAULT 0,
        result jsonb,
        error text,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_worker_claim
        ON anicode_worker_jobs(type, status, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_anicode_worker_retention
        ON anicode_worker_jobs(status, updated_at);

      CREATE TABLE IF NOT EXISTS anicode_worktree_leases (
        worktree text PRIMARY KEY,
        owner text,
        lease_expires_at timestamptz,
        fencing_token bigint NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS anicode_commands (
        session_id text NOT NULL,
        id text NOT NULL,
        idempotency_key text NOT NULL,
        status text NOT NULL CHECK (status IN ('accepted', 'running', 'completed', 'failed', 'cancelled')),
        lease_owner text,
        lease_expires_at timestamptz,
        fencing_token bigint NOT NULL DEFAULT 0,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL,
        PRIMARY KEY(session_id, id),
        UNIQUE(session_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_commands_recovery
        ON anicode_commands(session_id, status, lease_expires_at, created_at);

      CREATE TABLE IF NOT EXISTS anicode_outbox (
        id text PRIMARY KEY,
        idempotency_key text NOT NULL UNIQUE,
        status text NOT NULL CHECK (status IN ('pending', 'sent')),
        lease_owner text,
        lease_expires_at timestamptz,
        fencing_token bigint NOT NULL DEFAULT 0,
        data jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_outbox_pending
        ON anicode_outbox(status, lease_expires_at, created_at);

      CREATE TABLE IF NOT EXISTS anicode_artifacts (
        session_id text NOT NULL,
        id text NOT NULL,
        sha256 text NOT NULL,
        metadata jsonb NOT NULL,
        data bytea NOT NULL,
        created_at timestamptz NOT NULL,
        PRIMARY KEY(session_id, id)
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_artifacts_session
        ON anicode_artifacts(session_id, created_at);

      CREATE TABLE IF NOT EXISTS anicode_runtime_audit (
        id text PRIMARY KEY,
        timestamp timestamptz NOT NULL,
        category text NOT NULL,
        action text NOT NULL,
        subject text,
        actor text,
        decision text,
        metadata jsonb NOT NULL,
        trace_id text
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_audit_time
        ON anicode_runtime_audit(category, timestamp);

      INSERT INTO anicode_worker_jobs
        (id, type, idempotency_key, payload, status, attempts, max_attempts,
         lease_owner, lease_expires_at, fencing_token, result, error, created_at, updated_at)
      SELECT
        item->>'id', item->>'type', item->>'idempotencyKey', item->'payload', item->>'status',
        COALESCE((item->>'attempts')::integer, 0),
        COALESCE((item->>'maxAttempts')::integer, 3),
        item->>'leaseOwner', NULLIF(item->>'leaseExpiresAt', '')::timestamptz,
        COALESCE((item->>'fencingToken')::bigint, 0), item->'result', item->>'error',
        (item->>'createdAt')::timestamptz, (item->>'updatedAt')::timestamptz
      FROM anicode_documents document
      CROSS JOIN LATERAL jsonb_array_elements(document.data) item
      WHERE document.namespace = 'worker' AND document.key = 'global'
        AND item->>'type' NOT LIKE '__worktree__:%'
      ON CONFLICT DO NOTHING;

      INSERT INTO anicode_worktree_leases
        (worktree, owner, lease_expires_at, fencing_token, updated_at)
      SELECT
        item#>>'{payload,worktree}', item->>'leaseOwner',
        NULLIF(item->>'leaseExpiresAt', '')::timestamptz,
        COALESCE((item->>'fencingToken')::bigint, 0),
        (item->>'updatedAt')::timestamptz
      FROM anicode_documents document
      CROSS JOIN LATERAL jsonb_array_elements(document.data) item
      WHERE document.namespace = 'worker' AND document.key = 'global'
        AND item->>'type' LIKE '__worktree__:%'
      ON CONFLICT DO NOTHING;

      INSERT INTO anicode_commands
        (session_id, id, idempotency_key, status, lease_owner, lease_expires_at,
         fencing_token, data, created_at, updated_at)
      SELECT
        document.key, item->>'id', item->>'idempotencyKey', item->>'status',
        item->>'leaseOwner', NULLIF(item->>'leaseExpiresAt', '')::timestamptz,
        COALESCE((item->>'fencingToken')::bigint, 0), item,
        (item->>'createdAt')::timestamptz, (item->>'updatedAt')::timestamptz
      FROM anicode_documents document
      CROSS JOIN LATERAL jsonb_array_elements(document.data) item
      WHERE document.namespace = 'commands'
      ON CONFLICT DO NOTHING;

      INSERT INTO anicode_outbox
        (id, idempotency_key, status, lease_owner, lease_expires_at,
         fencing_token, data, created_at, updated_at)
      SELECT
        item->>'id', COALESCE(item#>>'{event,idempotencyKey}', item->>'id'), item->>'status',
        item->>'leaseOwner', NULLIF(item->>'leaseExpiresAt', '')::timestamptz,
        COALESCE((item->>'fencingToken')::bigint, 0), item,
        (item->>'createdAt')::timestamptz, (item->>'updatedAt')::timestamptz
      FROM anicode_documents document
      CROSS JOIN LATERAL jsonb_array_elements(document.data) item
      WHERE document.namespace = 'outbox' AND document.key = 'global'
      ON CONFLICT DO NOTHING;
    `;
    const lifecycleMigrationSql = `
      ALTER TABLE anicode_sessions ADD COLUMN IF NOT EXISTS workspace_device text;
      ALTER TABLE anicode_sessions ADD COLUMN IF NOT EXISTS workspace_inode text;

      CREATE TABLE IF NOT EXISTS anicode_session_lifecycle (
        session_id text PRIMARY KEY,
        state text NOT NULL CHECK (state IN ('active', 'deleting', 'deleted')),
        epoch bigint NOT NULL DEFAULT 0,
        workspace text,
        workspace_device text,
        workspace_inode text,
        delete_owner text,
        delete_token text,
        delete_lease_expires_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_session_lifecycle_state
        ON anicode_session_lifecycle(state, delete_lease_expires_at);

      CREATE TABLE IF NOT EXISTS anicode_session_operation_leases (
        lease_id text PRIMARY KEY,
        session_id text NOT NULL,
        owner text NOT NULL,
        epoch bigint NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_anicode_session_operation_leases_session
        ON anicode_session_operation_leases(session_id, expires_at);
    `;
    const workerCancellationMigrationSql = `
      ALTER TABLE anicode_worker_jobs
        DROP CONSTRAINT IF EXISTS anicode_worker_jobs_status_check;
      ALTER TABLE anicode_worker_jobs
        ADD CONSTRAINT anicode_worker_jobs_status_check
        CHECK (status IN (
          'queued', 'leased', 'cancellation_requested', 'succeeded', 'failed', 'cancelled'
        ));
    `;
    const migrations = [
      {
        version: 3,
        sql: migrationSql,
        description: "normalized command, outbox, worker queue and worktree leases",
      },
      {
        version: 4,
        sql: lifecycleMigrationSql,
        description: "durable session lifecycle leases and workspace identity",
      },
      {
        version: 5,
        sql: workerCancellationMigrationSql,
        description: "two-phase durable worker cancellation",
      },
    ] as const;
    const latestVersion = migrations.at(-1)!.version;
    const client = await this.pool.connect();
    let migrationLockHeld = false;
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS anicode_schema_migrations (
          version integer PRIMARY KEY,
          checksum text,
          description text,
          applied_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE anicode_schema_migrations ADD COLUMN IF NOT EXISTS checksum text;
        ALTER TABLE anicode_schema_migrations ADD COLUMN IF NOT EXISTS description text;
      `);
      const lockDeadline = Date.now() + 10_000;
      while (!migrationLockHeld && Date.now() < lockDeadline) {
        const lock = await client.query(
          "SELECT pg_try_advisory_lock(hashtextextended('anicode:schema-migrations', 0)) AS locked",
        );
        migrationLockHeld = (lock.rows[0] as Row | undefined)?.locked === true;
        if (!migrationLockHeld) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!migrationLockHeld) {
        throw new Error("Timed out waiting for the PostgreSQL schema migration lock");
      }
      const future = await client.query(
        "SELECT version FROM anicode_schema_migrations WHERE version > $1 ORDER BY version LIMIT 1",
        [latestVersion],
      );
      if (future.rows[0]) {
        throw new Error(
          `Database schema version ${String((future.rows[0] as Row).version)} is newer than this runtime`,
        );
      }
      for (const migration of migrations) {
        const checksum = createHash("sha256").update(migration.sql).digest("hex");
        const applied = await client.query(
          "SELECT checksum FROM anicode_schema_migrations WHERE version = $1",
          [migration.version],
        );
        if (applied.rows[0]) {
          if (String((applied.rows[0] as Row).checksum ?? "") !== checksum) {
            throw new Error(`Database migration ${migration.version} checksum mismatch`);
          }
          continue;
        }
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query(
            `INSERT INTO anicode_schema_migrations(version, checksum, description)
             VALUES ($1, $2, $3)`,
            [migration.version, checksum, migration.description],
          );
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      }
    } finally {
      if (migrationLockHeld) {
        await client
          .query("SELECT pg_advisory_unlock(hashtextextended('anicode:schema-migrations', 0))")
          .catch(() => undefined);
      }
      client.release();
    }
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>, maxAttempts = 4): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        last = error;
        await client.query("ROLLBACK").catch(() => undefined);
        if (!transient(error) || attempt === maxAttempts) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 20));
      } finally {
        client.release();
      }
    }
    throw last;
  }

  async documentTransaction<T>(
    namespace: string,
    key: string,
    empty: unknown,
    work: (document: unknown) => T | Promise<T>,
  ): Promise<T> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO anicode_documents(namespace, key, data)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT(namespace, key) DO NOTHING`,
        [namespace, key, JSON.stringify(empty)],
      );
      const selected = await client.query(
        "SELECT data FROM anicode_documents WHERE namespace = $1 AND key = $2 FOR UPDATE",
        [namespace, key],
      );
      const document = clone((selected.rows[0] as Row).data);
      const result = await work(document);
      await client.query(
        `UPDATE anicode_documents
         SET data = $3::jsonb, version = version + 1, updated_at = now()
         WHERE namespace = $1 AND key = $2`,
        [namespace, key, JSON.stringify(document)],
      );
      return result;
    });
  }

  async readDocument<T>(namespace: string, key: string, fallback: T): Promise<T> {
    const result = await this.pool.query(
      "SELECT data FROM anicode_documents WHERE namespace = $1 AND key = $2",
      [namespace, key],
    );
    return result.rows[0] ? clone((result.rows[0] as Row).data as T) : clone(fallback);
  }

  async audit(input: RuntimeAuditRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO anicode_runtime_audit
       (id, timestamp, category, action, subject, actor, decision, metadata, trace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [
        input.id ?? `audit_${randomUUID()}`,
        input.timestamp ?? new Date().toISOString(),
        input.category,
        input.action,
        input.subject ?? null,
        input.actor ?? null,
        input.decision ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.traceId ?? null,
      ],
    );
  }

  async healthCheck(): Promise<void> {
    const result = await this.pool.query("SELECT 1 AS ok");
    if (Number((result.rows[0] as Row | undefined)?.ok) !== 1) {
      throw new Error("PostgreSQL readiness query failed");
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

function eventFromRow<T = unknown>(row: Row): RuntimeEvent<T> {
  return {
    id: String(row.id),
    version: 2,
    streamId: String(row.stream_id),
    sequence: Number(row.sequence),
    timestamp: new Date(String(row.timestamp)).toISOString(),
    type: String(row.type),
    data: clone(row.data as T),
    ...(row.correlation_id != null ? { correlationId: String(row.correlation_id) } : {}),
    ...(row.causation_id != null ? { causationId: String(row.causation_id) } : {}),
    ...(row.idempotency_key != null ? { idempotencyKey: String(row.idempotency_key) } : {}),
    ...(row.trace_id != null ? { traceId: String(row.trace_id) } : {}),
    ...(row.span_id != null ? { spanId: String(row.span_id) } : {}),
  };
}

function postgresLifecycleRecord(row: Row, activeLeases: number): SessionLifecycleRecord {
  return {
    sessionId: String(row.session_id),
    state: String(row.state) as SessionLifecycleRecord["state"],
    epoch: Number(row.epoch),
    activeLeases,
    ...(row.workspace != null ? { workspace: String(row.workspace) } : {}),
    ...(row.workspace_device != null && row.workspace_inode != null
      ? {
          workspaceIdentity: {
            device: String(row.workspace_device),
            inode: String(row.workspace_inode),
          },
        }
      : {}),
    ...(row.delete_owner != null ? { deleteOwner: String(row.delete_owner) } : {}),
    ...(row.delete_token != null ? { deleteToken: String(row.delete_token) } : {}),
    ...(row.delete_lease_expires_at != null
      ? { deleteLeaseExpiresAt: new Date(String(row.delete_lease_expires_at)).toISOString() }
      : {}),
  };
}

/** PostgreSQL lifecycle transitions use row locks inside SERIALIZABLE transactions. */
export class PostgresSessionLifecycleStore implements SessionLifecycleStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}

  get(sessionId: string): Promise<SessionLifecycleRecord | undefined> {
    assertIdentifier(sessionId, "session lifecycle id");
    return this.database.transaction(async (client) => {
      await this.deleteExpiredOperations(client, sessionId);
      const selected = await client.query(
        "SELECT * FROM anicode_session_lifecycle WHERE session_id = $1 FOR UPDATE",
        [sessionId],
      );
      const row = selected.rows[0] as Row | undefined;
      if (!row) return undefined;
      return postgresLifecycleRecord(row, await this.activeLeaseCount(client, sessionId));
    });
  }

  async listDeleted(input: {
    limit: number;
    afterSessionId?: string;
    workspace?: string;
  }): Promise<SessionLifecycleRecord[]> {
    this.validateListInput(input);
    const result = await this.database.pool.query(
      `SELECT * FROM anicode_session_lifecycle
       WHERE state = 'deleted'
         AND ($1::text IS NULL OR session_id > $1)
         AND ($2::text IS NULL OR workspace = $2)
       ORDER BY session_id
       LIMIT $3`,
      [input.afterSessionId ?? null, input.workspace ?? null, input.limit],
    );
    return (result.rows as Row[]).map((row) => postgresLifecycleRecord(row, 0));
  }

  acquireOperation(input: AcquireSessionOperationInput): Promise<SessionOperationLease> {
    this.validateInput(input);
    const leaseId = `sop_${randomUUID()}`;
    return this.database.transaction(async (client) => {
      await this.deleteExpiredOperations(client, input.sessionId);
      await client.query(
        `INSERT INTO anicode_session_lifecycle
         (session_id, state, epoch, workspace, workspace_device, workspace_inode)
         VALUES ($1, 'active', 0, $2, $3, $4) ON CONFLICT(session_id) DO NOTHING`,
        [
          input.sessionId,
          input.workspace ?? null,
          input.workspaceIdentity?.device ?? null,
          input.workspaceIdentity?.inode ?? null,
        ],
      );
      const selected = await client.query(
        "SELECT * FROM anicode_session_lifecycle WHERE session_id = $1 FOR UPDATE",
        [input.sessionId],
      );
      const row = selected.rows[0] as Row;
      const state = String(row.state) as SessionLifecycleRecord["state"];
      if (state !== "active") throw new SessionLifecycleUnavailableError(input.sessionId, state);
      this.assertWorkspace(row, input.workspace, input.workspaceIdentity);
      if (row.workspace == null && input.workspace) {
        await client.query(
          `UPDATE anicode_session_lifecycle SET workspace = $2, updated_at = now()
           WHERE session_id = $1`,
          [input.sessionId, input.workspace],
        );
      }
      if (row.workspace_device == null && row.workspace_inode == null && input.workspaceIdentity) {
        await client.query(
          `UPDATE anicode_session_lifecycle
           SET workspace_device = $2, workspace_inode = $3, updated_at = now()
           WHERE session_id = $1`,
          [input.sessionId, input.workspaceIdentity.device, input.workspaceIdentity.inode],
        );
      }
      const inserted = await client.query(
        `INSERT INTO anicode_session_operation_leases
         (lease_id, session_id, owner, epoch, expires_at)
         VALUES ($1, $2, $3, $4, clock_timestamp() + ($5 * interval '1 millisecond'))
         RETURNING expires_at`,
        [leaseId, input.sessionId, input.owner, Number(row.epoch), input.ttlMs],
      );
      return {
        sessionId: input.sessionId,
        leaseId,
        owner: input.owner,
        epoch: Number(row.epoch),
        expiresAt: new Date(String((inserted.rows[0] as Row).expires_at)).toISOString(),
      };
    });
  }

  renewOperation(lease: SessionOperationLease, ttlMs: number): Promise<boolean> {
    this.validateLease(lease);
    assertLifecycleTtl(ttlMs);
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE anicode_session_operation_leases
         SET expires_at = clock_timestamp() + ($5 * interval '1 millisecond')
         WHERE lease_id = $1 AND session_id = $2 AND owner = $3 AND epoch = $4
           AND expires_at > clock_timestamp()`,
        [lease.leaseId, lease.sessionId, lease.owner, lease.epoch, ttlMs],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  async releaseOperation(lease: SessionOperationLease): Promise<void> {
    this.validateLease(lease);
    await this.database.pool.query(
      `DELETE FROM anicode_session_operation_leases
       WHERE lease_id = $1 AND session_id = $2 AND owner = $3 AND epoch = $4`,
      [lease.leaseId, lease.sessionId, lease.owner, lease.epoch],
    );
  }

  claimDeletion(input: ClaimSessionDeletionInput): Promise<SessionDeletionClaim> {
    this.validateInput(input);
    const replacementToken = `sdel_${randomUUID()}`;
    return this.database.transaction(async (client) => {
      await this.deleteExpiredOperations(client, input.sessionId);
      await client.query(
        `INSERT INTO anicode_session_lifecycle
         (session_id, state, epoch, workspace, workspace_device, workspace_inode)
         VALUES ($1, 'active', 0, $2, $3, $4) ON CONFLICT(session_id) DO NOTHING`,
        [
          input.sessionId,
          input.workspace ?? null,
          input.workspaceIdentity?.device ?? null,
          input.workspaceIdentity?.inode ?? null,
        ],
      );
      let selected = await client.query(
        "SELECT * FROM anicode_session_lifecycle WHERE session_id = $1 FOR UPDATE",
        [input.sessionId],
      );
      let row = selected.rows[0] as Row;
      this.assertWorkspace(row, input.workspace, input.workspaceIdentity);
      if (row.workspace == null && input.workspace) {
        await client.query(
          "UPDATE anicode_session_lifecycle SET workspace = $2 WHERE session_id = $1",
          [input.sessionId, input.workspace],
        );
        row.workspace = input.workspace;
      }
      if (row.workspace_device == null && row.workspace_inode == null && input.workspaceIdentity) {
        await client.query(
          `UPDATE anicode_session_lifecycle
           SET workspace_device = $2, workspace_inode = $3 WHERE session_id = $1`,
          [input.sessionId, input.workspaceIdentity.device, input.workspaceIdentity.inode],
        );
        row.workspace_device = input.workspaceIdentity.device;
        row.workspace_inode = input.workspaceIdentity.inode;
      }
      if (row.state === "deleted") {
        return {
          ...postgresLifecycleRecord(row, await this.activeLeaseCount(client, input.sessionId)),
          claimed: false,
        };
      }
      if (row.state === "active") {
        await client.query(
          `UPDATE anicode_session_lifecycle SET state = 'deleting', epoch = epoch + 1,
           delete_owner = NULL, delete_token = NULL, delete_lease_expires_at = NULL,
           updated_at = now() WHERE session_id = $1`,
          [input.sessionId],
        );
      }
      const claimed = await client.query(
        `UPDATE anicode_session_lifecycle
         SET delete_owner = $2,
             delete_token = CASE
               WHEN delete_owner = $2 AND delete_lease_expires_at > clock_timestamp()
                 THEN delete_token ELSE $3 END,
             delete_lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'),
             updated_at = now()
         WHERE session_id = $1 AND state = 'deleting'
           AND (delete_lease_expires_at IS NULL OR delete_lease_expires_at <= clock_timestamp()
                OR delete_owner = $2)
         RETURNING *`,
        [input.sessionId, input.owner, replacementToken, input.ttlMs],
      );
      if (claimed.rows[0]) {
        row = claimed.rows[0] as Row;
        return {
          ...postgresLifecycleRecord(row, await this.activeLeaseCount(client, input.sessionId)),
          claimed: true,
        };
      }
      selected = await client.query(
        "SELECT * FROM anicode_session_lifecycle WHERE session_id = $1",
        [input.sessionId],
      );
      row = selected.rows[0] as Row;
      return {
        ...postgresLifecycleRecord(row, await this.activeLeaseCount(client, input.sessionId)),
        claimed: false,
      };
    });
  }

  renewDeletion(claim: SessionDeletionClaim, ttlMs: number): Promise<boolean> {
    this.validateClaim(claim);
    assertLifecycleTtl(ttlMs);
    return this.database.transaction(async (client) => {
      const result = await client.query(
        `UPDATE anicode_session_lifecycle
         SET delete_lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'),
             updated_at = now()
         WHERE session_id = $1 AND state = 'deleting' AND delete_owner = $2
           AND delete_token = $3 AND delete_lease_expires_at > clock_timestamp()`,
        [claim.sessionId, claim.deleteOwner!, claim.deleteToken!, ttlMs],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  completeDeletion(claim: SessionDeletionClaim): Promise<boolean> {
    this.validateClaim(claim);
    return this.database.transaction(async (client) => {
      await this.deleteExpiredOperations(client, claim.sessionId);
      // Lock the lifecycle row before counting leases so acquire and completion have one order.
      const selected = await client.query(
        "SELECT * FROM anicode_session_lifecycle WHERE session_id = $1 FOR UPDATE",
        [claim.sessionId],
      );
      const row = selected.rows[0] as Row | undefined;
      if (
        !row ||
        row.state !== "deleting" ||
        row.delete_owner !== claim.deleteOwner ||
        row.delete_token !== claim.deleteToken ||
        row.delete_lease_expires_at == null ||
        (await this.activeLeaseCount(client, claim.sessionId)) !== 0
      ) {
        return false;
      }
      const result = await client.query(
        `UPDATE anicode_session_lifecycle SET state = 'deleted',
         delete_owner = NULL, delete_token = NULL, delete_lease_expires_at = NULL,
         updated_at = now()
         WHERE session_id = $1 AND state = 'deleting' AND delete_owner = $2
           AND delete_token = $3 AND delete_lease_expires_at > clock_timestamp()`,
        [claim.sessionId, claim.deleteOwner, claim.deleteToken],
      );
      return (result.rowCount ?? 0) === 1;
    });
  }

  private async deleteExpiredOperations(client: PoolClient, sessionId: string): Promise<void> {
    await client.query(
      `DELETE FROM anicode_session_operation_leases
       WHERE session_id = $1 AND expires_at <= clock_timestamp()`,
      [sessionId],
    );
  }

  private async activeLeaseCount(client: PoolClient, sessionId: string): Promise<number> {
    const result = await client.query(
      `SELECT COUNT(*) AS count FROM anicode_session_operation_leases
       WHERE session_id = $1 AND expires_at > clock_timestamp()`,
      [sessionId],
    );
    return Number((result.rows[0] as Row).count);
  }

  private assertWorkspace(
    row: Row,
    workspace: string | undefined,
    identity: { device: string; inode: string } | undefined,
  ): void {
    if (row.workspace != null && String(row.workspace) !== workspace) {
      throw new Error(`Session ${String(row.session_id)} workspace lifecycle mismatch`);
    }
    if (
      row.workspace_device != null &&
      row.workspace_inode != null &&
      (!identity ||
        String(row.workspace_device) !== identity.device ||
        String(row.workspace_inode) !== identity.inode)
    ) {
      throw new Error(`Session ${String(row.session_id)} workspace identity lifecycle mismatch`);
    }
  }

  private validateInput(input: AcquireSessionOperationInput | ClaimSessionDeletionInput): void {
    assertIdentifier(input.sessionId, "session lifecycle id");
    assertLifecycleId(input.owner, "session lifecycle owner");
    assertLifecycleTtl(input.ttlMs);
    if (input.workspace !== undefined && input.workspace.length === 0) {
      throw new Error("Session lifecycle workspace must not be empty");
    }
    if (
      input.workspaceIdentity &&
      (!input.workspaceIdentity.device || !input.workspaceIdentity.inode)
    ) {
      throw new Error("Session lifecycle workspace identity must include device and inode");
    }
  }

  private validateListInput(input: {
    limit: number;
    afterSessionId?: string;
    workspace?: string;
  }): void {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
      throw new Error("Session lifecycle list limit must be an integer from 1 to 1000");
    }
    if (input.afterSessionId !== undefined) {
      assertIdentifier(input.afterSessionId, "session lifecycle cursor");
    }
    if (input.workspace !== undefined && input.workspace.length === 0) {
      throw new Error("Session lifecycle workspace must not be empty");
    }
  }

  private validateLease(lease: SessionOperationLease): void {
    assertIdentifier(lease.sessionId, "session lifecycle id");
    assertLifecycleId(lease.leaseId, "session operation lease id");
    assertLifecycleId(lease.owner, "session lifecycle owner");
  }

  private validateClaim(claim: SessionDeletionClaim): void {
    assertIdentifier(claim.sessionId, "session lifecycle id");
    if (!claim.deleteOwner || !claim.deleteToken) {
      throw new Error("Session deletion claim is missing its owner or token");
    }
    assertLifecycleId(claim.deleteOwner, "session lifecycle owner");
    assertLifecycleId(claim.deleteToken, "session deletion token");
  }
}

export class PostgresRuntimeEventStore implements RuntimeEventStore {
  readonly lifecycle: SessionLifecycleStore;

  constructor(readonly database: PostgresRuntimeDatabase) {
    this.lifecycle = new PostgresSessionLifecycleStore(database);
  }

  append<T>(input: AppendRuntimeEvent<T>): Promise<RuntimeEvent<T>> {
    assertIdentifier(input.streamId, "runtime stream id");
    return this.database.transaction(async (client) => {
      if (input.idempotencyKey) {
        const duplicate = await client.query(
          `SELECT * FROM anicode_runtime_events
           WHERE stream_id = $1 AND idempotency_key = $2`,
          [input.streamId, input.idempotencyKey],
        );
        if (duplicate.rows[0]) return eventFromRow<T>(duplicate.rows[0] as Row);
      }
      // 锁定稳定 advisory key，即使 stream 尚无行也能串行化首条 append。
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.streamId]);
      const last = await client.query(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM anicode_runtime_events WHERE stream_id = $1",
        [input.streamId],
      );
      const current = Number((last.rows[0] as Row).sequence);
      if (input.expectedSequence !== undefined && input.expectedSequence !== current) {
        throw new Error(
          `Runtime stream ${input.streamId} version conflict: expected ${input.expectedSequence}, actual ${current}`,
        );
      }
      const event: RuntimeEvent<T> = {
        id: `rte_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        version: 2,
        streamId: input.streamId,
        sequence: current + 1,
        timestamp: new Date().toISOString(),
        type: input.type,
        data: input.data,
        ...(input.correlationId ? { correlationId: input.correlationId } : {}),
        ...(input.causationId ? { causationId: input.causationId } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.spanId ? { spanId: input.spanId } : {}),
      };
      await client.query(
        `INSERT INTO anicode_runtime_events
         (stream_id, sequence, id, timestamp, type, data, correlation_id, causation_id,
          idempotency_key, trace_id, span_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)`,
        [
          event.streamId,
          event.sequence,
          event.id,
          event.timestamp,
          event.type,
          JSON.stringify(event.data),
          event.correlationId ?? null,
          event.causationId ?? null,
          event.idempotencyKey ?? null,
          event.traceId ?? null,
          event.spanId ?? null,
        ],
      );
      return event;
    });
  }

  async read(streamId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    assertIdentifier(streamId, "runtime stream id");
    const result = await this.database.pool.query(
      `SELECT * FROM anicode_runtime_events
       WHERE stream_id = $1 AND sequence > $2 ORDER BY sequence`,
      [streamId, afterSequence],
    );
    return result.rows.map((row) => eventFromRow(row as Row));
  }

  async listStreams(): Promise<string[]> {
    const result = await this.database.pool.query(
      "SELECT DISTINCT stream_id FROM anicode_runtime_events ORDER BY stream_id",
    );
    return result.rows.map((row) => String((row as Row).stream_id));
  }

  async delete(streamId: string): Promise<void> {
    assertIdentifier(streamId, "runtime stream id");
    await this.database.pool.query("DELETE FROM anicode_runtime_events WHERE stream_id = $1", [
      streamId,
    ]);
  }
}

export class PostgresRuntimeSnapshotStore implements RuntimeSnapshotStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}
  async get(streamId: string): Promise<RuntimeSnapshot | undefined> {
    const result = await this.database.pool.query(
      "SELECT data FROM anicode_runtime_snapshots WHERE stream_id = $1",
      [streamId],
    );
    return result.rows[0] ? clone((result.rows[0] as Row).data as RuntimeSnapshot) : undefined;
  }
  async put(snapshot: RuntimeSnapshot): Promise<void> {
    await this.database.pool.query(
      `INSERT INTO anicode_runtime_snapshots(stream_id, sequence, data)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT(stream_id) DO UPDATE SET
         sequence = excluded.sequence, data = excluded.data, updated_at = now()`,
      [snapshot.streamId, snapshot.sequence, JSON.stringify(snapshot)],
    );
  }
  async delete(streamId: string): Promise<void> {
    await this.database.pool.query("DELETE FROM anicode_runtime_snapshots WHERE stream_id = $1", [
      streamId,
    ]);
  }
}

function sessionMetaFromRow(row: Row): SessionMeta {
  return {
    id: String(row.id),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    cwd: String(row.cwd),
    ...(row.workspace_device != null && row.workspace_inode != null
      ? {
          workspaceIdentity: {
            device: String(row.workspace_device),
            inode: String(row.workspace_inode),
          },
        }
      : {}),
    model: String(row.model),
    ...(row.title != null ? { title: String(row.title) } : {}),
  };
}

/** 共享控制面的会话存储；所有复合写入均为 SERIALIZABLE，并锁定 session row。 */
export class PostgresSessionStore implements ISessionStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}

  create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    assertIdentifier(meta.id, "session id");
    return this.database.transaction(async (client) => {
      const now = new Date().toISOString();
      const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
      await client.query(
        `INSERT INTO anicode_sessions
         (id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          full.id,
          full.createdAt,
          full.updatedAt,
          full.cwd,
          full.workspaceIdentity?.device ?? null,
          full.workspaceIdentity?.inode ?? null,
          full.model,
          full.title ?? null,
        ],
      );
      return full;
    });
  }

  append(id: string, message: ChatMessage): Promise<void> {
    assertIdentifier(id, "session id");
    return this.database.transaction(async (client) => {
      const session = await client.query(
        "SELECT id FROM anicode_sessions WHERE id = $1 FOR UPDATE",
        [id],
      );
      if (!session.rows[0]) throw new Error(`Session ${id} not found`);
      const next = await client.query(
        `SELECT COALESCE(MAX(idx), -1) + 1 AS next_idx
         FROM anicode_session_messages WHERE session_id = $1`,
        [id],
      );
      await client.query(
        `INSERT INTO anicode_session_messages(session_id, idx, data)
         VALUES ($1, $2, $3::jsonb)`,
        [id, Number((next.rows[0] as Row).next_idx), JSON.stringify(message)],
      );
      await client.query("UPDATE anicode_sessions SET updated_at = now() WHERE id = $1", [id]);
    });
  }

  async rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    assertIdentifier(meta.id, "session id");
    const updatedAt = await this.database.transaction(async (client) => {
      const timestamp = new Date().toISOString();
      await client.query(
        `INSERT INTO anicode_sessions
         (id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           cwd = excluded.cwd,
           workspace_device = excluded.workspace_device,
           workspace_inode = excluded.workspace_inode,
           model = excluded.model,
           title = excluded.title`,
        [
          meta.id,
          meta.createdAt,
          timestamp,
          meta.cwd,
          meta.workspaceIdentity?.device ?? null,
          meta.workspaceIdentity?.inode ?? null,
          meta.model,
          meta.title ?? null,
        ],
      );
      await client.query("DELETE FROM anicode_session_messages WHERE session_id = $1", [meta.id]);
      for (let index = 0; index < messages.length; index++) {
        await client.query(
          `INSERT INTO anicode_session_messages(session_id, idx, data)
           VALUES ($1, $2, $3::jsonb)`,
          [meta.id, index, JSON.stringify(messages[index])],
        );
      }
      return timestamp;
    });
    meta.updatedAt = updatedAt;
  }

  async load(id: string): Promise<SessionData> {
    assertIdentifier(id, "session id");
    const [session, messages] = await Promise.all([
      this.database.pool.query("SELECT * FROM anicode_sessions WHERE id = $1", [id]),
      this.database.pool.query(
        "SELECT data FROM anicode_session_messages WHERE session_id = $1 ORDER BY idx",
        [id],
      ),
    ]);
    if (!session.rows[0]) throw new Error(`Session ${id} not found`);
    return {
      ...sessionMetaFromRow(session.rows[0] as Row),
      messages: messages.rows.map((row) => clone((row as Row).data as ChatMessage)),
    };
  }

  async list(): Promise<SessionMeta[]> {
    const result = await this.database.pool.query(
      "SELECT * FROM anicode_sessions ORDER BY updated_at DESC, id",
    );
    return result.rows.map((row) => sessionMetaFromRow(row as Row));
  }

  async delete(id: string): Promise<void> {
    assertIdentifier(id, "session id");
    await this.database.transaction(async (client) => {
      await client.query("DELETE FROM anicode_sessions WHERE id = $1", [id]);
    });
  }
}

function commandFromRow(row: Row): DurableCommand {
  const command = clone(row.data as DurableCommand);
  command.status = String(row.status) as DurableCommand["status"];
  command.updatedAt = new Date(String(row.updated_at)).toISOString();
  command.fencingToken = Number(row.fencing_token ?? 0);
  if (row.lease_owner != null) command.leaseOwner = String(row.lease_owner);
  else delete command.leaseOwner;
  if (row.lease_expires_at != null) {
    command.leaseExpiresAt = new Date(String(row.lease_expires_at)).toISOString();
  } else delete command.leaseExpiresAt;
  return command;
}

function commandParams(command: DurableCommand): unknown[] {
  return [
    command.sessionId,
    command.id,
    command.idempotencyKey,
    command.status,
    command.leaseOwner ?? null,
    command.leaseExpiresAt ?? null,
    command.fencingToken ?? 0,
    JSON.stringify(command),
    command.createdAt,
    command.updatedAt,
  ];
}

async function insertCommandRow(client: PoolClient, command: DurableCommand): Promise<void> {
  await client.query(
    `INSERT INTO anicode_commands
     (session_id, id, idempotency_key, status, lease_owner, lease_expires_at,
      fencing_token, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
    commandParams(command),
  );
}

async function updateCommandRow(client: PoolClient, command: DurableCommand): Promise<void> {
  await client.query(
    `UPDATE anicode_commands
     SET status = $3, lease_owner = $4, lease_expires_at = $5,
         fencing_token = $6, data = $7::jsonb, updated_at = $8
     WHERE session_id = $1 AND id = $2`,
    [
      command.sessionId,
      command.id,
      command.status,
      command.leaseOwner ?? null,
      command.leaseExpiresAt ?? null,
      command.fencingToken ?? 0,
      JSON.stringify(command),
      command.updatedAt,
    ],
  );
}

async function lockedCommand(
  client: PoolClient,
  sessionId: string,
  commandId: string,
): Promise<DurableCommand> {
  const selected = await client.query(
    "SELECT * FROM anicode_commands WHERE session_id = $1 AND id = $2 FOR UPDATE",
    [sessionId, commandId],
  );
  if (!selected.rows[0]) throw new Error(`Unknown durable command: ${commandId}`);
  return commandFromRow(selected.rows[0] as Row);
}

function outboxFromRow(row: Row): OutboxMessage {
  const message = clone(row.data as OutboxMessage);
  message.status = String(row.status) as OutboxMessage["status"];
  message.updatedAt = new Date(String(row.updated_at)).toISOString();
  message.fencingToken = Number(row.fencing_token ?? 0);
  if (row.lease_owner != null) message.leaseOwner = String(row.lease_owner);
  else delete message.leaseOwner;
  if (row.lease_expires_at != null) {
    message.leaseExpiresAt = new Date(String(row.lease_expires_at)).toISOString();
  } else delete message.leaseExpiresAt;
  return message;
}

function outboxParams(message: OutboxMessage): unknown[] {
  return [
    message.id,
    message.event.idempotencyKey ?? message.id,
    message.status,
    message.leaseOwner ?? null,
    message.leaseExpiresAt ?? null,
    message.fencingToken ?? 0,
    JSON.stringify(message),
    message.createdAt,
    message.updatedAt,
  ];
}

async function insertOutboxRow(client: PoolClient, message: OutboxMessage): Promise<void> {
  await client.query(
    `INSERT INTO anicode_outbox
     (id, idempotency_key, status, lease_owner, lease_expires_at,
      fencing_token, data, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    outboxParams(message),
  );
}

async function updateOutboxRow(client: PoolClient, message: OutboxMessage): Promise<void> {
  await client.query(
    `UPDATE anicode_outbox
     SET status = $2, lease_owner = $3, lease_expires_at = $4,
         fencing_token = $5, data = $6::jsonb, updated_at = $7
     WHERE id = $1`,
    [
      message.id,
      message.status,
      message.leaseOwner ?? null,
      message.leaseExpiresAt ?? null,
      message.fencingToken ?? 0,
      JSON.stringify(message),
      message.updatedAt,
    ],
  );
}

async function lockedOutbox(client: PoolClient, id: string): Promise<OutboxMessage> {
  const selected = await client.query("SELECT * FROM anicode_outbox WHERE id = $1 FOR UPDATE", [
    id,
  ]);
  if (!selected.rows[0]) throw new Error(`Unknown outbox message: ${id}`);
  return outboxFromRow(selected.rows[0] as Row);
}

function assertOutboxLease(
  message: OutboxMessage,
  owner: string,
  fencingToken: number | undefined,
): void {
  if (
    message.leaseOwner !== owner ||
    fencingToken === undefined ||
    message.fencingToken !== fencingToken
  ) {
    throw new Error(`Stale fencing token for outbox message ${message.id}`);
  }
}

export class PostgresCommandInboxStore implements CommandInboxStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}

  async read(sessionId: string): Promise<DurableCommand[]> {
    assertIdentifier(sessionId, "command session id");
    const result = await this.database.pool.query(
      "SELECT * FROM anicode_commands WHERE session_id = $1 ORDER BY created_at, id",
      [sessionId],
    );
    return result.rows.map((row) => commandFromRow(row as Row));
  }

  async write(sessionId: string, commands: DurableCommand[]): Promise<void> {
    assertIdentifier(sessionId, "command session id");
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `commands:${sessionId}`,
      ]);
      await client.query("DELETE FROM anicode_commands WHERE session_id = $1", [sessionId]);
      for (const command of commands) await insertCommandRow(client, command);
    });
  }

  transact<T>(sessionId: string, fn: (commands: DurableCommand[]) => T | Promise<T>): Promise<T> {
    assertIdentifier(sessionId, "command session id");
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `commands:${sessionId}`,
      ]);
      const selected = await client.query(
        "SELECT * FROM anicode_commands WHERE session_id = $1 ORDER BY created_at, id FOR UPDATE",
        [sessionId],
      );
      const commands = selected.rows.map((row) => commandFromRow(row as Row));
      const result = await fn(commands);
      await client.query("DELETE FROM anicode_commands WHERE session_id = $1", [sessionId]);
      for (const command of commands) await insertCommandRow(client, command);
      return result;
    });
  }

  async listSessions(): Promise<string[]> {
    const result = await this.database.pool.query(
      "SELECT DISTINCT session_id FROM anicode_commands ORDER BY session_id",
    );
    return result.rows.map((row) => String((row as Row).session_id));
  }

  async insertCommand(command: DurableCommand): Promise<DurableCommand> {
    const inserted = await this.database.pool.query(
      `INSERT INTO anicode_commands
       (session_id, id, idempotency_key, status, lease_owner, lease_expires_at,
        fencing_token, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
       ON CONFLICT(session_id, idempotency_key) DO NOTHING
       RETURNING *`,
      commandParams(command),
    );
    if (inserted.rows[0]) return commandFromRow(inserted.rows[0] as Row);
    const duplicate = await this.database.pool.query(
      `SELECT * FROM anicode_commands
       WHERE session_id = $1 AND idempotency_key = $2`,
      [command.sessionId, command.idempotencyKey],
    );
    if (!duplicate.rows[0]) throw new Error("Command idempotency conflict disappeared");
    return commandFromRow(duplicate.rows[0] as Row);
  }

  claimCommand(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs: number,
    now: number,
  ): Promise<DurableCommand> {
    return this.database.transaction(async (client) => {
      const selected = await client.query(
        "SELECT * FROM anicode_commands WHERE session_id = $1 AND id = $2 FOR UPDATE",
        [sessionId, commandId],
      );
      if (!selected.rows[0]) throw new Error(`Unknown durable command: ${commandId}`);
      const command = commandFromRow(selected.rows[0] as Row);
      const leaseActive =
        command.leaseExpiresAt !== undefined && Date.parse(command.leaseExpiresAt) > now;
      if (command.status === "running" && leaseActive && command.leaseOwner !== owner) {
        throw new Error(`Durable command ${commandId} is leased by ${command.leaseOwner}`);
      }
      if (!(["accepted", "running"] as string[]).includes(command.status)) {
        throw new Error(`Durable command ${commandId} is already ${command.status}`);
      }
      command.status = "running";
      command.attempts++;
      command.fencingToken = (command.fencingToken ?? 0) + 1;
      command.leaseOwner = owner;
      command.leaseExpiresAt = new Date(now + Math.max(1_000, leaseMs)).toISOString();
      command.updatedAt = new Date(now).toISOString();
      await updateCommandRow(client, command);
      return command;
    });
  }

  heartbeatCommand(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void> {
    return this.database.transaction(async (client) => {
      const command = await lockedCommand(client, sessionId, commandId);
      if (command.status !== "running" || command.leaseOwner !== owner) {
        throw new Error(`Cannot heartbeat unowned command ${commandId}`);
      }
      if (fencingToken !== undefined && command.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for command ${commandId}`);
      }
      command.leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
      command.updatedAt = new Date().toISOString();
      await updateCommandRow(client, command);
    });
  }

  finishCommand(
    sessionId: string,
    commandId: string,
    status: "completed" | "failed" | "cancelled",
    error?: string,
    lease?: { owner: string; fencingToken: number },
  ): Promise<void> {
    return this.database.transaction(async (client) => {
      const command = await lockedCommand(client, sessionId, commandId);
      if (
        lease &&
        (command.leaseOwner !== lease.owner || command.fencingToken !== lease.fencingToken)
      ) {
        throw new Error(`Stale fencing token for command ${commandId}`);
      }
      command.status = status;
      command.updatedAt = new Date().toISOString();
      delete command.leaseOwner;
      delete command.leaseExpiresAt;
      if (error) command.error = error;
      else delete command.error;
      await updateCommandRow(client, command);
    });
  }

  async getCommand(sessionId: string, commandId: string): Promise<DurableCommand | undefined> {
    const result = await this.database.pool.query(
      "SELECT * FROM anicode_commands WHERE session_id = $1 AND id = $2",
      [sessionId, commandId],
    );
    return result.rows[0] ? commandFromRow(result.rows[0] as Row) : undefined;
  }

  async recoverableCommands(sessionId: string, now: number): Promise<DurableCommand[]> {
    const result = await this.database.pool.query(
      `SELECT * FROM anicode_commands
       WHERE session_id = $1
         AND (status = 'accepted' OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= $2)))
       ORDER BY created_at, id`,
      [sessionId, new Date(now).toISOString()],
    );
    return result.rows.map((row) => commandFromRow(row as Row));
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertIdentifier(sessionId, "command session id");
    await this.database.pool.query("DELETE FROM anicode_commands WHERE session_id = $1", [
      sessionId,
    ]);
  }
}

export class PostgresOutboxStore implements OutboxStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}

  async read(): Promise<OutboxMessage[]> {
    const result = await this.database.pool.query(
      "SELECT * FROM anicode_outbox ORDER BY created_at, id",
    );
    return result.rows.map((row) => outboxFromRow(row as Row));
  }

  async write(messages: OutboxMessage[]): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('outbox', 0))");
      await client.query("DELETE FROM anicode_outbox");
      for (const message of messages) await insertOutboxRow(client, message);
    });
  }

  transact<T>(fn: (messages: OutboxMessage[]) => T | Promise<T>): Promise<T> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('outbox', 0))");
      const selected = await client.query(
        "SELECT * FROM anicode_outbox ORDER BY created_at, id FOR UPDATE",
      );
      const messages = selected.rows.map((row) => outboxFromRow(row as Row));
      const result = await fn(messages);
      await client.query("DELETE FROM anicode_outbox");
      for (const message of messages) await insertOutboxRow(client, message);
      return result;
    });
  }

  async insertMessage(message: OutboxMessage): Promise<OutboxMessage> {
    const inserted = await this.database.pool.query(
      `INSERT INTO anicode_outbox
       (id, idempotency_key, status, lease_owner, lease_expires_at,
        fencing_token, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING *`,
      outboxParams(message),
    );
    if (inserted.rows[0]) return outboxFromRow(inserted.rows[0] as Row);
    const duplicate = await this.database.pool.query(
      "SELECT * FROM anicode_outbox WHERE idempotency_key = $1",
      [message.event.idempotencyKey ?? message.id],
    );
    if (!duplicate.rows[0]) throw new Error("Outbox idempotency conflict disappeared");
    return outboxFromRow(duplicate.rows[0] as Row);
  }

  claimMessage(owner: string, leaseMs: number): Promise<OutboxMessage | undefined> {
    return this.database.transaction(async (client) => {
      const selected = await client.query(
        `SELECT * FROM anicode_outbox
         WHERE status = 'pending' AND (lease_expires_at IS NULL OR lease_expires_at <= now())
         ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      if (!selected.rows[0]) return undefined;
      const message = outboxFromRow(selected.rows[0] as Row);
      message.leaseOwner = owner;
      message.leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
      message.fencingToken = (message.fencingToken ?? 0) + 1;
      message.updatedAt = new Date().toISOString();
      await updateOutboxRow(client, message);
      return message;
    });
  }

  markSent(message: OutboxMessage, owner: string, sentEventId: string): Promise<void> {
    return this.database.transaction(async (client) => {
      const current = await lockedOutbox(client, message.id);
      assertOutboxLease(current, owner, message.fencingToken);
      current.status = "sent";
      current.sentEventId = sentEventId;
      current.attempts++;
      current.updatedAt = new Date().toISOString();
      delete current.error;
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      await updateOutboxRow(client, current);
    });
  }

  markFailed(message: OutboxMessage, owner: string, error: string): Promise<void> {
    return this.database.transaction(async (client) => {
      const current = await lockedOutbox(client, message.id);
      assertOutboxLease(current, owner, message.fencingToken);
      current.attempts++;
      current.error = error;
      current.updatedAt = new Date().toISOString();
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      await updateOutboxRow(client, current);
    });
  }

  async getMessage(id: string): Promise<OutboxMessage | undefined> {
    const result = await this.database.pool.query("SELECT * FROM anicode_outbox WHERE id = $1", [
      id,
    ]);
    return result.rows[0] ? outboxFromRow(result.rows[0] as Row) : undefined;
  }

  async pendingMessages(): Promise<OutboxMessage[]> {
    const result = await this.database.pool.query(
      "SELECT * FROM anicode_outbox WHERE status = 'pending' ORDER BY created_at, id",
    );
    return result.rows.map((row) => outboxFromRow(row as Row));
  }
}

function workerFromRow(row: Row): WorkerJob {
  return {
    id: String(row.id),
    type: String(row.type),
    payload: clone(row.payload),
    status: String(row.status) as WorkerJob["status"],
    idempotencyKey: String(row.idempotency_key),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
    ...(row.lease_owner != null ? { leaseOwner: String(row.lease_owner) } : {}),
    ...(row.lease_expires_at != null
      ? { leaseExpiresAt: new Date(String(row.lease_expires_at)).toISOString() }
      : {}),
    ...(row.fencing_token != null ? { fencingToken: Number(row.fencing_token) } : {}),
    ...(row.result != null ? { result: clone(row.result) } : {}),
    ...(row.error != null ? { error: String(row.error) } : {}),
  };
}

export class PostgresWorkerQueueStore implements WorkerQueueStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}
  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T> {
    return this.database.documentTransaction("worker", "global", [], (document) =>
      fn(document as WorkerJob[]),
    );
  }

  async enqueueJob(job: WorkerJob): Promise<WorkerJob> {
    const inserted = await this.database.pool.query(
      `INSERT INTO anicode_worker_jobs
       (id, type, idempotency_key, payload, status, attempts, max_attempts,
        lease_owner, lease_expires_at, fencing_token, result, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
       ON CONFLICT(idempotency_key) DO NOTHING
       RETURNING *`,
      [
        job.id,
        job.type,
        job.idempotencyKey,
        JSON.stringify(job.payload),
        job.status,
        job.attempts,
        job.maxAttempts,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.fencingToken ?? 0,
        job.result === undefined ? null : JSON.stringify(job.result),
        job.error ?? null,
        job.createdAt,
        job.updatedAt,
      ],
    );
    if (inserted.rows[0]) return workerFromRow(inserted.rows[0] as Row);
    const duplicate = await this.database.pool.query(
      "SELECT * FROM anicode_worker_jobs WHERE idempotency_key = $1",
      [job.idempotencyKey],
    );
    if (!duplicate.rows[0]) throw new Error("Worker job idempotency conflict disappeared");
    return workerFromRow(duplicate.rows[0] as Row);
  }

  enqueueJobWithQuota(job: WorkerJob, quota: WorkerEnqueueQuota): Promise<WorkerJob> {
    return this.database.transaction(async (client) => {
      const existing = await client.query(
        "SELECT * FROM anicode_worker_jobs WHERE idempotency_key = $1",
        [job.idempotencyKey],
      );
      if (existing.rows[0]) return workerFromRow(existing.rows[0] as Row);

      const outstanding = await client.query(
        `SELECT COUNT(*)::bigint AS count
         FROM anicode_worker_jobs
         WHERE status IN ('queued', 'leased', 'cancellation_requested')
           AND payload->>'tenantId' = $1`,
        [quota.tenantId],
      );
      if (Number((outstanding.rows[0] as Row).count) >= quota.maxOutstandingPerTenant) {
        throw new WorkerQueueQuotaError("tenant_quota_exceeded", "Tenant execution quota exceeded");
      }

      const actorQueued = await client.query(
        `SELECT COUNT(*)::bigint AS count
         FROM anicode_worker_jobs
         WHERE status = 'queued'
           AND payload->>'tenantId' = $1
           AND payload->>'actor' = $2`,
        [quota.tenantId, quota.actor],
      );
      if (Number((actorQueued.rows[0] as Row).count) >= quota.maxQueuedPerActor) {
        throw new WorkerQueueQuotaError("actor_queue_full", "Actor execution queue is full");
      }

      const inserted = await client.query(
        `INSERT INTO anicode_worker_jobs
         (id, type, idempotency_key, payload, status, attempts, max_attempts,
          lease_owner, lease_expires_at, fencing_token, result, error, created_at, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13, $14)
         ON CONFLICT(idempotency_key) DO NOTHING
         RETURNING *`,
        [
          job.id,
          job.type,
          job.idempotencyKey,
          JSON.stringify(job.payload),
          job.status,
          job.attempts,
          job.maxAttempts,
          job.leaseOwner ?? null,
          job.leaseExpiresAt ?? null,
          job.fencingToken ?? 0,
          job.result === undefined ? null : JSON.stringify(job.result),
          job.error ?? null,
          job.createdAt,
          job.updatedAt,
        ],
      );
      if (inserted.rows[0]) return workerFromRow(inserted.rows[0] as Row);

      // A concurrent idempotent insert may be invisible to this SERIALIZABLE snapshot.
      // Force the transaction helper to retry with a fresh snapshot instead of reporting
      // a spurious conflict or inserting a second job.
      const retry = new Error("Concurrent worker idempotency conflict") as Error & {
        code: string;
      };
      retry.code = "40001";
      throw retry;
    });
  }

  claimJob(
    owner: string,
    types: string[] | undefined,
    leaseMs: number,
  ): Promise<WorkerJob | undefined> {
    return this.database.transaction(async (client) => {
      await client.query(
        `UPDATE anicode_worker_jobs
         SET status = 'failed', error = 'lease expired after maximum attempts', updated_at = now(),
             lease_owner = NULL, lease_expires_at = NULL
         WHERE status = 'leased' AND lease_expires_at <= now() AND attempts >= max_attempts`,
      );
      await client.query(
        `UPDATE anicode_worker_jobs
         SET status = 'failed',
             error = 'cancellation acknowledgement lease expired; execution outcome indeterminate',
             updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
         WHERE status = 'cancellation_requested'
           AND (lease_expires_at IS NULL OR lease_expires_at <= now())`,
      );
      const selected = await client.query(
        `SELECT id FROM anicode_worker_jobs
         WHERE ($1::text[] IS NULL OR type = ANY($1::text[]))
           AND attempts < max_attempts
           AND (status = 'queued' OR (status = 'leased' AND lease_expires_at <= now()))
         ORDER BY created_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1`,
        [types?.length ? types : null],
      );
      const id = (selected.rows[0] as Row | undefined)?.id;
      if (!id) return undefined;
      const updated = await client.query(
        `UPDATE anicode_worker_jobs
         SET status = 'leased', attempts = attempts + 1, fencing_token = fencing_token + 1,
             lease_owner = $2, lease_expires_at = now() + ($3::bigint * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [id, owner, Math.max(1_000, leaseMs)],
      );
      return workerFromRow(updated.rows[0] as Row);
    });
  }

  async heartbeatJob(
    jobId: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void> {
    const result = await this.database.pool.query(
      `UPDATE anicode_worker_jobs
       SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
       WHERE id = $1 AND status = 'leased' AND lease_owner = $2
         AND ($4::bigint IS NULL OR fencing_token = $4)`,
      [jobId, owner, Math.max(1_000, leaseMs), fencingToken ?? null],
    );
    if ((result.rowCount ?? 0) !== 1)
      throw new Error(`Cannot heartbeat unowned worker job ${jobId}`);
  }

  async finishJob(
    jobId: string,
    owner: string,
    resultValue: unknown,
    fencingToken?: number,
  ): Promise<void> {
    const result = await this.database.pool.query(
      `UPDATE anicode_worker_jobs
       SET status = 'succeeded', result = $3::jsonb, error = NULL, updated_at = now(),
           lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'leased' AND lease_owner = $2
         AND ($4::bigint IS NULL OR fencing_token = $4)`,
      [jobId, owner, JSON.stringify(resultValue ?? null), fencingToken ?? null],
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error(`Cannot settle unowned worker job ${jobId}`);
  }

  async failJob(
    jobId: string,
    owner: string,
    error: string,
    retry: boolean,
    fencingToken?: number,
  ): Promise<void> {
    const result = await this.database.pool.query(
      `UPDATE anicode_worker_jobs
       SET status = CASE WHEN $4::boolean AND attempts < max_attempts THEN 'queued' ELSE 'failed' END,
           error = $3, updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'leased' AND lease_owner = $2
         AND ($5::bigint IS NULL OR fencing_token = $5)`,
      [jobId, owner, error, retry, fencingToken ?? null],
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error(`Cannot fail unowned worker job ${jobId}`);
  }

  async requestCancellationJob(jobId: string): Promise<WorkerCancellationResult> {
    const result = await this.database.pool.query(
      `UPDATE anicode_worker_jobs
       SET status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE 'cancellation_requested' END,
           updated_at = now(),
           lease_owner = CASE WHEN status = 'queued' THEN NULL ELSE lease_owner END,
           lease_expires_at = CASE WHEN status = 'queued' THEN NULL ELSE lease_expires_at END
       WHERE id = $1 AND status IN ('queued', 'leased', 'cancellation_requested')
       RETURNING status`,
      [jobId],
    );
    const status = (result.rows[0] as Row | undefined)?.status;
    if (status === "cancelled" || status === "cancellation_requested") return status;
    const existing = await this.database.pool.query(
      "SELECT status FROM anicode_worker_jobs WHERE id = $1",
      [jobId],
    );
    return (existing.rows[0] as Row | undefined)?.status === "cancelled"
      ? "cancelled"
      : "not_cancellable";
  }

  async acknowledgeCancellationJob(
    jobId: string,
    owner: string,
    fencingToken?: number,
  ): Promise<void> {
    const result = await this.database.pool.query(
      `UPDATE anicode_worker_jobs
       SET status = 'cancelled', updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
       WHERE id = $1 AND status = 'cancellation_requested' AND lease_owner = $2
         AND ($3::bigint IS NULL OR fencing_token = $3)`,
      [jobId, owner, fencingToken ?? null],
    );
    if ((result.rowCount ?? 0) !== 1) {
      throw new Error(`Cannot acknowledge unowned worker job cancellation ${jobId}`);
    }
  }

  async listJobs(): Promise<WorkerJob[]> {
    const result = await this.database.pool.query(
      "SELECT * FROM anicode_worker_jobs ORDER BY created_at, id",
    );
    return result.rows.map((row) => workerFromRow(row as Row));
  }

  async get(jobId: string): Promise<WorkerJob | undefined> {
    const result = await this.database.pool.query(
      "SELECT * FROM anicode_worker_jobs WHERE id = $1",
      [jobId],
    );
    return result.rows[0] ? workerFromRow(result.rows[0] as Row) : undefined;
  }

  acquireWorktree(worktree: string, owner: string, leaseMs: number) {
    return this.database.transaction(async (client) => {
      const selected = await client.query(
        "SELECT * FROM anicode_worktree_leases WHERE worktree = $1 FOR UPDATE",
        [worktree],
      );
      const current = selected.rows[0] as Row | undefined;
      if (
        current?.owner &&
        String(current.owner) !== owner &&
        current.lease_expires_at &&
        new Date(String(current.lease_expires_at)).getTime() > Date.now()
      ) {
        throw new Error(`Worktree is owned by ${String(current.owner)}: ${worktree}`);
      }
      const result = await client.query(
        `INSERT INTO anicode_worktree_leases
         (worktree, owner, lease_expires_at, fencing_token, updated_at)
         VALUES ($1, $2, now() + ($3::bigint * interval '1 millisecond'), 1, now())
         ON CONFLICT(worktree) DO UPDATE SET
           owner = excluded.owner, lease_expires_at = excluded.lease_expires_at,
           fencing_token = anicode_worktree_leases.fencing_token + 1, updated_at = now()
         RETURNING lease_expires_at, fencing_token`,
        [worktree, owner, Math.max(1_000, leaseMs)],
      );
      const row = result.rows[0] as Row;
      return {
        worktree,
        owner,
        expiresAt: new Date(String(row.lease_expires_at)).toISOString(),
        fencingToken: Number(row.fencing_token),
      };
    });
  }

  async heartbeatWorktree(worktree: string, owner: string, leaseMs: number): Promise<void> {
    const result = await this.database.pool.query(
      `UPDATE anicode_worktree_leases
       SET lease_expires_at = now() + ($3::bigint * interval '1 millisecond'), updated_at = now()
       WHERE worktree = $1 AND owner = $2 AND lease_expires_at > now()`,
      [worktree, owner, Math.max(1_000, leaseMs)],
    );
    if ((result.rowCount ?? 0) !== 1)
      throw new Error(`Cannot heartbeat unowned worktree: ${worktree}`);
  }

  async releaseWorktree(worktree: string, owner: string, fencingToken?: number): Promise<void> {
    const result = await this.database.pool.query(
      `UPDATE anicode_worktree_leases
       SET owner = NULL, lease_expires_at = NULL, updated_at = now()
       WHERE worktree = $1 AND owner = $2
         AND ($3::bigint IS NULL OR fencing_token = $3)`,
      [worktree, owner, fencingToken ?? null],
    );
    if ((result.rowCount ?? 0) !== 1)
      throw new Error(`Cannot release unowned worktree: ${worktree}`);
  }
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function makeArtifact(input: ArtifactInput, data: Uint8Array): Artifact {
  assertIdentifier(input.sessionId, "session id");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const id = `art_${sha256.slice(0, 24)}`;
  return {
    id,
    sessionId: input.sessionId,
    kind: input.kind,
    name: input.name.trim() || id,
    mediaType: input.mediaType ?? "application/octet-stream",
    sizeBytes: data.byteLength,
    sha256,
    createdAt: new Date().toISOString(),
    uri: `anicode://sessions/${encodeURIComponent(input.sessionId)}/artifacts/${id}`,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export class PostgresArtifactStore implements ArtifactStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}
  async put(input: ArtifactInput): Promise<Artifact> {
    const data = bytes(input.data);
    const artifact = makeArtifact(input, data);
    const result = await this.database.pool.query(
      `INSERT INTO anicode_artifacts(session_id, id, sha256, metadata, data, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT(session_id, id) DO UPDATE SET id = excluded.id
       RETURNING metadata`,
      [
        artifact.sessionId,
        artifact.id,
        artifact.sha256,
        JSON.stringify(artifact),
        Buffer.from(data),
        artifact.createdAt,
      ],
    );
    return clone((result.rows[0] as Row).metadata as Artifact);
  }
  async list(sessionId: string): Promise<Artifact[]> {
    const result = await this.database.pool.query(
      "SELECT metadata FROM anicode_artifacts WHERE session_id = $1 ORDER BY created_at",
      [sessionId],
    );
    return result.rows.map((row) => clone((row as Row).metadata as Artifact));
  }
  async get(sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined> {
    const result = await this.database.pool.query(
      "SELECT metadata, data FROM anicode_artifacts WHERE session_id = $1 AND id = $2",
      [sessionId, artifactId],
    );
    const row = result.rows[0] as Row | undefined;
    if (!row) return undefined;
    return {
      artifact: clone(row.metadata as Artifact),
      data: new Uint8Array(row.data as Uint8Array),
    };
  }
  async delete(sessionId: string, artifactId: string): Promise<boolean> {
    const result = await this.database.pool.query(
      "DELETE FROM anicode_artifacts WHERE session_id = $1 AND id = $2",
      [sessionId, artifactId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertIdentifier(sessionId, "session id");
    await this.database.pool.query("DELETE FROM anicode_artifacts WHERE session_id = $1", [
      sessionId,
    ]);
  }
}
