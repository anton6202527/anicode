/**
 * MCP server 模式：2026-07-28 无状态协议 + 旧 initialize 双栈，以及 anicode 会话工具。
 * 进程内 PassThrough 流驱动（换行分隔 JSON-RPC），脚本化 provider，全离线。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { serveMcp } from "./mcp-server.js";
import { SessionManager } from "./session-manager.js";
import { SessionStore } from "./session.js";
import type { Provider, StreamEvent } from "./types.js";

function makeProvider(): Provider {
  let n = 0;
  return {
    name: "p",
    async *stream(req): AsyncIterable<StreamEvent> {
      n++;
      // 回答里带上收到的最后一条用户文本，便于断言 reply 续话看到了完整历史。
      const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
      const text = lastUser?.content.find((p) => p.type === "text");
      yield {
        type: "done",
        stopReason: "end_turn",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `答复${n}: ${text && "text" in text ? text.text : ""}` }],
        },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

async function rpc(
  input: PassThrough,
  replies: Map<number, any>,
  id: number,
  method: string,
  params?: unknown,
): Promise<any> {
  input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  const deadline = Date.now() + 3000;
  while (!replies.has(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  const msg = replies.get(id);
  assert.ok(msg, `请求 ${method}(#${id}) 应有响应`);
  return msg;
}

function modernParams(params: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...params,
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  };
}

test("serveMcp: 握手/工具列表/跑任务/续会话（换行分隔 JSON-RPC）", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mcp-srv-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: makeProvider(), model: "p" }),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map<number, any>();
  let outBuf = "";
  output.on("data", (c: Buffer) => {
    outBuf += c.toString();
    let nl: number;
    while ((nl = outBuf.indexOf("\n")) >= 0) {
      const line = outBuf.slice(0, nl);
      outBuf = outBuf.slice(nl + 1);
      const msg = JSON.parse(line);
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });
  const server = serveMcp({
    manager,
    model: "p",
    cwd: dir,
    input,
    output,
    serverInfo: { name: "anicode", version: "test" },
  });

  const init = await rpc(input, replies, 1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  });
  assert.equal(init.result.serverInfo.name, "anicode");
  input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const list = await rpc(input, replies, 2, "tools/list");
  assert.deepEqual(
    list.result.tools.map((t: any) => t.name),
    ["anicode", "anicode_reply"],
  );

  const call = await rpc(input, replies, 3, "tools/call", {
    name: "anicode",
    arguments: { prompt: "修复登录" },
  });
  assert.equal(call.result.isError, false);
  const payload = JSON.parse(call.result.content[0].text);
  assert.match(payload.answer, /答复1: 修复登录/);
  assert.ok(payload.sessionId);

  const reply = await rpc(input, replies, 4, "tools/call", {
    name: "anicode_reply",
    arguments: { sessionId: payload.sessionId, prompt: "再加测试" },
  });
  const payload2 = JSON.parse(reply.result.content[0].text);
  assert.equal(payload2.sessionId, payload.sessionId);
  assert.match(payload2.answer, /答复2: 再加测试/, "续会话应带完整历史（同一会话第二轮）");

  const unknown = await rpc(input, replies, 5, "tools/call", { name: "nope", arguments: {} });
  assert.ok(unknown.error, "未知工具应回 JSON-RPC error");

  server.close();
  manager.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("serveMcp 2026: discover / 每请求元数据 / complete 结果，无需 initialize", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mcp-srv-modern-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: makeProvider(), model: "p" }),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map<number, any>();
  let outBuf = "";
  output.on("data", (chunk: Buffer) => {
    outBuf += chunk.toString();
    let newline: number;
    while ((newline = outBuf.indexOf("\n")) >= 0) {
      const msg = JSON.parse(outBuf.slice(0, newline));
      outBuf = outBuf.slice(newline + 1);
      if (typeof msg.id === "number") replies.set(msg.id, msg);
    }
  });
  const server = serveMcp({
    manager,
    model: "p",
    cwd: dir,
    input,
    output,
    serverInfo: { name: "anicode", version: "test" },
  });

  const discover = await rpc(input, replies, 1, "server/discover", modernParams());
  assert.equal(discover.result.resultType, "complete");
  assert.deepEqual(discover.result.supportedVersions, ["2026-07-28"]);
  assert.deepEqual(discover.result.capabilities, { tools: {} });
  assert.equal(discover.result._meta["io.modelcontextprotocol/serverInfo"].name, "anicode");
  assert.equal(discover.result.serverInfo, undefined, "最终版 serverInfo 只位于结果 _meta");

  const list = await rpc(input, replies, 2, "tools/list", modernParams());
  assert.equal(list.result.resultType, "complete");
  assert.deepEqual(
    list.result.tools.map((tool: any) => tool.name),
    ["anicode", "anicode_reply"],
  );

  const call = await rpc(
    input,
    replies,
    3,
    "tools/call",
    modernParams({ name: "anicode", arguments: { prompt: "现代协议任务" } }),
  );
  assert.equal(call.result.resultType, "complete");
  assert.equal(call.result.isError, false);
  assert.match(JSON.parse(call.result.content[0].text).answer, /答复1: 现代协议任务/);

  const invalid = await rpc(input, replies, 4, "tools/list", {
    _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
  });
  assert.equal(invalid.error.code, -32602);

  const unsupported = await rpc(input, replies, 5, "tools/list", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2099-01-01",
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  assert.equal(unsupported.error.code, -32022);
  assert.deepEqual(unsupported.error.data, {
    supported: ["2026-07-28"],
    requested: "2099-01-01",
  });

  server.close();
  manager.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});

test("serveMcp: oversized unterminated input is rejected and reading stops", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mcp-srv-limit-"));
  const manager = new SessionManager({
    store: new SessionStore(path.join(dir, "sessions")),
    resolveProvider: () => ({ provider: makeProvider(), model: "p" }),
  });
  const input = new PassThrough();
  const output = new PassThrough();
  let response = "";
  output.on("data", (chunk: Buffer) => (response += chunk.toString("utf8")));
  const server = serveMcp({ manager, model: "p", cwd: dir, input, output });
  input.write(Buffer.alloc(4 * 1024 * 1024 + 1, 0x78));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(response, /request frame exceeds 4194304 bytes/);
  assert.equal(input.isPaused(), true);
  server.close();
  manager.dispose();
  await fs.rm(dir, { recursive: true, force: true });
});
