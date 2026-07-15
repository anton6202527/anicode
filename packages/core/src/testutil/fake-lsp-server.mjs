/**
 * 测试用假语言服务器 —— 纯 JS（无 tsx 依赖，任意 cwd 下 `node fake-lsp-server.mjs` 可跑）。
 * LSP JSON-RPC over stdio（Content-Length 分帧）：
 *   initialize → 空 capabilities；textDocument/didOpen → 立刻回一条 error 诊断。
 */
let buffer = Buffer.alloc(0);

function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

function handle(msg) {
  if (msg.method === "initialize") {
    writeFrame({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/didOpen") {
    const uri = msg.params.textDocument.uri;
    writeFrame({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri,
        diagnostics: [
          {
            range: { start: { line: 2, character: 4 }, end: { line: 2, character: 9 } },
            severity: 1,
            source: "fake",
            message: "类型不匹配（测试诊断）",
          },
        ],
      },
    });
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const sep = buffer.indexOf("\r\n\r\n");
    if (sep < 0) return;
    const header = buffer.subarray(0, sep).toString("ascii");
    const m = /content-length:\s*(\d+)/i.exec(header);
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
      // 忽略坏包
    }
  }
});
