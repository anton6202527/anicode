/**
 * 测试用假 MCP server —— 实现 JSON-RPC 2.0 over stdio（MCP 规范的换行分隔 JSON），
 * 支持 2026-07-28 server/discover + 每请求 _meta，以及 tools/resources/prompts。
 * 工具：echo、fail、hang（永不响应，测超时）、notify_changed（先发
 * notifications/tools/list_changed 再响应，测动态刷新）。
 * 供 mcp.test.ts 以子进程方式启动，验证 McpClient 的真实协议往返。
 */

let buffer = "";
const VERSION = "2026-07-28";
const VERSION_META = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_META = "io.modelcontextprotocol/clientCapabilities";

function writeFrame(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function complete(id: number, result: Record<string, unknown>): void {
  writeFrame({
    jsonrpc: "2.0",
    id,
    result: {
      ...result,
      resultType: "complete",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "fake", version: "1" } },
    },
  });
}

function validModernRequest(msg: any): boolean {
  const meta = msg?.params?._meta;
  if (meta?.[VERSION_META] === VERSION && typeof meta?.[CAPABILITIES_META] === "object") {
    return true;
  }
  writeFrame({
    jsonrpc: "2.0",
    id: msg.id,
    error: { code: -32602, message: "missing 2026 request metadata" },
  });
  return false;
}

function handle(msg: any): void {
  if (msg.method === "server/discover") {
    if (!validModernRequest(msg)) return;
    complete(msg.id, {
      supportedVersions: [VERSION],
      capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
    });
  } else if (!validModernRequest(msg)) {
    return;
  } else if (msg.method === "tools/list") {
    complete(msg.id, {
      tools: [
        {
          name: "echo",
          description: "回显输入的文本",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        {
          name: "fail",
          description: "总是返回错误（测试错误路径）",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "hang",
          description: "永不响应（测试超时）",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "notify_changed",
          description: "先广播 tools/list_changed 再响应",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo") {
      complete(msg.id, { content: [{ type: "text", text: `echo: ${args.text}` }] });
    } else if (name === "fail") {
      complete(msg.id, {
        isError: true,
        content: [{ type: "text", text: "故意失败" }],
      });
    } else if (name === "hang") {
      /* 故意不响应 */
    } else if (name === "notify_changed") {
      writeFrame({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      complete(msg.id, { content: [{ type: "text", text: "notified" }] });
    } else {
      writeFrame({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } });
    }
  } else if (msg.method === "resources/list") {
    complete(msg.id, {
      resources: [
        { uri: "fake://readme", name: "readme", description: "项目说明", mimeType: "text/plain" },
      ],
    });
  } else if (msg.method === "resources/read") {
    complete(msg.id, {
      contents: [
        { uri: msg.params.uri, mimeType: "text/plain", text: `content of ${msg.params.uri}` },
      ],
    });
  } else if (msg.method === "prompts/list") {
    complete(msg.id, {
      prompts: [
        {
          name: "review",
          description: "审查提示",
          arguments: [{ name: "file", required: true }],
        },
      ],
    });
  } else if (msg.method === "prompts/get") {
    complete(msg.id, {
      messages: [
        {
          role: "user",
          content: { type: "text", text: `请审查 ${msg.params?.arguments?.file ?? "?"}` },
        },
      ],
    });
  } else if (typeof msg.id === "number") {
    writeFrame({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } });
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).replace(/\r$/, "").trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch {
      /* ignore */
    }
  }
});
