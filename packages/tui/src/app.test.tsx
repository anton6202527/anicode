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
  type ModelCatalogEntry,
  type NetworkToolStatuses,
  type ProviderDescriptor,
  type SessionEvent,
  type SessionHost,
  type PendingPermission,
} from "@anicode/core";
import { clearLangOverride } from "@anicode/core";
import {
  App,
  boundTranscriptRows,
  composerCaretPosition,
  composerLayout,
  coalesceSessionEventsForRender,
  dispWidth,
  inputView,
  InputPanel,
  matchesKeybinding,
  networkToolsText,
  permissionAnswersFor,
  promptHistoryFromMessages,
  subagentActivityLine,
  Welcome,
  WelcomeTip,
} from "./app.js";
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

/** 轮询等待帧内容满足条件——CI 冷启动与原生模块加载时也不依赖固定 sleep。 */
async function waitFor(cond: () => boolean, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await tick(25);
  if (!cond()) throw new Error(`Timed out after ${timeoutMs}ms waiting for TUI frame`);
}

const zeroUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

test("TUI stream batching: adjacent token deltas merge without crossing event boundaries", () => {
  const stateEvent: SessionEvent = { type: "state", running: true };
  assert.deepEqual(
    coalesceSessionEventsForRender([
      { type: "agent", event: { type: "thinking", text: "先" } },
      { type: "agent", event: { type: "thinking", text: "想" } },
      stateEvent,
      { type: "agent", event: { type: "text", text: "答" } },
      { type: "agent", event: { type: "text", text: "案" } },
      {
        type: "agent",
        event: { type: "tool_input_delta", id: "tool", name: "read", delta: '{"path":' },
      },
      {
        type: "agent",
        event: { type: "tool_input_delta", id: "tool", name: "read", delta: '"x"}' },
      },
    ]),
    [
      { type: "agent", event: { type: "thinking", text: "先想" } },
      stateEvent,
      { type: "agent", event: { type: "text", text: "答案" } },
      {
        type: "agent",
        event: { type: "tool_input_delta", id: "tool", name: "read", delta: '{"path":"x"}' },
      },
    ],
  );
});

function offlineHost(
  options: {
    id?: string;
    cwd?: string;
    model?: string;
    messages?: ChatMessage[];
    running?: boolean;
    eventsBeforeSnapshot?: SessionEvent[];
    pendingPermissions?: PendingPermission[];
    networkTools?: NetworkToolStatuses;
    onInterrupt?: () => void;
    onSend?: (text: string) => void;
    onCreate?: (input: { cwd: string; model: string; title?: string }) => void;
    onFork?: (
      sessionId: string,
      opts?: { title?: string; upToMessage?: number; model?: string },
    ) => void;
    onPermission?: (decision: "allow" | "allow_remember" | "allow_always" | "deny") => void;
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
  const host: SessionHost = {
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
          messages: options.messages ?? [],
          usage: zeroUsage,
          running: options.running ?? false,
          pendingPermissions: options.pendingPermissions ?? [],
          ...(options.networkTools ? { networkTools: options.networkTools } : {}),
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
    async answerPermission(_sessionId, _permId, decision) {
      options.onPermission?.(decision);
      return true;
    },
    dispose() {},
  };
  if (options.onFork) {
    host.forkSession = async (sessionId, opts) => {
      options.onFork?.(sessionId, opts);
      created = {
        id: "s_new",
        cwd,
        model: opts?.model ?? model,
        ...(opts?.title ? { title: opts.title } : {}),
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
      };
      return { ...created, running: false };
    };
  }
  return host;
}

test("TUI: 远端事件流断开后自动重连并恢复 snapshot", async () => {
  let opens = 0;
  let closeFirst!: (error: Error | undefined) => void;
  const host = offlineHost();
  const baseOpen = host.open.bind(host);
  host.open = async (sessionId, listener) => {
    opens++;
    const handle = await baseOpen(sessionId, listener);
    if (opens !== 1) return handle;
    return {
      ...handle,
      closed: new Promise<Error | undefined>((resolve) => {
        closeFirst = resolve;
      }),
    };
  };
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_remote" />);
  await tick(80);
  closeFirst(new Error("transport reset"));
  await waitFor(() => opens >= 2 && /连接已恢复/.test(view.lastFrame() ?? ""), 2_000);

  assert.equal(opens, 2);
  view.unmount();
});

test("TUI: transcript UI cache 有硬上限并保留会话边界", () => {
  const rows = [
    { kind: "info", text: "boundary" } as const,
    ...Array.from({ length: 10 }, (_, i) => ({ kind: "info" as const, text: String(i) })),
  ];
  const bounded = boundTranscriptRows(rows, 4);
  assert.deepEqual(
    bounded.map((row) => ("text" in row ? row.text : row.kind)),
    ["boundary", "7", "8", "9"],
  );

  const byteBounded = boundTranscriptRows(
    [
      { kind: "info", text: "boundary" },
      { kind: "assistant", text: "a".repeat(200) },
      { kind: "assistant", text: "b".repeat(200) },
    ],
    100,
    350,
  );
  assert.deepEqual(
    byteBounded.map((row) => ("text" in row ? row.text[0] : row.kind)),
    ["b", "b"],
  );
});

test("TUI: multiline composer keeps the active logical line visible", () => {
  const text = "one\ntwo\nthree";
  const layout = composerLayout(text, text.indexOf("w"), 2);
  assert.equal(layout.lines[layout.activeLine]?.text, "two");
  assert.ok(layout.activeVisibleLine >= 0 && layout.activeVisibleLine < 2);
});

test("TUI: configurable keybinding parser distinguishes modifiers", () => {
  const key = {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    home: false,
    end: false,
    return: false,
    escape: false,
    ctrl: true,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    super: false,
    hyper: false,
    capsLock: false,
    numLock: false,
  };
  assert.equal(matchesKeybinding("x", key, "ctrl+x"), true);
  assert.equal(matchesKeybinding("x", key, "meta+x"), false);
});

test("TUI: 极窄极矮终端不会输出越界帧", async () => {
  for (const terminalSize of [
    { rows: 4, cols: 10 },
    { rows: 6, cols: 16 },
  ]) {
    const view = render(
      <App
        host={offlineHost()}
        cwd="/work"
        model="debug/demo"
        sessionId="s_tiny"
        terminalSize={terminalSize}
      />,
    );
    await tick(80);
    const plain = (view.lastFrame() ?? "").replace(SGR, "");
    const lines = plain.split("\n");
    assert.ok(lines.length <= terminalSize.rows, `${terminalSize.rows} rows`);
    for (const line of lines) {
      assert.ok(dispWidth(line) <= terminalSize.cols, `${dispWidth(line)} > ${terminalSize.cols}`);
    }
    view.unmount();
  }
});

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
  // 环境接地（git spawn 等）会拖慢首轮，固定 tick 不够稳 —— 轮询等授权弹窗。
  await waitFor(() => /授权请求/.test(lastFrame() ?? ""));

  assert.match(lastFrame() ?? "", /授权请求/);
  assert.match(lastFrame() ?? "", /write/);

  stdin.write("y"); // 批准
  await waitFor(() => /完成，已写入/.test(lastFrame() ?? ""));

  assert.equal(await fs.readFile(path.join(dir, "note.txt"), "utf8"), "hello");
  const frame = lastFrame() ?? "";
  assert.match(frame, /完成，已写入/);
  assert.match(frame, /✔\s+write/);
  assert.doesNotMatch(frame, /⚙\s+write/);
  assert.match(frame, /\d+\/\d+ tokens/);

  await host.dispose();
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
  await waitFor(() => /授权请求/.test(view.lastFrame() ?? ""));
  assert.match(view.lastFrame() ?? "", /授权请求/);
  view.stdin.write("n");
  await waitFor(() => /⊘\s+write/.test(view.lastFrame() ?? ""));

  const frame = view.lastFrame() ?? "";
  assert.match(frame, /⊘\s+write/);
  assert.doesNotMatch(frame, /✖\s+write/);
  await assert.rejects(fs.access(path.join(dir, "blocked.txt")));

  view.unmount();
  await host.dispose();
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
  await waitFor(() => /起点历史-5/.test(lastFrame() ?? ""));

  // /resume 到旧会话
  for (const ch of "/resume s_old") stdin.write(ch);
  await tick();
  stdin.write("\r");
  await waitFor(() => /会话边界 s_old/.test(lastFrame() ?? ""));

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
  await waitFor(() => /会话列表/.test(lastFrame() ?? ""));

  const frame = lastFrame() ?? "";
  assert.match(frame, /会话列表/);
  assert.match(frame, /会话A/);
  assert.match(frame, /起点/);

  // 选择器支持即时搜索并直接 Enter 切换，不再要求手输完整 session id。
  for (const ch of "会话A") stdin.write(ch);
  await tick(40);
  const filtered = lastFrame() ?? "";
  assert.match(filtered, /会话A/);
  stdin.write("\r");
  await waitFor(() => /会话边界 s_a/.test(lastFrame() ?? ""));
  assert.match(lastFrame() ?? "", /会话边界 s_a/);

  host.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("TUI: Ctrl+P 打开命令面板，Ctrl+X leader 可新建会话", async () => {
  let created: { cwd: string; model: string; title?: string } | undefined;
  const host = offlineHost({
    id: "s_keys",
    cwd: "/keys/project",
    model: "debug/demo",
    onCreate: (input) => {
      created = input;
    },
  });
  const view = render(
    <App host={host} cwd="/keys/project" model="debug/demo" sessionId="s_keys" />,
  );
  await tick(80);

  view.stdin.write("\u0010"); // Ctrl+P
  await waitFor(() => /\/sessions/.test(view.lastFrame() ?? ""));
  assert.match(view.lastFrame() ?? "", /\/status/);
  assert.match(view.lastFrame() ?? "", /\/sessions/);
  view.stdin.write("\u001b");

  view.stdin.write("\u0018"); // Ctrl+X
  await waitFor(() => /n 新建/.test(view.lastFrame() ?? ""));
  assert.match(view.lastFrame() ?? "", /n 新建/);
  view.stdin.write("n");
  await waitFor(() => created !== undefined && /会话边界 s_new/.test(view.lastFrame() ?? ""));
  assert.deepEqual(created, { cwd: "/keys/project", model: "debug/demo" });
  assert.match(view.lastFrame() ?? "", /会话边界 s_new/);

  // PTY 可能把 leader 与下一键合成一个 chunk；也必须识别，不能污染输入框。
  view.stdin.write("\u0018l");
  await waitFor(() => /会话列表/.test(view.lastFrame() ?? ""));
  assert.match(view.lastFrame() ?? "", /会话列表/);
  assert.doesNotMatch(view.lastFrame() ?? "", /\u0018l/);

  view.unmount();
  host.dispose();
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

test("TUI: 首页铺满固定视口，命令候选覆盖显示且不推动输入框", async () => {
  const lastLineContaining = (lines: readonly string[], text: string): number => {
    let found = -1;
    lines.forEach((line, index) => {
      if (line.includes(text)) found = index;
    });
    return found;
  };
  const host = offlineHost({ model: "stable/provider-model" });
  const provider: ProviderDescriptor = {
    id: "debug",
    name: "Debug",
    kind: "debug",
    protocol: "debug",
    aliases: [],
    apiKeyEnv: [],
    requiresApiKey: false,
    local: true,
    capabilities: { tools: true, reasoning: false },
    limits: {},
    models: [],
    catalog: [],
  };
  const view = render(
    <App
      host={host}
      cwd="/fixed-home"
      model="stable/provider-model"
      sessionId="s_fixed_home"
      terminalSize={{ rows: 30, cols: 80 }}
      providers={[provider]}
      catalog={[
        {
          model: "demo",
          label: "Debug Demo",
          providerId: "debug",
          providerName: "Debug",
          spec: "debug/demo",
          local: true,
          requiresApiKey: false,
        },
      ]}
      discoverModels={async () => ["demo"]}
    />,
  );
  await tick(80);
  const beforeLines = (view.lastFrame() ?? "").split("\n");
  const inputMetaBefore = lastLineContaining(beforeLines, "provider-model");
  assert.equal(beforeLines.length, 30, "首页必须严格铺满终端高度且不产生额外行");
  assert.ok(inputMetaBefore > 0);

  for (const ch of "/mcp") view.stdin.write(ch);
  await tick(40);
  const after = view.lastFrame() ?? "";
  const afterLines = after.split("\n");
  const inputMetaAfter = lastLineContaining(afterLines, "provider-model");
  assert.match(after, /查看 MCP 服务器/);
  assert.equal(afterLines.length, 30, "候选层不得撑高首页");
  assert.equal(inputMetaAfter, inputMetaBefore, "候选层开关不得推动输入框");
  const plainAfterLines = afterLines.map((line) => line.replace(SGR, ""));
  const menuTop = plainAfterLines.findIndex((line) => line.startsWith("╭"));
  const menuBottom = plainAfterLines.findIndex(
    (line, index) => index > menuTop && line.startsWith("╰"),
  );
  const menuBorder = plainAfterLines[menuTop];
  assert.ok(menuBorder, "命令候选应显示完整边框");
  assert.equal(dispWidth(menuBorder), 80, "命令候选边框必须铺满整个视图宽度");
  assert.equal(menuBottom - menuTop, 2, "单条命令只应包含一行内容，不得保留固定空白高度");

  view.stdin.write("\u001b");
  await tick(20);
  for (const ch of "/model") view.stdin.write(ch);
  await tick(20);
  view.stdin.write("\r");
  await waitFor(() => /选择模型/.test(view.lastFrame() ?? ""));
  const modelLines = (view.lastFrame() ?? "").split("\n");
  assert.equal(modelLines.length, 30, "模型层不得撑高首页");
  const modelBorder = modelLines
    .map((line) => line.replace(SGR, ""))
    .find((line) => line.startsWith("╭"));
  assert.ok(modelBorder, "模型候选应显示完整边框");
  assert.equal(dispWidth(modelBorder), 80, "模型候选边框必须铺满整个视图宽度");
  assert.equal(
    lastLineContaining(modelLines, "provider-model"),
    inputMetaBefore,
    "模型层不得推动输入框",
  );

  view.unmount();
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

test("TUI: Ctrl+O 展开和收起完整工具输出", async () => {
  const host = offlineHost({
    eventsBeforeSnapshot: [
      {
        type: "agent",
        event: { type: "tool_start", id: "detail-tool", name: "bash", ruleKey: "npm test" },
      },
      {
        type: "agent",
        event: {
          type: "tool_result",
          id: "detail-tool",
          name: "bash",
          content: "first line\nsecond detail line",
          isError: false,
        },
      },
    ],
  });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_tool" />);
  await tick(100);
  assert.doesNotMatch(view.lastFrame() ?? "", /second detail line/);
  view.stdin.write("\u000f");
  await tick(50);
  assert.match(view.lastFrame() ?? "", /second detail line/);
  view.stdin.write("\u000f");
  await tick(50);
  assert.doesNotMatch(view.lastFrame() ?? "", /second detail line/);
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

test("TUI: 受限工作区 snapshot 中的内置工具权限请求仍可批准", async () => {
  const decisions: string[] = [];
  const host = offlineHost({
    pendingPermissions: [
      { permId: "p-restricted", toolName: "apply_patch", ruleKey: "src/app.ts" },
    ],
    onPermission: (decision) => decisions.push(decision),
  });
  const view = render(
    <App
      host={host}
      cwd="/fallback"
      model="fallback"
      sessionId="s_offline"
      workspaceTrusted={false}
      requireWorkspaceTrust
    />,
  );
  await waitFor(() => /授权请求/.test(view.lastFrame() ?? ""));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /内置 write\/edit\/apply_patch\/bash[\s\S]*工具仍可逐项授权/);
  assert.doesNotMatch(frame, /计划模式 · 只读/);

  view.stdin.write("y");
  await waitFor(() => decisions.length === 1);
  assert.deepEqual(decisions, ["allow"]);
  assert.doesNotMatch(view.lastFrame() ?? "", /授权请求/);
  view.unmount();
});

test("TUI: 运行中断失败会显示错误且不会成为未处理 rejection", async () => {
  const host = offlineHost({ running: true });
  host.interrupt = async () => {
    throw new Error("interrupt transport unavailable");
  };
  const view = render(<App host={host} cwd="/fallback" model="fallback" sessionId="s_offline" />);
  await tick(80);
  view.stdin.write("\u001b");
  await waitFor(() => /中断失败.*interrupt transport unavailable/.test(view.lastFrame() ?? ""));
  view.unmount();
});

test("TUI: 模型与工具正文中的终端控制序列不能进入渲染帧", async () => {
  const host = offlineHost({
    eventsBeforeSnapshot: [
      {
        type: "agent",
        event: {
          type: "text",
          text: "safe\x1b]52;c;SGVsbG8=\x07\x1b[2Jvisible",
        },
      },
      { type: "agent", event: { type: "done", usage: zeroUsage, turns: 1 } },
    ],
  });
  const view = render(<App host={host} cwd="/fallback" model="fallback" sessionId="s_offline" />);
  await tick(100);
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /safevisible/);
  assert.doesNotMatch(frame, /\x1b\]52|\x1b\[2J/);
  view.unmount();
});

test("TUI: 权限层贴在输入框上方，永久允许只需一次 Enter 确认", async () => {
  const decisions: string[] = [];
  const host = offlineHost({
    pendingPermissions: [{ permId: "p-arrow", toolName: "edit", ruleKey: "src/app.ts" }],
    onPermission: (decision) => decisions.push(decision),
  });
  const view = render(<App host={host} cwd="/fallback" model="fallback" sessionId="s_offline" />);
  await waitFor(() => /授权请求/.test(view.lastFrame() ?? ""));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /授权请求/);
  assert.match(frame, /输入你的目标/);
  assert.match(frame, /↑↓ 选择 · Enter 确认/);

  view.stdin.write("\u001b[B");
  await waitFor(() => /› \[a\]/.test(view.lastFrame() ?? ""));
  view.stdin.write("\u001b[B");
  await waitFor(() => /› \[p\]/.test(view.lastFrame() ?? ""));
  view.stdin.write("\r");
  await waitFor(() => decisions.length === 1);
  assert.deepEqual(decisions, ["allow_always"]);
  assert.doesNotMatch(view.lastFrame() ?? "", /授权请求/);
  view.unmount();
});

test("TUI: shell 联网授权明确标注联网且只提供一次性允许", async () => {
  const decisions: string[] = [];
  const host = offlineHost({
    pendingPermissions: [
      {
        permId: "p-network",
        toolName: "bash",
        ruleKey: "curl https://example.com",
        network: true,
        risk: "high",
      },
    ],
    onPermission: (decision) => decisions.push(decision),
  });
  const view = render(<App host={host} cwd="/fallback" model="fallback" sessionId="s_offline" />);
  await waitFor(() => /授权请求/.test(view.lastFrame() ?? ""));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /联网/);
  assert.match(frame, /本次允许联网/);
  assert.doesNotMatch(frame, /本会话允许并记住|永久允许/);

  view.stdin.write("y");
  await waitFor(() => decisions.length === 1);
  assert.deepEqual(decisions, ["allow"]);
  view.unmount();
});

test("TUI: 极矮终端的授权面板仍显示拒绝入口并保持输入框固定", async () => {
  const host = offlineHost({
    pendingPermissions: [{ permId: "p-small", toolName: "bash", ruleKey: "dangerous command" }],
  });
  const view = render(
    <App
      host={host}
      cwd="/fallback"
      model="fallback"
      sessionId="s_offline"
      terminalSize={{ rows: 10, cols: 48 }}
    />,
  );
  await waitFor(() => /授权请求/.test(view.lastFrame() ?? ""));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /\[n\] 拒绝/);
  assert.match(frame, /↑↓ 选择 · Enter 确认/);
  assert.doesNotMatch(frame, /输入你的目标/);
  assert.ok(frame.split("\n").length <= 10, frame);
  view.unmount();

  const ultra = render(
    <App
      host={offlineHost({
        pendingPermissions: [{ permId: "p-ultra", toolName: "bash", ruleKey: "danger" }],
      })}
      cwd="/fallback"
      model="fallback"
      sessionId="s_offline"
      terminalSize={{ rows: 4, cols: 16 }}
    />,
  );
  await waitFor(() => /\[n\] 拒绝/.test(ultra.lastFrame() ?? ""));
  assert.ok((ultra.lastFrame() ?? "").split("\n").length <= 4, ultra.lastFrame());
  ultra.unmount();
});

test("TUI: 会话列表高亮超过前十项时会滚动窗口并清洗元数据", async () => {
  const host = offlineHost();
  host.listSessions = async () =>
    Array.from({ length: 25 }, (_, index) => ({
      id: `session-${index}`,
      title:
        index === 15
          ? "\u001b[31msession-15\u001b[0m\u001b]8;;https://evil.invalid\u0007title\u001b]8;;\u0007"
          : `session-${index}`,
      cwd: `/work/${index}`,
      model: index === 15 ? "\u001b[32mdebug/demo\u001b[0m" : "debug/demo",
      createdAt: "2026-07-14T00:00:00.000Z",
      updatedAt: "2026-07-14T00:00:00.000Z",
      running: false,
    }));
  const view = render(
    <App
      host={host}
      cwd="/fallback"
      model="fallback"
      sessionId="s_offline"
      terminalSize={{ rows: 24, cols: 80 }}
    />,
  );
  await tick(80);
  for (const ch of "/sessions") view.stdin.write(ch);
  view.stdin.write("\r");
  await waitFor(() => /会话列表/.test(view.lastFrame() ?? ""));
  for (let i = 0; i < 15; i++) view.stdin.write("\u001b[B");
  await waitFor(() => /session-15.*title/.test(view.lastFrame() ?? ""));
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /session-15.*title/);
  assert.doesNotMatch(frame, /\u001b\[31m|\u001b\]8;;|evil\.invalid/);
  view.unmount();
});

test("TUI: /help 与 /status 显示快捷帮助和 snapshot 实际元数据", async () => {
  const networkTools: NetworkToolStatuses = {
    webSearch: { state: "disabled", reason: "credential_not_configured" },
    webFetch: { state: "ready" },
  };
  const host = offlineHost({
    id: "s_status",
    cwd: "/status/cwd",
    model: "status/model",
    networkTools,
  });
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
  assert.match(frame, /web_search: 已禁用 · 未配置搜索凭据/);
  assert.match(frame, /webfetch: 可用/);

  for (const ch of "/tools") view.stdin.write(ch);
  view.stdin.write("\r");
  await tick(80);
  assert.match(view.lastFrame() ?? "", /联网工具[\s\S]*web_search[\s\S]*webfetch/);
  view.unmount();
});

test("TUI: network tool diagnostics are explicit and bash network approval is one-shot", () => {
  assert.match(
    networkToolsText({
      webSearch: { state: "ready", provider: "brave" },
      webFetch: { state: "disabled", reason: "workspace_restricted" },
    }),
    /web_search: 可用 \(brave\)[\s\S]*webfetch: 已禁用 · 工作区未授信/,
  );
  assert.deepEqual(permissionAnswersFor({ toolName: "bash", network: true }), ["allow", "deny"]);
  assert.deepEqual(permissionAnswersFor({ toolName: "bash", network: false }), [
    "allow",
    "allow_remember",
    "allow_always",
    "deny",
  ]);
});

test("TUI: /mouse 可切换跟踪，off 明确恢复原生框选/复制", async () => {
  const host = offlineHost({ id: "s_mouse", cwd: "/work", model: "debug/demo" });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_mouse" />);
  await tick(60);

  for (const ch of "/mouse on") view.stdin.write(ch);
  view.stdin.write("\r");
  await tick(50);
  assert.match(view.lastFrame() ?? "", /鼠标.*跟踪|Mouse.*tracking/);

  for (const ch of "/mouse off") view.stdin.write(ch);
  view.stdin.write("\r");
  await tick(50);
  assert.match(view.lastFrame() ?? "", /原生框选|Native text selection/);
  assert.match(view.lastFrame() ?? "", /PageUp\/PageDown/);
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
      discoverModels={async (providerId) =>
        providerId === "cloud-test" ? ["org/model-v1"] : undefined
      }
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

    for (const ch of "/model cloud-test/removed-model") view.stdin.write(ch);
    view.stdin.write("\r");
    await waitFor(() => /当前未被模型端点列为可用/.test(view.lastFrame() ?? ""));
    assert.equal(created, undefined, "未出现在实时目录的模型不得创建会话");

    const spec = "cloud-test/org/model-v1";
    for (const ch of `/model ${spec}`) view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await waitFor(() => created !== undefined && /会话边界 s_new/.test(view.lastFrame() ?? ""));

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

test("TUI: 打开和重新打开 /model 只读本地目录，最终选择才在线校验", async () => {
  const providers: ProviderDescriptor[] = [
    {
      id: "fresh",
      name: "Fresh Provider",
      kind: "openai-compatible",
      protocol: "openai-chat",
      aliases: [],
      baseURL: "http://127.0.0.1:18999/v1",
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
      model: "old-model",
      label: "Old Model",
      providerId: "fresh",
      providerName: "Fresh Provider",
      spec: "fresh/old-model",
      local: true,
      requiresApiKey: false,
    },
  ];
  let calls = 0;
  const view = render(
    <App
      host={offlineHost()}
      cwd="/work"
      model="debug/demo"
      sessionId="s_refresh_models"
      providers={providers}
      catalog={catalog}
      discoverModels={async () => {
        calls++;
        return [];
      }}
    />,
  );
  await tick(80);
  try {
    for (const ch of "/model") view.stdin.write(ch);
    view.stdin.write("\r");
    await waitFor(() => /Old Model/.test(view.lastFrame() ?? ""));
    assert.equal(calls, 0, "打开 picker 不得读取 provider 凭据或请求 /models");
    view.stdin.write("\u001b");
    await waitFor(() => !/选择模型/.test(view.lastFrame() ?? ""));

    for (const ch of "/model") view.stdin.write(ch);
    view.stdin.write("\r");
    await waitFor(() => /Old Model/.test(view.lastFrame() ?? ""));
    assert.equal(calls, 0, "重新打开 picker 仍不得进行鉴权探测");

    view.stdin.write("\r");
    await waitFor(() => calls === 1);
    view.stdin.write("\u001b");
    await waitFor(() => /当前未被模型端点列为可用/.test(view.lastFrame() ?? ""));
    assert.equal(calls, 1, "最终选择只校验一次所选 provider");
  } finally {
    view.unmount();
  }
});

test("TUI: DeepSeek V4 Flash 被实时端点列出时可选中且只探测一次", async () => {
  let discoveryCalls = 0;
  let created: { cwd: string; model: string; title?: string } | undefined;
  const view = render(
    <App
      host={offlineHost({ cwd: "/work", onCreate: (input) => (created = input) })}
      cwd="/work"
      model="debug/demo"
      sessionId="s_deepseek_v4"
      discoverModels={async (providerId) => {
        discoveryCalls++;
        assert.equal(providerId, "deepseek");
        return ["deepseek-v4-flash", "deepseek-v4-pro"];
      }}
    />,
  );
  await tick(80);
  try {
    for (const ch of "/model deepseek/deepseek-v4-flash") view.stdin.write(ch);
    view.stdin.write("\r");
    await waitFor(() => created !== undefined);

    assert.equal(discoveryCalls, 1);
    assert.deepEqual(created, { cwd: "/work", model: "deepseek/deepseek-v4-flash" });
    assert.doesNotMatch(view.lastFrame() ?? "", /未被模型端点|无法从模型端点校验/);
  } finally {
    view.unmount();
  }
});

test("TUI: 非 provider/model 格式在访问模型端点前被拒绝", async () => {
  let discoveryCalls = 0;
  const view = render(
    <App
      host={offlineHost()}
      cwd="/work"
      model="debug/demo"
      sessionId="s_invalid_model_spec"
      discoverModels={async () => {
        discoveryCalls++;
        return [];
      }}
    />,
  );
  await tick(80);
  try {
    for (const ch of "/model deepseek") view.stdin.write(ch);
    view.stdin.write("\r");
    await waitFor(() => /应使用 <provider\/model> 格式/.test(view.lastFrame() ?? ""));
    assert.equal(discoveryCalls, 0);
  } finally {
    view.unmount();
  }
});

test("TUI: 未信任工作区探测失败时提示项目 env 未加载和显式授信", async () => {
  let discoveryCalls = 0;
  const view = render(
    <App
      host={offlineHost({ cwd: "/work" })}
      cwd="/work"
      model="debug/demo"
      sessionId="s_untrusted_model"
      workspaceTrusted={false}
      requireWorkspaceTrust
      discoverModels={async () => {
        discoveryCalls++;
        return undefined;
      }}
      terminalSize={{ cols: 180, rows: 40 }}
    />,
  );
  await tick(80);
  try {
    for (const ch of "/model deepseek/deepseek-v4-flash") view.stdin.write(ch);
    view.stdin.write("\r");
    await waitFor(() => /受限工作区不会加载项目 \.env 凭据/.test(view.lastFrame() ?? ""));

    const frame = view.lastFrame() ?? "";
    assert.equal(discoveryCalls, 1, "只有最终选中的 provider 可探测一次");
    assert.match(frame, /anicode trust grant --cwd \/work/);
    assert.match(frame, /重启 AniCode 后重试/);
    assert.doesNotMatch(frame, /当前未被模型端点列为可用/);
  } finally {
    view.unmount();
  }
});

test("TUI: /model 无参打开选择器，滚轮选中并 Enter 以该模型新建会话，Esc 取消", async () => {
  let created: { cwd: string; model: string; title?: string } | undefined;
  const discoveredProviders: string[] = [];
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
    {
      id: "openrouter",
      name: "OpenRouter",
      kind: "openai-compatible",
      protocol: "openai-chat",
      aliases: [],
      baseURL: "https://openrouter.ai/api/v1",
      apiKeyEnv: ["OPENROUTER_API_KEY"],
      requiresApiKey: true,
      local: false,
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
      discoverModels={async (providerId) => {
        discoveredProviders.push(providerId);
        return providerId === "debug"
          ? ["demo"]
          : providerId === "openrouter"
            ? ["meta-llama/llama-3.3-70b-instruct:free"]
            : undefined;
      }}
      inspectProviderCredentials
    />,
  );

  try {
    await tick(80);
    // 打开选择器
    for (const ch of "/model") view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await waitFor(() => /选择模型/.test(view.lastFrame() ?? ""));

    const pickerFrame = view.lastFrame() ?? "";
    assert.match(pickerFrame, /选择模型/);
    assert.match(pickerFrame, /Debug Demo/);
    assert.match(pickerFrame, /Free/); // 免费模型右侧标 Free
    assert.match(pickerFrame, /OpenRouter/); // 按 provider 分组的组标题
    assert.match(pickerFrame, /搜索模型…/); // 选择器复用底部输入框，不再居中接管整屏
    assert.doesNotMatch(pickerFrame, /↑\/↓|Enter 确认/); // 固定视口无需额外操作提示行
    // 打开时未新建会话
    assert.equal(created, undefined);
    assert.deepEqual(discoveredProviders, [], "浏览 picker 不得触发任何 provider 鉴权");

    // Esc 取消不新建会话
    view.stdin.write("\u001b");
    await waitFor(() => !/选择模型/.test(view.lastFrame() ?? ""));
    assert.doesNotMatch(view.lastFrame() ?? "", /选择模型/);
    assert.equal(created, undefined);
    assert.deepEqual(discoveredProviders, [], "Esc 取消前不得触发 provider 鉴权");

    // 再次打开，鼠标滚轮向下到第二项（Llama），Enter 新建
    for (const ch of "/model") view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await waitFor(() => /选择模型/.test(view.lastFrame() ?? ""));
    view.stdin.write("\u001b[<65;10;10M".repeat(8)); // 触控板会批量合并滚轮事件
    await tick(20);
    assert.doesNotMatch(view.lastFrame() ?? "", /\[<65;/); // 鼠标序列不能污染搜索词
    view.stdin.write("\r");
    await waitFor(() => created !== undefined && /会话边界 s_new/.test(view.lastFrame() ?? ""));

    assert.deepEqual(created, {
      cwd: "/pick/project",
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
    });
    assert.deepEqual(
      discoveredProviders,
      ["openrouter"],
      "最终选择只允许校验被选中的唯一 provider",
    );
    assert.match(view.lastFrame() ?? "", /会话边界 s_new/);
  } finally {
    view.unmount();
  }
});

test("TUI: 结果页模型选择器遮住底层文字，选中后带历史切换而不返回首页", async () => {
  const marker = "MODEL_PICKER_BACKGROUND_LEAK";
  let created = false;
  let forked:
    | {
        sessionId: string;
        opts?: { title?: string; upToMessage?: number; model?: string };
      }
    | undefined;
  const host = offlineHost({
    id: "s_result",
    cwd: "/result/project",
    model: "old/model",
    messages: [
      { role: "user", content: [{ type: "text", text: "问题" }] },
      { role: "assistant", content: [{ type: "text", text: marker }] },
    ],
    onCreate: () => {
      created = true;
    },
    onFork: (sessionId, opts) => {
      forked = { sessionId, ...(opts ? { opts } : {}) };
    },
  });
  const view = render(
    <App
      host={host}
      cwd="/wrong"
      model="wrong"
      sessionId="s_result"
      terminalSize={{ rows: 20, cols: 80 }}
      providers={[
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
      ]}
      catalog={[
        {
          model: "demo",
          label: "Debug Demo",
          providerId: "debug",
          providerName: "anicode Debug",
          spec: "debug/demo",
          local: true,
          requiresApiKey: false,
        },
      ]}
      discoverModels={async () => ["demo"]}
      inspectProviderCredentials
    />,
  );

  try {
    await waitFor(() => (view.lastFrame() ?? "").includes(marker));
    for (const ch of "/model") view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await waitFor(() => /选择模型/.test(view.lastFrame() ?? ""));
    assert.doesNotMatch(view.lastFrame() ?? "", new RegExp(marker));
    const pickerLines = (view.lastFrame() ?? "").split("\n");
    const selectedLine = pickerLines.find((line) => line.includes("Debug Demo"));
    assert.equal(
      selectedLine?.length,
      80,
      "模型候选行应从左边框连续铺到右边框，不保留框内 padding",
    );

    view.stdin.write("\r");
    await waitFor(() => forked !== undefined && (view.lastFrame() ?? "").includes(marker));
    assert.equal(created, false);
    assert.deepEqual(forked, { sessionId: "s_result", opts: { model: "debug/demo" } });
    assert.match(view.lastFrame() ?? "", /debug\/demo|demo/);
  } finally {
    view.unmount();
  }
});

test("TUI: /model 浏览不探测失败 provider，选中后才单独校验并拒绝不可用模型", async () => {
  const providers: ProviderDescriptor[] = [
    {
      id: "down",
      name: "Down Provider",
      kind: "openai-compatible",
      protocol: "openai-chat",
      aliases: [],
      baseURL: "https://down.invalid/v1",
      apiKeyEnv: ["DOWN_API_KEY"],
      requiresApiKey: true,
      local: false,
      capabilities: { tools: true, reasoning: false },
      limits: {},
      models: [],
      catalog: [],
    },
  ];
  const catalog: ModelCatalogEntry[] = [
    {
      model: "ghost-model",
      providerId: "down",
      providerName: "Down Provider",
      spec: "down/ghost-model",
      local: false,
      requiresApiKey: true,
    },
  ];
  const discoveredProviders: string[] = [];
  let created = false;
  const view = render(
    <App
      host={offlineHost({ onCreate: () => (created = true) })}
      cwd="/work"
      model="debug/demo"
      sessionId="s_offline"
      providers={providers}
      catalog={catalog}
      discoverModels={async (providerId) => {
        discoveredProviders.push(providerId);
        return undefined;
      }}
    />,
  );
  await tick(80);
  try {
    for (const ch of "/model") view.stdin.write(ch);
    view.stdin.write("\r");
    await waitFor(() => /ghost-model/.test(view.lastFrame() ?? ""));
    assert.deepEqual(discoveredProviders, []);

    view.stdin.write("\r");
    await waitFor(() => discoveredProviders.length === 1);
    assert.deepEqual(discoveredProviders, ["down"]);
    assert.equal(created, false);
    view.stdin.write("\u001b");
    await waitFor(() => /无法从模型端点校验/.test(view.lastFrame() ?? ""));
    assert.doesNotMatch(view.lastFrame() ?? "", /当前未被模型端点列为可用/);
  } finally {
    view.unmount();
  }
});

test("TUI: bracketed paste 的尾随换行只插入、绝不隐式提交", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_offline" />);
  await tick(80);

  view.stdin.write("\u001b[200~pasted request\n\u001b[201~");
  await tick(40);

  assert.deepEqual(sent, []);
  view.stdin.write("\r");
  await tick(80);

  assert.deepEqual(sent, ["pasted request"]);
  assert.doesNotMatch(view.lastFrame() ?? "", /pasted request\r/);
  view.unmount();
});

test("TUI: bracketed paste 保留内部换行直到用户显式提交", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_offline" />);
  await tick(80);

  view.stdin.write("\u001b[200~first line\nsecond line\u001b[201~");
  await tick(40);
  assert.deepEqual(sent, []);

  view.stdin.write("\r");
  await tick(80);
  assert.deepEqual(sent, ["first line\nsecond line"]);
  view.unmount();
});

test("TUI: 被拆成多个 stdin chunk 的 bracketed paste 保持原子且不自动提交", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_offline" />);
  await tick(80);

  view.stdin.write("\u001b[200~first line\n");
  await tick(5); // PTY 的下一块可能落在后续 event-loop tick
  view.stdin.write("second line\n\u001b[201~");
  await tick(40);

  assert.deepEqual(sent, []);
  view.stdin.write("\r");
  await tick(80);

  assert.deepEqual(sent, ["first line\nsecond line"]);
  view.unmount();
});

test("TUI: 光标与退格不会拆开 emoji grapheme", async () => {
  const sent: string[] = [];
  const host = offlineHost({ onSend: (text) => sent.push(text) });
  const view = render(<App host={host} cwd="/work" model="debug/demo" sessionId="s_unicode" />);
  await tick(80);

  view.stdin.write("\u001b[200~a👨‍💻b\u001b[201~");
  await tick(20);
  view.stdin.write("\u001b[D");
  view.stdin.write("\u007f");
  view.stdin.write("\r");
  await tick(80);

  assert.deepEqual(sent, ["ab"]);
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

test("TUI: 任务清单只显示当前运行中的未完成任务，旧结果与结束事件会隐藏它", async () => {
  const todoMessages = (status: "pending" | "in_progress" | "completed"): ChatMessage[] => [
    {
      role: "assistant",
      content: [
        {
          type: "tool_call",
          id: "todo-current",
          name: "todo_write",
          args: { todos: [{ content: "整理搜索结果", status }] },
        },
      ],
    },
  ];

  const idle = render(
    <App
      host={offlineHost({ messages: todoMessages("completed"), running: false })}
      cwd="/work"
      model="debug/demo"
      sessionId="s_todo_idle"
    />,
  );
  await tick(80);
  assert.doesNotMatch(idle.lastFrame() ?? "", /任务清单|Task list/);
  idle.unmount();

  const active = render(
    <App
      host={offlineHost({ messages: todoMessages("in_progress"), running: true })}
      cwd="/work"
      model="debug/demo"
      sessionId="s_todo_active"
    />,
  );
  await tick(80);
  assert.match(active.lastFrame() ?? "", /任务清单|Task list/);
  active.unmount();

  const finished = render(
    <App
      host={offlineHost({
        messages: todoMessages("in_progress"),
        running: true,
        eventsBeforeSnapshot: [{ type: "state", running: false }],
      })}
      cwd="/work"
      model="debug/demo"
      sessionId="s_todo_finished"
    />,
  );
  await tick(80);
  assert.doesNotMatch(finished.lastFrame() ?? "", /任务清单|Task list/);
  finished.unmount();
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

test("TUI: 恢复会话时从持久化用户消息重建 prompt 历史", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "第一问" }] },
    { role: "assistant", content: [{ type: "text", text: "第一答" }] },
    {
      role: "user",
      content: [
        { type: "text", text: "内部上下文", internal: true },
        { type: "tool_result", toolCallId: "t1", toolName: "read", content: "result" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "第二问" }] },
    { role: "user", content: [{ type: "text", text: "第二问" }] },
  ];
  assert.deepEqual(promptHistoryFromMessages(messages), ["第一问", "第二问"]);
  assert.deepEqual(promptHistoryFromMessages(messages, 1), ["第二问"]);
  assert.deepEqual(promptHistoryFromMessages(messages, 0), []);
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

  // 宽屏：5 行实心块大字，每行都含块字符且不超宽。
  const wide = rowsAt(120);
  assert.equal(wide.length, 5, "宽屏应为 5 行块字 logo");
  for (const row of wide) {
    assert.match(row, /█/, "块字行应含实心块字符");
    assert.ok(contentWidth(row) <= 120);
  }

  // 极窄屏：只裁两侧、不折行（行数不超过 logo 高度）、不超宽。
  for (const width of [24, 12, 4]) {
    const rows = rowsAt(width);
    assert.ok(rows.length <= 5, `width=${width} 不应折行超过 logo 高度：${rows.length} 行`);
    assert.ok(rows.length >= 1, `width=${width} logo 不应整块消失`);
    for (const row of rows) {
      assert.ok(contentWidth(row) <= width, `width=${width} 超宽`);
    }
  }
});

test("TUI: 空会话 Tip 展示通用能力与 /help，宽度始终受终端约束", () => {
  for (const width of [80, 48, 28]) {
    const frame = (render(<WelcomeTip width={width} />).lastFrame() ?? "").replace(SGR, "");
    assert.match(frame, /Tip/);
    assert.match(frame, /\/help/);
    assert.match(frame, /调研|research/);
    assert.match(frame, /代码|code/);
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
        running={false}
        spinner="●"
      />,
    ).lastFrame() ?? "";
  return frame.replace(SGR, "").split("\n");
}

test("TUI: 输入面板只显示去掉 provider 的模型标识", () => {
  const rows = panelRows({ text: "", cursor: 0, width: 80 });
  assert.match(rows[3]!, /claude-opus-4-8/);
  assert.doesNotMatch(rows[3]!, /anthropic|project| · /);
});

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

test("TUI: IME 真实光标与中文、多行输入面板中的绘制插入点重合", () => {
  const visualPosition = composerCaretPosition({
    panelTop: 3,
    text: "深圳的",
    cursor: "深圳的".length,
    width: 80,
    maxInputRows: 5,
    terminalRows: 24,
  });
  assert.deepEqual(
    visualPosition,
    // panel 下一行；竖条 + 空格后，3 个汉字占 6 列。
    { x: 8, y: 4 },
  );
  const multiline = "第一行\n第二行\n第三行";
  assert.deepEqual(
    composerCaretPosition({
      panelTop: 8,
      text: multiline,
      cursor: multiline.length,
      width: 20,
      maxInputRows: 2,
      terminalRows: 24,
    }),
    // 只显示末两行，第三行是可见窗口内第 2 行。
    { x: 8, y: 10 },
  );
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

test("subagentActivityLine: 从子 agent 转发事件提炼活动行", () => {
  // tool_start → ⚙ 名称 + ruleKey
  assert.equal(
    subagentActivityLine({ type: "tool_start", name: "grep", ruleKey: "foo" }),
    "⚙ grep foo",
  );
  // tool_result → ✔/✖ 名称
  assert.equal(
    subagentActivityLine({ type: "tool_result", name: "read", isError: false }),
    "✔ read",
  );
  assert.equal(
    subagentActivityLine({ type: "tool_result", name: "bash", isError: true }),
    "✖ bash",
  );
  // 文本/思考等噪声事件不作为活动行
  assert.equal(subagentActivityLine({ type: "text", text: "hi" }), null);
  assert.equal(subagentActivityLine(null), null);
  // 嵌套子 agent（tool_progress 套 tool_progress）下钻到叶子，逐层加 › 前缀
  assert.equal(
    subagentActivityLine({
      type: "tool_progress",
      name: "task",
      event: { type: "tool_start", name: "bash", ruleKey: "npm test" },
    }),
    "› ⚙ bash npm test",
  );
});
