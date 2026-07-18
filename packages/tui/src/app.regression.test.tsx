/**
 * TUI 交互回归测试：把近期提交沉淀的行为固化住——输入编辑快捷键（Ctrl+E/U/K）、
 * PageUp/PageDown 回看、斜杠菜单 ↑/↓ 选择、/model 选择器搜索过滤、/plan 计划模式、
 * /undo 接线。全离线（假 SessionHost），防止下次重构 app.tsx 悄悄打碎这些行为。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import type { ProviderDescriptor, SessionEvent, SessionHost } from "@anicode/core";
import { App, parseMouseInput } from "./app.js";

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

const zeroUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

test("TUI 回归: SGR 左键点击解析坐标，释放事件不重复触发", () => {
  assert.deepEqual(parseMouseInput("\u001b[<0;20;10M\u001b[<0;20;10m"), {
    wheelDelta: 0,
    leftClick: { column: 20, row: 10 },
  });
  assert.deepEqual(parseMouseInput("\u001b[<0;20;10m"), { wheelDelta: 0 });
});

/** 最小离线 host：可注入历史事件与 undo/setPermissionMode 行为。 */
function makeHost(
  options: {
    eventsBeforeSnapshot?: SessionEvent[];
    onSend?: (text: string) => void;
    onCreate?: (input: { cwd: string; model: string; title?: string }) => void;
    undo?: (sessionId: string, arg?: string) => Promise<{ restored: number; deleted: number }>;
    setPermissionMode?: (sessionId: string, mode: string) => Promise<void>;
    setPermissionProfile?: (sessionId: string, name: string) => Promise<"plan" | "default">;
  } = {},
): SessionHost {
  const meta = {
    id: "s_reg",
    cwd: "/reg/project",
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
      for (const event of options.eventsBeforeSnapshot ?? []) listener(event);
      return {
        snapshot: {
          meta,
          messages: [],
          usage: zeroUsage,
          running: false,
          pendingPermissions: [],
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
    async answerPermission() {
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

test("TUI 回归: PageUp 进入回看（有指示条），PageDown 回到底部", async () => {
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
    assert.doesNotMatch(view.lastFrame() ?? "", /回看历史中/);
    view.stdin.write("[5~"); // PageUp
    await tick(40);
    assert.match(view.lastFrame() ?? "", /回看历史中/);
    view.stdin.write("[6~"); // PageDown 回底
    await tick(40);
    assert.doesNotMatch(view.lastFrame() ?? "", /回看历史中/);
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

test("TUI 回归: /model 选择器键入即过滤，Enter 选中过滤后的首项", async () => {
  let created: { cwd: string; model: string } | undefined;
  const host = makeHost({ onCreate: (input) => (created = input) });
  const view = mount(host, {
    providers: pickerProviders,
    catalog: pickerCatalog,
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

test("TUI 回归: /plan 开关计划模式——调用 setPermissionMode 并显示只读指示", async () => {
  const calls: [string, string][] = [];
  const host = makeHost({
    setPermissionMode: async (sessionId, mode) => {
      calls.push([sessionId, mode]);
    },
  });
  const view = mount(host);
  await tick();
  try {
    for (const ch of "/plan on") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    const on = view.lastFrame() ?? "";
    assert.match(on, /计划模式/);
    assert.match(on, /只读/);
    assert.deepEqual(calls, [["s_reg", "plan"]]);

    for (const ch of "/plan off") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /已退出计划模式/);
    assert.deepEqual(calls, [
      ["s_reg", "plan"],
      ["s_reg", "default"],
    ]);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: host 不支持运行时计划模式时 /plan 给出明确提示", async () => {
  const host = makeHost(); // 无 setPermissionMode
  const view = mount(host);
  await tick();
  try {
    for (const ch of "/plan") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    assert.match(view.lastFrame() ?? "", /不支持运行时计划模式/);
  } finally {
    view.unmount();
  }
});

test("TUI 回归: /profile 无参列档位，带参切换并同步只读指示", async () => {
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
    assert.match(list, /readonly/);
    assert.match(list, /full/);

    // 切 readonly → 模式 plan → 只读指示出现
    for (const ch of "/profile readonly") view.stdin.write(ch);
    view.stdin.write("\r");
    await tick(80);
    const on = view.lastFrame() ?? "";
    assert.match(on, /已切换权限档位：readonly/);
    assert.match(on, /计划模式|只读/);
    assert.deepEqual(calls, [["s_reg", "readonly"]]);
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
  const view = mount(host);
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
