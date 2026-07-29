/** 持久向量库：本地 SQLite exact search；共享部署使用 PostgreSQL + pgvector HNSW。 */

import { chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Pool } from "pg";

export interface VectorRecord {
  namespace: string;
  id: string;
  embedding: number[];
  content: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchHit {
  id: string;
  score: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  search(namespace: string, embedding: number[], limit?: number): Promise<VectorSearchHit[]>;
  deleteExcept(namespace: string, ids: Set<string>): Promise<number>;
  close?(): void | Promise<void>;
}

function valid(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function vectorBytes(vector: number[]): Uint8Array {
  const values = Float32Array.from(vector);
  return new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
}

function decodeVector(bytes: Uint8Array): number[] {
  const copy = Uint8Array.from(bytes);
  return [...new Float32Array(copy.buffer)];
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index]! * b[index]!;
    aa += a[index]! * a[index]!;
    bb += b[index]! * b[index]!;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export class SqliteVectorStore implements VectorStore {
  private readonly db: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly file: string) {
    const absolute = path.resolve(file);
    mkdirSync(path.dirname(absolute), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(absolute);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 10000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS code_vectors (
        namespace TEXT NOT NULL,
        id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        embedding BLOB NOT NULL,
        content TEXT NOT NULL,
        metadata TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(namespace, id)
      );
      CREATE INDEX IF NOT EXISTS idx_code_vectors_namespace ON code_vectors(namespace);
    `);
    chmodSync(absolute, 0o600);
  }

  private run<T>(work: () => T | Promise<T>): Promise<T> {
    const current = this.tail.catch(() => undefined).then(work);
    this.tail = current;
    return current;
  }

  upsert(records: VectorRecord[]): Promise<void> {
    return this.run(() => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const statement = this.db.prepare(
          `INSERT INTO code_vectors
           (namespace, id, dimensions, embedding, content, metadata, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(namespace, id) DO UPDATE SET
             dimensions = excluded.dimensions, embedding = excluded.embedding,
             content = excluded.content, metadata = excluded.metadata, updated_at = excluded.updated_at`,
        );
        for (const record of records) {
          statement.run(
            valid(record.namespace, "vector namespace"),
            valid(record.id, "vector id"),
            record.embedding.length,
            vectorBytes(record.embedding),
            record.content,
            JSON.stringify(record.metadata ?? {}),
            new Date().toISOString(),
          );
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  search(namespace: string, embedding: number[], limit = 20): Promise<VectorSearchHit[]> {
    return this.run(() =>
      this.db
        .prepare(
          "SELECT id, embedding, content, metadata FROM code_vectors WHERE namespace = ? AND dimensions = ?",
        )
        .all(valid(namespace, "vector namespace"), embedding.length)
        .map((row) => {
          const value = row as Record<string, unknown>;
          return {
            id: String(value.id),
            score: cosine(embedding, decodeVector(value.embedding as Uint8Array)),
            content: String(value.content),
            metadata: JSON.parse(String(value.metadata)) as Record<string, unknown>,
          };
        })
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
        .slice(0, Math.max(1, limit)),
    );
  }

  deleteExcept(namespace: string, ids: Set<string>): Promise<number> {
    return this.run(() => {
      const rows = this.db
        .prepare("SELECT id FROM code_vectors WHERE namespace = ?")
        .all(valid(namespace, "vector namespace"));
      const remove = rows
        .map((row) => String((row as Record<string, unknown>).id))
        .filter((id) => !ids.has(id));
      const statement = this.db.prepare("DELETE FROM code_vectors WHERE namespace = ? AND id = ?");
      for (const id of remove) statement.run(namespace, id);
      return remove.length;
    });
  }

  close(): void {
    this.db.close();
  }
}

export class PostgresVectorStore implements VectorStore {
  private constructor(
    readonly pool: Pool,
    readonly dimensions: number,
  ) {}

  static async open(pool: Pool, dimensions: number): Promise<PostgresVectorStore> {
    if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 4_000) {
      throw new Error("pgvector dimensions must be between 1 and 4000");
    }
    await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
    await pool.query(`
      CREATE TABLE IF NOT EXISTS anicode_code_vectors (
        namespace text NOT NULL,
        id text NOT NULL,
        embedding vector(${dimensions}) NOT NULL,
        content text NOT NULL,
        metadata jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY(namespace, id)
      )
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_anicode_vectors_hnsw
       ON anicode_code_vectors USING hnsw (embedding vector_cosine_ops)`,
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS idx_anicode_vectors_namespace ON anicode_code_vectors(namespace)",
    );
    return new PostgresVectorStore(pool, dimensions);
  }

  async upsert(records: VectorRecord[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const record of records) {
        if (record.embedding.length !== this.dimensions)
          throw new Error("Vector dimension mismatch");
        await client.query(
          `INSERT INTO anicode_code_vectors(namespace, id, embedding, content, metadata)
           VALUES ($1, $2, $3::vector, $4, $5::jsonb)
           ON CONFLICT(namespace, id) DO UPDATE SET
             embedding = excluded.embedding, content = excluded.content,
             metadata = excluded.metadata, updated_at = now()`,
          [
            valid(record.namespace, "vector namespace"),
            valid(record.id, "vector id"),
            `[${record.embedding.join(",")}]`,
            record.content,
            JSON.stringify(record.metadata ?? {}),
          ],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async search(namespace: string, embedding: number[], limit = 20): Promise<VectorSearchHit[]> {
    if (embedding.length !== this.dimensions) throw new Error("Vector dimension mismatch");
    const result = await this.pool.query(
      `SELECT id, content, metadata, 1 - (embedding <=> $2::vector) AS score
       FROM anicode_code_vectors WHERE namespace = $1
       ORDER BY embedding <=> $2::vector LIMIT $3`,
      [valid(namespace, "vector namespace"), `[${embedding.join(",")}]`, Math.max(1, limit)],
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      score: Number(row.score),
      content: String(row.content),
      metadata: row.metadata as Record<string, unknown>,
    }));
  }

  async deleteExcept(namespace: string, ids: Set<string>): Promise<number> {
    if (ids.size === 0) {
      const result = await this.pool.query(
        "DELETE FROM anicode_code_vectors WHERE namespace = $1",
        [namespace],
      );
      return result.rowCount ?? 0;
    }
    const result = await this.pool.query(
      "DELETE FROM anicode_code_vectors WHERE namespace = $1 AND NOT (id = ANY($2::text[]))",
      [namespace, [...ids]],
    );
    return result.rowCount ?? 0;
  }
}

/** 无外部模型时的确定性 feature-hashing embedding，便于离线图检索。 */
export function localCodeEmbedding(text: string, dimensions = 384): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  const tokens =
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .match(/[a-z_$][\w$]*|[\p{L}\p{N}_]+/gu) ?? [];
  for (const token of tokens) {
    let hash = 2166136261;
    for (let index = 0; index < token.length; index++) {
      hash ^= token.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    const bucket = Math.abs(hash) % dimensions;
    vector[bucket] = vector[bucket]! + (hash < 0 ? -1 : 1);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm ? vector.map((value) => value / norm) : vector;
}
