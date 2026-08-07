/**
 * HTTP + SSE 传输端到端测试：真 http server（随机端口）+ HttpSessionHost。
 * 验证与 socket daemon 等价的核心语义：snapshot 先行、事件广播、多客户端共享，
 * 以及 HTTP 版独有的 permission-mode / permission-profile 端点与 token 鉴权。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { EventEmitter } from "node:events";
import * as os from "node:os";
import * as path from "node:path";
import {
  HttpDaemonServer,
  SseBackpressureWriter,
  waitForHttpDrain,
  type SseWritable,
} from "./http-server.js";
import { HttpSessionHost, parseSseChunk } from "./http-client.js";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import { SessionStore } from "../session.js";
import type { ChatMessage, Provider, StreamEvent } from "../index.js";

const TEST_HTTP_TOKEN = "anicode-core-http-test-token-32-bytes-minimum";

function authenticatedFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TEST_HTTP_TOKEN}`);
  return fetch(input, { ...init, headers });
}

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

async function startHttp(
  dir: string,
  provider: Provider,
  token = TEST_HTTP_TOKEN,
  discoverModels?: (providerId: string) => Promise<string[] | undefined>,
) {
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  const server = new HttpDaemonServer({
    manager,
    token,
    ...(discoverModels ? { discoverModels } : {}),
  });
  await server.listen(0);
  return { manager, server, baseUrl: `http://127.0.0.1:${server.port()}` };
}

test("http host: authenticated model discovery executes server-side and validates boundaries", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-models-"));
  const calls: string[] = [];
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([]),
    TEST_HTTP_TOKEN,
    async (providerId) => {
      calls.push(providerId);
      if (providerId === "broken") throw new Error("secret upstream failure");
      return ["live-a", "live-a", "\u001b[31munsafe"];
    },
  );
  const auth = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const anonymous = await fetch(`${baseUrl}/providers/cliproxy/models`);
    assert.equal(anonymous.status, 401, "model discovery must never expose server credentials");
    assert.deepEqual(await auth.discoverModels("cliproxy"), ["live-a"]);
    assert.equal(await auth.discoverModels("broken"), undefined);
    assert.deepEqual(
      calls,
      ["cliproxy", "broken"],
      "discovery must execute behind the HTTP boundary",
    );
    await assert.rejects(() => auth.discoverModels("../cliproxy"), /Invalid provider id/);
    const encodedSlash = await authenticatedFetch(
      `${baseUrl}/providers/${encodeURIComponent("../cliproxy")}/models`,
    );
    assert.equal(encodedSlash.status, 400);
  } finally {
    auth.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

class FakeSseWritable extends EventEmitter implements SseWritable {
  readonly writes: string[] = [];
  writableLength = 0;
  accepting = false;

  write(frame: string): boolean {
    this.writes.push(frame);
    this.writableLength += Buffer.byteLength(frame);
    return this.accepting;
  }

  drain(): void {
    this.writableLength = 0;
    this.accepting = true;
    this.emit("drain");
  }
}

test("HTTP artifact drain wait rejects on client close and releases every listener", async () => {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
  }) as unknown as Parameters<typeof waitForHttpDrain>[0];
  const waiting = waitForHttpDrain(response);
  response.emit("close");
  await assert.rejects(waiting, /disconnected/);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(response.listenerCount("error"), 0);
});

test("SSE writer: write(false) queues in order, drain resumes, and slow clients are bounded", () => {
  const sink = new FakeSseWritable();
  let overflowed = 0;
  const writer = new SseBackpressureWriter(
    sink,
    { maxPendingBytes: 1024, maxPendingEvents: 2 },
    () => overflowed++,
  );
  assert.equal(writer.raw("first"), true);
  assert.equal(writer.raw("second"), true);
  assert.equal(writer.raw("third"), true);
  assert.deepEqual(sink.writes, ["first"], "blocked writes must stay in the process queue");
  sink.drain();
  assert.deepEqual(sink.writes, ["first", "second", "third"]);
  assert.equal(overflowed, 0);
  writer.close();
  assert.equal(sink.listenerCount("drain"), 0);

  const slow = new FakeSseWritable();
  const bounded = new SseBackpressureWriter(
    slow,
    { maxPendingBytes: 1024, maxPendingEvents: 1 },
    () => overflowed++,
  );
  bounded.raw("blocked");
  bounded.raw("queued");
  assert.equal(bounded.raw("overflow"), false);
  assert.equal(overflowed, 1);
  assert.equal(slow.listenerCount("drain"), 0, "overflow must release the drain listener");
  slow.drain();
  assert.deepEqual(slow.writes, ["blocked"], "closed slow clients must never flush stale frames");
});

test("sse 解析：分帧/多 data 行/心跳注释/半帧留存", () => {
  const input =
    ": ping\n\n" +
    'event: snapshot\ndata: {"a":1}\n\n' +
    "event: session\ndata: line1\ndata: line2\n\n" +
    'event: session\ndata: {"partial"';
  const { frames, rest } = parseSseChunk(input);
  assert.equal(frames.length, 2);
  assert.deepEqual(frames[0], { event: "snapshot", data: '{"a":1}' });
  assert.deepEqual(frames[1], { event: "session", data: "line1\nline2" });
  assert.match(rest, /partial/);
  assert.throws(
    () => parseSseChunk(`data: ${"x".repeat(64)}`, 32),
    /SSE (?:frame exceeds safety limit|帧超过安全上限)/,
  );
});

test("http host: request and initial snapshot deadlines fail closed", async () => {
  const server = createHttpServer((req, res) => {
    if (req.url === "/sessions") return; // connected peer that never sends headers
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": heartbeat\n\n"); // valid stream that deliberately never sends a snapshot
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") assert.fail("expected TCP test server");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const requestHost = new HttpSessionHost({ baseUrl, requestTimeoutMs: 50 });
  const streamHost = new HttpSessionHost({ baseUrl, snapshotTimeoutMs: 50 });
  try {
    await assert.rejects(
      requestHost.listSessions(),
      /HTTP (?:request timed out after 50 ms|请求在 50 ms 后超时)/,
    );
    await assert.rejects(
      streamHost.open("s_stalled", () => {}),
      /SSE snapshot (?:timed out after 50 ms|在 50 ms 后超时)/,
    );
  } finally {
    requestHost.dispose();
    streamHost.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("http host: oversized JSON responses are rejected before parsing", async () => {
  const payload = JSON.stringify({ value: "x".repeat(1024) });
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") assert.fail("expected TCP test server");
  const host = new HttpSessionHost({
    baseUrl: `http://127.0.0.1:${address.port}`,
    maxResponseBytes: 128,
  });
  try {
    await assert.rejects(
      host.listSessions(),
      /HTTP (?:response exceeds safety limit|响应超过安全上限)/,
    );
  } finally {
    host.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("http host: snapshot permissionMode stays optional but rejects unknown values", async () => {
  const server = createHttpServer((req, res) => {
    const sessionId = req.url?.includes("s_legacy")
      ? "s_legacy"
      : req.url?.includes("s_malformed")
        ? "s_malformed"
        : "s_invalid";
    const snapshot =
      sessionId === "s_malformed"
        ? {}
        : {
            meta: { id: sessionId },
            messages: [],
            usage: {},
            running: false,
            ...(sessionId === "s_invalid" ? { permissionMode: "unsafe" } : {}),
            pendingPermissions: [],
          };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ type: "session.snapshot", properties: { sessionId, snapshot } })}\n\n`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") assert.fail("expected TCP test server");
  const host = new HttpSessionHost({ baseUrl: `http://127.0.0.1:${address.port}` });
  try {
    const legacy = await host.open("s_legacy", () => {});
    assert.equal(legacy.snapshot.permissionMode, undefined);
    legacy.close();
    await assert.rejects(
      host.open("s_malformed", () => {}),
      /(?:Invalid|无效) SSE snapshot/,
    );
    await assert.rejects(
      host.open("s_invalid", () => {}),
      /(?:Invalid|无效) SSE snapshot/,
    );
  } finally {
    host.dispose();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("http server: bounded request contract rejects negative indexes and oversized tracing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-contract-"));
  const { server, baseUrl } = await startHttp(dir, scriptedProvider([]));
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    const fork = await authenticatedFetch(`${baseUrl}/sessions/${meta.id}/fork`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ upToMessage: -1 }),
    });
    assert.equal(fork.status, 400);
    const send = await authenticatedFetch(`${baseUrl}/sessions/${meta.id}/send`, {
      method: "POST",
      headers: { "content-type": "application/json", traceparent: "x".repeat(513) },
      body: JSON.stringify({ text: "hello" }),
    });
    assert.equal(send.status, 400);
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http send: exact idempotent retries coalesce and payload conflicts return 409", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-idempotency-"));
  let providerCalls = 0;
  const provider: Provider = {
    name: "counted",
    async *stream(): AsyncIterable<StreamEvent> {
      providerCalls++;
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const { server, baseUrl } = await startHttp(dir, provider);
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await host.createSession({ cwd: dir, model: "counted" });
    const send = (text: string) =>
      authenticatedFetch(`${baseUrl}/sessions/${meta.id}/send`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "same-request" },
        body: JSON.stringify({ text }),
      });
    const [first, retry] = await Promise.all([send("build once"), send("build once")]);
    assert.equal(first.status, 204);
    assert.equal(retry.status, 204);
    assert.equal(providerCalls, 1, "exact retries must join the authoritative command");

    const conflict = await send("different payload");
    assert.equal(conflict.status, 409);
    assert.equal(
      ((await conflict.json()) as { code?: string }).code,
      "COMMAND_IDEMPOTENCY_CONFLICT",
    );
    assert.equal(providerCalls, 1);
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http host: 建会话 → SSE snapshot 先行 → send 两个客户端都收事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "HTTP 回答" }] }]]),
  );
  const a = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  const b = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await a.createSession({ cwd: dir, model: "scripted", title: "http 会话" });
    assert.ok((await a.listSessions()).some((s) => s.id === meta.id));

    const eventsA: SessionEvent[] = [];
    const eventsB: SessionEvent[] = [];
    const ha = await a.open(meta.id, (ev) => eventsA.push(ev));
    const hb = await b.open(meta.id, (ev) => eventsB.push(ev));
    assert.equal(ha.snapshot.meta.id, meta.id); // snapshot 先行契约
    assert.equal(hb.snapshot.meta.id, meta.id);

    await a.send(meta.id, "你好");
    // send resolve 在 drive 收尾后；SSE 推送是异步网络，稍等片刻收齐
    await new Promise((r) => setTimeout(r, 150));
    const textOf = (evs: SessionEvent[]) =>
      evs
        .filter((e) => e.type === "agent")
        .map((e) => JSON.stringify(e))
        .join("");
    assert.match(textOf(eventsA), /HTTP 回答/, "发起方应收到事件");
    assert.match(textOf(eventsB), /HTTP 回答/, "观察方也应收到广播事件");

    ha.close();
    hb.close();
  } finally {
    a.dispose();
    b.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http host: permission-mode / permission-profile 端到端可切", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(dir, scriptedProvider([]));
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    const profiles = await host.listPermissionProfiles(meta.id);
    assert.ok(profiles.readonly && profiles.full, "应能列出内置档位");

    assert.equal(await host.setPermissionProfile(meta.id, "readonly"), "plan");
    await host.setPermissionMode(meta.id, "default"); // 直接切模式也通
    await assert.rejects(() => host.setPermissionProfile(meta.id, "nope"), /nope/);
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http host: default auth rejects anonymous REST/SSE and never accepts URL tokens", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  const server = new HttpDaemonServer({ manager });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${server.port()}`;
  const token = server.authenticationToken();
  const anon = new HttpSessionHost({ baseUrl });
  const auth = new HttpSessionHost({ baseUrl, token });
  try {
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    await assert.rejects(() => anon.listSessions(), /unauthorized|401/);
    assert.equal((await fetch(`${baseUrl}/events`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/sessions/missing/events`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/providers/cliproxy/models`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseUrl}/global/health`)).status, 200);
    const leakedQuery = await fetch(`${baseUrl}/sessions?token=${encodeURIComponent(token)}`);
    assert.equal(leakedQuery.status, 401);
    const meta = await auth.createSession({ cwd: dir, model: "scripted" });
    const handle = await auth.open(meta.id, () => {});
    assert.equal(handle.snapshot.meta.id, meta.id);
    handle.close();
  } finally {
    anon.dispose();
    auth.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http security: configured bearer tokens enforce the shared strong-token policy", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-token-strength-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  try {
    assert.throws(() => new HttpDaemonServer({ manager, token: "short" }), /at least 32 bytes/);
    assert.throws(
      () => new HttpDaemonServer({ manager, token: `${"x".repeat(32)}\n` }),
      /control characters|whitespace/,
    );
  } finally {
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http security: clients require TLS off loopback and server refuses non-loopback bind", async () => {
  assert.throws(
    () => new HttpSessionHost({ baseUrl: "http://example.com:8317" }),
    /must use HTTPS/,
  );
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-bind-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  const server = new HttpDaemonServer({ manager });
  await assert.rejects(() => server.listen(0, "0.0.0.0"), /loopback host/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("http security: per-address rate limit returns 429 and Retry-After", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-rate-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  const server = new HttpDaemonServer({ manager, rateLimit: { maxRequests: 1 } });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${server.port()}`;
  try {
    assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
    const limited = await fetch(`${baseUrl}/healthz`);
    assert.equal(limited.status, 429);
    assert.ok(limited.headers.get("retry-after"));
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http lifecycle: close is idempotent and force-closes a stalled active handler", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-close-deadline-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  let entered!: () => void;
  const handlerEntered = new Promise<void>((resolve) => (entered = resolve));
  const server = new HttpDaemonServer({
    manager,
    token: TEST_HTTP_TOKEN,
    shutdownGraceMs: 100,
    discoverModels: () => {
      entered();
      return new Promise<string[] | undefined>(() => {});
    },
    onClose: () => manager.shutdown(),
  });
  await server.listen(0);
  const pendingRequest = authenticatedFetch(
    `http://127.0.0.1:${server.port()}/providers/cliproxy/models`,
  ).catch(() => undefined);
  await handlerEntered;
  const started = Date.now();
  try {
    const firstClose = server.close();
    const secondClose = server.close();
    assert.equal(firstClose, secondClose, "close callers must share one shutdown fence");
    await firstClose;
    assert.ok(Date.now() - started < 1_000, "stalled handlers must not block shutdown forever");
    await pendingRequest;
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http host: undo 无快照时报错经 HTTP 透传", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(dir, scriptedProvider([]));
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    await assert.rejects(() => host.undo(meta.id));
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http REST: 资源模型 —— GET/PATCH/DELETE /sessions/:id、messages、checkpoints、doc、health", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "投影回答" }] }]]),
  );
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const health = (await (await fetch(`${baseUrl}/global/health`)).json()) as {
      ok: boolean;
      protocol: number;
    };
    assert.equal(health.ok, true);
    assert.ok(health.protocol >= 1);

    const doc = (await (await authenticatedFetch(`${baseUrl}/doc`)).json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    assert.equal(doc.openapi, "3.1.1");
    assert.ok(doc.paths["/sessions/{id}/messages"]);

    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    await host.send(meta.id, "你好");

    // GET /sessions/:id → 快照
    const snap = (await (await authenticatedFetch(`${baseUrl}/sessions/${meta.id}`)).json()) as {
      meta: { id: string };
      messages: unknown[];
      running: boolean;
    };
    assert.equal(snap.meta.id, meta.id);
    assert.ok(snap.messages.length >= 2);

    // GET /sessions/:id/messages → Message+Parts 投影
    const messages = (await (
      await authenticatedFetch(`${baseUrl}/sessions/${meta.id}/messages`)
    ).json()) as {
      info: { role: string };
      parts: { type: string; text?: string }[];
    }[];
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.info.role, "user");
    assert.equal(messages[1]!.info.role, "assistant");
    assert.ok(messages[1]!.parts.some((p) => p.type === "text" && p.text === "投影回答"));

    // PATCH 标题
    const patch = await authenticatedFetch(`${baseUrl}/sessions/${meta.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "新标题" }),
    });
    assert.equal(patch.status, 204);
    assert.equal((await host.listSessions()).find((s) => s.id === meta.id)?.title, "新标题");

    // checkpoints（未开启快照 → 空数组而非报错）
    const cps = (await (
      await authenticatedFetch(`${baseUrl}/sessions/${meta.id}/checkpoints`)
    ).json()) as unknown[];
    assert.deepEqual(cps, []);

    // DELETE → 列表消失，GET 404
    const del = await authenticatedFetch(`${baseUrl}/sessions/${meta.id}`, {
      method: "DELETE",
    });
    assert.equal(del.status, 204);
    assert.ok(!(await host.listSessions()).some((s) => s.id === meta.id));
    assert.equal((await authenticatedFetch(`${baseUrl}/sessions/${meta.id}`)).status, 404);
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http DELETE starts the durable fence without awaiting a hung lazy SSE feed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-delete-feed-race-"));
  const { manager, server, baseUrl } = await startHttp(dir, scriptedProvider([]));
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  let releaseFeed!: () => void;
  let feedStarted!: () => void;
  let deletionStarted!: () => void;
  const feedGate = new Promise<void>((resolve) => {
    releaseFeed = resolve;
  });
  const feedWasStarted = new Promise<void>((resolve) => {
    feedStarted = resolve;
  });
  const deletionWasStarted = new Promise<void>((resolve) => {
    deletionStarted = resolve;
  });
  const originalOpen = manager.open.bind(manager);
  const originalDelete = manager.deleteSession.bind(manager);
  manager.open = async (sessionId, listener) => {
    feedStarted();
    await feedGate;
    return originalOpen(sessionId, listener);
  };
  manager.deleteSession = (sessionId) => {
    deletionStarted();
    return originalDelete(sessionId);
  };

  let eventsRequest: Promise<Response> | undefined;
  let deletionRequest: Promise<Response> | undefined;
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    eventsRequest = authenticatedFetch(`${baseUrl}/sessions/${meta.id}/events`);
    await feedWasStarted;

    deletionRequest = authenticatedFetch(`${baseUrl}/sessions/${meta.id}`, {
      method: "DELETE",
    });
    const fenceWonRace = await Promise.race([
      deletionWasStarted.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
    ]);
    assert.equal(fenceWonRace, true, "feedLoads must not precede the durable deletion claim");
    const deletionFinished = await Promise.race([
      deletionRequest.then((response) => response),
      new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1_500)),
    ]);
    assert.ok(deletionFinished, "DELETE must not wait for a hung feed load");
    assert.equal(deletionFinished.status, 204);
  } finally {
    releaseFeed();
    await deletionRequest?.catch(() => undefined);
    const eventsResponse = await eventsRequest?.catch(() => undefined);
    if (eventsResponse) assert.equal(eventsResponse.status, 404);
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http SSE: 信封协议 —— server.connected 首帧、snapshot 次帧、parts 投影事件广播", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "信封回答" }] }]]),
  );
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    const ac = new AbortController();
    const res = await authenticatedFetch(`${baseUrl}/sessions/${meta.id}/events`, {
      signal: ac.signal,
    });
    assert.ok(res.body);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const envelopes: { id: string; type: string; properties: Record<string, unknown> }[] = [];
    let buf = "";
    const pump = (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { frames, rest } = parseSseChunk(buf);
        buf = rest;
        for (const f of frames) envelopes.push(JSON.parse(f.data) as (typeof envelopes)[number]);
      }
    })();

    // 等首两帧
    for (let i = 0; i < 50 && envelopes.length < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    assert.equal(envelopes[0]?.type, "server.connected");
    assert.equal(envelopes[1]?.type, "session.snapshot");
    assert.ok(envelopes.every((e) => /^evt_/.test(e.id)));

    await host.send(meta.id, "你好");
    await new Promise((r) => setTimeout(r, 200));

    const types = envelopes.map((e) => e.type);
    assert.ok(types.includes("session.event"), "SessionEvent 透传通道");
    assert.ok(types.includes("session.status"), "命名运行态事件");
    assert.ok(types.includes("message.updated"), "消息投影");
    const deltas = envelopes.filter((e) => e.type === "message.part.delta");
    assert.ok(
      deltas.some((e) => (e.properties as { delta?: string }).delta?.includes("信封回答")),
      "part 级文本增量",
    );
    const partUpdates = envelopes.filter((e) => e.type === "message.part.updated");
    assert.ok(partUpdates.length > 0, "part 终态事件");

    ac.abort();
    await pump;
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http SSE: snapshots larger than one frame are drained in bounded ordered chunks", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-large-snapshot-"));
  const largeText = `begin-${"x".repeat(2 * 1024 * 1024)}-end`;
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: largeText }] }]]),
  );
  const writer = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  const reader = new HttpSessionHost({
    baseUrl,
    token: TEST_HTTP_TOKEN,
    maxSseFrameBytes: 512 * 1024,
  });
  const bounded = new HttpSessionHost({
    baseUrl,
    token: TEST_HTTP_TOKEN,
    maxSseFrameBytes: 512 * 1024,
    maxSseSnapshotBytes: 512 * 1024,
  });
  try {
    const meta = await writer.createSession({ cwd: dir, model: "scripted" });
    await writer.send(meta.id, "produce a long answer");
    const handle = await reader.open(meta.id, () => {});
    assert.equal(handle.snapshot.messages.length, 2);
    assert.equal((handle.snapshot.messages[1]!.content[0] as { text: string }).text, largeText);
    handle.close();
    await assert.rejects(() => bounded.open(meta.id, () => {}), /snapshot 超过|snapshot exceeds/);
  } finally {
    writer.dispose();
    reader.dispose();
    bounded.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

type Env = { id: string; type: string; properties: Record<string, unknown> };
const CONTROL = new Set([
  "server.connected",
  "server.heartbeat",
  "session.snapshot",
  "session.snapshot.chunk",
]);

/**
 * 后台 pump 读 SSE 流入数组，主循环轮询直到 predicate 满足或超时，然后中断连接。
 * 关键：不在 `reader.read()` 上做时间判断（它会一直阻塞到有数据/30s 心跳），而是让
 * pump 独立读、主循环 poll，超时即 abort —— 否则会被心跳间隔拖住。
 */
async function collectEnvelopes(
  baseUrl: string,
  pathStr: string,
  until: (envs: Env[]) => boolean,
  timeoutMs = 2000,
): Promise<Env[]> {
  const ac = new AbortController();
  const res = await authenticatedFetch(`${baseUrl}${pathStr}`, { signal: ac.signal });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const envs: Env[] = [];
  let buf = "";
  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { frames, rest } = parseSseChunk(buf);
      buf = rest;
      for (const f of frames) envs.push(JSON.parse(f.data) as Env);
    }
  })();
  const start = Date.now();
  while (Date.now() - start < timeoutMs && !until(envs))
    await new Promise((r) => setTimeout(r, 15));
  ac.abort();
  await pump.catch(() => {});
  return envs;
}

test("http SSE: Last-Event-ID 续传 —— 增量补发且不重发快照", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "续传回答" }] }]]),
  );
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    // 边读边 send：一条连接实时采集本轮的可续传事件（feed linger 让缓冲在断开后仍存活）
    const liveP = collectEnvelopes(
      baseUrl,
      `/sessions/${meta.id}/events`,
      (e) => e.filter((x) => !CONTROL.has(x.type)).length >= 3,
      2500,
    );
    await new Promise((r) => setTimeout(r, 50));
    await host.send(meta.id, "你好");
    const first = await liveP;
    assert.equal(first[0]!.type, "server.connected");
    assert.equal(first[1]!.type, "session.snapshot");
    const replayable = first.filter((e) => !CONTROL.has(e.type));
    assert.ok(replayable.length >= 2, "应采集到多个可续传事件");
    const cutoff = replayable[0]!.id;

    // 用 cutoff 续传：server.connected 打头、其后事件补发、不回落快照、不重发 cutoff
    const resumed = await collectEnvelopes(
      baseUrl,
      `/sessions/${meta.id}/events?lastEventId=${encodeURIComponent(cutoff)}`,
      (e) => e.length >= 2,
      1500,
    );
    assert.equal(resumed[0]!.type, "server.connected");
    assert.ok(!resumed.some((e) => e.type === "session.snapshot"), "续传不应回落整份快照");
    assert.ok(!resumed.some((e) => e.id === cutoff), "不应重发 cutoff 自身");
    assert.ok(
      resumed.some((e) => e.id === replayable[replayable.length - 1]!.id),
      "cutoff 之后的事件应被补发",
    );

    // 未知 id → 回落整份快照
    const stale = await collectEnvelopes(
      baseUrl,
      `/sessions/${meta.id}/events?lastEventId=evt_deadbeef`,
      (e) => e.some((x) => x.type === "session.snapshot"),
      1500,
    );
    assert.ok(
      stale.some((e) => e.type === "session.snapshot"),
      "未知 id 应重同步",
    );

    const activeSession = await authenticatedFetch(`${baseUrl}/sessions/${meta.id}/events`);
    const activeFirehose = await authenticatedFetch(`${baseUrl}/events`);
    const sessionReader = activeSession.body!.getReader();
    const firehoseReader = activeFirehose.body!.getReader();
    await sessionReader.read();
    await firehoseReader.read();

    const deleted = await authenticatedFetch(`${baseUrl}/sessions/${meta.id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 204);
    const closesPromptly = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
      Promise.race([
        reader.read().then(
          (result) => result.done,
          () => true,
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_500)),
      ]);
    assert.equal(await closesPromptly(sessionReader), true, "删除必须撤销活跃会话流");
    assert.equal(await closesPromptly(firehoseReader), true, "删除必须撤销含旧事件的 firehose");

    const afterDelete = await authenticatedFetch(
      `${baseUrl}/sessions/${meta.id}/events?lastEventId=${encodeURIComponent(cutoff)}`,
    );
    assert.equal(afterDelete.status, 404, "删除后旧 Last-Event-ID 不能回放会话内容");
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http SSE: 全局 firehose GET /events 跨会话广播，不发快照", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const { server, baseUrl } = await startHttp(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "firehose 回答" }] }]]),
  );
  const host = new HttpSessionHost({ baseUrl, token: TEST_HTTP_TOKEN });
  try {
    const meta = await host.createSession({ cwd: dir, model: "scripted" });
    // 先起 firehose，再 send（firehose 只覆盖订阅期间的 live 事件）
    const collector = collectEnvelopes(
      baseUrl,
      `/events`,
      (e) => e.some((x) => x.type === "message.updated"),
      2500,
    );
    await new Promise((r) => setTimeout(r, 50));
    await host.send(meta.id, "你好");
    const envs = await collector;
    assert.equal(envs[0]!.type, "server.connected");
    assert.ok(!envs.some((e) => e.type === "session.snapshot"), "firehose 不发快照");
    assert.ok(
      envs.some((e) => e.type === "session.event" && e.properties.sessionId === meta.id),
      "firehose 应带 sessionId 广播会话事件",
    );
    assert.ok(
      envs.some((e) => e.type === "message.updated"),
      "firehose 含 parts 投影",
    );
  } finally {
    host.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("http: 目录级多实例路由 —— x-anicode-directory / ?directory= 隔离会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-http-"));
  const projectA = path.join(dir, "project-a");
  const projectB = path.join(dir, "project-b");
  await fs.mkdir(projectA, { recursive: true });
  await fs.mkdir(projectB, { recursive: true });
  const provider = scriptedProvider([]);
  const mk = (sub: string) =>
    new SessionManager({
      store: new SessionStore(path.join(dir, sub)),
      resolveProvider: () => ({ provider, model: "scripted" }),
    });
  const managers = new Map([
    [projectA, mk("a")],
    [projectB, mk("b")],
  ]);
  const fallback = mk("default");
  const server = new HttpDaemonServer({
    manager: fallback,
    token: TEST_HTTP_TOKEN,
    resolveInstance: (d) => managers.get(d) ?? fallback,
  });
  await server.listen(0);
  const baseUrl = `http://127.0.0.1:${server.port()}`;
  try {
    // 在实例 A 建会话（经 header）
    const created = (await (
      await authenticatedFetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-anicode-directory": projectA },
        body: JSON.stringify({ cwd: projectA, model: "scripted" }),
      })
    ).json()) as { id: string };

    // 实例 A 列表可见（经 query）
    const listA = (await (
      await authenticatedFetch(`${baseUrl}/sessions?directory=${encodeURIComponent(projectA)}`)
    ).json()) as {
      id: string;
    }[];
    assert.ok(listA.some((s) => s.id === created.id));

    // 实例 B 与默认实例都看不到 A 的会话
    const listB = (await (
      await authenticatedFetch(`${baseUrl}/sessions?directory=${encodeURIComponent(projectB)}`)
    ).json()) as {
      id: string;
    }[];
    assert.ok(!listB.some((s) => s.id === created.id));
    const listDefault = (await (await authenticatedFetch(`${baseUrl}/sessions`)).json()) as {
      id: string;
    }[];
    assert.ok(!listDefault.some((s) => s.id === created.id));
  } finally {
    for (const m of managers.values()) m.dispose();
    fallback.dispose();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
