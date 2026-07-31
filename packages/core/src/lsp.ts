/**
 * 极简 LSP 客户端：把语言服务器（typescript-language-server / gopls / pyright 等）
 * 的诊断喂给 agent，让它改代码时能看到类型/语法错误。对齐 opencode 的 LSP 能力。
 *
 * 只实现「诊断」这一条最有价值的链路：
 *   initialize → initialized → textDocument/didOpen →（等）textDocument/publishDiagnostics
 *
 * 服务器由配置提供（命令 + 负责的扩展名），未配置则该能力静默关闭——不绑定具体语言。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";

export interface LspServerConfig {
  /** 服务器可执行文件，如 "typescript-language-server" */
  command: string;
  args?: string[];
  /** 负责的文件扩展名，如 [".ts", ".tsx"] */
  extensions: string[];
  /** didOpen 用的 languageId，缺省按扩展名推断 */
  languageId?: string;
  /** 单个 JSON-RPC 请求超时；默认 10000ms，防止损坏的 server 挂住 agent。 */
  timeoutMs?: number;
}

export interface Diagnostic {
  line: number; // 1 起
  column: number; // 1 起
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

const SEVERITY: Record<number, Diagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};
const MAX_LSP_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_LSP_BUFFER_BYTES = MAX_LSP_FRAME_BYTES + 64 * 1024;

/** 一处代码位置（跳转/引用结果）。line/column 均 1 起，path 为绝对路径。 */
export interface LspLocation {
  path: string;
  line: number;
  column: number;
}

/** 一个符号（文档大纲 / 工作区符号搜索结果）。 */
export interface LspSymbol {
  name: string;
  /** LSP SymbolKind 的可读名（function/class/method/…）。 */
  kind: string;
  path: string;
  line: number;
  column: number;
  /** 所属容器（类名/命名空间等），若服务器提供。 */
  container?: string;
}

/** LSP SymbolKind（1..26）→ 可读名。 */
const SYMBOL_KIND: Record<number, string> = {
  1: "file",
  2: "module",
  3: "namespace",
  4: "package",
  5: "class",
  6: "method",
  7: "property",
  8: "field",
  9: "constructor",
  10: "enum",
  11: "interface",
  12: "function",
  13: "variable",
  14: "constant",
  15: "string",
  16: "number",
  17: "boolean",
  18: "array",
  19: "object",
  20: "key",
  21: "null",
  22: "enum-member",
  23: "struct",
  24: "event",
  25: "operator",
  26: "type-parameter",
};

function posToLine(range: any): { line: number; column: number } {
  return {
    line: (range?.start?.line ?? 0) + 1,
    column: (range?.start?.character ?? 0) + 1,
  };
}

/** textDocument/definition|references 结果（Location | Location[] | LocationLink[]）归一。 */
function toLocations(res: any): LspLocation[] {
  if (!res) return [];
  const arr = Array.isArray(res) ? res : [res];
  return arr
    .map((item) => {
      const uri: string | undefined = item?.uri ?? item?.targetUri;
      const range = item?.range ?? item?.targetSelectionRange ?? item?.targetRange;
      if (!uri) return null;
      const { line, column } = posToLine(range);
      return { path: safeFsPath(uri), line, column };
    })
    .filter((l): l is LspLocation => l !== null && l.path !== "");
}

/** documentSymbol（层级 DocumentSymbol[]）与 workspace/symbol（扁平 SymbolInformation[]）归一。 */
function toSymbols(res: any, defaultPath?: string): LspSymbol[] {
  if (!Array.isArray(res)) return [];
  const out: LspSymbol[] = [];
  const walk = (items: any[], container?: string): void => {
    for (const s of items) {
      const kind = SYMBOL_KIND[s?.kind] ?? String(s?.kind ?? "");
      if (s?.location) {
        // SymbolInformation / WorkspaceSymbol（扁平，带 location）
        const { line, column } = posToLine(s.location.range);
        out.push({
          name: String(s.name ?? ""),
          kind,
          path: s.location.uri ? safeFsPath(s.location.uri) : (defaultPath ?? ""),
          line,
          column,
          ...(s.containerName ? { container: String(s.containerName) } : {}),
        });
      } else {
        // DocumentSymbol（层级，带 selectionRange + children）
        const { line, column } = posToLine(s?.selectionRange ?? s?.range);
        out.push({
          name: String(s?.name ?? ""),
          kind,
          path: defaultPath ?? "",
          line,
          column,
          ...(container ? { container } : {}),
        });
        if (Array.isArray(s?.children) && s.children.length)
          walk(s.children, String(s?.name ?? ""));
      }
    }
  };
  walk(res);
  return out;
}

function safeFsPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return "";
  }
}

function guessLanguageId(ext: string): string {
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescriptreact",
    ".js": "javascript",
    ".jsx": "javascriptreact",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
  };
  return map[ext] ?? "plaintext";
}

export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private diagnostics = new Map<string, Diagnostic[]>();
  private diagWaiters = new Map<string, ((d: Diagnostic[]) => void)[]>();
  private opened = new Set<string>();
  private initialized: Promise<void>;

  private constructor(
    proc: ChildProcessWithoutNullStreams,
    private readonly rootPath: string,
    private readonly cfg: LspServerConfig,
  ) {
    this.proc = proc;
    this.proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.proc.stderr.on("data", () => {}); // 语言服务器的 stderr 噪声忽略
    this.initialized = this.handshake();
  }

  static start(
    rootPath: string,
    cfg: LspServerConfig,
    executionRuntime?: ExecutionRuntime,
  ): LspClient {
    const prepared = executionRuntime?.prepare?.({
      command: shellCommand(cfg.command, cfg.args ?? []),
      cwd: rootPath,
      policy: "read-only",
      network: false,
    });
    if (executionRuntime && !prepared) {
      throw new Error("Persistent LSP requires an execution runtime with prepare() support");
    }
    const proc = spawn(prepared?.file ?? cfg.command, prepared?.args ?? cfg.args ?? [], {
      cwd: prepared?.cwd ?? rootPath,
      ...(prepared ? { env: prepared.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new LspClient(proc, rootPath, cfg);
  }

  private async handshake(): Promise<void> {
    await this.request("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.rootPath).href,
      capabilities: {
        textDocument: {
          publishDiagnostics: { relatedInformation: false },
          synchronization: { didSave: false },
          definition: { linkSupport: true },
          references: {},
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        },
        workspace: { symbol: {} },
      },
    });
    this.notify("initialized", {});
  }

  private send(msg: object): void {
    const json = JSON.stringify(msg);
    const payload = Buffer.from(json, "utf8");
    const header = Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii");
    this.proc.stdin.write(Buffer.concat([header, payload]));
  }

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const requested = this.cfg.timeoutMs ?? 10_000;
      const timeoutMs =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.max(100, requested), 60_000)
          : 10_000;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private onData(chunk: Buffer): void {
    if (this.buffer.length + chunk.length > MAX_LSP_BUFFER_BYTES) {
      this.failProtocol(new Error("LSP receive buffer exceeded the 8 MiB frame limit"));
      return;
    }
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const sep = this.buffer.indexOf("\r\n\r\n");
      if (sep < 0) return;
      const header = this.buffer.subarray(0, sep).toString("ascii");
      const m = /content-length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buffer = this.buffer.subarray(sep + 4);
        continue;
      }
      const len = Number(m[1]);
      if (!Number.isSafeInteger(len) || len < 0 || len > MAX_LSP_FRAME_BYTES) {
        this.failProtocol(new Error("LSP Content-Length exceeds the 8 MiB frame limit"));
        return;
      }
      const start = sep + 4;
      if (this.buffer.length < start + len) return; // 等更多数据
      const body = this.buffer.subarray(start, start + len).toString("utf8");
      this.buffer = this.buffer.subarray(start + len);
      try {
        this.dispatch(JSON.parse(body));
      } catch {
        // 半包/坏包忽略
      }
    }
  }

  private failProtocol(error: Error): void {
    this.buffer = Buffer.alloc(0);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    try {
      this.proc.kill();
    } catch {
      // already exited
    }
  }

  private dispatch(msg: any): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message ?? "LSP error"));
      else p.resolve(msg.result);
      return;
    }
    // 服务器 → 客户端请求（如 workspace/configuration）：回空，别让服务器卡住。
    if (msg.id !== undefined && msg.method) {
      this.send({ jsonrpc: "2.0", id: msg.id, result: null });
      return;
    }
    if (msg.method === "textDocument/publishDiagnostics") {
      const uri: string = msg.params.uri;
      const diags: Diagnostic[] = (msg.params.diagnostics ?? []).map((d: any) => ({
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        severity: SEVERITY[d.severity] ?? "info",
        message: d.message ?? "",
        ...(d.source ? { source: d.source } : {}),
      }));
      this.diagnostics.set(uri, diags);
      const waiters = this.diagWaiters.get(uri);
      if (waiters) {
        this.diagWaiters.delete(uri);
        for (const w of waiters) w(diags);
      }
    }
  }

  handles(ext: string): boolean {
    return this.cfg.extensions.includes(ext.toLowerCase());
  }

  /** 打开（或同步）文件，返回其 uri —— 语言请求前置：服务器需先知道文件内容。 */
  private async ensureOpen(absPath: string): Promise<string> {
    await this.initialized;
    const uri = pathToFileURL(absPath).href;
    const ext = path.extname(absPath).toLowerCase();
    const text = await fs.readFile(absPath, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_LSP_FRAME_BYTES) {
      throw new Error("LSP document exceeds the 8 MiB frame limit");
    }
    const languageId = this.cfg.languageId ?? guessLanguageId(ext);
    if (this.opened.has(uri)) {
      this.notify("textDocument/didChange", {
        textDocument: { uri, version: this.nextId++ },
        contentChanges: [{ text }],
      });
    } else {
      this.opened.add(uri);
      this.notify("textDocument/didOpen", {
        textDocument: { uri, languageId, version: 1, text },
      });
    }
    return uri;
  }

  /** 跳转到定义。position 为 0 起（LSP 原生）。 */
  async definition(
    absPath: string,
    position: { line: number; character: number },
  ): Promise<LspLocation[]> {
    const uri = await this.ensureOpen(absPath);
    const res = await this.request("textDocument/definition", { textDocument: { uri }, position });
    return toLocations(res);
  }

  /** 查找引用（含声明）。position 为 0 起。 */
  async references(
    absPath: string,
    position: { line: number; character: number },
  ): Promise<LspLocation[]> {
    const uri = await this.ensureOpen(absPath);
    const res = await this.request("textDocument/references", {
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    return toLocations(res);
  }

  /** 文件大纲（该文件内所有符号）。 */
  async documentSymbols(absPath: string): Promise<LspSymbol[]> {
    const uri = await this.ensureOpen(absPath);
    const res = await this.request("textDocument/documentSymbol", { textDocument: { uri } });
    return toSymbols(res, absPath);
  }

  /** 工作区符号搜索（按名字跨文件找定义）。 */
  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    await this.initialized;
    const res = await this.request("workspace/symbol", { query });
    return toSymbols(res);
  }

  /** 打开文件并等待其诊断（超时返回当前已知/空）。 */
  async diagnose(absPath: string, timeoutMs = 4000): Promise<Diagnostic[]> {
    const uri = await this.ensureOpen(absPath);
    return new Promise<Diagnostic[]>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const done = (d: Diagnostic[]) => {
        clearTimeout(timer);
        resolve(d);
      };
      const arr = this.diagWaiters.get(uri) ?? [];
      arr.push(done);
      this.diagWaiters.set(uri, arr);
      timer = setTimeout(() => {
        const waiters = this.diagWaiters.get(uri);
        if (waiters?.includes(done)) {
          this.diagWaiters.set(
            uri,
            waiters.filter((w) => w !== done),
          );
        }
        resolve(this.diagnostics.get(uri) ?? []);
      }, timeoutMs);
    });
  }

  close(): void {
    try {
      this.proc.kill();
    } catch {
      // 忽略
    }
  }
}

/** 从配置数组里挑出负责某扩展名的服务器（第一个匹配）。 */
export function pickLspServer(
  servers: LspServerConfig[],
  ext: string,
): LspServerConfig | undefined {
  const e = ext.toLowerCase();
  return servers.find((s) => s.extensions.map((x) => x.toLowerCase()).includes(e));
}

/** 语言服务器池：按扩展名惰性启动并复用客户端，不匹配的扩展名缓存为「无服务器」。 */
export class LspPool {
  private clients: LspClient[] = [];
  private byExt = new Map<string, LspClient | null>();

  constructor(
    private readonly rootPath: string,
    private readonly servers: LspServerConfig[],
    private readonly executionRuntime?: ExecutionRuntime,
  ) {}

  clientFor(ext: string): LspClient | undefined {
    const e = ext.toLowerCase();
    if (this.byExt.has(e)) return this.byExt.get(e) ?? undefined;
    const cfg = pickLspServer(this.servers, e);
    if (!cfg) {
      this.byExt.set(e, null);
      return undefined;
    }
    const client = LspClient.start(this.rootPath, cfg, this.executionRuntime);
    this.clients.push(client);
    this.byExt.set(e, client);
    return client;
  }

  /** 启动（并返回）每个已配置服务器各一个客户端 —— workspace/symbol 需跨语言查询。 */
  ensureAllStarted(): LspClient[] {
    for (const cfg of this.servers) {
      const ext = cfg.extensions[0];
      if (ext) this.clientFor(ext);
    }
    return this.clients;
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
    this.clients = [];
    this.byExt.clear();
  }
}

function shellCommand(file: string, args: readonly string[]): string {
  return [file, ...args].map((part) => `'${part.replace(/'/g, `'"'"'`)}'`).join(" ");
}
