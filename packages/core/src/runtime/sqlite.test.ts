import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MigratingSessionStore, SessionStore } from "../session.js";
import { DurableWorkerQueue } from "./worker.js";
import {
  SqliteRuntimeDatabase,
  SqliteRuntimeEventStore,
  SqliteRuntimeSessionStore,
  SqliteWorkerQueueStore,
} from "./sqlite.js";

test("SQLite runtime: BEGIN IMMEDIATE 回滚、事件幂等与 fencing token", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-runtime-"));
  const database = new SqliteRuntimeDatabase(path.join(root, "runtime.db"));
  try {
    await assert.rejects(
      () =>
        database.transaction((db) => {
          db.prepare(
            `INSERT INTO runtime_audit
             (id, timestamp, category, action, metadata) VALUES (?, ?, ?, ?, ?)`,
          ).run("rolled-back", new Date().toISOString(), "runtime", "test", "{}");
          throw new Error("rollback-me");
        }),
      /rollback-me/,
    );
    assert.equal((await database.auditLog()).length, 0);

    const events = new SqliteRuntimeEventStore(database);
    const first = await events.append({
      streamId: "session-1",
      type: "command.accepted",
      data: { ok: true },
      idempotencyKey: "same-command",
    });
    const duplicate = await events.append({
      streamId: "session-1",
      type: "command.accepted",
      data: { ok: false },
      idempotencyKey: "same-command",
    });
    assert.equal(duplicate.id, first.id);
    await assert.rejects(
      () =>
        events.append({
          streamId: "session-1",
          type: "command.started",
          data: {},
          expectedSequence: 0,
        }),
      /version conflict/,
    );

    const store = new SqliteWorkerQueueStore(database);
    const queue = new DurableWorkerQueue(store);
    const queued = await queue.enqueue("build", { commit: "abc" }, { idempotencyKey: "build:abc" });
    const worker1 = await queue.claim("worker-1", ["build"], 60_000);
    assert.equal(worker1?.fencingToken, 1);
    await store.transact((jobs) => {
      jobs.find((job) => job.id === queued.id)!.leaseExpiresAt = new Date(0).toISOString();
    });
    const worker2 = await queue.claim("worker-2", ["build"], 60_000);
    assert.equal(worker2?.fencingToken, 2);
    await assert.rejects(
      () => queue.finish(queued.id, "worker-1", "late", worker1!.fencingToken),
      /unowned|Stale fencing/,
    );
    await queue.finish(queued.id, "worker-2", "ok", worker2!.fencingToken);
    assert.equal((await queue.list())[0]?.status, "succeeded");
  } finally {
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SQLite runtime: close synchronously fences new work and is idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-close-fence-"));
  const file = path.join(root, "runtime.db");
  const database = new SqliteRuntimeDatabase(file);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  const accepted = database.run(async (db) => {
    entered();
    await gate;
    db.prepare(
      `INSERT INTO runtime_audit
       (id, timestamp, category, action, metadata) VALUES (?, ?, ?, ?, ?)`,
    ).run("before-close", new Date().toISOString(), "runtime", "close-fence", "{}");
  });
  await started;

  const firstClose = database.close();
  const secondClose = database.close();
  assert.equal(firstClose, secondClose, "concurrent close callers must share one lifecycle fence");
  await assert.rejects(() => database.run(() => undefined), /database is closed/);

  release();
  await accepted;
  await firstClose;

  const reopened = new SqliteRuntimeDatabase(file);
  try {
    assert.equal(
      (await reopened.auditLog()).some((entry) => entry.id === "before-close"),
      true,
    );
  } finally {
    await reopened.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "SQLite runtime: DB/WAL/SHM 权限私有且不修改自定义父目录",
  {
    skip:
      process.platform === "win32"
        ? "POSIX owner/group/other mode bits are unavailable on Windows"
        : false,
  },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-runtime-mode-"));
    const file = path.join(root, "runtime.db");
    await fs.chmod(root, 0o755);
    const database = new SqliteRuntimeDatabase(file);
    try {
      await database.audit({ category: "runtime", action: "permission-check" });
      assert.equal((await fs.stat(root)).mode & 0o777, 0o755);

      const existing: string[] = [];
      for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
        try {
          await fs.access(candidate);
          existing.push(candidate);
        } catch {
          // A checkpoint may remove a sidecar; every sidecar that remains must be private.
        }
      }
      assert.ok(existing.includes(file));
      for (const candidate of existing) {
        assert.equal((await fs.stat(candidate)).mode & 0o777, 0o600);
        await fs.chmod(candidate, 0o666);
      }

      await database.auditLog();
      for (const candidate of existing) {
        assert.equal((await fs.stat(candidate)).mode & 0o777, 0o600);
      }

      await database.close();
      await fs.chmod(file, 0o666);
      const reopened = new SqliteRuntimeDatabase(file);
      try {
        assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      } finally {
        await reopened.close();
      }
    } finally {
      await database.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("SQLite runtime: JSONL 会话幂等迁移，事务追加不丢消息", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-sessions-"));
  const file = path.join(root, "runtime.db");
  const database = new SqliteRuntimeDatabase(file);
  const secondDatabase = new SqliteRuntimeDatabase(file);
  try {
    const legacy = new SessionStore(path.join(root, "sessions"));
    const legacyMeta = await legacy.create({
      id: "session-legacy",
      cwd: root,
      model: "debug/demo",
      title: "legacy",
    });
    await legacy.append("session-legacy", {
      role: "user",
      content: [{ type: "text", text: "before migration" }],
    });

    const primary = new SqliteRuntimeSessionStore(database);
    const migrated = new MigratingSessionStore(primary, legacy);
    assert.equal((await migrated.list())[0]?.createdAt, legacyMeta.createdAt);
    assert.deepEqual(
      await primary.list(),
      [],
      "metadata listing must not eagerly import legacy transcript bodies",
    );
    assert.equal((await migrated.load("session-legacy")).messages.length, 1);
    // 第二次 list 不重复导入；两个独立 SQLite 连接追加后 index 仍唯一且内容完整。
    await migrated.list();
    await Promise.all([
      primary.append("session-legacy", {
        role: "user",
        content: [{ type: "text", text: "from connection one" }],
      }),
      new SqliteRuntimeSessionStore(secondDatabase).append("session-legacy", {
        role: "assistant",
        content: [{ type: "text", text: "from connection two" }],
      }),
    ]);
    assert.equal((await primary.load("session-legacy")).messages.length, 3);
    await primary.create({
      id: "session-identity",
      cwd: root,
      workspaceIdentity: { device: "device-1", inode: "inode-2" },
      model: "debug/demo",
    });
    assert.deepEqual((await primary.load("session-identity")).workspaceIdentity, {
      device: "device-1",
      inode: "inode-2",
    });

    const interruptedLegacy = await legacy.create({
      id: "session-interrupted",
      cwd: root,
      model: "debug/demo",
    });
    await legacy.append(interruptedLegacy.id, {
      role: "user",
      content: [{ type: "text", text: "recover interrupted import" }],
    });
    await primary.create({ id: interruptedLegacy.id, cwd: root, model: "debug/demo" });
    assert.equal(
      (await new MigratingSessionStore(primary, legacy).load(interruptedLegacy.id)).messages.length,
      1,
      "an empty primary row left by an interrupted migration must import only that legacy body",
    );

    await migrated.delete("session-legacy");
    assert.deepEqual(
      new Set(
        (await new MigratingSessionStore(primary, legacy).list()).map((session) => session.id),
      ),
      new Set(["session-identity", "session-interrupted"]),
    );
  } finally {
    await secondDatabase.close();
    await database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("SQLite runtime session store: load 使用单一快照，rewrite 提交后才更新 meta", async () => {
  let inReadTransaction = false;
  const executed: string[] = [];
  const readConnection = {
    exec(sql: string) {
      executed.push(sql);
      if (sql === "BEGIN") inReadTransaction = true;
      if (sql === "COMMIT" || sql === "ROLLBACK") inReadTransaction = false;
    },
    prepare(sql: string) {
      return {
        get: () =>
          sql.startsWith("SELECT * FROM sessions")
            ? {
                id: "session-snapshot",
                created_at: "2026-01-01T00:00:00.000Z",
                updated_at: "2026-01-01T00:00:00.000Z",
                cwd: "/workspace",
                workspace_device: null,
                workspace_inode: null,
                model: "m",
                title: "snapshot-a",
              }
            : undefined,
        all: () =>
          sql.startsWith("SELECT data FROM session_messages")
            ? [
                {
                  data: JSON.stringify({
                    role: "user",
                    content: [
                      { type: "text", text: inReadTransaction ? "snapshot-a" : "snapshot-b" },
                    ],
                  }),
                },
              ]
            : [],
        run: () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
  };
  const snapshotDatabase = {
    run<T>(work: (db: typeof readConnection) => T): Promise<T> {
      return Promise.resolve(work(readConnection));
    },
  } as unknown as SqliteRuntimeDatabase;
  const snapshotStore = new SqliteRuntimeSessionStore(snapshotDatabase);
  const loaded = await snapshotStore.load("session-snapshot");
  assert.equal(loaded.title, "snapshot-a");
  assert.equal((loaded.messages[0]!.content[0] as { text: string }).text, "snapshot-a");
  assert.deepEqual(executed, ["BEGIN", "COMMIT"]);

  const originalUpdatedAt = "2025-12-31T00:00:00.000Z";
  const meta = {
    id: "session-commit-failure",
    createdAt: originalUpdatedAt,
    updatedAt: originalUpdatedAt,
    cwd: "/workspace",
    model: "m",
  };
  const writeConnection = {
    prepare() {
      return { run: () => ({ changes: 1, lastInsertRowid: 0 }) };
    },
  };
  const failingDatabase = {
    transaction<T>(work: (db: typeof writeConnection) => T): Promise<T> {
      work(writeConnection);
      return Promise.reject(new Error("simulated commit failure"));
    },
  } as unknown as SqliteRuntimeDatabase;
  await assert.rejects(
    new SqliteRuntimeSessionStore(failingDatabase).rewrite(meta, []),
    /simulated commit failure/,
  );
  assert.equal(meta.updatedAt, originalUpdatedAt);
});

test("SQLite runtime: ordered migration checksums and explicit retention", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-migrations-"));
  const file = path.join(root, "runtime.db");
  const database = new SqliteRuntimeDatabase(file);
  try {
    const migrations = await database.run(
      (db) =>
        db
          .prepare("SELECT version, checksum, description FROM schema_migrations ORDER BY version")
          .all() as Array<Record<string, unknown>>,
    );
    assert.deepEqual(
      migrations.map((row) => Number(row.version)),
      [1, 2, 3],
    );
    assert.ok(migrations.every((row) => /^[a-f0-9]{64}$/.test(String(row.checksum))));

    const old = "2000-01-01T00:00:00.000Z";
    await database.run((db) => {
      db.prepare(
        `INSERT INTO runtime_audit
         (id, timestamp, category, action, metadata) VALUES (?, ?, ?, ?, ?)`,
      ).run("old-audit", old, "runtime", "old", "{}");
      db.prepare(
        `INSERT INTO worker_jobs
         (id, type, idempotency_key, status, data, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run("old-job", "test", "old-job", "succeeded", "{}", old, old);
      db.prepare(
        `INSERT INTO runtime_events
         (stream_id, sequence, id, timestamp, type, data) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run("compacted", 1, "old-event", old, "done", "{}");
      db.prepare(
        `INSERT INTO runtime_snapshots(stream_id, sequence, data, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run("compacted", 1, "{}", old);
    });

    const pruned = await database.prune({}, Date.parse("2026-01-01T00:00:00.000Z"));
    assert.equal(pruned.audit, 1);
    assert.equal(pruned.workerJobs, 1);
    assert.equal(pruned.events, 1);

    await database.run((db) =>
      db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2").run("tampered"),
    );
  } finally {
    await database.close();
  }
  assert.throws(() => new SqliteRuntimeDatabase(file), /migration 2 checksum mismatch/);
  await fs.rm(root, { recursive: true, force: true });
});

test("SQLite runtime: v2 database upgrades to v3 without changing old checksums", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sqlite-v2-upgrade-"));
  const file = path.join(root, "runtime.db");
  const seeded = new SqliteRuntimeDatabase(file);
  let oldChecksums: string[];
  try {
    oldChecksums = await seeded.run((db) =>
      db
        .prepare("SELECT checksum FROM schema_migrations WHERE version IN (1, 2) ORDER BY version")
        .all()
        .map((row) => String((row as Record<string, unknown>).checksum)),
    );
    await seeded.run((db) => {
      db.exec(`
        DROP TABLE session_operation_leases;
        DROP TABLE session_lifecycle;
        ALTER TABLE sessions DROP COLUMN workspace_device;
        ALTER TABLE sessions DROP COLUMN workspace_inode;
        DELETE FROM schema_migrations WHERE version = 3;
      `);
    });
  } finally {
    await seeded.close();
  }

  const upgraded = new SqliteRuntimeDatabase(file);
  try {
    const versions = await upgraded.run((db) =>
      db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => Number((row as Record<string, unknown>).version)),
    );
    assert.deepEqual(versions, [1, 2, 3]);
    const checksums = await upgraded.run((db) =>
      db
        .prepare("SELECT checksum FROM schema_migrations WHERE version IN (1, 2) ORDER BY version")
        .all()
        .map((row) => String((row as Record<string, unknown>).checksum)),
    );
    assert.deepEqual(checksums, oldChecksums, "v3 must not rewrite historical migration records");
    const columns = await upgraded.run((db) =>
      db
        .prepare("PRAGMA table_info(sessions)")
        .all()
        .map((row) => String((row as Record<string, unknown>).name)),
    );
    assert.ok(columns.includes("workspace_device"));
    assert.ok(columns.includes("workspace_inode"));
    assert.ok(
      await upgraded.run((db) =>
        Boolean(
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_lifecycle'",
            )
            .get(),
        ),
      ),
    );
  } finally {
    await upgraded.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
