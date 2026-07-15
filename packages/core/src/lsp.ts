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
import { pathToFileURL } from "node:url";

export interface LspServerConfig {
  /** 服务器可执行文件，如 "typescript-language-server" */
  command: string;
  args?: string[];
  /** 负责的文件扩展名，如 [".ts", ".tsx"] */
  extensions: string[];
  /** didOpen 用的 languageId，缺省按扩展名推断 */
  languageId?: string;
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

  static start(rootPath: string, cfg: LspServerConfig): LspClient {
    const proc = spawn(cfg.command, cfg.args ?? [], {
      cwd: rootPath,
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
        },
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
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private onData(chunk: Buffer): void {
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

  /** 打开文件并等待其诊断（超时返回当前已知/空）。 */
  async diagnose(absPath: string, timeoutMs = 4000): Promise<Diagnostic[]> {
    await this.initialized;
    const uri = pathToFileURL(absPath).href;
    const ext = path.extname(absPath).toLowerCase();
    const text = await fs.readFile(absPath, "utf8");
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
  ) {}

  clientFor(ext: string): LspClient | undefined {
    const e = ext.toLowerCase();
    if (this.byExt.has(e)) return this.byExt.get(e) ?? undefined;
    const cfg = pickLspServer(this.servers, e);
    if (!cfg) {
      this.byExt.set(e, null);
      return undefined;
    }
    const client = LspClient.start(this.rootPath, cfg);
    this.clients.push(client);
    this.byExt.set(e, client);
    return client;
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
    this.clients = [];
    this.byExt.clear();
  }
}

