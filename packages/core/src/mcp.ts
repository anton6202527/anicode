/**
 * MCP 客户端 —— 把外部 MCP server 的工具接入 core 的 ToolRegistry。
 *
 * 两种传输：
 *   - stdio（本地进程）：JSON-RPC 2.0，Content-Length 分帧（MCP 标准帧）。
 *   - Streamable HTTP（远程 server）：POST JSON-RPC 到单一 endpoint，响应为
 *     application/json 或 text/event-stream(SSE)；用 Mcp-Session-Id 维持会话。
 * 支持 initialize / tools/list / tools/call。每个 MCP 工具包装成 core Tool
 * （默认非只读——外部工具不可信，一律走权限门）。
 *
 * 自研、无外部依赖：stdio 可用「假 server 脚本」离线测试，HTTP 可用本地 http server 测试。
 *
 * 除 tools 外还支持：
 *   - per-request 超时（对齐 Codex tool_timeout_sec；默认 60s，per-server 可配）
 *   - notifications/tools/list_changed → onToolsChanged 回调（对齐 Claude Code 自动刷新）
 *   - resources/prompts 的客户端方法（listResources/readResource/listPrompts/getPrompt），
 *     供前端做 @资源 提及与 /prompt 命令；按 initialize 声明的能力裁剪。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { t } from "./i18n.js";
import type { Tool, ToolContext } from "./tools/tool.js";
import { ToolError } from "./tools/tool.js";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** MCP 请求默认超时；挂死的 server 不该无限期占住一次工具调用。 */
const DEFAULT_TIMEOUT_MS = 60_000;

/** server 声明的资源元数据（resources/list）。 */
export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

/** server 声明的 prompt 模板（prompts/list）。 */
export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
}

/** initialize 握手里 server 声明的能力面（只保留我们关心的判定位）。 */
export interface McpServerCapabilities {
  tools: boolean;
  resources: boolean;
  prompts: boolean;
}

/** 客户端事件回调（按需传入 McpClient.start / connectMcpServers）。 */
export interface McpClientHandlers {
  /** server 广播 notifications/tools/list_changed 时触发；用 listTools() 重新拉取。 */
  onToolsChanged?: () => void;
}

/** stdio 传输：本地进程 server。 */
export interface McpStdioConfig {
  /** 前缀名，工具会以 "<name>__<tool>" 暴露，避免与内置工具重名 */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 单个请求的超时（毫秒）；默认 60000。 */
  timeoutMs?: number;
}

/** Streamable HTTP 传输：远程 server（含云端官方 server）。 */
export interface McpHttpConfig {
  name: string;
  /** server endpoint（Streamable HTTP）。 */
  url: string;
  /** 附加请求头（如 Authorization: Bearer …）。 */
  headers?: Record<string, string>;
  /** 单个请求的超时（毫秒）；默认 60000。 */
  timeoutMs?: number;
}

export type McpServerConfig = McpStdioConfig | McpHttpConfig;

function isHttp(cfg: McpServerConfig): cfg is McpHttpConfig {
  return typeof (cfg as McpHttpConfig).url === "string";
}

// ---------- 传输抽象 ----------

interface McpTransport {
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params: unknown): void;
  close(): void;
  /** server 主动通知（notifications/*）的回调；由客户端在握手后设置。 */
  onNotification?: (method: string, params: unknown) => void;
}

// ---------- 客户端 ----------

export class McpClient {
  /** initialize 握手取回的 server 能力面。 */
  readonly capabilities: McpServerCapabilities;

  /** 配置里的 server 名（工具/prompt 的前缀）。 */
  get name(): string {
    return this.serverName;
  }

  private constructor(
    private readonly serverName: string,
    private readonly transport: McpTransport,
    capabilities: McpServerCapabilities,
  ) {
    this.capabilities = capabilities;
  }

  /** 启动 server（按 config 选传输）并完成 initialize 握手。 */
  static async start(cfg: McpServerConfig, handlers?: McpClientHandlers): Promise<McpClient> {
    const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const transport: McpTransport = isHttp(cfg)
      ? new HttpTransport(cfg.url, cfg.headers, timeoutMs)
      : new StdioTransport(cfg.command, cfg.args ?? [], cfg.env, timeoutMs);
    const init = await transport.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "anicode", version: "0.0.1" },
    });
    const caps = init?.capabilities ?? {};
    const client = new McpClient(cfg.name, transport, {
      tools: Boolean(caps.tools),
      resources: Boolean(caps.resources),
      prompts: Boolean(caps.prompts),
    });
    transport.onNotification = (method) => {
      if (method === "notifications/tools/list_changed") handlers?.onToolsChanged?.();
    };
    transport.notify("notifications/initialized", {});
    return client;
  }

  /** 拉取工具列表并包装成 core Tool 数组 */
  async listTools(): Promise<Tool[]> {
    const res = await this.transport.request("tools/list", {});
    const specs: McpToolSpec[] = res?.tools ?? [];
    return specs.map((spec) => this.wrap(spec));
  }

  /** 列出 server 声明的资源；server 未声明 resources 能力时返回空数组。 */
  async listResources(): Promise<McpResource[]> {
    if (!this.capabilities.resources) return [];
    const res = await this.transport.request("resources/list", {});
    return (res?.resources ?? []) as McpResource[];
  }

  /** 读取一个资源的文本内容（blob 内容以占位说明代替，不注入二进制）。 */
  async readResource(uri: string): Promise<string> {
    const res = await this.transport.request("resources/read", { uri });
    const contents: any[] = res?.contents ?? [];
    return contents
      .map((c) =>
        typeof c?.text === "string"
          ? c.text
          : t(`[binary content: ${c?.mimeType ?? "unknown"}]`, `[二进制内容: ${c?.mimeType ?? "未知类型"}]`),
      )
      .join("\n");
  }

  /** 列出 server 的 prompt 模板；未声明 prompts 能力时返回空数组。 */
  async listPrompts(): Promise<McpPrompt[]> {
    if (!this.capabilities.prompts) return [];
    const res = await this.transport.request("prompts/list", {});
    return (res?.prompts ?? []) as McpPrompt[];
  }

  /** 取一个 prompt 模板渲染后的消息文本（拼接为可直接作为用户输入的文本）。 */
  async getPrompt(name: string, args?: Record<string, string>): Promise<string> {
    const res = await this.transport.request("prompts/get", {
      name,
      ...(args ? { arguments: args } : {}),
    });
    const messages: any[] = res?.messages ?? [];
    return messages
      .map((m) => {
        const content = m?.content;
        if (typeof content?.text === "string") return content.text;
        if (Array.isArray(content))
          return content
            .filter((c: any) => typeof c?.text === "string")
            .map((c: any) => c.text)
            .join("\n");
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  close(): void {
    this.transport.close();
  }

  private wrap(spec: McpToolSpec): Tool {
    const fqName = `${this.serverName}__${spec.name}`;
    const transport = this.transport;
    const serverName = this.serverName;
    return {
      readOnly: false, // 外部工具默认不可信，走权限门
      def: {
        name: fqName,
        description: spec.description ?? `MCP 工具 ${spec.name}（来自 ${serverName}）`,
        parameters: (spec.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      },
      ruleKey: (input) => `${spec.name} ${JSON.stringify(input).slice(0, 80)}`,
      async run(input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
        const res = await transport.request("tools/call", { name: spec.name, arguments: input });
        return renderToolResult(res);
      },
    };
  }
}

// ---------- stdio 传输（Content-Length 分帧）----------

class StdioTransport implements McpTransport {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  onNotification?: (method: string, params: unknown) => void;

  constructor(
    command: string,
    args: string[],
    env: Record<string, string> | undefined,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.proc = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.on("exit", () => {
      for (const p of this.pending.values())
        p.reject(new Error(t("MCP server has exited", "MCP server 已退出")));
      this.pending.clear();
    });
  }

  request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      // 超时：挂死的 server 不该无限期占住一次工具调用；如实告知方法与时限。
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(
            new Error(
              t(
                `MCP request timed out (${method}, ${this.timeoutMs}ms)`,
                `MCP 请求超时（${method}，${this.timeoutMs}ms）`,
              ),
            ),
          );
        }
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.writeFrame({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.writeFrame({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.proc.kill();
  }

  private writeFrame(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buffer.subarray(0, sep).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buffer.length < start + len) return;
      const body = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let msg: JsonRpcResponse & { method?: string; params?: unknown };
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") {
      // 无 id + 有 method = server 通知（如 notifications/tools/list_changed）。
      if (typeof msg.method === "string") this.onNotification?.(msg.method, msg.params);
      return;
    }
    if (typeof msg.method === "string") {
      // server→client 请求（roots/list、sampling 等）：明确回「不支持」，
      // 不能沉默 —— 等着响应的 server 会挂住。
      this.writeFrame({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: "Method not supported by anicode client" },
      });
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
}

// ---------- Streamable HTTP 传输 ----------

class HttpTransport implements McpTransport {
  private nextId = 1;
  private sessionId: string | null = null;
  onNotification?: (method: string, params: unknown) => void;

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> = {},
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  async request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    // 超时覆盖整个请求（含 SSE 流式响应体的读取），abort 统一收束。
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const res = await this.post({ jsonrpc: "2.0", id, method, params }, ac.signal);
      // initialize 响应会带 Mcp-Session-Id，后续请求需回带。
      const sid = res.headers.get("mcp-session-id");
      if (sid) this.sessionId = sid;
      const message = await this.readResponse(res, id);
      if (message.error) throw new Error(`MCP ${message.error.code}: ${message.error.message}`);
      return message.result;
    } catch (err) {
      if (ac.signal.aborted) {
        throw new Error(
          t(
            `MCP request timed out (${method}, ${this.timeoutMs}ms)`,
            `MCP 请求超时（${method}，${this.timeoutMs}ms）`,
          ),
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  notify(method: string, params: unknown): void {
    // 通知无需响应；失败静默（notifications/initialized 等不影响后续）。
    void this.post({ jsonrpc: "2.0", method, params }).catch(() => {});
  }

  close(): void {
    if (!this.sessionId) return;
    // 尽力释放服务端会话；失败无妨。
    void fetch(this.url, {
      method: "DELETE",
      headers: { ...this.headers, "mcp-session-id": this.sessionId },
    }).catch(() => {});
  }

  private post(body: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
        ...this.headers,
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  }

  /** 读取一个 JSON-RPC 响应：application/json 直接解析；text/event-stream 读到匹配 id 的消息。 */
  private async readResponse(res: Response, id: number): Promise<JsonRpcResponse> {
    if (!res.ok) {
      throw new Error(
        `MCP HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    const ctype = res.headers.get("content-type") ?? "";
    if (ctype.includes("application/json")) {
      return (await res.json()) as JsonRpcResponse;
    }
    if (ctype.includes("text/event-stream")) {
      const msg = await readSseForId(res, id, this.onNotification);
      if (!msg)
        throw new Error(
          t("MCP SSE stream returned no matching response", "MCP SSE 流未返回匹配的响应"),
        );
      return msg;
    }
    // 少数 server 不带 content-type；尝试当 JSON 解析。
    const text = await res.text();
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new Error(
        t(
          `MCP response could not be parsed: ${text.slice(0, 200)}`,
          `MCP 响应无法解析: ${text.slice(0, 200)}`,
        ),
      );
    }
  }
}

/** 从 SSE 流里读出 id 匹配的 JSON-RPC 响应（读到即返回）；流内通知转交回调。 */
async function readSseForId(
  res: Response,
  id: number,
  onNotification?: (method: string, params: unknown) => void,
): Promise<JsonRpcResponse | null> {
  const body = res.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE 事件以空行分隔。
      while ((sep = indexOfDoubleNewline(buf)) >= 0) {
        const rawEvent = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^(\r?\n){1,2}/, "");
        const data = sseData(rawEvent);
        if (!data) continue;
        try {
          const msg = JSON.parse(data) as JsonRpcResponse & { method?: string; params?: unknown };
          if (msg.id === id) return msg;
          if (msg.id === undefined && typeof msg.method === "string")
            onNotification?.(msg.method, msg.params);
        } catch {
          /* 非 JSON 或部分事件，跳过 */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
  return null;
}

function indexOfDoubleNewline(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a < 0) return b;
  if (b < 0) return a;
  return Math.min(a, b);
}

/** 从一个 SSE 事件块里拼出 data: 行的内容。 */
function sseData(rawEvent: string): string {
  return rawEvent
    .split(/\r?\n/)
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
}

// ---------- 结果渲染 ----------

/** MCP tools/call 结果 → 文本（content 数组里取 text 块拼接） */
function renderToolResult(res: any): string {
  if (res?.isError) {
    throw new ToolError(extractText(res) || "MCP 工具返回错误");
  }
  return extractText(res) || "(无输出)";
}

function extractText(res: any): string {
  const content = res?.content;
  if (!Array.isArray(content)) return typeof res === "string" ? res : "";
  return content
    .filter((c: any) => c?.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

/** 便捷函数：启动多个 MCP server，收集全部工具。
 * handlers.onToolsChanged 在任一 server 广播工具变更时触发（带 server 名），
 * 调用方可对该 client 重新 listTools() 并更新自己的注册表。 */
export async function connectMcpServers(
  configs: McpServerConfig[],
  handlers?: { onToolsChanged?: (serverName: string, client: McpClient) => void },
): Promise<{
  tools: Tool[];
  clients: McpClient[];
}> {
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  for (const cfg of configs) {
    let client: McpClient;
    const perServer: McpClientHandlers = {
      onToolsChanged: () => handlers?.onToolsChanged?.(cfg.name, client),
    };
    client = await McpClient.start(cfg, perServer);
    clients.push(client);
    tools.push(...(await client.listTools()));
  }
  return { tools, clients };
}
