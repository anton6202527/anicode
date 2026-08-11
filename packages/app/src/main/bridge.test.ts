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
import {
  registerOpenAICompatibleProvider,
  registerProvider,
  type CredentialBroker,
  type Provider,
  type SecretBackend,
} from "@anicode/core";
import type {
  CloudAuthStatus,
  EventEnvelope,
  ModelRow,
  PluginEntry,
  UserModel,
} from "../shared/api.js";
import { Bridge, type BridgeOptions } from "./bridge.js";

type Handler = (event: { sender: FakeSender }, ...args: unknown[]) => unknown;

function memoryCredentialEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ANICODE_CREDENTIAL_BACKEND: "memory",
    ANICODE_DISABLE_OS_KEYCHAIN: "1",
  };
}

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

async function tempBridge(
  isTrustedSender: BridgeOptions["isTrustedSender"] = () => true,
): Promise<{ bridge: Bridge; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-app-"));
  const bridge = new Bridge({
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    pluginsFile: path.join(dir, "plugins.json"),
    modelsFile: path.join(dir, "models.json"),
    appName: "anicode",
    appVersion: "0.0.1-test",
    env: memoryCredentialEnv(),
    isTrustedSender,
  });
  return { bridge, dir };
}

test("Bridge.create registers an async Keychain backend without reading it at startup", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-app-async-keychain-"));
  let reads = 0;
  let closes = 0;
  const backend: SecretBackend & { close(): void } = {
    kind: "fake-async-keychain",
    credentialNamespace: "fake-async-keychain:test",
    async get() {
      reads++;
      return "must-not-read-at-startup";
    },
    async put() {},
    async delete() {
      return true;
    },
    close() {
      closes++;
    },
  };
  const bridge = await Bridge.create({
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    pluginsFile: path.join(dir, "plugins.json"),
    modelsFile: path.join(dir, "models.json"),
    appName: "anicode",
    appVersion: "0.0.1-test",
    env: {
      ANICODE_CREDENTIAL_BACKEND: "keychain",
      ANICODE_CREDENTIAL_KEYS: "OPENAI_API_KEY",
    },
    credentialBackend: backend,
    isTrustedSender: () => true,
  });
  try {
    assert.equal(reads, 0);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.equal(closes, 1);
});

test("Bridge: rejects IPC from an untrusted renderer", async () => {
  const { bridge } = await tempBridge(() => false);
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  try {
    await assert.rejects(() => invoke("app:info", new FakeSender()), /untrusted IPC sender/);
  } finally {
    await bridge.dispose();
  }
});

test("Bridge: 创建会话 → 订阅 → 发送，事件经 sender 回流（走 debug/demo，离线）", async () => {
  const { bridge, dir } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();

  try {
    const meta = (await invoke("host:createSession", sender, {
      cwd: dir,
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
    await bridge.dispose();
  }
});

test("Bridge: 高频文本增量按帧合并，且在 done 前保持顺序", async () => {
  const providerId = "bridge-burst-stream";
  registerProvider(providerId, (): Provider => ({
    name: providerId,
    async *stream(request) {
      const text = "x".repeat(200);
      for (const char of text) yield { type: "text_delta", text: char };
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text }] },
        usage: {
          inputTokens: request.messages.length,
          outputTokens: text.length,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  }));
  const { bridge, dir } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();

  try {
    const meta = (await invoke("host:createSession", sender, {
      cwd: dir,
      model: `${providerId}/test`,
    })) as { id: string };
    await invoke("host:open", sender, meta.id);
    await invoke("host:send", sender, meta.id, "burst");

    const agentEvents = sender.received.flatMap((envelope) =>
      envelope.event.type === "agent" ? [envelope.event.event] : [],
    );
    const textEvents = agentEvents.filter((event) => event.type === "text");
    assert.equal(textEvents.length, 1, "200 个同步 delta 应合并成一个 IPC 文本事件");
    assert.equal(textEvents[0]?.type === "text" ? textEvents[0].text : "", "x".repeat(200));
    assert.ok(
      agentEvents.findIndex((event) => event.type === "text") <
        agentEvents.findIndex((event) => event.type === "done"),
      "合并文本必须在 done 边界前送达",
    );
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Bridge: 模型目录标注凭证就绪状态，debug/demo 免 key 可用", async () => {
  registerOpenAICompatibleProvider({
    id: "bridge-test-cloud",
    name: "Bridge Test Cloud",
    baseURL: "https://bridge-test.invalid/v1",
    apiKeyEnv: "ANICODE_BRIDGE_TEST_MISSING_KEY",
    catalog: [{ model: "requires-key" }],
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-app-catalog-"));
  const env = memoryCredentialEnv();
  delete env.ANICODE_BRIDGE_TEST_MISSING_KEY;
  const bridge = new Bridge({
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    pluginsFile: path.join(dir, "plugins.json"),
    modelsFile: path.join(dir, "models.json"),
    appName: "anicode",
    appVersion: "0.0.1-test",
    isTrustedSender: () => true,
    env,
  });
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const rows = (await invoke("meta:catalog", sender)) as ModelRow[];
    const demo = rows.find((r) => r.spec === "debug/demo");
    assert.ok(demo, "目录缺少 debug/demo");
    assert.equal(demo?.ready, true);
    const cloud = rows.find((r) => r.spec === "bridge-test-cloud/requires-key");
    assert.ok(cloud, "目录缺少测试云端模型");
    assert.equal(cloud?.ready, false);
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
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
    env: memoryCredentialEnv(),
    isTrustedSender: () => true,
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
    await bridge.dispose();
  }
});

test("Bridge: 未显式指定默认模型时使用自身 runtimeStack provider 状态", async () => {
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-app-bound-default-"));
  const env = memoryCredentialEnv();
  env.DEEPSEEK_API_KEY = "sentinel-app-deepseek";
  const bridge = new Bridge({
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    pluginsFile: path.join(dir, "plugins.json"),
    modelsFile: path.join(dir, "models.json"),
    appName: "anicode",
    appVersion: "0.0.1-test",
    env,
    isTrustedSender: () => true,
  });
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  try {
    const info = (await invoke("app:info", new FakeSender())) as { defaultModel: string };
    assert.equal(info.defaultModel, "deepseek/deepseek-v4-flash");
    assert.equal(env.DEEPSEEK_API_KEY, undefined, "runtime stack owns the captured credential");
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
});

test("Bridge: 登录后云端模型优先，auth IPC 只返回脱敏状态", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-app-cloud-auth-"));
  let status: CloudAuthStatus = {
    state: "signed_in",
    signedIn: true,
    user: { id: "user-1", email: "user@example.com" },
    expiresAt: "2099-01-01T00:00:00.000Z",
    accessToken: "must-never-cross-ipc",
    refreshToken: "must-never-cross-ipc",
  } as CloudAuthStatus;
  let failSignIn = false;
  let closed = 0;
  const cloudAuth: NonNullable<BridgeOptions["cloudAuth"]> = {
    attachBroker(_broker: CredentialBroker) {},
    status: () => status,
    async signIn() {
      if (failSignIn) {
        throw Object.assign(new Error("upstream leaked super-secret-token"), {
          code: "temporarily_unavailable",
        });
      }
      return status;
    },
    async signOut() {
      status = { state: "signed_out", signedIn: false };
      return status;
    },
    close() {
      closed++;
    },
  };
  const bridge = new Bridge({
    cwd: dir,
    sessionsDir: path.join(dir, "sessions"),
    pluginsFile: path.join(dir, "plugins.json"),
    modelsFile: path.join(dir, "models.json"),
    appName: "anicode",
    appVersion: "0.0.1-test",
    env: memoryCredentialEnv(),
    isTrustedSender: () => true,
    defaultModel: "custom/local-model",
    cloudDefaultModel: "anicode-cloud/deepseek-v4-flash",
    cloudAuth,
  });
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const info = (await invoke("app:info", sender)) as { defaultModel: string };
    assert.equal(info.defaultModel, "anicode-cloud/deepseek-v4-flash");

    const auth = (await invoke("auth:status", sender)) as CloudAuthStatus;
    assert.deepEqual(auth, {
      state: "signed_in",
      signedIn: true,
      user: { id: "user-1", email: "user@example.com" },
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
    assert.doesNotMatch(JSON.stringify(auth), /access|refresh|token|secret/iu);

    failSignIn = true;
    await assert.rejects(
      () => invoke("auth:signIn", sender, "user@example.com", "correct-password"),
      (error: Error) => {
        assert.match(error.message, /AniCode Cloud/iu);
        assert.doesNotMatch(error.message, /super-secret-token/iu);
        return true;
      },
    );

    await invoke("auth:signOut", sender);
    const signedOutInfo = (await invoke("app:info", sender)) as { defaultModel: string };
    assert.equal(signedOutInfo.defaultModel, "custom/local-model");
  } finally {
    await bridge.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
  assert.equal(closed, 1);
});

test("Bridge: deleteSession 从列表移除会话", async () => {
  const { bridge, dir } = await tempBridge();
  const { ipcMain, invoke } = fakeIpc();
  bridge.register(ipcMain);
  const sender = new FakeSender();
  try {
    const a = (await invoke("host:createSession", sender, {
      cwd: dir,
      model: "debug/demo",
    })) as { id: string };
    const b = (await invoke("host:createSession", sender, {
      cwd: dir,
      model: "debug/demo",
    })) as { id: string };
    let list = (await invoke("host:listSessions", sender)) as { id: string }[];
    assert.equal(list.length, 2);

    await invoke("host:deleteSession", sender, b.id);
    list = (await invoke("host:listSessions", sender)) as { id: string }[];
    assert.equal(list.length, 1);
    assert.equal(list[0]?.id, a.id);
  } finally {
    await bridge.dispose();
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
      cwd: dir,
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
      env: memoryCredentialEnv(),
      isTrustedSender: () => true,
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
    await reopened.dispose();
  } finally {
    await bridge.dispose();
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
      env: memoryCredentialEnv(),
      isTrustedSender: () => true,
    });
    await reopened.init();
    const ipc2 = fakeIpc();
    reopened.register(ipc2.ipcMain);
    const persisted = (await ipc2.invoke("plugins:list", sender)) as PluginEntry[];
    assert.equal(persisted.find((p) => p.id === "skill.fs.mytool")?.enabled, false);
    await reopened.dispose();
  } finally {
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    await bridge.dispose();
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
    const github = initial.find((p) => p.id === "mcp.github");
    assert.equal(github?.enabled, false, "非内建插件应默认停用");

    // 启用一个 MCP 插件、停用一个内建插件，均应持久化。
    await invoke("plugins:setEnabled", sender, "mcp.github", true);
    const after = (await invoke("plugins:setEnabled", sender, "core.bash", false)) as PluginEntry[];
    assert.equal(after.find((p) => p.id === "mcp.github")?.enabled, true);
    assert.equal(after.find((p) => p.id === "core.bash")?.enabled, false);

    // 新建 Bridge 从同一文件回读，状态应保留。
    const reopened = new Bridge({
      cwd: dir,
      sessionsDir: path.join(dir, "sessions"),
      pluginsFile: path.join(dir, "plugins.json"),
      modelsFile: path.join(dir, "models.json"),
      appName: "anicode",
      appVersion: "0.0.1-test",
      env: memoryCredentialEnv(),
      isTrustedSender: () => true,
    });
    await reopened.init();
    const ipc2 = fakeIpc();
    reopened.register(ipc2.ipcMain);
    const persisted = (await ipc2.invoke("plugins:list", sender)) as PluginEntry[];
    assert.equal(persisted.find((p) => p.id === "mcp.github")?.enabled, true);
    assert.equal(persisted.find((p) => p.id === "core.bash")?.enabled, false);
    await reopened.dispose();
  } finally {
    await bridge.dispose();
  }
});
