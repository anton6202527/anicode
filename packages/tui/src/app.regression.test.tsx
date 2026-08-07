/**
 * TUI 交互回归测试：把近期提交沉淀的行为固化住——输入编辑快捷键（Ctrl+E/U/K）、
 * PageUp/PageDown 回看、斜杠菜单 ↑/↓ 选择、/model 选择器搜索过滤、权限模式边界、
 * /undo 接线。全离线（假 SessionHost），防止下次重构 app.tsx 悄悄打碎这些行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import type {
  PendingPermission,
  PermissionMode,
  ProviderDescriptor,
  SessionEvent,
  SessionHost,
  WorkspaceTrustReason,
} from "@anicode/core";
import { App, parseMouseInput, terminalMouseModeSequence } from "./app.js";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

test("TUI 回归: SGR 左键点击解析坐标，释放事件不重复触发", () => {
  assert.deepEqual(parseMouseInput("\u001b[<0;20;10M\u001b[<0;20;10m"), {
    wheelDelta: 0,
    leftClick: { column: 20, row: 10 },
  });
  assert.deepEqual(parseMouseInput("\u001b[<0;20;10m"), { wheelDelta: 0 });
});

test("TUI 回归: 关闭鼠标协议时保留左键拖选，开启时接收滚轮", () => {
  const selectable = terminalMouseModeSequence(false);
  assert.match(selectable, /\?1000l/);
  assert.match(selectable, /\?1006l/);
  assert.match(selectable, /\?1007h/);
  assert.doesNotMatch(selectable, /\?1000h|\?1006h/);

  const fullTracking = terminalMouseModeSequence(true);
  assert.match(fullTracking, /\?1007l/);
  assert.match(fullTracking, /\?1000h/);
  assert.match(fullTracking, /\?1006h/);
});

test("TUI 安全边界: 仅本地且受信任工作区展开 @文件，远端与受限工作区原文透传", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tui-mention-boundary-"));
  await fs.writeFile(path.join(dir, "secret.txt"), "CLIENT_ONLY_SECRET", "utf8");
  try {
    const cases = [
      { name: "trusted-local", canInspectWorkspace: true, workspaceTrusted: true, expands: true },
      { name: "remote", canInspectWorkspace: false, workspaceTrusted: true, expands: false },
      { name: "restricted", canInspectWorkspace: true, workspaceTrusted: false, expands: false },
    ] as const;
    for (const scenario of cases) {
      const sent: string[] = [];
      const host = makeHost({
        cwd: dir,
        workspaceTrusted: scenario.workspaceTrusted,
        onSend: (text) => sent.push(text),
      });
      const view = mount(host, {
        canInspectWorkspace: scenario.canInspectWorkspace,
        requireWorkspaceTrust: true,
      });
      await tick(80);
      try {
        view.stdin.write("inspect @secret.txt");
        view.stdin.write("\r");
        await tick(100);
        assert.equal(sent.length, 1, scenario.name);
        assert.equal(sent[0]!.includes("CLIENT_ONLY_SECRET"), scenario.expands, scenario.name);
        if (!scenario.expands) assert.equal(sent[0], "inspect @secret.txt", scenario.name);
      } finally {
        view.unmount();
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("TUI 安全边界: /diff 对远端与受限工作区 fail closed", async () => {
  const cases = [
    {
      canInspectWorkspace: false,
      workspaceTrusted: true,
      expected: /无法检查宿主工作区/,
    },
    {
      canInspectWorkspace: true,
      workspaceTrusted: false,
      expected: /受限工作区中已禁用/,
    },
  ] as const;
  for (const scenario of cases) {
    const host = makeHost({
      cwd: "/definitely/not/a/local/repository",
      workspaceTrusted: scenario.workspaceTrusted,
    });
    const view = mount(host, {
      canInspectWorkspace: scenario.canInspectWorkspace,
      requireWorkspaceTrust: true,
    });
    await tick(80);
    try {
      view.stdin.write("/diff");
      view.stdin.write("\r");
      await tick(80);
      const frame = view.lastFrame() ?? "";
      assert.match(frame, scenario.expected);
      assert.doesNotMatch(frame, /not a git repository|ENOENT/);
    } finally {
      view.unmount();
    }
  }
});

/** 最小离线 host：可注入历史事件与 undo/setPermissionMode 行为。 */
function makeHost(
  options: {
    eventsBeforeSnapshot?: SessionEvent[];
    pendingPermissions?: PendingPermission[];
    permissionMode?: PermissionMode;
    cwd?: string;
    workspaceTrusted?: boolean;
    workspaceTrustReason?: WorkspaceTrustReason;
    onSend?: (text: string) => void;
    onCreate?: (input: { cwd: string; model: string; title?: string }) => void;
    onOpen?: (listener: (event: SessionEvent) => void) => void;
    onPermission?: (decision: "allow" | "allow_remember" | "allow_always" | "deny") => void;
    undo?: (sessionId: string, arg?: string) => Promise<{ restored: number; deleted: number }>;
    setPermissionMode?: (sessionId: string, mode: PermissionMode) => Promise<void>;
    setPermissionProfile?: (sessionId: string, name: string) => Promise<"plan" | "default">;
  } = {},
): SessionHost {
  const meta = {
    id: "s_reg",
    cwd: options.cwd ?? "/reg/project",
    model: "debug/demo",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
  };
  const sendLog: { text: string; model?: string }[] = [];
  const host: SessionHost = {
    async listSessions() {
      return [];
    },
    async createSession(input) {
      options.onCreate?.(input);
      return {
        id: "s_new",
        cwd: input.cwd,
        model: input.model,
        ...(input.title ? { title: input.title } : {}),
        createdAt: meta.createdAt,
        updatedAt: meta.updatedAt,
        running: false,
      };
    },
    async open(_sessionId, listener) {
      options.onOpen?.(listener);
      for (const event of options.eventsBeforeSnapshot ?? []) listener(event);
      return {
        snapshot: {
          meta,
          messages: [],
          usage: zeroUsage,
          running: false,
          pendingPermissions: options.pendingPermissions ?? [],
          ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}),
          ...(options.workspaceTrusted === undefined
            ? {}
            : {
                workspaceTrust: {
                  trusted: options.workspaceTrusted,
                  reason:
                    options.workspaceTrustReason ??
                    (options.workspaceTrusted ? ("trusted" as const) : ("not-trusted" as const)),
                  executionSources: [],
                  storeFile: "/tmp/anicode-test-trust.json",
                  assessedAt: "2026-07-17T00:00:00.000Z",
                },
              }),
        },
        close() {},
      };
    },
    async send(_sessionId, text, opts) {
      sendLog.push({ text, ...(opts?.model ? { model: opts.model } : {}) });
      options.onSend?.(text);
    },
    async interrupt() {},
    async undo(sessionId, arg) {
      if (options.undo) return options.undo(sessionId, arg);
      return { restored: 0, deleted: 0 };
    },
    async answerPermission(_sessionId, _permId, decision) {
      options.onPermission?.(decision);
      return true;
    },
    dispose() {},
  };
  (host as SessionHost & { sendLog: typeof sendLog }).sendLog = sendLog;
  if (options.setPermissionMode) host.setPermissionMode = options.setPermissionMode;
  if (options.setPermissionProfile) {
    const spp = options.setPermissionProfile;
    host.setPermissionProfile = (sid, name) => spp(sid, name);
    host.listPermissionProfiles = async () => ({
      readonly: { mode: "plan", description: "read-only" },
      full: { mode: "auto", description: "auto-approve" },
    });
  }
  return host;
}

function mount(host: SessionHost, extra: Record<string, unknown> = {}) {
  return render(
    <App host={host} cwd="/reg/project" model="debug/demo" sessionId="s_reg" {...extra} />,
  );
}

test("TUI 安全边界: authoritative trust-change 立即降级并清除权限 UI", async () => {
  let emit: ((event: SessionEvent) => void) | undefined;
  const host = makeHost({
    workspaceTrusted: true,
    onOpen: (listener) => {
      emit = listener;
    },
  });
  const view = mount(host, { requireWorkspaceTrust: true, canInspectWorkspace: true });
  await tick(80);
  try {
    emit?.({
      type: "permission_request",
      permId: "p-before-revoke",
      toolName: "bash",
      ruleKey: "bash:*",
    });
    await tick(80);
    assert.match(view.lastFrame() ?? "", /授权请求/);

    emit?.({
      type: "workspace_trust",
      assessment: {
        trusted: false,
        reason: "execution-config-changed",
        executionSources: [],
        storeFile: "/tmp/anicode-test-trust.json",
        assessedAt: "2026-07-17T00:00:00.000Z",
      },
    });
    await tick(80);
    const downgraded = view.lastFrame() ?? "";
    assert.match(downgraded, /工作区信任已撤销/);
    assert.doesNotMatch(downgraded, /授权请求/);

    view.stdin.write("/diff");
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /受限工作区中已禁用/);
  } finally {
    view.unmount();
  }
});

test("TUI 受限工作区: 初始与新权限请求均可逐项允许或拒绝", async () => {
  let emit: ((event: SessionEvent) => void) | undefined;
  const decisions: string[] = [];
  const host = makeHost({
    workspaceTrusted: false,
    pendingPermissions: [
      { permId: "p-initial", toolName: "edit", ruleKey: "src/app.ts", risk: "medium" },
    ],
    onOpen: (listener) => {
      emit = listener;
    },
    onPermission: (decision) => decisions.push(decision),
  });
  const view = mount(host, { requireWorkspaceTrust: true, canInspectWorkspace: true });
  await tick(100);
  try {
    const initial = view.lastFrame() ?? "";
    assert.match(initial, /内置 write\/edit\/apply_patch\/bash[\s\S]*工具仍可逐项授权/);
    assert.match(initial, /MCP、hooks、项目扩展与网络访问已禁用/);
    assert.match(initial, /授权请求/);
    assert.doesNotMatch(initial, /计划模式 · 只读/);

    view.stdin.write("y");
    await tick(80);
    assert.deepEqual(decisions, ["allow"]);
    assert.doesNotMatch(view.lastFrame() ?? "", /授权请求/);

    emit?.({
      type: "permission_request",
      permId: "p-after-open",
      toolName: "bash",
      ruleKey: "npm test",
      risk: "medium",
    });
    await tick(80);
    assert.match(view.lastFrame() ?? "", /授权请求/);
    view.stdin.write("n");
    await tick(80);
    assert.deepEqual(decisions, ["allow", "deny"]);
    assert.doesNotMatch(view.lastFrame() ?? "", /授权请求/);
  } finally {
    view.unmount();
  }
});

test("TUI 检查失败: 初始状态启用严格只读安全锁且 read ask 可答复", async () => {
  const modeCalls: string[] = [];
  const decisions: string[] = [];
  const host = makeHost({
    workspaceTrusted: false,
    workspaceTrustReason: "inspection-failed",
    pendingPermissions: [
      { permId: "p-strict-read", toolName: "read", ruleKey: "README.md", risk: "medium" },
    ],
    onPermission: (decision) => decisions.push(decision),
    setPermissionMode: async (_sessionId, mode) => {
      modeCalls.push(mode);
    },
  });
  const view = mount(host, { requireWorkspaceTrust: true });
  await tick(100);
  try {
    const initial = view.lastFrame() ?? "";
    assert.match(initial, /工作区检查失败/);
    assert.match(initial, /严格只读安全锁/);
    assert.match(initial, /仅可使用内置 read\/glob\/grep/);
    assert.doesNotMatch(initial, /\/plan|计划模式|\bplan\b/i);
    assert.match(initial, /授权请求: read/);
    assert.doesNotMatch(initial, /仍可逐项授权/);

    view.stdin.write("n");
    await tick(80);
    assert.deepEqual(decisions, ["deny"]);
    assert.doesNotMatch(view.lastFrame() ?? "", /授权请求/);

    view.stdin.write("\u001b[Z");
    await tick(60);
    const locked = view.lastFrame() ?? "";
    assert.match(locked, /严格只读安全锁无法切换/);
    assert.doesNotMatch(locked, /\/plan|计划模式|\bplan\b/i);
    assert.deepEqual(modeCalls, [], "strict mode must never request default/accept/bypass");
  } finally {
    view.unmount();
  }
});

test("TUI 检查失败事件: 同为 untrusted 的 reason 升级也进入严格模式", async () => {
  let emit: ((event: SessionEvent) => void) | undefined;
  const modeCalls: string[] = [];
  const decisions: string[] = [];
  const host = makeHost({
    workspaceTrusted: false,
    workspaceTrustReason: "not-trusted",
    onOpen: (listener) => {
      emit = listener;
    },
    setPermissionMode: async (_sessionId, mode) => {
      modeCalls.push(mode);
    },
    onPermission: (decision) => decisions.push(decision),
  });
  const view = mount(host, { requireWorkspaceTrust: true });
  await tick(100);
  try {
    emit?.({
      type: "permission_request",
      permId: "p-before-inspection-failure",
      toolName: "edit",
      ruleKey: "src/app.ts",
    });
    await tick(80);
    assert.match(view.lastFrame() ?? "", /授权请求/);

    emit?.({
      type: "workspace_trust",
      assessment: {
        trusted: false,
        reason: "inspection-failed",
        executionSources: [],
        storeFile: "/tmp/anicode-test-trust.json",
        assessedAt: "2026-07-17T00:00:00.000Z",
      },
    });
    await tick(80);
    const strict = view.lastFrame() ?? "";
    assert.match(strict, /工作区检查失败/);
    assert.match(strict, /严格只读安全锁/);
    assert.doesNotMatch(strict, /\/plan|计划模式|\bplan\b/i);
    assert.doesNotMatch(strict, /授权请求/);

    emit?.({
      type: "permission_request",
      permId: "p-after-inspection-failure",
      toolName: "read",
      ruleKey: "README.md",
    });
    await tick(80);
    assert.match(view.lastFrame() ?? "", /授权请求: read/);
    view.stdin.write("y");
    await tick(80);
    assert.deepEqual(decisions, ["allow"]);
    assert.doesNotMatch(view.lastFrame() ?? "", /授权请求/);
    view.stdin.write("\u001b[Z");
    await tick(60);
    assert.deepEqual(modeCalls, []);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: Ctrl+E 跳行尾、Ctrl+K 删到行尾", async () => {
  const host = makeHost();
  const view = mount(host);
  await tick();
  try {
    for (const ch of "abc") view.stdin.write(ch);
    view.stdin.write(""); // Ctrl+A 行首
    view.stdin.write("Z"); // 行首插入
    view.stdin.write(""); // Ctrl+E 行尾
    view.stdin.write("!"); // 行尾追加
    await tick(20);
    assert.match(view.lastFrame() ?? "", /Zabc!/);

    view.stdin.write(""); // Ctrl+A
    view.stdin.write(""); // Ctrl+K 删到行尾 → 清空
    await tick(20);
    assert.doesNotMatch(view.lastFrame() ?? "", /Zabc!/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: Ctrl+U 删到行首只保留光标后内容", async () => {
  const host = makeHost();
  const view = mount(host);
  await tick();
  try {
    for (const ch of "xx yy") view.stdin.write(ch);
    for (let i = 0; i < 3; i++) view.stdin.write("[D"); // ← ×3，光标停在 "xx" 后
    view.stdin.write(""); // Ctrl+U 删到行首
    await tick(20);
    const frame = view.lastFrame() ?? "";
    assert.match(frame, /yy/);
    assert.doesNotMatch(frame, /xx/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: PageUp/完整鼠标滚轮只回看结果区，不显示额外状态提示", async () => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 8; i++) {
    events.push({
      type: "agent",
      event: { type: "user_message", text: `问题-${i}`, queued: false },
    });
    events.push({ type: "agent", event: { type: "text", text: `回答-${i}` } });
  }
  events.push({ type: "state", running: false });
  const host = makeHost({ eventsBeforeSnapshot: events });
  const view = mount(host);
  await tick(100);
  try {
    const initial = view.lastFrame() ?? "";
    assert.doesNotMatch(initial, /回看历史中/);
    const inputRow = initial.split("\n").findIndex((line) => line.includes("输入你的目标"));
    assert.ok(inputRow >= 0, `未找到输入框占位行：\n${initial}`);

    view.stdin.write("[5~"); // PageUp
    await tick(40);
    const pagedUp = view.lastFrame() ?? "";
    assert.doesNotMatch(pagedUp, /回看历史中|PageDown 回到底部/);
    assert.notEqual(pagedUp, initial);
    view.stdin.write("[6~"); // PageDown 回底
    await tick(40);
    assert.doesNotMatch(view.lastFrame() ?? "", /回看历史中/);

    // xterm SGR 滚轮：向上进入内部回看，输入框仍停在同一个绝对行；向下回到底部。
    view.stdin.write("\u001b[<64;10;10M".repeat(3));
    await tick(40);
    const scrolled = view.lastFrame() ?? "";
    assert.doesNotMatch(scrolled, /回看历史中|PageDown 回到底部/);
    assert.notEqual(scrolled, initial);
    assert.equal(
      scrolled.split("\n").findIndex((line) => line.includes("输入你的目标")),
      inputRow,
    );
    view.stdin.write("\u001b[<65;10;10M".repeat(3));
    await tick(40);
    assert.doesNotMatch(view.lastFrame() ?? "", /回看历史中/);

    // 默认 selectable 模式使用 DEC 1007：真实终端把滚轮转换成 ↑/↓，应用仍应回看。
    view.stdin.write("\u001b[A");
    await tick(40);
    const alternateScrolled = view.lastFrame() ?? "";
    assert.notEqual(alternateScrolled, initial);
    assert.equal(
      alternateScrolled.split("\n").findIndex((line) => line.includes("输入你的目标")),
      inputRow,
    );
    view.stdin.write("\u001b[B");
    await tick(40);
    assert.doesNotMatch(view.lastFrame() ?? "", /回看历史中/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: 回看时流式追加保持可见锚点，PageDown 仍可回到底部", async () => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 24; i++) {
    events.push({ type: "agent", event: { type: "text", text: `锚点回答-${i}` } });
    events.push({ type: "agent", event: { type: "done", usage: zeroUsage, turns: 1 } });
  }
  let emit: ((event: SessionEvent) => void) | undefined;
  const host = makeHost({
    eventsBeforeSnapshot: events,
    onOpen: (listener) => {
      emit = listener;
    },
  });
  const view = mount(host, { terminalSize: { rows: 18, cols: 72 } });
  await tick(120);
  try {
    view.stdin.write("\u001b[5~");
    await tick(50);
    const before = view.lastFrame() ?? "";
    const visibleBefore = before.match(/锚点回答-\d+/g) ?? [];
    assert.ok(visibleBefore.length > 0, before);

    emit?.({ type: "agent", event: { type: "text", text: "新追加的底部回答" } });
    emit?.({ type: "agent", event: { type: "done", usage: zeroUsage, turns: 1 } });
    await tick(80);
    const anchored = view.lastFrame() ?? "";
    assert.match(anchored, new RegExp(visibleBefore[0]!));
    assert.doesNotMatch(anchored, /新追加的底部回答/);

    view.stdin.write("\u001b[6~".repeat(8));
    await tick(80);
    assert.match(view.lastFrame() ?? "", /新追加的底部回答/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: 结果页 ↑/↓ 浏览 prompt 历史，越界时保持边界或空输入", async () => {
  const events: SessionEvent[] = [
    { type: "agent", event: { type: "text", text: "已有搜索结果" } },
    { type: "state", running: false },
  ];
  const sent: string[] = [];
  const host = makeHost({ eventsBeforeSnapshot: events, onSend: (text) => sent.push(text) });
  const view = mount(host);
  await tick(100);
  try {
    // 空历史时 ↑ 不显示任何内容。
    view.stdin.write("\u001b[A");
    await tick(20);
    assert.match(view.lastFrame() ?? "", /输入你的目标/);

    for (const ch of "第一条 prompt") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(30);
    for (const ch of "第二条 prompt") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(30);
    assert.deepEqual(sent, ["第一条 prompt", "第二条 prompt"]);

    view.stdin.write("\u001b[A");
    await tick(20);
    assert.match(view.lastFrame() ?? "", /第二条 prompt/);
    view.stdin.write("\u001b[A");
    await tick(20);
    assert.match(view.lastFrame() ?? "", /第一条 prompt/);
    view.stdin.write("\u001b[A"); // 已到最旧项，继续 ↑ 不越界。
    await tick(20);
    assert.match(view.lastFrame() ?? "", /第一条 prompt/);

    view.stdin.write("\u001b[B");
    await tick(20);
    assert.match(view.lastFrame() ?? "", /第二条 prompt/);
    view.stdin.write("\u001b[B"); // 越过最新项，恢复空输入。
    await tick(20);
    assert.match(view.lastFrame() ?? "", /输入你的目标/);
    view.stdin.write("\u001b[B"); // 已无更新记录，保持空白。
    await tick(20);
    assert.match(view.lastFrame() ?? "", /输入你的目标/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: 大量短结果可滚到完整历史顶部", async () => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 300; i++) {
    events.push({
      type: "agent",
      event: { type: "text", text: `短结果-${String(i).padStart(3, "0")}` },
    });
    events.push({ type: "state", running: false });
  }
  const host = makeHost({ eventsBeforeSnapshot: events });
  const view = mount(host);
  await tick(120);
  try {
    const atBottom = view.lastFrame() ?? "";
    assert.match(atBottom, /短结果-299/);
    assert.doesNotMatch(atBottom, /短结果-000/);
    const inputRow = atBottom.split("\n").findIndex((line) => line.includes("输入你的目标"));
    assert.ok(inputRow >= 0);

    // 一次连续的大幅上滚必须基于完整历史高度计算，不能卡在尾部渲染窗口的假顶部。
    view.stdin.write("\u001b[<64;10;10M".repeat(300));
    await tick(120);
    const atTop = view.lastFrame() ?? "";
    assert.match(atTop, /短结果-000/);
    assert.doesNotMatch(atTop, /短结果-299/);
    assert.equal(
      atTop.split("\n").findIndex((line) => line.includes("输入你的目标")),
      inputRow,
    );
  } finally {
    view.unmount();
  }
});

test("TUI 回归: 斜杠菜单滚轮移动高亮后 Enter 运行选中命令", async () => {
  const host = makeHost();
  const view = mount(host);
  await tick();
  try {
    // "/s" 同时匹配 status（首位）与 sessions（次位）。
    for (const ch of "/s") view.stdin.write(ch);
    await tick();
    const menu = view.lastFrame() ?? "";
    assert.match(menu, /\/status/);
    assert.match(menu, /\/sessions/);
    // 同一 chunk 内 4 次向下 + 3 次向上，净向下 1 项；覆盖触控板事件合并。
    view.stdin.write("\u001b[<65;10;10M".repeat(4) + "\u001b[<64;10;10M".repeat(3));
    await tick(20);
    view.stdin.write("\r"); // 运行高亮命令
    await tick(80);
    // 跑的是 sessions（列表标题），而不是 status。
    assert.match(view.lastFrame() ?? "", /会话列表|sessions/i);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: 单条超长回复可按行滚动，不会把输入区推出屏幕", async () => {
  const longReply = [
    "HEAD_MARK",
    ...Array.from({ length: 60 }, (_, i) => `结果行-${String(i).padStart(2, "0")}`),
    "TAIL_MARK",
  ].join("\n");
  const host = makeHost({
    eventsBeforeSnapshot: [
      { type: "agent", event: { type: "user_message", text: "长回复", queued: false } },
      { type: "agent", event: { type: "text", text: longReply } },
      { type: "state", running: false },
    ],
  });
  const view = mount(host);
  await tick(100);
  try {
    const atBottom = view.lastFrame() ?? "";
    assert.match(atBottom, /TAIL_MARK/);
    assert.doesNotMatch(atBottom, /HEAD_MARK/);
    const inputRow = atBottom.split("\n").findIndex((line) => line.includes("输入你的目标"));
    assert.ok(inputRow >= 0);

    view.stdin.write("\u001b[<64;10;10M".repeat(60));
    await tick(40);
    const atTop = view.lastFrame() ?? "";
    assert.match(atTop, /HEAD_MARK/);
    assert.doesNotMatch(atTop, /TAIL_MARK/);
    assert.equal(
      atTop.split("\n").findIndex((line) => line.includes("输入你的目标")),
      inputRow,
    );

    view.stdin.write("\u001b[<65;10;10M".repeat(60));
    await tick(40);
    const backAtBottom = view.lastFrame() ?? "";
    assert.match(backAtBottom, /TAIL_MARK/);
    assert.doesNotMatch(backAtBottom, /回看历史中/);
  } finally {
    view.unmount();
  }
});

const pickerProviders: ProviderDescriptor[] = [
  {
    id: "debug",
    name: "anicode Debug",
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

const pickerCatalog = [
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const raceProvider: ProviderDescriptor = {
  id: "race",
  name: "Race Provider",
  kind: "openai-compatible",
  protocol: "openai-chat",
  aliases: [],
  baseURL: "https://example.invalid/v1",
  apiKeyEnv: [],
  requiresApiKey: false,
  local: false,
  capabilities: { tools: true, reasoning: false },
  limits: {},
  models: [],
  catalog: [],
};

const raceCatalog = [
  {
    model: "a",
    label: "Race A",
    free: false,
    openWeight: false,
    recommended: true,
    providerId: "race",
    providerName: "Race Provider",
    spec: "race/a",
    local: false,
    requiresApiKey: false,
  },
  {
    model: "b",
    label: "Race B",
    free: false,
    openWeight: false,
    recommended: false,
    providerId: "race",
    providerName: "Race Provider",
    spec: "race/b",
    local: false,
    requiresApiKey: false,
  },
];

test("TUI 回归: 显式 /model 后发选择胜出，旧 verify 完全静默", async () => {
  const first = deferred<readonly string[]>();
  const second = deferred<readonly string[]>();
  let discoveryCall = 0;
  const created: string[] = [];
  const host = makeHost({ onCreate: (input) => created.push(input.model) });
  const view = mount(host, {
    providers: [raceProvider],
    discoverModels: async () => {
      discoveryCall++;
      if (discoveryCall === 1) return first.promise;
      if (discoveryCall === 2) return second.promise;
      return ["a", "b"];
    },
  });
  await tick(80);
  try {
    view.stdin.write("/model race/a");
    view.stdin.write("\r");
    await tick(20);
    view.stdin.write("/model race/b");
    view.stdin.write("\r");
    await tick(20);

    second.resolve(["b"]);
    await tick(120);
    assert.deepEqual(created, ["race/b"]);

    first.resolve(["a"]);
    await tick(120);
    assert.deepEqual(created, ["race/b"]);
    assert.doesNotMatch(view.lastFrame() ?? "", /race\/a.*(?:未被模型端点|无法从模型端点)/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /model 后发选择胜出，旧 verify 不得切换或写入错误会话", async () => {
  const first = deferred<readonly string[]>();
  const second = deferred<readonly string[]>();
  let discoveryCall = 0;
  const created: string[] = [];
  const host = makeHost({ onCreate: (input) => created.push(input.model) });
  const view = mount(host, {
    providers: [raceProvider],
    catalog: raceCatalog,
    discoverModels: async () => {
      discoveryCall++;
      if (discoveryCall === 1) return first.promise;
      if (discoveryCall === 2) return second.promise;
      return ["a", "b"];
    },
  });
  await tick(80);
  try {
    view.stdin.write("/model");
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /Race A/);

    view.stdin.write("\r"); // A verify pending
    await tick(20);
    view.stdin.write("\u001b[B");
    await tick(20);
    view.stdin.write("\r"); // B supersedes A
    await tick(20);
    second.resolve(["b"]);
    await tick(120);
    assert.deepEqual(created, ["race/b"]);

    first.resolve(["a"]);
    await tick(120);
    assert.deepEqual(created, ["race/b"]);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /model Esc 与重开使旧 Tab verify 完全失效", async () => {
  const stale = deferred<readonly string[]>();
  const current = deferred<readonly string[]>();
  let discoveryCall = 0;
  const host = makeHost();
  const view = mount(host, {
    providers: [raceProvider],
    catalog: raceCatalog,
    discoverModels: async () => {
      discoveryCall++;
      if (discoveryCall === 1) return stale.promise;
      if (discoveryCall === 2) return current.promise;
      return ["a", "b"];
    },
  });
  await tick(80);
  try {
    view.stdin.write("/model");
    view.stdin.write("\r");
    await tick(80);
    view.stdin.write("\t");
    await tick(20);
    view.stdin.write("\u001b");
    await tick(20);

    view.stdin.write("/model");
    view.stdin.write("\r");
    await tick(80);
    view.stdin.write("\t");
    await tick(20);

    stale.resolve(["a"]);
    await tick(80);
    assert.doesNotMatch(view.lastFrame() ?? "", /下一条消息将使用 race\/a/);

    current.resolve(["a"]);
    await tick(100);
    assert.match(view.lastFrame() ?? "", /下一条消息将使用 race\/a/);
  } finally {
    view.unmount();
  }
});

test("TUI 安全边界: 远端 host 选择 Ollama 模型绝不启动客户端 Ollama", async () => {
  let localStarts = 0;
  const created: string[] = [];
  const host = makeHost({ onCreate: (input) => created.push(input.model) });
  const view = mount(host, {
    canInspectWorkspace: false,
    discoverModels: async (providerId: string) =>
      providerId === "ollama" ? ["remote-model"] : undefined,
    ensureLocalOllama: async () => {
      localStarts++;
      return "running" as const;
    },
  });
  await tick(80);
  try {
    view.stdin.write("/model ollama/remote-model");
    view.stdin.write("\r");
    await tick(120);
    assert.equal(localStarts, 0);
    assert.deepEqual(created, ["ollama/remote-model"]);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /model 选择器键入即过滤，Enter 选中过滤后的首项", async () => {
  let created: { cwd: string; model: string } | undefined;
  const host = makeHost({ onCreate: (input) => (created = input) });
  const view = mount(host, {
    providers: pickerProviders,
    catalog: pickerCatalog,
    discoverModels: async (providerId: string) =>
      providerId === "debug"
        ? ["demo"]
        : providerId === "openrouter"
          ? ["meta-llama/llama-3.3-70b-instruct:free"]
          : undefined,
    inspectProviderCredentials: true,
  });
  await tick(80);
  try {
    for (const ch of "/model") view.stdin.write(ch);
    await tick();
    view.stdin.write("\r");
    await tick(40);
    assert.match(view.lastFrame() ?? "", /Debug Demo/);

    // 真实 PTY 可能把连续输入合成一个 data chunk；选择器仍应整块接收并过滤。
    view.stdin.write("llama");
    await tick(40);
    const filtered = view.lastFrame() ?? "";
    assert.match(filtered, /Llama 3\.3/);
    assert.doesNotMatch(filtered, /Debug Demo/);

    view.stdin.write(""); // 退格放宽过滤
    await tick(40);
    assert.match(view.lastFrame() ?? "", /Llama 3\.3/);

    for (const ch of "a") view.stdin.write(ch); // 收窄回 llama
    await tick(40);
    view.stdin.write("\r"); // 选中过滤后的首项
    await tick(120);
    assert.equal(created?.model, "openrouter/meta-llama/llama-3.3-70b-instruct:free");
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /plan 不再暴露，直接执行按未知命令处理", async () => {
  const calls: [string, string][] = [];
  const host = makeHost({
    setPermissionMode: async (sessionId, mode) => {
      calls.push([sessionId, mode]);
    },
  });
  const view = mount(host);
  await tick();
  try {
    for (const ch of "/help") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.doesNotMatch(view.lastFrame() ?? "", /\/plan/);

    for (const ch of "/plan") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /未知命令: \/plan/);
    assert.deepEqual(calls, []);
  } finally {
    view.unmount();
  }
});

test("TUI 受限工作区: Shift+Tab 不切换模式也不调用宿主", async () => {
  const calls: string[] = [];
  const host = makeHost({
    workspaceTrusted: false,
    setPermissionMode: async (_sessionId, mode) => {
      calls.push(mode);
    },
  });
  const view = mount(host, { requireWorkspaceTrust: true });
  await tick(100);
  try {
    view.stdin.write("\u001b[Z");
    await tick(60);
    const frame = view.lastFrame() ?? "";
    assert.match(frame, /受限工作区中权限模式固定，无法切换/);
    assert.doesNotMatch(frame, /\/plan|计划模式|\bplan\b/i);
    assert.deepEqual(calls, []);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: snapshot 权威模式为 bypass，状态立即同步且首次 Shift+Tab 回到普通模式", async () => {
  const calls: PermissionMode[] = [];
  const host = makeHost({
    permissionMode: "bypass",
    setPermissionMode: async (_sessionId, mode) => {
      calls.push(mode);
    },
  });
  const view = mount(host);
  await tick(80);
  try {
    assert.match(view.lastFrame() ?? "", /跳过所有授权/);
    view.stdin.write("\u001b[Z");
    await tick(60);
    assert.deepEqual(calls, ["default"]);
    assert.match(view.lastFrame() ?? "", /权限模式：普通/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: 授权卡打开时 Shift+Tab 仍可切模式且不会误裁决当前请求", async () => {
  const calls: PermissionMode[] = [];
  const answers: string[] = [];
  const host = makeHost({
    permissionMode: "default",
    pendingPermissions: [
      {
        permId: "perm_shift_tab",
        toolName: "bash",
        ruleKey: "curl -s wttr.in/Wuhu",
        risk: "medium",
      },
    ],
    setPermissionMode: async (_sessionId, mode) => {
      calls.push(mode);
    },
    onPermission: (decision) => answers.push(decision),
  });
  const view = mount(host);
  await tick(80);
  try {
    const initial = view.lastFrame() ?? "";
    assert.match(initial, /授权请求/);
    assert.match(initial, /Shift\+Tab 切模式/i);

    view.stdin.write("\u001b[Z");
    await tick(60);
    assert.deepEqual(calls, ["acceptEdits"]);
    assert.deepEqual(answers, []);
    assert.match(view.lastFrame() ?? "", /自动接受编辑/);
    assert.match(view.lastFrame() ?? "", /授权请求/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: Shift+Tab 轮换权限模式 default→acceptEdits→bypass→default 并刷新指示", async () => {
  const calls: string[] = [];
  const host = makeHost({
    setPermissionMode: async (_sessionId, mode) => {
      calls.push(mode);
    },
  });
  const view = mount(host);
  await tick();
  try {
    const SHIFT_TAB = "[Z";
    view.stdin.write(SHIFT_TAB);
    await tick(60);
    assert.match(view.lastFrame() ?? "", /自动接受编辑/);

    view.stdin.write(SHIFT_TAB);
    await tick(60);
    assert.match(view.lastFrame() ?? "", /跳过所有授权/);

    view.stdin.write(SHIFT_TAB);
    await tick(60);
    // 回到 default：给出"普通"回执（历史里保留旧回执，故只断言新回执出现 + 调用序列）。
    assert.match(view.lastFrame() ?? "", /权限模式：普通/);

    assert.deepEqual(calls, ["acceptEdits", "bypass", "default"]);
    assert.equal(calls.includes("plan"), false);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: host 不支持权限模式时 Shift+Tab 给出明确提示", async () => {
  const host = makeHost(); // 无 setPermissionMode
  const view = mount(host);
  await tick();
  try {
    view.stdin.write("[Z");
    await tick(60);
    assert.match(view.lastFrame() ?? "", /不支持运行时权限模式切换/);
  } finally {
    view.unmount();
  }
});

test("TUI 远端客户端: 宿主管理的权限模式与档位不可在本地切换", async () => {
  const modeCalls: PermissionMode[] = [];
  const profileCalls: string[] = [];
  const host = makeHost({
    workspaceTrusted: true,
    setPermissionMode: async (_sessionId, mode) => {
      modeCalls.push(mode);
    },
    setPermissionProfile: async (_sessionId, name) => {
      profileCalls.push(name);
      return "default";
    },
  });
  const view = mount(host, { requireWorkspaceTrust: true, allowPermissionControls: false });
  await tick(80);
  try {
    view.stdin.write("\u001b[Z");
    await tick(60);
    assert.match(view.lastFrame() ?? "", /权限设置由宿主管理，当前客户端无法切换/);

    for (const ch of "/profile full") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /权限档位由宿主管理，当前客户端无法切换/);
    assert.deepEqual(modeCalls, []);
    assert.deepEqual(profileCalls, []);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /profile 隐藏并拒绝只读档位，其他档位仍可切换", async () => {
  const calls: [string, string][] = [];
  const host = makeHost({
    setPermissionProfile: async (sessionId, name) => {
      calls.push([sessionId, name]);
      return name === "readonly" ? "plan" : "default";
    },
  });
  const view = mount(host);
  await tick();
  try {
    // 无参：列出可用档位
    for (const ch of "/profile") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    const list = view.lastFrame() ?? "";
    assert.match(list, /可用权限档位/);
    assert.match(list, /full/);
    assert.doesNotMatch(list, /readonly|read-only|→ plan|计划模式/i);

    // 即使知道内部档位名称，也必须在调用宿主前拒绝。
    for (const ch of "/profile readonly") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /TUI 不提供只读权限档位/);
    assert.deepEqual(calls, []);

    for (const ch of "/profile full") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /已切换权限档位：full/);
    assert.deepEqual(calls, [["s_reg", "full"]]);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: host 不支持档位时 /profile 明确提示", async () => {
  const host = makeHost();
  const view = mount(host);
  await tick();
  try {
    for (const ch of "/profile full") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /不支持运行时权限档位/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /model <spec> once 仅覆盖下一条消息的模型，随后自动还原", async () => {
  const host = makeHost();
  const sendLog = (host as SessionHost & { sendLog: { text: string; model?: string }[] }).sendLog;
  const view = mount(host, {
    discoverModels: async (providerId: string) => (providerId === "alt" ? ["fast"] : undefined),
  });
  await tick();
  try {
    for (const ch of "/model alt/fast once") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    const hint = view.lastFrame() ?? "";
    assert.match(hint, /下一条消息将使用 alt\/fast/);
    assert.match(hint, /下一条: alt\/fast/); // 输入区上方的待用指示

    for (const ch of "第一条") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(100);
    for (const ch of "第二条") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(100);

    assert.deepEqual(sendLog, [
      { text: "第一条", model: "alt/fast" }, // 覆盖仅一次
      { text: "第二条" }, // 自动还原
    ]);
    assert.doesNotMatch(view.lastFrame() ?? "", /下一条: alt\/fast/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /undo 把参数透传给 host.undo；失败时显示错误", async () => {
  const undoCalls: [string, string | undefined][] = [];
  const okHost = makeHost({
    undo: async (sessionId, arg) => {
      undoCalls.push([sessionId, arg]);
      return { restored: 2, deleted: 1 };
    },
  });
  const view = mount(okHost);
  await tick();
  try {
    for (const ch of "/undo 3") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.deepEqual(undoCalls, [["s_reg", "3"]]);
  } finally {
    view.unmount();
  }

  const badHost = makeHost({
    undo: async () => {
      throw new Error("没有可回滚的快照");
    },
  });
  const view2 = mount(badHost);
  await tick();
  try {
    for (const ch of "/undo") view2.stdin.write(ch);
    view2.stdin.write("\r");
    await tick(80);
    assert.match(view2.lastFrame() ?? "", /撤销失败.*没有可回滚的快照/);
  } finally {
    view2.unmount();
  }
});
