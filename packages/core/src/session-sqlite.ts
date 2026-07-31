/**
 * SQLite 会话持久化（对齐 opencode 的存储演进方向：JSON 文件 → SQLite 单库）。
 *
 * 用 Node 内置的 `node:sqlite`（无第三方依赖、无原生编译，契合 core 的零依赖原则），
 * 与 JSONL 的 `SessionStore` 实现同一个 `ISessionStore` 接口，可直接替换。
 *
 * 设计取舍：
 *   - 仍以 core 规范化的 `ChatMessage` 为消息载体（不拆 provider 原生形状），
 *     与 JSONL 完全等价，便于两种后端互相导入/迁移。
 *   - `node:sqlite` 是同步 API（DatabaseSync）；同步 SQLite 在 Node 生态是常规做法
 *     （对齐 better-sqlite3 心智），方法体同步执行、以 Promise 包装满足接口。
 *   - 该模块**不在** index 顶层静态 import `node:sqlite`：老版本 Node（无该内置模块或
 *     需 --experimental-sqlite）下仅 `import` 本文件不会触发加载，只有调用 `open()`
 *     才动态 import；不可用时抛清晰错误，调用方（及测试）据此回退/跳过。
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { t } from "./i18n.js";
import type { ChatMessage } from "./types.js";
import {
  assertSessionId,
  type ISessionStore,
  type SessionData,
  type SessionMeta,
} from "./session.js";

/** node:sqlite 的最小结构类型（避免依赖其类型定义在旧 Node 上缺失）。 */
interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

function defaultDbPath(): string {
  return path.join(os.homedir(), ".anicode", "sessions.db");
}

/** node:sqlite 是否可用（动态探测，供测试 skip）。 */
export async function sqliteAvailable(): Promise<boolean> {
  try {
    const mod = (await import("node:sqlite")) as { DatabaseSync?: unknown };
    return typeof mod.DatabaseSync === "function";
  } catch {
    return false;
  }
}

export class SqliteSessionStore implements ISessionStore {
  private constructor(
    private db: SqliteDatabase,
    private dbPath: string,
  ) {}

  /**
   * 打开（或创建）一个 SQLite 会话库。node:sqlite 不可用时抛错，调用方应回退到
   * JSONL `SessionStore`。
   */
  static async open(dbPath?: string): Promise<SqliteSessionStore> {
    let DatabaseSync: new (p: string) => SqliteDatabase;
    try {
      const mod = (await import("node:sqlite")) as {
        DatabaseSync: new (p: string) => SqliteDatabase;
      };
      DatabaseSync = mod.DatabaseSync;
    } catch {
      throw new Error(
        t(
          "node:sqlite is unavailable in this runtime; fall back to the JSONL SessionStore",
          "当前运行时不支持 node:sqlite，请回退到 JSONL SessionStore",
        ),
      );
    }
    const file = dbPath ?? defaultDbPath();
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(file);
    // WAL 提升并发读写；外键级联让删除会话自动清消息。
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        cwd        TEXT NOT NULL,
        model      TEXT NOT NULL,
        title      TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        idx        INTEGER NOT NULL,
        data       TEXT NOT NULL,
        PRIMARY KEY (session_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at DESC);
    `);
    await fs.chmod(file, 0o600).catch(() => {});
    return new SqliteSessionStore(db, file);
  }

  async create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    assertSessionId(meta.id);
    const now = new Date().toISOString();
    const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
    try {
      this.db
        .prepare(
          "INSERT INTO sessions (id, created_at, updated_at, cwd, model, title) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(full.id, full.createdAt, full.updatedAt, full.cwd, full.model, full.title ?? null);
    } catch (err) {
      throw new Error(
        t(`Session ${meta.id} already exists`, `会话 ${meta.id} 已存在`) +
          `: ${(err as Error).message}`,
        { cause: err },
      );
    }
    return full;
  }

  async append(id: string, message: ChatMessage): Promise<void> {
    assertSessionId(id);
    const row = this.db.prepare("SELECT MAX(idx) AS n FROM messages WHERE session_id = ?").get(id);
    const next = typeof row?.n === "number" ? row.n + 1 : 0;
    this.db
      .prepare("INSERT INTO messages (session_id, idx, data) VALUES (?, ?, ?)")
      .run(id, next, JSON.stringify(message));
    this.db
      .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  async rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    assertSessionId(meta.id);
    const updated: SessionMeta = { ...meta, updatedAt: new Date().toISOString() };
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          "INSERT INTO sessions (id, created_at, updated_at, cwd, model, title) VALUES (?, ?, ?, ?, ?, ?) " +
            "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, cwd = excluded.cwd, model = excluded.model, title = excluded.title",
        )
        .run(
          updated.id,
          updated.createdAt,
          updated.updatedAt,
          updated.cwd,
          updated.model,
          updated.title ?? null,
        );
      this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(meta.id);
      const insert = this.db.prepare(
        "INSERT INTO messages (session_id, idx, data) VALUES (?, ?, ?)",
      );
      messages.forEach((m, i) => insert.run(meta.id, i, JSON.stringify(m)));
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    // 与 live meta 共享对象：成功后同步更新时间。
    meta.updatedAt = updated.updatedAt;
  }

  async load(id: string): Promise<SessionData> {
    assertSessionId(id);
    const meta = this.db
      .prepare("SELECT id, created_at, updated_at, cwd, model, title FROM sessions WHERE id = ?")
      .get(id);
    if (!meta) throw new Error(t(`Session ${id} not found`, `会话 ${id} 不存在`));
    const rows = this.db
      .prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY idx ASC")
      .all(id);
    return {
      ...rowToMeta(meta),
      messages: rows.map((r) => JSON.parse(String(r.data)) as ChatMessage),
    };
  }

  async list(): Promise<SessionMeta[]> {
    const rows = this.db
      .prepare(
        "SELECT id, created_at, updated_at, cwd, model, title FROM sessions ORDER BY updated_at DESC",
      )
      .all();
    return rows.map(rowToMeta);
  }

  async delete(id: string): Promise<void> {
    assertSessionId(id);
    // 外键 ON DELETE CASCADE 会连带删除 messages。
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }

  /** 关闭底层数据库句柄（进程退出前调用）。 */
  close(): void {
    this.db.close();
  }

  /** 从一个 ISessionStore 全量迁移会话进本库（幂等：已存在的会话跳过）。 */
  async importFrom(source: ISessionStore): Promise<number> {
    const existing = new Set((await this.list()).map((m) => m.id));
    let imported = 0;
    for (const meta of await source.list()) {
      if (existing.has(meta.id)) continue;
      const data = await source.load(meta.id);
      await this.create({
        id: meta.id,
        cwd: meta.cwd,
        model: meta.model,
        ...(meta.title ? { title: meta.title } : {}),
      });
      await this.rewrite({ ...meta }, data.messages);
      imported++;
    }
    return imported;
  }
}

function rowToMeta(row: Record<string, unknown>): SessionMeta {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    cwd: String(row.cwd),
    model: String(row.model),
    ...(row.title != null ? { title: String(row.title) } : {}),
  };
}
