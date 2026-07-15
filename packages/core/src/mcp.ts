/**
 * MCP 客户端（stdio transport）—— 最小实现，够把外部 MCP server 的工具
 * 接入 core 的 ToolRegistry。
 *
 * 协议：JSON-RPC 2.0 over stdio，Content-Length 分帧（MCP 标准帧格式）。
 * 支持：initialize / tools/list / tools/call。
 * 每个 MCP 工具被包装成一个 core Tool（默认非只读——外部工具不可信，一律走权限门）。
 *
 * 自研，无外部依赖，因此可用「假 MCP server 脚本」离线测试。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

export interface McpServerConfig {
  /** 前缀名，工具会以 "<name>__<tool>" 暴露，避免与内置工具重名 */
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private cfg: McpServerConfig;

  private constructor(cfg: McpServerConfig, proc: ChildProcessWithoutNullStreams) {
    this.cfg = cfg;
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    proc.on("exit", () => {
      for (const p of this.pending.values()) p.reject(new Error("MCP server 已退出"));
      this.pending.clear();
    });
  }

  /** 启动 server 进程并完成 initialize 握手 */
  static async start(cfg: McpServerConfig): Promise<McpClient> {
    const proc = spawn(cfg.command, cfg.args ?? [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...cfg.env },
    });
    const client = new McpClient(cfg, proc);
    await client.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "anicode", version: "0.0.1" },
    });
    client.notify("notifications/initialized", {});
    return client;
  }

  /** 拉取工具列表并包装成 core Tool 数组 */
  async listTools(): Promise<Tool[]> {
    const res = await this.rpc("tools/list", {});
    const specs: McpToolSpec[] = res?.tools ?? [];
    return specs.map((spec) => this.wrap(spec));
  }

  close(): void {
    this.proc.kill();
  }

  private wrap(spec: McpToolSpec): Tool {
    const fqName = `${this.cfg.name}__${spec.name}`;
    const self = this;
    return {
      readOnly: false, // 外部工具默认不可信，走权限门
      def: {
        name: fqName,
        description: spec.description ?? `MCP 工具 ${spec.name}（来自 ${self.cfg.name}）`,
        parameters: (spec.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      },
      ruleKey: (input) => `${spec.name} ${JSON.stringify(input).slice(0, 80)}`,
      async run(input: Record<string, unknown>, _ctx: ToolContext): Promise<string> {
        const res = await self.rpc("tools/call", { name: spec.name, arguments: input });
        return renderToolResult(res);
      },
    };
  }

  // ---------- JSON-RPC over stdio（Content-Length 分帧）----------

  private rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeFrame(payload);
    });
  }

  private notify(method: string, params: unknown): void {
    this.writeFrame({ jsonrpc: "2.0", method, params });
  }

  private writeFrame(obj: unknown): void {
    const body = Buffer.from(JSON.stringify(obj), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
    this.proc.stdin.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    // 循环解析：Content-Length 头 + \r\n\r\n + body
    while (true) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buffer.subarray(0, sep).toString("ascii");
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // 头损坏，丢弃到分隔符后
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      const start = sep + 4;
      if (this.buffer.length < start + len) return; // body 未到齐
      const body = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      this.handleMessage(body);
    }
  }

  private handleMessage(body: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof msg.id !== "number") return; // 通知/请求，忽略
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`MCP ${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  }
}

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

/** 便捷函数：启动多个 MCP server，收集全部工具 */
export async function connectMcpServers(configs: McpServerConfig[]): Promise<{
  tools: Tool[];
  clients: McpClient[];
}> {
  const clients: McpClient[] = [];
  const tools: Tool[] = [];
  for (const cfg of configs) {
    const client = await McpClient.start(cfg);
    clients.push(client);
    tools.push(...(await client.listTools()));
  }
  return { tools, clients };
}
