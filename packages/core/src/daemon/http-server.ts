/**
 * HTTP + SSE 传输 —— server-first 路线（对齐 opencode）：SessionManager 之上的
 * 另一层薄转发，与 unix socket daemon 并存、可同时开。
 *
 * 端点以 `api.ts` 的 ROUTES 表为准（单一事实源），`GET /doc` 输出 OpenAPI 3.1。
 *
 * SSE 统一信封 `{ id, type, properties }`（见 api.ts EVENTS 目录）：
 *   首帧 server.connected → session.snapshot → 实时事件。其中：
 *   - `session.event` 原样透传 SessionEvent（host 客户端兼容通道）
 *   - `message.updated` / `message.part.updated` / `message.part.delta` 是
 *     Message+Parts 投影（每会话一个共享 PartsProjector，多个订阅端看到同一批
 *     part id），供 SDK/外部客户端做 UI 无关渲染
 *   - permission.asked/replied、session.status/updated/reverted 为命名细粒度事件
 *
 * 三项 server-first 能力：
 *   1. **Last-Event-ID 续传**：可续传事件帧带 `id:`（SSE 规范字段），断线重连带
 *      `Last-Event-ID` 头或 `?lastEventId=` 时，从每流的环形缓冲增量补发；缓冲已
 *      淘汰该 id 时回落整份 session.snapshot（会话流）或直接续流（firehose）。
 *   2. **全局 firehose** `GET /events`：跨所有 live 会话的监控流（manager.subscribeAll）。
 *   3. **目录级多实例路由**：请求带 `x-anicode-directory` 头 / `?directory=` 时经
 *      `resolveInstance` 惰性路由到按目录隔离的 SessionManager（未配置则忽略、用默认实例）。
 *
 * 安全：默认只应绑定 127.0.0.1；可选 token —— 提供时所有请求须带
 * `Authorization: Bearer <token>`；SSE 同样只接受 header，凭证绝不进入 URL。
 */

import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { t } from "../i18n.js";
import { SessionManager, type SessionEvent, type SessionSnapshot } from "../session-manager.js";
import type { PermissionDecisionKind } from "../host.js";
import type { PermissionMode } from "../permission.js";
import { PartsProjector, messagesToParts } from "../parts.js";
import { createId } from "../id.js";
import { PatchSetConflictError, type PatchSetChangeInput } from "../runtime/patchset.js";
import {
  generateOpenApi,
  PROTOCOL_VERSION,
  validateRouteRequest,
  type ApiValidationIssue,
  type EventEnvelope,
} from "./api.js";

export interface HttpDaemonOptions {
  /** 默认会话实例（无目录路由、或未配置 resolveInstance 时的实例）。 */
  manager: SessionManager;
  /** 可选 Bearer token；提供时所有请求都要求携带。 */
  token?: string;
  /**
   * 目录级多实例路由（对齐 opencode 单 server 多工程）：给定请求携带的目录，
   * 返回该目录对应的 SessionManager（可异步惰性 boot）。返回值按目录 memoize。
   * 省略则不启用路由，所有请求走 `manager`。
   */
  resolveInstance?: (directory: string) => SessionManager | Promise<SessionManager>;
  /** 每个 SSE 流保留的可续传事件条数（Last-Event-ID 回放窗口）。默认 1024。 */
  replayBufferSize?: number;
  /**
   * 最后一个订阅者断开后，会话扇出（及其 replay 缓冲）延迟释放的毫秒数。
   * 让单客户端断线重连仍能在窗口内增量补发；窗口外回落整份快照。默认 15000。
   */
  feedLingerMs?: number;
  /** 监听关闭后的宿主资源清理（数据库、worker 等）。 */
  onClose?: () => void | Promise<void>;
  /** 单个 socket 地址在窗口内允许的请求数。默认每分钟 600。 */
  rateLimit?: { windowMs?: number; maxRequests?: number };
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

class HttpRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let exceeded = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      if (exceeded) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        exceeded = true;
        reject(
          new HttpRequestError(
            413,
            "REQUEST_BODY_TOO_LARGE",
            t("request body too large", "请求体过大"),
          ),
        );
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  const errorData =
    status >= 400 &&
    data &&
    typeof data === "object" &&
    typeof (data as { error?: unknown }).error === "string"
      ? {
          ...(data as Record<string, unknown>),
          code:
            (data as { code?: string }).code ??
            {
              400: "BAD_REQUEST",
              401: "UNAUTHORIZED",
              404: "NOT_FOUND",
              405: "METHOD_NOT_ALLOWED",
              409: "CONFLICT",
              413: "REQUEST_BODY_TOO_LARGE",
              415: "UNSUPPORTED_MEDIA_TYPE",
              426: "UNSUPPORTED_API_VERSION",
              500: "INTERNAL_ERROR",
            }[status] ??
            "HTTP_ERROR",
          requestId: String(res.getHeader("x-request-id") ?? "unknown"),
        }
      : data;
  const body = JSON.stringify(errorData);
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

function strictBase64(value: string): Uint8Array {
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error("invalid dataBase64");
  }
  return Buffer.from(value, "base64");
}

function envelope(type: string, properties: Record<string, unknown>): EventEnvelope {
  return { id: createId("evt"), type, properties };
}

/** 可续传事件帧：带 `id:`，浏览器 EventSource 会据此在重连时回发 Last-Event-ID。 */
function sseEvent(res: http.ServerResponse, ev: EventEnvelope): void {
  res.write(`id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`);
}

/** 控制帧（connected/heartbeat/snapshot）：不带 `id:`，不参与 Last-Event-ID 定位。 */
function sseControl(res: http.ServerResponse, ev: EventEnvelope): void {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

/** SessionEvent → 命名细粒度事件（含 Message+Parts 投影）。 */
function deriveNamedEvents(
  sessionId: string,
  projector: PartsProjector,
  event: SessionEvent,
): EventEnvelope[] {
  switch (event.type) {
    case "agent":
      return [
        ...projector
          .handle(event.event)
          .map((p) => envelope(p.type, p.properties as unknown as Record<string, unknown>)),
        ...(event.event.type === "verification"
          ? [
              envelope("verification.completed", {
                sessionId,
                report: event.event.report,
              }),
            ]
          : []),
      ];
    case "permission_request":
      return [
        envelope("permission.asked", {
          sessionId,
          permId: event.permId,
          toolName: event.toolName,
          ruleKey: event.ruleKey,
        }),
      ];
    case "permission_resolved":
      return [
        envelope("permission.replied", {
          sessionId,
          permId: event.permId,
          decision: event.decision,
        }),
      ];
    case "title":
      return [envelope("session.updated", { sessionId, title: event.title })];
    case "state":
      return [envelope("session.status", { sessionId, running: event.running })];
    case "reverted": {
      const { type: _type, ...rest } = event;
      return [envelope("session.reverted", { sessionId, ...rest })];
    }
    default:
      return [];
  }
}

/** 有界环形缓冲：支持按 Last-Event-ID 回放其后事件（未命中返回 null → 需整份重同步）。 */
class EventRing {
  private buf: EventEnvelope[] = [];
  constructor(private max: number) {}
  push(ev: EventEnvelope): void {
    this.buf.push(ev);
    if (this.buf.length > this.max) this.buf.shift();
  }
  replayAfter(id: string): EventEnvelope[] | null {
    const i = this.buf.findIndex((e) => e.id === id);
    return i === -1 ? null : this.buf.slice(i + 1);
  }
}

type Writer = (ev: EventEnvelope) => void;

/** 单会话事件扇出：一份 manager 订阅 + 一份 PartsProjector + 环形缓冲，广播给多连接。 */
interface SessionFeed {
  writers: Set<Writer>;
  ring: EventRing;
  peek: () => SessionSnapshot | undefined;
  linger?: NodeJS.Timeout;
  close: () => void;
}

/** 全局 firehose 扇出：manager.subscribeAll + 每会话惰性 projector + 环形缓冲。 */
interface Firehose {
  writers: Set<Writer>;
  ring: EventRing;
  close: () => void;
}

/** 每个 SessionManager 实例独立的流状态（目录路由下各实例互不干扰）。 */
interface InstanceStreams {
  manager: SessionManager;
  feeds: Map<string, SessionFeed>;
  firehose?: Firehose;
}

export class HttpDaemonServer {
  private server: http.Server;
  private defaultManager: SessionManager;
  private token?: string;
  private resolveInstance?: (directory: string) => SessionManager | Promise<SessionManager>;
  private replayBufferSize: number;
  private feedLingerMs: number;
  private onClose?: () => void | Promise<void>;
  private rateWindowMs: number;
  private rateMaxRequests: number;
  private requestRates = new Map<string, { startedAt: number; count: number }>();
  /** 活跃 SSE 连接的清理器，close 时逐个断开。 */
  private sseCleanups = new Set<() => void>();
  /** 目录 → 实例的 memo（并发 boot 去重）。 */
  private instances = new Map<string, Promise<SessionManager>>();
  /** manager → 流状态；close 时统一释放。 */
  private streams = new Map<SessionManager, InstanceStreams>();

  constructor(opts: HttpDaemonOptions) {
    this.defaultManager = opts.manager;
    if (opts.token) this.token = opts.token;
    if (opts.resolveInstance) this.resolveInstance = opts.resolveInstance;
    this.replayBufferSize = opts.replayBufferSize ?? 1024;
    this.feedLingerMs = opts.feedLingerMs ?? 15_000;
    this.rateWindowMs = Math.max(1_000, opts.rateLimit?.windowMs ?? 60_000);
    this.rateMaxRequests = Math.max(1, opts.rateLimit?.maxRequests ?? 600);
    if (opts.onClose) this.onClose = opts.onClose;
    this.server = http.createServer((req, res) => {
      void this.route(req, res).catch((err) => {
        if (!res.headersSent) {
          if (err instanceof HttpRequestError) {
            json(res, err.status, {
              error: err.message,
              code: err.code,
              ...(err.details !== undefined ? { details: err.details } : {}),
            });
          } else {
            json(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
        } else res.destroy(err instanceof Error ? err : undefined);
      });
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 15_000;
    this.server.keepAliveTimeout = 5_000;
    this.server.maxRequestsPerSocket = 100;
    this.server.maxConnections = 128;
  }

  /** 明文 Node HTTP server 只能绑回环；远程入口必须经同机 HTTPS/mTLS 反向代理。 */
  listen(port: number, host = "127.0.0.1"): Promise<void> {
    if (!isLoopbackHost(host)) {
      return Promise.reject(
        new Error(
          "HTTP daemon may only bind a loopback host; use a TLS reverse proxy for remote access",
        ),
      );
    }
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

  async close(): Promise<void> {
    for (const cleanup of this.sseCleanups) cleanup();
    this.sseCleanups.clear();
    for (const inst of this.streams.values()) {
      for (const feed of inst.feeds.values()) {
        if (feed.linger) clearTimeout(feed.linger);
        feed.close();
      }
      inst.firehose?.close();
    }
    this.streams.clear();
    this.requestRates.clear();
    await new Promise<void>((res) => this.server.close(() => res()));
    await this.onClose?.();
  }

  private authorized(req: http.IncomingMessage): boolean {
    if (!this.token) return true;
    const header = req.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
    const presented = Buffer.from(header.slice(7));
    const expected = Buffer.from(this.token);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  }

  private withinRateLimit(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const now = Date.now();
    const key = req.socket.remoteAddress ?? "unknown";
    let rate = this.requestRates.get(key);
    if (!rate || now - rate.startedAt >= this.rateWindowMs) {
      rate = { startedAt: now, count: 0 };
      this.requestRates.set(key, rate);
    }
    rate.count++;
    if (rate.count <= this.rateMaxRequests) return true;
    const retrySeconds = Math.max(
      1,
      Math.ceil((rate.startedAt + this.rateWindowMs - now) / 1_000),
    );
    res.setHeader("retry-after", String(retrySeconds));
    json(res, 429, { error: "rate limit exceeded", code: "RATE_LIMITED" });
    return false;
  }

  /** 按请求携带的目录路由到实例（未配置 resolveInstance 或无目录 → 默认实例）。 */
  private async managerFor(req: http.IncomingMessage, url: URL): Promise<SessionManager> {
    if (!this.resolveInstance) return this.defaultManager;
    const header = req.headers["x-anicode-directory"];
    const directory =
      (typeof header === "string" ? header : undefined) ??
      url.searchParams.get("directory") ??
      undefined;
    if (!directory) return this.defaultManager;
    let pending = this.instances.get(directory);
    if (!pending) {
      pending = Promise.resolve(this.resolveInstance(directory));
      this.instances.set(directory, pending);
      pending.catch(() => this.instances.delete(directory)); // boot 失败不缓存
    }
    return pending;
  }

  private streamsFor(manager: SessionManager): InstanceStreams {
    let inst = this.streams.get(manager);
    if (!inst) {
      inst = { manager, feeds: new Map() };
      this.streams.set(manager, inst);
    }
    return inst;
  }

  private lastEventId(req: http.IncomingMessage, url: URL): string | undefined {
    const header = req.headers["last-event-id"];
    return (
      (typeof header === "string" ? header : undefined) ??
      url.searchParams.get("lastEventId") ??
      undefined
    );
  }

  private async requestJson(req: http.IncomingMessage, url: URL): Promise<Record<string, unknown>> {
    const contentType = req.headers["content-type"];
    if (typeof contentType === "string" && !/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new HttpRequestError(
        415,
        "UNSUPPORTED_MEDIA_TYPE",
        "request content-type must be application/json",
      );
    }
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      throw new HttpRequestError(400, "INVALID_JSON", "request body is not valid JSON");
    }
    const issues: ApiValidationIssue[] = validateRouteRequest(req.method ?? "", url.pathname, body);
    if (issues.length > 0) {
      throw new HttpRequestError(
        400,
        "VALIDATION_ERROR",
        "request body failed API contract validation",
        { issues },
      );
    }
    return body as Record<string, unknown>;
  }

  private async route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const incomingRequestId = req.headers["x-request-id"];
    const requestId =
      typeof incomingRequestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(incomingRequestId)
        ? incomingRequestId
        : randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-anicode-api-version", String(PROTOCOL_VERSION));
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    if (!this.withinRateLimit(req, res)) return;
    const requestedVersion = req.headers["x-anicode-api-version"];
    if (requestedVersion !== undefined && requestedVersion !== String(PROTOCOL_VERSION)) {
      return json(res, 426, {
        error: `unsupported API version ${String(requestedVersion)}`,
        code: "UNSUPPORTED_API_VERSION",
        details: { supported: [PROTOCOL_VERSION] },
      });
    }
    if (!this.authorized(req)) return json(res, 401, { error: "unauthorized" });

    if (req.method === "GET") {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname === "/global/health")
        return json(res, 200, { ok: true, name: "anicode", protocol: PROTOCOL_VERSION });
      if (url.pathname === "/doc") return json(res, 200, generateOpenApi());
      if (url.pathname === "/events")
        return this.firehose(await this.managerFor(req, url), res, this.lastEventId(req, url));
    }

    const manager = await this.managerFor(req, url);

    if (req.method === "GET" && url.pathname === "/sessions") {
      const sessions = await manager.listSessions();
      const limitValue = url.searchParams.get("limit");
      const cursorValue = url.searchParams.get("cursor");
      if (limitValue === null && cursorValue === null) return json(res, 200, sessions);
      const limit = Number(limitValue ?? 50);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
        return json(res, 400, { error: "limit must be an integer between 1 and 200" });
      }
      let offset = 0;
      if (cursorValue) {
        try {
          const decoded = Buffer.from(cursorValue, "base64url").toString("utf8");
          const matched = /^v1:(\d+)$/.exec(decoded);
          if (!matched) throw new Error("invalid cursor");
          offset = Number(matched[1]);
          if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid cursor");
        } catch {
          return json(res, 400, { error: "cursor is invalid" });
        }
      }
      const items = sessions.slice(offset, offset + limit);
      if (offset + items.length < sessions.length) {
        res.setHeader(
          "x-anicode-next-cursor",
          Buffer.from(`v1:${offset + items.length}`, "utf8").toString("base64url"),
        );
      }
      return json(res, 200, items);
    }
    if (req.method === "POST" && url.pathname === "/sessions") {
      const body = (await this.requestJson(req, url)) as {
        cwd?: string;
        model?: string;
        title?: string;
      };
      if (!body.cwd || !body.model) return json(res, 400, { error: "cwd and model are required" });
      const meta = await manager.createSession({
        cwd: body.cwd,
        model: body.model,
        ...(body.title ? { title: body.title } : {}),
      });
      return json(res, 200, meta);
    }

    // Artifact 子资源（必须先于 /sessions/:id/:action 的两段匹配）。
    const artifactCollection = /^\/sessions\/([^/]+)\/artifacts$/.exec(url.pathname);
    if (artifactCollection) {
      const sessionId = decodeURIComponent(artifactCollection[1]!);
      if (!(await this.snapshotOf(manager, sessionId))) {
        return json(res, 404, { error: "not found" });
      }
      if (req.method === "GET") return json(res, 200, await manager.listArtifacts(sessionId));
      if (req.method === "POST") {
        const body = (await this.requestJson(req, url)) as Record<string, unknown>;
        if (
          !body.kind ||
          !body.name ||
          (body.text === undefined && body.dataBase64 === undefined)
        ) {
          return json(res, 400, { error: "kind, name and text or dataBase64 are required" });
        }
        let data: string | Uint8Array;
        if (typeof body.dataBase64 === "string") {
          try {
            data = strictBase64(body.dataBase64);
          } catch {
            return json(res, 400, { error: "invalid dataBase64" });
          }
        } else {
          data = String(body.text ?? "");
        }
        return json(
          res,
          200,
          await manager.putArtifact({
            sessionId,
            kind: String(body.kind) as import("../runtime/artifacts.js").ArtifactKind,
            name: String(body.name),
            ...(typeof body.mediaType === "string" ? { mediaType: body.mediaType } : {}),
            data,
            ...(body.metadata && typeof body.metadata === "object"
              ? { metadata: body.metadata as Record<string, unknown> }
              : {}),
          }),
        );
      }
      return json(res, 405, { error: "method not allowed" });
    }

    const artifactContent = /^\/sessions\/([^/]+)\/artifacts\/([^/]+)\/content$/.exec(url.pathname);
    if (artifactContent) {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const sessionId = decodeURIComponent(artifactContent[1]!);
      const artifactId = decodeURIComponent(artifactContent[2]!);
      const record = await manager.openArtifact(sessionId, artifactId);
      if (!record) return json(res, 404, { error: "not found" });
      const mediaType = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+(?:\s*;\s*charset=[\w-]+)?$/i.test(
        record.artifact.mediaType,
      )
        ? record.artifact.mediaType
        : "application/octet-stream";
      const checksum = Buffer.from(record.artifact.sha256, "hex").toString("base64");
      res.writeHead(200, {
        "content-type": mediaType,
        "content-length": record.artifact.sizeBytes,
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.artifact.name)}`,
        "content-digest": `sha-256=:${checksum}:`,
        etag: `"sha256:${record.artifact.sha256}"`,
        "x-content-type-options": "nosniff",
      });
      for await (const chunk of record.data) {
        if (res.destroyed) throw new Error("artifact client disconnected");
        if (!res.write(chunk)) await once(res, "drain");
      }
      res.end();
      return;
    }

    const artifactItem = /^\/sessions\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
    if (artifactItem) {
      const sessionId = decodeURIComponent(artifactItem[1]!);
      const artifactId = decodeURIComponent(artifactItem[2]!);
      if (req.method === "GET") {
        const record = await manager.getArtifact(sessionId, artifactId);
        return record
          ? json(res, 200, {
              artifact: record.artifact,
              dataBase64: Buffer.from(record.data).toString("base64"),
            })
          : json(res, 404, { error: "not found" });
      }
      if (req.method === "DELETE") {
        const deleted = await manager.deleteArtifact(sessionId, artifactId);
        return deleted ? noContent(res) : json(res, 404, { error: "not found" });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    const patchsetCollection = /^\/sessions\/([^/]+)\/patchsets$/.exec(url.pathname);
    if (patchsetCollection) {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const sessionId = decodeURIComponent(patchsetCollection[1]!);
      if (!(await this.snapshotOf(manager, sessionId))) {
        return json(res, 404, { error: "not found" });
      }
      const body = (await this.requestJson(req, url)) as Record<string, unknown>;
      if (!Array.isArray(body.changes) || body.changes.length === 0) {
        return json(res, 400, { error: "changes must be a non-empty array" });
      }
      let changes: PatchSetChangeInput[];
      try {
        changes = body.changes.map((raw, index) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error(`changes[${index}] must be an object`);
          }
          const change = raw as Record<string, unknown>;
          if (typeof change.path !== "string" || !change.path) {
            throw new Error(`changes[${index}].path is required`);
          }
          const hasText = typeof change.text === "string";
          const hasBinary = typeof change.dataBase64 === "string";
          const deleting = change.delete === true;
          const renameFrom =
            typeof change.renameFrom === "string" && change.renameFrom
              ? change.renameFrom
              : undefined;
          if (Number(hasText) + Number(hasBinary) + Number(deleting) > 1) {
            throw new Error(
              `changes[${index}] must choose only one of text, dataBase64, or delete`,
            );
          }
          if (!hasText && !hasBinary && !deleting && !renameFrom) {
            throw new Error(`changes[${index}] requires content, delete, or renameFrom`);
          }
          if (deleting && renameFrom) {
            throw new Error(`changes[${index}] cannot combine delete and renameFrom`);
          }
          return {
            path: change.path,
            ...(renameFrom ? { renameFrom } : {}),
            ...(hasText
              ? { content: change.text as string }
              : hasBinary
                ? { content: strictBase64(change.dataBase64 as string) }
                : deleting
                  ? { content: null }
                  : {}),
          };
        });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      const requiredApprovals = Number(body.requiredApprovals ?? 0);
      if (!Number.isInteger(requiredApprovals) || requiredApprovals < 0) {
        return json(res, 400, { error: "requiredApprovals must be a non-negative integer" });
      }
      const requiredRoles = body.requiredRoles ?? [];
      if (
        !Array.isArray(requiredRoles) ||
        requiredRoles.some((role) => typeof role !== "string" || !role.trim())
      ) {
        return json(res, 400, { error: "requiredRoles must contain non-empty strings" });
      }
      return json(
        res,
        200,
        await manager.preparePatchSet(sessionId, changes, {
          requiredApprovals,
          requiredRoles: requiredRoles as string[],
        }),
      );
    }

    const patchsetItem = /^\/sessions\/([^/]+)\/patchsets\/([^/]+)$/.exec(url.pathname);
    if (patchsetItem) {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const value = await manager.getPatchSet(
        decodeURIComponent(patchsetItem[1]!),
        decodeURIComponent(patchsetItem[2]!),
      );
      return value ? json(res, 200, value) : json(res, 404, { error: "not found" });
    }

    const patchsetAction =
      /^\/sessions\/([^/]+)\/patchsets\/([^/]+)\/(approve|apply|rebase|rollback)$/.exec(
        url.pathname,
      );
    if (patchsetAction) {
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const sessionId = decodeURIComponent(patchsetAction[1]!);
      const patchsetId = decodeURIComponent(patchsetAction[2]!);
      const action = patchsetAction[3]!;
      if (!(await manager.getPatchSet(sessionId, patchsetId))) {
        return json(res, 404, { error: "not found" });
      }
      const body = (await this.requestJson(req, url)) as Record<string, unknown>;
      try {
        if (action === "approve") {
          if (
            typeof body.actor !== "string" ||
            !body.actor.trim() ||
            typeof body.role !== "string" ||
            !body.role.trim() ||
            (body.decision !== "approve" && body.decision !== "reject")
          ) {
            return json(res, 400, {
              error: "actor, role and approve|reject decision are required",
            });
          }
          return json(
            res,
            200,
            await manager.approvePatchSet(sessionId, patchsetId, {
              actor: body.actor,
              role: body.role,
              decision: body.decision,
              ...(typeof body.comment === "string" ? { comment: body.comment } : {}),
            }),
          );
        }
        if (action === "apply") {
          return json(res, 200, await manager.applyPatchSet(sessionId, patchsetId));
        }
        if (action === "rebase") {
          return json(res, 200, await manager.rebasePatchSet(sessionId, patchsetId));
        }
        return json(
          res,
          200,
          await manager.rollbackPatchSet(sessionId, patchsetId, body.force === true),
        );
      } catch (error) {
        if (error instanceof PatchSetConflictError) {
          return json(res, 409, { error: error.message, paths: error.paths });
        }
        if (
          error instanceof Error &&
          /lacks required approvals| is (?:conflict|failed)/.test(error.message)
        ) {
          return json(res, 409, { error: error.message });
        }
        throw error;
      }
    }

    const runtimeResource = /^\/sessions\/([^/]+)\/(runtime-events|runtime-state)$/.exec(
      url.pathname,
    );
    if (runtimeResource) {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      const sessionId = decodeURIComponent(runtimeResource[1]!);
      if (!(await this.snapshotOf(manager, sessionId))) {
        return json(res, 404, { error: "not found" });
      }
      if (runtimeResource[2] === "runtime-state") {
        return json(res, 200, await manager.recoverRuntime(sessionId));
      }
      const after = Math.max(0, Number(url.searchParams.get("afterSequence") ?? 0) || 0);
      return json(res, 200, await manager.runtimeEvents(sessionId, after));
    }

    // /sessions/:id —— 会话资源本体
    const mSelf = /^\/sessions\/([^/]+)$/.exec(url.pathname);
    if (mSelf) {
      const sessionId = decodeURIComponent(mSelf[1]!);
      if (req.method === "GET") {
        const snap = await this.snapshotOf(manager, sessionId);
        return snap ? json(res, 200, snap) : json(res, 404, { error: "not found" });
      }
      if (req.method === "DELETE") {
        await manager.deleteSession(sessionId);
        return noContent(res);
      }
      if (req.method === "PATCH") {
        const body = (await this.requestJson(req, url)) as { title?: string };
        if (!body.title) return json(res, 400, { error: "title is required" });
        await manager.setTitle(sessionId, body.title);
        return noContent(res);
      }
      return json(res, 405, { error: "method not allowed" });
    }

    const m = /^\/sessions\/([^/]+)\/([a-z-]+)$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: "not found" });
    const sessionId = decodeURIComponent(m[1]!);
    const action = m[2]!;

    if (req.method === "GET") {
      if (action === "events") return this.sse(manager, sessionId, res, this.lastEventId(req, url));
      if (action === "messages") {
        const snap = await this.snapshotOf(manager, sessionId);
        if (!snap) return json(res, 404, { error: "not found" });
        return json(res, 200, messagesToParts(sessionId, snap.messages));
      }
      if (action === "checkpoints") return json(res, 200, manager.listCheckpoints(sessionId));
      if (action === "permission-profiles")
        return json(res, 200, await manager.listPermissionProfiles(sessionId));
    }

    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = (await this.requestJson(req, url)) as Record<string, unknown>;

    switch (action) {
      case "send": {
        const idempotencyHeader = req.headers["idempotency-key"];
        if (
          Array.isArray(idempotencyHeader) ||
          (typeof idempotencyHeader === "string" &&
            (!idempotencyHeader || idempotencyHeader.length > 256))
        ) {
          return json(res, 400, { error: "Idempotency-Key must contain 1 to 256 characters" });
        }
        const idempotencyKey =
          typeof idempotencyHeader === "string" && idempotencyHeader
            ? idempotencyHeader
            : typeof body.idempotencyKey === "string" && body.idempotencyKey
              ? body.idempotencyKey
              : undefined;
        await manager.send(
          sessionId,
          String(body.text ?? ""),
          (typeof body.model === "string" && body.model) || idempotencyKey
            ? {
                ...(typeof body.model === "string" && body.model ? { model: body.model } : {}),
                ...(idempotencyKey ? { idempotencyKey } : {}),
                ...(typeof req.headers.traceparent === "string"
                  ? { traceparent: req.headers.traceparent }
                  : {}),
              }
            : typeof req.headers.traceparent === "string"
              ? { traceparent: req.headers.traceparent }
              : undefined,
        );
        return noContent(res);
      }
      case "interrupt":
        await manager.interrupt(sessionId);
        return noContent(res);
      case "undo":
        return json(
          res,
          200,
          await manager.undo(
            sessionId,
            typeof body.checkpointId === "string" ? body.checkpointId : undefined,
            body.mode === "conversation" || body.mode === "both" ? body.mode : "files",
          ),
        );
      case "compact":
        return json(res, 200, await manager.compact(sessionId));
      case "fork":
        return json(
          res,
          200,
          await manager.forkSession(sessionId, {
            ...(typeof body.title === "string" ? { title: body.title } : {}),
            ...(typeof body.upToMessage === "number" ? { upToMessage: body.upToMessage } : {}),
          }),
        );
      case "permission": {
        const answered = await manager.answerPermission(
          sessionId,
          String(body.permId ?? ""),
          body.decision as PermissionDecisionKind,
        );
        return json(res, 200, { answered });
      }
      case "permission-mode":
        await manager.setPermissionMode(sessionId, body.mode as PermissionMode);
        return noContent(res);
      case "permission-profile": {
        const mode = await manager.setPermissionProfile(sessionId, String(body.name ?? ""));
        return json(res, 200, { mode });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  /** live 快照；未加载则经 resumeSession 懒载入（不存在返回 undefined）。 */
  private async snapshotOf(manager: SessionManager, sessionId: string) {
    const live = manager.peek(sessionId);
    if (live) return live;
    try {
      await manager.resumeSession(sessionId);
    } catch {
      return undefined;
    }
    return manager.peek(sessionId);
  }

  /** 取（或建）会话的共享事件扇出。 */
  private async sessionFeed(inst: InstanceStreams, sessionId: string): Promise<SessionFeed> {
    const existing = inst.feeds.get(sessionId);
    if (existing) {
      // 复用扇出：取消 linger 释放计时（新订阅者接管缓冲）。
      if (existing.linger) {
        clearTimeout(existing.linger);
        delete existing.linger;
      }
      return existing;
    }
    const writers = new Set<Writer>();
    const ring = new EventRing(this.replayBufferSize);
    const projector = new PartsProjector(sessionId);
    const emit = (ev: EventEnvelope) => {
      ring.push(ev);
      for (const w of writers) w(ev);
    };
    const handle = await inst.manager.open(sessionId, (event: SessionEvent) => {
      emit(envelope("session.event", { sessionId, event }));
      for (const named of deriveNamedEvents(sessionId, projector, event)) emit(named);
    });
    const feed: SessionFeed = {
      writers,
      ring,
      peek: () => inst.manager.peek(sessionId),
      close: () => {
        handle.close();
        inst.feeds.delete(sessionId);
      },
    };
    inst.feeds.set(sessionId, feed);
    return feed;
  }

  /** 订阅单会话：server.connected →（Last-Event-ID 增量补发 | session.snapshot）→ 实时。 */
  private async sse(
    manager: SessionManager,
    sessionId: string,
    res: http.ServerResponse,
    lastEventId?: string,
  ): Promise<void> {
    const inst = this.streamsFor(manager);
    const feed = await this.sessionFeed(inst, sessionId);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    sseControl(res, envelope("server.connected", { protocol: PROTOCOL_VERSION }));

    const replay = lastEventId ? feed.ring.replayAfter(lastEventId) : null;
    if (replay) {
      // 增量补发：客户端已有状态，从断点续流，无需整份快照。
      for (const ev of replay) sseEvent(res, ev);
    } else {
      // 首连或缓冲已淘汰该事件：回落整份快照重同步。
      sseControl(res, envelope("session.snapshot", { sessionId, snapshot: feed.peek() }));
    }

    this.attach(res, feed.writers, () => {
      // 最后一个订阅者断开：延迟释放，给断线重连留一个 replay 窗口。
      if (feed.writers.size > 0 || feed.linger) return;
      feed.linger = setTimeout(() => {
        if (feed.writers.size === 0) feed.close();
      }, this.feedLingerMs);
      feed.linger.unref?.(); // 不因等待释放而拖住进程退出
    });
  }

  /** 取（或建）全局 firehose 扇出（跨所有 live 会话）。 */
  private ensureFirehose(inst: InstanceStreams): Firehose {
    if (inst.firehose) return inst.firehose;
    const writers = new Set<Writer>();
    const ring = new EventRing(this.replayBufferSize);
    const projectors = new Map<string, PartsProjector>();
    const emit = (ev: EventEnvelope) => {
      ring.push(ev);
      for (const w of writers) w(ev);
    };
    const unsub = inst.manager.subscribeAll((sessionId, event) => {
      emit(envelope("session.event", { sessionId, event }));
      let projector = projectors.get(sessionId);
      if (!projector) {
        projector = new PartsProjector(sessionId);
        projectors.set(sessionId, projector);
      }
      for (const named of deriveNamedEvents(sessionId, projector, event)) emit(named);
    });
    const firehose: Firehose = {
      writers,
      ring,
      close: () => {
        unsub();
        delete inst.firehose;
      },
    };
    inst.firehose = firehose;
    return firehose;
  }

  /** 全局 firehose：server.connected →（Last-Event-ID 增量补发）→ 实时；不发快照。 */
  private firehose(manager: SessionManager, res: http.ServerResponse, lastEventId?: string): void {
    const inst = this.streamsFor(manager);
    const fh = this.ensureFirehose(inst);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write("retry: 1000\n\n");
    sseControl(res, envelope("server.connected", { protocol: PROTOCOL_VERSION }));
    const replay = lastEventId ? fh.ring.replayAfter(lastEventId) : null;
    if (replay) for (const ev of replay) sseEvent(res, ev);
    this.attach(res, fh.writers, () => {
      if (fh.writers.size === 0) fh.close();
    });
  }

  /** 挂载一个 writer 到流：心跳 + 断开清理（含引用计数回收扇出）。 */
  private attach(res: http.ServerResponse, writers: Set<Writer>, onEmpty: () => void): void {
    const writer: Writer = (ev) => sseEvent(res, ev);
    writers.add(writer);
    const heartbeat = setInterval(() => sseControl(res, envelope("server.heartbeat", {})), 30_000);
    const cleanup = () => {
      clearInterval(heartbeat);
      writers.delete(writer);
      onEmpty();
      this.sseCleanups.delete(cleanup);
      res.end();
    };
    this.sseCleanups.add(cleanup);
    res.on("close", cleanup);
  }
}
