/**
 * 守护进程端到端测试：真 unix socket，验证新的 subscribe/broadcast 架构。
 * 重点验证旧版做不到的事：
 *   - 两个客户端 open 同一会话，一个 send，两个都收到事件（共享/接管）
 *   - 权限经协议广播，任一客户端裁决
 *   - open 立即拿到 snapshot（resume 渲染）
 *   - DaemonClient 满足 SessionHost 接口，与 LocalSessionHost 可换
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { DaemonServer } from "./server.js";
import { DaemonClient } from "./client.js";
import { MAX_FRAME_BYTES } from "./protocol.js";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import { SessionStore } from "../session.js";
import type { SessionHost } from "../host.js";
import type { Provider, StreamEvent, ChatMessage } from "../index.js";

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

async function startDaemon(dir: string, provider: Provider) {
  const sockPath = path.join(dir, "d.sock");
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  const server = new DaemonServer({ manager });
  await server.listen(sockPath);
  return { server, sockPath };
}

test("daemon: 两个客户端共享同一会话，一个 send 两个都收事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-"));
  const { server, sockPath } = await startDaemon(
    dir,
    scriptedProvider([
      [
        {
          role: "assistant",
          content: [
            { type: "text", text: "写文件" },
            {
              type: "tool_call",
              id: "c1",
              name: "write",
              args: { path: "d.txt", content: "shared" },
            },
          ],
        },
      ],
      [{ role: "assistant", content: [{ type: "text", text: "完成" }] }],
    ]),
  );

  // 客户端 A 建会话并订阅
  const clientA: SessionHost = await DaemonClient.connect(sockPath);
  const clientB: SessionHost = await DaemonClient.connect(sockPath);
  const meta = await clientA.createSession({ cwd: dir, model: "scripted", title: "共享会话" });

  const eventsA: SessionEvent[] = [];
  const eventsB: SessionEvent[] = [];
  // B 的 done 是跨 socket 异步到达的，用 promise 等它，避免 send 一 resolve 就断言的竞态
  let resolveBDone: () => void;
  const bDone = new Promise<void>((r) => (resolveBDone = r));
  let answerResult: Promise<boolean | void> | undefined;

  await clientA.open(meta.id, (ev) => {
    eventsA.push(ev);
    if (ev.type === "permission_request") {
      answerResult = clientA.answerPermission(meta.id, ev.permId, "allow");
    }
  });
  await clientB.open(meta.id, (ev) => {
    eventsB.push(ev); // B 只观察
    if (ev.type === "agent" && ev.event.type === "done") resolveBDone();
  });

  // A 触发 send，并等 B 也收到 done
  await clientA.send(meta.id, "写 d.txt");
  await bDone;
  assert.equal(await answerResult, true);

  // B（没发 send）收到了完整事件流：权限广播 + done
  assert.ok(
    eventsB.some((e) => e.type === "permission_request"),
    "B 应看到权限请求广播",
  );
  const bRequest = eventsB.findIndex((e) => e.type === "permission_request" && e.permId === "c1");
  const bResolved = eventsB.findIndex(
    (e) => e.type === "permission_resolved" && e.permId === "c1" && e.decision === "allow",
  );
  assert.ok(bRequest >= 0 && bResolved > bRequest, "B 应收到 request 后的 resolved 广播");
  assert.equal(
    await clientB.answerPermission(meta.id, "c1", "deny"),
    false,
    "另一个客户端不能重复裁决已完成请求",
  );
  assert.ok(
    eventsB.some((e) => e.type === "agent" && e.event.type === "tool_result" && !e.event.isError),
    "B 应看到成功的工具结果",
  );
  // 文件在 daemon 侧真的写了
  assert.equal(await fs.readFile(path.join(dir, "d.txt"), "utf8"), "shared");

  (clientA as SessionHost).dispose();
  (clientB as SessionHost).dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon client: open 先交付 snapshot，再回放响应飞行期事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-race-"));
  const sockPath = path.join(dir, "fake.sock");
  const fake = net.createServer((sock) => {
    let buffer = "";
    sock.on("data", (chunk) => {
      buffer += chunk.toString();
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method: string };
      if (request.method !== "open") return;
      const meta = {
        id: "s_race",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
        cwd: dir,
        model: "scripted",
      };
      // 刻意把事件写在 result 之前，模拟服务端先订阅、open 响应仍在飞行。
      const payload = Buffer.from(
        JSON.stringify({
          type: "session_event",
          sessionId: "s_race",
          event: { type: "agent", event: { type: "text", text: "响应中文" } },
        }) +
          "\n" +
          JSON.stringify({
            type: "result",
            id: request.id,
            ok: true,
            data: {
              snapshot: {
                meta,
                messages: [],
                usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
                running: true,
                pendingPermissions: [],
              },
            },
          }) +
          "\n",
      );
      // 故意在“中”的 UTF-8 三字节中间切开，客户端必须无损重组。
      const chinese = payload.indexOf(Buffer.from("中"));
      sock.write(payload.subarray(0, chinese + 1));
      setImmediate(() => sock.write(payload.subarray(chinese + 1)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    fake.once("error", reject);
    fake.listen(sockPath, resolve);
  });

  const client = await DaemonClient.connect(sockPath);
  const seen: SessionEvent[] = [];
  const handle = await client.open("s_race", (event) => seen.push(event));
  assert.equal(handle.snapshot.messages.length, 0);
  assert.equal(seen.length, 0, "open resolve 时调用方应先有机会应用 snapshot");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    seen.some(
      (event) =>
        event.type === "agent" && event.event.type === "text" && event.event.text === "响应中文",
    ),
    true,
  );

  client.dispose();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon client: dispose 立即拒绝 pending 并销毁半开 socket", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-dispose-"));
  const sockPath = path.join(dir, "half-open.sock");
  let accepted!: net.Socket;
  const fake = net.createServer({ allowHalfOpen: true }, (socket) => {
    accepted = socket;
    socket.on("data", () => {
      // 故意永不响应，也不主动 FIN。
    });
  });
  await new Promise<void>((resolve, reject) => {
    fake.once("error", reject);
    fake.listen(sockPath, resolve);
  });
  const client = await DaemonClient.connect(sockPath);
  const pending = client.listSessions();

  client.dispose();
  await assert.rejects(pending, /已释放/);
  await assert.rejects(client.listSessions(), /已释放/);
  assert.equal(
    (client as unknown as { sock: net.Socket }).sock.destroyed,
    true,
    "dispose 应同步 destroy，而不是停在 readOnly half-open",
  );

  accepted.destroy();
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon: 同一客户端并发 open 同一冷会话不会重复订阅事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-double-open-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({ id: "s_cold", cwd: dir, model: "scripted" });
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({
      provider: scriptedProvider([
        [{ role: "assistant", content: [{ type: "text", text: "once" }] }],
      ]),
      model: "scripted",
    }),
  });
  const server = new DaemonServer({ manager });
  const sockPath = path.join(dir, "d.sock");
  await server.listen(sockPath);
  const client = await DaemonClient.connect(sockPath);
  const first: SessionEvent[] = [];
  const second: SessionEvent[] = [];

  await Promise.all([
    client.open("s_cold", (event) => first.push(event)),
    client.open("s_cold", (event) => second.push(event)),
  ]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await client.send("s_cold", "hello");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(first.length, 0, "同一 client 后一次 open 应替换本地 listener");
  assert.equal(
    second.filter((event) => event.type === "agent" && event.event.type === "text").length,
    1,
  );
  assert.equal(second.filter((event) => event.type === "state" && event.running).length, 1);

  client.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon server: 请求 UTF-8 字符跨 socket chunk 时不损坏", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-utf8-"));
  let capture!: (text: string) => void;
  const captured = new Promise<string>((resolve) => (capture = resolve));
  const provider: Provider = {
    name: "utf8-capture",
    async *stream(req): AsyncIterable<StreamEvent> {
      const text =
        req.messages
          .at(-1)
          ?.content.filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("") ?? "";
      capture(text);
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const { server, sockPath } = await startDaemon(dir, provider);
  const client = await DaemonClient.connect(sockPath);
  const meta = await client.createSession({ cwd: dir, model: "scripted" });
  const raw = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(sockPath, () => resolve(socket));
    socket.once("error", reject);
  });
  const frame = Buffer.from(
    `${JSON.stringify({ id: 1, method: "send", sessionId: meta.id, text: "你好吗" })}\n`,
  );
  const marker = frame.indexOf(Buffer.from("你"));
  raw.write(frame.subarray(0, marker + 1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  raw.write(frame.subarray(marker + 1));

  assert.equal(await captured, "你好吗");

  raw.destroy();
  client.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon: open 返回 snapshot；resume 已有会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({ id: "s_pre", cwd: dir, model: "scripted", title: "旧会话" });
  await store.append("s_pre", { role: "user", content: [{ type: "text", text: "旧消息" }] });
  await store.append("s_pre", { role: "assistant", content: [{ type: "text", text: "旧回复" }] });

  const manager = new SessionManager({
    store,
    resolveProvider: () => ({
      provider: scriptedProvider([
        [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
      ]),
      model: "scripted",
    }),
  });
  const server = new DaemonServer({ manager });
  const sockPath = path.join(dir, "d.sock");
  await server.listen(sockPath);

  const client = await DaemonClient.connect(sockPath);
  const list = await client.listSessions();
  assert.equal(list.find((x) => x.id === "s_pre")?.title, "旧会话");

  const handle = await client.open("s_pre", () => {});
  assert.equal(handle.snapshot.messages.length, 2);
  assert.equal((handle.snapshot.messages[0]!.content[0] as any).text, "旧消息");

  // 同一连接再次 open 仍必须返回有效快照，不能只回 alreadyOpen。
  const reopened = await client.open("s_pre", () => {});
  assert.equal(reopened.snapshot.meta.id, "s_pre");
  assert.equal(reopened.snapshot.messages.length, 2);

  client.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon: close 后立即 reopen 串行生效，listener 异常不截断后续事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-reopen-"));
  const { server, sockPath } = await startDaemon(
    dir,
    scriptedProvider([[{ role: "assistant", content: [{ type: "text", text: "after reopen" }] }]]),
  );
  const client = await DaemonClient.connect(sockPath);
  const meta = await client.createSession({ cwd: dir, model: "scripted" });
  const stale: SessionEvent[] = [];
  const first = await client.open(meta.id, (event) => stale.push(event));

  first.close();
  let calls = 0;
  const texts: string[] = [];
  const reopened = await client.open(meta.id, (event) => {
    calls++;
    if (calls === 1) throw new Error("broken UI listener");
    if (event.type === "agent" && event.event.type === "text") texts.push(event.event.text);
  });
  await client.send(meta.id, "hello again");
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(stale, []);
  assert.ok(calls > 1, "首个 listener 异常后仍应继续分发该 socket 上的后续帧");
  assert.deepEqual(texts, ["after reopen"]);

  reopened.close();
  client.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon: 运行中 close→reopen 不把旧订阅尾事件重复叠到新 snapshot", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-generation-"));
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  const barrier = new Promise<void>((resolve) => (release = resolve));
  const provider: Provider = {
    name: "barrier",
    async *stream(): AsyncIterable<StreamEvent> {
      markStarted();
      await barrier;
      yield { type: "text_delta", text: "persisted reply" };
      yield {
        type: "done",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "persisted reply" }],
        },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const { server, sockPath } = await startDaemon(dir, provider);
  const client = await DaemonClient.connect(sockPath);
  const meta = await client.createSession({ cwd: dir, model: "scripted" });
  const first = await client.open(meta.id, () => {});
  const sending = client.send(meta.id, "go");
  await started;

  first.close();
  const fresh: SessionEvent[] = [];
  const opening = client.open(meta.id, (event) => fresh.push(event));
  release();
  const reopened = await opening;
  await sending;
  await new Promise<void>((resolve) => setImmediate(resolve));

  const snapshotReplies = reopened.snapshot.messages.filter(
    (message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text === "persisted reply"),
  ).length;
  const freshReplies = fresh.filter(
    (event) =>
      event.type === "agent" &&
      event.event.type === "text" &&
      event.event.text === "persisted reply",
  ).length;
  assert.equal(
    snapshotReplies + freshReplies,
    1,
    "同一回答应只来自 snapshot 或新订阅事件之一，不能两边重复",
  );

  reopened.close();
  client.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon: 非法 NDJSON 只断开当前连接，服务端仍可接受新客户端", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-invalid-"));
  const { server, sockPath } = await startDaemon(dir, scriptedProvider([]));
  const raw = await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(sockPath, () => resolve(socket));
    socket.once("error", reject);
  });
  raw.on("error", () => {});
  const closed = new Promise<void>((resolve) => raw.once("close", () => resolve()));
  raw.write("{ definitely not json }\n");
  await closed;

  const healthy = await DaemonClient.connect(sockPath);
  assert.deepEqual(await healthy.listSessions(), []);

  healthy.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("daemon: 超过单帧上限的长会话 snapshot 可分块恢复", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-large-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const content = "x".repeat(MAX_FRAME_BYTES + 1024);
  await store.create({ id: "s_large", cwd: dir, model: "scripted" });
  await store.append("s_large", {
    role: "user",
    content: [{ type: "text", text: content }],
  });
  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  const server = new DaemonServer({ manager });
  const sockPath = path.join(dir, "d.sock");
  await server.listen(sockPath);
  const client = await DaemonClient.connect(sockPath);

  const handle = await client.open("s_large", () => {});
  const restored = handle.snapshot.messages[0]!.content[0];
  if (!restored || restored.type !== "text") assert.fail("应恢复长文本消息");
  assert.equal(restored.text.length, content.length);

  handle.close();
  client.dispose();
  await server.close();
  await fs.rm(dir, { recursive: true, force: true });
});
