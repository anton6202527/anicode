/**
 * MCP server 模式 —— 把 anicode 自身暴露为一个 MCP server（对齐 `codex mcp-server`）。
 *
 * 任意 MCP 客户端（Claude Code / IDE / 其他 agent）由此把 anicode 当工具嵌入：
 *   - `anicode` 工具：起一个新会话跑完一个任务，返回最终结论 + sessionId
 *   - `anicode_reply` 工具：带 sessionId 继续既有会话（多轮协作）
 *
 * 传输：stdio，MCP 规范的换行分隔 JSON-RPC（与 mcp.ts 客户端同一帧格式）。
 * 并发：每个 tools/call 独立异步执行，互不阻塞（不同会话可并行）。
 * 权限：嵌入场景无人可点确认框 —— 宿主应以 auto/acceptEdits 等非交互模式构建
 * SessionManager，否则权限询问会把 drive 挂死（本模块不改权限语义，只如实执行）。
 */

import type { SessionManager } from "./session-manager.js";

export interface McpServeOptions {
  manager: SessionManager;
  /** 新会话的默认模型/工作目录（工具入参可覆盖 cwd/model）。 */
  model: string;
  cwd: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  serverInfo?: { name: string; version: string };
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: any;
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_MCP_CONCURRENT_CALLS = 32;
const MAX_MCP_RESULT_CHARS = 512 * 1024;

/** 启动 stdio MCP server；返回句柄用于停止读入（不 dispose manager，归宿主管）。 */
export function serveMcp(opts: McpServeOptions): { close(): void } {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const info = opts.serverInfo ?? { name: "anicode", version: "0.0.0" };
  let buffer = Buffer.alloc(0);
  let activeCalls = 0;
  let closed = false;

  const write = (obj: unknown): void => {
    const frame = JSON.stringify(obj) + "\n";
    if (Buffer.byteLength(frame, "utf8") <= MAX_MCP_FRAME_BYTES) {
      output.write(frame);
      return;
    }
    const id =
      obj && typeof obj === "object" && "id" in obj
        ? (obj as { id?: JsonRpcMessage["id"] }).id
        : null;
    output.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: id ?? null,
        error: { code: -32603, message: `response frame exceeds ${MAX_MCP_FRAME_BYTES} bytes` },
      }) + "\n",
    );
  };
  const reply = (id: JsonRpcMessage["id"], result: unknown): void =>
    write({ jsonrpc: "2.0", id, result });
  const replyError = (id: JsonRpcMessage["id"], code: number, message: string): void =>
    write({ jsonrpc: "2.0", id, error: { code, message } });

  const tools = [
    {
      name: "anicode",
      description:
        "Run the general-purpose anicode agent on a task, optionally grounded in a workspace directory. " +
        "Starts a fresh session and uses available tools autonomously (including files and commands when relevant and allowed), " +
        "and returns the final answer plus a sessionId for follow-ups via anicode_reply.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "The task for the agent (self-contained)" },
          cwd: { type: "string", description: "Workspace directory (defaults to server cwd)" },
          model: { type: "string", description: "Model override, e.g. provider/model" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
    },
    {
      name: "anicode_reply",
      description:
        "Continue an existing anicode session (from a previous anicode call) with a follow-up message; full context is kept.",
      inputSchema: {
        type: "object",
        properties: {
          sessionId: { type: "string" },
          prompt: { type: "string" },
        },
        required: ["sessionId", "prompt"],
        additionalProperties: false,
      },
    },
  ];

  async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
    const prompt = args["prompt"];
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 2 * 1024 * 1024) {
      throw new Error("prompt 必须包含 1 到 2097152 个字符");
    }
    let sessionId: string;
    if (name === "anicode") {
      const cwd = args["cwd"];
      const model = args["model"];
      if (
        cwd !== undefined &&
        (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 32768)
      ) {
        throw new Error("cwd 必须包含 1 到 32768 个字符");
      }
      if (
        model !== undefined &&
        (typeof model !== "string" || model.length === 0 || model.length > 512)
      ) {
        throw new Error("model 必须包含 1 到 512 个字符");
      }
      const meta = await opts.manager.createSession({
        cwd: typeof cwd === "string" ? cwd : opts.cwd,
        model: typeof model === "string" ? model : opts.model,
      });
      sessionId = meta.id;
    } else {
      const value = args["sessionId"];
      if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > 128 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
      ) {
        throw new Error("sessionId 非法");
      }
      sessionId = value;
      // 会话必须已存在；resumeSession 顺带把它拉活（跨 server 重启也能续）。
      await opts.manager.resumeSession(sessionId);
    }
    await opts.manager.send(sessionId, prompt);
    const snap = opts.manager.peek(sessionId);
    const answer = lastAssistantText(snap?.messages ?? []).slice(0, MAX_MCP_RESULT_CHARS);
    return JSON.stringify({ sessionId, answer });
  }

  function handle(msg: JsonRpcMessage): void {
    const id = msg.id;
    switch (msg.method) {
      case "initialize":
        reply(id, {
          protocolVersion:
            typeof msg.params?.protocolVersion === "string"
              ? msg.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: info,
        });
        return;
      case "notifications/initialized":
      case "notifications/cancelled":
        return; // 通知，无需回应
      case "ping":
        reply(id, {});
        return;
      case "tools/list":
        reply(id, { tools });
        return;
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const rawArgs = msg.params?.arguments ?? {};
        if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) {
          replyError(id, -32602, "tool arguments must be an object");
          return;
        }
        const args = rawArgs as Record<string, unknown>;
        if (name !== "anicode" && name !== "anicode_reply") {
          replyError(id, -32602, `unknown tool: ${name}`);
          return;
        }
        if (activeCalls >= MAX_MCP_CONCURRENT_CALLS) {
          replyError(
            id,
            -32000,
            `too many concurrent tool calls (max ${MAX_MCP_CONCURRENT_CALLS})`,
          );
          return;
        }
        activeCalls++;
        // 异步执行，不串行阻塞后续请求；结果/错误都以 MCP tool result 形态回传。
        void runTool(name, args)
          .then(
            (text) => reply(id, { content: [{ type: "text", text }], isError: false }),
            (err: unknown) =>
              reply(id, {
                content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
                isError: true,
              }),
          )
          .finally(() => activeCalls--);
        return;
      }
      default:
        if (id !== undefined && id !== null)
          replyError(id, -32601, `unknown method: ${msg.method}`);
    }
  }

  const onData = (chunk: Buffer | string): void => {
    if (closed) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = Buffer.concat([buffer, bytes]);
    let nl: number;
    while ((nl = buffer.indexOf(0x0a)) >= 0) {
      if (nl > MAX_MCP_FRAME_BYTES) {
        replyError(null, -32600, `request frame exceeds ${MAX_MCP_FRAME_BYTES} bytes`);
        closeInput();
        return;
      }
      const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
      buffer = buffer.subarray(nl + 1);
      if (!line) continue;
      try {
        handle(JSON.parse(line) as JsonRpcMessage);
      } catch {
        /* 非 JSON 行忽略 */
      }
    }
    if (buffer.length > MAX_MCP_FRAME_BYTES) {
      replyError(null, -32600, `request frame exceeds ${MAX_MCP_FRAME_BYTES} bytes`);
      closeInput();
    }
  };
  const closeInput = (): void => {
    if (closed) return;
    closed = true;
    buffer = Buffer.alloc(0);
    input.off("data", onData);
    input.pause?.();
  };
  input.on("data", onData);

  return {
    close() {
      closeInput();
    },
  };
}

/** 最后一条 assistant 消息的非内部文本（会话最终结论）。 */
function lastAssistantText(messages: readonly { role: string; content: any[] }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = m.content
      .filter((p) => p.type === "text" && !p.internal)
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
