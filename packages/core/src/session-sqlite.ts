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

const SQLITE_PRIVATE_MODE = 0o600;

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
  readonly storageSemantics = "transactional-primary" as const;
  private operationTail: Promise<void> = Promise.resolve();
  private closed = false;
  private closeTask?: Promise<void>;

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
    const requestedFile = dbPath ?? defaultDbPath();
    const inMemory = requestedFile === ":memory:";
    // DatabaseSync resolves relative paths only when it opens the handle. Persisting that relative
    // spelling would make later permission checks follow a changed process.cwd() to another file.
    const file = inMemory ? requestedFile : path.resolve(requestedFile);
    if (!inMemory) {
      const directory = path.dirname(file);
      await ensureDatabaseParent(directory, dbPath === undefined);
      await preparePrivateDatabaseFile(file);
    }

    const db = new DatabaseSync(file);
    try {
      // Bound lock contention rather than failing immediately under a second local process. FULL
      // synchronous WAL commits trade a little latency for crash-safe acknowledged transcripts.
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA foreign_keys = ON");
      // Serialize schema discovery + ALTER across processes. Without one write transaction, two
      // old-database openers can both observe a missing column and the loser fails with duplicate.
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE IF NOT EXISTS sessions (
            id         TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            cwd        TEXT NOT NULL,
            workspace_device TEXT,
            workspace_inode  TEXT,
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
        const sessionColumns = new Set(
          db
            .prepare("PRAGMA table_info(sessions)")
            .all()
            .map((row) => String(row.name)),
        );
        if (!sessionColumns.has("workspace_device")) {
          db.exec("ALTER TABLE sessions ADD COLUMN workspace_device TEXT");
        }
        if (!sessionColumns.has("workspace_inode")) {
          db.exec("ALTER TABLE sessions ADD COLUMN workspace_inode TEXT");
        }
        db.exec("COMMIT");
      } catch (error) {
        rollback(db);
        throw error;
      }
      const integrity = db.prepare("PRAGMA quick_check(1)").get();
      if (integrity && String(integrity.quick_check) !== "ok") {
        throw new Error(
          `SQLite session database integrity check failed: ${String(integrity.quick_check)}`,
        );
      }
      if (!inMemory) await secureDatabaseFiles(file);
      return new SqliteSessionStore(db, file);
    } catch (error) {
      try {
        db.close();
      } catch {
        // Preserve the initialization error; SQLite may already have invalidated the handle.
      }
      throw error;
    }
  }

  private enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new Error(t("SQLite session store is closed", "SQLite 会话存储已关闭")),
      );
    }
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async secureFiles(): Promise<void> {
    if (this.dbPath !== ":memory:") await secureDatabaseFiles(this.dbPath);
  }

  create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    return this.enqueue(async () => {
      assertSessionId(meta.id);
      const now = new Date().toISOString();
      const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
      const result = this.db
        .prepare(
          "INSERT OR IGNORE INTO sessions (id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          full.id,
          full.createdAt,
          full.updatedAt,
          full.cwd,
          full.workspaceIdentity?.device ?? null,
          full.workspaceIdentity?.inode ?? null,
          full.model,
          full.title ?? null,
        );
      if (Number(result.changes) !== 1) {
        throw new Error(t(`Session ${meta.id} already exists`, `会话 ${meta.id} 已存在`));
      }
      await this.secureFiles();
      return full;
    });
  }

  append(id: string, message: ChatMessage): Promise<void> {
    return this.enqueue(async () => {
      assertSessionId(id);
      const serialized = JSON.stringify(message);
      if (serialized === undefined)
        throw new Error(t("Cannot serialize session message", "无法序列化会话消息"));
      this.db.exec("BEGIN IMMEDIATE");
      try {
        // Computing the index inside the INSERT keeps it atomic across multiple processes.
        this.db
          .prepare(
            "INSERT INTO messages (session_id, idx, data) " +
              "SELECT ?, COALESCE(MAX(idx) + 1, 0), ? FROM messages WHERE session_id = ?",
          )
          .run(id, serialized, id);
        this.db
          .prepare("UPDATE sessions SET updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), id);
        this.db.exec("COMMIT");
      } catch (error) {
        rollback(this.db);
        throw error;
      }
      await this.secureFiles();
    });
  }

  rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    return this.enqueue(async () => {
      assertSessionId(meta.id);
      const updated: SessionMeta = { ...meta, updatedAt: new Date().toISOString() };
      const serialized = messages.map((message) => {
        const value = JSON.stringify(message);
        if (value === undefined)
          throw new Error(t("Cannot serialize session message", "无法序列化会话消息"));
        return value;
      });
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db
          .prepare(
            "INSERT INTO sessions (id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
              "ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, cwd = excluded.cwd, workspace_device = excluded.workspace_device, workspace_inode = excluded.workspace_inode, model = excluded.model, title = excluded.title",
          )
          .run(
            updated.id,
            updated.createdAt,
            updated.updatedAt,
            updated.cwd,
            updated.workspaceIdentity?.device ?? null,
            updated.workspaceIdentity?.inode ?? null,
            updated.model,
            updated.title ?? null,
          );
        this.db.prepare("DELETE FROM messages WHERE session_id = ?").run(meta.id);
        const insert = this.db.prepare(
          "INSERT INTO messages (session_id, idx, data) VALUES (?, ?, ?)",
        );
        serialized.forEach((data, index) => insert.run(meta.id, index, data));
        this.db.exec("COMMIT");
      } catch (err) {
        rollback(this.db);
        throw err;
      }
      await this.secureFiles();
      // 与 live meta 共享对象：成功后同步更新时间。
      meta.updatedAt = updated.updatedAt;
    });
  }

  load(id: string): Promise<SessionData> {
    return this.enqueue(() => {
      assertSessionId(id);
      // The metadata and message rows are one logical value. A read transaction pins one WAL
      // snapshot so a concurrent rewrite/delete cannot produce a mixed old/new SessionData.
      this.db.exec("BEGIN");
      try {
        const meta = this.db
          .prepare(
            "SELECT id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title FROM sessions WHERE id = ?",
          )
          .get(id);
        if (!meta) throw new Error(t(`Session ${id} not found`, `会话 ${id} 不存在`));
        const rows = this.db
          .prepare("SELECT data FROM messages WHERE session_id = ? ORDER BY idx ASC")
          .all(id);
        const data = {
          ...rowToMeta(meta),
          messages: rows.map((row) => JSON.parse(String(row.data)) as ChatMessage),
        };
        this.db.exec("COMMIT");
        return data;
      } catch (error) {
        rollback(this.db);
        throw error;
      }
    });
  }

  list(): Promise<SessionMeta[]> {
    return this.enqueue(() => {
      const rows = this.db
        .prepare(
          "SELECT id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title FROM sessions ORDER BY updated_at DESC",
        )
        .all();
      return rows.map(rowToMeta);
    });
  }

  delete(id: string): Promise<void> {
    return this.enqueue(async () => {
      assertSessionId(id);
      // 外键 ON DELETE CASCADE 会连带删除 messages。
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
      await this.secureFiles();
    });
  }

  /**
   * Fence new work synchronously, drain every operation accepted before close, then close once.
   * Returning the same promise makes concurrent shutdown paths deterministic.
   */
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    const acceptedTail = this.operationTail;
    this.closeTask = acceptedTail.then(async () => {
      let error: unknown;
      try {
        await this.secureFiles();
      } catch (cause) {
        error = cause;
      }
      try {
        this.db.close();
      } catch (cause) {
        error ??= cause;
      }
      try {
        await this.secureFiles();
      } catch (cause) {
        error ??= cause;
      }
      if (error) throw error;
    });
    return this.closeTask;
  }

  /** 从一个 ISessionStore 全量迁移会话进本库（逐会话事务化且幂等）。 */
  async importFrom(source: ISessionStore): Promise<number> {
    const existing = new Set((await this.list()).map((meta) => meta.id));
    let imported = 0;
    for (const meta of await source.list()) {
      if (existing.has(meta.id)) continue;
      const data = await source.load(meta.id);
      if (
        data.id !== meta.id ||
        data.cwd !== meta.cwd ||
        data.model !== meta.model ||
        data.workspaceIdentity?.device !== meta.workspaceIdentity?.device ||
        data.workspaceIdentity?.inode !== meta.workspaceIdentity?.inode
      ) {
        throw new Error(`Session ${meta.id} metadata changed while import was running`);
      }
      const inserted = await this.enqueue(async () => {
        const serialized = data.messages.map((message) => {
          const value = JSON.stringify(message);
          if (value === undefined)
            throw new Error(t("Cannot serialize session message", "无法序列化会话消息"));
          return value;
        });
        this.db.exec("BEGIN IMMEDIATE");
        let created: boolean;
        try {
          const result = this.db
            .prepare(
              "INSERT OR IGNORE INTO sessions (id, created_at, updated_at, cwd, workspace_device, workspace_inode, model, title) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(
              data.id,
              data.createdAt,
              data.updatedAt,
              data.cwd,
              data.workspaceIdentity?.device ?? null,
              data.workspaceIdentity?.inode ?? null,
              data.model,
              data.title ?? null,
            );
          created = Number(result.changes) === 1;
          if (created) {
            const insert = this.db.prepare(
              "INSERT INTO messages (session_id, idx, data) VALUES (?, ?, ?)",
            );
            serialized.forEach((message, index) => insert.run(data.id, index, message));
          }
          this.db.exec("COMMIT");
        } catch (error) {
          rollback(this.db);
          throw error;
        }
        await this.secureFiles();
        return created;
      });
      existing.add(meta.id);
      if (inserted) imported++;
    }
    return imported;
  }
}

function rollback(db: SqliteDatabase): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // Preserve the operation error if SQLite already rolled the transaction back.
  }
}

async function ensureDatabaseParent(directory: string, applicationOwned: boolean): Promise<void> {
  let created = false;
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory())
      throw new Error(`SQLite session path is not a directory: ${directory}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    created = true;
  }
  // Never chmod an arbitrary existing custom parent (for example /tmp). The default application
  // directory and a leaf we created are owned by this store and can safely be tightened.
  if (applicationOwned || created) await fs.chmod(directory, 0o700);
}

async function preparePrivateDatabaseFile(file: string): Promise<void> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) throw new Error(`SQLite session path is not a regular file: ${file}`);
    await fs.chmod(file, SQLITE_PRIVATE_MODE);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  try {
    const handle = await fs.open(file, "wx", SQLITE_PRIVATE_MODE);
    await handle.close();
  } catch (error) {
    // Another process may have won the create race. Re-validate instead of following an attacker
    // controlled non-regular replacement.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await fs.lstat(file);
    if (!stat.isFile())
      throw new Error(`SQLite session path is not a regular file: ${file}`, { cause: error });
  }
  await fs.chmod(file, SQLITE_PRIVATE_MODE);
}

async function secureDatabaseFiles(file: string): Promise<void> {
  for (const candidate of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isFile()) {
        throw new Error(`SQLite session path is not a regular file: ${candidate}`);
      }
      await fs.chmod(candidate, SQLITE_PRIVATE_MODE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && candidate !== file) continue;
      throw error;
    }
  }
}

function rowToMeta(row: Record<string, unknown>): SessionMeta {
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
