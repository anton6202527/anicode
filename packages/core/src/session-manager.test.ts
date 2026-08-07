/**
 * SessionManager 测试：验证 pub/sub 总线的核心承诺 ——
 *   - 多订阅者都收到同一批事件（共享会话/接管的基础）
 *   - 权限请求广播，任一订阅者可裁决
 *   - subscribe 立即回放 snapshot（晚加入者对齐）
 *   - create/resume/list 生命周期
 * 全离线（脚本化 provider）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionEvent } from "./session-manager.js";
import { MigratingSessionStore, SessionStore } from "./session.js";
import { MemoryArtifactStore, type ArtifactStore } from "./runtime/artifacts.js";
import { DurableRuntime, MemoryRuntimeEventStore } from "./runtime/durable.js";
import { CommandInbox, MemoryCommandInboxStore, type DurableCommand } from "./runtime/commands.js";
import type { IsolatedRunRequest } from "./runtime/isolated-runtime.js";
import { PatchSetService } from "./runtime/patchset.js";
import type { Provider, StreamEvent, ChatMessage, StreamRequest } from "./types.js";
import { workspaceExecutionFingerprint } from "./workspace-trust.js";
import {
  RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES,
  RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES,
} from "./tools/index.js";
import { ToolRegistry } from "./tools/tool.js";
import { bindProviderRegistry } from "./provider/registry.js";
import { CredentialBroker, credentialScopesForEnvironment } from "./security/credentials.js";
import type { SyncSecretBackend } from "./security/secret-backends.js";

function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      for (const part of content)
        if (part.type === "text") yield { type: "text_delta", text: part.text };
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 0 },
      };
    },
  };
}

async function mgr(dir: string, provider: Provider) {
  return new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    now: () => 1_700_000_000_000,
    rand: () => 0.5,
  });
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function sessionWorkspaceIdentity(cwd: string): Promise<{ device: string; inode: string }> {
  const stat = await fs.lstat(await fs.realpath(cwd), { bigint: true });
  return { device: String(stat.dev), inode: String(stat.ino) };
}

test("SessionManager: 多订阅者都收到同一批事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const m = await mgr(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "hi there" }] }]]),
  );
  const s = await m.createSession({ cwd: dir, model: "scripted", title: "多订阅" });

  const a: SessionEvent[] = [];
  const b: SessionEvent[] = [];
  const subA = await m.open(s.id, (ev) => a.push(ev));
  const subB = await m.open(s.id, (ev) => b.push(ev));

  await m.send(s.id, "hello");

  // 两个订阅者都拿到 state(running) + agent 文本 + done
  const textOf = (arr: SessionEvent[]) =>
    arr
      .filter((e) => e.type === "agent" && e.event.type === "text")
      .map((e: any) => e.event.text)
      .join("");
  assert.equal(textOf(a), "hi there");
  assert.equal(textOf(b), "hi there");
  assert.ok(a.some((e) => e.type === "state" && e.running === true));
  assert.ok(a.some((e) => e.type === "state" && e.running === false));
  assert.ok(a.some((e) => e.type === "agent" && e.event.type === "done"));
  assert.ok(b.some((e) => e.type === "agent" && e.event.type === "done"));

  subA.close();
  subB.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: oversized UTF-8 input is rejected before provider dispatch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-input-bound-"));
  let providerCalls = 0;
  const provider: Provider = {
    name: "input-bound",
    async *stream(): AsyncIterable<StreamEvent> {
      providerCalls++;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [] },
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = await mgr(dir, provider);
  try {
    const session = await manager.createSession({ cwd: dir, model: "input-bound" });
    const oversized = "界".repeat(Math.floor((8 * 1024 * 1024) / 3) + 1);
    await assert.rejects(manager.send(session.id, oversized), /8388608 bytes/);
    assert.equal(providerCalls, 0);
    assert.equal(manager.peek(session.id)?.messages.length, 0);
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: send re-entered synchronously from abort belongs to the next drive", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-abort-reentry-"));
  const firstStarted = deferred();
  type ManagedSessionHarness = {
    send(text: string): Promise<{ error?: Error }>;
    interrupt(): void;
  };
  let managed!: ManagedSessionHarness;
  let reentrant: Promise<{ error?: Error }> | undefined;
  let providerCalls = 0;
  const done = (text: string): StreamEvent => ({
    type: "done",
    stopReason: "end_turn",
    message: { role: "assistant", content: [{ type: "text", text }] },
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  });
  const provider: Provider = {
    name: "abort-reentry",
    async *stream(request): AsyncIterable<StreamEvent> {
      providerCalls++;
      if (providerCalls === 1) {
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          const onAbort = () => {
            reentrant = managed.send("after interrupt");
            resolve();
          };
          request.signal?.addEventListener("abort", onAbort, { once: true });
          if (request.signal?.aborted) onAbort();
        });
        yield done("late first reply");
        return;
      }
      yield done("second reply");
    },
  };
  const manager = await mgr(dir, provider);
  try {
    const session = await manager.createSession({ cwd: dir, model: "abort-reentry" });
    managed = (manager as unknown as { sessions: Map<string, ManagedSessionHarness> }).sessions.get(
      session.id,
    )!;
    const first = managed.send("before interrupt");
    await firstStarted.promise;
    managed.interrupt();
    await first;
    assert.ok(reentrant, "AbortSignal listener must synchronously enqueue the next drive");
    assert.deepEqual(await reentrant, {});
    assert.equal(providerCalls, 2);
    const visibleText = manager
      .peek(session.id)!
      .messages.flatMap((message) =>
        message.content.flatMap((part) =>
          part.type === "text" && !part.internal ? [part.text] : [],
        ),
      );
    assert.ok(visibleText.includes("after interrupt"));
    assert.ok(visibleText.includes("second reply"));
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: snapshot 权限模式反映初始配置与运行时切换", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-permission-mode-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    permission: { mode: "acceptEdits" },
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "scripted" });
    assert.equal((await manager.resumeSession(session.id)).permissionMode, "acceptEdits");

    await manager.setPermissionMode(session.id, "plan");
    assert.equal(manager.peek(session.id)?.permissionMode, "plan");
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: snapshot reports actual network tool readiness without probing credentials", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-network-tools-"));
  const ready = new SessionManager({
    store: new SessionStore(path.join(dir, "ready")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    webSearch: async () => [],
    webSearchProvider: "tavily",
    webSearchDisabledReason: "credential_not_configured",
  });
  const disabled = new SessionManager({
    store: new SessionStore(path.join(dir, "disabled")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    tools: () => new ToolRegistry(),
    webSearchDisabledReason: "credential_not_configured",
  });
  try {
    const readySession = await ready.createSession({ cwd: dir, model: "scripted" });
    assert.deepEqual(ready.peek(readySession.id)?.networkTools, {
      webSearch: { state: "ready", provider: "tavily" },
      webFetch: { state: "ready" },
    });

    const disabledSession = await disabled.createSession({ cwd: dir, model: "scripted" });
    assert.deepEqual(disabled.peek(disabledSession.id)?.networkTools, {
      webSearch: { state: "disabled", reason: "credential_not_configured" },
      webFetch: { state: "disabled", reason: "host_disabled" },
    });
  } finally {
    ready.dispose();
    disabled.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: workspace scope 以 canonical cwd 隔离 list/create/load/fork", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-scope-"));
  const workspaceA = path.join(dir, "workspace-a");
  const workspaceB = path.join(dir, "workspace-b");
  const aliasA = path.join(dir, "workspace-a-alias");
  await fs.mkdir(workspaceA);
  await fs.mkdir(workspaceB);
  await fs.symlink(workspaceA, aliasA, process.platform === "win32" ? "junction" : "dir");
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({
    id: "scope-a",
    cwd: workspaceA,
    workspaceIdentity: await sessionWorkspaceIdentity(workspaceA),
    model: "scripted",
  });
  await store.create({
    id: "scope-b",
    cwd: workspaceB,
    workspaceIdentity: await sessionWorkspaceIdentity(workspaceB),
    model: "scripted",
  });
  const loadedSessionIds: string[] = [];
  const originalLoad = store.load.bind(store);
  store.load = async (id) => {
    loadedSessionIds.push(id);
    return originalLoad(id);
  };
  let providerResolutions = 0;
  const manager = new SessionManager({
    store,
    workspaceScope: aliasA,
    resolveProvider: () => {
      providerResolutions++;
      return { provider: scriptedProvider([]), model: "scripted" };
    },
    recoverCommands: false,
  });
  try {
    assert.deepEqual(
      (await manager.listSessions()).map((session) => session.id),
      ["scope-a"],
      "foreign session metadata must not be disclosed",
    );

    const resumed = await manager.resumeSession("scope-a");
    assert.equal(resumed.meta.cwd, await fs.realpath(workspaceA));
    const resolutionsBeforeForeignLoad = providerResolutions;
    await assert.rejects(() => manager.resumeSession("scope-b"), /配置范围|configured scope/);
    assert.deepEqual(
      loadedSessionIds,
      ["scope-a"],
      "foreign transcript body must not be loaded after metadata preflight rejects it",
    );
    assert.equal(
      providerResolutions,
      resolutionsBeforeForeignLoad,
      "foreign load must be rejected before provider construction",
    );

    const countBeforeRejectedCreate = (await store.list()).length;
    await assert.rejects(
      () => manager.createSession({ cwd: workspaceB, model: "scripted" }),
      /配置范围|configured scope/,
    );
    assert.equal((await store.list()).length, countBeforeRejectedCreate);
    assert.equal(
      providerResolutions,
      resolutionsBeforeForeignLoad,
      "foreign create must be rejected before provider construction",
    );

    const viaAlias = await manager.createSession({ cwd: aliasA, model: "scripted" });
    assert.equal(viaAlias.cwd, await fs.realpath(workspaceA), "accepted aliases are canonicalized");
    const fork = await manager.forkSession("scope-a", { title: "scoped fork" });
    assert.equal(fork.cwd, await fs.realpath(workspaceA));
    assert.deepEqual(
      new Set((await manager.listSessions()).map((session) => session.id)),
      new Set(["scope-a", viaAlias.id, fork.id]),
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: scoped listing authorizes legacy metadata before lazy transcript migration", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-lazy-migration-"));
  const workspace = path.join(dir, "workspace");
  const foreignWorkspace = path.join(dir, "foreign-workspace");
  await fs.mkdir(workspace);
  await fs.mkdir(foreignWorkspace);
  const primary = new SessionStore(path.join(dir, "primary"));
  const legacy = new SessionStore(path.join(dir, "legacy"));
  const ownedMeta = await legacy.create({
    id: "legacy-owned",
    cwd: workspace,
    workspaceIdentity: await sessionWorkspaceIdentity(workspace),
    model: "scripted",
  });
  await legacy.append(ownedMeta.id, {
    role: "user",
    content: [{ type: "text", text: "owned transcript" }],
  });
  const foreignMeta = await legacy.create({
    id: "legacy-foreign",
    cwd: foreignWorkspace,
    workspaceIdentity: await sessionWorkspaceIdentity(foreignWorkspace),
    model: "scripted",
  });
  await legacy.append(foreignMeta.id, {
    role: "user",
    content: [{ type: "text", text: "foreign secret transcript" }],
  });

  const loadedLegacyIds: string[] = [];
  const legacyLoad = legacy.load.bind(legacy);
  legacy.load = async (id) => {
    loadedLegacyIds.push(id);
    return legacyLoad(id);
  };
  const migrating = new MigratingSessionStore(primary, legacy);
  await assert.rejects(
    () =>
      migrating.create({
        id: foreignMeta.id,
        cwd: workspace,
        workspaceIdentity: ownedMeta.workspaceIdentity!,
        model: "scripted",
      }),
    /already exists/,
  );
  assert.deepEqual(loadedLegacyIds, [], "a create collision must not import the legacy body");

  await primary.create({
    id: "cross-owner-collision",
    cwd: workspace,
    workspaceIdentity: ownedMeta.workspaceIdentity!,
    model: "scripted",
  });
  await legacy.create({
    id: "cross-owner-collision",
    cwd: foreignWorkspace,
    workspaceIdentity: foreignMeta.workspaceIdentity!,
    model: "scripted",
  });
  await migrating.delete("cross-owner-collision");
  assert.ok(
    (await legacy.list()).some((meta) => meta.id === "cross-owner-collision"),
    "deleting a primary id must preserve a same-id legacy record owned by another workspace",
  );
  assert.deepEqual(loadedLegacyIds, [], "collision handling must stay metadata-only");
  const manager = new SessionManager({
    store: migrating,
    workspaceScope: workspace,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  try {
    assert.deepEqual(
      (await manager.listSessions()).map((session) => session.id),
      [ownedMeta.id],
    );
    assert.deepEqual(loadedLegacyIds, [], "list must inspect legacy metadata only");

    await assert.rejects(() => manager.resumeSession(foreignMeta.id), /配置范围|configured scope/);
    assert.deepEqual(
      loadedLegacyIds,
      [],
      "foreign legacy transcript must be rejected before migration reads its body",
    );
    assert.deepEqual(await primary.list(), [], "foreign legacy record must not enter primary");

    const resumed = await manager.resumeSession(ownedMeta.id);
    assert.equal(resumed.messages.length, 1);
    assert.deepEqual(loadedLegacyIds, [ownedMeta.id]);
    assert.deepEqual(
      (await primary.list()).map((session) => session.id),
      [ownedMeta.id],
      "only the authorized session is migrated",
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 同路径目录替换不能继承旧 scope 或旧会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-scope-identity-"));
  const workspace = path.join(dir, "workspace");
  const displaced = path.join(dir, "displaced-workspace");
  const store = new SessionStore(path.join(dir, "sessions"));
  await fs.mkdir(workspace);
  const original = new SessionManager({
    store,
    workspaceScope: workspace,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  try {
    const created = await original.createSession({ cwd: workspace, model: "scripted" });
    assert.ok(created.workspaceIdentity);

    await fs.rename(workspace, displaced);
    await fs.mkdir(workspace);

    await assert.rejects(() => original.listSessions(), /配置范围|configured scope/);
    await assert.rejects(() => original.resumeSession(created.id), /配置范围|configured scope/);

    const replacement = new SessionManager({
      store,
      workspaceScope: workspace,
      resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
      recoverCommands: false,
    });
    try {
      assert.deepEqual(await replacement.listSessions(), []);
      await assert.rejects(
        () => replacement.resumeSession(created.id),
        /配置范围|configured scope/,
      );
      await assert.rejects(
        () => replacement.deleteSession(created.id),
        /配置范围|configured scope/,
      );
    } finally {
      replacement.dispose();
    }
  } finally {
    original.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: scoped artifact/runtime/delete APIs preflight ownership before side effects", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-scope-api-"));
  const workspace = path.join(dir, "workspace");
  const foreignWorkspace = path.join(dir, "foreign-workspace");
  await fs.mkdir(workspace);
  await fs.mkdir(foreignWorkspace);
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({
    id: "scope-owned",
    cwd: workspace,
    workspaceIdentity: await sessionWorkspaceIdentity(workspace),
    model: "scripted",
  });
  await store.create({
    id: "scope-foreign",
    cwd: foreignWorkspace,
    workspaceIdentity: await sessionWorkspaceIdentity(foreignWorkspace),
    model: "scripted",
  });

  const backingArtifacts = new MemoryArtifactStore();
  const ownedArtifact = await backingArtifacts.put({
    sessionId: "scope-owned",
    kind: "report",
    name: "owned.txt",
    data: "owned",
  });
  const foreignArtifact = await backingArtifacts.put({
    sessionId: "scope-foreign",
    kind: "report",
    name: "foreign.txt",
    data: "FOREIGN_ARTIFACT_CANARY",
  });
  const artifactCalls = { put: 0, list: 0, get: 0, delete: 0, deleteSession: 0 };
  const artifacts: ArtifactStore = {
    async put(input) {
      artifactCalls.put++;
      return backingArtifacts.put(input);
    },
    async list(sessionId) {
      artifactCalls.list++;
      return backingArtifacts.list(sessionId);
    },
    async get(sessionId, artifactId) {
      artifactCalls.get++;
      return backingArtifacts.get(sessionId, artifactId);
    },
    async delete(sessionId, artifactId) {
      artifactCalls.delete++;
      return backingArtifacts.delete(sessionId, artifactId);
    },
    async deleteSession(sessionId) {
      artifactCalls.deleteSession++;
      return backingArtifacts.deleteSession(sessionId);
    },
  };

  const runtimeStore = new MemoryRuntimeEventStore();
  await runtimeStore.append({
    streamId: "scope-owned",
    type: "owned.canary",
    data: { visible: true },
  });
  await runtimeStore.append({
    streamId: "scope-foreign",
    type: "foreign.canary",
    data: { secret: "FOREIGN_RUNTIME_CANARY" },
  });
  const runtime = new DurableRuntime(runtimeStore);
  const runtimeCalls = { events: 0, recover: 0, deleteStream: 0, record: 0 };
  const originalEvents = runtime.events.bind(runtime);
  const originalRecover = runtime.recover.bind(runtime);
  const originalDeleteStream = runtime.deleteStream.bind(runtime);
  const originalRecord = runtime.record.bind(runtime);
  runtime.events = (sessionId, afterSequence) => {
    runtimeCalls.events++;
    return originalEvents(sessionId, afterSequence);
  };
  runtime.recover = async (sessionId) => {
    runtimeCalls.recover++;
    return originalRecover(sessionId);
  };
  runtime.deleteStream = async (sessionId) => {
    runtimeCalls.deleteStream++;
    return originalDeleteStream(sessionId);
  };
  runtime.record = async (input) => {
    runtimeCalls.record++;
    return originalRecord(input);
  };

  let storeDeletes = 0;
  const originalStoreDelete = store.delete.bind(store);
  store.delete = async (sessionId) => {
    storeDeletes++;
    return originalStoreDelete(sessionId);
  };
  const manager = new SessionManager({
    store,
    workspaceScope: workspace,
    artifacts,
    runtime,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  try {
    const foreignCalls: Array<() => Promise<unknown>> = [
      () => manager.listArtifacts("scope-foreign"),
      () => manager.getArtifact("scope-foreign", foreignArtifact.id),
      () => manager.openArtifact("scope-foreign", foreignArtifact.id),
      () => manager.deleteArtifact("scope-foreign", foreignArtifact.id),
      () =>
        manager.putArtifact({
          sessionId: "scope-foreign",
          kind: "report",
          name: "must-not-write.txt",
          data: "must not write",
        }),
      () => manager.runtimeEvents("scope-foreign"),
      () => manager.recoverRuntime("scope-foreign"),
      () => manager.deleteSession("scope-foreign"),
    ];
    for (const call of foreignCalls) {
      await assert.rejects(call, /配置范围|configured scope/);
    }
    assert.deepEqual(
      artifactCalls,
      { put: 0, list: 0, get: 0, delete: 0, deleteSession: 0 },
      "foreign artifact APIs must be rejected before touching the artifact store",
    );
    assert.deepEqual(
      runtimeCalls,
      { events: 0, recover: 0, deleteStream: 0, record: 0 },
      "foreign runtime APIs and deletion must be rejected before touching runtime state",
    );
    assert.equal(storeDeletes, 0, "foreign delete must not mutate the session store");

    assert.deepEqual(
      (await manager.listArtifacts("scope-owned")).map((artifact) => artifact.id),
      [ownedArtifact.id],
    );
    assert.equal(
      Buffer.from((await manager.getArtifact("scope-owned", ownedArtifact.id))!.data).toString(),
      "owned",
    );
    const opened = await manager.openArtifact("scope-owned", ownedArtifact.id);
    assert.ok(opened);
    const openedChunks: Uint8Array[] = [];
    for await (const chunk of opened.data) openedChunks.push(chunk);
    assert.equal(Buffer.concat(openedChunks).toString(), "owned");
    assert.equal((await manager.runtimeEvents("scope-owned"))[0]?.type, "owned.canary");
    assert.equal((await manager.recoverRuntime("scope-owned")).streamId, "scope-owned");

    const releasePreflight = deferred();
    const preflightStarted = deferred();
    const originalStoreList = store.list.bind(store);
    let blockNextPreflight = true;
    store.list = async () => {
      const listed = await originalStoreList();
      if (blockNextPreflight) {
        blockNextPreflight = false;
        preflightStarted.resolve();
        await releasePreflight.promise;
      }
      return listed;
    };
    const firstDeletion = manager.deleteSession("scope-owned");
    const secondDeletion = manager.deleteSession("scope-owned");
    assert.strictEqual(secondDeletion, firstDeletion, "concurrent deletes must share one task");
    await preflightStarted.promise;
    assert.equal(storeDeletes, 0, "deletion fence and purge must wait for scope preflight");
    releasePreflight.resolve();
    await Promise.all([firstDeletion, secondDeletion]);
    assert.equal(storeDeletes, 1, "the shared deletion task must purge the session once");
    assert.equal(runtimeCalls.deleteStream, 1);
    assert.equal(artifactCalls.deleteSession, 1, "same-scope deletion must purge its artifacts");

    const callsAfterDelete = {
      artifact: { ...artifactCalls },
      runtime: { ...runtimeCalls },
      storeDeletes,
    };
    await manager.deleteSession("scope-owned");
    assert.deepEqual(
      { artifact: artifactCalls, runtime: runtimeCalls, storeDeletes },
      callsAfterDelete,
      "repeated authorized deletion must be idempotent after metadata is purged",
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: workspace scope realpath 检查失败时 fail closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-scope-fail-"));
  const workspace = path.join(dir, "workspace");
  const missingWorkspace = path.join(dir, "missing-workspace");
  await fs.mkdir(workspace);
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({ id: "missing-cwd", cwd: missingWorkspace, model: "scripted" });
  let providerResolutions = 0;
  const manager = new SessionManager({
    store,
    workspaceScope: workspace,
    resolveProvider: () => {
      providerResolutions++;
      return { provider: scriptedProvider([]), model: "scripted" };
    },
    recoverCommands: false,
  });
  const brokenScopeManager = new SessionManager({
    store,
    workspaceScope: path.join(dir, "missing-scope"),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  try {
    assert.deepEqual(await manager.listSessions(), [], "uninspectable session cwd is hidden");
    await assert.rejects(
      () => manager.resumeSession("missing-cwd"),
      /无法安全检查|Cannot securely inspect/,
    );
    await assert.rejects(
      () => manager.createSession({ cwd: missingWorkspace, model: "scripted" }),
      /无法安全检查|Cannot securely inspect/,
    );
    assert.equal(providerResolutions, 0);
    assert.equal((await store.list()).length, 1, "rejected operations must not mutate the store");
    await assert.rejects(
      () => brokenScopeManager.listSessions(),
      /无法安全检查|Cannot securely inspect/,
    );
  } finally {
    manager.dispose();
    brokenScopeManager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 未信任 cwd 的 default 模式启用受审计开发工具并封死项目执行面", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-"));
  const workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "AGENTS.md"), "UNTRUSTED_MEMORY_SENTINEL");
  let captured: StreamRequest | undefined;
  let assessments = 0;
  const provider: Provider = {
    name: "capture-trust-boundary",
    async *stream(request): AsyncIterable<StreamEvent> {
      captured = request;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const trust = async () => {
    assessments++;
    return {
      trusted: false as const,
      reason: "not-trusted" as const,
      executionSources: ["AGENTS.md"],
      storeFile: path.join(dir, "trust.json"),
      assessedAt: new Date().toISOString(),
    };
  };
  const store = new SessionStore(path.join(dir, "sessions"));
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider, model: "capture" }),
    workspaceTrust: trust,
    permission: { mode: "default" },
    permissionProfile: "full",
    persistPermissions: true,
    projectMemory: true,
    checkpoints: true,
    repoMap: true,
    skills: true,
    subagents: { discover: true },
    browser: true,
  });
  try {
    const session = await manager.createSession({ cwd: workspace, model: "capture" });
    assert.equal(assessments, 1, "createSession 必须按 cwd 评估 trust");
    assert.equal(manager.peek(session.id)?.workspaceTrust?.reason, "not-trusted");
    assert.deepEqual(manager.peek(session.id)?.networkTools, {
      webSearch: { state: "disabled", reason: "workspace_restricted" },
      webFetch: { state: "disabled", reason: "workspace_restricted" },
    });
    await manager.send(session.id, "inspect only");
    assert.ok(captured);
    assert.deepEqual(
      (captured.tools ?? []).map((tool) => tool.name).sort(),
      [...RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES].sort(),
    );
    const restrictedBash = (captured.tools ?? []).find((tool) => tool.name === "bash");
    assert.ok(restrictedBash);
    assert.equal(
      Object.hasOwn(
        (restrictedBash.parameters["properties"] ?? {}) as Record<string, unknown>,
        "network",
      ),
      false,
      "restricted bash schema must not advertise network access",
    );
    assert.doesNotMatch(captured.system ?? "", /UNTRUSTED_MEMORY_SENTINEL/);
    assert.deepEqual(await manager.listCheckpoints(session.id), []);
    await manager.setPermissionMode(session.id, "plan");
    await manager.setPermissionMode(session.id, "default");
    for (const mode of ["acceptEdits", "auto", "bypass"] as const) {
      await assert.rejects(
        () => manager.setPermissionMode(session.id, mode),
        /only support default and plan|仅支持普通与计划/,
      );
    }
    await assert.rejects(
      () => manager.setPermissionProfile(session.id, "full"),
      /Cannot apply permission profile "full" in an untrusted workspace|未信任.*权限档位/,
    );
    assert.deepEqual(await manager.listPermissionProfiles(session.id), {});
    await assert.rejects(
      () => manager.preparePatchSet(session.id, [{ path: "owned.txt", content: "blocked" }]),
      /PatchSet|Untrusted workspace|未信任/,
    );

    manager.dispose();
    const assessmentsBeforeReload = assessments;
    const reloaded = new SessionManager({
      store,
      resolveProvider: () => ({ provider, model: "capture" }),
      workspaceTrust: trust,
    });
    await reloaded.resumeSession(session.id);
    assert.equal(
      assessments,
      assessmentsBeforeReload + 1,
      "冷会话 ensureLive 必须重新按持久化 cwd 评估 trust",
    );
    reloaded.dispose();
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 未信任 cwd 的非 default 启动模式退回只读 plan，避免无人授权入口逃逸", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-headless-"));
  try {
    for (const requestedMode of ["acceptEdits", "auto", "bypass"] as const) {
      let captured: StreamRequest | undefined;
      const provider: Provider = {
        name: `capture-${requestedMode}`,
        async *stream(request): AsyncIterable<StreamEvent> {
          captured = request;
          yield {
            type: "done",
            stopReason: "end_turn",
            message: { role: "assistant", content: [{ type: "text", text: "restricted" }] },
            usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
          };
        },
      };
      const manager = new SessionManager({
        store: new SessionStore(path.join(dir, `sessions-${requestedMode}`)),
        resolveProvider: () => ({ provider, model: "capture" }),
        workspaceTrust: async () => ({
          trusted: false,
          reason: "not-trusted",
          executionSources: [],
          storeFile: path.join(dir, "trust.json"),
          assessedAt: new Date().toISOString(),
        }),
        permission: { mode: requestedMode },
      });
      try {
        const session = await manager.createSession({ cwd: dir, model: "capture" });
        await manager.send(session.id, "headless inspect");
        assert.deepEqual(
          (captured?.tools ?? []).map((tool) => tool.name).sort(),
          [...RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES].sort(),
          requestedMode,
        );
        await manager.setPermissionMode(session.id, "plan");
        await assert.rejects(
          () => manager.setPermissionMode(session.id, "default"),
          /locked to plan mode|锁定为计划模式/,
        );
      } finally {
        manager.dispose();
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 显式关闭受限开发能力优先于 legacy default-mode 推断", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-no-dev-intent-"));
  let captured: StreamRequest | undefined;
  const provider: Provider = {
    name: "capture-no-dev-intent",
    async *stream(request): AsyncIterable<StreamEvent> {
      captured = request;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "restricted" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "capture" }),
    workspaceTrust: async () => ({
      trusted: false,
      reason: "not-trusted",
      executionSources: [],
      storeFile: path.join(dir, "trust.json"),
      assessedAt: new Date().toISOString(),
    }),
    permission: { mode: "default" },
    allowRestrictedWorkspaceDevelopment: false,
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "capture" });
    assert.equal(manager.peek(session.id)?.permissionMode, "plan");
    await manager.send(session.id, "inspect only");
    assert.deepEqual(
      (captured?.tools ?? []).map((tool) => tool.name).sort(),
      [...RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES].sort(),
    );
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 显式交互能力让高权限会话在 trust 撤销后降为 restricted default+confirm", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-interactive-intent-"));
  const fingerprint = await workspaceExecutionFingerprint(dir);
  let granted = true;
  let turn = 0;
  const requests: StreamRequest[] = [];
  const provider: Provider = {
    name: "capture-interactive-intent",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      const content: ChatMessage["content"] =
        turn++ === 0
          ? [
              {
                type: "tool_call",
                id: "write-after-revoke",
                name: "write",
                args: { path: "must-not-exist.txt", content: "blocked" },
              },
            ]
          : [{ type: "text", text: "permission handled" }];
      yield {
        type: "done",
        stopReason: content.some((part) => part.type === "tool_call") ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "capture" }),
    workspaceTrust: async () => ({
      trusted: granted,
      reason: granted ? ("trusted" as const) : ("not-trusted" as const),
      identity: fingerprint.identity,
      executionHash: fingerprint.executionHash,
      executionSources: fingerprint.executionSources,
      storeFile: path.join(dir, "trust.json"),
      assessedAt: new Date().toISOString(),
    }),
    permission: { mode: "bypass" },
    allowRestrictedWorkspaceDevelopment: true,
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "capture" });
    const events: SessionEvent[] = [];
    const opened = await manager.open(session.id, (event) => {
      events.push(event);
      if (event.type === "permission_request") {
        void manager.answerPermission(session.id, event.permId, "deny");
      }
    });
    assert.equal(opened.snapshot.permissionMode, "bypass");

    granted = false;
    const restricted = await manager.resumeSession(session.id);
    assert.equal(restricted.workspaceTrust?.trusted, false);
    assert.equal(restricted.permissionMode, "default");

    await manager.send(session.id, "attempt a write after trust was revoked");
    assert.deepEqual(
      (requests[0]?.tools ?? []).map((tool) => tool.name).sort(),
      [...RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES].sort(),
    );
    assert.ok(
      events.some(
        (event) => event.type === "permission_request" && event.permId === "write-after-revoke",
      ),
      "restricted default must route side effects through the interactive confirmation callback",
    );
    assert.equal(
      await fs.stat(path.join(dir, "must-not-exist.txt")).catch(() => undefined),
      undefined,
    );
    opened.close();
  } finally {
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 未信任 auto+ask 的只读调用不请求授权、不挂起，deny 仍优先", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-headless-ask-"));
  await fs.writeFile(path.join(dir, "safe.txt"), "safe");
  await fs.writeFile(path.join(dir, "secret.txt"), "secret");
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "read-safe", name: "read", args: { path: "safe.txt" } }],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "safe read handled" }] }],
    [
      {
        role: "assistant",
        content: [
          { type: "tool_call", id: "read-denied", name: "read", args: { path: "secret.txt" } },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "denied read handled" }] }],
  ]);
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    workspaceTrust: async () => ({
      trusted: false,
      reason: "not-trusted",
      executionSources: [],
      storeFile: path.join(dir, "trust.json"),
      assessedAt: new Date().toISOString(),
    }),
    permission: {
      mode: "auto",
      allowRules: ["Read(*)"],
      askRules: ["Read(*)"],
      denyRules: ["Read(secret.txt)"],
    },
  });
  let sendPromise: Promise<void> | undefined;
  try {
    const session = await manager.createSession({ cwd: dir, model: "scripted" });
    const events: SessionEvent[] = [];
    let reportPermission!: () => void;
    const permissionSeen = new Promise<"permission">((resolve) => {
      reportPermission = () => resolve("permission");
    });
    await manager.open(session.id, (event) => {
      events.push(event);
      if (event.type === "permission_request") reportPermission();
    });

    sendPromise = manager.send(session.id, "read safe without an authorization UI");
    const outcome = await Promise.race([sendPromise.then(() => "done" as const), permissionSeen]);
    assert.equal(outcome, "done", "auto fallback must not wait for an authorization response");
    assert.equal(
      events.some((event) => event.type === "permission_request"),
      false,
    );

    await manager.send(session.id, "deny remains authoritative");
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent" &&
          event.event.type === "tool_result" &&
          event.event.id === "read-denied" &&
          event.event.isError,
      ),
      "denyRules must remain active in the headless plan fallback",
    );
    assert.equal(
      events.some((event) => event.type === "permission_request"),
      false,
    );
  } finally {
    manager.dispose();
    await sendPromise?.catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 未信任 default 下 write/bash 仍请求授权，bash 强制离线沙箱且 deny 优先", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-permission-"));
  const runtimeRequests: IsolatedRunRequest[] = [];
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "write-default",
            name: "write",
            args: { path: "must-not-exist.txt", content: "blocked" },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "write handled" }] }],
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "write-allowed",
            name: "write",
            args: { path: "allowed.txt", content: "written" },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "allowed write handled" }] }],
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "bash-default",
            name: "bash",
            args: { command: "printf safe", network: true },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "bash handled" }] }],
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "write-plan",
            name: "write",
            args: { path: "plan-must-not-exist.txt", content: "blocked" },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "plan handled" }] }],
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "bash-denied",
            name: "bash",
            args: { command: "blocked command" },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "deny handled" }] }],
  ]);
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    workspaceTrust: async () => ({
      trusted: false,
      reason: "not-trusted",
      executionSources: [],
      storeFile: path.join(dir, "trust.json"),
      assessedAt: new Date().toISOString(),
    }),
    permission: { mode: "default", denyRules: ["Bash(blocked *)"] },
    isolatedRuntime: {
      async run(request) {
        runtimeRequests.push(request);
        return {
          exitCode: 0,
          output: "safe",
          timedOut: false,
          sandboxed: true,
          durationMs: 1,
        };
      },
    },
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "scripted" });
    const permissions: Array<{ permId: string; toolName: string }> = [];
    await manager.open(session.id, (event) => {
      if (event.type !== "permission_request") return;
      permissions.push({ permId: event.permId, toolName: event.toolName });
      void manager.answerPermission(
        session.id,
        event.permId,
        event.toolName === "bash" || event.permId === "write-allowed" ? "allow" : "deny",
      );
    });

    await manager.send(session.id, "try write");
    assert.equal(
      await fs.stat(path.join(dir, "must-not-exist.txt")).catch(() => undefined),
      undefined,
    );

    await manager.send(session.id, "allow one write");
    assert.equal(await fs.readFile(path.join(dir, "allowed.txt"), "utf8"), "written");

    await manager.send(session.id, "run bash offline");
    assert.equal(runtimeRequests.length, 1);
    assert.equal(runtimeRequests[0]?.network, false);
    assert.equal(runtimeRequests[0]?.policy, "workspace-write");

    await manager.setPermissionMode(session.id, "plan");
    await manager.send(session.id, "plan cannot write");
    assert.equal(
      await fs.stat(path.join(dir, "plan-must-not-exist.txt")).catch(() => undefined),
      undefined,
    );

    await manager.setPermissionMode(session.id, "default");
    await manager.send(session.id, "configured deny wins");
    assert.deepEqual(
      permissions.map((permission) => permission.toolName),
      ["write", "write", "bash"],
      "plan denial and configured deny must not reach interactive confirmation",
    );
    assert.equal(runtimeRequests.length, 1, "configured deny must block bash before execution");
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 交互能力也不能放宽 inspection-failed；projectMemory=false 透传给 Agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-fail-"));
  await fs.writeFile(path.join(dir, "AGENTS.md"), "MEMORY_MUST_NOT_LOAD");
  let captured: StreamRequest | undefined;
  const provider: Provider = {
    name: "capture-trust-failure",
    async *stream(request): AsyncIterable<StreamEvent> {
      captured = request;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "capture" }),
    workspaceTrust: async () => {
      throw new Error("trust backend unavailable");
    },
    permission: { mode: "bypass" },
    allowRestrictedWorkspaceDevelopment: true,
    projectMemory: false,
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "capture" });
    assert.equal(manager.peek(session.id)?.workspaceTrust?.reason, "inspection-failed");
    assert.equal(manager.peek(session.id)?.permissionMode, "plan");
    assert.match(manager.peek(session.id)?.workspaceTrust?.error ?? "", /backend unavailable/);
    await manager.send(session.id, "hello");
    assert.doesNotMatch(captured?.system ?? "", /MEMORY_MUST_NOT_LOAD/);
    assert.deepEqual(
      (captured?.tools ?? []).map((tool) => tool.name).sort(),
      [...RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES].sort(),
    );
    await assert.rejects(
      () => manager.setPermissionMode(session.id, "default"),
      /locked to plan mode|锁定为计划模式/,
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: live 会话在新 drive 前刷新 trust，授权/配置变化会重建安全边界", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-refresh-"));
  await fs.writeFile(path.join(dir, "AGENTS.md"), "TRUST_REFRESH_MEMORY_SENTINEL");
  const fingerprint = await workspaceExecutionFingerprint(dir);
  let granted = false;
  const requests: StreamRequest[] = [];
  const reconciled: boolean[] = [];
  const provider: Provider = {
    name: "capture-trust-refresh",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      yield { type: "text_delta", text: `answer-${requests.length}` };
      yield {
        type: "done",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `answer-${requests.length}` }],
        },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "capture" }),
    workspaceTrust: async () => ({
      trusted: granted,
      reason: granted ? ("trusted" as const) : ("not-trusted" as const),
      identity: fingerprint.identity,
      executionHash: fingerprint.executionHash,
      executionSources: fingerprint.executionSources,
      storeFile: path.join(dir, "trust.json"),
      assessedAt: new Date().toISOString(),
    }),
    onWorkspaceTrustChange: async ({ current }) => {
      reconciled.push(current.trusted);
    },
    projectMemory: true,
  });
  try {
    const created = await manager.createSession({ cwd: dir, model: "capture" });
    const observed: SessionEvent[] = [];
    const opened = await manager.open(created.id, (event) => observed.push(event));

    await manager.send(created.id, "restricted");
    assert.deepEqual(
      (requests[0]?.tools ?? []).map((tool) => tool.name).sort(),
      [...RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES].sort(),
    );
    assert.doesNotMatch(requests[0]?.system ?? "", /TRUST_REFRESH_MEMORY_SENTINEL/);

    granted = true;
    await manager.send(created.id, "now trusted");
    assert.deepEqual(reconciled, [true]);
    assert.equal(manager.peek(created.id)?.workspaceTrust?.trusted, true);
    assert.ok((requests[1]?.tools ?? []).some((tool) => tool.name === "bash"));
    assert.match(requests[1]?.system ?? "", /TRUST_REFRESH_MEMORY_SENTINEL/);

    await fs.mkdir(path.join(dir, ".anicode"));
    await fs.writeFile(
      path.join(dir, ".anicode", "anicode.json"),
      JSON.stringify({ hooks: { PreToolUse: [{ command: "attacker-controlled" }] } }),
    );
    await manager.send(created.id, "config changed");
    assert.deepEqual(reconciled, [true, false]);
    assert.equal(manager.peek(created.id)?.workspaceTrust?.trusted, false);
    assert.equal(manager.peek(created.id)?.workspaceTrust?.reason, "execution-config-changed");
    assert.deepEqual(
      (requests[2]?.tools ?? []).map((tool) => tool.name).sort(),
      [...RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES].sort(),
    );
    assert.doesNotMatch(requests[2]?.system ?? "", /TRUST_REFRESH_MEMORY_SENTINEL/);
    assert.deepEqual(
      observed
        .filter((event) => event.type === "workspace_trust")
        .map((event) => (event.type === "workspace_trust" ? event.assessment.trusted : undefined)),
      [true, false],
    );

    const observedText = observed
      .filter((event) => event.type === "agent" && event.event.type === "text")
      .map((event) =>
        event.type === "agent" && event.event.type === "text" ? event.event.text : "",
      )
      .join("");
    assert.match(observedText, /answer-1/);
    assert.match(observedText, /answer-2/);
    assert.match(observedText, /answer-3/);
    const observedBeforeClose = observed.length;
    opened.close();
    await manager.send(created.id, "after subscriber close");
    assert.equal(
      observed.length,
      observedBeforeClose,
      "the original close handle must detach from the replacement session's shared listener set",
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 运行中 steering 也会先应用 trust 撤销", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-trust-steering-"));
  const fingerprint = await workspaceExecutionFingerprint(dir);
  const firstStarted = deferred();
  let granted = true;
  const requests: StreamRequest[] = [];
  const provider: Provider = {
    name: "capture-trust-steering",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      if (requests.length === 1) {
        firstStarted.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw request.signal?.reason ?? new Error("first drive aborted");
      }
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "restricted" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "capture" }),
    workspaceTrust: async () => ({
      trusted: granted,
      reason: granted ? ("trusted" as const) : ("not-trusted" as const),
      identity: fingerprint.identity,
      executionHash: fingerprint.executionHash,
      executionSources: fingerprint.executionSources,
      storeFile: path.join(dir, "trust.json"),
      assessedAt: new Date().toISOString(),
    }),
  });
  try {
    const created = await manager.createSession({ cwd: dir, model: "capture" });
    const first = manager.send(created.id, "start privileged drive");
    await firstStarted.promise;
    assert.equal(manager.peek(created.id)?.running, true);

    granted = false;
    await manager.send(created.id, "steering after revoke");
    await first;

    assert.equal(manager.peek(created.id)?.workspaceTrust?.trusted, false);
    assert.deepEqual(
      (requests[1]?.tools ?? []).map((tool) => tool.name).sort(),
      [...RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES].sort(),
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 会话启动前恢复崩溃中断的 PatchSet", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-patch-recovery-"));
  const workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "a.txt"), "before");
  const provider = scriptedProvider([]);
  const creator = await mgr(dir, provider);
  const session = await creator.createSession({ cwd: workspace, model: "scripted" });
  creator.dispose();
  const service = new PatchSetService(workspace, {
    directCommit: "trusted-local",
    sessionId: session.id,
  });
  const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
  // 模拟进程在第一项落盘、journal 标记 applying 后被 SIGKILL。
  await fs.writeFile(path.join(workspace, "a.txt"), "after");
  patchset.status = "applying";
  patchset.appliedCount = 1;
  await fs.writeFile(
    path.join(workspace, ".anicode", "patchsets", `${patchset.id}.json`),
    JSON.stringify(patchset),
  );

  const manager = await mgr(dir, provider);
  await manager.resumeSession(session.id);
  assert.equal(await fs.readFile(path.join(workspace, "a.txt"), "utf8"), "before");
  assert.equal((await service.load(patchset.id))?.status, "rolled_back");
  assert.ok(
    (await manager.runtimeEvents(session.id)).some((event) => event.type === "patchset.recovered"),
  );
  manager.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: PatchSet IDs are session-bound and deletion purges only the owner", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-patch-owner-"));
  let tick = 1_700_000_000_000;
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    now: () => tick++,
    rand: () => 0.5,
    recoverCommands: false,
  });
  try {
    const alice = await manager.createSession({ cwd: dir, model: "scripted" });
    const bob = await manager.createSession({ cwd: dir, model: "scripted" });
    const alicePatch = await manager.preparePatchSet(alice.id, [
      { path: "alice-private.txt", content: "SESSION_ALICE_PATCH_CANARY" },
    ]);
    const bobPatch = await manager.preparePatchSet(bob.id, [
      { path: "bob-private.txt", content: "SESSION_BOB_PATCH_CANARY" },
    ]);
    assert.equal(alicePatch.patchset.sessionId, alice.id);
    assert.equal(bobPatch.patchset.sessionId, bob.id);

    const foreignOperations = [
      () => manager.getPatchSet(bob.id, alicePatch.patchset.id),
      () => manager.applyPatchSet(bob.id, alicePatch.patchset.id),
      () =>
        manager.approvePatchSet(bob.id, alicePatch.patchset.id, {
          actor: "bob",
          role: "reviewer",
          decision: "approve",
        }),
      () => manager.rebasePatchSet(bob.id, alicePatch.patchset.id),
      () => manager.rollbackPatchSet(bob.id, alicePatch.patchset.id),
    ];
    for (const operation of foreignOperations) {
      await assert.rejects(operation, /another session/);
    }

    const journalDir = path.join(dir, ".anicode", "patchsets");
    const aliceJournal = path.join(journalDir, `${alicePatch.patchset.id}.json`);
    const bobJournal = path.join(journalDir, `${bobPatch.patchset.id}.json`);
    assert.match(await fs.readFile(aliceJournal, "utf8"), /SESSION_ALICE_PATCH_CANARY/);
    await manager.deleteSession(alice.id);
    await assert.rejects(() => fs.access(aliceJournal));
    assert.match(await fs.readFile(bobJournal, "utf8"), /SESSION_BOB_PATCH_CANARY/);
    assert.equal(
      (await manager.getPatchSet(bob.id, bobPatch.patchset.id))?.patchset.sessionId,
      bob.id,
    );
    assert.doesNotMatch(
      (
        await Promise.all(
          (await fs.readdir(journalDir)).map((name) =>
            fs.readFile(path.join(journalDir, name), "utf8").catch(() => ""),
          ),
        )
      ).join("\n"),
      /SESSION_ALICE_PATCH_CANARY/,
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: deletion recovers an interrupted applying PatchSet without a manual retry", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-patch-delete-retry-"));
  const manager = await mgr(dir, scriptedProvider([]));
  try {
    const session = await manager.createSession({ cwd: dir, model: "scripted" });
    const prepared = await manager.preparePatchSet(session.id, [
      { path: "pending-private.txt", content: "APPLYING_PATCH_PRIVATE_CANARY" },
    ]);
    prepared.patchset.status = "applying";
    prepared.patchset.appliedCount = 1;
    const journalFile = path.join(dir, ".anicode", "patchsets", `${prepared.patchset.id}.json`);
    await fs.writeFile(journalFile, JSON.stringify(prepared.patchset));

    await manager.deleteSession(session.id);
    await assert.rejects(() => fs.access(journalFile));
    await assert.rejects(() => manager.send(session.id, "must remain fenced"), /删除|deleted/);
    await assert.rejects(() => manager.resumeSession(session.id));
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: new sessions never claim or attribute legacy workspace journals", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-patch-legacy-"));
  const file = path.join(dir, "legacy.txt");
  await fs.writeFile(file, "before");
  const standalone = new PatchSetService(dir, { directCommit: "trusted-local" });
  const legacy = await standalone.prepare([{ path: "legacy.txt", content: "after" }]);
  await fs.writeFile(file, "after");
  legacy.status = "applying";
  legacy.appliedCount = 1;
  await fs.writeFile(
    path.join(dir, ".anicode", "patchsets", `${legacy.id}.json`),
    JSON.stringify(legacy),
  );
  const manager = await mgr(dir, scriptedProvider([]));
  try {
    const session = await manager.createSession({ cwd: dir, model: "scripted" });
    assert.equal(await fs.readFile(file, "utf8"), "after");
    assert.equal(
      (await manager.runtimeEvents(session.id)).some(
        (event) => event.type === "patchset.recovered",
      ),
      false,
    );
    assert.equal((await standalone.recoverIncomplete())[0]?.status, "rolled_back");
    assert.equal(await fs.readFile(file, "utf8"), "before");
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 权限广播，任一订阅者可裁决", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const m = await mgr(
    dir,
    scriptedProvider([
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "c1",
              name: "write",
              args: { path: "x.txt", content: "data" },
            },
          ],
        },
      ],
      [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    ]),
  );
  const s = await m.createSession({ cwd: dir, model: "scripted" });

  const events: SessionEvent[] = [];
  const observerEvents: SessionEvent[] = [];
  await m.open(s.id, (ev) => {
    events.push(ev);
    // 订阅者 A 看到权限请求就批准（模拟 UI 交互）
    if (ev.type === "permission_request") void m.answerPermission(s.id, ev.permId, "allow");
  });
  // 特意后注册 observer：裁决者会在 permission_request 回调里同步 answer，
  // 仍必须保证 observer 先收到 request、再收到 resolved。
  await m.open(s.id, (ev) => observerEvents.push(ev));

  await m.send(s.id, "写文件");

  // permId 应等于工具调用 id（供 UI 关联）
  const perm = events.find((e) => e.type === "permission_request") as any;
  assert.equal(perm.permId, "c1");
  assert.equal(perm.toolName, "write");
  assert.equal(perm.cwd, dir);
  assert.equal(perm.risk, "medium");
  assert.deepEqual(perm.input, { path: "x.txt", content: "data" });
  for (const received of [events, observerEvents]) {
    const requestAt = received.findIndex((e) => e.type === "permission_request");
    const resolvedAt = received.findIndex(
      (e) => e.type === "permission_resolved" && e.permId === "c1" && e.decision === "allow",
    );
    assert.ok(
      requestAt >= 0 && resolvedAt > requestAt,
      "每个观察者都应按 request → resolved 收到事件",
    );
  }
  assert.equal(await m.answerPermission(s.id, "c1", "deny"), false, "已裁决请求不可重复回答");
  // 文件真的写了
  assert.equal(await fs.readFile(path.join(dir, "x.txt"), "utf8"), "data");
  // 有成功的工具结果
  assert.ok(
    events.some((e) => e.type === "agent" && e.event.type === "tool_result" && !e.event.isError),
  );

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: shell 联网的 stale allow_always 被规范为一次性 allow", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-network-permission-"));
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "network-shell",
            name: "bash",
            args: { command: "fetch example", network: true },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    permission: { mode: "bypass" },
    tools: () =>
      new ToolRegistry().register({
        readOnly: false,
        capabilities: ["process"],
        def: {
          name: "bash",
          description: "fake network shell",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              network: { type: "boolean" },
            },
            required: ["command"],
            additionalProperties: false,
          },
        },
        ruleKey: (input) => String(input["command"] ?? ""),
        run: async () => "executed",
      }),
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "scripted" });
    const events: SessionEvent[] = [];
    await manager.open(session.id, (event) => {
      events.push(event);
      if (event.type === "permission_request") {
        void manager.answerPermission(session.id, event.permId, "allow_always");
      }
    });
    await manager.send(session.id, "request network");

    assert.ok(
      events.some(
        (event) =>
          event.type === "permission_resolved" &&
          event.permId === "network-shell" &&
          event.decision === "allow",
      ),
      "one-shot network consent must never be reported as persistent",
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: 非法权限答复 fail closed 且不消费待裁决请求", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-invalid-permission-"));
  let executions = 0;
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "network-shell-invalid-answer",
            name: "bash",
            args: { command: "fetch example", network: true },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    permission: { mode: "bypass" },
    tools: () =>
      new ToolRegistry().register({
        readOnly: false,
        capabilities: ["process"],
        def: {
          name: "bash",
          description: "fake network shell",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string" },
              network: { type: "boolean" },
            },
            required: ["command"],
            additionalProperties: false,
          },
        },
        ruleKey: (input) => String(input["command"] ?? ""),
        run: async () => {
          executions++;
          return "executed";
        },
      }),
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "scripted" });
    const events: SessionEvent[] = [];
    let signalPermission!: (permId: string) => void;
    const permissionRequested = new Promise<string>((resolve) => {
      signalPermission = resolve;
    });
    await manager.open(session.id, (event) => {
      events.push(event);
      if (event.type === "permission_request") signalPermission(event.permId);
    });

    const send = manager.send(session.id, "request network");
    const permId = await permissionRequested;
    assert.equal(
      await manager.answerPermission(session.id, permId, "bogus" as never),
      false,
      "unknown runtime values must not approve or consume the prompt",
    );
    assert.equal(
      events.some((event) => event.type === "permission_resolved" && event.permId === permId),
      false,
    );
    assert.equal(await manager.answerPermission(session.id, permId, "deny"), true);
    await send;

    assert.equal(executions, 0);
    assert.ok(
      events.some(
        (event) =>
          event.type === "permission_resolved" &&
          event.permId === permId &&
          event.decision === "deny",
      ),
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: create 只做纯 provider 检查，首次 send 才解析一次", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  let inspections = 0;
  let resolutions = 0;
  const broken = new SessionManager({
    store,
    resolveProvider: () => {
      resolutions++;
      return { provider: scriptedProvider([]), model: "broken/model" };
    },
    inspectProvider: () => {
      inspections++;
      throw new Error("provider config invalid");
    },
    recoverCommands: false,
  });

  await assert.rejects(
    broken.createSession({ cwd: dir, model: "broken/model" }),
    /provider config invalid/,
  );
  assert.equal(inspections, 1);
  assert.equal(resolutions, 0, "纯检查失败不得构造 provider 或读取凭据");
  assert.deepEqual(await store.list(), [], "检查失败不得留下孤儿会话文件");
  await broken.shutdown();

  const healthy = new SessionManager({
    store,
    inspectProvider: () => ({ model: "scripted", providerId: "scripted" }),
    resolveProvider: () => {
      resolutions++;
      return {
        provider: scriptedProvider([
          [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        ]),
        model: "scripted",
      };
    },
    recoverCommands: false,
  });
  const created = await healthy.createSession({ cwd: dir, model: "scripted" });
  const opened = await healthy.open(created.id, () => {});
  await healthy.resumeSession(created.id);
  assert.equal(resolutions, 0, "create/open/resume 不应 resolve provider");
  await healthy.send(created.id, "hello");
  assert.equal(resolutions, 1, "首次真实消息只 resolve 一次 provider");

  opened.close();
  await healthy.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: cold create/open/resume 不读凭据，首条消息只读一次", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-lazy-credential-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  class CountingSecretBackend implements SyncSecretBackend {
    readonly kind = "session-manager-counting-secret";
    reads = 0;

    getSync(key: string): string | undefined {
      this.reads++;
      return key === "env:DEEPSEEK_API_KEY" ? "test-deepseek-secret" : undefined;
    }
    putSync(): void {}
    deleteSync(): boolean {
      return false;
    }
    async get(key: string): Promise<string | undefined> {
      return this.getSync(key);
    }
    async put(): Promise<void> {}
    async delete(): Promise<boolean> {
      return false;
    }
  }

  const backend = new CountingSecretBackend();
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "env:DEEPSEEK_API_KEY",
    backend,
    scopes: credentialScopesForEnvironment("DEEPSEEK_API_KEY"),
  });
  const registry = bindProviderRegistry({
    broker,
    environment: {},
    allowEnvironmentFallback: false,
  });
  const resolveProvider = (spec: string) => {
    const resolved = registry.resolveProvider(spec);
    return {
      ...resolved,
      provider: scriptedProvider([
        [{ role: "assistant", content: [{ type: "text", text: "credential loaded" }] }],
      ]),
    };
  };
  const makeManager = () =>
    new SessionManager({
      store,
      inspectProvider: registry.inspectProvider,
      resolveProvider,
      recoverCommands: false,
    });

  const first = makeManager();
  const created = await first.createSession({
    cwd: dir,
    model: "deepseek/deepseek-chat",
  });
  const firstOpen = await first.open(created.id, () => {});
  await first.resumeSession(created.id);
  assert.equal(backend.reads, 0);
  firstOpen.close();
  await first.shutdown();

  const resumed = makeManager();
  const coldOpen = await resumed.open(created.id, () => {});
  await resumed.resumeSession(created.id);
  assert.equal(backend.reads, 0, "冷启动 open/resume 也不能访问 secret backend");
  await resumed.send(created.id, "hello");
  assert.equal(backend.reads, 1, "首次真正 provider stream 只读取一次凭据");
  coldOpen.close();
  await resumed.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: deferred provider 解析失败不缓存，修复凭据后下一条消息可恢复", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-lazy-provider-retry-"));
  let attempts = 0;
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    inspectProvider: () => ({ model: "scripted", providerId: "scripted" }),
    resolveProvider: () => {
      attempts++;
      if (attempts === 1) throw new Error("credential temporarily locked");
      return {
        provider: scriptedProvider([
          [{ role: "assistant", content: [{ type: "text", text: "recovered" }] }],
        ]),
        model: "scripted",
      };
    },
    recoverCommands: false,
  });
  const events: SessionEvent[] = [];
  const created = await manager.createSession({ cwd: dir, model: "scripted" });
  const opened = await manager.open(created.id, (event) => events.push(event));

  await manager.send(created.id, "first");
  assert.equal(attempts, 1);
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent" &&
        event.event.type === "error" &&
        event.event.message.includes("credential temporarily locked"),
    ),
  );

  await manager.send(created.id, "second");
  assert.equal(attempts, 2, "失败的物化不得毒化后续 send");
  assert.ok(
    events.some(
      (event) =>
        event.type === "agent" && event.event.type === "text" && event.event.text === "recovered",
    ),
  );

  opened.close();
  await manager.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: send 严格推进 live snapshot 的 updatedAt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const m = await mgr(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "ok" }] }]]),
  );
  const created = await m.createSession({ cwd: dir, model: "scripted" });
  await m.send(created.id, "hello");

  const handle = await m.open(created.id, () => {});
  assert.ok(
    handle.snapshot.meta.updatedAt > created.updatedAt,
    `${handle.snapshot.meta.updatedAt} 应晚于 ${created.updatedAt}`,
  );
  assert.equal((await m.listSessions())[0]!.updatedAt, handle.snapshot.meta.updatedAt);
  handle.close();

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: listSessions 把最近活跃的 live 会话排在前面", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "first" }] }],
    [{ role: "assistant", content: [{ type: "text", text: "second" }] }],
  ]);
  let idClock = 1_700_000_000_000;
  const m = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    now: () => idClock++,
    rand: () => 0.5,
  });
  const a = await m.createSession({ cwd: dir, model: "scripted", title: "A" });
  const b = await m.createSession({ cwd: dir, model: "scripted", title: "B" });

  // 两次 activity touch 即使发生在同一毫秒也会单调 +1，不依赖 sleep。
  await m.send(a.id, "one");
  await m.send(a.id, "two");
  const list = await m.listSessions();
  assert.equal(list[0]!.id, a.id);
  assert.equal(list[1]!.id, b.id);
  assert.ok(list[0]!.updatedAt > list[1]!.updatedAt);

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: subscribe 立即回放 snapshot；resume 载入历史", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  // 预置一个已有会话
  await store.create({ id: "s_pre", cwd: dir, model: "scripted", title: "旧会话" });
  await store.append("s_pre", { role: "user", content: [{ type: "text", text: "旧问题" }] });
  await store.append("s_pre", { role: "assistant", content: [{ type: "text", text: "旧回答" }] });

  const m = new SessionManager({
    store,
    resolveProvider: () => ({
      provider: scriptedProvider([
        [{ role: "assistant", content: [{ type: "text", text: "续接" }] }],
      ]),
      model: "scripted",
    }),
  });

  // list 能看到磁盘会话
  const list = await m.listSessions();
  assert.equal(list.find((x) => x.id === "s_pre")?.title, "旧会话");

  // open 返回的 snapshot 带历史
  const sub = await m.open("s_pre", () => {});
  assert.equal(sub.snapshot.messages.length, 2);
  assert.equal(sub.snapshot.running, false);
  assert.equal((sub.snapshot.messages[0]!.content[0] as any).text, "旧问题");

  // 续接后仍持久化
  await m.send("s_pre", "新问题");
  const reloaded = await store.load("s_pre");
  assert.equal(reloaded.messages.length, 4);

  sub.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: 两客户端并发 open 冷会话只实例化一次且都能收到后续事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-cold-open-"));
  class SlowStore extends SessionStore {
    loads = 0;
    override async load(id: string) {
      this.loads++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return super.load(id);
    }
  }
  const store = new SlowStore(path.join(dir, "sessions"));
  await store.create({ id: "s_cold", cwd: dir, model: "scripted" });
  let resolutions = 0;
  const manager = new SessionManager({
    store,
    resolveProvider: () => {
      resolutions++;
      return {
        provider: scriptedProvider([
          [{ role: "assistant", content: [{ type: "text", text: "shared reply" }] }],
        ]),
        model: "scripted",
      };
    },
  });
  const a: SessionEvent[] = [];
  const b: SessionEvent[] = [];

  const [handleA, handleB] = await Promise.all([
    manager.open("s_cold", (event) => a.push(event)),
    manager.open("s_cold", (event) => b.push(event)),
  ]);
  await manager.send("s_cold", "hello");

  assert.equal(store.loads, 1);
  assert.equal(resolutions, 1);
  for (const events of [a, b]) {
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent" &&
          event.event.type === "text" &&
          event.event.text === "shared reply",
      ),
    );
  }

  handleA.close();
  handleB.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: dispose 后即使 provider 忽略 AbortSignal 也不会执行迟到工具", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-dispose-"));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const ignoringProvider: Provider = {
    name: "ignores-abort",
    async *stream(): AsyncIterable<StreamEvent> {
      markStarted();
      await new Promise((resolve) => setTimeout(resolve, 30));
      yield {
        type: "done",
        stopReason: "tool_use",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_call",
              id: "late-write",
              name: "write",
              args: { path: "must-not-exist.txt", content: "too late" },
            },
          ],
        },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: ignoringProvider, model: "ignores-abort" }),
    permission: { mode: "auto" },
  });
  const meta = await manager.createSession({ cwd: dir, model: "ignores-abort" });
  const sending = manager.send(meta.id, "start");
  await started;

  manager.dispose();
  await sending;
  await assert.rejects(fs.access(path.join(dir, "must-not-exist.txt")));

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: shutdown 同步封死新工作并等待已开始的冷加载", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-shutdown-fence-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const creator = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  const created = await creator.createSession({ cwd: dir, model: "scripted" });
  await creator.shutdown();

  const loadStarted = deferred();
  const releaseLoad = deferred();
  const originalLoad = store.load.bind(store);
  store.load = async (id) => {
    loadStarted.resolve();
    await releaseLoad.promise;
    return originalLoad(id);
  };
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  const resuming = manager.resumeSession(created.id);
  await loadStarted.promise;
  let shutdownSettled = false;
  const shuttingDown = manager.shutdown().then(() => {
    shutdownSettled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownSettled, false, "shutdown 必须等待 fence 前已经开始的 load");
  await assert.rejects(
    manager.createSession({ cwd: dir, model: "scripted" }),
    /shutting down|disposed/,
  );
  await assert.rejects(manager.listSessions(), /shutting down|disposed/);
  await assert.rejects(
    manager.send(created.id, "late"),
    /shutting down|disposed|shutdown deadline exceeded/,
  );
  assert.throws(() => manager.peek(created.id), /shutting down|disposed/);

  releaseLoad.resolve();
  await assert.rejects(resuming, /shutting down|disposed/);
  await shuttingDown;
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: shutdown 对不协作的持久后端执行全局硬截止并保持 fence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-shutdown-deadline-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const creator = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  const created = await creator.createSession({ cwd: dir, model: "scripted" });
  await creator.shutdown();

  const loadStarted = deferred();
  store.load = async () => {
    loadStarted.resolve();
    return new Promise<never>(() => undefined);
  };
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
    shutdownTimeoutMs: 25,
  });
  void manager.resumeSession(created.id).catch(() => undefined);
  await loadStarted.promise;

  const startedAt = Date.now();
  await assert.rejects(manager.shutdown(), /shutdown exceeded the 25ms hard deadline/);
  assert.ok(Date.now() - startedAt < 1_000, "shutdown 不能永久等待不协作的 store");
  await assert.rejects(
    manager.send(created.id, "late"),
    /shutting down|disposed|shutdown deadline exceeded/,
  );
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: steering 必须在 durable accept+claim 完成后才进入 Agent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-steering-durable-"));
  const acceptStarted = deferred();
  const releaseAccept = deferred();
  class SlowSecondAcceptStore extends MemoryCommandInboxStore {
    override async write(sessionId: string, commands: DurableCommand[]): Promise<void> {
      if (commands.some((command) => command.text === "second")) {
        acceptStarted.resolve();
        await releaseAccept.promise;
      }
      await super.write(sessionId, commands);
    }
  }
  const firstStreamStarted = deferred();
  const releaseFirstStream = deferred();
  let providerCalls = 0;
  const provider: Provider = {
    name: "durable-steering",
    async *stream(): AsyncIterable<StreamEvent> {
      const turn = providerCalls++;
      if (turn === 0) {
        firstStreamStarted.resolve();
        await releaseFirstStream.promise;
      }
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: `turn-${turn}` }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    commandInbox: new CommandInbox(new SlowSecondAcceptStore()),
    resolveProvider: () => ({ provider, model: "durable-steering" }),
    recoverCommands: false,
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "durable-steering" });
    const first = manager.send(session.id, "first");
    await firstStreamStarted.promise;
    const second = manager.send(session.id, "second");
    await acceptStarted.promise;
    releaseFirstStream.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(providerCalls, 1, "未耐久的 steering 不能被当前 drive 消费");

    releaseAccept.resolve();
    await Promise.all([first, second]);
    assert.equal(providerCalls, 2);
  } finally {
    releaseFirstStream.resolve();
    releaseAccept.resolve();
    await manager.shutdown().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: command fencing heartbeat 失败时在 provider/tool 前 fail closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-command-fence-"));
  class LostLeaseStore extends MemoryCommandInboxStore {
    async heartbeatCommand(): Promise<void> {
      throw new Error("stale command fencing token");
    }
  }
  let providerCalls = 0;
  const provider: Provider = {
    name: "must-not-run",
    async *stream(): AsyncIterable<StreamEvent> {
      providerCalls++;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "unsafe" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    commandInbox: new CommandInbox(new LostLeaseStore()),
    resolveProvider: () => ({ provider, model: "must-not-run" }),
    recoverCommands: false,
  });
  try {
    const session = await manager.createSession({ cwd: dir, model: "must-not-run" });
    await assert.rejects(manager.send(session.id, "do not execute"), /stale command fencing token/);
    assert.equal(providerCalls, 0);
  } finally {
    await manager.shutdown().catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: setTitle 更新标题并持久化，list/resume 都可见", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const m = await mgr(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "ok" }] }]]),
  );
  const s = await m.createSession({ cwd: dir, model: "scripted" });
  assert.equal(s.title, undefined);

  await m.send(s.id, "帮我重构登录模块");
  await m.setTitle(s.id, "重构登录模块");

  const listed = (await m.listSessions()).find((x) => x.id === s.id);
  assert.equal(listed?.title, "重构登录模块");

  // 空标题被忽略，不会清空已有标题。
  await m.setTitle(s.id, "   ");
  assert.equal((await m.listSessions()).find((x) => x.id === s.id)?.title, "重构登录模块");

  // 从磁盘 resume（新 manager）也能读到标题与历史。
  const m2 = await mgr(dir, scriptedProvider([]));
  const snap = await m2.resumeSession(s.id);
  assert.equal(snap.meta.title, "重构登录模块");
  assert.ok(snap.messages.length > 0, "历史应保留");

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: deleteSession 移除会话，list 不再包含，resume 报错", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
  ]);
  // 递增时钟保证两个会话 id 不同（mgr 助手用固定时钟会碰撞）。
  let clock = 1_700_000_000_000;
  const m = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    now: () => clock++,
    rand: () => 0.5,
  });
  const a = await m.createSession({ cwd: dir, model: "scripted", title: "留下" });
  const b = await m.createSession({ cwd: dir, model: "scripted", title: "删掉" });
  const canary = "PROMPT_CANARY_DELETE_ME_7f2d";
  await m.send(b.id, canary);
  await m.putArtifact({
    sessionId: b.id,
    kind: "report",
    name: "canary.txt",
    data: canary,
  });

  assert.equal((await m.listSessions()).length, 2);
  await m.deleteSession(b.id);
  const remaining = await m.listSessions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, a.id);
  assert.deepEqual(await m.commandInbox.store.read(b.id), []);
  assert.deepEqual(await m.artifacts.list(b.id), []);
  assert.equal(
    (await m.outbox.store.read()).some((message) => message.event.streamId === b.id),
    false,
  );
  const tombstone = await m.runtime.events(b.id);
  assert.deepEqual(
    tombstone.map((event) => event.type),
    ["session.deleted"],
  );
  assert.doesNotMatch(JSON.stringify(tombstone), new RegExp(canary));

  // 删除已不存在的会话是无操作，不抛。
  await m.deleteSession(b.id);

  // 已删会话无法 resume（磁盘文件已移除）。
  await assert.rejects(() => m.resumeSession(b.id));

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: failed purge keeps the fence but a repeated delete resumes cleanup", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-delete-retry-"));
  const backing = new MemoryArtifactStore();
  let purgeAttempts = 0;
  const artifacts: ArtifactStore = {
    put: (input) => backing.put(input),
    list: (sessionId) => backing.list(sessionId),
    get: (sessionId, artifactId) => backing.get(sessionId, artifactId),
    delete: (sessionId, artifactId) => backing.delete(sessionId, artifactId),
    async deleteSession(sessionId) {
      purgeAttempts++;
      if (purgeAttempts === 1) throw new Error("artifact backend temporarily unavailable");
      await backing.deleteSession(sessionId);
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    artifacts,
  });
  try {
    const created = await manager.createSession({ cwd: dir, model: "scripted" });
    await manager.putArtifact({
      sessionId: created.id,
      kind: "report",
      name: "retry.txt",
      data: "purge me",
    });
    await assert.rejects(() => manager.deleteSession(created.id), /temporarily unavailable/);
    await assert.rejects(() => manager.send(created.id, "must remain fenced"), /删除|deleted/);
    await manager.deleteSession(created.id);
    assert.equal(purgeAttempts, 2);
    assert.deepEqual(await backing.list(created.id), []);
    await manager.deleteSession(created.id);
    assert.equal(purgeAttempts, 2, "completed deletion remains idempotent");
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: delete fence 等待迟到持久化，并拒绝新 load/send/artifact", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-delete-fence-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const appendStarted = deferred();
  const releaseAppend = deferred();
  const originalAppend = store.append.bind(store);
  let blockFirstAppend = true;
  store.append = async (id, message) => {
    if (blockFirstAppend) {
      blockFirstAppend = false;
      appendStarted.resolve();
      await releaseAppend.promise;
    }
    await originalAppend(id, message);
  };
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({
      provider: scriptedProvider([
        [{ role: "assistant", content: [{ type: "text", text: "LATE_RESPONSE_CANARY" }] }],
      ]),
      model: "scripted",
    }),
    recoverCommands: false,
  });
  try {
    const created = await manager.createSession({ cwd: dir, model: "scripted" });
    const sending = manager.send(created.id, "LATE_PROMPT_CANARY");
    await appendStarted.promise;

    let deletionSettled = false;
    const deletion = manager.deleteSession(created.id).then(() => {
      deletionSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deletionSettled, false, "purge must wait for the active persistence write");
    await assert.rejects(() => manager.send(created.id, "must reject"), /删除|deleted/);
    await assert.rejects(() => manager.resumeSession(created.id), /删除|deleted/);
    await assert.rejects(() => manager.recoverCommands(created.id), /删除|deleted/);
    await assert.rejects(
      () =>
        manager.putArtifact({
          sessionId: created.id,
          kind: "report",
          name: "must-not-exist.txt",
          data: "artifact after delete fence",
        }),
      /删除|deleted/,
    );

    releaseAppend.resolve();
    await Promise.allSettled([sending]);
    await deletion;
    assert.equal(deletionSettled, true);
    await assert.rejects(() => store.load(created.id));
    assert.deepEqual(await manager.commandInbox.store.read(created.id), []);
    assert.deepEqual(await manager.artifacts.list(created.id), []);
    assert.equal(
      (await manager.outbox.store.read()).some((message) => message.event.streamId === created.id),
      false,
    );
    const tombstone = await manager.runtime.events(created.id);
    assert.deepEqual(
      tombstone.map((event) => event.type),
      ["session.deleted"],
    );
    assert.doesNotMatch(JSON.stringify(tombstone), /LATE_(?:PROMPT|RESPONSE)_CANARY/);
  } finally {
    releaseAppend.resolve();
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: paused artifact reader is revoked before session DELETE completes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-delete-artifact-stream-"));
  const backing = new MemoryArtifactStore();
  const sourceClosed = deferred();
  const artifacts: ArtifactStore = {
    put: (input) => backing.put(input),
    list: (sessionId) => backing.list(sessionId),
    get: (sessionId, artifactId) => backing.get(sessionId, artifactId),
    async open(sessionId, artifactId) {
      const record = await backing.get(sessionId, artifactId);
      if (!record) return undefined;
      return {
        artifact: record.artifact,
        data: (async function* () {
          try {
            yield record.data.subarray(0, 5);
            yield record.data.subarray(5);
          } finally {
            sourceClosed.resolve();
          }
        })(),
      };
    },
    delete: (sessionId, artifactId) => backing.delete(sessionId, artifactId),
    deleteSession: (sessionId) => backing.deleteSession(sessionId),
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    artifacts,
    recoverCommands: false,
  });
  try {
    const created = await manager.createSession({ cwd: dir, model: "scripted" });
    const artifact = await manager.putArtifact({
      sessionId: created.id,
      kind: "report",
      name: "paused.txt",
      data: "firstSECRET_AFTER_DELETE",
    });
    const opened = await manager.openArtifact(created.id, artifact.id);
    assert.ok(opened);
    const reader = opened.data[Symbol.asyncIterator]();
    const first = await reader.next();
    assert.equal(Buffer.from(first.value!).toString("utf8"), "first");
    assert.equal(
      (await manager.runtime.lifecycle.get(created.id))?.activeLeases,
      1,
      "the durable operation lease remains held while the iterator is paused at yield",
    );

    const deletion = manager.deleteSession(created.id);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error("session DELETE waited on a paused reader")),
        1_000,
      );
      timeout.unref();
    });
    try {
      await Promise.race([deletion, timedOut]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    await sourceClosed.promise;
    await assert.rejects(() => reader.next(), /deleted|deleting|aborted/i);
    assert.deepEqual(await backing.list(created.id), []);
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: an opened but never iterated artifact reader cannot block DELETE", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-delete-unread-artifact-"));
  const backing = new MemoryArtifactStore();
  const sourceClosed = deferred();
  const artifacts: ArtifactStore = {
    put: (input) => backing.put(input),
    list: (sessionId) => backing.list(sessionId),
    get: (sessionId, artifactId) => backing.get(sessionId, artifactId),
    async open(sessionId, artifactId) {
      const record = await backing.get(sessionId, artifactId);
      if (!record) return undefined;
      return {
        artifact: record.artifact,
        data: {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                return { done: false as const, value: record.data };
              },
              async return() {
                sourceClosed.resolve();
                return { done: true as const, value: undefined };
              },
            };
          },
        },
      };
    },
    delete: (sessionId, artifactId) => backing.delete(sessionId, artifactId),
    deleteSession: (sessionId) => backing.deleteSession(sessionId),
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    artifacts,
    recoverCommands: false,
  });
  try {
    const created = await manager.createSession({ cwd: dir, model: "scripted" });
    const artifact = await manager.putArtifact({
      sessionId: created.id,
      kind: "report",
      name: "unread.txt",
      data: "never consumed",
    });
    assert.ok(await manager.openArtifact(created.id, artifact.id));
    assert.equal((await manager.runtime.lifecycle.get(created.id))?.activeLeases, 0);
    await manager.deleteSession(created.id);
    await sourceClosed.promise;
    assert.deepEqual(await backing.list(created.id), []);
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: delete fence 等待并发冷载入，不让 load 迟到重建 live 会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-delete-load-race-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const creator = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  const created = await creator.createSession({ cwd: dir, model: "scripted" });
  await creator.shutdown();

  const loadStarted = deferred();
  const releaseLoad = deferred();
  const originalLoad = store.load.bind(store);
  let blockFirstLoad = true;
  store.load = async (id) => {
    if (blockFirstLoad) {
      blockFirstLoad = false;
      loadStarted.resolve();
      await releaseLoad.promise;
    }
    return originalLoad(id);
  };
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
    recoverCommands: false,
  });
  try {
    const resuming = manager.resumeSession(created.id);
    await loadStarted.promise;
    let deletionSettled = false;
    const deletion = manager.deleteSession(created.id).then(() => {
      deletionSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deletionSettled, false);
    releaseLoad.resolve();
    await assert.rejects(resuming, /删除|deleted/);
    await deletion;
    assert.equal(manager.peek(created.id), undefined);
    await assert.rejects(() => manager.resumeSession(created.id), /删除|deleted/);
    await assert.rejects(() => originalLoad(created.id));
  } finally {
    releaseLoad.resolve();
    await manager.shutdown();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: delete fence 中断并等待 command recovery 后再 purge", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-delete-recovery-"));
  const providerStarted = deferred();
  const releaseProvider = deferred();
  const provider: Provider = {
    name: "slow-recovery",
    async *stream(): AsyncIterable<StreamEvent> {
      providerStarted.resolve();
      await releaseProvider.promise;
      yield {
        type: "done",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "RECOVERY_RESPONSE_CANARY" }],
        },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "slow" }),
    recoverCommands: false,
  });
  try {
    const created = await manager.createSession({ cwd: dir, model: "slow" });
    await manager.commandInbox.accept({
      sessionId: created.id,
      text: "RECOVERY_PROMPT_CANARY",
      messageCountBefore: 0,
    });
    const recovery = manager.recoverCommands(created.id);
    await providerStarted.promise;
    let deletionSettled = false;
    const deletion = manager.deleteSession(created.id).then(() => {
      deletionSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deletionSettled, false, "purge must wait for recovery drive termination");
    releaseProvider.resolve();
    await Promise.allSettled([recovery]);
    await deletion;
    assert.deepEqual(await manager.commandInbox.store.read(created.id), []);
    assert.equal(
      (await manager.outbox.store.read()).some((message) => message.event.streamId === created.id),
      false,
    );
    const tombstone = await manager.runtime.events(created.id);
    assert.deepEqual(
      tombstone.map((event) => event.type),
      ["session.deleted"],
    );
    assert.doesNotMatch(JSON.stringify(tombstone), /RECOVERY_(?:PROMPT|RESPONSE)_CANARY/);
  } finally {
    releaseProvider.resolve();
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionManager: forkSession 复制历史成新会话，原会话不动", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "第一轮回答" }] }],
    [{ role: "assistant", content: [{ type: "text", text: "fork 后的回答" }] }],
  ]);
  let tick = 1_700_000_000_000;
  const m = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    now: () => tick++, // fork 生成的新 id 不能与原会话撞车
    rand: () => 0.5,
  });
  const s = await m.createSession({ cwd: dir, model: "scripted", title: "原会话" });
  await m.send(s.id, "第一问");

  const fork = await m.forkSession(s.id);
  assert.notEqual(fork.id, s.id);
  assert.equal(fork.title, "原会话 (fork)");

  // fork 继承完整历史
  const forkSnap = await m.resumeSession(fork.id);
  const origSnap = await m.resumeSession(s.id);
  assert.equal(forkSnap.messages.length, origSnap.messages.length);

  // fork 上继续对话，原会话历史不变
  await m.send(fork.id, "第二问");
  const after = await m.resumeSession(fork.id);
  assert.ok(after.messages.length > origSnap.messages.length);
  assert.equal((await m.resumeSession(s.id)).messages.length, origSnap.messages.length);

  // 持久化：新 manager（同一 store）也能载入 fork
  const m2 = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  const reloaded = await m2.resumeSession(fork.id);
  assert.equal(reloaded.messages.length, after.messages.length);

  // upToMessage 截断分叉
  const early = await m.forkSession(s.id, { title: "早期分叉", upToMessage: 1 });
  const earlySnap = await m.resumeSession(early.id);
  assert.equal(earlySnap.messages.length, 1);
  assert.equal(early.title, "早期分叉");

  // 切换模型时仍复制完整历史；解析在写入前完成，生成的会话可直接恢复。
  const switched = await m.forkSession(s.id, { title: "切换模型", model: "alt/fast" });
  const switchedSnap = await m.resumeSession(switched.id);
  assert.equal(switched.model, "alt/fast");
  assert.equal(switchedSnap.meta.model, "alt/fast");
  assert.equal(switchedSnap.messages.length, origSnap.messages.length);

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager.compact: 手动压缩广播 compacted 事件并收缩历史", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-compact-"));
  const provider = scriptedProvider(
    Array.from({ length: 4 }, (_, i) => [
      { role: "assistant" as const, content: [{ type: "text" as const, text: `回答${i}` }] },
    ]),
  );
  let tick = 1_700_000_100_000;
  const m = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    compaction: { keepRecentMessages: 1, summarizer: async () => "（旧对话摘要）" },
    now: () => tick++,
    rand: () => 0.5,
  });
  const s = await m.createSession({ cwd: dir, model: "scripted" });
  const events: SessionEvent[] = [];
  await m.open(s.id, (ev) => events.push(ev));
  for (const q of ["一", "二", "三"]) await m.send(s.id, q);
  const before = (await m.resumeSession(s.id)).messages.length;
  assert.equal(before, 6);

  const r = await m.compact(s.id);
  assert.equal(r.compacted, true);
  const after = (await m.resumeSession(s.id)).messages.length;
  assert.ok(after < before, `压缩后应更短: ${after} < ${before}`);
  assert.ok(
    events.some((e) => e.type === "agent" && e.event.type === "compacted"),
    "应广播 compacted 事件",
  );
  // 持久化被重写：新 manager 载入的是压缩后的历史
  const m2 = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  assert.equal((await m2.resumeSession(s.id)).messages.length, after);
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager.autoTitle: 首轮后本地起标题、持久化并广播 title 事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-title-"));
  // 自动标题不再启动账外模型调用；三条脚本只对应三次正常用户回合。
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "好的，我来修" }] }],
    [{ role: "assistant", content: [{ type: "text", text: "第二轮回答" }] }],
    [{ role: "assistant", content: [{ type: "text", text: "命名会话回答" }] }],
  ]);
  let tick = 1_700_000_200_000;
  const m = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
    autoTitle: true,
    now: () => tick++,
    rand: () => 0.5,
  });
  const s = await m.createSession({ cwd: dir, model: "scripted" });
  const events: SessionEvent[] = [];
  await m.open(s.id, (ev) => events.push(ev));
  await m.send(s.id, "登录接口超时了，帮我修一下");

  const titleDeadline = Date.now() + 1_000;
  while (!events.some((event) => event.type === "title") && Date.now() < titleDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const titled = events.find((e) => e.type === "title") as any;
  assert.ok(titled, "应广播 title 事件");
  assert.equal(titled.title, "登录接口超时了");
  assert.equal((await m.resumeSession(s.id)).meta.title, "登录接口超时了");

  // 已有标题后不再重复起名（第二轮消耗脚本第 3 条）
  await m.send(s.id, "继续");
  assert.equal(events.filter((e) => e.type === "title").length, 1);

  // 持久化：新 manager 载入仍带标题
  const m2 = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  assert.equal((await m2.resumeSession(s.id)).meta.title, "登录接口超时了");

  // 显式命名的会话不会被覆盖
  const named = await m.createSession({ cwd: dir, model: "scripted", title: "手动标题" });
  await m.open(named.id, (ev) => events.push(ev));
  await m.send(named.id, "任务");
  assert.equal((await m.resumeSession(named.id)).meta.title, "手动标题");

  await m.shutdown();
  await m2.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionManager: 后台任务空闲期完成 → 自动发起 drive 消化通知", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-bg-"));
  let parentTurn = 0;
  let releaseChild!: () => void;
  const childGate = new Promise<void>((r) => (releaseChild = r));
  const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let childEffect = false;

  // 子 agent 请求的辨识：它的用户消息文本就是 task prompt（"去干"）。
  const provider: Provider = {
    name: "p",
    async *stream(req): AsyncIterable<StreamEvent> {
      const isChild = req.messages.some((m) =>
        m.content.some((p) => p.type === "text" && p.text === "去干"),
      );
      if (isChild) {
        await childGate;
        const hasToolResult = req.messages.some((message) =>
          message.content.some((part) => part.type === "tool_result"),
        );
        if (!hasToolResult) {
          yield {
            type: "done",
            stopReason: "tool_use",
            message: {
              role: "assistant",
              content: [{ type: "tool_call", id: "child-write", name: "child_effect", args: {} }],
            },
            usage: zero,
          };
          return;
        }
        yield {
          type: "done",
          stopReason: "end_turn",
          message: { role: "assistant", content: [{ type: "text", text: "孩子结论Z" }] },
          usage: zero,
        };
        return;
      }
      const turn = parentTurn++;
      const content =
        turn === 0
          ? [
              {
                type: "tool_call" as const,
                id: "c1",
                name: "task",
                args: { description: "后台活", prompt: "去干", background: true },
              },
            ]
          : [{ type: "text" as const, text: `轮${turn}` }];
      yield {
        type: "done",
        stopReason: turn === 0 ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: zero,
      };
    },
  };

  const commandInbox = new CommandInbox(new MemoryCommandInboxStore());

  const m = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "p" }),
    subagents: true,
    permission: { mode: "auto" },
    commandInbox,
    tools: () =>
      new ToolRegistry().register({
        def: { name: "child_effect", description: "child effect", parameters: { type: "object" } },
        readOnly: false,
        capabilities: ["filesystem-write"],
        ruleKey: () => "child effect",
        async run() {
          childEffect = true;
          return "effect committed";
        },
      }),
  });
  const s = await m.createSession({ cwd: dir, model: "p" });
  const events: SessionEvent[] = [];
  await m.open(s.id, (ev) => events.push(ev));
  await m.send(s.id, "开始");
  assert.equal(parentTurn, 2, "第一次 drive 结束（task 立即返回 + 收尾轮）");
  assert.equal(childEffect, false, "root send 返回时后台副作用尚未发生");
  const runningCommand = (await commandInbox.store.read(s.id))[0]!;
  assert.equal(runningCommand.status, "running", "后台树运行期间 root command 必须保留 lease");

  // 会话空闲后子任务才完成 → onTaskNotice → 自动 send 通知 → 第二次 drive
  releaseChild();
  const deadline = Date.now() + 3000;
  while (parentTurn < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  assert.equal(parentTurn, 3, "应自动发起第二次 drive");
  assert.equal(childEffect, true, "后台子 agent 应在同一 command fence 内提交工具调用");
  const terminalDeadline = Date.now() + 3_000;
  let terminal = (await commandInbox.store.read(s.id)).find(
    (command) => command.id === runningCommand.id,
  );
  while (terminal?.status !== "completed" && Date.now() < terminalDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    terminal = (await commandInbox.store.read(s.id)).find(
      (command) => command.id === runningCommand.id,
    );
  }
  assert.equal(terminal?.status, "completed");
  const notif = events.find(
    (e) =>
      e.type === "agent" &&
      e.event.type === "user_message" &&
      e.event.text.startsWith("<task-notification"),
  );
  assert.ok(notif, "自动 drive 的输入应是通知信封");
  assert.ok(
    events.filter((e) => e.type === "state" && (e as any).running === true).length >= 2,
    "至少两次 running 状态（手动 + 自动）",
  );
  // snapshot 携带后台任务摘要（晚订阅者/daemon 客户端可见）。
  const snap = m.peek(s.id)!;
  assert.equal(snap.backgroundTasks?.length, 1);
  assert.equal(snap.backgroundTasks![0]!.id, "t1");
  assert.equal(snap.backgroundTasks![0]!.status, "done");
  await m.shutdown();
  await fs.rm(dir, { recursive: true, force: true });
});
