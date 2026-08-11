import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStore, newSessionId } from "./session.js";
import { Agent } from "./agent.js";
import type { Provider, StreamEvent, ChatMessage } from "./types.js";

function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

async function drain(agent: Agent, text: string) {
  for await (const _ of agent.send(text)) void _;
}

const sessionModuleUrl = new URL("./session.ts", import.meta.url).href;

async function runNodeEval(source: string, environment: Record<string, string>): Promise<void> {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`session child timed out: ${stderr || stdout}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
  if (code !== 0) {
    throw new Error(
      `session child failed (code=${String(code)}, signal=${String(signal)}): ${stderr || stdout}`,
    );
  }
}

async function spawnLiveLockOwner(lock: string) {
  const source = String.raw`
    const { randomBytes, randomUUID } = await import("node:crypto");
    const { promises: fs } = await import("node:fs");
    const { hostname } = await import("node:os");
    const lock = process.env.ANICODE_TEST_SESSION_LOCK;
    const candidate = lock + "." + process.pid + "." + randomUUID() + ".candidate";
    let handle;
    try {
      handle = await fs.open(candidate, "wx", 0o600);
      if (process.platform !== "win32") await handle.chmod(0o600);
      const owner = {
        version: 1,
        pid: process.pid,
        host: hostname(),
        token: randomBytes(32).toString("hex"),
      };
      await handle.writeFile(JSON.stringify(owner) + "\n", "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.link(candidate, lock);
      await fs.rm(candidate, { force: true });
      process.stdout.write("READY\n");
      setInterval(() => {}, 1_000);
    } finally {
      await handle?.close().catch(() => undefined);
      await fs.rm(candidate, { force: true }).catch(() => undefined);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    env: { ...process.env, ANICODE_TEST_SESSION_LOCK: lock },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      cleanup();
      child.kill();
      reject(new Error(`timed out waiting for lock owner: ${stderr || stdout}`));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `lock owner exited before ready (code=${String(code)}, signal=${String(signal)}): ${stderr || stdout}`,
        ),
      );
    };
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("READY\n")) {
        cleanup();
        resolve();
      }
    });
    child.once("error", onError);
    child.once("exit", onExit);
  });
  return child;
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill();
  await exited;
}

test("SessionStore: create/append/load/list 往返", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-"));
  const store = new SessionStore(dir);
  const id = newSessionId(Date.now(), Math.random);
  assert.equal(store.storageSemantics, "legacy-single-writer");
  const meta = await store.create({ id, cwd: "/x", model: "m", title: "测试会话" });
  assert.equal(meta.id, id);

  await store.append(id, { role: "user", content: [{ type: "text", text: "hi" }] });
  await store.append(id, { role: "assistant", content: [{ type: "text", text: "hello" }] });

  const data = await store.load(id);
  assert.equal(data.title, "测试会话");
  assert.equal(data.messages.length, 2);
  assert.equal((data.messages[0]!.content[0] as any).text, "hi");

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, id);

  await fs.rm(dir, { recursive: true, force: true });
});

test("SessionStore: JSONL mtime 驱动最近活跃排序与 load.updatedAt", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-"));
  const store = new SessionStore(dir);
  await store.create({ id: "s_old", cwd: "/x", model: "m" });
  await store.create({ id: "s_new", cwd: "/x", model: "m" });

  // 使用固定的未来时间，避免依赖定时器与文件系统 mtime 精度。
  const activity = new Date("2040-01-02T03:04:05.000Z");
  await fs.utimes(path.join(dir, "s_old.jsonl"), activity, activity);

  const list = await store.list();
  assert.equal(list[0]!.id, "s_old");
  assert.equal(list[0]!.updatedAt, activity.toISOString());
  assert.equal((await store.load("s_old")).updatedAt, activity.toISOString());

  await fs.rm(dir, { recursive: true, force: true });
});

test(
  "SessionStore: 会话目录/文件为私有权限，并自动收紧旧文件",
  {
    skip:
      process.platform === "win32"
        ? "POSIX owner/group/other mode bits are unavailable on Windows"
        : false,
  },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-mode-"));
    const dir = path.join(root, "sessions");
    const store = new SessionStore(dir);
    const meta = await store.create({ id: "s_private", cwd: "/x", model: "m" });
    const file = path.join(dir, "s_private.jsonl");

    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    // 模拟旧版本留下的宽权限；append/load/rewrite 都会迁移回私有权限。
    await fs.chmod(dir, 0o755);
    await fs.chmod(file, 0o644);
    await store.append("s_private", {
      role: "user",
      content: [{ type: "text", text: "private prompt" }],
    });
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    await fs.chmod(file, 0o644);
    const loaded = await store.load("s_private");
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    await store.rewrite(meta, loaded.messages);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

    await fs.rm(root, { recursive: true, force: true });
  },
);

test("SessionStore: 会话 id 不能路径穿越，meta id 必须与文件名一致", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-boundary-"));
  const sessions = path.join(root, "sessions");
  await fs.mkdir(sessions);
  const outside = {
    id: "../outside",
    cwd: "/secret",
    model: "debug/demo",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
  };
  await fs.writeFile(
    path.join(root, "outside.jsonl"),
    `${JSON.stringify({ __meta: outside })}\n${JSON.stringify({ role: "user", content: [{ type: "text", text: "TOP SECRET" }] })}\n`,
  );
  await fs.writeFile(
    path.join(sessions, "safe.jsonl"),
    `${JSON.stringify({ __meta: { ...outside, id: "different" } })}\n`,
  );
  const store = new SessionStore(sessions);

  await assert.rejects(store.load("../outside"), /Invalid session id|非法会话 id/);
  await assert.rejects(store.load("safe"), /mismatched meta id|meta id 不匹配/);
  assert.deepEqual(await store.list(), []);

  await fs.rm(root, { recursive: true, force: true });
});

test("SessionStore: 截断未提交的 JSONL 尾行后可继续追加", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-tail-"));
  const store = new SessionStore(dir);
  const file = path.join(dir, "s_tail.jsonl");
  try {
    await store.create({ id: "s_tail", cwd: dir, model: "m" });
    await store.append("s_tail", {
      role: "user",
      content: [{ type: "text", text: "committed" }],
    });
    // 模拟进程在一次 append 写完换行提交标记之前崩溃。
    await fs.appendFile(file, '{"role":"assistant","content":[{"type":"text"', "utf8");

    const recovered = await store.load("s_tail");
    assert.equal(recovered.messages.length, 1);
    assert.equal((recovered.messages[0]!.content[0] as { text: string }).text, "committed");
    assert.ok((await fs.readFile(file, "utf8")).endsWith("\n"));

    await store.append("s_tail", {
      role: "assistant",
      content: [{ type: "text", text: "after recovery" }],
    });
    const after = await store.load("s_tail");
    assert.deepEqual(
      after.messages.map((message) => (message.content[0] as { text: string }).text),
      ["committed", "after recovery"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore: 尾部恢复与 meta 读取在底层短读时不跳过字节", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-short-read-"));
  const store = new SessionStore(dir);
  const file = path.join(dir, "s_short_read.jsonl");
  const originalOpen = fs.open;
  try {
    await store.create({ id: "s_short_read", cwd: dir, model: "m" });
    await store.append("s_short_read", {
      role: "user",
      content: [{ type: "text", text: "committed before partial tail" }],
    });
    await fs.appendFile(file, '{"role":"assistant","content":[{"type":"text"', "utf8");

    fs.open = (async (openPath, flags, mode) => {
      const handle = await originalOpen(openPath, flags, mode);
      if (path.resolve(String(openPath)) === file && (flags === "r" || flags === "r+")) {
        const originalRead = handle.read.bind(handle);
        handle.read = ((buffer: Buffer, offset: number, length: number, position: number | null) =>
          originalRead(buffer, offset, Math.min(length, 7), position)) as typeof handle.read;
      }
      return handle;
    }) as typeof fs.open;

    await store.append("s_short_read", {
      role: "assistant",
      content: [{ type: "text", text: "committed after recovery" }],
    });
    assert.equal((await store.list())[0]?.id, "s_short_read");
    assert.deepEqual(
      (await store.load("s_short_read")).messages.map(
        (message) => (message.content[0] as { text: string }).text,
      ),
      ["committed before partial tail", "committed after recovery"],
    );
  } finally {
    fs.open = originalOpen;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore: 不静默吞掉已换行提交的损坏记录", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-corrupt-"));
  const store = new SessionStore(dir);
  try {
    await store.create({ id: "s_corrupt", cwd: dir, model: "m" });
    await fs.appendFile(path.join(dir, "s_corrupt.jsonl"), "{broken json}\n", "utf8");
    await assert.rejects(store.load("s_corrupt"), SyntaxError);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore: 同一会话的 rewrite/append 按接收顺序串行", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-order-"));
  const store = new SessionStore(dir);
  const secondStore = new SessionStore(dir);
  try {
    const meta = await store.create({ id: "s_order", cwd: dir, model: "m" });
    const rewrite = store.rewrite(meta, [
      { role: "user", content: [{ type: "text", text: "rewritten" }] },
    ]);
    const append = secondStore.append("s_order", {
      role: "assistant",
      content: [{ type: "text", text: "appended" }],
    });
    await Promise.all([rewrite, append]);

    const loaded = await secondStore.load("s_order");
    assert.deepEqual(
      loaded.messages.map((message) => (message.content[0] as { text: string }).text),
      ["rewritten", "appended"],
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore: owner release 不删除已被替换 inode 的锁", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-lock-aba-"));
  const store = new SessionStore(dir);
  const file = path.join(dir, "s_aba.jsonl");
  const lock = `${file}.lock`;
  const displaced = `${lock}.displaced`;
  const originalOpen = fs.open;
  let replaced = false;
  try {
    await store.create({ id: "s_aba", cwd: dir, model: "m" });
    fs.open = (async (openPath, flags, mode) => {
      if (!replaced && path.resolve(String(openPath)) === file && flags === "r+") {
        replaced = true;
        const sameOwner = await fs.readFile(lock);
        // Keep the old inode linked so the replacement is guaranteed to have a different inode,
        // while deliberately reusing the exact same owner token to exercise both lease checks.
        await fs.rename(lock, displaced);
        await fs.writeFile(lock, sameOwner, { flag: "wx", mode: 0o600 });
      }
      return originalOpen(openPath, flags, mode);
    }) as typeof fs.open;

    await store.append("s_aba", {
      role: "user",
      content: [{ type: "text", text: "committed while lock path was replaced" }],
    });
    assert.equal(replaced, true);
    await fs.access(lock);
    await fs.access(displaced);
    assert.equal((await fs.readFile(file, "utf8")).includes("committed while"), true);
  } finally {
    fs.open = originalOpen;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore: 多个真实进程并发 append 不丢记录且不残留锁文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-processes-"));
  const store = new SessionStore(dir);
  const workerCount = 4;
  const messagesPerWorker = 12;
  const source = String.raw`
    const { SessionStore } = await import(process.env.ANICODE_TEST_SESSION_MODULE);
    const store = new SessionStore(process.env.ANICODE_TEST_SESSION_DIR);
    const worker = Number(process.env.ANICODE_TEST_SESSION_WORKER);
    const count = Number(process.env.ANICODE_TEST_SESSION_COUNT);
    for (let index = 0; index < count; index += 1) {
      await store.append("s_processes", {
        role: "user",
        content: [{ type: "text", text: worker + ":" + index }],
      });
    }
  `;
  try {
    await store.create({ id: "s_processes", cwd: dir, model: "m" });
    await Promise.all(
      Array.from({ length: workerCount }, (_, worker) =>
        runNodeEval(source, {
          ANICODE_TEST_SESSION_MODULE: sessionModuleUrl,
          ANICODE_TEST_SESSION_DIR: dir,
          ANICODE_TEST_SESSION_WORKER: String(worker),
          ANICODE_TEST_SESSION_COUNT: String(messagesPerWorker),
        }),
      ),
    );

    const loaded = await store.load("s_processes");
    const texts = loaded.messages.map((message) => (message.content[0] as { text: string }).text);
    assert.equal(texts.length, workerCount * messagesPerWorker);
    assert.equal(new Set(texts).size, workerCount * messagesPerWorker);
    assert.deepEqual(await fs.readdir(dir), ["s_processes.jsonl"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore: 活锁与 owner 退出后的残留锁都 fail-closed", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-owner-lock-"));
  const initialStore = new SessionStore(dir);
  const lock = path.join(dir, "s_owner.jsonl.lock");
  let owner: Awaited<ReturnType<typeof spawnLiveLockOwner>> | undefined;
  try {
    await initialStore.create({ id: "s_owner", cwd: dir, model: "m" });
    owner = await spawnLiveLockOwner(lock);
    await fs.utimes(lock, new Date(0), new Date(0));

    if (process.platform !== "win32") {
      assert.equal((await fs.stat(lock)).mode & 0o777, 0o600);
    }
    const contender = new SessionStore(dir, { lockTimeoutMs: 60, lockRetryMs: 5 });
    const started = performance.now();
    await assert.rejects(
      contender.append("s_owner", {
        role: "user",
        content: [{ type: "text", text: "must not be written while owner is alive" }],
      }),
      /Session store lock timeout|会话存储锁获取超时/,
    );
    assert.ok(performance.now() - started < 1_000);
    assert.equal(
      (await fs.readFile(path.join(dir, "s_owner.jsonl"), "utf8")).includes("must not"),
      false,
    );

    await stopChild(owner);
    owner = undefined;

    const abandonedLock = await fs.readFile(lock);
    const failClosedStore = new SessionStore(dir, { lockTimeoutMs: 60, lockRetryMs: 5 });
    await assert.rejects(
      failClosedStore.append("s_owner", {
        role: "user",
        content: [{ type: "text", text: "must not be written after owner exit" }],
      }),
      /remove exactly this lock file|仅删除这个锁文件/,
    );
    assert.deepEqual(await fs.readFile(lock), abandonedLock);
    assert.equal(
      (await fs.readFile(path.join(dir, "s_owner.jsonl"), "utf8")).includes("must not"),
      false,
    );
  } finally {
    if (owner) await stopChild(owner);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("SessionStore: 外地主机死 PID 锁 fail-closed，但 list 不等待单个会话锁", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-foreign-lock-"));
  const store = new SessionStore(dir);
  const lock = path.join(dir, "s_foreign.jsonl.lock");
  const serialized = `${JSON.stringify({
    version: 1,
    pid: 2_147_483_647,
    host: `${os.hostname()}-foreign`,
    token: "ab".repeat(32),
  })}\n`;
  try {
    await store.create({ id: "s_foreign", cwd: dir, model: "m" });
    await fs.writeFile(lock, serialized, { flag: "wx", mode: 0o600 });
    await fs.utimes(lock, new Date(0), new Date(0));

    const listingStore = new SessionStore(dir, { lockTimeoutMs: 2_000, lockRetryMs: 5 });
    const listStarted = performance.now();
    assert.deepEqual(
      (await listingStore.list()).map((meta) => meta.id),
      ["s_foreign"],
    );
    assert.ok(performance.now() - listStarted < 500);
    const contender = new SessionStore(dir, { lockTimeoutMs: 50, lockRetryMs: 5 });
    await assert.rejects(
      contender.load("s_foreign"),
      /Session store lock timeout|会话存储锁获取超时/,
    );
    assert.equal(await fs.readFile(lock, "utf8"), serialized);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Agent: 对话自动持久化，可 resume 续接", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sess-"));
  const store = new SessionStore(dir);
  const id = newSessionId(Date.now(), Math.random);
  const meta = await store.create({ id, cwd: dir, model: "m" });

  // 第一段会话
  const agent1 = new Agent({
    provider: scriptedProvider([
      [{ role: "assistant", content: [{ type: "text", text: "记住：项目叫 X" }] }],
    ]),
    model: "m",
    cwd: dir,
    projectMemory: false,
    persistence: { store, meta },
  });
  await drain(agent1, "项目叫什么，先记住");

  // 落盘应有：user + assistant = 2 条
  const saved = await store.load(id);
  assert.equal(saved.messages.length, 2);

  // resume：新 Agent 载入历史续接
  const agent2 = new Agent({
    provider: scriptedProvider([
      [{ role: "assistant", content: [{ type: "text", text: "项目叫 X" }] }],
    ]),
    model: "m",
    cwd: dir,
    projectMemory: false,
    persistence: { store, meta, resumeMessages: saved.messages },
  });
  assert.equal(agent2.messages.length, 2); // 已载入历史
  await drain(agent2, "项目叫什么");

  // 续接后文件应有 4 条（2 旧 + 2 新），且不重复旧消息
  const after = await store.load(id);
  assert.equal(after.messages.length, 4);
  assert.equal((after.messages[0]!.content[0] as any).text, "项目叫什么，先记住");

  await fs.rm(dir, { recursive: true, force: true });
});

test("newSessionId: 时间前缀保证可排序", () => {
  const a = newSessionId(1000, () => 0.1);
  const b = newSessionId(2000, () => 0.1);
  assert.ok(a < b, `${a} 应小于 ${b}`);
});
