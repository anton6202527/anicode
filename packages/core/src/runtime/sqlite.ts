/**
 * 生产默认持久化：一个 SQLite WAL 数据库承载 Runtime、inbox/outbox、worker、
 * snapshot、artifact 与安全审计。所有 read-modify-write 都在 BEGIN IMMEDIATE 中完成，
 * 多进程争用由 SQLite busy_timeout 协调，不再依赖 JSON 文件锁。
 */

import { randomUUID, createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import type { WorkerJob, WorkerQueueStore } from "./worker.js";

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

const SQLITE_MIGRATIONS = [
  { version: 1, description: "initial durable runtime schema", sql: RUNTIME_SCHEMA_V1 },
  { version: 2, description: "retention and compaction indexes", sql: RUNTIME_SCHEMA_V2 },
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

function json<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

function clone<T>(value: T): T {
  return structuredClone(value);
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

  db.exec("BEGIN IMMEDIATE");
  try {
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

  constructor(file: string) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 10000");
    try {
      migrateDatabase(this.db);
      chmodSync(this.file, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  run<T>(work: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("SQLite runtime database is closed"));
    const previous = SQLITE_FILE_TAILS.get(this.file) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(() => work(this.db));
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
      db.exec("BEGIN IMMEDIATE");
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
    await this.run((db) => {
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
  prune(
    policy: SqliteRetentionPolicy = {},
    now: number = Date.now(),
  ): Promise<SqlitePruneResult> {
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
            "DELETE FROM worker_jobs WHERE status IN ('succeeded', 'failed', 'cancelled') AND updated_at < ?",
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

  async close(): Promise<void> {
    await this.tail.catch(() => undefined);
    if (this.closed) return;
    this.closed = true;
    this.db.close();
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
  constructor(readonly database: SqliteRuntimeDatabase) {}

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
           sequence = excluded.sequence, data = excluded.data, updated_at = excluded.updated_at`,
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
    model: String(row.model),
    ...(row.title != null ? { title: String(row.title) } : {}),
  };
}

/**
 * 生产会话存储：与 event/inbox/outbox 共用同一个 WAL 数据库。
 * append/rewrite 均走 BEGIN IMMEDIATE，跨进程追加不会复用 message index。
 */
export class SqliteRuntimeSessionStore implements ISessionStore {
  constructor(readonly database: SqliteRuntimeDatabase) {}

  create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    assertIdentifier(meta.id, "session id");
    return this.database.transaction((db) => {
      const now = new Date().toISOString();
      const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
      db.prepare(
        `INSERT INTO sessions(id, created_at, updated_at, cwd, model, title)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(full.id, full.createdAt, full.updatedAt, full.cwd, full.model, full.title ?? null);
      return full;
    });
  }

  append(id: string, message: ChatMessage): Promise<void> {
    assertIdentifier(id, "session id");
    return this.database.transaction((db) => {
      const session = db.prepare("SELECT id FROM sessions WHERE id = ?").get(id);
      if (!session) throw new Error(`Session ${id} not found`);
      const row = db
        .prepare(
          "SELECT COALESCE(MAX(idx), -1) + 1 AS next_idx FROM session_messages WHERE session_id = ?",
        )
        .get(id) as Row;
      db.prepare("INSERT INTO session_messages(session_id, idx, data) VALUES (?, ?, ?)").run(
        id,
        Number(row.next_idx),
        JSON.stringify(message),
      );
      db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(
        new Date().toISOString(),
        id,
      );
    });
  }

  rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    assertIdentifier(meta.id, "session id");
    return this.database.transaction((db) => {
      const updatedAt = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions(id, created_at, updated_at, cwd, model, title)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           cwd = excluded.cwd,
           model = excluded.model,
           title = excluded.title`,
      ).run(meta.id, meta.createdAt, updatedAt, meta.cwd, meta.model, meta.title ?? null);
      db.prepare("DELETE FROM session_messages WHERE session_id = ?").run(meta.id);
      const insert = db.prepare(
        "INSERT INTO session_messages(session_id, idx, data) VALUES (?, ?, ?)",
      );
      messages.forEach((message, index) => insert.run(meta.id, index, JSON.stringify(message)));
      meta.updatedAt = updatedAt;
    });
  }

  load(id: string): Promise<SessionData> {
    assertIdentifier(id, "session id");
    return this.database.run((db) => {
      const row = db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
      if (!row) throw new Error(`Session ${id} not found`);
      return {
        ...sessionMetaFromRow(row),
        messages: db
          .prepare("SELECT data FROM session_messages WHERE session_id = ? ORDER BY idx")
          .all(id)
          .map((item) => json<ChatMessage>((item as Row).data)),
      };
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
  constructor(readonly database: SqliteRuntimeDatabase) {}

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

  private readDirect(db: DatabaseSync, sessionId: string): DurableCommand[] {
    return db
      .prepare("SELECT data FROM commands WHERE session_id = ? ORDER BY rowid")
      .all(sessionId)
      .map((row) => json<DurableCommand>((row as Row).data));
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
  constructor(readonly database: SqliteRuntimeDatabase) {}

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

  private readDirect(db: DatabaseSync): OutboxMessage[] {
    return db
      .prepare("SELECT data FROM outbox ORDER BY rowid")
      .all()
      .map((row) => json<OutboxMessage>((row as Row).data));
  }

  private writeDirect(db: DatabaseSync, messages: OutboxMessage[]): void {
    db.prepare("DELETE FROM outbox").run();
    const insert = db.prepare(
      `INSERT INTO outbox(id, idempotency_key, status, data, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const message of messages) {
      insert.run(
        message.id,
        message.event.idempotencyKey ?? message.id,
        message.status,
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
          fencing_token, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          JSON.stringify(job),
          job.createdAt,
          job.updatedAt,
        );
      }
      return result;
    });
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
}
