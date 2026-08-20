/**
 * 生产默认持久化：一个 SQLite WAL 数据库承载 Runtime、inbox/outbox、worker、
 * snapshot、artifact 与安全审计。所有 read-modify-write 都在 BEGIN IMMEDIATE 中完成，
 * 多进程争用由 SQLite busy_timeout 协调，不再依赖 JSON 文件锁。
 */

import { randomUUID, createHash } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Artifact, ArtifactInput, ArtifactRecord, ArtifactStore } from "./artifacts.js";
import {
  CommandIdempotencyConflictError,
  type CommandInboxStore,
  type DurableCommand,
  type FencedCommandEventCommit,
  type OutboxMessage,
  type OutboxStore,
} from "./commands.js";
import type { ISessionStore, SessionData, SessionMeta } from "../session.js";
import type { ChatMessage } from "../types.js";
import type {
  AppendRuntimeEvent,
  RuntimeEvent,
  RuntimeEventStore,
  RuntimeSnapshot,
  RuntimeSnapshotStore,
} from "./durable.js";
import {
  WorkerQueueQuotaError,
  type WorkerEnqueueQuota,
  type WorkerJob,
  type WorkerQueueStore,
  type WorkerCancellationResult,
  type WorktreeLease,
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

const RUNTIME_SCHEMA_V1 = `
  CREATE TABLE IF NOT EXISTS runtime_events (
    stream_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    id TEXT NOT NULL UNIQUE,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    correlation_id TEXT,
    causation_id TEXT,
    idempotency_key TEXT,
    trace_id TEXT,
    span_id TEXT,
    PRIMARY KEY (stream_id, sequence)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS uq_runtime_event_idempotency
    ON runtime_events(stream_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_runtime_events_type ON runtime_events(type, timestamp);

  CREATE TABLE IF NOT EXISTS runtime_snapshots (
    stream_id TEXT PRIMARY KEY,
    sequence INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    cwd TEXT NOT NULL,
    model TEXT NOT NULL,
    title TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
  CREATE TABLE IF NOT EXISTS session_messages (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    idx INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY(session_id, idx)
  );

  CREATE TABLE IF NOT EXISTS commands (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    fencing_token INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    UNIQUE (session_id, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_commands_recovery
    ON commands(session_id, status, lease_expires_at);

  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_pending ON outbox(status, updated_at);

  CREATE TABLE IF NOT EXISTS worker_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,
    lease_owner TEXT,
    lease_expires_at TEXT,
    fencing_token INTEGER NOT NULL DEFAULT 0,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_worker_claim
    ON worker_jobs(type, status, lease_expires_at, created_at);

  CREATE TABLE IF NOT EXISTS artifacts (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    metadata TEXT NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (session_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id, created_at);

  CREATE TABLE IF NOT EXISTS runtime_audit (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    category TEXT NOT NULL,
    action TEXT NOT NULL,
    subject TEXT,
    actor TEXT,
    decision TEXT,
    metadata TEXT NOT NULL,
    trace_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_runtime_audit_time ON runtime_audit(category, timestamp);
`;

const RUNTIME_SCHEMA_V2 = `
  CREATE INDEX IF NOT EXISTS idx_runtime_events_retention ON runtime_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_commands_retention ON commands(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_worker_jobs_retention ON worker_jobs(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_artifacts_retention ON artifacts(created_at);
`;

const RUNTIME_SCHEMA_V3 = `
  ALTER TABLE sessions ADD COLUMN workspace_device TEXT;
  ALTER TABLE sessions ADD COLUMN workspace_inode TEXT;

  CREATE TABLE session_lifecycle (
    session_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('active', 'deleting', 'deleted')),
    epoch INTEGER NOT NULL DEFAULT 0,
    workspace TEXT,
    workspace_device TEXT,
    workspace_inode TEXT,
    delete_owner TEXT,
    delete_token TEXT,
    delete_lease_expires_at TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_session_lifecycle_state
    ON session_lifecycle(state, delete_lease_expires_at);

  CREATE TABLE session_operation_leases (
    lease_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_session_operation_leases_session
    ON session_operation_leases(session_id, expires_at);
`;

const RUNTIME_SCHEMA_V4 = `
  ALTER TABLE outbox ADD COLUMN lease_owner TEXT;
  ALTER TABLE outbox ADD COLUMN lease_expires_at TEXT;
  ALTER TABLE outbox ADD COLUMN fencing_token INTEGER NOT NULL DEFAULT 0;

  DROP INDEX idx_outbox_pending;
  CREATE INDEX idx_outbox_pending
    ON outbox(status, lease_expires_at, updated_at);
`;

const RUNTIME_SCHEMA_V5 = `
  ALTER TABLE worker_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE worker_jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;

  UPDATE worker_jobs
  SET attempts = COALESCE(CAST(json_extract(data, '$.attempts') AS INTEGER), 0),
      max_attempts = MAX(
        1,
        COALESCE(CAST(json_extract(data, '$.maxAttempts') AS INTEGER), 3)
      );

  DROP INDEX idx_worker_claim;
  CREATE INDEX idx_worker_claim
    ON worker_jobs(status, type, lease_expires_at, created_at, id);
`;

const SQLITE_MIGRATIONS = [
  { version: 1, description: "initial durable runtime schema", sql: RUNTIME_SCHEMA_V1 },
  { version: 2, description: "retention and compaction indexes", sql: RUNTIME_SCHEMA_V2 },
  {
    version: 3,
    description: "durable session lifecycle leases and workspace identity",
    sql: RUNTIME_SCHEMA_V3,
  },
  {
    version: 4,
    description: "outbox leases and fencing tokens",
    sql: RUNTIME_SCHEMA_V4,
  },
  {
    version: 5,
    description: "normalized worker queue claim state",
    sql: RUNTIME_SCHEMA_V5,
  },
] as const;

export interface SqliteRetentionPolicy {
  auditDays?: number;
  terminalCommandDays?: number;
  sentOutboxDays?: number;
  terminalWorkerDays?: number;
  snapshottedEventDays?: number;
  artifactDays?: number;
}

export interface SqlitePruneResult {
  audit: number;
  commands: number;
  outbox: number;
  workerJobs: number;
  events: number;
  artifacts: number;
}

/** 同一 Node 进程打开相同文件的多个连接也共享串行队列，避免 DatabaseSync busy wait 卡住事件循环。 */
const SQLITE_FILE_TAILS = new Map<string, Promise<unknown>>();
const SQLITE_LOCK_WAIT_MS = 10_000;
const SQLITE_BUSY_SLICE_MS = 5;
const SQLITE_BUSY_RETRY_MS = 5;

function sqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { errcode?: unknown; message?: unknown };
  return (
    candidate.errcode === 5 ||
    (typeof candidate.message === "string" &&
      /(?:database is locked|database is busy|SQLITE_BUSY)/i.test(candidate.message))
  );
}

async function beginImmediateWithoutLongEventLoopBlock(db: DatabaseSync): Promise<void> {
  const deadline = Date.now() + SQLITE_LOCK_WAIT_MS;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!sqliteBusy(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, SQLITE_BUSY_RETRY_MS));
    }
  }
}

function preparePrivateRuntimeDatabaseFile(file: string): void {
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) throw new Error(`SQLite runtime path is not a regular file: ${file}`);
    if (process.platform === "win32" || (stat.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    closeSync(openSync(file, "wx", 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = lstatSync(file);
    if (!stat.isFile())
      throw new Error(`SQLite runtime path is not a regular file: ${file}`, { cause: error });
  }
  const stat = lstatSync(file);
  if (process.platform === "win32" || (stat.mode & 0o777) !== 0o600) chmodSync(file, 0o600);
}

function secureRuntimeDatabaseFiles(file: string): void {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      const stat = lstatSync(candidate);
      if (!stat.isFile())
        throw new Error(`SQLite runtime path is not a regular file: ${candidate}`);
      // Keep the symlink/regular-file verification on every accepted operation, but avoid an
      // unconditional metadata write when the owner-only boundary is already correct.
      if (process.platform === "win32" || (stat.mode & 0o777) !== 0o600) {
        chmodSync(candidate, 0o600);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && candidate !== file) continue;
      throw error;
    }
  }
}

function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sqliteTimestamp(db: DatabaseSync): string {
  const row = db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS value").get() as Row;
  const value = String(row.value);
  if (!Number.isFinite(Date.parse(value))) throw new Error("SQLite failed to provide its clock");
  return value;
}

function leaseExpiresAt(now: string, leaseMs: number): string {
  return new Date(Date.parse(now) + Math.max(1_000, leaseMs)).toISOString();
}

function commandFromSqliteRow(row: Row): DurableCommand {
  const command = json<DurableCommand>(row.data);
  command.status = String(row.status) as DurableCommand["status"];
  command.updatedAt = String(row.updated_at);
  command.fencingToken = Number(row.fencing_token ?? 0);
  if (row.lease_owner == null) delete command.leaseOwner;
  else command.leaseOwner = String(row.lease_owner);
  if (row.lease_expires_at == null) delete command.leaseExpiresAt;
  else command.leaseExpiresAt = String(row.lease_expires_at);
  return command;
}

function outboxFromSqliteRow(row: Row): OutboxMessage {
  const message = json<OutboxMessage>(row.data);
  message.status = String(row.status) as OutboxMessage["status"];
  message.updatedAt = String(row.updated_at);
  message.fencingToken = Number(row.fencing_token ?? 0);
  if (row.lease_owner == null) delete message.leaseOwner;
  else message.leaseOwner = String(row.lease_owner);
  if (row.lease_expires_at == null) delete message.leaseExpiresAt;
  else message.leaseExpiresAt = String(row.lease_expires_at);
  return message;
}

function workerFromSqliteRow(row: Row): WorkerJob {
  const job = json<WorkerJob>(row.data);
  job.status = String(row.status) as WorkerJob["status"];
  job.attempts = Number(row.attempts ?? job.attempts ?? 0);
  job.maxAttempts = Number(row.max_attempts ?? job.maxAttempts ?? 3);
  job.updatedAt = String(row.updated_at);
  job.fencingToken = Number(row.fencing_token ?? 0);
  if (row.lease_owner == null) delete job.leaseOwner;
  else job.leaseOwner = String(row.lease_owner);
  if (row.lease_expires_at == null) delete job.leaseExpiresAt;
  else job.leaseExpiresAt = String(row.lease_expires_at);
  return job;
}

function assertIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

export interface RuntimeAuditRecord {
  id?: string;
  timestamp?: string;
  category: "credential" | "network" | "runtime" | "github" | "security";
  action: string;
  subject?: string;
  actor?: string;
  decision?: "allow" | "deny" | "success" | "failure";
  metadata?: Record<string, unknown>;
  traceId?: string;
}

function migrationChecksum(sql: string): string {
  return createHash("sha256").update(sql).digest("hex");
}

function migrateDatabase(db: DatabaseSync): void {
  // The schema ledger bootstrap/upgrade is part of the same write transaction as migrations.
  // This prevents two processes opening an old database from both observing a missing ledger
  // column and racing the same ALTER TABLE.
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL,
        checksum TEXT,
        description TEXT
      );
    `);
    const columns = new Set(
      db
        .prepare("PRAGMA table_info(schema_migrations)")
        .all()
        .map((row) => String((row as Row).name)),
    );
    if (!columns.has("checksum")) db.exec("ALTER TABLE schema_migrations ADD COLUMN checksum TEXT");
    if (!columns.has("description"))
      db.exec("ALTER TABLE schema_migrations ADD COLUMN description TEXT");

    const latest = SQLITE_MIGRATIONS.at(-1)!.version;
    const future = db
      .prepare("SELECT version FROM schema_migrations WHERE version > ? ORDER BY version LIMIT 1")
      .get(latest) as Row | undefined;
    if (future) {
      throw new Error(
        `SQLite schema version ${String(future.version)} is newer than supported version ${latest}`,
      );
    }

    for (const migration of SQLITE_MIGRATIONS) {
      const checksum = migrationChecksum(migration.sql);
      const applied = db
        .prepare("SELECT checksum FROM schema_migrations WHERE version = ?")
        .get(migration.version) as Row | undefined;
      if (applied) {
        const recorded = applied.checksum == null ? "" : String(applied.checksum);
        if (recorded && recorded !== checksum) {
          throw new Error(`SQLite migration ${migration.version} checksum mismatch`);
        }
        if (!recorded) {
          db.prepare(
            "UPDATE schema_migrations SET checksum = ?, description = ? WHERE version = ?",
          ).run(checksum, migration.description, migration.version);
        }
        continue;
      }
      db.exec(migration.sql);
      db.prepare(
        `INSERT INTO schema_migrations(version, applied_at, checksum, description)
         VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?, ?)`,
      ).run(migration.version, checksum, migration.description);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the migration failure.
    }
    throw error;
  }
}

/** 共享连接自身就是并发边界；所有 adapter 必须通过 run/transaction 访问连接。 */
export class SqliteRuntimeDatabase {
  readonly file: string;
  private readonly db: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closeTask: Promise<void> | undefined;

  constructor(file: string) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    preparePrivateRuntimeDatabaseFile(this.file);
    this.db = new DatabaseSync(this.file);
    try {
      // Configure the lock wait before journal-mode/schema work so concurrent process startup is
      // bounded by the declared timeout instead of failing immediately.
      this.db.exec("PRAGMA busy_timeout = 10000");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = FULL");
      this.db.exec("PRAGMA foreign_keys = ON");
      migrateDatabase(this.db);
      // Constructor migrations retain the generous startup wait above. Runtime write contention
      // is retried asynchronously in short slices so another process cannot freeze this host's
      // JavaScript event loop for the full lock timeout.
      this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_SLICE_MS}`);
      secureRuntimeDatabaseFiles(this.file);
    } catch (error) {
      try {
        this.db.close();
      } catch {
        // Preserve the initialization error if SQLite already invalidated the handle.
      }
      throw error;
    }
  }

  run<T>(work: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("SQLite runtime database is closed"));
    const previous = SQLITE_FILE_TAILS.get(this.file) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(async () => {
        secureRuntimeDatabaseFiles(this.file);
        let result: T;
        try {
          result = await work(this.db);
        } catch (error) {
          try {
            secureRuntimeDatabaseFiles(this.file);
          } catch {
            // Preserve the operation error.
          }
          throw error;
        }
        // WAL/SHM can be recreated after a checkpoint. Re-apply the private boundary after every
        // accepted operation without changing the caller-owned parent directory.
        secureRuntimeDatabaseFiles(this.file);
        return result;
      });
    SQLITE_FILE_TAILS.set(this.file, current);
    this.tail = current;
    const cleanup = () => {
      if (SQLITE_FILE_TAILS.get(this.file) === current) SQLITE_FILE_TAILS.delete(this.file);
    };
    void current.then(cleanup, cleanup);
    return current;
  }

  transaction<T>(work: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    return this.run(async (db) => {
      await beginImmediateWithoutLongEventLoopBlock(db);
      try {
        const result = await work(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // 原始错误优先。
        }
        throw error;
      }
    });
  }

  async audit(input: RuntimeAuditRecord): Promise<void> {
    const record = {
      ...input,
      id: input.id ?? `audit_${randomUUID()}`,
      timestamp: input.timestamp ?? new Date().toISOString(),
    };
    await this.transaction((db) => {
      db.prepare(
        `INSERT INTO runtime_audit
         (id, timestamp, category, action, subject, actor, decision, metadata, trace_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.timestamp,
        record.category,
        record.action,
        record.subject ?? null,
        record.actor ?? null,
        record.decision ?? null,
        JSON.stringify(record.metadata ?? {}),
        record.traceId ?? null,
      );
    });
  }

  async auditLog(limit = 100): Promise<RuntimeAuditRecord[]> {
    return this.run((db) =>
      db
        .prepare("SELECT * FROM runtime_audit ORDER BY timestamp DESC LIMIT ?")
        .all(Math.max(1, limit))
        .map((row) => auditFromRow(row as Row)),
    );
  }

  /** Explicit, transactional retention pass. User sessions/messages are never deleted here. */
  prune(policy: SqliteRetentionPolicy = {}, now: number = Date.now()): Promise<SqlitePruneResult> {
    const days = (value: number | undefined, fallback: number): number => {
      const resolved = value ?? fallback;
      if (!Number.isInteger(resolved) || resolved < 1 || resolved > 3_650) {
        throw new Error(`SQLite retention days must be an integer from 1 to 3650: ${resolved}`);
      }
      return resolved;
    };
    const cutoff = (value: number | undefined, fallback: number): string =>
      new Date(now - days(value, fallback) * 86_400_000).toISOString();
    const auditCutoff = cutoff(policy.auditDays, 90);
    const commandCutoff = cutoff(policy.terminalCommandDays, 30);
    const outboxCutoff = cutoff(policy.sentOutboxDays, 7);
    const workerCutoff = cutoff(policy.terminalWorkerDays, 30);
    const eventCutoff = cutoff(policy.snapshottedEventDays, 30);
    const artifactCutoff = cutoff(policy.artifactDays, 90);
    return this.transaction((db) => {
      const changes = (result: { changes: number | bigint }): number => Number(result.changes);
      const audit = changes(
        db.prepare("DELETE FROM runtime_audit WHERE timestamp < ?").run(auditCutoff),
      );
      const commands = changes(
        db
          .prepare(
            "DELETE FROM commands WHERE status IN ('completed', 'failed', 'cancelled') AND updated_at < ?",
          )
          .run(commandCutoff),
      );
      const outbox = changes(
        db.prepare("DELETE FROM outbox WHERE status = 'sent' AND updated_at < ?").run(outboxCutoff),
      );
      const workerJobs = changes(
        db
          .prepare(
            `DELETE FROM worker_jobs
             WHERE type NOT GLOB '__worktree__:*'
               AND status IN ('succeeded', 'failed', 'cancelled')
               AND updated_at < ?`,
          )
          .run(workerCutoff),
      );
      const events = changes(
        db
          .prepare(
            `DELETE FROM runtime_events
             WHERE timestamp < ? AND EXISTS (
               SELECT 1 FROM runtime_snapshots
               WHERE runtime_snapshots.stream_id = runtime_events.stream_id
                 AND runtime_snapshots.sequence >= runtime_events.sequence
             )`,
          )
          .run(eventCutoff),
      );
      const artifacts = changes(
        db.prepare("DELETE FROM artifacts WHERE created_at < ?").run(artifactCutoff),
      );
      return { audit, commands, outbox, workerJobs, events, artifacts };
    });
  }

  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    // Fence new work synchronously. Waiting for the queue before setting this flag allows a
    // concurrent run() to append behind the captured tail and then execute against a closed DB.
    this.closed = true;
    const acceptedTail = this.tail;
    this.closeTask = acceptedTail.catch(() => undefined).then(() => this.db.close());
    return this.closeTask;
  }
}

function auditFromRow(row: Row): RuntimeAuditRecord {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    category: String(row.category) as RuntimeAuditRecord["category"],
    action: String(row.action),
    ...(row.subject != null ? { subject: String(row.subject) } : {}),
    ...(row.actor != null ? { actor: String(row.actor) } : {}),
    ...(row.decision != null
      ? {
          decision: String(row.decision) as Exclude<RuntimeAuditRecord["decision"], undefined>,
        }
      : {}),
    metadata: json<Record<string, unknown>>(row.metadata),
    ...(row.trace_id != null ? { traceId: String(row.trace_id) } : {}),
  };
}

function sqliteLifecycleRecord(row: Row, activeLeases: number): SessionLifecycleRecord {
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
      ? { deleteLeaseExpiresAt: String(row.delete_lease_expires_at) }
      : {}),
  };
}

/** SQLite durable lifecycle adapter. BEGIN IMMEDIATE serializes acquire/delete transitions. */
export class SqliteSessionLifecycleStore implements SessionLifecycleStore {
  constructor(readonly database: SqliteRuntimeDatabase) {}

  get(sessionId: string): Promise<SessionLifecycleRecord | undefined> {
    assertIdentifier(sessionId, "session lifecycle id");
    return this.database.transaction((db) => {
      const now = new Date().toISOString();
      db.prepare(
        "DELETE FROM session_operation_leases WHERE session_id = ? AND expires_at <= ?",
      ).run(sessionId, now);
      const row = db
        .prepare("SELECT * FROM session_lifecycle WHERE session_id = ?")
        .get(sessionId) as Row | undefined;
      if (!row) return undefined;
      return sqliteLifecycleRecord(row, this.activeLeaseCount(db, sessionId, now));
    });
  }

  listDeleted(input: {
    limit: number;
    afterSessionId?: string;
    workspace?: string;
  }): Promise<SessionLifecycleRecord[]> {
    this.validateListInput(input);
    return this.database.run((db) => {
      const rows = db
        .prepare(
          `SELECT * FROM session_lifecycle
           WHERE state = 'deleted'
             AND (? IS NULL OR session_id > ?)
             AND (? IS NULL OR workspace = ?)
           ORDER BY session_id
           LIMIT ?`,
        )
        .all(
          input.afterSessionId ?? null,
          input.afterSessionId ?? null,
          input.workspace ?? null,
          input.workspace ?? null,
          input.limit,
        ) as Row[];
      return rows.map((row) => sqliteLifecycleRecord(row, 0));
    });
  }

  acquireOperation(input: AcquireSessionOperationInput): Promise<SessionOperationLease> {
    this.validateInput(input);
    return this.database.transaction((db) => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      db.prepare(
        "DELETE FROM session_operation_leases WHERE session_id = ? AND expires_at <= ?",
      ).run(input.sessionId, now);
      db.prepare(
        `INSERT INTO session_lifecycle
         (session_id, state, epoch, workspace, workspace_device, workspace_inode, updated_at)
         VALUES (?, 'active', 0, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
      ).run(
        input.sessionId,
        input.workspace ?? null,
        input.workspaceIdentity?.device ?? null,
        input.workspaceIdentity?.inode ?? null,
        now,
      );
      const row = db
        .prepare("SELECT * FROM session_lifecycle WHERE session_id = ?")
        .get(input.sessionId) as Row;
      const state = String(row.state) as SessionLifecycleRecord["state"];
      if (state !== "active") throw new SessionLifecycleUnavailableError(input.sessionId, state);
      this.assertWorkspace(row, input.workspace, input.workspaceIdentity);
      if (row.workspace == null && input.workspace) {
        db.prepare(
          "UPDATE session_lifecycle SET workspace = ?, updated_at = ? WHERE session_id = ?",
        ).run(input.workspace, now, input.sessionId);
      }
      if (row.workspace_device == null && row.workspace_inode == null && input.workspaceIdentity) {
        db.prepare(
          `UPDATE session_lifecycle SET workspace_device = ?, workspace_inode = ?, updated_at = ?
           WHERE session_id = ?`,
        ).run(input.workspaceIdentity.device, input.workspaceIdentity.inode, now, input.sessionId);
      }
      const lease: SessionOperationLease = {
        sessionId: input.sessionId,
        leaseId: `sop_${randomUUID()}`,
        owner: input.owner,
        epoch: Number(row.epoch),
        expiresAt: new Date(nowMs + input.ttlMs).toISOString(),
      };
      db.prepare(
        `INSERT INTO session_operation_leases
         (lease_id, session_id, owner, epoch, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(lease.leaseId, lease.sessionId, lease.owner, lease.epoch, lease.expiresAt, now);
      return lease;
    });
  }

  renewOperation(lease: SessionOperationLease, ttlMs: number): Promise<boolean> {
    this.validateLease(lease);
    assertLifecycleTtl(ttlMs);
    return this.database.transaction((db) => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const result = db
        .prepare(
          `UPDATE session_operation_leases SET expires_at = ?
           WHERE lease_id = ? AND session_id = ? AND owner = ? AND epoch = ? AND expires_at > ?`,
        )
        .run(
          new Date(nowMs + ttlMs).toISOString(),
          lease.leaseId,
          lease.sessionId,
          lease.owner,
          lease.epoch,
          now,
        );
      return Number(result.changes) === 1;
    });
  }

  releaseOperation(lease: SessionOperationLease): Promise<void> {
    this.validateLease(lease);
    return this.database.transaction((db) => {
      db.prepare(
        `DELETE FROM session_operation_leases
         WHERE lease_id = ? AND session_id = ? AND owner = ? AND epoch = ?`,
      ).run(lease.leaseId, lease.sessionId, lease.owner, lease.epoch);
    });
  }

  claimDeletion(input: ClaimSessionDeletionInput): Promise<SessionDeletionClaim> {
    this.validateInput(input);
    return this.database.transaction((db) => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      db.prepare(
        "DELETE FROM session_operation_leases WHERE session_id = ? AND expires_at <= ?",
      ).run(input.sessionId, now);
      db.prepare(
        `INSERT INTO session_lifecycle
         (session_id, state, epoch, workspace, workspace_device, workspace_inode, updated_at)
         VALUES (?, 'active', 0, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO NOTHING`,
      ).run(
        input.sessionId,
        input.workspace ?? null,
        input.workspaceIdentity?.device ?? null,
        input.workspaceIdentity?.inode ?? null,
        now,
      );
      let row = db
        .prepare("SELECT * FROM session_lifecycle WHERE session_id = ?")
        .get(input.sessionId) as Row;
      this.assertWorkspace(row, input.workspace, input.workspaceIdentity);
      if (row.workspace == null && input.workspace) {
        db.prepare("UPDATE session_lifecycle SET workspace = ? WHERE session_id = ?").run(
          input.workspace,
          input.sessionId,
        );
        row.workspace = input.workspace;
      }
      if (row.workspace_device == null && row.workspace_inode == null && input.workspaceIdentity) {
        db.prepare(
          `UPDATE session_lifecycle SET workspace_device = ?, workspace_inode = ?
           WHERE session_id = ?`,
        ).run(input.workspaceIdentity.device, input.workspaceIdentity.inode, input.sessionId);
        row.workspace_device = input.workspaceIdentity.device;
        row.workspace_inode = input.workspaceIdentity.inode;
      }
      if (row.state === "deleted") {
        return {
          ...sqliteLifecycleRecord(row, this.activeLeaseCount(db, input.sessionId, now)),
          claimed: false,
        };
      }
      if (row.state === "active") {
        db.prepare(
          `UPDATE session_lifecycle SET state = 'deleting', epoch = epoch + 1,
           delete_owner = NULL, delete_token = NULL, delete_lease_expires_at = NULL,
           updated_at = ? WHERE session_id = ?`,
        ).run(now, input.sessionId);
        row = db
          .prepare("SELECT * FROM session_lifecycle WHERE session_id = ?")
          .get(input.sessionId) as Row;
      }
      const claimExpired =
        row.delete_lease_expires_at == null || String(row.delete_lease_expires_at) <= now;
      const reentrant = row.delete_owner === input.owner && !claimExpired;
      let claimed = false;
      if (claimExpired || reentrant) {
        const token = reentrant ? String(row.delete_token) : `sdel_${randomUUID()}`;
        const expiresAt = new Date(nowMs + input.ttlMs).toISOString();
        db.prepare(
          `UPDATE session_lifecycle SET delete_owner = ?, delete_token = ?,
           delete_lease_expires_at = ?, updated_at = ? WHERE session_id = ?`,
        ).run(input.owner, token, expiresAt, now, input.sessionId);
        row.delete_owner = input.owner;
        row.delete_token = token;
        row.delete_lease_expires_at = expiresAt;
        claimed = true;
      }
      return {
        ...sqliteLifecycleRecord(row, this.activeLeaseCount(db, input.sessionId, now)),
        claimed,
      };
    });
  }

  renewDeletion(claim: SessionDeletionClaim, ttlMs: number): Promise<boolean> {
    this.validateClaim(claim);
    assertLifecycleTtl(ttlMs);
    return this.database.transaction((db) => {
      const nowMs = Date.now();
      const now = new Date(nowMs).toISOString();
      const result = db
        .prepare(
          `UPDATE session_lifecycle SET delete_lease_expires_at = ?, updated_at = ?
           WHERE session_id = ? AND state = 'deleting' AND delete_owner = ?
             AND delete_token = ? AND delete_lease_expires_at > ?`,
        )
        .run(
          new Date(nowMs + ttlMs).toISOString(),
          now,
          claim.sessionId,
          claim.deleteOwner!,
          claim.deleteToken!,
          now,
        );
      return Number(result.changes) === 1;
    });
  }

  completeDeletion(claim: SessionDeletionClaim): Promise<boolean> {
    this.validateClaim(claim);
    return this.database.transaction((db) => {
      const now = new Date().toISOString();
      db.prepare(
        "DELETE FROM session_operation_leases WHERE session_id = ? AND expires_at <= ?",
      ).run(claim.sessionId, now);
      if (this.activeLeaseCount(db, claim.sessionId, now) !== 0) return false;
      const result = db
        .prepare(
          `UPDATE session_lifecycle SET state = 'deleted',
           delete_owner = NULL, delete_token = NULL, delete_lease_expires_at = NULL,
           updated_at = ?
           WHERE session_id = ? AND state = 'deleting' AND delete_owner = ?
             AND delete_token = ? AND delete_lease_expires_at > ?`,
        )
        .run(now, claim.sessionId, claim.deleteOwner!, claim.deleteToken!, now);
      return Number(result.changes) === 1;
    });
  }

  private activeLeaseCount(db: DatabaseSync, sessionId: string, now: string): number {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count FROM session_operation_leases WHERE session_id = ? AND expires_at > ?",
      )
      .get(sessionId, now) as Row;
    return Number(row.count);
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

function eventFromRow<T = unknown>(row: Row): RuntimeEvent<T> {
  return {
    id: String(row.id),
    version: 2,
    streamId: String(row.stream_id),
    sequence: Number(row.sequence),
    timestamp: String(row.timestamp),
    type: String(row.type),
    data: json<T>(row.data),
    ...(row.correlation_id != null ? { correlationId: String(row.correlation_id) } : {}),
    ...(row.causation_id != null ? { causationId: String(row.causation_id) } : {}),
    ...(row.idempotency_key != null ? { idempotencyKey: String(row.idempotency_key) } : {}),
    ...(row.trace_id != null ? { traceId: String(row.trace_id) } : {}),
    ...(row.span_id != null ? { spanId: String(row.span_id) } : {}),
  };
}

export class SqliteRuntimeEventStore implements RuntimeEventStore {
  readonly lifecycle: SessionLifecycleStore;
  readonly atomicPersistenceBackend: object;

  constructor(readonly database: SqliteRuntimeDatabase) {
    this.lifecycle = new SqliteSessionLifecycleStore(database);
    this.atomicPersistenceBackend = database;
  }

  append<T>(input: AppendRuntimeEvent<T>): Promise<RuntimeEvent<T>> {
    assertIdentifier(input.streamId, "runtime stream id");
    return this.database.transaction((db) => {
      if (input.idempotencyKey) {
        const duplicate = db
          .prepare("SELECT * FROM runtime_events WHERE stream_id = ? AND idempotency_key = ?")
          .get(input.streamId, input.idempotencyKey) as Row | undefined;
        if (duplicate) return eventFromRow<T>(duplicate);
      }
      const last = db
        .prepare("SELECT MAX(sequence) AS sequence FROM runtime_events WHERE stream_id = ?")
        .get(input.streamId) as Row;
      const current = Number(last.sequence ?? 0);
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
      db.prepare(
        `INSERT INTO runtime_events
         (stream_id, sequence, id, timestamp, type, data, correlation_id, causation_id,
          idempotency_key, trace_id, span_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
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
      );
      return event;
    });
  }

  read(streamId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    assertIdentifier(streamId, "runtime stream id");
    return this.database.run((db) =>
      db
        .prepare(
          "SELECT * FROM runtime_events WHERE stream_id = ? AND sequence > ? ORDER BY sequence",
        )
        .all(streamId, afterSequence)
        .map((row) => eventFromRow(row as Row)),
    );
  }

  listStreams(): Promise<string[]> {
    return this.database.run((db) =>
      db
        .prepare("SELECT DISTINCT stream_id FROM runtime_events ORDER BY stream_id")
        .all()
        .map((row) => String((row as Row).stream_id)),
    );
  }

  async delete(streamId: string): Promise<void> {
    assertIdentifier(streamId, "runtime stream id");
    await this.database.transaction((db) => {
      db.prepare("DELETE FROM runtime_events WHERE stream_id = ?").run(streamId);
    });
  }
}

export class SqliteRuntimeSnapshotStore implements RuntimeSnapshotStore {
  constructor(readonly database: SqliteRuntimeDatabase) {}

  async get(streamId: string): Promise<RuntimeSnapshot | undefined> {
    assertIdentifier(streamId, "runtime stream id");
    return this.database.run((db) => {
      const row = db
        .prepare("SELECT data FROM runtime_snapshots WHERE stream_id = ?")
        .get(streamId) as Row | undefined;
      return row ? json<RuntimeSnapshot>(row.data) : undefined;
    });
  }

  async put(snapshot: RuntimeSnapshot): Promise<void> {
    assertIdentifier(snapshot.streamId, "runtime stream id");
    await this.database.transaction((db) => {
      db.prepare(
        `INSERT INTO runtime_snapshots(stream_id, sequence, data, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(stream_id) DO UPDATE SET
           sequence = excluded.sequence, data = excluded.data, updated_at = excluded.updated_at
         WHERE excluded.sequence >= runtime_snapshots.sequence`,
      ).run(
        snapshot.streamId,
        snapshot.sequence,
        JSON.stringify(snapshot),
        new Date().toISOString(),
      );
    });
  }

  async delete(streamId: string): Promise<void> {
    await this.database.transaction((db) => {
      db.prepare("DELETE FROM runtime_snapshots WHERE stream_id = ?").run(streamId);
    });
  }
}

function sessionMetaFromRow(row: Row): SessionMeta {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
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

/**
 * 生产会话存储：与 event/inbox/outbox 共用同一个 WAL 数据库。
 * append/rewrite 均走 BEGIN IMMEDIATE，跨进程追加不会复用 message index。
 */
export class SqliteRuntimeSessionStore implements ISessionStore {
  readonly storageSemantics = "transactional-primary" as const;
  constructor(readonly database: SqliteRuntimeDatabase) {}

  create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    assertIdentifier(meta.id, "session id");
    return this.database.transaction((db) => {
      const now = new Date().toISOString();
      const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
      db.prepare(
        `INSERT INTO sessions
         (id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        full.id,
        full.createdAt,
        full.updatedAt,
        full.cwd,
        full.workspaceIdentity?.device ?? null,
        full.workspaceIdentity?.inode ?? null,
        full.model,
        full.title ?? null,
      );
      return full;
    });
  }

  append(id: string, message: ChatMessage): Promise<void> {
    return this.appendMany(id, [message]);
  }

  appendMany(id: string, messages: ChatMessage[]): Promise<void> {
    assertIdentifier(id, "session id");
    if (messages.length === 0) return Promise.resolve();
    // Serialize before taking the write lock so large tool results do not lengthen the critical
    // section. The transaction still owns index allocation and every insert atomically.
    const serialized = messages.map((message) => JSON.stringify(message));
    return this.database.transaction((db) => {
      const session = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
      if (!session) throw new Error(`Session ${id} not found`);
      const row = db
        .prepare(
          "SELECT COALESCE(MAX(idx), -1) + 1 AS next_idx FROM session_messages WHERE session_id = ?",
        )
        .get(id) as Row;
      const firstIndex = Number(row.next_idx);
      const insert = db.prepare(
        "INSERT INTO session_messages(session_id, idx, data) VALUES (?, ?, ?)",
      );
      serialized.forEach((data, offset) => insert.run(id, firstIndex + offset, data));
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        id,
      );
    });
  }

  getMeta(id: string): Promise<SessionMeta | undefined> {
    assertIdentifier(id, "session id");
    return this.database.run((db) => {
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
      return row ? sessionMetaFromRow(row) : undefined;
    });
  }

  updateMeta(meta: SessionMeta): Promise<SessionMeta> {
    assertIdentifier(meta.id, "session id");
    return this.database.transaction((db) => {
      const updatedAt = new Date().toISOString();
      const updated = db
        .prepare(
          `UPDATE sessions SET
             updated_at = ?,
             cwd = ?,
             workspace_device = ?,
             workspace_inode = ?,
             model = ?,
             title = ?
           WHERE id = ?`,
        )
        .run(
          updatedAt,
          meta.cwd,
          meta.workspaceIdentity?.device ?? null,
          meta.workspaceIdentity?.inode ?? null,
          meta.model,
          meta.title ?? null,
          meta.id,
        );
      if (Number(updated.changes) !== 1) throw new Error(`Session ${meta.id} not found`);
      return { ...meta, updatedAt };
    });
  }

  rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    assertIdentifier(meta.id, "session id");
    return this.database
      .transaction((db) => {
        const updatedAt = new Date().toISOString();
        db.prepare(
          `INSERT INTO sessions
           (id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             cwd = excluded.cwd,
             workspace_device = excluded.workspace_device,
             workspace_inode = excluded.workspace_inode,
             model = excluded.model,
             title = excluded.title`,
        ).run(
          meta.id,
          meta.createdAt,
          updatedAt,
          meta.cwd,
          meta.workspaceIdentity?.device ?? null,
          meta.workspaceIdentity?.inode ?? null,
          meta.model,
          meta.title ?? null,
        );
        db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(meta.id);
        const insert = db.prepare(
          "INSERT INTO session_messages(session_id, idx, data) VALUES (?, ?, ?)",
        );
        messages.forEach((message, index) => insert.run(meta.id, index, JSON.stringify(message)));
        return updatedAt;
      })
      .then((updatedAt) => {
        // Do not expose a timestamp from a transaction whose COMMIT failed and rolled back.
        meta.updatedAt = updatedAt;
      });
  }

  load(id: string): Promise<SessionData> {
    assertIdentifier(id, "session id");
    return this.database.run((db) => {
      // Pin both SELECTs to one WAL snapshot. Otherwise a writer in another process may commit a
      // rewrite/delete between them and produce metadata and messages from different versions.
      db.exec("BEGIN");
      try {
        const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
        if (!row) throw new Error(`Session ${id} not found`);
        const data = {
          ...sessionMetaFromRow(row),
          messages: db
            .prepare("SELECT data FROM session_messages WHERE session_id = ? ORDER BY idx")
            .all(id)
            .map((item) => json<ChatMessage>((item as Row).data)),
        };
        db.exec("COMMIT");
        return data;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the query/parse/commit failure.
        }
        throw error;
      }
    });
  }

  list(): Promise<SessionMeta[]> {
    return this.database.run((db) =>
      db
        .prepare("SELECT * FROM sessions ORDER BY updated_at DESC, id")
        .all()
        .map((row) => sessionMetaFromRow(row as Row)),
    );
  }

  delete(id: string): Promise<void> {
    assertIdentifier(id, "session id");
    return this.database.transaction((db) => {
      db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    });
  }
}

export class SqliteCommandInboxStore implements CommandInboxStore {
  readonly atomicPersistenceBackend: object;

  constructor(readonly database: SqliteRuntimeDatabase) {
    this.atomicPersistenceBackend = database;
  }

  read(sessionId: string): Promise<DurableCommand[]> {
    assertIdentifier(sessionId, "command session id");
    return this.database.run((db) => this.readDirect(db, sessionId));
  }

  write(sessionId: string, commands: DurableCommand[]): Promise<void> {
    assertIdentifier(sessionId, "command session id");
    return this.database.transaction((db) => this.writeDirect(db, sessionId, commands));
  }

  transact<T>(sessionId: string, fn: (commands: DurableCommand[]) => T | Promise<T>): Promise<T> {
    assertIdentifier(sessionId, "command session id");
    return this.database.transaction(async (db) => {
      const commands = this.readDirect(db, sessionId);
      const result = await fn(commands);
      this.writeDirect(db, sessionId, commands);
      return result;
    });
  }

  listSessions(): Promise<string[]> {
    return this.database.run((db) =>
      db
        .prepare("SELECT DISTINCT session_id FROM commands ORDER BY session_id")
        .all()
        .map((row) => String((row as Row).session_id)),
    );
  }

  insertCommand(command: DurableCommand): Promise<DurableCommand> {
    assertIdentifier(command.sessionId, "command session id");
    assertIdentifier(command.id, "command id");
    return this.database.transaction((db) => {
      const inserted = db
        .prepare(
          `INSERT INTO commands
           (session_id, id, idempotency_key, status, lease_owner, lease_expires_at,
            fencing_token, data, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(session_id, idempotency_key) DO NOTHING`,
        )
        .run(
          command.sessionId,
          command.id,
          command.idempotencyKey,
          command.status,
          command.leaseOwner ?? null,
          command.leaseExpiresAt ?? null,
          command.fencingToken ?? 0,
          JSON.stringify(command),
          command.updatedAt,
        );
      if (Number(inserted.changes) === 1) return clone(command);

      const duplicate = db
        .prepare(
          `SELECT * FROM commands
           WHERE session_id = ? AND idempotency_key = ?`,
        )
        .get(command.sessionId, command.idempotencyKey) as Row | undefined;
      if (!duplicate) throw new Error("Command idempotency conflict disappeared");
      const existing = commandFromSqliteRow(duplicate);
      if (existing.text !== command.text || existing.model !== command.model) {
        throw new CommandIdempotencyConflictError(command.idempotencyKey);
      }
      return existing;
    });
  }

  claimCommand(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs: number,
    _now: number,
  ): Promise<DurableCommand> {
    assertIdentifier(sessionId, "command session id");
    assertIdentifier(commandId, "command id");
    return this.database.transaction((db) => {
      const row = db
        .prepare("SELECT * FROM commands WHERE session_id = ? AND id = ?")
        .get(sessionId, commandId) as Row | undefined;
      if (!row) throw new Error(`Unknown durable command: ${commandId}`);

      const now = sqliteTimestamp(db);
      const current = commandFromSqliteRow(row);
      const leaseActive = current.leaseExpiresAt !== undefined && current.leaseExpiresAt > now;
      if (current.status === "running" && leaseActive) {
        throw new Error(`Durable command ${commandId} is leased by ${current.leaseOwner}`);
      }
      if (current.status !== "accepted" && current.status !== "running") {
        throw new Error(`Durable command ${commandId} is already ${current.status}`);
      }

      current.status = "running";
      current.attempts++;
      current.fencingToken = (current.fencingToken ?? 0) + 1;
      current.leaseOwner = owner;
      current.leaseExpiresAt = leaseExpiresAt(now, leaseMs);
      current.updatedAt = now;
      db.prepare(
        `UPDATE commands
         SET status = ?, lease_owner = ?, lease_expires_at = ?, fencing_token = ?,
             data = ?, updated_at = ?
         WHERE session_id = ? AND id = ?`,
      ).run(
        current.status,
        current.leaseOwner,
        current.leaseExpiresAt,
        current.fencingToken,
        JSON.stringify(current),
        current.updatedAt,
        sessionId,
        commandId,
      );
      return clone(current);
    });
  }

  heartbeatCommand(
    sessionId: string,
    commandId: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void> {
    assertIdentifier(sessionId, "command session id");
    assertIdentifier(commandId, "command id");
    return this.database.transaction((db) => {
      const row = db
        .prepare("SELECT * FROM commands WHERE session_id = ? AND id = ?")
        .get(sessionId, commandId) as Row | undefined;
      const current = row ? commandFromSqliteRow(row) : undefined;
      if (!current || current.status !== "running" || current.leaseOwner !== owner) {
        throw new Error(`Cannot heartbeat unowned command ${commandId}`);
      }
      if (fencingToken !== undefined && current.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for command ${commandId}`);
      }
      const now = sqliteTimestamp(db);
      if (!current.leaseExpiresAt || current.leaseExpiresAt <= now) {
        throw new Error(`Expired lease for command ${commandId}`);
      }

      current.leaseExpiresAt = leaseExpiresAt(now, leaseMs);
      current.updatedAt = now;
      db.prepare(
        `UPDATE commands
         SET lease_expires_at = ?, data = ?, updated_at = ?
         WHERE session_id = ? AND id = ?`,
      ).run(
        current.leaseExpiresAt,
        JSON.stringify(current),
        current.updatedAt,
        sessionId,
        commandId,
      );
    });
  }

  commitFencedEvent(input: FencedCommandEventCommit): Promise<RuntimeEvent> {
    assertIdentifier(input.sessionId, "command session id");
    assertIdentifier(input.commandId, "command id");
    assertIdentifier(input.event.streamId, "runtime stream id");
    if (input.event.streamId !== input.sessionId) {
      throw new Error("A fenced command event must use its command session as the Runtime stream");
    }
    const idempotencyKey = input.event.idempotencyKey;
    if (!idempotencyKey) {
      throw new Error("A fenced command event requires an idempotency key");
    }
    if (input.event.expectedSequence !== undefined) {
      throw new Error("A fenced command event cannot carry an expected Runtime sequence");
    }
    if (!Number.isSafeInteger(input.fencingToken) || input.fencingToken < 1) {
      throw new Error(`Invalid fencing token for command ${input.commandId}`);
    }

    return this.database.transaction((db) => {
      const now = sqliteTimestamp(db);
      const row = db
        .prepare("SELECT * FROM commands WHERE session_id = ? AND id = ?")
        .get(input.sessionId, input.commandId) as Row | undefined;
      const command = row ? commandFromSqliteRow(row) : undefined;
      if (
        !command ||
        command.status !== "running" ||
        command.leaseOwner !== input.owner ||
        command.fencingToken !== input.fencingToken ||
        !command.leaseExpiresAt ||
        command.leaseExpiresAt <= now
      ) {
        throw new Error(`Stale fencing token for command ${input.commandId}`);
      }

      command.leaseExpiresAt = leaseExpiresAt(now, input.leaseMs);
      command.updatedAt = now;
      db.prepare(
        `UPDATE commands
         SET lease_expires_at = ?, data = ?, updated_at = ?
         WHERE session_id = ? AND id = ?`,
      ).run(
        command.leaseExpiresAt,
        JSON.stringify(command),
        command.updatedAt,
        input.sessionId,
        input.commandId,
      );

      const duplicate = db
        .prepare("SELECT * FROM runtime_events WHERE stream_id = ? AND idempotency_key = ?")
        .get(input.event.streamId, idempotencyKey) as Row | undefined;
      let event: RuntimeEvent;
      if (duplicate) {
        event = eventFromRow(duplicate);
      } else {
        const last = db
          .prepare("SELECT MAX(sequence) AS sequence FROM runtime_events WHERE stream_id = ?")
          .get(input.event.streamId) as Row;
        event = {
          id: `rte_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          version: 2,
          streamId: input.event.streamId,
          sequence: Number(last.sequence ?? 0) + 1,
          timestamp: now,
          type: input.event.type,
          data: input.event.data,
          ...(input.event.correlationId ? { correlationId: input.event.correlationId } : {}),
          ...(input.event.causationId ? { causationId: input.event.causationId } : {}),
          idempotencyKey,
          ...(input.event.traceId ? { traceId: input.event.traceId } : {}),
          ...(input.event.spanId ? { spanId: input.event.spanId } : {}),
        };
        db.prepare(
          `INSERT INTO runtime_events
           (stream_id, sequence, id, timestamp, type, data, correlation_id, causation_id,
            idempotency_key, trace_id, span_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          event.streamId,
          event.sequence,
          event.id,
          event.timestamp,
          event.type,
          JSON.stringify(event.data),
          event.correlationId ?? null,
          event.causationId ?? null,
          idempotencyKey,
          event.traceId ?? null,
          event.spanId ?? null,
        );
      }

      const outboxId = `out_${randomUUID()}`;
      const message: OutboxMessage = {
        id: outboxId,
        status: "sent",
        event: clone(input.event),
        attempts: 1,
        createdAt: now,
        updatedAt: now,
        sentEventId: event.id,
        fencingToken: 0,
      };
      db.prepare(
        `INSERT INTO outbox
         (id, idempotency_key, status, lease_owner, lease_expires_at,
          fencing_token, data, updated_at)
         VALUES (?, ?, 'sent', NULL, NULL, 0, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      ).run(outboxId, idempotencyKey, JSON.stringify(message), now);
      return event;
    });
  }

  finishCommand(
    sessionId: string,
    commandId: string,
    status: "completed" | "failed" | "cancelled",
    error?: string,
    lease?: { owner: string; fencingToken: number },
  ): Promise<void> {
    assertIdentifier(sessionId, "command session id");
    assertIdentifier(commandId, "command id");
    return this.database.transaction((db) => {
      const row = db
        .prepare("SELECT * FROM commands WHERE session_id = ? AND id = ?")
        .get(sessionId, commandId) as Row | undefined;
      if (!row) throw new Error(`Unknown durable command: ${commandId}`);
      const current = commandFromSqliteRow(row);
      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "cancelled"
      ) {
        if (!lease && current.status === status && current.error === (error || undefined)) return;
        throw new Error(`Durable command ${commandId} is already ${current.status}`);
      }

      const now = sqliteTimestamp(db);
      if (
        lease &&
        (current.leaseOwner !== lease.owner ||
          current.fencingToken !== lease.fencingToken ||
          !current.leaseExpiresAt ||
          current.leaseExpiresAt <= now)
      ) {
        throw new Error(`Stale fencing token for command ${commandId}`);
      }

      current.status = status;
      current.updatedAt = now;
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      if (error) current.error = error;
      else delete current.error;
      db.prepare(
        `UPDATE commands
         SET status = ?, lease_owner = NULL, lease_expires_at = NULL, data = ?, updated_at = ?
         WHERE session_id = ? AND id = ?`,
      ).run(current.status, JSON.stringify(current), current.updatedAt, sessionId, commandId);
    });
  }

  getCommand(sessionId: string, commandId: string): Promise<DurableCommand | undefined> {
    assertIdentifier(sessionId, "command session id");
    assertIdentifier(commandId, "command id");
    return this.database.run((db) => {
      const row = db
        .prepare("SELECT * FROM commands WHERE session_id = ? AND id = ?")
        .get(sessionId, commandId) as Row | undefined;
      return row ? commandFromSqliteRow(row) : undefined;
    });
  }

  recoverableCommands(sessionId: string, _now: number): Promise<DurableCommand[]> {
    assertIdentifier(sessionId, "command session id");
    return this.database.run((db) => {
      const now = sqliteTimestamp(db);
      return db
        .prepare(
          `SELECT * FROM commands
           WHERE session_id = ?
             AND (status = 'accepted' OR
                  (status = 'running' AND
                   (lease_expires_at IS NULL OR lease_expires_at <= ?)))
           ORDER BY rowid`,
        )
        .all(sessionId, now)
        .map((row) => commandFromSqliteRow(row as Row));
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertIdentifier(sessionId, "command session id");
    await this.database.transaction((db) => {
      db.prepare("DELETE FROM commands WHERE session_id = ?").run(sessionId);
    });
  }

  private readDirect(db: DatabaseSync, sessionId: string): DurableCommand[] {
    return db
      .prepare("SELECT * FROM commands WHERE session_id = ? ORDER BY rowid")
      .all(sessionId)
      .map((row) => commandFromSqliteRow(row as Row));
  }

  private writeDirect(db: DatabaseSync, sessionId: string, commands: DurableCommand[]): void {
    db.prepare("DELETE FROM commands WHERE session_id = ?").run(sessionId);
    const insert = db.prepare(
      `INSERT INTO commands
       (session_id, id, idempotency_key, status, lease_owner, lease_expires_at,
        fencing_token, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const command of commands) {
      insert.run(
        sessionId,
        command.id,
        command.idempotencyKey,
        command.status,
        command.leaseOwner ?? null,
        command.leaseExpiresAt ?? null,
        command.fencingToken ?? 0,
        JSON.stringify(command),
        command.updatedAt,
      );
    }
  }
}

export class SqliteOutboxStore implements OutboxStore {
  readonly atomicPersistenceBackend: object;

  constructor(readonly database: SqliteRuntimeDatabase) {
    this.atomicPersistenceBackend = database;
  }

  read(): Promise<OutboxMessage[]> {
    return this.database.run((db) => this.readDirect(db));
  }

  write(messages: OutboxMessage[]): Promise<void> {
    return this.database.transaction((db) => this.writeDirect(db, messages));
  }

  transact<T>(fn: (messages: OutboxMessage[]) => T | Promise<T>): Promise<T> {
    return this.database.transaction(async (db) => {
      const messages = this.readDirect(db);
      const result = await fn(messages);
      this.writeDirect(db, messages);
      return result;
    });
  }

  insertMessage(message: OutboxMessage): Promise<OutboxMessage> {
    assertIdentifier(message.id, "outbox message id");
    return this.database.transaction((db) => {
      const idempotencyKey = message.event.idempotencyKey ?? message.id;
      const inserted = db
        .prepare(
          `INSERT INTO outbox
           (id, idempotency_key, status, lease_owner, lease_expires_at,
            fencing_token, data, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(idempotency_key) DO NOTHING`,
        )
        .run(
          message.id,
          idempotencyKey,
          message.status,
          message.leaseOwner ?? null,
          message.leaseExpiresAt ?? null,
          message.fencingToken ?? 0,
          JSON.stringify(message),
          message.updatedAt,
        );
      if (Number(inserted.changes) === 1) return clone(message);

      const duplicate = db
        .prepare("SELECT * FROM outbox WHERE idempotency_key = ?")
        .get(idempotencyKey) as Row | undefined;
      if (!duplicate) throw new Error("Outbox idempotency conflict disappeared");
      return outboxFromSqliteRow(duplicate);
    });
  }

  claimMessage(owner: string, leaseMs: number): Promise<OutboxMessage | undefined> {
    return this.database.transaction((db) => {
      const now = sqliteTimestamp(db);
      const row = db
        .prepare(
          `SELECT * FROM outbox
           WHERE status = 'pending'
             AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
           ORDER BY rowid
           LIMIT 1`,
        )
        .get(now) as Row | undefined;
      if (!row) return undefined;

      const current = outboxFromSqliteRow(row);
      current.leaseOwner = owner;
      current.leaseExpiresAt = leaseExpiresAt(now, leaseMs);
      current.fencingToken = (current.fencingToken ?? 0) + 1;
      current.updatedAt = now;
      db.prepare(
        `UPDATE outbox
         SET lease_owner = ?, lease_expires_at = ?, fencing_token = ?, data = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        current.leaseOwner,
        current.leaseExpiresAt,
        current.fencingToken,
        JSON.stringify(current),
        current.updatedAt,
        current.id,
      );
      return clone(current);
    });
  }

  markSent(message: OutboxMessage, owner: string, sentEventId: string): Promise<void> {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM outbox WHERE id = ?").get(message.id) as
        Row | undefined;
      const current = row ? outboxFromSqliteRow(row) : undefined;
      const now = sqliteTimestamp(db);
      if (
        !current ||
        current.status !== "pending" ||
        current.leaseOwner !== owner ||
        current.fencingToken !== message.fencingToken ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= now
      ) {
        throw new Error(`Stale or expired fencing token for outbox message ${message.id}`);
      }

      current.status = "sent";
      current.sentEventId = sentEventId;
      current.attempts++;
      current.updatedAt = now;
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      delete current.error;
      db.prepare(
        `UPDATE outbox
         SET status = 'sent', lease_owner = NULL, lease_expires_at = NULL,
             data = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(current), current.updatedAt, current.id);
    });
  }

  markFailed(message: OutboxMessage, owner: string, error: string): Promise<void> {
    return this.database.transaction((db) => {
      const row = db.prepare("SELECT * FROM outbox WHERE id = ?").get(message.id) as
        Row | undefined;
      const current = row ? outboxFromSqliteRow(row) : undefined;
      const now = sqliteTimestamp(db);
      if (
        !current ||
        current.status !== "pending" ||
        current.leaseOwner !== owner ||
        current.fencingToken !== message.fencingToken ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= now
      ) {
        throw new Error(`Stale or expired fencing token for outbox message ${message.id}`);
      }

      current.attempts++;
      current.error = error;
      current.updatedAt = now;
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      db.prepare(
        `UPDATE outbox
         SET lease_owner = NULL, lease_expires_at = NULL, data = ?, updated_at = ?
         WHERE id = ?`,
      ).run(JSON.stringify(current), current.updatedAt, current.id);
    });
  }

  getMessage(id: string): Promise<OutboxMessage | undefined> {
    assertIdentifier(id, "outbox message id");
    return this.database.run((db) => {
      const row = db.prepare("SELECT * FROM outbox WHERE id = ?").get(id) as Row | undefined;
      return row ? outboxFromSqliteRow(row) : undefined;
    });
  }

  pendingMessages(): Promise<OutboxMessage[]> {
    return this.database.run((db) =>
      db
        .prepare("SELECT * FROM outbox WHERE status = 'pending' ORDER BY rowid")
        .all()
        .map((row) => outboxFromSqliteRow(row as Row)),
    );
  }

  private readDirect(db: DatabaseSync): OutboxMessage[] {
    return db
      .prepare("SELECT * FROM outbox ORDER BY rowid")
      .all()
      .map((row) => outboxFromSqliteRow(row as Row));
  }

  private writeDirect(db: DatabaseSync, messages: OutboxMessage[]): void {
    db.prepare("DELETE FROM outbox").run();
    const insert = db.prepare(
      `INSERT INTO outbox
       (id, idempotency_key, status, lease_owner, lease_expires_at,
        fencing_token, data, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const message of messages) {
      insert.run(
        message.id,
        message.event.idempotencyKey ?? message.id,
        message.status,
        message.leaseOwner ?? null,
        message.leaseExpiresAt ?? null,
        message.fencingToken ?? 0,
        JSON.stringify(message),
        message.updatedAt,
      );
    }
  }
}

export class SqliteWorkerQueueStore implements WorkerQueueStore {
  constructor(readonly database: SqliteRuntimeDatabase) {}

  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T> {
    return this.database.transaction(async (db) => {
      const jobs = db
        .prepare("SELECT data FROM worker_jobs ORDER BY rowid")
        .all()
        .map((row) => json<WorkerJob>((row as Row).data));
      const result = await fn(jobs);
      db.prepare("DELETE FROM worker_jobs").run();
      const insert = db.prepare(
        `INSERT INTO worker_jobs
         (id, type, idempotency_key, status, lease_owner, lease_expires_at,
          fencing_token, attempts, max_attempts, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const job of jobs) {
        insert.run(
          job.id,
          job.type,
          job.idempotencyKey,
          job.status,
          job.leaseOwner ?? null,
          job.leaseExpiresAt ?? null,
          job.fencingToken ?? 0,
          job.attempts,
          job.maxAttempts,
          JSON.stringify(job),
          job.createdAt,
          job.updatedAt,
        );
      }
      return result;
    });
  }

  enqueueJob(job: WorkerJob): Promise<WorkerJob> {
    return this.database.transaction((db) => this.enqueueDirect(db, job));
  }

  enqueueJobWithQuota(job: WorkerJob, quota: WorkerEnqueueQuota): Promise<WorkerJob> {
    return this.database.transaction((db) => {
      const duplicate = db
        .prepare("SELECT * FROM worker_jobs WHERE idempotency_key = ?")
        .get(job.idempotencyKey) as Row | undefined;
      if (duplicate) return workerFromSqliteRow(duplicate);

      const outstanding = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM worker_jobs
           WHERE status IN ('queued', 'leased', 'cancellation_requested')
             AND json_extract(data, '$.payload.tenantId') = ?`,
        )
        .get(quota.tenantId) as Row;
      if (Number(outstanding.count) >= quota.maxOutstandingPerTenant) {
        throw new WorkerQueueQuotaError("tenant_quota_exceeded", "Tenant execution quota exceeded");
      }

      const actorQueued = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM worker_jobs
           WHERE status = 'queued'
             AND json_extract(data, '$.payload.tenantId') = ?
             AND json_extract(data, '$.payload.actor') = ?`,
        )
        .get(quota.tenantId, quota.actor) as Row;
      if (Number(actorQueued.count) >= quota.maxQueuedPerActor) {
        throw new WorkerQueueQuotaError("actor_queue_full", "Actor execution queue is full");
      }
      return this.enqueueDirect(db, job);
    });
  }

  claimJob(
    owner: string,
    types: string[] | undefined,
    leaseMs: number,
  ): Promise<WorkerJob | undefined> {
    if (types && types.length === 0) return Promise.resolve(undefined);
    return this.database.transaction((db) => {
      const now = sqliteTimestamp(db);
      const expired = db
        .prepare(
          `SELECT * FROM worker_jobs
           WHERE (status = 'cancellation_requested' AND
                  (lease_expires_at IS NULL OR lease_expires_at <= ?))
              OR (status = 'leased' AND
                  (lease_expires_at IS NULL OR lease_expires_at <= ?) AND
                  attempts >= max_attempts)`,
        )
        .all(now, now) as Row[];
      for (const row of expired) {
        const current = workerFromSqliteRow(row);
        current.status = "failed";
        // Capture the pre-transition status; the normalized row remains the source of truth even
        // when an older JSON payload omitted newer worker fields.
        current.error =
          String(row.status) === "cancellation_requested"
            ? "cancellation acknowledgement lease expired; execution outcome indeterminate"
            : "lease expired after maximum attempts";
        current.updatedAt = now;
        delete current.leaseOwner;
        delete current.leaseExpiresAt;
        this.updateDirect(db, current);
      }

      const typeClause = types ? `AND type IN (${types.map(() => "?").join(", ")})` : "";
      const row = db
        .prepare(
          `SELECT * FROM worker_jobs
           WHERE type NOT GLOB '__worktree__:*'
             ${typeClause}
             AND attempts < max_attempts
             AND (status = 'queued' OR
                  (status = 'leased' AND
                   (lease_expires_at IS NULL OR lease_expires_at <= ?)))
           ORDER BY rowid
           LIMIT 1`,
        )
        .get(...(types ?? []), now) as Row | undefined;
      if (!row) return undefined;

      const current = workerFromSqliteRow(row);
      current.status = "leased";
      current.attempts++;
      current.fencingToken = (current.fencingToken ?? 0) + 1;
      current.leaseOwner = owner;
      current.leaseExpiresAt = leaseExpiresAt(now, leaseMs);
      current.updatedAt = now;
      delete current.error;
      this.updateDirect(db, current);
      return clone(current);
    });
  }

  heartbeatJob(
    jobId: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void> {
    return this.database.transaction((db) => {
      const current = this.getDirect(db, jobId);
      if (!current || current.status !== "leased" || current.leaseOwner !== owner) {
        throw new Error(`Cannot heartbeat unowned worker job ${jobId}`);
      }
      if (fencingToken !== undefined && current.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for worker job ${jobId}`);
      }
      const now = sqliteTimestamp(db);
      current.leaseExpiresAt = leaseExpiresAt(now, leaseMs);
      current.updatedAt = now;
      this.updateDirect(db, current);
    });
  }

  finishJob(jobId: string, owner: string, result: unknown, fencingToken?: number): Promise<void> {
    return this.database.transaction((db) => {
      const current = this.ownedJob(db, jobId, owner, "settle", fencingToken);
      current.status = "succeeded";
      current.result = result;
      delete current.error;
      current.updatedAt = sqliteTimestamp(db);
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      this.updateDirect(db, current);
    });
  }

  failJob(
    jobId: string,
    owner: string,
    error: string,
    retry: boolean,
    fencingToken?: number,
  ): Promise<void> {
    return this.database.transaction((db) => {
      const current = this.ownedJob(db, jobId, owner, "fail", fencingToken);
      current.status = retry && current.attempts < current.maxAttempts ? "queued" : "failed";
      current.error = error;
      current.updatedAt = sqliteTimestamp(db);
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      this.updateDirect(db, current);
    });
  }

  requestCancellationJob(jobId: string): Promise<WorkerCancellationResult> {
    return this.database.transaction((db) => {
      const current = this.getDirect(db, jobId);
      if (!current || current.status === "succeeded" || current.status === "failed") {
        return "not_cancellable";
      }
      if (current.status === "cancelled") return "cancelled";
      if (current.status === "cancellation_requested") return "cancellation_requested";
      current.updatedAt = sqliteTimestamp(db);
      if (current.status === "leased") {
        current.status = "cancellation_requested";
        this.updateDirect(db, current);
        return "cancellation_requested";
      }
      current.status = "cancelled";
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      this.updateDirect(db, current);
      return "cancelled";
    });
  }

  acknowledgeCancellationJob(jobId: string, owner: string, fencingToken?: number): Promise<void> {
    return this.database.transaction((db) => {
      const current = this.getDirect(db, jobId);
      if (!current || current.status !== "cancellation_requested" || current.leaseOwner !== owner) {
        throw new Error(`Cannot acknowledge unowned worker job cancellation ${jobId}`);
      }
      if (fencingToken !== undefined && current.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for worker job ${jobId}`);
      }
      current.status = "cancelled";
      current.updatedAt = sqliteTimestamp(db);
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      this.updateDirect(db, current);
    });
  }

  listJobs(): Promise<WorkerJob[]> {
    return this.database.run((db) =>
      db
        .prepare("SELECT * FROM worker_jobs WHERE type NOT GLOB '__worktree__:*' ORDER BY rowid")
        .all()
        .map((row) => workerFromSqliteRow(row as Row)),
    );
  }

  get(jobId: string): Promise<WorkerJob | undefined> {
    return this.database.run((db) => this.getDirect(db, jobId));
  }

  acquireWorktree(worktree: string, owner: string, leaseMs: number): Promise<WorktreeLease> {
    return this.database.transaction((db) => {
      const type = `__worktree__:${path.resolve(worktree)}`;
      const row = db.prepare("SELECT * FROM worker_jobs WHERE type = ?").get(type) as
        Row | undefined;
      const now = sqliteTimestamp(db);
      const current = row ? workerFromSqliteRow(row) : undefined;
      if (
        current?.status === "leased" &&
        current.leaseOwner !== owner &&
        current.leaseExpiresAt &&
        current.leaseExpiresAt > now
      ) {
        throw new Error(`Worktree is owned by ${current.leaseOwner}: ${worktree}`);
      }
      const resolved = path.resolve(worktree);
      const expiresAt = leaseExpiresAt(now, leaseMs);
      const fencingToken = (current?.fencingToken ?? 0) + 1;
      if (current) {
        current.status = "leased";
        current.leaseOwner = owner;
        current.leaseExpiresAt = expiresAt;
        current.fencingToken = fencingToken;
        current.updatedAt = now;
        this.updateDirect(db, current);
      } else {
        const created: WorkerJob = {
          id: `wt_${randomUUID().replace(/-/g, "")}`,
          type,
          payload: { worktree: resolved },
          status: "leased",
          idempotencyKey: type,
          attempts: 1,
          maxAttempts: Number.MAX_SAFE_INTEGER,
          createdAt: now,
          updatedAt: now,
          leaseOwner: owner,
          leaseExpiresAt: expiresAt,
          fencingToken,
        };
        this.insertDirect(db, created);
      }
      return { worktree: resolved, owner, expiresAt, fencingToken };
    });
  }

  heartbeatWorktree(
    worktree: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void> {
    return this.database.transaction((db) => {
      const type = `__worktree__:${path.resolve(worktree)}`;
      const row = db.prepare("SELECT * FROM worker_jobs WHERE type = ?").get(type) as
        Row | undefined;
      const current = row ? workerFromSqliteRow(row) : undefined;
      const now = sqliteTimestamp(db);
      if (
        !current ||
        current.status !== "leased" ||
        current.leaseOwner !== owner ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= now
      ) {
        throw new Error(`Cannot heartbeat unowned worktree: ${worktree}`);
      }
      if (fencingToken !== undefined && current.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for worktree: ${worktree}`);
      }
      current.leaseExpiresAt = leaseExpiresAt(now, leaseMs);
      current.updatedAt = now;
      this.updateDirect(db, current);
    });
  }

  releaseWorktree(worktree: string, owner: string, fencingToken?: number): Promise<void> {
    return this.database.transaction((db) => {
      const type = `__worktree__:${path.resolve(worktree)}`;
      const row = db.prepare("SELECT * FROM worker_jobs WHERE type = ?").get(type) as
        Row | undefined;
      const current = row ? workerFromSqliteRow(row) : undefined;
      if (!current || current.leaseOwner !== owner) {
        throw new Error(`Cannot release unowned worktree: ${worktree}`);
      }
      if (fencingToken !== undefined && current.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for worktree: ${worktree}`);
      }
      current.status = "succeeded";
      current.updatedAt = sqliteTimestamp(db);
      delete current.leaseOwner;
      delete current.leaseExpiresAt;
      this.updateDirect(db, current);
    });
  }

  private enqueueDirect(db: DatabaseSync, job: WorkerJob): WorkerJob {
    const inserted = this.insertDirect(db, job, true);
    if (inserted) return clone(job);
    const duplicate = db
      .prepare("SELECT * FROM worker_jobs WHERE idempotency_key = ?")
      .get(job.idempotencyKey) as Row | undefined;
    if (!duplicate) throw new Error("Worker job idempotency conflict disappeared");
    return workerFromSqliteRow(duplicate);
  }

  private insertDirect(db: DatabaseSync, job: WorkerJob, ignoreConflict = false): boolean {
    const result = db
      .prepare(
        `INSERT INTO worker_jobs
         (id, type, idempotency_key, status, lease_owner, lease_expires_at,
          fencing_token, attempts, max_attempts, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ${ignoreConflict ? "ON CONFLICT(idempotency_key) DO NOTHING" : ""}`,
      )
      .run(
        job.id,
        job.type,
        job.idempotencyKey,
        job.status,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.fencingToken ?? 0,
        job.attempts,
        job.maxAttempts,
        JSON.stringify(job),
        job.createdAt,
        job.updatedAt,
      );
    return Number(result.changes) === 1;
  }

  private updateDirect(db: DatabaseSync, job: WorkerJob): void {
    const result = db
      .prepare(
        `UPDATE worker_jobs
         SET type = ?, idempotency_key = ?, status = ?, lease_owner = ?,
             lease_expires_at = ?, fencing_token = ?, attempts = ?, max_attempts = ?,
             data = ?, created_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        job.type,
        job.idempotencyKey,
        job.status,
        job.leaseOwner ?? null,
        job.leaseExpiresAt ?? null,
        job.fencingToken ?? 0,
        job.attempts,
        job.maxAttempts,
        JSON.stringify(job),
        job.createdAt,
        job.updatedAt,
        job.id,
      );
    if (Number(result.changes) !== 1) throw new Error(`Unknown worker job ${job.id}`);
  }

  private getDirect(db: DatabaseSync, jobId: string): WorkerJob | undefined {
    const row = db.prepare("SELECT * FROM worker_jobs WHERE id = ?").get(jobId) as Row | undefined;
    return row ? workerFromSqliteRow(row) : undefined;
  }

  private ownedJob(
    db: DatabaseSync,
    jobId: string,
    owner: string,
    action: "settle" | "fail",
    fencingToken?: number,
  ): WorkerJob {
    const current = this.getDirect(db, jobId);
    if (!current || current.status !== "leased" || current.leaseOwner !== owner) {
      throw new Error(`Cannot ${action} unowned worker job ${jobId}`);
    }
    if (fencingToken !== undefined && current.fencingToken !== fencingToken) {
      throw new Error(`Stale fencing token for worker job ${jobId}`);
    }
    return current;
  }
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

function artifactFor(input: ArtifactInput, data: Uint8Array): Artifact {
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

export class SqliteArtifactStore implements ArtifactStore {
  constructor(readonly database: SqliteRuntimeDatabase) {}

  put(input: ArtifactInput): Promise<Artifact> {
    const data = bytes(input.data);
    const artifact = artifactFor(input, data);
    return this.database.transaction((db) => {
      const existing = db
        .prepare("SELECT metadata FROM artifacts WHERE session_id = ? AND id = ?")
        .get(artifact.sessionId, artifact.id) as Row | undefined;
      if (existing) return json<Artifact>(existing.metadata);
      db.prepare(
        `INSERT INTO artifacts(session_id, id, sha256, metadata, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        artifact.sessionId,
        artifact.id,
        artifact.sha256,
        JSON.stringify(artifact),
        data,
        artifact.createdAt,
      );
      return clone(artifact);
    });
  }

  list(sessionId: string): Promise<Artifact[]> {
    assertIdentifier(sessionId, "session id");
    return this.database.run((db) =>
      db
        .prepare("SELECT metadata FROM artifacts WHERE session_id = ? ORDER BY created_at")
        .all(sessionId)
        .map((row) => json<Artifact>((row as Row).metadata)),
    );
  }

  get(sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined> {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(artifactId, "artifact id");
    return this.database.run((db) => {
      const row = db
        .prepare("SELECT metadata, data FROM artifacts WHERE session_id = ? AND id = ?")
        .get(sessionId, artifactId) as Row | undefined;
      if (!row) return undefined;
      return {
        artifact: json<Artifact>(row.metadata),
        data: new Uint8Array(row.data as Uint8Array),
      };
    });
  }

  async delete(sessionId: string, artifactId: string): Promise<boolean> {
    assertIdentifier(sessionId, "session id");
    assertIdentifier(artifactId, "artifact id");
    return this.database.transaction((db) => {
      const result = db
        .prepare("DELETE FROM artifacts WHERE session_id = ? AND id = ?")
        .run(sessionId, artifactId);
      return Number(result.changes) > 0;
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    assertIdentifier(sessionId, "session id");
    await this.database.transaction((db) => {
      db.prepare("DELETE FROM artifacts WHERE session_id = ?").run(sessionId);
    });
  }
}
