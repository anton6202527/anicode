/**
 * JSONL 会话兼容存储 —— 把 Agent 的对话历史落盘，支持列出、resume 与旧数据迁移。
 *
 * 存储格式：每个会话一个 JSONL 文件。
 *   第 1 行：meta（id / 创建时间 / cwd / model / title）
 *   后续每行：一条 ChatMessage
 * 选 JSONL 而非单个 JSON，是为了能「追加写」——每轮结束 append 新消息，
 * 不必重写整个文件，长会话也不卡。
 *
 * 默认目录：~/.anicode/sessions/（可覆盖）。core 不碰凭证，只存对话。
 * 该格式是单机 fallback / 迁移源；生产组合默认使用 SQLite WAL，共享控制面使用 PostgreSQL。
 */

import { promises as fs, createReadStream, type BigIntStats } from "node:fs";
import { t } from "./i18n.js";
import { randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as readline from "node:readline";
import type { ChatMessage } from "./types.js";

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  cwd: string;
  /** Filesystem identity at session creation; scoped hosts reject replacement directories. */
  workspaceIdentity?: { device: string; inode: string };
  model: string;
  title?: string;
}

export interface SessionData extends SessionMeta {
  messages: ChatMessage[];
}

/**
 * Storage guarantee attested by a trusted host implementation.
 *
 * Production composition accepts only the exact transactional marker. The property remains
 * optional on `ISessionStore` so test doubles and legacy embedders stay source-compatible, but an
 * omitted or unknown value is deliberately not production-safe.
 */
export type SessionStoreSemantics =
  "unclassified" | "legacy-single-writer" | "transactional-primary";

/**
 * 会话持久化的抽象接口 —— SessionManager 只依赖它，不绑定具体后端。
 * `SessionStore` 是 legacy migration / single-host JSONL fallback；production primary 使用
 * SQLite 或 PostgreSQL。
 */
export interface ISessionStore {
  readonly storageSemantics?: SessionStoreSemantics;
  create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta>;
  append(id: string, message: ChatMessage): Promise<void>;
  /** Transactional batch append; avoids one durable commit/network round-trip per message. */
  appendMany?(id: string, messages: ChatMessage[]): Promise<void>;
  /** Metadata-only point read used by scoped-host authorization hot paths. */
  getMeta?(id: string): Promise<SessionMeta | undefined>;
  /** Metadata-only update; must not rewrite or reload the transcript. */
  updateMeta?(meta: SessionMeta): Promise<SessionMeta>;
  rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void>;
  load(id: string): Promise<SessionData>;
  list(): Promise<SessionMeta[]>;
  delete(id: string): Promise<void>;
}

/**
 * 生产迁移门：只在访问某个会话正文时，才把该会话从旧 JSONL 幂等导入数据库。
 *
 * `list()` 故意只合并 metadata。scoped host 必须能先用 cwd + workspace identity 拒绝
 * foreign session，不能因为列出会话就在授权前把共享 legacy store 的所有 prompt/response
 * 读入内存或写入 primary。旧文件保留为可恢复备份；primary 已更新得更晚时不会被覆盖。
 */
export class MigratingSessionStore implements ISessionStore {
  private readonly migrated = new Set<string>();
  private readonly migrations = new Map<string, Promise<void>>();

  constructor(
    readonly primary: ISessionStore,
    readonly legacy: ISessionStore,
  ) {}

  /** Migration is only as strong as its authoritative primary. */
  get storageSemantics(): SessionStoreSemantics {
    return this.primary.storageSemantics ?? "unclassified";
  }

  private migrateSession(id: string): Promise<void> {
    if (this.migrated.has(id)) return Promise.resolve();
    const pending = this.migrations.get(id);
    if (pending) return pending;
    const migration = this.migrateOne(id).then(() => {
      this.migrated.add(id);
    });
    this.migrations.set(id, migration);
    const cleanup = () => {
      if (this.migrations.get(id) === migration) this.migrations.delete(id);
    };
    void migration.then(cleanup, cleanup);
    return migration;
  }

  private async migrateOne(id: string): Promise<void> {
    const [primaryMeta, legacyMeta] = await Promise.all([
      this.findMeta(this.primary, id),
      this.findMeta(this.legacy, id),
    ]);
    if (!legacyMeta) return;

    // A same-id record from another workspace is not a migration source for the primary record.
    // Keeping primary authoritative also prevents an untrusted legacy collision from disclosing or
    // overwriting a valid transcript.
    if (primaryMeta && !sameStoredWorkspace(primaryMeta, legacyMeta)) return;

    let current: SessionData | undefined;
    let legacyData: SessionData | undefined;
    let created = false;
    if (primaryMeta) {
      current = await this.primary.load(id);
    } else {
      // This is the first operation which reads the legacy body. SessionManager.loadSession has
      // already authorized the metadata returned by list() for scoped hosts.
      legacyData = await this.legacy.load(id);
      assertStableMigrationMetadata(legacyMeta, legacyData);
      try {
        await this.primary.create({
          id: legacyMeta.id,
          cwd: legacyMeta.cwd,
          ...(legacyMeta.workspaceIdentity
            ? { workspaceIdentity: legacyMeta.workspaceIdentity }
            : {}),
          model: legacyMeta.model,
          ...(legacyMeta.title ? { title: legacyMeta.title } : {}),
        });
        created = true;
      } catch {
        // 另一进程可能刚完成相同迁移；以数据库中的提交为准继续比较。
      }
      current = await this.primary.load(id);
      if (!sameStoredWorkspace(current, legacyMeta)) return;
    }

    const legacyNewer = Date.parse(legacyMeta.updatedAt) > Date.parse(current.updatedAt);
    if (created || legacyNewer || current.messages.length === 0) {
      legacyData ??= await this.legacy.load(id);
      assertStableMigrationMetadata(legacyMeta, legacyData);
      if (
        created ||
        legacyNewer ||
        (current.messages.length === 0 && legacyData.messages.length > 0)
      ) {
        const { messages, ...loadedMeta } = legacyData;
        await this.primary.rewrite(loadedMeta, messages);
      }
    }
  }

  private async findMeta(store: ISessionStore, id: string): Promise<SessionMeta | undefined> {
    return store.getMeta ? store.getMeta(id) : (await store.list()).find((meta) => meta.id === id);
  }

  async create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    // Preserve create-exclusive semantics without reading a colliding legacy transcript. This is
    // important for scoped hosts: a generated id collision must not turn an authorized create in
    // one workspace into an implicit read of another workspace's legacy body.
    if (await this.findMeta(this.legacy, meta.id)) {
      throw new Error(`Session ${meta.id} already exists in the legacy store`);
    }
    return this.primary.create(meta);
  }

  async append(id: string, message: ChatMessage): Promise<void> {
    await this.migrateSession(id);
    return this.primary.append(id, message);
  }

  async appendMany(id: string, messages: ChatMessage[]): Promise<void> {
    await this.migrateSession(id);
    if (this.primary.appendMany) return this.primary.appendMany(id, messages);
    for (const message of messages) await this.primary.append(id, message);
  }

  async getMeta(id: string): Promise<SessionMeta | undefined> {
    const [primary, legacy] = await Promise.all([
      this.findMeta(this.primary, id),
      this.findMeta(this.legacy, id),
    ]);
    if (!legacy) return primary;
    if (!primary) return legacy;
    return sameStoredWorkspace(primary, legacy) &&
      Date.parse(legacy.updatedAt) > Date.parse(primary.updatedAt)
      ? legacy
      : primary;
  }

  async updateMeta(meta: SessionMeta): Promise<SessionMeta> {
    await this.migrateSession(meta.id);
    if (this.primary.updateMeta) return this.primary.updateMeta(meta);
    const current = await this.primary.load(meta.id);
    const next = { ...meta };
    await this.primary.rewrite(next, current.messages);
    return next;
  }

  async rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    await this.migrateSession(meta.id);
    return this.primary.rewrite(meta, messages);
  }

  async load(id: string): Promise<SessionData> {
    await this.migrateSession(id);
    return this.primary.load(id);
  }

  async list(): Promise<SessionMeta[]> {
    const [primary, legacy] = await Promise.all([this.primary.list(), this.legacy.list()]);
    const merged = new Map(primary.map((meta) => [meta.id, meta]));
    for (const legacyMeta of legacy) {
      const current = merged.get(legacyMeta.id);
      if (
        !current ||
        (sameStoredWorkspace(current, legacyMeta) &&
          Date.parse(legacyMeta.updatedAt) > Date.parse(current.updatedAt))
      ) {
        merged.set(legacyMeta.id, legacyMeta);
      }
    }
    return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(id: string): Promise<void> {
    // Deletion must never import the content it is about to erase.
    const [primaryMeta, legacyMeta] = await Promise.all([
      this.findMeta(this.primary, id),
      this.findMeta(this.legacy, id),
    ]);
    await this.primary.delete(id);
    // 删除语义必须同时清理迁移源，否则下次进程启动会把已删除会话重新导入。
    // A colliding record owned by a different workspace is not this primary session's backup and
    // must not be erased through the primary session's authorization.
    if (!primaryMeta || !legacyMeta || sameStoredWorkspace(primaryMeta, legacyMeta)) {
      await this.legacy.delete(id);
    }
    this.migrated.add(id);
  }
}

function sameStoredWorkspace(left: SessionMeta, right: SessionMeta): boolean {
  if (left.workspaceIdentity || right.workspaceIdentity) {
    return (
      left.workspaceIdentity?.device === right.workspaceIdentity?.device &&
      left.workspaceIdentity?.inode === right.workspaceIdentity?.inode
    );
  }
  return path.resolve(left.cwd) === path.resolve(right.cwd);
}

function assertStableMigrationMetadata(expected: SessionMeta, loaded: SessionData): void {
  if (
    loaded.id !== expected.id ||
    !sameStoredWorkspace(expected, loaded) ||
    loaded.model !== expected.model
  ) {
    throw new Error(`Session ${expected.id} metadata changed while legacy migration was running`);
  }
}

function defaultDir(): string {
  return path.join(os.homedir(), ".anicode", "sessions");
}

/** 生成一个可排序（时间前缀）的会话 id，无外部依赖 */
export function newSessionId(now: number, rand: () => number): string {
  const ts = now.toString(36).padStart(9, "0");
  const suffix = Math.floor(rand() * 0xfffff)
    .toString(36)
    .padStart(4, "0");
  return `s_${ts}_${suffix}`;
}

/** Shared by all SessionStore instances in this process which address the same directory/id. */
const jsonlSessionOperations = new Map<string, Promise<void>>();
const DEFAULT_SESSION_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_SESSION_LOCK_RETRY_MS = 10;
const MAX_SESSION_LOCK_BYTES = 4 * 1024;
const SESSION_LOCK_READ_CHUNK_BYTES = 4 * 1024;

export interface SessionStoreOptions {
  /** Maximum monotonic time spent acquiring another process's per-session owner lock. */
  lockTimeoutMs?: number;
  /** Delay between lock acquisition attempts. */
  lockRetryMs?: number;
}

interface SessionLockOwner {
  version: 1;
  pid: number;
  host: string;
  token: string;
}

interface SessionFileIdentity {
  dev: bigint;
  ino: bigint;
}

interface SessionLockLease {
  lock: string;
  owner: SessionLockOwner;
  identity: SessionFileIdentity;
}

interface SessionLockSnapshot {
  identity?: SessionFileIdentity;
  owner?: SessionLockOwner;
}

/**
 * Legacy JSONL fallback/migration store.
 *
 * Per-session owner locks prevent cooperating local processes from interleaving individual file
 * operations. They do not turn `load()` followed by `rewrite()` into a multi-writer transaction or
 * provide a distributed consistency boundary. Lock publication requires same-directory hard-link
 * atomicity on a local filesystem; network/distributed filesystems are outside this contract.
 * Production hosts must keep SQLite/PostgreSQL as the authoritative store; JSONL remains a
 * compatibility and recovery format.
 */
export class SessionStore implements ISessionStore {
  readonly storageSemantics = "legacy-single-writer" as const;
  private dir: string;

  constructor(
    dir?: string,
    private readonly options: SessionStoreOptions = {},
  ) {
    this.dir = dir ?? defaultDir();
  }

  private file(id: string): string {
    assertSessionId(id);
    return path.join(this.dir, `${id}.jsonl`);
  }

  private async ensurePrivateDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(this.dir);
    if (!stat.isDirectory())
      throw new Error(
        t(
          `Session path is not a regular directory: ${this.dir}`,
          `会话路径不是普通目录: ${this.dir}`,
        ),
      );
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(
        t(
          `Session directory is owned by another user: ${this.dir}`,
          `会话目录属于其他用户: ${this.dir}`,
        ),
      );
    }
    // mkdir 的 mode 受 umask 影响且不会修复既有目录，因此始终显式收紧。
    if (process.platform !== "win32") await fs.chmod(this.dir, 0o700);
  }

  private async secureExistingFile(file: string): Promise<void> {
    const stat = await fs.lstat(file);
    if (!stat.isFile())
      throw new Error(
        t(`Session path is not a regular file: ${file}`, `会话路径不是普通文件: ${file}`),
      );
    await fs.chmod(file, 0o600);
  }

  private withSessionLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
    // Keep call order stable inside one process. The owner lock acquired below extends the same
    // serialization guarantee to every cooperating anicode process on this filesystem.
    const key = `${path.resolve(this.dir)}\0${id}`;
    const predecessor = jsonlSessionOperations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = predecessor.then(() => gate);
    jsonlSessionOperations.set(key, tail);

    return predecessor
      .then(async () => {
        assertSessionId(id);
        await this.ensurePrivateDir();
        const lease = await acquireSessionLock(this.file(id), this.options);
        try {
          return await operation();
        } finally {
          await releaseSessionLock(lease);
        }
      })
      .finally(() => {
        release();
        if (jsonlSessionOperations.get(key) === tail) jsonlSessionOperations.delete(key);
      });
  }

  /** 创建新会话文件，写入 meta 头行 */
  create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    return this.withSessionLock(meta.id, async () => {
      assertSessionId(meta.id);
      await this.ensurePrivateDir();
      const now = new Date().toISOString();
      const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
      const file = this.file(meta.id);
      const candidate = `${file}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(candidate, "wx", 0o600);
        if (process.platform !== "win32") await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify({ __meta: full }) + "\n", "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        // Hard-link publication gives create both properties we need: the target appears only
        // after its complete header is durable, and an existing session is never overwritten.
        await fs.link(candidate, file);
        await fs.rm(candidate, { force: true }).catch(() => undefined);
        await syncDirectory(this.dir);
      } finally {
        await handle?.close().catch(() => undefined);
        await fs.rm(candidate, { force: true }).catch(() => undefined);
      }
      return full;
    });
  }

  /** 追加一条消息（每轮结束调用） */
  append(id: string, message: ChatMessage): Promise<void> {
    return this.appendMany(id, [message]);
  }

  /** 在一次 owner lock / write / fsync 中提交一批消息。 */
  appendMany(id: string, messages: ChatMessage[]): Promise<void> {
    assertSessionId(id);
    if (messages.length === 0) return Promise.resolve();
    const lines = messages.map((message) => {
      const serialized = JSON.stringify(message);
      if (serialized === undefined)
        throw new Error(t("Cannot serialize session message", "无法序列化会话消息"));
      return serialized;
    });
    return this.withSessionLock(id, async () => {
      await this.ensurePrivateDir();
      const file = this.file(id);
      // 先 chmod 也让旧版本留下的 0644 会话在下一次使用时自动迁移。
      await this.secureExistingFile(file);
      await recoverIncompleteJsonlTail(file);
      await assertSessionHeader(file, id);

      const handle = await fs.open(file, "a", 0o600);
      try {
        // The trailing LF is the commit marker. A crash before it reaches disk is repaired on the
        // next load/append; sync makes a successfully resolved append durable before acknowledgement.
        await handle.writeFile(lines.join("\n") + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  /** Read only the JSONL header; authorization does not scan unrelated sessions or transcript. */
  async getMeta(id: string): Promise<SessionMeta | undefined> {
    assertSessionId(id);
    try {
      return await this.withSessionLock(id, async () => {
        const file = this.file(id);
        await this.secureExistingFile(file);
        const first = await readFirstLine(file);
        const parsed = JSON.parse(first) as unknown;
        if (!isRecord(parsed) || !isRecord(parsed.__meta)) {
          throw new Error(t(`Session ${id} is missing its meta header`, `会话 ${id} 缺少 meta 头`));
        }
        const meta = parsed.__meta as unknown as SessionMeta;
        if (meta.id !== id) {
          throw new Error(
            t(
              `Session ${id} has a mismatched meta id: ${meta.id}`,
              `会话 ${id} 的 meta id 不匹配: ${meta.id}`,
            ),
          );
        }
        return withFileActivity(meta, file);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * 一次性覆盖写入全部消息（compaction 改写历史后用）。
   * 原子写：先写 .tmp 再 rename —— 中途崩溃只会留下 tmp 残片，
   * 原会话文件要么是旧的完整版本、要么是新的完整版本，绝不会半截。
   */
  rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    return this.withSessionLock(meta.id, async () => {
      assertSessionId(meta.id);
      await this.ensurePrivateDir();
      const updated: SessionMeta = { ...meta, updatedAt: new Date().toISOString() };
      const lines = [
        JSON.stringify({ __meta: updated }),
        ...messages.map((message) => {
          const serialized = JSON.stringify(message);
          if (serialized === undefined)
            throw new Error(t("Cannot serialize session message", "无法序列化会话消息"));
          return serialized;
        }),
      ];
      const target = this.file(meta.id);
      await this.secureExistingFile(target);
      const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
      let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
      try {
        handle = await fs.open(tmp, "wx", 0o600);
        if (process.platform !== "win32") await handle.chmod(0o600);
        await handle.writeFile(lines.join("\n") + "\n", "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await fs.rename(tmp, target);
        await fs.chmod(target, 0o600);
        await syncDirectory(this.dir);
      } finally {
        await handle?.close().catch(() => undefined);
        await fs.rm(tmp, { force: true });
      }
      // meta 与 live ManagedSession/Agent persistence 共享同一对象。只在原子替换
      // 成功后同步它，保证 snapshot 不会继续展示旧的活跃时间。
      meta.updatedAt = updated.updatedAt;
    });
  }

  /** 读取整个会话（流式逐行解析，避免大文件一次性读入） */
  load(id: string): Promise<SessionData> {
    return this.withSessionLock(id, async () => {
      assertSessionId(id);
      await this.ensurePrivateDir();
      const file = this.file(id);
      await this.secureExistingFile(file);
      // JSONL records are committed by LF. Discard only an unterminated tail; malformed committed
      // lines remain a hard error so corruption is never silently hidden.
      await recoverIncompleteJsonlTail(file);
      const input = createReadStream(file, "utf8");
      const rl = readline.createInterface({
        input,
        crlfDelay: Infinity,
      });
      let meta: SessionMeta | null = null;
      const messages: ChatMessage[] = [];
      try {
        for await (const line of rl) {
          if (!line.trim()) continue;
          const obj = JSON.parse(line) as unknown;
          if (!meta) {
            if (!isRecord(obj) || !isRecord(obj.__meta)) {
              throw new Error(
                t(`Session ${id} is missing its meta header`, `会话 ${id} 缺少 meta 头`),
              );
            }
            meta = obj.__meta as unknown as SessionMeta;
          } else {
            messages.push(obj as ChatMessage);
          }
        }
      } finally {
        rl.close();
        input.destroy();
      }
      if (!meta)
        throw new Error(t(`Session ${id} is missing its meta header`, `会话 ${id} 缺少 meta 头`));
      if (meta.id !== id) {
        throw new Error(
          t(
            `Session ${id} has a mismatched meta id: ${meta.id}`,
            `会话 ${id} 的 meta id 不匹配: ${meta.id}`,
          ),
        );
      }
      return { ...(await withFileActivity(meta, file)), messages };
    });
  }

  /** 列出所有会话的 meta（按 updatedAt 倒序），不加载消息 */
  async list(): Promise<SessionMeta[]> {
    let files: string[];
    try {
      await this.ensurePrivateDir();
      files = await fs.readdir(this.dir);
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        const file = path.join(this.dir, f);
        await this.secureExistingFile(file);
        const first = await readFirstLine(file);
        const obj = JSON.parse(first);
        const expectedId = f.slice(0, -".jsonl".length);
        if (obj.__meta && (obj.__meta as SessionMeta).id === expectedId) {
          assertSessionId(expectedId);
          metas.push(await withFileActivity(obj.__meta as SessionMeta, file));
        }
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return metas.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  delete(id: string): Promise<void> {
    return this.withSessionLock(id, async () => {
      assertSessionId(id);
      await this.ensurePrivateDir();
      await fs.rm(this.file(id), { force: true });
      await syncDirectory(this.dir);
    });
  }
}

async function acquireSessionLock(
  file: string,
  options: SessionStoreOptions,
): Promise<SessionLockLease> {
  const lock = `${file}.lock`;
  const timeoutMs = positiveInteger(options.lockTimeoutMs, DEFAULT_SESSION_LOCK_TIMEOUT_MS);
  const retryMs = positiveInteger(options.lockRetryMs, DEFAULT_SESSION_LOCK_RETRY_MS);
  const deadline = performance.now() + timeoutMs;
  const owner: SessionLockOwner = {
    version: 1,
    pid: process.pid,
    host: os.hostname(),
    token: randomBytes(32).toString("hex"),
  };

  // A contender must never observe a half-written owner record. Write and sync a private
  // candidate first, then publish it with a same-directory atomic hard link.
  const candidate = `${lock}.${process.pid}.${randomUUID()}.candidate`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(candidate, "wx", 0o600);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;

    for (;;) {
      try {
        await fs.link(candidate, lock);
        return { lock, owner, identity: sessionFileIdentity(stat) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Portable fs APIs have no compare-and-unlink primitive. Never auto-reap an apparently
        // dead owner: two reapers could otherwise validate the old inode and unlink a new owner.
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Error(
            t(
              `Session store lock timeout: ${lock}. After confirming every AniCode process using this store has stopped, remove exactly this lock file, or migrate the session store to SQLite/PostgreSQL.`,
              `会话存储锁获取超时: ${lock}。确认使用此存储的所有 AniCode 进程均已停止后，仅删除这个锁文件；或将会话存储迁移到 SQLite/PostgreSQL。`,
            ),
            { cause: error },
          );
        }
        await delay(Math.min(retryMs, remaining));
      }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(candidate, { force: true }).catch(() => undefined);
  }
}

async function releaseSessionLock(lease: SessionLockLease): Promise<void> {
  // Only the process holding this lease releases it. The identity check prevents a replacement
  // visible before validation from being removed; abandoned locks are deliberately fail-closed.
  const snapshot = await readSessionLockSnapshot(lease.lock);
  if (
    snapshot.owner?.token === lease.owner.token &&
    snapshot.identity &&
    sameSessionFileIdentity(snapshot.identity, lease.identity)
  ) {
    await fs.unlink(lease.lock).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readSessionLockSnapshot(lock: string): Promise<SessionLockSnapshot> {
  let before: BigIntStats;
  try {
    before = await fs.lstat(lock, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const identity = sessionFileIdentity(before);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size > BigInt(MAX_SESSION_LOCK_BYTES) ||
    (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid()))
  ) {
    return { identity };
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(lock, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (
      !sameSessionFile(opened, before) ||
      !opened.isFile() ||
      opened.size > BigInt(MAX_SESSION_LOCK_BYTES)
    ) {
      return { identity };
    }
    const raw = await readSessionLockBounded(handle);
    if (!raw) return { identity };
    const after = await handle.stat({ bigint: true });
    if (!sameSessionSnapshot(opened, after)) return { identity };
    const owner = parseSessionLockOwner(raw.toString("utf8"));
    return owner
      ? { identity: sessionFileIdentity(opened), owner }
      : { identity: sessionFileIdentity(opened) };
  } finally {
    await handle.close();
  }
}

async function readSessionLockBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const capacity = Math.min(SESSION_LOCK_READ_CHUNK_BYTES, MAX_SESSION_LOCK_BYTES + 1 - total);
    if (capacity <= 0) return undefined;
    const buffer = Buffer.allocUnsafe(capacity);
    const { bytesRead } = await handle.read(buffer, 0, capacity, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > MAX_SESSION_LOCK_BYTES) return undefined;
  }
}

function parseSessionLockOwner(text: string): SessionLockOwner | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value["version"] === 1 &&
      Number.isSafeInteger(value["pid"]) &&
      (value["pid"] as number) > 0 &&
      typeof value["host"] === "string" &&
      value["host"].length > 0 &&
      typeof value["token"] === "string" &&
      /^[a-f0-9]{64}$/.test(value["token"])
    ) {
      return value as unknown as SessionLockOwner;
    }
  } catch {
    // Invalid owner data is authoritative and fail-closed; never guess that it is stale.
  }
  return undefined;
}

function sessionFileIdentity(stat: BigIntStats): SessionFileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameSessionFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSessionSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameSessionFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameSessionFileIdentity(left: SessionFileIdentity, right: SessionFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function assertSessionId(id: string): void {
  if (id.length === 0 || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    throw new Error(
      t(`Invalid session id: ${JSON.stringify(id)}`, `非法会话 id: ${JSON.stringify(id)}`),
    );
  }
}

/**
 * JSONL 采用追加写，不能为更新时间重写首行；文件 mtime 就是持久化层的活跃时钟。
 * 同时保留首行中更晚的时间，兼容文件复制/恢复导致 mtime 回退的情况。
 */
async function withFileActivity(meta: SessionMeta, file: string): Promise<SessionMeta> {
  const stat = await fs.stat(file);
  const stored = Date.parse(meta.updatedAt);
  const activityMs = Number.isFinite(stored) ? Math.max(stored, stat.mtimeMs) : stat.mtimeMs;
  return { ...meta, updatedAt: new Date(activityMs).toISOString() };
}

async function readFirstLine(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  const chunks: Buffer[] = [];
  const maxHeaderBytes = 1024 * 1024;
  let total = 0;
  let position = 0;
  try {
    while (total <= maxHeaderBytes) {
      // Read one byte beyond the limit only to distinguish an exactly-1-MiB header followed by LF
      // from an oversized header. Short reads advance by bytesRead, never by requested capacity.
      const capacity = Math.min(4096, maxHeaderBytes + 1 - total);
      const chunk = Buffer.allocUnsafe(capacity);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) return ""; // An unterminated header is not committed.
      const newline = chunk.indexOf(0x0a, 0);
      if (newline >= 0 && newline < bytesRead) {
        if (total + newline > maxHeaderBytes) break;
        chunks.push(chunk.subarray(0, newline));
        return Buffer.concat(chunks, total + newline)
          .toString("utf8")
          .replace(/\r$/, "");
      }
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      position += bytesRead;
    }
    throw new Error(t("Session meta header exceeds 1 MiB", "会话 meta 头超过 1 MiB"));
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertSessionHeader(file: string, expectedId: string): Promise<void> {
  const first = await readFirstLine(file);
  let parsed: unknown;
  try {
    parsed = JSON.parse(first) as unknown;
  } catch (error) {
    throw new Error(
      t(`Session ${expectedId} has a corrupt meta header`, `会话 ${expectedId} 的 meta 头已损坏`),
      { cause: error },
    );
  }
  const meta = isRecord(parsed) && isRecord(parsed.__meta) ? parsed.__meta : undefined;
  if (!meta) {
    throw new Error(
      t(`Session ${expectedId} is missing its meta header`, `会话 ${expectedId} 缺少 meta 头`),
    );
  }
  if (meta.id !== expectedId) {
    throw new Error(
      t(
        `Session ${expectedId} has a mismatched meta id: ${String(meta.id)}`,
        `会话 ${expectedId} 的 meta id 不匹配: ${String(meta.id)}`,
      ),
    );
  }
}

/**
 * Recover a crash-partial append. A newline is the record commit marker, so only bytes after the
 * last newline are discarded. A malformed newline-terminated record is intentionally preserved
 * and will fail parsing rather than being mistaken for a harmless crash tail.
 */
async function recoverIncompleteJsonlTail(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r+");
  try {
    const original = await handle.stat();
    const { size } = original;
    if (size === 0) return false;

    const truncateDurably = async (length: number): Promise<void> => {
      await handle.truncate(length);
      await handle.sync();
      // Recovery is not new conversation activity. Preserve the timestamp from the interrupted
      // append so list ordering does not jump merely because a host restarted much later.
      await handle.utimes(original.atime, original.mtime);
      await handle.sync();
    };

    const finalByte = Buffer.allocUnsafe(1);
    await readRangeExactly(handle, finalByte, 1, size - 1, file);
    if (finalByte[0] === 0x0a) return false;

    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, size));
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.length);
      const length = end - start;
      // Positional reads of regular files are allowed to complete short. Fill the whole requested
      // range before moving the backwards cursor or we could skip a committed LF and over-truncate.
      await readRangeExactly(handle, chunk, length, start, file);
      const newline = chunk.lastIndexOf(0x0a, length - 1);
      if (newline >= 0) {
        const current = await handle.stat();
        if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
          throw new Error(
            t(
              `Session file changed while recovering its incomplete tail: ${file}`,
              `恢复未完成尾记录时会话文件发生变化: ${file}`,
            ),
          );
        }
        await truncateDurably(start + newline + 1);
        return true;
      }
      end = start;
    }

    const current = await handle.stat();
    if (current.size !== original.size || current.mtimeMs !== original.mtimeMs) {
      throw new Error(
        t(
          `Session file changed while recovering its incomplete tail: ${file}`,
          `恢复未完成尾记录时会话文件发生变化: ${file}`,
        ),
      );
    }
    await truncateDurably(0);
    return true;
  } finally {
    await handle.close();
  }
}

async function readRangeExactly(
  handle: Awaited<ReturnType<typeof fs.open>>,
  buffer: Buffer,
  length: number,
  position: number,
  file: string,
): Promise<void> {
  let total = 0;
  while (total < length) {
    const { bytesRead } = await handle.read(buffer, total, length - total, position + total);
    if (bytesRead === 0) {
      throw new Error(
        t(`Session file changed while reading it: ${file}`, `读取期间会话文件发生变化: ${file}`),
      );
    }
    total += bytesRead;
  }
}

/** Best-effort directory fsync turns rename/create/delete into a durable namespace update. */
async function syncDirectory(dir: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (error) {
    // Directory fsync is unsupported on a few platforms/filesystems. File contents are still
    // synced; ignore only the documented capability-style failures.
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
