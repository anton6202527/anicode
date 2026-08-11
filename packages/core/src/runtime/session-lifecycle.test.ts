import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager } from "../session-manager.js";
import type { ISessionStore } from "../session.js";
import type { Provider } from "../types.js";
import type { ArtifactStore } from "./artifacts.js";
import { CommandInbox, DurableOutbox } from "./commands.js";
import { DurableRuntime } from "./durable.js";
import {
  SqliteArtifactStore,
  SqliteCommandInboxStore,
  SqliteOutboxStore,
  SqliteRuntimeDatabase,
  SqliteRuntimeEventStore,
  SqliteRuntimeSessionStore,
  SqliteRuntimeSnapshotStore,
  SqliteSessionLifecycleStore,
} from "./sqlite.js";
import type {
  AcquireSessionOperationInput,
  ClaimSessionDeletionInput,
  SessionDeletionClaim,
  SessionLifecycleRecord,
  SessionLifecycleStore,
  SessionOperationLease,
} from "./session-lifecycle.js";

const idleProvider: Provider = {
  name: "idle",
  async *stream() {
    yield {
      type: "done",
      stopReason: "end_turn",
      message: { role: "assistant", content: [] },
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function sqliteManager(
  database: SqliteRuntimeDatabase,
  options: {
    store?: ISessionStore;
    artifacts?: ArtifactStore;
    lifecycle?: SessionLifecycleStore;
    workspaceScope?: string;
    leaseMs?: number;
  } = {},
): SessionManager {
  const events = new SqliteRuntimeEventStore(database);
  const runtime = new DurableRuntime(
    events,
    new SqliteRuntimeSnapshotStore(database),
    50,
    options.lifecycle,
  );
  return new SessionManager({
    store: options.store ?? new SqliteRuntimeSessionStore(database),
    runtime,
    artifacts: options.artifacts ?? new SqliteArtifactStore(database),
    commandInbox: new CommandInbox(new SqliteCommandInboxStore(database)),
    outbox: new DurableOutbox(new SqliteOutboxStore(database), runtime),
    resolveProvider: () => ({ provider: idleProvider, model: "idle" }),
    recoverCommands: false,
    ...(options.workspaceScope ? { workspaceScope: options.workspaceScope } : {}),
    ...(options.leaseMs
      ? { sessionLifecycleLeaseMs: options.leaseMs, sessionLifecyclePollMs: 5 }
      : {}),
  });
}

class DelayedArtifactStore implements ArtifactStore {
  readonly started = deferred();
  readonly release = deferred();
  putCalls = 0;

  constructor(
    private readonly backing: ArtifactStore,
    private readonly delayPut = true,
  ) {}

  async put(input: Parameters<ArtifactStore["put"]>[0]) {
    this.putCalls++;
    if (this.delayPut) {
      this.started.resolve();
      await this.release.promise;
    }
    return this.backing.put(input);
  }

  list(sessionId: string) {
    return this.backing.list(sessionId);
  }

  get(sessionId: string, artifactId: string) {
    return this.backing.get(sessionId, artifactId);
  }

  open(sessionId: string, artifactId: string) {
    return this.backing.open
      ? this.backing.open(sessionId, artifactId)
      : Promise.resolve(undefined);
  }

  delete(sessionId: string, artifactId: string) {
    return this.backing.delete(sessionId, artifactId);
  }

  deleteSession(sessionId: string) {
    return this.backing.deleteSession(sessionId);
  }
}

class DroppedOperationRenewals implements SessionLifecycleStore {
  drop = false;

  constructor(private readonly backing: SessionLifecycleStore) {}

  get(sessionId: string): Promise<SessionLifecycleRecord | undefined> {
    return this.backing.get(sessionId);
  }
  listDeleted(input: {
    limit: number;
    afterSessionId?: string;
    workspace?: string;
  }): Promise<SessionLifecycleRecord[]> {
    return this.backing.listDeleted(input);
  }
  acquireOperation(input: AcquireSessionOperationInput): Promise<SessionOperationLease> {
    return this.backing.acquireOperation(input);
  }
  renewOperation(lease: SessionOperationLease, ttlMs: number): Promise<boolean> {
    return this.drop ? Promise.resolve(false) : this.backing.renewOperation(lease, ttlMs);
  }
  releaseOperation(lease: SessionOperationLease): Promise<void> {
    return this.backing.releaseOperation(lease);
  }
  claimDeletion(input: ClaimSessionDeletionInput): Promise<SessionDeletionClaim> {
    return this.backing.claimDeletion(input);
  }
  renewDeletion(claim: SessionDeletionClaim, ttlMs: number): Promise<boolean> {
    return this.backing.renewDeletion(claim, ttlMs);
  }
  completeDeletion(claim: SessionDeletionClaim): Promise<boolean> {
    return this.backing.completeDeletion(claim);
  }
}

test("durable lifecycle: two managers drain a shared SQLite producer before purge", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lifecycle-drain-"));
  const file = path.join(root, "runtime.db");
  const databaseA = new SqliteRuntimeDatabase(file);
  const databaseB = new SqliteRuntimeDatabase(file);
  const delayed = new DelayedArtifactStore(new SqliteArtifactStore(databaseA));
  const managerA = sqliteManager(databaseA, { artifacts: delayed });
  const managerB = sqliteManager(databaseB);
  let writing: Promise<unknown> | undefined;
  let deleting: Promise<void> | undefined;
  try {
    const session = await managerA.createSession({ cwd: root, model: "idle" });
    writing = managerA.putArtifact({
      sessionId: session.id,
      kind: "report",
      name: "racing.txt",
      data: "must be purged",
    });
    await delayed.started.promise;
    assert.equal(
      (await new SqliteSessionLifecycleStore(databaseB).get(session.id))?.activeLeases,
      1,
      "the delayed producer must publish its durable lease before entering the artifact store",
    );

    let deleted = false;
    deleting = managerB.deleteSession(session.id).then(() => {
      deleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(deleted, false, "delete must wait for the other manager's durable lease");
    await assert.rejects(
      () =>
        managerB.putArtifact({
          sessionId: session.id,
          kind: "report",
          name: "blocked.txt",
          data: "blocked",
        }),
      /deleted|删除/,
    );

    delayed.release.resolve();
    await writing;
    await deleting;
    assert.deepEqual(await new SqliteArtifactStore(databaseB).list(session.id), []);
    await assert.rejects(() => new SqliteRuntimeSessionStore(databaseB).load(session.id));
    assert.equal(
      (await new SqliteSessionLifecycleStore(databaseB).get(session.id))?.state,
      "deleted",
    );
  } finally {
    delayed.release.resolve();
    await writing?.catch(() => undefined);
    await deleting?.catch(() => undefined);
    managerA.dispose();
    managerB.dispose();
    await databaseB.close();
    await databaseA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("durable lifecycle: stale cross-manager preflight cannot write behind delete", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lifecycle-preflight-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const file = path.join(root, "runtime.db");
  const databaseA = new SqliteRuntimeDatabase(file);
  const databaseB = new SqliteRuntimeDatabase(file);
  const primaryA = new SqliteRuntimeSessionStore(databaseA);
  let blockList = false;
  const listed = deferred();
  const releaseList = deferred();
  const gatedStore: ISessionStore = {
    create: (meta) => primaryA.create(meta),
    append: (id, message) => primaryA.append(id, message),
    rewrite: (meta, messages) => primaryA.rewrite(meta, messages),
    load: (id) => primaryA.load(id),
    async list() {
      const result = await primaryA.list();
      if (blockList) {
        blockList = false;
        listed.resolve();
        await releaseList.promise;
      }
      return result;
    },
    delete: (id) => primaryA.delete(id),
  };
  const counted = new DelayedArtifactStore(new SqliteArtifactStore(databaseA), false);
  const managerA = sqliteManager(databaseA, {
    store: gatedStore,
    artifacts: counted,
    workspaceScope: workspace,
  });
  const managerB = sqliteManager(databaseB, { workspaceScope: workspace });
  try {
    const session = await managerA.createSession({ cwd: workspace, model: "idle" });
    blockList = true;
    const staleWrite = managerA.putArtifact({
      sessionId: session.id,
      kind: "report",
      name: "stale.txt",
      data: "must never reach storage",
    });
    await listed.promise;
    await managerB.deleteSession(session.id);
    releaseList.resolve();
    await assert.rejects(() => staleWrite, /deleted|删除/);
    assert.equal(counted.putCalls, 0, "acquire must fail before the artifact side effect");
    assert.deepEqual(await new SqliteArtifactStore(databaseB).list(session.id), []);
  } finally {
    releaseList.resolve();
    managerA.dispose();
    managerB.dispose();
    await databaseB.close();
    await databaseA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("durable lifecycle: queued runtime projection stays inside the producer lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lifecycle-projection-"));
  const file = path.join(root, "runtime.db");
  const databaseA = new SqliteRuntimeDatabase(file);
  const databaseB = new SqliteRuntimeDatabase(file);
  const managerA = sqliteManager(databaseA);
  const managerB = sqliteManager(databaseB);
  const projectionStarted = deferred();
  const releaseProjection = deferred();
  const originalPublish = managerA.outbox.publish.bind(managerA.outbox);
  let blockProjection = true;
  managerA.outbox.publish = async (input) => {
    if (blockProjection && input.type === "session.state") {
      blockProjection = false;
      projectionStarted.resolve();
      await releaseProjection.promise;
    }
    return originalPublish(input);
  };
  let sending: Promise<void> | undefined;
  let deleting: Promise<void> | undefined;
  try {
    const session = await managerA.createSession({ cwd: root, model: "idle" });
    sending = managerA.send(session.id, "project this event");
    await projectionStarted.promise;
    let deleteSettled = false;
    deleting = managerB.deleteSession(session.id).then(() => {
      deleteSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(deleteSettled, false, "delete must drain a queued event projection lease");
    releaseProjection.resolve();
    await Promise.allSettled([sending]);
    await deleting;
    const events = await new SqliteRuntimeEventStore(databaseB).read(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["session.deleted"],
    );
  } finally {
    releaseProjection.resolve();
    await sending?.catch(() => undefined);
    await deleting?.catch(() => undefined);
    managerA.dispose();
    managerB.dispose();
    await databaseB.close();
    await databaseA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("durable lifecycle: an expired late artifact write is compensatingly purged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lifecycle-late-write-"));
  const file = path.join(root, "runtime.db");
  const databaseA = new SqliteRuntimeDatabase(file);
  const databaseB = new SqliteRuntimeDatabase(file);
  const lifecycleA = new DroppedOperationRenewals(new SqliteSessionLifecycleStore(databaseA));
  const delayed = new DelayedArtifactStore(new SqliteArtifactStore(databaseA));
  const managerA = sqliteManager(databaseA, {
    artifacts: delayed,
    lifecycle: lifecycleA,
  });
  const managerB = sqliteManager(databaseB);
  let lateWrite: Promise<unknown> | undefined;
  try {
    const session = await managerA.createSession({ cwd: root, model: "idle" });
    lateWrite = managerA.putArtifact({
      sessionId: session.id,
      kind: "report",
      name: "late.txt",
      data: "LATE_ARTIFACT_CANARY",
    });
    await delayed.started.promise;
    lifecycleA.drop = true;
    // Expire only the producer lease; a tiny shared wall-clock TTL can also expire the unrelated
    // deletion claim under CI scheduler pressure and turn this into a cleanup-ordering test.
    const expired = await databaseA.run((db) =>
      db
        .prepare("UPDATE session_operation_leases SET expires_at = ? WHERE session_id = ?")
        .run(new Date(0).toISOString(), session.id),
    );
    assert.equal(Number(expired.changes), 1, "the delayed producer must own one durable lease");

    await managerB.deleteSession(session.id);
    assert.deepEqual(await new SqliteArtifactStore(databaseB).list(session.id), []);
    delayed.release.resolve();
    await assert.rejects(lateWrite, /lease.*lost/i);

    assert.deepEqual(
      await new SqliteArtifactStore(databaseB).list(session.id),
      [],
      "the old producer's post-delete commit must be removed by compensation",
    );
    await assert.rejects(() => new SqliteRuntimeSessionStore(databaseB).load(session.id));
    const events = await new SqliteRuntimeEventStore(databaseB).read(session.id);
    assert.deepEqual(
      events.map((event) => event.type),
      ["session.deleted"],
    );
  } finally {
    delayed.release.resolve();
    await lateWrite?.catch(() => undefined);
    managerA.dispose();
    managerB.dispose();
    await databaseB.close();
    await databaseA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("durable lifecycle: startup tombstone sweep repairs a late write after producer crash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lifecycle-crashed-writer-"));
  const file = path.join(root, "runtime.db");
  const databaseA = new SqliteRuntimeDatabase(file);
  const databaseB = new SqliteRuntimeDatabase(file);
  const managerA = sqliteManager(databaseA);
  const managerB = sqliteManager(databaseB);
  let restarted: SessionManager | undefined;
  try {
    const session = await managerA.createSession({ cwd: root, model: "idle" });
    await managerB.deleteSession(session.id);
    managerA.dispose();
    managerB.dispose();

    // This bypasses SessionManager deliberately: it models an already-issued S3/HTTP request
    // whose backend commits after the lease expired and whose producer crashes before compensating.
    const backing = new SqliteArtifactStore(databaseA);
    await backing.put({
      sessionId: session.id,
      kind: "report",
      name: "orphan-after-crash.txt",
      data: "LATE_CRASHED_PRODUCER_CANARY",
    });
    assert.equal((await backing.list(session.id)).length, 1);

    restarted = sqliteManager(databaseA);
    const deadline = Date.now() + 2_000;
    while ((await backing.list(session.id)).length !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(
      await backing.list(session.id),
      [],
      "a fresh manager must sweep permanent deleted tombstones without an explicit retry",
    );
    assert.deepEqual(
      (await new SqliteRuntimeEventStore(databaseA).read(session.id)).map((event) => event.type),
      ["session.deleted"],
    );
  } finally {
    managerA.dispose();
    managerB.dispose();
    restarted?.dispose();
    await databaseB.close();
    await databaseA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("durable lifecycle: a restarted deleter rejects a replacement workspace inode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lifecycle-replaced-workspace-"));
  const workspace = path.join(root, "workspace");
  const displaced = path.join(root, "displaced");
  await fs.mkdir(workspace);
  const file = path.join(root, "runtime.db");
  const databaseA = new SqliteRuntimeDatabase(file);
  const databaseB = new SqliteRuntimeDatabase(file);
  const backingArtifacts = new SqliteArtifactStore(databaseA);
  const failingArtifacts: ArtifactStore = {
    put: (input) => backingArtifacts.put(input),
    list: (sessionId) => backingArtifacts.list(sessionId),
    get: (sessionId, artifactId) => backingArtifacts.get(sessionId, artifactId),
    delete: (sessionId, artifactId) => backingArtifacts.delete(sessionId, artifactId),
    async deleteSession() {
      throw new Error("artifact purge unavailable");
    },
  };
  const managerA = sqliteManager(databaseA, {
    artifacts: failingArtifacts,
    workspaceScope: workspace,
  });
  let managerB: SessionManager | undefined;
  try {
    const session = await managerA.createSession({ cwd: workspace, model: "idle" });
    await assert.rejects(() => managerA.deleteSession(session.id), /purge unavailable/);
    assert.equal(
      (await new SqliteSessionLifecycleStore(databaseB).get(session.id))?.state,
      "deleting",
    );
    managerA.dispose();

    await fs.rename(workspace, displaced);
    await fs.mkdir(path.join(workspace, ".anicode", "patchsets"), { recursive: true });
    const canary = path.join(workspace, ".anicode", "patchsets", "REPLACEMENT_CANARY.txt");
    await fs.writeFile(canary, "must survive", "utf8");

    managerB = sqliteManager(databaseB, { workspaceScope: workspace });
    await assert.rejects(
      () => managerB!.deleteSession(session.id),
      /configured scope|配置范围|identity|身份/,
    );
    assert.equal(await fs.readFile(canary, "utf8"), "must survive");
  } finally {
    managerA.dispose();
    managerB?.dispose();
    await databaseB.close();
    await databaseA.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
