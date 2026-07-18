/**
 * TUI 冒烟测试：真实 App 挂在 LocalSessionHost（进程内 SessionManager + 脚本化 provider）上，
 * 走完 键入 → 权限弹窗 → 批准 → 文件落盘 → 渲染，并验证 /resume 回显历史。
 * 全离线。因为 App 只依赖 SessionHost，这套测试同时覆盖了 core 的整条新架构。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import {
  SessionManager,
  SessionStore,
  LocalSessionHost,
  type Provider,
  type StreamEvent,
  type ChatMessage,
  type ProviderDescriptor,
  type SessionEvent,
  type SessionHost,
} from "@anicode/core";
import { clearLangOverride } from "@anicode/core";
import { App, dispWidth, inputView, InputPanel, Welcome, WelcomeTip } from "./app.js";
import { messagesToItems, todosFromMessages } from "./transcript.js";

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
        usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 0 },
      };
    },
  };
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

function offlineHost(
  options: {
    id?: string;
    cwd?: string;
    model?: string;
    eventsBeforeSnapshot?: SessionEvent[];
    pendingPermissions?: { permId: string; toolName: string; ruleKey: string }[];
    onInterrupt?: () => void;
    onSend?: (text: string) => void;
    onCreate?: (input: { cwd: string; model: string; title?: string }) => void;
  } = {},
): SessionHost {
  const id = options.id ?? "s_offline";
  const cwd = options.cwd ?? "/offline/project";
  const model = options.model ?? "offline/model";
  let created:
    | {
        id: string;
        cwd: string;
        model: string;
        title?: string;
        createdAt: string;
        updatedAt: string;
      }
    | undefined;
  return {
    async listSessions() {
      return [];
    },
    async createSession(input) {
      options.onCreate?.(input);
      created = {
        id: "s_new",
        cwd: input.cwd,
        model: input.model,
        ...(input.title ? { title: input.title } : {}),
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      };
      return { ...created, running: false };
    },
    async open(sessionId, listener) {
      for (const event of options.eventsBeforeSnapshot ?? []) listener(event);
      const opened =
        created?.id === sessionId
          ? created
          : {
              id,
              cwd,
              model,
              createdAt: "2026-07-14T00:00:00.000Z",
              updatedAt: "2026-07-14T00:00:00.000Z",
            };
      return {
        snapshot: {
          meta: opened,
          messages: [],
          usage: zeroUsage,
          running: false,
          pendingPermissions: options.pendingPermissions ?? [],
        },
        close() {},
      };
    },
    async send(_sessionId, text) {
      options.onSend?.(text);
    },
    async interrupt() {
      options.onInterrupt?.();
    },
    async undo() {
      return { restored: 0, deleted: 0 };
    },
    async answerPermission() {
      return true;
    },
    dispose() {},
  };
}

test("TUI: 键入 → 授权 → 文件落盘 → 渲染（走 SessionHost）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tui-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({
      provider: scriptedProvider([
        [
          {
            role: "assistant",
            content: [
              { type: "text", text: "创建文件中。" },
              {
                type: "tool_call",
                id: "c1",
                name: "write",
                args: { path: "note.txt", content: "hello" },
              },
            ],
          },
        ],
        [{ role: "assistant", content: [{ type: "text", text: "完成，已写入 note.txt。" }] }],
      ]),
      model: "scripted",
    }),
  });
  const host = new LocalSessionHost(manager);
  const meta = await host.createSession({ cwd: dir, model: "scripted", title: "TUI 测试" });

  const { stdin, lastFrame } = render(
    <App host={host} cwd={dir} model="scripted" sessionId={meta.id} />,
  );
  await tick(); // 等 open/subscribe 完成

  for (const ch of "写个 note.txt") stdin.write(ch);
  await tick();
  stdin.write("\r");
  await tick(100);

  assert.match(lastFrame() ?? "", /授权请求/);
  assert.match(lastFrame() ?? "", /write/);

  stdin.write("y"); // 批准
  await tick(150);

  assert.equal(await fs.readFile(path.join(dir, "note.txt"), "utf8"), "hello");
  const frame = lastFrame() ?? "";
  assert.match(frame, /完成，已写入/);
  assert.match(frame, /✔\s+write/);
  assert.doesNotMatch(frame, /⚙\s+write/);
  assert.match(frame, /out \d+ tokens/);

  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("TUI: 工具被拒绝后以最终状态追加，不被错误结果覆盖", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tui-deny-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({
      provider: scriptedProvider([
        [
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "deny-write",
                name: "write",
                args: { path: "blocked.txt", content: "no" },
              },
            ],
          },
        ],
        [{ role: "assistant", content: [{ type: "text", text: "已停止。" }] }],
      ]),
      model: "scripted",
    }),
  });
  const host = new LocalSessionHost(manager);
  const meta = await host.createSession({ cwd: dir, model: "scripted" });
  const view = render(<App host={host} cwd={dir} model="scripted" sessionId={meta.id} />);
  await tick();

  for (const ch of "写文件") view.stdin.write(ch);
  view.stdin.write("\r");
  await tick(100);
  assert.match(view.lastFrame() ?? "", /授权请求/);
  view.stdin.write("n");
  await tick(150);

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /⊘\s+write/);
  assert.doesNotMatch(frame, /✖\s+write/);
  await assert.rejects(fs.access(path.join(dir, "blocked.txt")));

  view.unmount();
  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("TUI: /resume 回显已有会话的历史", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tui-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  const targetCwd = path.join(dir, "target-project");
  await fs.mkdir(targetCwd);
  // 起点会话刻意比目标会话更长：未重挂 Ink Static 时，较短历史会被漏掉。
  await store.create({ id: "s_start", cwd: dir, model: "start-model", title: "长会话" });
  for (let i = 0; i < 6; i++) {
    await store.append("s_start", {
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `起点历史-${i}` }],
    });
  }
  await store.create({ id: "s_old", cwd: targetCwd, model: "target-model", title: "旧会话" });
  await store.append("s_old", { role: "user", content: [{ type: "text", text: "先前的问题" }] });
  await store.append("s_old", {
    role: "assistant",
    content: [{ type: "text", text: "先前的回答" }],
  });

  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  const host = new LocalSessionHost(manager);

  const { stdin, lastFrame } = render(
    <App host={host} cwd="/wrong-prop-cwd" model="wrong-prop-model" sessionId="s_start" />,
  );
  await tick();
  assert.match(lastFrame() ?? "", /起点历史-5/);

  // /resume 到旧会话
  for (const ch of "/resume s_old") stdin.write(ch);
  await tick();
  stdin.write("\r");
  await tick(120);

  // 界面回显了旧会话的历史
  const frame = lastFrame() ?? "";
  assert.match(frame, /先前的问题/);
  assert.match(frame, /先前的回答/);
  assert.match(frame, /会话边界 s_old/);
  assert.match(frame, /target-model/);
  assert.match(frame, new RegExp(targetCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("TUI: /sessions 列出会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tui-"));
  const store = new SessionStore(path.join(dir, "sessions"));
  await store.create({ id: "s_a", cwd: dir, model: "scripted", title: "会话A" });

  const manager = new SessionManager({
    store,
    resolveProvider: () => ({ provider: scriptedProvider([]), model: "scripted" }),
  });
  const host = new LocalSessionHost(manager);
  const start = await host.createSession({ cwd: dir, model: "scripted", title: "起点" });

  const { stdin, lastFrame } = render(
    <App host={host} cwd={dir} model="scripted" sessionId={start.id} />,
  );
  await tick();
  for (const ch of "/sessions") stdin.write(ch);
  await tick();
  stdin.write("\r");
  await tick(80);

  const frame = lastFrame() ?? "";
  assert.match(frame, /会话列表/);
  assert.match(frame, /会话A/);
  assert.match(frame, /起点/);

  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("TUI: 键入 / 弹出命令补全菜单，Enter 直接运行高亮命令", async () => {
  const host = offlineHost();
  const { stdin, lastFrame } = render(<App host={host} cwd="/x" model="m" sessionId="s_offline" />);
  await tick();
  // 敲命令名前缀即弹出菜单：命令名 + 描述都可见。
  for (const ch of "/hel") stdin.write(ch);
  await tick();
  const menu = lastFrame() ?? "";
  assert.match(menu, /\/help/);
  assert.match(menu, /显示命令帮助/);
  // Enter 运行高亮命令（此刻输入只有 /hel，无需补全完整）。
  stdin.write("\r");
  await tick(80);
  assert.match(lastFrame() ?? "", /回滚上一轮/); // 仅 /help 运行后才出现的帮助正文

  host.dispose();
});

test("TUI: /lang 即时切换界面语言（英文），并可切回", async () => {
  const host = offlineHost();
  const { stdin, lastFrame } = render(<App host={host} cwd="/x" model="m" sessionId="s_offline" />);
  await tick();
  try {
    // 初始中文（脚本 env=zh）：命令菜单描述为中文。
    for (const ch of "/hel") stdin.write(ch);
    await tick();
    assert.match(lastFrame() ?? "", /显示命令帮助/);
    // 切英文后，同一菜单描述随之变英文（onLangChange 触发整屏重渲染）。
    for (const ch of "".repeat(4)) stdin.write(ch); // 退格清空 /hel
    for (const ch of "/lang en") stdin.write(ch);
    stdin.write("\r");
    await tick(60);
    assert.match(lastFrame() ?? "", /Language switched to English/);
    for (const ch of "/hel") stdin.write(ch);
    await tick();
    const en = lastFrame() ?? "";
    assert.match(en, /Show command help/);
    assert.doesNotMatch(en, /显示命令帮助/);
  } finally {
    clearLangOverride(); // 复位，避免污染其余以中文断言的用例
    host.dispose();
  }
});

test("TUI: 命令菜单 Tab 补全命令名并留空格待输参数", async () => {
  const host = offlineHost();
  const { stdin, lastFrame } = render(<App host={host} cwd="/x" model="m" sessionId="s_offline" />);
  await tick();
  for (const ch of "/res") stdin.write(ch);
  await tick();
  assert.match(lastFrame() ?? "", /\/resume/);
  stdin.write("\t"); // Tab 补全
  await tick();
  const after = lastFrame() ?? "";
  // 补全后输入为 "/resume "（含空格）→ 菜单收起（描述行不再出现）。
  assert.doesNotMatch(after, /载入已有会话/);

  host.dispose();
});

test("TUI: open 响应前的所有事件在 snapshot 后按序回放", async () => {
  const events: SessionEvent[] = [
    { type: "agent", event: { type: "user_message", text: "缓冲用户消息", queued: false } },
    { type: "agent", event: { type: "text", text: "缓冲回答" } },
    {
      type: "agent",
      event: { type: "tool_start", id: "buffer-tool", name: "read", ruleKey: "a.ts" },
    },
    {
      type: "agent",
      event: {
        type: "tool_result",
        id: "buffer-tool",
        name: "read",
        content: "ok",
        isError: false,
      },
    },
    { type: "permission_request", permId: "already-done", toolName: "bash", ruleKey: "pwd" },
    { type: "permission_resolved", permId: "already-done", decision: "allow" },
    { type: "state", running: false },
  ];
  const host = offlineHost({
    id: "s_snapshot",
    cwd: "/actual/cwd",
    model: "actual/model",
    eventsBeforeSnapshot: events,
  });
  const view = render(
    <App host={host} cwd="/wrong/cwd" model="wrong/model" sessionId="s_snapshot" />,
  );
  await tick(100);

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /缓冲用户消息/);
  assert.match(frame, /缓冲回答/);
  assert.match(frame, /✔\s+read/);
  assert.match(frame, /actual\/model/);
  assert.match(frame, /\/actual\/cwd/);
  assert.match(frame, /会话边界 s_snapshot/);
  assert.doesNotMatch(frame, /授权请求/);
  view.unmount();
});

test("TUI: 权限弹窗期间 Escape 可中断会话", async () => {
  let interrupts = 0;
  const host = offlineHost({
    pendingPermissions: [{ permId: "p1", toolName: "bash", ruleKey: "rm x" }],
    onInterrupt: () => {
      interrupts++;
    },
  });
  const view = render(<App host={host} cwd="/fallback" model="fallback" sessionId="s_offline" />);
  await tick(80);
  assert.match(view.lastFrame() ?? "", /授权请求/);

  view.stdin.write("\u001b");
  await tick(80);

  assert.equal(interrupts, 1);
  assert.doesNotMatch(view.lastFrame() ?? "", /授权请求/);
  view.unmount();
});

test("TUI: /help 与 /status 显示快捷帮助和 snapshot 实际元数据", async () => {
  const host = offlineHost({ id: "s_status", cwd: "/status/cwd", model: "status/model" });
  const view = render(<App host={host} cwd="/wrong" model="wrong" sessionId="s_status" />);
  await tick(80);

  for (const ch of "/help") view.stdin.write(ch);
  await tick();
  view.stdin.write("\r");
  await tick(50);
  for (const ch of "/status") view.stdin.write(ch);
  await tick();
  view.stdin.write("\r");
  await tick(80);

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /\/resume <sessionId>/);
  assert.match(frame, /\/providers/);
  assert.match(frame, /\/model <provider\/model>/);
  assert.match(frame, /会话 s_status · status\/model · \/status\/cwd · 空闲/);
  view.unmount();
});

test("TUI: /providers 显示安全元数据，/model 以当前 cwd 新建并切换会话", async () => {
  const keyName = "AGENTX_TUI_MISSING_KEY";
  const previousKey = process.env[keyName];
  delete process.env[keyName];
  let created: { cwd: string; model: string; title?: string } | undefined;
  const providers: ProviderDescriptor[] = [
    {
      id: "cloud-test",
      name: "Cloud Test",
      kind: "openai-compatible",
      protocol: "openai-chat",
      aliases: ["ct"],
      baseURL: "https://example.invalid/v1",
      apiKeyEnv: [keyName],
      requiresApiKey: true,
      local: false,
      capabilities: { tools: true, reasoning: false },
      limits: {},
      models: [],
      catalog: [],
    },
    {
      id: "local-test",
      name: "Local Test",
      kind: "openai-compatible",
      protocol: "openai-chat",
      aliases: [],
      baseURL: "http://127.0.0.1:9999/v1",
      apiKeyEnv: [],
      requiresApiKey: false,
      local: true,
      capabilities: { tools: true, reasoning: false },
      limits: {},
      models: [],
      catalog: [],
    },
  ];
  const host = offlineHost({
    id: "s_model",
    cwd: "/model/project",
    model: "old/model",
    onCreate: (input) => {
      created = input;
    },
  });
  const view = render(
    <App
      host={host}
      cwd="/wrong"
      model="wrong"
      sessionId="s_model"
      providers={providers}
      inspectProviderCredentials
    />,
  );

  try {
    await tick(80);
    for (const ch of "/providers") view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await tick(80);

    const providerFrame = view.lastFrame() ?? "";
    assert.match(providerFrame, /cloud-test · Cloud Test · openai-chat · 云端/);
    assert.match(providerFrame, new RegExp(`缺少 ${keyName}`));
    assert.match(providerFrame, /local-test · Local Test · openai-chat · 本地 · 无需 API key/);

    const spec = "cloud-test/org/model-v1";
    for (const ch of `/model ${spec}`) view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await tick(120);

    assert.deepEqual(created, { cwd: "/model/project", model: spec });
    const modelFrame = view.lastFrame() ?? "";
    assert.match(modelFrame, new RegExp(`会话边界 s_new · ${spec}`));
    assert.match(modelFrame, new RegExp(spec));
  } finally {
    view.unmount();
    if (previousKey === undefined) delete process.env[keyName];
    else process.env[keyName] = previousKey;
  }
});

test("TUI: /model 无参打开选择器，滚轮选中并 Enter 以该模型新建会话，Esc 取消", async () => {
  let created: { cwd: string; model: string; title?: string } | undefined;
  const providers: ProviderDescriptor[] = [
    {
      id: "debug",
      name: "anicode Debug",
      kind: "debug",
      protocol: "debug",
      aliases: ["demo"],
      apiKeyEnv: [],
      requiresApiKey: false,
      local: true,
      capabilities: { tools: true, reasoning: false },
      limits: {},
      models: [],
      catalog: [],
    },
  ];
  const catalog = [
    {
      model: "demo",
      label: "Debug Demo（零网络 · 免费）",
      free: true,
      openWeight: false,
      recommended: true,
      providerId: "debug",
      providerName: "anicode Debug",
      spec: "debug/demo",
      local: true,
      requiresApiKey: false,
    },
    {
      model: "meta-llama/llama-3.3-70b-instruct:free",
      label: "Llama 3.3 70B（免费）",
      free: true,
      openWeight: true,
      recommended: false,
      providerId: "openrouter",
      providerName: "OpenRouter",
      spec: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      local: false,
      requiresApiKey: true,
    },
  ];
  const host = offlineHost({
    id: "s_pick",
    cwd: "/pick/project",
    model: "old/model",
    onCreate: (input) => {
      created = input;
    },
  });
  const view = render(
    <App
      host={host}
      cwd="/wrong"
      model="wrong"
      sessionId="s_pick"
      providers={providers}
      catalog={catalog}
      inspectProviderCredentials
    />,
  );

  try {
    await tick(80);
    // 打开选择器
    for (const ch of "/model") view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await tick(40);

    const pickerFrame = view.lastFrame() ?? "";
    assert.match(pickerFrame, /选择模型/);
    assert.match(pickerFrame, /Debug Demo/);
    assert.match(pickerFrame, /Free/); // 免费模型右侧标 Free
    assert.match(pickerFrame, /OpenRouter/); // 按 provider 分组的组标题
    assert.doesNotMatch(pickerFrame, /↑\/↓|Enter 确认/); // 固定视口无需额外操作提示行
    // 打开时未新建会话
    assert.equal(created, undefined);

    // Esc 取消不新建会话
    view.stdin.write("\u001b");
    await tick(40);
    assert.doesNotMatch(view.lastFrame() ?? "", /选择模型/);
    assert.equal(created, undefined);

    // 再次打开，鼠标滚轮向下到第二项（Llama），Enter 新建
    for (const ch of "/model") view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await tick(40);
    view.stdin.write("\u001b[<65;10;10M".repeat(8)); // 触控板会批量合并滚轮事件
    await tick(20);
    assert.doesNotMatch(view.lastFrame() ?? "", /\[<65;/); // 鼠标序列不能污染搜索词
    view.stdin.write("\r");
    await tick(120);

    assert.deepEqual(created, {
      cwd: "/pick/project",
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    });
    assert.match(view.lastFrame() ?? "", /会话边界 s_new/);
  } finally {
    view.unmount();
  }
});

test("TUI: PTY 整块 paste 的尾随回车会提交且不进入消息内容", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_offline" />);
  await tick(80);

  view.stdin.write("pasted request\r");
  await tick(80);

  assert.deepEqual(sent, ["pasted request"]);
  assert.doesNotMatch(view.lastFrame() ?? "", /pasted request\r/);
  view.unmount();
});

test("TUI: 含内部换行但无尾随回车的 paste 只填入输入框", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_offline" />);
  await tick(80);

  view.stdin.write("first line\nsecond line");
  await tick(40);
  assert.deepEqual(sent, []);

  view.stdin.write("\r");
  await tick(80);
  assert.deepEqual(sent, ["first line second line"]);
  view.unmount();
});

test("TUI: 被拆成多个 stdin chunk 的多行 paste 只提交一次", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_offline" />);
  await tick(80);

  view.stdin.write("first line\n");
  await tick(5); // PTY 的下一块可能落在后续 event-loop tick
  view.stdin.write("second line\r");
  await tick(80);

  assert.deepEqual(sent, ["first line second line"]);
  view.unmount();
});

test("TUI transcript: 隐藏内部 context，并从最近 todo_write 恢复清单", () => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "用户原话" },
        { type: "text", text: "secret internal context", internal: true },
      ],
    },
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "todo-1",
          name: "todo_write",
          args: { todos: [{ content: "跑测试", status: "in_progress", activeForm: "正在跑测试" }] },
        },
      ],
    },
  ];
  const items = messagesToItems(messages);
  assert.ok(items.some((item) => item.kind === "user" && item.text === "用户原话"));
  assert.ok(!items.some((item) => "text" in item && item.text.includes("secret internal")));
  assert.deepEqual(todosFromMessages(messages), [
    { content: "跑测试", status: "in_progress", activeForm: "正在跑测试" },
  ]);
});

test("TUI transcript: 并行工具结果按 toolCallId 关联", () => {
  const items = messagesToItems([
    {
      role: "assistant",
      content: [
        { type: "tool_call", id: "call-a", name: "read", args: { path: "a.ts" } },
        { type: "tool_call", id: "call-b", name: "read", args: { path: "b.ts" } },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-a",
          toolName: "read",
          content: "a failed",
          isError: true,
        },
        {
          type: "tool_result",
          toolCallId: "call-b",
          toolName: "read",
          content: "b ok",
        },
      ],
    },
  ]);
  const tools = items.filter(
    (item): item is Extract<typeof item, { kind: "tool" }> => item.kind === "tool",
  );
  assert.deepEqual(
    tools.map(({ id, status, detail }) => ({ id, status, detail })),
    [
      { id: "call-a", status: "err", detail: "a failed" },
      { id: "call-b", status: "ok", detail: undefined },
    ],
  );
});

test("TUI: 输入框支持光标移动、Ctrl+W 删词与中间插入", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_edit" />);
  await tick(80);

  for (const ch of "hello world") view.stdin.write(ch);
  await tick(20);
  assert.match(view.lastFrame() ?? "", /hello world/);

  view.stdin.write("\u0017"); // Ctrl+W 删除光标前一个词 "world"
  await tick(20);
  assert.doesNotMatch(view.lastFrame() ?? "", /world/);
  assert.match(view.lastFrame() ?? "", /hello/);

  // 回到行首（Ctrl+A）后在最前插入，验证中间插入而非只追加末尾
  view.stdin.write("\u0001"); // Ctrl+A
  await tick(10);
  for (const ch of "say ") view.stdin.write(ch);
  await tick(20);
  view.stdin.write("\r");
  await tick(40);
  assert.deepEqual(sent, ["say hello"]);
  view.unmount();
});

test("TUI: ↑/↓ 回溯已提交的输入历史", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_hist" />);
  await tick(80);

  for (const ch of "alpha") view.stdin.write(ch);
  view.stdin.write("\r");
  await tick(40);

  // 未提交的 "beta" 只存在于输入框，可用来判定 ↑ 是否用历史项替换了它
  for (const ch of "beta") view.stdin.write(ch);
  await tick(20);
  assert.match(view.lastFrame() ?? "", /beta/);

  view.stdin.write("\u001b[A"); // ↑ 召回最近一次提交 "alpha"
  await tick(20);
  assert.doesNotMatch(view.lastFrame() ?? "", /beta/); // 输入框已被替换
  assert.match(view.lastFrame() ?? "", /alpha/);

  view.stdin.write("\u001b[B"); // ↓ 越过最新回到空行
  await tick(20);
  view.stdin.write("\r"); // 空行不提交
  await tick(20);
  assert.deepEqual(sent, ["alpha"]);
  view.unmount();
});

/** ink-testing-library 的帧带 ANSI 颜色，比对宽度前先剥掉 SGR。 */
const SGR = new RegExp("\\u001b\\[[0-9;]*m", "g");

test("TUI: 始终画 3 行大 logo，窄屏只裁两侧不折行", () => {
  const rowsAt = (width: number) =>
    (render(<Welcome width={width} />).lastFrame() ?? "")
      .replace(SGR, "")
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.length > 0);
  const contentWidth = (line: string) => line.trim().length;

  // 宽屏：3 行半块大字，每行都含块字符且不超宽。
  const wide = rowsAt(120);
  assert.equal(wide.length, 3, "宽屏应为 3 行块字 logo");
  for (const row of wide) {
    assert.match(row, /[█▀▄]/, "块字行应含半块字符");
    assert.ok(contentWidth(row) <= 120);
  }

  // 极窄屏：仍是 3 行大 logo，只裁两侧、不折行、不超宽。
  for (const width of [24, 12, 4]) {
    const rows = rowsAt(width);
    assert.equal(rows.length, 3, `width=${width} 仍应为 3 行块字 logo`);
    for (const row of rows) {
      assert.match(row, /[█▀▄]/, `width=${width} 块字行应含半块字符`);
      assert.ok(contentWidth(row) <= width, `width=${width} 超宽`);
    }
  }
});

test("TUI: 空会话 Tip 提示 /init，宽度始终受终端约束", () => {
  for (const width of [80, 48, 28]) {
    const frame = (render(<WelcomeTip width={width} />).lastFrame() ?? "").replace(SGR, "");
    assert.match(frame, /Tip/);
    assert.match(frame, /\/init/);
    assert.match(frame, /AGENTS\.md/);
    for (const line of frame.split("\n")) {
      assert.ok(dispWidth(line) <= width, `width=${width} Tip 行超宽: ${JSON.stringify(line)}`);
    }
  }
  assert.equal(render(<WelcomeTip width={27} />).lastFrame() ?? "", "");
});

/** 面板每行都以竖条打头；剥掉 SGR 后按行返回，用来断言结构没被折行撑破。 */
function panelRows(props: { text: string; cursor: number; width: number }): string[] {
  const frame =
    render(
      <InputPanel
        text={props.text}
        cursor={props.cursor}
        width={props.width}
        model="anthropic/claude-opus-4-8"
        cwd="/Users/someone/work/a-rather-long-project-name"
        running={false}
        spinner="●"
      />,
    ).lastFrame() ?? "";
  return frame.replace(SGR, "").split("\n");
}

test("TUI: 窄屏输入面板不折行，占位与模型行按宽度截断", () => {
  for (const width of [60, 30, 20, 12]) {
    const rows = panelRows({ text: "", cursor: 0, width });
    assert.equal(rows.length, 5, `width=${width} 面板被撑成 ${rows.length} 行`);
    for (const [i, l] of rows.entries()) {
      // 折行时第二行没有竖条，正是它把面板结构撑破的表现
      assert.ok(l.startsWith("▎"), `width=${width} 第 ${i} 行缺竖条: ${JSON.stringify(l)}`);
      assert.ok(dispWidth(l) <= width, `width=${width} 第 ${i} 行超宽（${dispWidth(l)}）`);
    }
  }
});

test("TUI: 输入超出面板宽度时窗口跟着光标走，尾部始终可见", () => {
  const width = 30;
  const text = `HEAD${"-".repeat(42)}TAIL`; // 50 列，远超面板可用宽度；首尾各留可辨认的记号
  const rows = panelRows({ text, cursor: text.length, width });
  assert.equal(rows.length, 5);
  for (const l of rows) assert.ok(dispWidth(l) <= width, `行超宽（${dispWidth(l)}）`);

  // 光标在末尾：看得见文本尾巴，开头已滚出窗口
  const line = rows[1]!;
  assert.ok(line.includes("TAIL"), `尾部不可见: ${JSON.stringify(line)}`);
  assert.ok(!line.includes("HEAD"), `开头本应被滚出窗口: ${JSON.stringify(line)}`);

  // 光标回到行首：反过来看得见开头、尾巴滚出窗口
  const atHome = panelRows({ text, cursor: 0, width })[1]!;
  assert.ok(atHome.includes("HEAD"), `行首不可见: ${JSON.stringify(atHome)}`);
  assert.ok(!atHome.includes("TAIL"), `尾部本应被滚出窗口: ${JSON.stringify(atHome)}`);
});

test("TUI: 中文与窄屏下真实光标列都落在窗口内", () => {
  // 与 App 里停放真实光标用的是同一套 inputView，列偏移必须始终落在面板可见范围内
  for (const width of [80, 30, 16]) {
    for (const text of ["", "ab", "你好世界", "你好".repeat(20), "x".repeat(60)]) {
      for (const cursor of [0, Math.floor(text.length / 2), text.length]) {
        const { caretX, startX, avail } = inputView(text, cursor, width);
        const offset = caretX - startX;
        assert.ok(offset >= 0, `width=${width} 光标滑出窗口左侧: ${offset}`);
        assert.ok(offset < avail, `width=${width} 光标滑出窗口右侧: ${offset} >= ${avail}`);
      }
    }
  }
});

test("TUI: /mcp 未配置时提示；配置后展示状态与 MCP prompt 命令可执行", async () => {
  const host = offlineHost();
  const view1 = render(<App host={host} cwd="/x" model="m" sessionId="s_offline" />);
  await tick();
  for (const ch of "/mcp") view1.stdin.write(ch);
  await tick();
  view1.stdin.write("\r");
  await tick(80);
  assert.match(view1.lastFrame() ?? "", /未配置 MCP 服务器/);
  view1.unmount();
  host.dispose();

  // 配置了 mcpStatus 与 resolve 型命令：/mcp 输出状态，MCP prompt 命令渲染后发送
  const host2 = offlineHost();
  const resolved: string[] = [];
  const view2 = render(
    <App
      host={host2}
      cwd="/x"
      model="m"
      sessionId="s_offline"
      mcpStatus={async () => "▸ srv  tools:✓ resources:✓ prompts:✓\n    提示 /mcp__srv__review"}
      commands={[
        {
          name: "mcp__srv__review",
          description: "审查提示",
          template: "",
          source: "mcp:srv",
          resolve: async (a: string) => {
            resolved.push(a);
            return `请审查 ${a}`;
          },
        },
      ]}
    />,
  );
  await tick();
  // 带空格结尾使输入不再匹配命令菜单前缀，回车走完整命令解析路径。
  for (const ch of "/mcp ") view2.stdin.write(ch);
  view2.stdin.write("\r");
  await tick(80);
  assert.match(view2.lastFrame() ?? "", /tools:✓/);

  for (const ch of "/mcp__srv__review a.ts") view2.stdin.write(ch);
  view2.stdin.write("\r");
  await tick(80);
  assert.deepEqual(resolved, ["a.ts"]);
  // 发送后 running 挂起 spinner（离线 host 无 state 事件），必须 unmount 让事件循环收尾。
  view2.unmount();
  host2.dispose();
});
