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
import { SessionStore } from "./session.js";
import type { Provider, StreamEvent, ChatMessage } from "./types.js";

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

test("SessionManager: provider 解析先于落盘且成功路径只解析一次", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  let failures = 0;
  const broken = new SessionManager({
    store,
    resolveProvider: () => {
      failures++;
      throw new Error("provider config invalid");
    },
  });

  await assert.rejects(
    broken.createSession({ cwd: dir, model: "broken/model" }),
    /provider config invalid/,
  );
  assert.equal(failures, 1);
  assert.deepEqual(await store.list(), [], "解析失败不得留下孤儿会话文件");

  let resolutions = 0;
  const healthy = new SessionManager({
    store,
    resolveProvider: () => {
      resolutions++;
      return {
        provider: scriptedProvider([
          [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
        ]),
        model: "scripted",
      };
    },
  });
  await healthy.createSession({ cwd: dir, model: "scripted" });
  assert.equal(resolutions, 1, "create 不应在预校验后再次 resolve provider");

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
  await m.send(b.id, "hi");

  assert.equal((await m.listSessions()).length, 2);
  await m.deleteSession(b.id);
  const remaining = await m.listSessions();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]?.id, a.id);

  // 删除已不存在的会话是无操作，不抛。
  await m.deleteSession(b.id);

  // 已删会话无法 resume（磁盘文件已移除）。
  await assert.rejects(() => m.resumeSession(b.id));

  await fs.rm(dir, { recursive: true, force: true });
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

test("SessionManager.autoTitle: 首轮后用模型起标题、持久化并广播 title 事件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sm-title-"));
  // 第 1 轮=正常回答；第 2 次调用即起名请求，返回带引号/句号的标题验证清洗
  const provider = scriptedProvider([
    [{ role: "assistant", content: [{ type: "text", text: "好的，我来修" }] }],
    [{ role: "assistant", content: [{ type: "text", text: "「修复登录超时。」" }] }],
    [{ role: "assistant", content: [{ type: "text", text: "第二轮回答" }] }],
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

  const titled = events.find((e) => e.type === "title") as any;
  assert.ok(titled, "应广播 title 事件");
  assert.equal(titled.title, "修复登录超时");
  assert.equal((await m.resumeSession(s.id)).meta.title, "修复登录超时");

  // 已有标题后不再重复起名（第二轮消耗脚本第 3 条）
  await m.send(s.id, "继续");
  assert.equal(events.filter((e) => e.type === "title").length, 1);

  // 持久化：新 manager 载入仍带标题
  const m2 = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider, model: "scripted" }),
  });
  assert.equal((await m2.resumeSession(s.id)).meta.title, "修复登录超时");

  // 显式命名的会话不会被覆盖
  const named = await m.createSession({ cwd: dir, model: "scripted", title: "手动标题" });
  await m.open(named.id, (ev) => events.push(ev));
  await m.send(named.id, "任务");
  assert.equal((await m.resumeSession(named.id)).meta.title, "手动标题");

  await fs.rm(dir, { recursive: true, force: true });
});
