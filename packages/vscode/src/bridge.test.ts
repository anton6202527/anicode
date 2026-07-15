/**
 * ChatBridge 冒烟测试：真实 SessionManager（debug/demo）+ 假 post，驱动完整链路，全离线。
 * ChatBridge 不依赖 vscode，故可在 node:test 下直接跑。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, SessionStore } from "@anicode/core";
import { buildManager, resolveConfiguredProvider } from "./host.js";
import { ChatBridge } from "./bridge.js";
import type { HostToWebview } from "./protocol.js";

async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-vsc-"));
  const manager = buildManager(path.join(dir, "sessions"));
  const posted: HostToWebview[] = [];
  const bridge = new ChatBridge(manager, dir, "debug/demo", (m) => posted.push(m));
  return { dir, manager, posted, bridge };
}

test("ChatBridge: ready 建默认会话并回发 reset 快照", async () => {
  const { manager, posted, bridge } = await setup();
  try {
    await bridge.handle({ type: "ready" });
    const reset = posted.find((m) => m.type === "reset");
    assert.ok(reset, "应回发 reset");
    assert.equal(reset!.type === "reset" && reset.info.model, "debug/demo");
    assert.ok(bridge.sessionId, "应有活动会话");
  } finally {
    bridge.dispose();
    manager.dispose();
  }
});

test("ChatBridge: send 驱动回合，事件回流并按首句自动命名", async () => {
  const { manager, posted, bridge } = await setup();
  try {
    await bridge.handle({ type: "ready" });
    posted.length = 0;
    await bridge.handle({ type: "send", text: "帮我看看这个 bug" });

    const events = posted.filter((m) => m.type === "event").map((m) => (m.type === "event" ? m.event : null));
    const agentKinds = new Set(events.map((e) => (e && e.type === "agent" ? e.event.type : "")));
    assert.ok(agentKinds.has("text"), "缺少流式 text");
    assert.ok(agentKinds.has("done"), "缺少 done");

    // 首条消息 → 自动标题。
    const listed = await manager.listSessions();
    assert.equal(listed[0]?.title, "帮我看看这个 bug");
  } finally {
    bridge.dispose();
    manager.dispose();
  }
});

test("ChatBridge: switchModel 换到新会话，resume 可回到旧会话", async () => {
  const { manager, posted, bridge } = await setup();
  try {
    await bridge.handle({ type: "ready" });
    const firstId = bridge.sessionId!;
    posted.length = 0;

    await bridge.switchModel("debug/demo");
    const secondId = bridge.sessionId!;
    assert.notEqual(secondId, firstId, "切模型应换新会话");
    assert.ok(posted.some((m) => m.type === "reset"));

    posted.length = 0;
    await bridge.resume(firstId);
    assert.equal(bridge.sessionId, firstId);
    const reset = posted.find((m) => m.type === "reset");
    assert.ok(reset && reset.type === "reset");
    assert.equal(reset.info.id, firstId);
  } finally {
    bridge.dispose();
    manager.dispose();
  }
});

test("ChatBridge: write 工具成功后回发 fileChange 预览", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-vsc-"));
  // auto 权限：!write 无需人工确认即可执行，便于验证 fileChange。
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: resolveConfiguredProvider,
    permission: { mode: "auto" },
  });
  const posted: HostToWebview[] = [];
  const bridge = new ChatBridge(manager, dir, "debug/demo", (m) => posted.push(m));
  try {
    await bridge.handle({ type: "ready" });
    posted.length = 0;
    await bridge.handle({ type: "send", text: "!write" });

    const fc = posted.find((m) => m.type === "fileChange");
    assert.ok(fc && fc.type === "fileChange", "应回发 fileChange");
    assert.equal(fc.change.kind, "write");
    assert.equal(fc.change.path, ".anicode-debug.txt");
    assert.ok(fc.change.added > 0);
  } finally {
    bridge.dispose();
    manager.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ChatBridge: 切到缺凭证的云端模型时回发 error，不抛出", async () => {
  const prev = process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_API_KEY"];
  const { manager, posted, bridge } = await setup();
  try {
    await bridge.handle({ type: "ready" });
    posted.length = 0;
    await bridge.switchModel("openai/gpt-nonexistent");
    assert.ok(posted.some((m) => m.type === "error"), "应回发 error 消息");
  } finally {
    bridge.dispose();
    manager.dispose();
    if (prev !== undefined) process.env["OPENAI_API_KEY"] = prev;
  }
});
