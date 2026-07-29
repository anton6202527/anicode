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
import type { WorkerJob, WorkerQueueStore } from "./worker.js";

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

export class PostgresRuntimeDatabase {
  readonly pool: Pool;

  private constructor(config: PoolConfig) {
    this.pool = new Pool(config);
  }

  static async open(config: string | PoolConfig): Promise<PostgresRuntimeDatabase> {
    const database = new PostgresRuntimeDatabase(
      typeof config === "string" ? { connectionString: config } : config,
    );
    await database.migrate();
    return database;
  }

  private async migrate(): Promise<void> {
    await this.pool.query(`
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

      CREATE TABLE IF NOT EXISTS anicode_schema_migrations (
        version integer PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO anicode_schema_migrations(version) VALUES (1)
        ON CONFLICT(version) DO NOTHING;
    `);
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

export class PostgresRuntimeEventStore implements RuntimeEventStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}

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
        `INSERT INTO anicode_sessions(id, created_at, updated_at, cwd, model, title)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [full.id, full.createdAt, full.updatedAt, full.cwd, full.model, full.title ?? null],
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
        `INSERT INTO anicode_sessions(id, created_at, updated_at, cwd, model, title)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT(id) DO UPDATE SET
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           cwd = excluded.cwd,
           model = excluded.model,
           title = excluded.title`,
        [meta.id, meta.createdAt, timestamp, meta.cwd, meta.model, meta.title ?? null],
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

export class PostgresCommandInboxStore implements CommandInboxStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}
  read(sessionId: string): Promise<DurableCommand[]> {
    return this.database.readDocument("commands", sessionId, []);
  }
  async write(sessionId: string, commands: DurableCommand[]): Promise<void> {
    await this.transact(sessionId, (current) =>
      current.splice(0, current.length, ...clone(commands)),
    );
  }
  transact<T>(sessionId: string, fn: (commands: DurableCommand[]) => T | Promise<T>): Promise<T> {
    assertIdentifier(sessionId, "command session id");
    return this.database.documentTransaction("commands", sessionId, [], (document) =>
      fn(document as DurableCommand[]),
    );
  }
  async listSessions(): Promise<string[]> {
    const result = await this.database.pool.query(
      "SELECT key FROM anicode_documents WHERE namespace = 'commands' ORDER BY key",
    );
    return result.rows.map((row) => String((row as Row).key));
  }
}

export class PostgresOutboxStore implements OutboxStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}
  read(): Promise<OutboxMessage[]> {
    return this.database.readDocument("outbox", "global", []);
  }
  async write(messages: OutboxMessage[]): Promise<void> {
    await this.transact((current) => current.splice(0, current.length, ...clone(messages)));
  }
  transact<T>(fn: (messages: OutboxMessage[]) => T | Promise<T>): Promise<T> {
    return this.database.documentTransaction("outbox", "global", [], (document) =>
      fn(document as OutboxMessage[]),
    );
  }
}

export class PostgresWorkerQueueStore implements WorkerQueueStore {
  constructor(readonly database: PostgresRuntimeDatabase) {}
  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T> {
    return this.database.documentTransaction("worker", "global", [], (document) =>
      fn(document as WorkerJob[]),
    );
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
}
