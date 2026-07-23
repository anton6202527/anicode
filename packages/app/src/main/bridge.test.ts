/**
 * Bridge 冒烟测试：用假的 ipcMain / sender 驱动主进程侧的完整链路，全离线。
 * Bridge 只 import type 'electron'（运行时无 electron 依赖），故可在 node:test 下直接跑。
 * 覆盖：会话创建 → 订阅 → 发送 → 事件回流；模型目录就绪状态；插件启用持久化。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IpcMain } from "electron";
import type { EventEnvelope, ModelRow, PluginEntry, UserModel } from "../shared/api.js";
import { Bridge } from "./bridge.js";

type Handler = (event: { sender: FakeSender }, ...args: unknown[]) => unknown;

class FakeSender {
  readonly received: EventEnvelope[] = [];
  isDestroyed(): boolean {
    return false;
  }
  send(_channel: string, payload: EventEnvelope): void {
    this.received.push(payload);
  }
  once(_event: string, _cb: () => void): void {}
}

function fakeIpc(): {
  ipcMain: IpcMain;
  invoke: (channel: string, sender: FakeSender, ...args: unknown[]) => Promise<unknown>;
} {
  const handlers = new Map<string, Handler>();
  const ipcMain = {
    handle(channel: string, handler: Handler) {
      handlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  const invoke = async (channel: string, sender: FakeSender, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`未注册的 channel: ${channel}`);
    return handler({ sender }, ...args);
  };
  return { ipcMain, invoke };
}

async function tempBridge(): Promise<{ bridge: Bridge; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-app-"));
  const bridge = new Bridge({
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    pluginsFile: path.join(dir, "plugins.json"),
    modelsFile: path.join(dir, "models.json"),
    appName: "anicode",
    appVersion: "0.0.1-test",
  });
  return { bridge, dir };
}

test("Bridge: 创建会话 → 订阅 → 发送，事件经 sender 回流（走 debug/demo，离线）", async () => {
  const { bridge } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();

  try {
    const meta = (await invoke("host:createSession", sender, {
      cwd: process.cwd(),
      model: "debug/demo",
    })) as {
      id: string;
      model: string;
    };
    assert.equal(meta.model, "debug/demo");

    const opened = (await invoke("host:open", sender, meta.id)) as {
      subId: string;
      snapshot: { meta: { id: string } };
    };
    assert.ok(opened.subId);
    assert.equal(opened.snapshot.meta.id, meta.id);

    await invoke("host:send", sender, meta.id, "你好");

    // 事件应带上正确的 subId，并包含流式文本与结束。
    assert.ok(sender.received.length > 0, "sender 未收到任何事件");
    assert.ok(
      sender.received.every((e) => e.subId === opened.subId),
      "事件 subId 不匹配",
    );
    const agentEvents = sender.received.filter((e) => e.event.type === "agent").map((e) => e.event);
    const kinds = new Set(agentEvents.map((e) => (e.type === "agent" ? e.event.type : "")));
    assert.ok(kinds.has("text"), "缺少流式 text 事件");
    assert.ok(kinds.has("done"), "缺少 done 事件");
  } finally {
    bridge.dispose();
  }
});

test("Bridge: 模型目录标注凭证就绪状态，debug/demo 免 key 可用", async () => {
  const { bridge } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const rows = (await invoke("meta:catalog", sender)) as ModelRow[];
    const demo = rows.find((r) => r.spec === "debug/demo");
    assert.ok(demo, "目录缺少 debug/demo");
    assert.equal(demo?.ready, true);
    // 缺 key 的云端模型应标为未就绪（测试环境通常未配置 DeepSeek key）。
    const cloud = rows.find((r) => r.spec.startsWith("deepseek/") && r.requiresApiKey);
    if (cloud && !process.env["DEEPSEEK_API_KEY"]) assert.equal(cloud.ready, false);
  } finally {
    bridge.dispose();
  }
});

test("Bridge: 配置 custom/<model> 时可创建首个会话", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-app-custom-"));
  const bridge = new Bridge({
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    pluginsFile: path.join(dir, "plugins.json"),
    modelsFile: path.join(dir, "models.json"),
    appName: "anicode",
    appVersion: "0.0.1-test",
    defaultModel: "custom/my-model",
  });
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const info = (await invoke("app:info", sender)) as { defaultModel: string };
    assert.equal(info.defaultModel, "custom/my-model");

    const session = (await invoke("host:createSession", sender, {
      cwd: dir,
      model: info.defaultModel,
    })) as { model: string };
    assert.equal(session.model, "custom/my-model");
  } finally {
    bridge.dispose();
  }
});

test("Bridge: deleteSession 从列表移除会话", async () => {
  const { bridge } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const a = (await invoke("host:createSession", sender, {
      cwd: process.cwd(),
      model: "debug/demo",
    })) as { id: string };
    const b = (await invoke("host:createSession", sender, {
      cwd: process.cwd(),
      model: "debug/demo",
    })) as { id: string };
    let list = (await invoke("host:listSessions", sender)) as { id: string }[];
    assert.equal(list.length, 2);

    await invoke("host:deleteSession", sender, b.id);
    list = (await invoke("host:listSessions", sender)) as { id: string }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, a.id);
  } finally {
    bridge.dispose();
  }
});

test("Bridge: 自定义模型进入目录、可被 createProvider 解析、可移除并持久化", async () => {
  const { bridge, dir } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const model: UserModel = {
      provider: "debug",
      model: "my-coder",
      label: "我的本地模型",
      free: true,
      openWeight: true,
    };
    const rows = (await invoke("meta:addUserModel", sender, model)) as ModelRow[];
    const added = rows.find((r) => r.spec === "debug/my-coder");
    assert.ok(added, "自定义模型应出现在目录里");
    assert.equal(added?.source, "user");
    assert.equal(added?.free, true);

    // 该 spec 能真正建会话（provider 存在，model 自由，免 key）。
    const meta = (await invoke("host:createSession", sender, {
      cwd: process.cwd(),
      model: "debug/my-coder",
    })) as {
      model: string;
    };
    assert.equal(meta.model, "debug/my-coder");

    // 未知 provider 应被拒绝。
    await assert.rejects(() =>
      invoke("meta:addUserModel", sender, { provider: "nope", model: "x" }),
    );

    // 持久化：新 Bridge 从 models.json 回读。
    const reopened = new Bridge({
      cwd: dir,
      sessionsDir: path.join(dir, "sessions"),
      pluginsFile: path.join(dir, "plugins.json"),
      modelsFile: path.join(dir, "models.json"),
      appName: "anicode",
      appVersion: "0.0.1-test",
    });
    const ipc2 = fakeIpc();
    reopened.register(ipc2.ipcMain);
    const persisted = (await ipc2.invoke("meta:userModels", sender)) as UserModel[];
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.model, "my-coder");

    // 移除后目录不再包含它。
    const afterRemove = (await ipc2.invoke(
      "meta:removeUserModel",
      sender,
      "debug/my-coder",
    )) as ModelRow[];
    assert.ok(!afterRemove.some((r) => r.spec === "debug/my-coder"));
    reopened.dispose();
  } finally {
    bridge.dispose();
  }
});

test("Bridge: 自动发现的文件系统技能进入市场、默认启用、可关闭并持久化", async () => {
  const { bridge, dir } = await tempBridge();
  // 隔离 HOME，避免机器上真实的全局技能干扰断言。
  const home = path.join(dir, "home");
  const oldHome = process.env["HOME"];
  process.env["HOME"] = home;
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    // 项目级技能：<cwd>/.claude/skills/mytool/SKILL.md（声明缺失的 bin → 不可用）。
    const skillDir = path.join(dir, ".claude", "skills", "mytool");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: mytool\ndescription: 项目技能\nmetadata:\n  requires:\n    bins: [anicode-absent-bin]\n---\nbody",
      "utf8",
    );

    await bridge.init();
    const list = (await invoke("plugins:list", sender)) as PluginEntry[];
    const skill = list.find((p) => p.id === "skill.fs.mytool");
    assert.ok(skill, "文件系统技能应出现在市场里");
    assert.equal(skill?.category, "skill");
    assert.equal(skill?.source, "filesystem");
    assert.equal(skill?.enabled, true, "技能默认启用");
    assert.equal(skill?.available, false, "缺依赖时标为不可用");
    assert.deepEqual(skill?.requiresBins, ["anicode-absent-bin"]);

    // 关闭它并回读：状态持久化。
    const after = (await invoke(
      "plugins:setEnabled",
      sender,
      "skill.fs.mytool",
      false,
    )) as PluginEntry[];
    assert.equal(after.find((p) => p.id === "skill.fs.mytool")?.enabled, false);

    const reopened = new Bridge({
      cwd: dir,
      sessionsDir: path.join(dir, "sessions"),
      pluginsFile: path.join(dir, "plugins.json"),
      modelsFile: path.join(dir, "models.json"),
      appName: "anicode",
      appVersion: "0.0.1-test",
    });
    await reopened.init();
    const ipc2 = fakeIpc();
    reopened.register(ipc2.ipcMain);
    const persisted = (await ipc2.invoke("plugins:list", sender)) as PluginEntry[];
    assert.equal(persisted.find((p) => p.id === "skill.fs.mytool")?.enabled, false);
    reopened.dispose();
  } finally {
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    bridge.dispose();
  }
});

test("Bridge: 插件默认启用内建项，开关状态写盘并回读", async () => {
  const { bridge, dir } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const initial = (await invoke("plugins:list", sender)) as PluginEntry[];
    const bash = initial.find((p) => p.id === "core.bash");
    assert.equal(bash?.enabled, true, "内建插件应默认启用");
    const websearch = initial.find((p) => p.id === "mcp.websearch");
    assert.equal(websearch?.enabled, false, "非内建插件应默认停用");

    // 启用一个 MCP 插件、停用一个内建插件，均应持久化。
    await invoke("plugins:setEnabled", sender, "mcp.websearch", true);
    const after = (await invoke("plugins:setEnabled", sender, "core.bash", false)) as PluginEntry[];
    assert.equal(after.find((p) => p.id === "mcp.websearch")?.enabled, true);
    assert.equal(after.find((p) => p.id === "core.bash")?.enabled, false);

    // 新建 Bridge 从同一文件回读，状态应保留。
    const reopened = new Bridge({
      cwd: dir,
      sessionsDir: path.join(dir, "sessions"),
      pluginsFile: path.join(dir, "plugins.json"),
      modelsFile: path.join(dir, "models.json"),
      appName: "anicode",
      appVersion: "0.0.1-test",
    });
    await reopened.init();
    const ipc2 = fakeIpc();
    reopened.register(ipc2.ipcMain);
    const persisted = (await ipc2.invoke("plugins:list", sender)) as PluginEntry[];
    assert.equal(persisted.find((p) => p.id === "mcp.websearch")?.enabled, true);
    assert.equal(persisted.find((p) => p.id === "core.bash")?.enabled, false);
    reopened.dispose();
  } finally {
    bridge.dispose();
  }
});
