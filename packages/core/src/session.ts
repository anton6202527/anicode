/**
 * 会话持久化 —— 把 Agent 的对话历史落盘，支持列出与 resume。
 *
 * 存储格式：每个会话一个 JSONL 文件。
 *   第 1 行：meta（id / 创建时间 / cwd / model / title）
 *   后续每行：一条 ChatMessage
 * 选 JSONL 而非单个 JSON，是为了能「追加写」——每轮结束 append 新消息，
 * 不必重写整个文件，长会话也不卡。
 *
 * 默认目录：~/.anicode/sessions/（可覆盖）。core 不碰凭证，只存对话。
 */

import { promises as fs, createReadStream } from "node:fs";
import { t } from "./i18n.js";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
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
 * 会话持久化的抽象接口 —— SessionManager 只依赖它，不绑定具体后端。
 * 默认实现 `SessionStore`（JSONL 文件）；可选 `SqliteSessionStore`（node:sqlite）。
 */
export interface ISessionStore {
  create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta>;
  append(id: string, message: ChatMessage): Promise<void>;
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
    return (await store.list()).find((meta) => meta.id === id);
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

export class SessionStore implements ISessionStore {
  private dir: string;

  constructor(dir?: string) {
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
    // mkdir 的 mode 受 umask 影响且不会修复既有目录，因此始终显式收紧。
    await fs.chmod(this.dir, 0o700);
  }

  private async secureExistingFile(file: string): Promise<void> {
    const stat = await fs.lstat(file);
    if (!stat.isFile())
      throw new Error(
        t(`Session path is not a regular file: ${file}`, `会话路径不是普通文件: ${file}`),
      );
    await fs.chmod(file, 0o600);
  }

  /** 创建新会话文件，写入 meta 头行 */
  async create(meta: Omit<SessionMeta, "createdAt" | "updatedAt">): Promise<SessionMeta> {
    await this.ensurePrivateDir();
    const now = new Date().toISOString();
    const full: SessionMeta = { ...meta, createdAt: now, updatedAt: now };
    await fs.writeFile(this.file(meta.id), JSON.stringify({ __meta: full }) + "\n", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return full;
  }

  /** 追加一条消息（每轮结束调用） */
  async append(id: string, message: ChatMessage): Promise<void> {
    await this.ensurePrivateDir();
    const file = this.file(id);
    // 先 chmod 也让旧版本留下的 0644 会话在下一次使用时自动迁移。
    await this.secureExistingFile(file);
    await fs.appendFile(file, JSON.stringify(message) + "\n", "utf8");
  }

  /**
   * 一次性覆盖写入全部消息（compaction 改写历史后用）。
   * 原子写：先写 .tmp 再 rename —— 中途崩溃只会留下 tmp 残片，
   * 原会话文件要么是旧的完整版本、要么是新的完整版本，绝不会半截。
   */
  async rewrite(meta: SessionMeta, messages: ChatMessage[]): Promise<void> {
    await this.ensurePrivateDir();
    const updated: SessionMeta = { ...meta, updatedAt: new Date().toISOString() };
    const lines = [JSON.stringify({ __meta: updated }), ...messages.map((m) => JSON.stringify(m))];
    const target = this.file(meta.id);
    await this.secureExistingFile(target);
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, lines.join("\n") + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await fs.rename(tmp, target);
      await fs.chmod(target, 0o600);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    // meta 与 live ManagedSession/Agent persistence 共享同一对象。只在原子替换
    // 成功后同步它，保证 snapshot 不会继续展示旧的活跃时间。
    meta.updatedAt = updated.updatedAt;
  }

  /** 读取整个会话（流式逐行解析，避免大文件一次性读入） */
  async load(id: string): Promise<SessionData> {
    await this.ensurePrivateDir();
    const file = this.file(id);
    await this.secureExistingFile(file);
    const rl = readline.createInterface({
      input: createReadStream(file, "utf8"),
      crlfDelay: Infinity,
    });
    let meta: SessionMeta | null = null;
    const messages: ChatMessage[] = [];
    for await (const line of rl) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.__meta) meta = obj.__meta;
      else messages.push(obj as ChatMessage);
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

  async delete(id: string): Promise<void> {
    await this.ensurePrivateDir();
    await fs.rm(this.file(id), { force: true });
  }
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
  const rl = readline.createInterface({
    input: createReadStream(file, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return "";
}
