/**
 * PluginRuntime 测试：验证「启用的插件」真正决定 agent 拿到的工具集，全离线。
 * MCP 连接器被注入成假的，因此无需真的 spawn npx。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credentialBrokerFromEnv,
  type McpClient,
  type McpServerConfig,
  type Tool,
} from "@anicode/core";
import { PluginRuntime, type McpConnector } from "./plugin-runtime.js";

function fakeTool(name: string): Tool {
  return {
    readOnly: false,
    def: { name, description: `fake ${name}`, parameters: { type: "object", properties: {} } },
    ruleKey: () => name,
    async run() {
      return "ok";
    },
  };
}

/** 记录连接调用与关闭次数的假连接器。 */
function fakeConnector(): { connect: McpConnector; calls: McpServerConfig[][]; closed: number } {
  const state = { calls: [] as McpServerConfig[][], closed: 0 };
  const connect: McpConnector = async (configs) => {
    state.calls.push(configs);
    const client = { close: () => void state.closed++ } as unknown as McpClient;
    const tools = configs.map((c) => fakeTool(`${c.name}__do`));
    return { tools, clients: [client] };
  };
  return {
    connect,
    calls: state.calls,
    get closed() {
      return state.closed;
    },
  };
}

test("PluginRuntime: 默认启用内建工具，工具集含全部默认工具", async () => {
  const rt = new PluginRuntime(fakeConnector().connect, {});
  await rt.setState([]);
  const names = rt.buildToolRegistry().names();
  for (const t of ["read", "write", "edit", "glob", "grep", "bash", "todo_write"]) {
    assert.ok(names.includes(t), `缺少默认工具 ${t}`);
  }
});

test("PluginRuntime: 停用内建工具插件会从工具集移除对应工具", async () => {
  const rt = new PluginRuntime(fakeConnector().connect, {});
  // 停用 core.bash（!id 记录停用）与 core.filesystem。
  await rt.setState(["!core.bash", "!core.filesystem"]);
  const names = rt.buildToolRegistry().names();
  assert.ok(!names.includes("bash"), "bash 应被移除");
  assert.ok(!names.includes("read"), "read 应随文件工具被移除");
  assert.ok(names.includes("todo_write"), "未停用的 todo 应保留");
});

test("PluginRuntime: 启用无需凭证的 MCP 会连接并注入其工具", async () => {
  const fake = fakeConnector();
  const rt = new PluginRuntime(fake.connect, {});
  await rt.setState(["mcp.playwright"]);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0]![0]!.name, "playwright");
  const names = rt.buildToolRegistry().names();
  assert.ok(names.includes("playwright__do"), "应注入 MCP 工具");
  const status = rt.entriesWithStatus().find((e) => e.id === "mcp.playwright")?.runtime;
  assert.equal(status?.connected, true);
  assert.equal(status?.toolCount, 1);
});

test("PluginRuntime: 缺环境变量的 MCP 不连接，状态标记缺失凭证", async () => {
  const fake = fakeConnector();
  const rt = new PluginRuntime(fake.connect, {}); // 无 GITHUB_TOKEN
  await rt.setState(["mcp.github"]);
  assert.equal(fake.calls.length, 0, "缺凭证不应尝试连接");
  assert.ok(
    !rt
      .buildToolRegistry()
      .names()
      .some((n) => n.startsWith("github__")),
  );
  const status = rt.entriesWithStatus().find((e) => e.id === "mcp.github")?.runtime;
  assert.equal(status?.connected, false);
  assert.match(status?.error ?? "", /GITHUB_TOKEN/);
});

test("PluginRuntime: 远程 MCP 凭证只以 Broker 引用交给连接器", async () => {
  const fake = fakeConnector();
  const env = { GITHUB_TOKEN: "x" };
  const broker = credentialBrokerFromEnv(env, { remove: true });
  const rt = new PluginRuntime(fake.connect, env, broker);
  await rt.setState(["mcp.github"]);
  assert.equal(fake.calls.length, 1);
  const config = fake.calls[0]![0]! as Extract<McpServerConfig, { url: string }>;
  assert.deepEqual(config.credential, {
    id: "env:GITHUB_TOKEN",
    header: "Authorization",
    scheme: "Bearer",
  });
  assert.equal(config.url, "https://api.githubcopilot.com/mcp/");
  assert.equal(config.headers?.["X-MCP-Lockdown"], "true");
  assert.ok(rt.buildToolRegistry().names().includes("github__do"));
});

test("PluginRuntime: 原始进程密钥不能绕过 Credential Broker", async () => {
  const fake = fakeConnector();
  const rt = new PluginRuntime(fake.connect, { GITHUB_TOKEN: "x" });
  await rt.setState(["mcp.github"]);
  assert.equal(fake.calls.length, 0);
  assert.match(
    rt.entriesWithStatus().find((entry) => entry.id === "mcp.github")?.runtime?.error ?? "",
    /GITHUB_TOKEN/,
  );
});

test("PluginRuntime: 停用已连接的 MCP 会断开并移除其工具", async () => {
  const fake = fakeConnector();
  const rt = new PluginRuntime(fake.connect, {});
  await rt.setState(["mcp.playwright"]);
  assert.ok(rt.buildToolRegistry().names().includes("playwright__do"));

  await rt.setState([]); // 停用
  assert.equal(fake.closed, 1, "应关闭 MCP client");
  assert.ok(!rt.buildToolRegistry().names().includes("playwright__do"));
});

test("PluginRuntime: trust suspension closes MCP and reconnects only after resume", async () => {
  const fake = fakeConnector();
  const rt = new PluginRuntime(fake.connect, {});
  await rt.setState(["mcp.playwright"]);
  assert.ok(rt.buildToolRegistry().names().includes("playwright__do"));
  await rt.setSuspended(true);
  assert.equal(fake.closed, 1);
  assert.ok(!rt.buildToolRegistry().names().includes("playwright__do"));
  await rt.setSuspended(false);
  assert.equal(fake.calls.length, 2);
  assert.ok(rt.buildToolRegistry().names().includes("playwright__do"));
  rt.dispose();
});
