/**
 * HTTP + SSE 传输 —— server-first 路线（对齐 opencode）：SessionManager 之上的
 * 另一层薄转发，与 unix socket daemon 并存、可同时开。
 *
 * 端点（JSON）：
 *   GET  /healthz                                → { ok: true }
 *   GET  /sessions                               → SessionSummary[]
 *   POST /sessions            {cwd,model,title?} → SessionSummary
 *   GET  /sessions/:id/events                    → SSE：先推 `snapshot`，随后每个
 *                                                  会话事件一条 `session` event
 *   POST /sessions/:id/send   {text,model?}      → 204（drive 收尾后返回）
 *   POST /sessions/:id/interrupt                 → 204
 *   POST /sessions/:id/undo   {checkpointId?}    → { restored, deleted }
 *   POST /sessions/:id/permission {permId,decision} → { answered }
 *   POST /sessions/:id/permission-mode {mode}    → 204
 *   POST /sessions/:id/permission-profile {name} → { mode }
 *   GET  /sessions/:id/permission-profiles       → Record<name, PermissionProfile>
 *
 * 安全：默认只应绑定 127.0.0.1；可选 token —— 提供时所有请求须带
 * `Authorization: Bearer <token>`（SSE 亦可用 `?token=` 查询参数，便于 EventSource）。
 */

import * as http from "node:http";
import { t } from "../i18n.js";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import type { PermissionDecisionKind } from "../host.js";
import type { PermissionMode } from "../permission.js";

export interface HttpDaemonOptions {
  manager: SessionManager;
  /** 可选 Bearer token；提供时所有请求都要求携带。 */
  token?: string;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(t("request body too large", "请求体过大")));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function noContent(res: http.ServerResponse): void {
  res.writeHead(204);
  res.end();
}

/** SSE 帧：JSON 无裸换行，单 data 行即可。 */
function sseWrite(res: http.ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export class HttpDaemonServer {
  private server: http.Server;
  private manager: SessionManager;
  private token?: string;
  /** 活跃 SSE 连接的清理器，close 时逐个断开。 */
  private sseCleanups = new Set<() => void>();

  constructor(opts: HttpDaemonOptions) {
    this.manager = opts.manager;
    if (opts.token) this.token = opts.token;
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        if (!res.headersSent)
          json(res, 500, { error: err instanceof Error ? err.message : String(err) });
        else res.end();
      });
    });
  }

  /** 监听：默认只绑回环地址；绑 0.0.0.0 请务必配 token。 */
  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((res, rej) => {
      this.server.once("error", rej);
      this.server.listen(port, host, () => res());
    });
  }

  /** 实际监听端口（listen(0) 随机端口时用）。 */
  port(): number {
    const addr = this.server.address();
    return typeof addr === "object" && addr ? addr.port : 0;
  }

  close(): Promise<void> {
    for (const cleanup of this.sseCleanups) cleanup();
    this.sseCleanups.clear();
    return new Promise((res) => this.server.close(() => res()));
  }

  private authorized(req: http.IncomingMessage, url: URL): boolean {
    if (!this.token) return true;
    const header = req.headers.authorization;
    if (header === `Bearer ${this.token}`) return true;
    // EventSource 无法设 header，允许 SSE 用查询参数带 token。
    return url.searchParams.get("token") === this.token;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!this.authorized(req, url)) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET" && url.pathname === "/healthz") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/sessions")
      return json(res, 200, await this.manager.listSessions());
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = JSON.parse((await readBody(req)) || "{}") as {
        cwd?: string;
        model?: string;
        title?: string;
      };
      if (!body.cwd || !body.model) return json(res, 400, { error: "cwd and model are required" });
      const meta = await this.manager.createSession({
        cwd: body.cwd,
        model: body.model,
        ...(body.title ? { title: body.title } : {}),
      });
      return json(res, 200, meta);
    }

    const m = /^\/sessions\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: "not found" });
    const sessionId = decodeURIComponent(m[1]!);
    const action = m[2]!;

    if (req.method === "GET" && action === "events") return this.sse(sessionId, res);
    if (req.method === "GET" && action === "permission-profiles")
      return json(res, 200, await this.manager.listPermissionProfiles(sessionId));

    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>;

    switch (action) {
      case "send":
        await this.manager.send(
          sessionId,
          String(body.text ?? ""),
          typeof body.model === "string" && body.model ? { model: body.model } : undefined,
        );
        return noContent(res);
      case "interrupt":
        await this.manager.interrupt(sessionId);
        return noContent(res);
      case "undo":
        return json(
          res,
          200,
          await this.manager.undo(
            sessionId,
            typeof body.checkpointId === "string" ? body.checkpointId : undefined,
            body.mode === "conversation" || body.mode === "both" ? body.mode : "files",
          ),
        );
      case "compact":
        return json(res, 200, await this.manager.compact(sessionId));
      case "fork":
        return json(
          res,
          200,
          await this.manager.forkSession(sessionId, {
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.upToMessage === "number" ? { upToMessage: body.upToMessage } : {}),
          }),
        );
      case "permission": {
        const answered = await this.manager.answerPermission(
          sessionId,
          String(body.permId ?? ""),
          body.decision as PermissionDecisionKind,
        );
        return json(res, 200, { answered });
      }
      case "permission-mode":
        await this.manager.setPermissionMode(sessionId, body.mode as PermissionMode);
        return noContent(res);
      case "permission-profile": {
        const mode = await this.manager.setPermissionProfile(sessionId, String(body.name ?? ""));
        return json(res, 200, { mode });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  /** 订阅会话：snapshot 先行，之后事件实时推送；连接断开即退订。 */
  private async sse(sessionId: string, res: http.ServerResponse): Promise<void> {
    const listener = (event: SessionEvent) => sseWrite(res, "session", event);
    const handle = await this.manager.open(sessionId, listener);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    sseWrite(res, "snapshot", handle.snapshot);
    // 心跳注释行防中间层空闲超时断连。
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 30_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      handle.close();
      this.sseCleanups.delete(cleanup);
      res.end();
    };
    this.sseCleanups.add(cleanup);
    res.on("close", cleanup);
  }
}
