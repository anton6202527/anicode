import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteSessionStore, sqliteAvailable } from "./session-sqlite.js";
import { SessionStore, type ISessionStore } from "./session.js";
import type { ChatMessage } from "./types.js";

const available = await sqliteAvailable();
const opts = { skip: available ? false : "node:sqlite 不可用（旧 Node 运行时）" };

const msg = (text: string): ChatMessage => ({ role: "user", content: [{ type: "text", text }] });

test("SqliteSessionStore: 与 JSONL 等价的 CRUD 语义", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-"));
  const store = await SqliteSessionStore.open(path.join(dir, "s.db"));
  try {
    assert.equal(store.storageSemantics, "transactional-primary");
    const meta = await store.create({ id: "s_a_1", cwd: dir, model: "m", title: "标题" });
    assert.equal(meta.createdAt, meta.updatedAt);
    assert.equal(meta.title, "标题");

    await store.append("s_a_1", msg("一"));
    await store.append("s_a_1", msg("二"));
    const loaded = await store.load("s_a_1");
    assert.equal(loaded.messages.length, 2);
    assert.equal((loaded.messages[1]!.content[0] as { text: string }).text, "二");

    // append 推进 updated_at
    const list1 = await store.list();
    assert.equal(list1.length, 1);
    assert.equal(list1[0]!.id, "s_a_1");

    // rewrite 覆盖历史
    await store.rewrite({ ...meta }, [msg("只剩这条")]);
    const after = await store.load("s_a_1");
    assert.equal(after.messages.length, 1);
    assert.equal((after.messages[0]!.content[0] as { text: string }).text, "只剩这条");

    // 删除级联清消息
    await store.delete("s_a_1");
    assert.deepEqual(await store.list(), []);
    await assert.rejects(() => store.load("s_a_1"));
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SqliteSessionStore: list 按 updated_at 倒序", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-"));
  const store = await SqliteSessionStore.open(path.join(dir, "s.db"));
  try {
    await store.create({ id: "s_a_1", cwd: dir, model: "m" });
    await new Promise((r) => setTimeout(r, 5));
    await store.create({ id: "s_b_2", cwd: dir, model: "m" });
    await new Promise((r) => setTimeout(r, 5));
    await store.append("s_a_1", msg("bump")); // s_a_1 变最新
    const list = await store.list();
    assert.equal(list[0]!.id, "s_a_1");
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SqliteSessionStore: importFrom 从 JSONL 迁移且幂等", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-"));
  const jsonl = new SessionStore(path.join(dir, "sessions"));
  await jsonl.create({ id: "s_j_1", cwd: dir, model: "m", title: "旧会话" });
  await jsonl.append("s_j_1", msg("历史一"));
  await jsonl.append("s_j_1", msg("历史二"));

  const store = await SqliteSessionStore.open(path.join(dir, "s.db"));
  try {
    assert.equal(await store.importFrom(jsonl), 1);
    assert.equal(await store.importFrom(jsonl), 0); // 幂等
    const loaded = await store.load("s_j_1");
    assert.equal(loaded.title, "旧会话");
    assert.equal(loaded.messages.length, 2);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SqliteSessionStore: DB/WAL/SHM 始终为私有权限且不修改自定义父目录", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-mode-"));
  const dbPath = path.join(dir, "s.db");
  await fs.chmod(dir, 0o755);
  const store = await SqliteSessionStore.open(dbPath);
  try {
    await store.create({ id: "s_private", cwd: dir, model: "m" });
    await store.append("s_private", msg("secret"));

    // 自定义目录可能由其他应用共享，存储层只收紧自己的数据库与 sidecar。
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o755);
    const existing: string[] = [];
    for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        await fs.access(file);
        existing.push(file);
      } catch {
        // SQLite may checkpoint and remove a sidecar; every sidecar that remains must be private.
      }
    }
    assert.ok(existing.includes(dbPath));
    for (const file of existing) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    // 模拟旧版本留下的宽权限；下一次写入会自动修复。
    for (const file of existing) await fs.chmod(file, 0o666);
    await store.append("s_private", msg("tighten"));
    for (const file of existing) assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test(
  "SqliteSessionStore: 相对路径在打开时冻结，不受后续 chdir 影响",
  { ...opts, concurrency: false },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-relative-"));
    const openedFrom = path.join(root, "opened-from");
    const changedTo = path.join(root, "changed-to");
    const databaseDirectory = path.join(openedFrom, "data");
    const databaseFile = path.join(databaseDirectory, "sessions.db");
    const originalCwd = process.cwd();
    let store: SqliteSessionStore | undefined;
    try {
      await Promise.all([
        fs.mkdir(databaseDirectory, { recursive: true }),
        fs.mkdir(changedTo, { recursive: true }),
      ]);
      process.chdir(openedFrom);
      store = await SqliteSessionStore.open(path.join("data", "sessions.db"));
      await fs.chmod(databaseFile, 0o666);

      process.chdir(changedTo);
      await store.create({ id: "s_relative", cwd: openedFrom, model: "m" });
      assert.equal((await fs.stat(databaseFile)).mode & 0o777, 0o600);
      await store.close();
      store = undefined;
    } finally {
      process.chdir(originalCwd);
      await store?.close().catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("SqliteSessionStore: load 将 meta 与 messages 固定在同一 SQLite 快照", async () => {
  let inReadTransaction = false;
  const executed: string[] = [];
  const fakeDb = {
    exec(sql: string) {
      executed.push(sql);
      if (sql === "BEGIN") inReadTransaction = true;
      if (sql === "COMMIT" || sql === "ROLLBACK") inReadTransaction = false;
    },
    prepare(sql: string) {
      return {
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
        get: () =>
          sql.startsWith("SELECT id")
            ? {
                id: "s_snapshot",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                cwd: "/workspace",
                workspace_device: null,
                workspace_inode: null,
                model: "m",
                title: "snapshot-a",
              }
            : undefined,
        // Simulate another connection committing version B between the two SELECTs. A pinned read
        // transaction must continue to see version A.
        all: () =>
          sql.startsWith("SELECT data")
            ? [
                {
                  data: JSON.stringify(msg(inReadTransaction ? "snapshot-a" : "snapshot-b")),
                },
              ]
            : [],
      };
    },
    close() {},
  };
  const StoreConstructor = SqliteSessionStore as unknown as new (
    db: typeof fakeDb,
    dbPath: string,
  ) => SqliteSessionStore;
  const store = new StoreConstructor(fakeDb, ":memory:");
  try {
    const loaded = await store.load("s_snapshot");
    assert.equal(loaded.title, "snapshot-a");
    assert.equal((loaded.messages[0]!.content[0] as { text: string }).text, "snapshot-a");
    assert.deepEqual(executed, ["BEGIN", "COMMIT"]);
  } finally {
    await store.close();
  }
});

test("SqliteSessionStore: close 同步阻止新工作并等待已接收写入", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-close-"));
  const dbPath = path.join(dir, "s.db");
  const store = await SqliteSessionStore.open(dbPath);
  await store.create({ id: "s_close", cwd: dir, model: "m" });

  const accepted = store.append("s_close", msg("accepted before close"));
  const firstClose = store.close();
  assert.equal(store.close(), firstClose);
  await assert.rejects(store.list(), /已关闭|closed/);
  await Promise.all([accepted, firstClose]);

  const reopened = await SqliteSessionStore.open(dbPath);
  try {
    assert.equal((await reopened.load("s_close")).messages.length, 1);
  } finally {
    await reopened.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SqliteSessionStore: 并发实例追加使用原子索引且不丢消息", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-concurrent-"));
  const dbPath = path.join(dir, "s.db");
  const first = await SqliteSessionStore.open(dbPath);
  const second = await SqliteSessionStore.open(dbPath);
  try {
    await first.create({ id: "s_shared", cwd: dir, model: "m" });
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? first : second).append("s_shared", msg(`message-${index}`)),
      ),
    );
    const loaded = await first.load("s_shared");
    assert.equal(loaded.messages.length, 20);
    assert.equal(
      new Set(loaded.messages.map((message) => (message.content[0] as { text: string }).text)).size,
      20,
    );
  } finally {
    await Promise.all([first.close(), second.close()]);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SqliteSessionStore: 迁移序列化失败不会留下半导入会话", opts, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-import-"));
  const store = await SqliteSessionStore.open(path.join(dir, "s.db"));
  const meta = {
    id: "s_invalid_import",
    cwd: dir,
    model: "m",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const source = {
    async list() {
      return [meta];
    },
    async load() {
      return {
        ...meta,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "invalid", nonJsonValue: 1n }],
          },
        ],
      };
    },
  } as unknown as ISessionStore;
  try {
    await assert.rejects(store.importFrom(source), /BigInt|serialize/i);
    assert.deepEqual(await store.list(), []);
  } finally {
    await store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
