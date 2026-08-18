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
    // This test double is app-owned code, not a real McpClient adapter. Production MCP tools are
    // branded by core's managed transport factory before registerExtension sees them.
    execution: { kind: "trusted-in-process" },
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

test("PluginRuntime: stdio MCP 在调用连接器前 fail-closed", async () => {
  const fake = fakeConnector();
  const rt = new PluginRuntime(fake.connect, {});
  await rt.setState(["mcp.playwright"]);
  assert.equal(fake.calls.length, 0);
  const names = rt.buildToolRegistry().names();
  assert.ok(!names.includes("playwright__do"));
  const status = rt.entriesWithStatus().find((e) => e.id === "mcp.playwright")?.runtime;
  assert.equal(status?.connected, false);
  assert.match(status?.error ?? "", /stdio MCP requires managed.*containment/i);
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

test("PluginRuntime: independent MCP servers connect concurrently and isolate failures", async () => {
  const gate = deferred();
  let started = 0;
  let active = 0;
  let peak = 0;
  const connect: McpConnector = async ([config]) => {
    assert.ok(config);
    started += 1;
    active += 1;
    peak = Math.max(peak, active);
    if (started === 3) gate.resolve();
    await gate.promise;
    active -= 1;
    if (config.name === "github") throw new Error("github unavailable");
    return {
      tools: [fakeTool(`${config.name}__do`)],
      clients: [{ close: async () => undefined } as McpClient],
    };
  };
  const env = { GITHUB_TOKEN: "x", SENTRY_ACCESS_TOKEN: "y" };
  const rt = new PluginRuntime(connect, env, credentialBrokerFromEnv(env, { remove: true }));

  await rt.setState(["mcp.context7", "mcp.github", "mcp.sentry"]);

  assert.equal(peak, 3, "independent startup latency should be max(server), not sum(server)");
  const names = rt.buildToolRegistry().names();
  assert.ok(names.includes("context7__do"));
  assert.ok(names.includes("sentry__do"));
  assert.ok(!names.includes("github__do"));
  const github = rt.entriesWithStatus().find((entry) => entry.id === "mcp.github")?.runtime;
  assert.equal(github?.connected, false);
  assert.match(github?.error ?? "", /github unavailable/);
  await rt.dispose();
});

test("PluginRuntime: state changes serialize behind an in-flight connection", async () => {
  const entered = deferred();
  const release = deferred();
  let closed = 0;
  const connect: McpConnector = async ([config]) => {
    assert.equal(config?.name, "context7");
    entered.resolve();
    await release.promise;
    return {
      tools: [fakeTool("context7__do")],
      clients: [{ close: async () => void closed++ } as McpClient],
    };
  };
  const rt = new PluginRuntime(connect, {});

  const enable = rt.setState(["mcp.context7"]);
  await entered.promise;
  const disable = rt.setState([]);
  release.resolve();
  await Promise.all([enable, disable]);

  assert.equal(closed, 1, "the later state must close the just-connected client");
  assert.ok(!rt.buildToolRegistry().names().includes("context7__do"));
  await rt.dispose();
});

test("PluginRuntime: trust revocation hides tools before an in-flight connection settles", async () => {
  const entered = deferred();
  const release = deferred();
  let closed = 0;
  const connect: McpConnector = async ([config]) => {
    assert.ok(config);
    if (config.name === "github") {
      entered.resolve();
      await release.promise;
    }
    return {
      tools: [fakeTool(`${config.name}__do`)],
      clients: [{ close: async () => void closed++ } as McpClient],
    };
  };
  const env = { GITHUB_TOKEN: "x" };
  const rt = new PluginRuntime(connect, env, credentialBrokerFromEnv(env, { remove: true }));
  await rt.setState(["mcp.context7"]);
  assert.ok(rt.buildToolRegistry().names().includes("context7__do"));

  const addGithub = rt.setState(["mcp.context7", "mcp.github"]);
  await entered.promise;
  const suspend = rt.setSuspended(true);
  assert.ok(
    !rt.buildToolRegistry().names().includes("context7__do"),
    "revocation must be a synchronous tool-visibility fence",
  );
  release.resolve();
  await Promise.all([addGithub, suspend]);

  assert.equal(closed, 2);
  await rt.dispose();
});

test("PluginRuntime: a queued resume cannot cross a newer trust revocation", async () => {
  const entered = deferred();
  const release = deferred();
  let closed = 0;
  const connect: McpConnector = async () => {
    entered.resolve();
    await release.promise;
    return {
      tools: [fakeTool("context7__do")],
      clients: [{ close: async () => void closed++ } as McpClient],
    };
  };
  const rt = new PluginRuntime(connect, {});

  const state = rt.setState(["mcp.context7"]);
  await entered.promise;
  const firstRevoke = rt.setSuspended(true);
  const resume = rt.setSuspended(false);
  const revoke = rt.setSuspended(true);

  release.resolve();
  await Promise.all([state, firstRevoke, resume, revoke]);

  assert.ok(!rt.buildToolRegistry().names().includes("context7__do"));
  assert.equal(closed, 1);
  await rt.dispose();
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
  const env = { GITHUB_TOKEN: "x" };
  const rt = new PluginRuntime(fake.connect, env, credentialBrokerFromEnv(env, { remove: true }));
  await rt.setState(["mcp.github"]);
  assert.ok(rt.buildToolRegistry().names().includes("github__do"));

  await rt.setState([]); // 停用
  assert.equal(fake.closed, 1, "应关闭 MCP client");
  assert.ok(!rt.buildToolRegistry().names().includes("github__do"));
});

test("PluginRuntime: trust suspension closes MCP and reconnects only after resume", async () => {
  const fake = fakeConnector();
  const env = { GITHUB_TOKEN: "x" };
  const rt = new PluginRuntime(fake.connect, env, credentialBrokerFromEnv(env, { remove: true }));
  await rt.setState(["mcp.github"]);
  assert.ok(rt.buildToolRegistry().names().includes("github__do"));
  await rt.setSuspended(true);
  assert.equal(fake.closed, 1);
  assert.ok(!rt.buildToolRegistry().names().includes("github__do"));
  await rt.setSuspended(false);
  assert.equal(fake.calls.length, 2);
  assert.ok(rt.buildToolRegistry().names().includes("github__do"));
  rt.dispose();
});

test("PluginRuntime: connector returning a stdio tool is closed before any tool becomes visible", async () => {
  let closed = 0;
  const connect: McpConnector = async () => ({
    tools: [
      {
        ...fakeTool("github__unsafe"),
        execution: {
          kind: "managed-external",
          protocol: "mcp-stdio",
          namespace: "github",
          cancellation: "outcome-indeterminate",
        },
      },
    ],
    clients: [{ close: async () => void closed++ } as McpClient],
  });
  const env = { GITHUB_TOKEN: "x" };
  const rt = new PluginRuntime(connect, env, credentialBrokerFromEnv(env, { remove: true }));
  await rt.setState(["mcp.github"]);
  assert.equal(closed, 1);
  assert.ok(!rt.buildToolRegistry().names().includes("github__unsafe"));
  const status = rt.entriesWithStatus().find((entry) => entry.id === "mcp.github")?.runtime;
  assert.equal(status?.connected, false);
  assert.match(status?.error ?? "", /stdio MCP requires managed process containment/i);
});
