/**
 * 测试用假 MCP server —— 实现 JSON-RPC 2.0 over stdio（Content-Length 分帧），
 * 支持 initialize / tools/list / tools/call。暴露一个 echo 工具和一个 fail 工具。
 * 供 mcp.test.ts 以子进程方式启动，验证 McpClient 的真实协议往返。
 */

let buffer = Buffer.alloc(0);

function writeFrame(obj: unknown): void {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

function handle(msg: any): void {
  if (msg.method === "initialize") {
    writeFrame({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1" },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // 通知，无需回应
  } else if (msg.method === "tools/list") {
    writeFrame({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
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
        ],
      },
    });
  } else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo") {
      writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `echo: ${args.text}` }] },
      });
    } else if (name === "fail") {
      writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        result: { isError: true, content: [{ type: "text", text: "故意失败" }] },
      });
    } else {
      writeFrame({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown tool" } });
    }
  }
}

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const header = buffer.subarray(0, sep).toString("ascii");
    const m = /Content-Length:\s*(\d+)/i.exec(header);
    if (!m) {
      buffer = buffer.subarray(sep + 4);
      continue;
    }
    const len = Number(m[1]);
    const start = sep + 4;
    if (buffer.length < start + len) return;
    const body = buffer.subarray(start, start + len).toString("utf8");
    buffer = buffer.subarray(start + len);
    try {
      handle(JSON.parse(body));
    } catch {
      /* ignore */
    }
  }
});
