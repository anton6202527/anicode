/**
 * Agent loop 离线测试：用「脚本化假 provider」驱动完整回路，
 * 验证 工具执行 / 权限拒绝 / 结果回传 / done 收尾 —— 不需要任何 API key。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "./agent.js";
import type { Provider, StreamEvent, ChatMessage } from "./types.js";

/** 按预设脚本逐轮回放的假 provider；每次 stream() 消费一条脚本 */
function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const msg = scripts[turn++] ?? [];
      const content = msg[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      for (const part of content) {
        if (part.type === "text") yield { type: "text_delta", text: part.text };
      }
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

async function collect(agent: Agent, text: string) {
  const events = [];
  for await (const ev of agent.send(text)) events.push(ev);
  return events;
}

test("Agent: 工具调用 → 执行 → 结果回传 → 收尾", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-"));
  const provider = scriptedProvider([
    // 第一轮：写文件
    [
      {
        role: "assistant",
        content: [
          { type: "text", text: "我来创建文件。" },
          {
            type: "tool_call",
            id: "c1",
            name: "write",
            args: { path: "hello.txt", content: "hi" },
          },
        ],
      },
    ],
    // 第二轮：读回来
    [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c2", name: "read", args: { path: "hello.txt" } }],
      },
    ],
    // 第三轮：收尾
    [{ role: "assistant", content: [{ type: "text", text: "完成，文件内容是 hi。" }] }],
  ]);

  const agent = new Agent({ provider, model: "x", cwd: dir, permission: { mode: "auto" } });
  const events = await collect(agent, "创建 hello.txt 写入 hi，再读回来确认");

  // 工具都执行了
  const toolResults = events.filter((e) => e.type === "tool_result");
  assert.equal(toolResults.length, 2);
  assert.ok(!toolResults.some((e: any) => e.isError));

  // 文件真的写进去了
  const onDisk = await fs.readFile(path.join(dir, "hello.txt"), "utf8");
  assert.equal(onDisk, "hi");

  // read 结果带行号
  const readRes = toolResults.find((e: any) => e.name === "read") as any;
  assert.match(readRes.content, /1\thi/);

  // 正常收尾
  const done = events.find((e) => e.type === "done");
  assert.ok(done && done.type === "done");
  assert.equal(done.turns, 3);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent: 权限拒绝 → 错误结果回传给模型", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-"));
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "bash", args: { command: "rm -rf /" } }],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "好的，我不执行该命令。" }] }],
  ]);

  // default 模式 + confirm 一律拒绝
  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    permission: {
      mode: "default",
      confirm: async () => ({ behavior: "deny", message: "危险命令被拒绝" }),
    },
  });
  const events = await collect(agent, "删库跑路");

  const perm = events.find((e) => e.type === "tool_permission") as any;
  assert.equal(perm.decision, "deny");
  const res = events.find((e) => e.type === "tool_result") as any;
  assert.equal(res.isError, true);
  assert.match(res.content, /拒绝/);
  assert.ok(events.some((e) => e.type === "done"));

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent: 并发护栏 —— send 重入抛错，不破坏历史", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-"));
  // 用一个可控延迟的 provider，让第一次 send 卡在流式中
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const provider: Provider = {
    name: "slow",
    async *stream(): AsyncIterable<StreamEvent> {
      await gate; // 阻塞直到放行
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const agent = new Agent({ provider, model: "x", cwd: dir, projectMemory: false });

  // 启动第一次 send（进入 running），不 await 完
  const gen1 = agent.send("第一条");
  const first = gen1.next(); // 触发 running=true，卡在 gate

  // 第二次 send 应立即抛错
  await assert.rejects(async () => {
    for await (const _ of agent.send("第二条")) void _;
  }, /会话正忙/);

  release();
  await first;
  for await (const _ of gen1) void _; // 排空第一次
  assert.equal(agent.isRunning, false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent: resume 悬空 tool_call 自愈 + 补写落盘", async () => {
  const { SessionStore } = await import("./session.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const meta = await store.create({ id: "s_crash", cwd: dir, model: "x" });
  // 模拟崩溃现场：文件以含 tool_call 的 assistant 消息结尾，没有结果
  await store.append("s_crash", { role: "user", content: [{ type: "text", text: "跑个命令" }] });
  await store.append("s_crash", {
    role: "assistant",
    content: [{ type: "tool_call", id: "c9", name: "bash", args: { command: "ls" } }],
  });

  const loaded = await store.load("s_crash");
  // provider 断言收到的历史是合法的：不以悬空 tool_call 结尾
  let sawRepairedHistory = false;
  const provider: Provider = {
    name: "check",
    async *stream(req: any): AsyncIterable<StreamEvent> {
      const last = req.messages[req.messages.length - 2]; // 倒数第二条应是合成 tool_result
      sawRepairedHistory =
        last.role === "user" &&
        last.content.some(
          (p: any) => p.type === "tool_result" && p.toolCallId === "c9" && p.isError,
        );
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "恢复了" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };

  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    projectMemory: false,
    permission: { mode: "auto" },
    persistence: { store, meta, resumeMessages: loaded.messages },
  });
  for await (const _ of agent.send("继续之前的活")) void _;

  assert.ok(sawRepairedHistory, "provider 应收到已自愈的历史（合成 tool_result 在场）");
  // 合成结果补写进了会话文件（含新 user 和 assistant，共 2+1+1+1=5 条）
  const after = await store.load("s_crash");
  assert.equal(after.messages.length, 5);
  assert.ok(after.messages[2]!.content.some((p: any) => p.type === "tool_result" && p.isError));

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent: 只读工具在 default 模式下自动放行（不触发 confirm）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-"));
  await fs.writeFile(path.join(dir, "a.txt"), "content");
  let confirmCalled = false;
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "c1", name: "read", args: { path: "a.txt" } }],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "读到了。" }] }],
  ]);

  const agent = new Agent({
    provider,
    model: "x",
    cwd: dir,
    permission: {
      mode: "default",
      confirm: async () => {
        confirmCalled = true;
        return { behavior: "deny" };
      },
    },
  });
  const events = await collect(agent, "读 a.txt");

  assert.equal(confirmCalled, false, "只读工具不应触发 confirm");
  const res = events.find((e) => e.type === "tool_result") as any;
  assert.equal(res.isError, false);

  await fs.rm(dir, { recursive: true, force: true });
});

test("Agent: 计划模式拒绝写入并给规划提示，退出后可正常写", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-plan-"));
  const writeCall: ChatMessage[] = [
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "w1", name: "write", args: { path: "a.txt", content: "hi" } },
      ],
    },
  ];
  const provider = scriptedProvider([
    writeCall, // 计划模式下这次写会被拒
    [{ role: "assistant", content: [{ type: "text", text: "方案：先改 a.txt。" }] }],
    writeCall, // 退出计划模式后重试
    [{ role: "assistant", content: [{ type: "text", text: "已写入。" }] }],
  ]);

  const agent = new Agent({ provider, model: "x", cwd: dir, permission: { mode: "plan" } });
  const planned = await collect(agent, "把 a.txt 写成 hi");
  const denied = planned.filter((e) => e.type === "tool_result") as any[];
  assert.equal(denied.length, 1);
  assert.ok(denied[0].isError, "计划模式下写入应被拒绝");
  assert.match(denied[0].content, /计划模式|Plan mode/);
  await assert.rejects(fs.readFile(path.join(dir, "a.txt")), "计划模式不应真的落盘");

  // 退出计划模式 → 同样的写调用应成功落盘
  agent.setPermissionMode("auto");
  assert.equal(agent.getPermissionMode(), "auto");
  const executed = await collect(agent, "现在执行");
  const ok = executed.filter((e) => e.type === "tool_result") as any[];
  assert.ok(!ok[0].isError, "退出计划模式后写入应成功");
  assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "hi");

  await fs.rm(dir, { recursive: true, force: true });
});
