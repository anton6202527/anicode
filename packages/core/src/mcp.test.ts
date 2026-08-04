/**
 * MCP 客户端测试：以子进程启动假 MCP server，验证
 *   2026-07-28 discover / 旧 initialize 回退 → tools/list 包装 → tools/call 往返，
 * 并把 MCP 工具挂进真实 Agent，端到端跑一次工具调用。全离线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as http from "node:http";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import { McpClient } from "./mcp.js";
import { Agent } from "./agent.js";
import { CredentialBroker } from "./security/credentials.js";
import { NetworkProxy } from "./runtime/network-proxy.js";
import { InMemoryTelemetry } from "./runtime/telemetry.js";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";
import { defaultTools } from "./tools/index.js";
import type { Provider, StreamEvent, ChatMessage, AgentEvent } from "./index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "testutil", "fake-mcp-server.ts");

// 用 tsx 直接跑 TS server 脚本
const serverCfg = {
  name: "fake",
  command: process.execPath, // node
  args: ["--import", "tsx", serverPath],
};

const legacyServerScript = String.raw`
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === "server/discover") {
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
    } else if (msg.method === "initialize") {
      send({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "legacy", version: "1" }
      }});
    } else if (msg.method === "tools/list") {
      send({ jsonrpc: "2.0", id: msg.id, result: { tools: [] } });
    }
  }
});
`;

test("MCP: 握手 → 列工具 → 调用 → 错误路径", async () => {
  const client = await McpClient.start(serverCfg);
  assert.equal(client.protocolVersion, "2026-07-28");
  const tools = await client.listTools();

  // 工具被以 "<server>__<tool>" 命名，且非只读（走权限门）
  const echo = tools.find((t) => t.def.name === "fake__echo");
  assert.ok(echo, "应有 fake__echo 工具");
  assert.equal(echo!.readOnly, false);
  assert.match(echo!.def.description, /回显/);

  // 正常调用
  const out = await echo!.run({ text: "你好" }, { cwd: ".", signal: new AbortController().signal });
  assert.equal(out, "echo: 你好");

  // 错误路径：fail 工具抛 ToolError
  const fail = tools.find((t) => t.def.name === "fake__fail")!;
  await assert.rejects(
    () => fail.run({}, { cwd: ".", signal: new AbortController().signal }),
    /故意失败/,
  );

  await client.close();
});

test("MCP(HTTP legacy): discover 失败后回退握手并维持 session", async () => {
  const seenSession: string[] = [];
  const seenAuthorization: string[] = [];
  const seenMethods: string[] = [];
  let initialized = false;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const sid = req.headers["mcp-session-id"];
      if (sid) seenSession.push(String(sid));
      if (req.headers.authorization) seenAuthorization.push(req.headers.authorization);
      const msg = body ? JSON.parse(body) : {};
      seenMethods.push(msg.method);
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-123" });
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }),
        );
        return;
      }
      if (msg.method === "notifications/initialized") {
        initialized = true;
        res.writeHead(202).end();
        return;
      }
      if (msg.method === "tools/list") {
        if (!initialized) {
          res.writeHead(400).end("initialized notification must arrive first");
          return;
        }
        // SSE 路径
        res.writeHead(200, { "content-type": "text/event-stream" });
        const payload = {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            tools: [{ name: "ping", description: "远程 ping", inputSchema: { type: "object" } }],
          },
        };
        res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
        res.end();
        return;
      }
      if (msg.method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: `pong:${msg.params.arguments.x}` }] },
          }),
        );
        return;
      }
      res.writeHead(400).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  let networkProxy: NetworkProxy | undefined;
  try {
    const broker = new CredentialBroker();
    broker.register({
      id: "mcp-token",
      value: "secret-token",
      scopes: [
        {
          audiences: ["mcp:remote"],
          hosts: ["127.0.0.1"],
          tools: ["http"],
          header: "authorization",
        },
      ],
    });
    networkProxy = new NetworkProxy({
      broker,
      policy: { allowPrivateAddresses: true, allowPorts: [port] },
    });
    const client = await McpClient.start(
      {
        name: "remote",
        url: `http://127.0.0.1:${port}/mcp`,
        credential: { id: "mcp-token", scheme: "Bearer" },
      },
      { networkProxy, credentialBroker: broker },
    );
    assert.equal(client.protocolVersion, "2024-11-05");
    const tools = await client.listTools();
    const ping = tools.find((t) => t.def.name === "remote__ping");
    assert.ok(ping, "应包装出 remote__ping");
    assert.equal(ping!.readOnly, false);
    const out = await ping!.run({ x: 42 }, { cwd: ".", signal: new AbortController().signal });
    assert.equal(out, "pong:42");
    // 初始化返回的 session id 必须在后续请求回带。
    assert.ok(seenSession.includes("sess-123"), "后续请求应回带 Mcp-Session-Id");
    assert.deepEqual(seenMethods.slice(0, 4), [
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    assert.ok(seenAuthorization.every((value) => value === "Bearer secret-token"));
    await client.close();
  } finally {
    await networkProxy?.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("MCP(HTTP probe): 仅明确 legacy 状态或 method error 触发降级", async () => {
  for (const evidence of [404, 405, "rpc-method-not-found"] as const) {
    const methods: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const msg = JSON.parse(body);
        methods.push(msg.method);
        if (msg.method === "server/discover") {
          if (typeof evidence === "number") {
            res.writeHead(evidence).end();
          } else {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: msg.id,
                error: { code: -32601, message: "unknown method" },
              }),
            );
          }
          return;
        }
        if (msg.method === "initialize") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
            }),
          );
          return;
        }
        res.writeHead(202).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const networkProxy = new NetworkProxy({
      policy: { allowPrivateAddresses: true, allowPorts: [port] },
    });
    try {
      const client = await McpClient.start(
        { name: `legacy-${evidence}`, url: `http://127.0.0.1:${port}/mcp` },
        { networkProxy },
      );
      assert.equal(client.protocolVersion, "2025-11-25");
      assert.deepEqual(methods.slice(0, 2), ["server/discover", "initialize"]);
      await client.close();
    } finally {
      await networkProxy.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("MCP(HTTP 2026): 每请求带自包含元数据/标准 header，且绝不使用 session", async () => {
  const requests: {
    method: string;
    params: Record<string, unknown>;
    headers: http.IncomingHttpHeaders;
  }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const msg = JSON.parse(body);
      requests.push({ method: msg.method, params: msg.params, headers: req.headers });
      res.setHeader("content-type", "application/json");
      // 即使异常 server 回了旧 session header，现代客户端也必须忽略。
      res.setHeader("mcp-session-id", "must-not-stick");
      if (msg.method === "server/discover") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              supportedVersions: ["2026-07-28"],
              capabilities: { tools: {} },
              _meta: {
                "io.modelcontextprotocol/serverInfo": { name: "modern", version: "1" },
              },
            },
          }),
        );
        return;
      }
      if (msg.method === "tools/list") {
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              resultType: "complete",
              tools: [
                {
                  name: "你好",
                  inputSchema: {
                    type: "object",
                    properties: {
                      token: { type: "string", "x-mcp-header": "Token" },
                      nested: {
                        type: "object",
                        properties: {
                          flag: { type: "boolean", "x-mcp-header": "Flag" },
                          count: { type: "integer", "x-mcp-header": "Count" },
                        },
                      },
                    },
                  },
                },
                {
                  name: "invalid-number",
                  inputSchema: {
                    type: "object",
                    properties: { value: { type: "number", "x-mcp-header": "Value" } },
                  },
                },
                {
                  name: "invalid-duplicate",
                  inputSchema: {
                    type: "object",
                    properties: {
                      a: { type: "string", "x-mcp-header": "Region" },
                      b: { type: "string", "x-mcp-header": "region" },
                    },
                  },
                },
                {
                  name: "invalid-items-path",
                  inputSchema: {
                    type: "object",
                    properties: {
                      values: {
                        type: "array",
                        items: { type: "string", "x-mcp-header": "Value" },
                      },
                    },
                  },
                },
              ],
            },
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            resultType: "complete",
            content: [{ type: "text", text: "ok" }],
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const networkProxy = new NetworkProxy({
    policy: { allowPrivateAddresses: true, allowPorts: [port] },
  });
  try {
    const client = await McpClient.start(
      { name: "modern", url: `http://127.0.0.1:${port}/mcp` },
      { networkProxy },
    );
    assert.equal(client.protocolVersion, "2026-07-28");
    const tools = await client.listTools();
    assert.deepEqual(
      tools.map((candidate) => candidate.def.name),
      ["modern__你好"],
      "含非法 x-mcp-header 注解的工具必须整项排除",
    );
    const tool = tools.find((candidate) => candidate.def.name === "modern__你好");
    assert.ok(tool);
    const input = {
      token: "=?base64?literal?=",
      nested: { flag: true, count: 7 },
    };
    assert.equal(await tool.run(input, { cwd: ".", signal: new AbortController().signal }), "ok");
    await assert.rejects(
      () =>
        tool.run(
          { token: "ok", nested: { flag: true, count: 1.5 } },
          { cwd: ".", signal: new AbortController().signal },
        ),
      /must be integer/,
      "header-bound integer 必须是安全整数，不能把错误实例镜像进 header",
    );
    await client.close();

    assert.deepEqual(
      requests.map((request) => request.method),
      ["server/discover", "tools/list", "tools/call"],
      "现代路径不得发送 initialize/initialized",
    );
    for (const request of requests) {
      const meta = request.params["_meta"] as Record<string, unknown>;
      assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
      assert.deepEqual(meta["io.modelcontextprotocol/clientCapabilities"], {});
      assert.deepEqual(meta["io.modelcontextprotocol/clientInfo"], {
        name: "anicode",
        version: "0.0.1",
      });
      assert.equal(request.headers["mcp-protocol-version"], "2026-07-28");
      assert.equal(request.headers["mcp-method"], request.method);
      assert.equal(request.headers["mcp-session-id"], undefined);
    }
    assert.equal(requests[2]?.headers["mcp-name"], "=?base64?5L2g5aW9?=");
    assert.equal(
      requests[2]?.headers["mcp-param-token"],
      `=?base64?${Buffer.from(input.token).toString("base64")}?=`,
      "与 sentinel 相似的 ASCII 值也必须再次 Base64 编码",
    );
    assert.equal(requests[2]?.headers["mcp-param-flag"], "true");
    assert.equal(requests[2]?.headers["mcp-param-count"], "7");
  } finally {
    await networkProxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP(HTTP 2026): 缺少必需 resultType 时 fail closed，不尝试 legacy", async () => {
  const methods: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const msg = JSON.parse(body);
      methods.push(msg.method);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            supportedVersions: ["2026-07-28"],
            capabilities: { tools: {} },
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const networkProxy = new NetworkProxy({
    policy: { allowPrivateAddresses: true, allowPorts: [port] },
  });
  try {
    await assert.rejects(
      () =>
        McpClient.start(
          { name: "missing-result-type", url: `http://127.0.0.1:${port}/mcp` },
          { networkProxy },
        ),
      /missing required resultType/,
    );
    assert.deepEqual(methods, ["server/discover"]);
  } finally {
    await networkProxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("MCP(HTTP probe): auth、限流与 5xx 失败绝不降级", async () => {
  for (const status of [401, 403, 429, 500, 503]) {
    const methods: string[] = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const msg = JSON.parse(body);
        methods.push(msg.method);
        res.writeHead(status, { "content-type": "application/json" });
        // 即使 body 伪装成 legacy method-not-found，HTTP 状态仍优先阻止降级。
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32601, message: "not available" },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as any).port;
    const networkProxy = new NetworkProxy({
      policy: { allowPrivateAddresses: true, allowPorts: [port] },
    });
    const telemetry = new InMemoryTelemetry();
    try {
      await assert.rejects(() =>
        McpClient.start(
          { name: `status-${status}`, url: `http://127.0.0.1:${port}/mcp` },
          { networkProxy, telemetry },
        ),
      );
      assert.deepEqual(methods, ["server/discover"], `HTTP ${status} 不得触发 initialize`);
      assert.equal(
        telemetry.spans.some((span) => span.attributes["rpc.method"] === "initialize"),
        false,
      );
    } finally {
      await networkProxy.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

test("MCP(HTTP probe): timeout 与网络故障绝不降级", async () => {
  const methods: string[] = [];
  const server = http.createServer((req) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => methods.push(JSON.parse(body).method));
    // 故意不响应，等待客户端 discovery timeout 主动 abort。
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const networkProxy = new NetworkProxy({
    policy: { allowPrivateAddresses: true, allowPorts: [port] },
  });
  const timeoutTelemetry = new InMemoryTelemetry();
  try {
    await assert.rejects(
      () =>
        McpClient.start(
          {
            name: "timeout",
            url: `http://127.0.0.1:${port}/mcp`,
            discoveryTimeoutMs: 40,
          },
          { networkProxy, telemetry: timeoutTelemetry },
        ),
      /timed out|超时/,
    );
    assert.deepEqual(methods, ["server/discover"]);
    assert.equal(
      timeoutTelemetry.spans.some((span) => span.attributes["rpc.method"] === "initialize"),
      false,
    );
  } finally {
    await networkProxy.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  const outageTelemetry = new InMemoryTelemetry();
  const outageProxy = new NetworkProxy({
    resolver: async () => ["93.184.216.34"],
    fetch: async () => {
      throw new Error("simulated network outage");
    },
  });
  try {
    await assert.rejects(
      () =>
        McpClient.start(
          { name: "outage", url: "https://mcp.example.test/mcp" },
          { networkProxy: outageProxy, telemetry: outageTelemetry },
        ),
      /simulated network outage/,
    );
    assert.equal(
      outageTelemetry.spans.some((span) => span.attributes["rpc.method"] === "initialize"),
      false,
    );
  } finally {
    await outageProxy.close();
  }
});

test("MCP(stdio legacy): server/discover 任意旧错误均回退 initialize", async () => {
  const client = await McpClient.start({
    name: "legacy",
    command: process.execPath,
    args: ["-e", legacyServerScript],
    timeoutMs: 1_000,
  });
  assert.equal(client.protocolVersion, "2024-11-05");
  assert.deepEqual(client.capabilities, { tools: true, resources: false, prompts: false });
  assert.deepEqual(await client.listTools(), []);
  await client.close();
});

test("MCP(stdio modern): 现代协议错误不得降级为 legacy 握手", async () => {
  const script = String.raw`
  let buffer = "";
  process.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const msg = JSON.parse(buffer.slice(0, newline));
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32022,
        message: "unsupported MCP protocol version",
        data: { supported: ["2099-01-01"], requested: "2026-07-28" }
      }
    }) + "\n");
  });
  `;
  await assert.rejects(
    () =>
      McpClient.start({
        name: "future",
        command: process.execPath,
        args: ["-e", script],
        timeoutMs: 1_000,
      }),
    /MCP -32022/,
  );
});

test("MCP(HTTP): 无受控出口或静态敏感 header 时 fail-close", async () => {
  await assert.rejects(
    () => McpClient.start({ name: "remote", url: "https://example.com/mcp" }),
    /requires the AniCode Network Proxy/,
  );
  const proxy = new NetworkProxy({ resolver: async () => ["203.0.113.10"] });
  await assert.rejects(
    () =>
      McpClient.start(
        {
          name: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer leaked" },
        },
        { networkProxy: proxy },
      ),
    /must use credential\.id/,
  );
});

test("MCP: capabilities + resources/prompts 客户端方法", async () => {
  const client = await McpClient.start(serverCfg);
  assert.deepEqual(client.capabilities, { tools: true, resources: true, prompts: true });

  const resources = await client.listResources();
  assert.equal(resources[0]?.uri, "fake://readme");
  const content = await client.readResource("fake://readme");
  assert.equal(content, "content of fake://readme");

  const prompts = await client.listPrompts();
  assert.equal(prompts[0]?.name, "review");
  const rendered = await client.getPrompt("review", { file: "a.ts" });
  assert.equal(rendered, "请审查 a.ts");

  await client.close();
});

test("MCP: per-request 超时（hang 工具在时限内报错，不永久挂起）", async () => {
  const client = await McpClient.start({ ...serverCfg, timeoutMs: 400 });
  const tools = await client.listTools();
  const hang = tools.find((t) => t.def.name === "fake__hang")!;
  await assert.rejects(
    () => hang.run({}, { cwd: ".", signal: new AbortController().signal }),
    /超时|timed out/,
  );
  await client.close();
});

test("MCP(stdio): AbortSignal 贯穿 tools/call，并在返回前终止 server tree", async () => {
  const client = await McpClient.start({ ...serverCfg, timeoutMs: 10_000 });
  const hang = (await client.listTools()).find((tool) => tool.def.name === "fake__hang")!;
  const controller = new AbortController();
  const call = hang.run({}, { cwd: ".", signal: controller.signal });
  setTimeout(() => controller.abort(new Error("command lease lost")), 20);
  await assert.rejects(call, /command lease lost|cancel/i);
  await assert.rejects(client.listTools(), /closed|exited|lease lost|cancel/i);
  await client.close();
});

test("MCP(stdio): Broker credential stays a lease until the controlled runtime prepares env", async () => {
  const broker = new CredentialBroker();
  broker.register({
    id: "mcp-env-secret",
    value: "broker-only-secret",
    scopes: [{ audiences: ["mcp:credential"], tools: ["stdio"], env: "MCP_TEST_TOKEN" }],
  });
  let prepared = false;
  const runtime: ExecutionRuntime = {
    async run() {
      throw new Error("not used");
    },
    prepare(request) {
      prepared = true;
      assert.equal(request.env?.["MCP_TEST_TOKEN"], undefined);
      assert.equal(request.credentialLeases?.length, 1);
      let env = { ...request.env };
      for (const lease of request.credentialLeases ?? []) env = broker.injectEnv(lease, env);
      return {
        file: "/bin/bash",
        args: ["-c", request.command],
        env,
        cwd: request.cwd,
        sandboxed: true,
      };
    },
  };
  const script = String.raw`
let buffer = "";
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const msg = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    const complete = (result) => ({ ...result, resultType: "complete" });
    if (msg.method === "server/discover") send({ jsonrpc: "2.0", id: msg.id, result: complete({ supportedVersions: ["2026-07-28"], capabilities: { tools: {} } }) });
    else if (msg.method === "tools/list") send({ jsonrpc: "2.0", id: msg.id, result: complete({ tools: [{ name: "credential_ok", inputSchema: { type: "object" } }] }) });
    else if (msg.method === "tools/call") send({ jsonrpc: "2.0", id: msg.id, result: complete({ content: [{ type: "text", text: String(process.env.MCP_TEST_TOKEN === "broker-only-secret") }] }) });
  }
});`;
  const client = await McpClient.start(
    {
      name: "credential",
      command: process.execPath,
      args: ["-e", script],
      credentialEnv: { MCP_TEST_TOKEN: "mcp-env-secret" },
    },
    { credentialBroker: broker, executionRuntime: runtime },
  );
  assert.equal(prepared, true);
  const tool = (await client.listTools()).find(
    (candidate) => candidate.def.name === "credential__credential_ok",
  )!;
  assert.equal(await tool.run({}, { cwd: ".", signal: new AbortController().signal }), "true");
  await client.close();
});

test("MCP(stdio): unterminated oversized frames fail closed instead of growing forever", async () => {
  await assert.rejects(
    () =>
      McpClient.start({
        name: "oversized",
        command: process.execPath,
        args: ["-e", 'process.stdout.write("x".repeat(4 * 1024 * 1024 + 1))'],
        timeoutMs: 5_000,
      }),
    /MCP (?:帧超过|frame exceeds) 4194304 bytes/,
  );
});

test("MCP(stdio): missing executables reject initialization without an unhandled error", async () => {
  await assert.rejects(
    () =>
      McpClient.start({
        name: "missing",
        command: `anicode-missing-mcp-${process.pid}`,
        timeoutMs: 1_000,
      }),
    /ENOENT|spawn/,
  );
});

test("MCP: notifications/tools/list_changed → onToolsChanged 回调", async () => {
  let changed = 0;
  const client = await McpClient.start(serverCfg, { onToolsChanged: () => changed++ });
  const tools = await client.listTools();
  const notify = tools.find((t) => t.def.name === "fake__notify_changed")!;
  const out = await notify.run({}, { cwd: ".", signal: new AbortController().signal });
  assert.equal(out, "notified");
  assert.equal(changed, 1, "通知应触发 onToolsChanged");
  await client.close();
});

function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

test("MCP: 工具挂进 Agent，端到端调用", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mcp-"));
  const telemetry = new InMemoryTelemetry();
  const client = await McpClient.start(serverCfg, { telemetry });
  const mcpTools = await client.listTools();

  // 内置工具 + MCP 工具合并进一个 registry
  const registry = defaultTools();
  for (const t of mcpTools) registry.register(t);

  const agent = new Agent({
    provider: scriptedProvider([
      [
        {
          role: "assistant",
          content: [
            { type: "tool_call", id: "c1", name: "fake__echo", args: { text: "从 agent 调 MCP" } },
          ],
        },
      ],
      [{ role: "assistant", content: [{ type: "text", text: "MCP 工具返回了内容" }] }],
    ]),
    model: "scripted",
    cwd: dir,
    tools: registry,
    projectMemory: false,
    permission: { mode: "auto" }, // 自动放行以便断言执行
    telemetry,
  });

  const events: AgentEvent[] = [];
  const upstream = { traceId: "c".repeat(32), spanId: "d".repeat(16), traceFlags: 1 };
  for await (const ev of agent.send("用 echo 工具", undefined, { parent: upstream }))
    events.push(ev);

  const res = events.find((e) => e.type === "tool_result") as any;
  assert.equal(res.name, "fake__echo");
  assert.match(res.content, /echo: 从 agent 调 MCP/);
  assert.ok(events.some((e) => e.type === "done"));
  const toolSpan = telemetry.spans.find((span) => span.name === "anicode.tool.execute")!;
  const mcpSpan = telemetry.spans.find(
    (span) => span.name === "anicode.mcp.request" && span.attributes["rpc.method"] === "tools/call",
  )!;
  assert.equal(toolSpan.traceId, upstream.traceId);
  assert.equal(toolSpan.parentSpanId, upstream.spanId);
  assert.equal(mcpSpan.traceId, toolSpan.traceId);
  assert.equal(mcpSpan.parentSpanId, toolSpan.spanId);

  await client.close();
  await fs.rm(dir, { recursive: true, force: true });
});
