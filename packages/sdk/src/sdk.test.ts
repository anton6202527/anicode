/**
 * SDK 集成测试：真 HttpDaemonServer（随机端口）+ createAnicodeClient。
 * 覆盖 REST 资源模型、Message+Parts 投影读取、SSE 信封订阅、错误与鉴权。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HttpDaemonServer,
  SessionManager,
  SessionStore,
  type ChatMessage,
  type Provider,
  type StreamEvent,
} from "@anicode/core";
import { createAnicodeClient, AnicodeApiError, type EventEnvelope } from "./index.js";

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
        usage: { inputTokens: 7, outputTokens: 4, cacheReadTokens: 1, cacheWriteTokens: 0 },
      };
    },
  };
}

async function startServer(dir: string, provider: Provider, token?: string) {
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  const server = new HttpDaemonServer({ manager, ...(token ? { token } : {}) });
  await server.listen(0);
  return { server, baseUrl: `http://127.0.0.1:${server.port()}` };
}

test("sdk: 会话生命周期 + messages 投影 + doc/health", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "SDK 回答" }] }]]),
  );
  const client = createAnicodeClient({ baseUrl });
  try {
    const health = await client.global.health();
    assert.equal(health.ok, true);
    assert.equal(health.name, "anicode");

    const doc = await client.global.doc();
    assert.equal((doc as { openapi: string }).openapi, "3.1.1");

    const meta = await client.session.create({ cwd: dir, model: "scripted", title: "sdk 会话" });
    assert.ok((await client.session.list()).some((s) => s.id === meta.id));

    await client.session.send(meta.id, "你好");

    const snap = await client.session.get(meta.id);
    assert.equal(snap.meta.id, meta.id);
    assert.equal(snap.running, false);

    const messages = await client.session.messages(meta.id);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.info.role, "user");
    const assistant = messages[1]!;
    assert.equal(assistant.info.role, "assistant");
    assert.ok(assistant.parts.some((p) => p.type === "text" && p.text === "SDK 回答"));

    await client.session.setTitle(meta.id, "改名了");
    assert.equal((await client.session.list()).find((s) => s.id === meta.id)?.title, "改名了");

    assert.deepEqual(await client.session.checkpoints(meta.id), []);

    const artifact = await client.artifact.create(meta.id, {
      kind: "report",
      name: "report.txt",
      mediaType: "text/plain",
      text: "SDK artifact",
    });
    assert.equal((await client.artifact.list(meta.id))[0]?.id, artifact.id);
    const artifactBody = await client.artifact.get(meta.id, artifact.id);
    assert.equal(Buffer.from(artifactBody.dataBase64, "base64").toString(), "SDK artifact");

    const runtimeEvents = await client.runtime.events(meta.id);
    assert.ok(runtimeEvents.some((event) => event.type === "prompt.accepted"));
    assert.equal((await client.runtime.state(meta.id)).streamId, meta.id);
    await client.artifact.delete(meta.id, artifact.id);
    assert.deepEqual(await client.artifact.list(meta.id), []);

    await fs.writeFile(path.join(dir, "old.txt"), "source\n");
    await fs.writeFile(path.join(dir, "image.bin"), Buffer.from([0, 1, 2]));
    const prepared = await client.patchset.prepare(meta.id, {
      changes: [
        { path: "new.txt", renameFrom: "old.txt" },
        { path: "image.bin", dataBase64: Buffer.from([0, 9, 8, 7]).toString("base64") },
      ],
      requiredApprovals: 2,
      requiredRoles: ["reviewer", "security"],
    });
    assert.equal(prepared.patchset.status, "pending_approval");
    assert.match(prepared.preview, /rename-target new\.txt/);
    assert.equal(
      (await client.patchset.get(meta.id, prepared.patchset.id)).patchset.id,
      prepared.patchset.id,
    );
    await client.patchset.approve(meta.id, prepared.patchset.id, {
      actor: "alice",
      role: "reviewer",
      decision: "approve",
    });
    await assert.rejects(
      () => client.patchset.apply(meta.id, prepared.patchset.id),
      (error: unknown) => error instanceof AnicodeApiError && error.status === 409,
    );
    await client.patchset.approve(meta.id, prepared.patchset.id, {
      actor: "security-bot",
      role: "security",
      decision: "approve",
    });
    assert.equal((await client.patchset.apply(meta.id, prepared.patchset.id)).status, "applied");
    assert.equal(await fs.readFile(path.join(dir, "new.txt"), "utf8"), "source\n");
    assert.deepEqual([...(await fs.readFile(path.join(dir, "image.bin")))], [0, 9, 8, 7]);
    assert.equal(
      (await client.patchset.rollback(meta.id, prepared.patchset.id)).status,
      "rolled_back",
    );
    assert.equal(await fs.readFile(path.join(dir, "old.txt"), "utf8"), "source\n");
    await assert.rejects(() => fs.access(path.join(dir, "new.txt")));

    await fs.writeFile(path.join(dir, "merge.txt"), "one\ntwo\nthree");
    const stale = await client.patchset.prepare(meta.id, {
      changes: [{ path: "merge.txt", text: "ONE\ntwo\nthree" }],
    });
    await fs.writeFile(path.join(dir, "merge.txt"), "one\ntwo\nTHREE");
    await assert.rejects(
      () => client.patchset.apply(meta.id, stale.patchset.id),
      (error: unknown) => error instanceof AnicodeApiError && error.status === 409,
    );
    const rebased = await client.patchset.rebase(meta.id, stale.patchset.id);
    assert.deepEqual(rebased.conflictedPaths, []);
    await client.patchset.apply(meta.id, rebased.patchset.id);
    assert.equal(await fs.readFile(path.join(dir, "merge.txt"), "utf8"), "ONE\ntwo\nTHREE");

    await assert.rejects(
      () =>
        client.patchset.prepare(meta.id, {
          changes: [{ path: "bad.bin", dataBase64: "not-base64" }],
        }),
      (error: unknown) => error instanceof AnicodeApiError && error.status === 400,
    );

    const fork = await client.session.fork(meta.id, { title: "分叉" });
    assert.notEqual(fork.id, meta.id);

    await client.session.delete(meta.id);
    assert.ok(!(await client.session.list()).some((s) => s.id === meta.id));
    await assert.rejects(
      () => client.session.get(meta.id),
      (err: unknown) => err instanceof AnicodeApiError && err.status === 404,
    );
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk/openapi: pagination、Artifact 原始流/摘要校验、结构化错误与客户端预检", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-contract-"));
  const { server, baseUrl } = await startServer(dir, scriptedProvider([]));
  const client = createAnicodeClient({ baseUrl });
  try {
    const sessions = await Promise.all(
      ["one", "two", "three"].map((title) =>
        client.session.create({ cwd: dir, model: "scripted", title }),
      ),
    );
    const first = await client.session.listPage({ limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await client.session.listPage({ limit: 2, cursor: first.nextCursor });
    assert.equal(second.items.length, 1);

    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    const artifact = await client.artifact.create(sessions[0]!.id, {
      kind: "file",
      name: "payload.bin",
      mediaType: "application/octet-stream",
      dataBase64: Buffer.from(bytes).toString("base64"),
    });
    const opened = await client.artifact.open(sessions[0]!.id, artifact.id);
    assert.match(opened.headers.get("content-digest") ?? "", /^sha-256=:/);
    assert.deepEqual(new Uint8Array(await opened.arrayBuffer()), bytes);
    assert.deepEqual(await client.artifact.download(sessions[0]!.id, artifact.id), bytes);

    await assert.rejects(
      () => client.session.create({ cwd: "", model: "scripted" }),
      (error: unknown) => error instanceof TypeError && /minLength/.test(error.message),
    );
    const incompatible = createAnicodeClient({ baseUrl, apiVersion: 999 });
    await assert.rejects(
      () => incompatible.global.health(),
      (error: unknown) =>
        error instanceof AnicodeApiError &&
        error.status === 426 &&
        error.code === "UNSUPPORTED_API_VERSION" &&
        Boolean(error.requestId),
    );
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk transport: generated method、API headers 与仅幂等请求重试", async () => {
  let healthCalls = 0;
  const seenHeaders: Headers[] = [];
  const retrying = createAnicodeClient({
    baseUrl: "https://api.example",
    maxRetries: 2,
    retryDelayMs: 1,
    fetch: (async (_input, init) => {
      seenHeaders.push(new Headers(init?.headers));
      healthCalls++;
      return healthCalls < 3
        ? Response.json({ error: "busy" }, { status: 503 })
        : Response.json({ ok: true, name: "anicode", protocol: 1 });
    }) as typeof fetch,
  });
  assert.equal((await retrying.global.health()).ok, true);
  assert.equal(healthCalls, 3);
  assert.ok(seenHeaders.every((headers) => headers.get("x-anicode-api-version") === "1"));
  assert.equal(new Set(seenHeaders.map((headers) => headers.get("x-request-id"))).size, 1);

  let createCalls = 0;
  const noMutationRetry = createAnicodeClient({
    baseUrl: "https://api.example",
    maxRetries: 2,
    retryDelayMs: 1,
    fetch: (async () => {
      createCalls++;
      return Response.json(
        { error: "busy", code: "BUSY", requestId: "req-server", details: { retry: false } },
        { status: 503 },
      );
    }) as typeof fetch,
  });
  await assert.rejects(
    () => noMutationRetry.session.create({ cwd: "/repo", model: "test" }),
    (error: unknown) =>
      error instanceof AnicodeApiError &&
      error.code === "BUSY" &&
      error.requestId === "req-server" &&
      (error.details as { retry?: boolean }).retry === false,
  );
  assert.equal(createCalls, 1);

  let sendCalls = 0;
  const idempotentMutation = createAnicodeClient({
    baseUrl: "https://api.example",
    maxRetries: 1,
    retryDelayMs: 1,
    fetch: (async (_input, init) => {
      sendCalls++;
      assert.equal(new Headers(init?.headers).get("idempotency-key"), "command-1");
      return sendCalls === 1
        ? Response.json({ error: "busy" }, { status: 503 })
        : new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  await idempotentMutation.session.send("s_1", "run", { idempotencyKey: "command-1" });
  assert.equal(sendCalls, 2);
});

test("sdk: event.subscribe —— 信封序保证与 parts 投影事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "订阅回答" }] }]]),
  );
  const client = createAnicodeClient({ baseUrl });
  try {
    const meta = await client.session.create({ cwd: dir, model: "scripted" });
    const ac = new AbortController();
    const seen: EventEnvelope[] = [];
    const consumer = (async () => {
      try {
        for await (const ev of client.event.subscribe(meta.id, { signal: ac.signal }))
          seen.push(ev);
      } catch {
        /* abort 收尾 */
      }
    })();

    for (let i = 0; i < 50 && seen.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen[0]?.type, "server.connected");
    assert.equal(seen[1]?.type, "session.snapshot");

    await client.session.send(meta.id, "你好");
    await new Promise((r) => setTimeout(r, 200));

    const types = seen.map((e) => e.type);
    assert.ok(types.includes("message.updated"));
    assert.ok(types.includes("message.part.updated"));
    assert.ok(
      seen.some(
        (e) =>
          e.type === "message.part.delta" &&
          String((e.properties as { delta?: string }).delta).includes("订阅回答"),
      ),
    );
    assert.ok(types.includes("session.status"));

    ac.abort();
    await consumer;
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk: token 鉴权 —— 无凭据 401，REST/SSE 均走 Authorization header", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(dir, scriptedProvider([]), "s3cret");
  const anon = createAnicodeClient({ baseUrl });
  const auth = createAnicodeClient({ baseUrl, token: "s3cret" });
  try {
    await assert.rejects(
      () => anon.session.list(),
      (err: unknown) => err instanceof AnicodeApiError && err.status === 401,
    );
    const meta = await auth.session.create({ cwd: dir, model: "scripted" });
    const ac = new AbortController();
    const first: EventEnvelope[] = [];
    const consumer = (async () => {
      try {
        for await (const ev of auth.event.subscribe(meta.id, { signal: ac.signal })) {
          first.push(ev);
          if (first.length >= 1) ac.abort();
        }
      } catch {
        /* abort 收尾 */
      }
    })();
    for (let i = 0; i < 50 && first.length < 1; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(first[0]?.type, "server.connected");
    await consumer;
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk: 权限域 —— listProfiles/setProfile/setMode", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(dir, scriptedProvider([]));
  const client = createAnicodeClient({ baseUrl });
  try {
    const meta = await client.session.create({ cwd: dir, model: "scripted" });
    const profiles = await client.permission.listProfiles(meta.id);
    assert.ok(profiles.readonly && profiles.full);
    assert.equal(await client.permission.setProfile(meta.id, "readonly"), "plan");
    await client.permission.setMode(meta.id, "default");
    await assert.rejects(() => client.permission.setProfile(meta.id, "nope"));
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("sdk: event.subscribeAll —— 全局 firehose 跨会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sdk-"));
  const { server, baseUrl } = await startServer(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "全局回答" }] }]]),
  );
  const client = createAnicodeClient({ baseUrl });
  try {
    const meta = await client.session.create({ cwd: dir, model: "scripted" });
    const ac = new AbortController();
    const seen: EventEnvelope[] = [];
    const consumer = (async () => {
      try {
        for await (const ev of client.event.subscribeAll({ signal: ac.signal })) {
          seen.push(ev);
          if (seen.some((e) => e.type === "message.updated")) ac.abort();
        }
      } catch {
        /* abort 收尾 */
      }
    })();
    await new Promise((r) => setTimeout(r, 50));
    await client.session.send(meta.id, "你好");
    await new Promise((r) => setTimeout(r, 250));
    ac.abort();
    await consumer;
    assert.equal(seen[0]?.type, "server.connected");
    assert.ok(!seen.some((e) => e.type === "session.snapshot"), "firehose 不发快照");
    assert.ok(
      seen.some((e) => e.type === "session.event" && e.properties.sessionId === meta.id),
      "带 sessionId 广播",
    );
    assert.ok(
      seen.some((e) => e.type === "message.updated"),
      "含 parts 投影",
    );
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
