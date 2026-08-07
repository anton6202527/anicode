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
 * 安全：默认只应绑定 127.0.0.1；除健康检查外，REST/SSE 默认强制 Bearer token。
 * 凭证只接受 `Authorization` header，绝不进入 URL。
 */

import * as http from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { t } from "../i18n.js";
import { SessionManager, type SessionEvent, type SessionSnapshot } from "../session-manager.js";
import type { PermissionDecisionKind } from "../host.js";
import type { PermissionMode } from "../permission.js";
import {
  discoverProviderModels,
  sanitizeDiscoveredModels,
  sanitizeProviderId,
} from "../provider/registry.js";
import { PartsProjector, messagesToParts } from "../parts.js";
import { createId } from "../id.js";
import { PatchSetConflictError, type PatchSetChangeInput } from "../runtime/patchset.js";
import { CommandIdempotencyConflictError } from "../runtime/commands.js";
import {
  generateOpenApi,
  PROTOCOL_VERSION,
  validateRouteRequest,
  type ApiValidationIssue,
  type EventEnvelope,
} from "./api.js";
import { generateDaemonAuthToken, validateDaemonAuthToken } from "./auth-token.js";

export interface HttpDaemonOptions {
  /** 默认会话实例（无目录路由、或未配置 resolveInstance 时的实例）。 */
  manager: SessionManager;
  /** Test/embedding override; production defaults to the core provider registry. */
  discoverModels?: (providerId: string) => Promise<string[] | undefined>;
  /** Bearer token；省略时安全生成 256-bit token，除健康检查外均强制携带。 */
  token?: string;
  /**
   * 目录级多实例路由（对齐 opencode 单 server 多工程）：给定请求携带的目录，
   * 返回该目录对应的 SessionManager（可异步惰性 boot）。返回值按目录 memoize。
   * 省略则不启用路由，所有请求走 `manager`。
   */
  resolveInstance?: (directory: string) => SessionManager | Promise<SessionManager>;
  /** 每个 SSE 流保留的可续传事件条数（Last-Event-ID 回放窗口）。默认 1024。 */
  replayBufferSize?: number;
  /** 每个 SSE replay ring 的序列化字节上限。默认 8 MiB。 */
  replayBufferBytes?: number;
  /**
   * 慢 SSE 客户端的进程内待发送上限。超过任一上限即断开该客户端，让其携带
   * Last-Event-ID 重连，避免一个不读数据的终端无限占用 daemon 内存。
   */
  sseClientBuffer?: { maxPendingBytes?: number; maxPendingEvents?: number };
  /**
   * 最后一个订阅者断开后，会话扇出（及其 replay 缓冲）延迟释放的毫秒数。
   * 让单客户端断线重连仍能在窗口内增量补发；窗口外回落整份快照。默认 15000。
   */
  feedLingerMs?: number;
  /** 监听关闭后的宿主资源清理（数据库、worker 等）。 */
  onClose?: () => void | Promise<void>;
  /** 单个 socket 地址在窗口内允许的请求数。默认每分钟 600。 */
  rateLimit?: { windowMs?: number; maxRequests?: number };
  /** Graceful shutdown window before active HTTP sockets are force-closed. Default: 5 seconds. */
  shutdownGraceMs?: number;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_SSE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const INLINE_SSE_SNAPSHOT_BYTES = 1024 * 1024;
const SSE_SNAPSHOT_CHUNK_CHARS = 128 * 1024;

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
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

/** A disconnected download must release its async iterator instead of waiting forever on drain. */
export function waitForHttpDrain(res: http.ServerResponse): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    return Promise.reject(new Error("artifact client disconnected before response drain"));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    const complete = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => complete();
    const onClose = () => complete(new Error("artifact client disconnected before response drain"));
    const onError = (error: Error) => complete(error);
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
    // Cover a close which raced the listener installation.
    if (res.destroyed || res.writableEnded) onClose();
  });
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
function sseEventFrame(ev: EventEnvelope): string {
  return `id: ${ev.id}\ndata: ${JSON.stringify(ev)}\n\n`;
}

/** 控制帧（connected/heartbeat/snapshot）：不带 `id:`，不参与 Last-Event-ID 定位。 */
function sseControlFrame(ev: EventEnvelope): string {
  return `data: ${JSON.stringify(ev)}\n\n`;
}

/** @internal Minimal ServerResponse surface used by the bounded SSE writer. */
export interface SseWritable {
  write(frame: string): boolean;
  readonly writableLength?: number;
  on(event: "drain", listener: () => void): unknown;
  off(event: "drain", listener: () => void): unknown;
}

/** @internal Exported for deterministic backpressure tests; not re-exported from the package. */
export class SseBackpressureWriter {
  private readonly queue: { frame: string; bytes: number }[] = [];
  private queuedBytes = 0;
  private blocked = false;
  private closed = false;
  private readonly flushWaiters = new Set<{
    resolve: () => void;
    reject: (error: Error) => void;
  }>();

  constructor(
    private readonly sink: SseWritable,
    private readonly limits: { maxPendingBytes: number; maxPendingEvents: number },
    private readonly onOverflow: () => void,
  ) {
    sink.on("drain", this.drain);
  }

  raw(frame: string): boolean {
    if (this.closed) return false;
    const bytes = Buffer.byteLength(frame);
    if (bytes > this.limits.maxPendingBytes) return this.overflow();
    if (this.blocked) {
      if (
        this.queue.length >= this.limits.maxPendingEvents ||
        this.queuedBytes + bytes > this.limits.maxPendingBytes
      ) {
        return this.overflow();
      }
      this.queue.push({ frame, bytes });
      this.queuedBytes += bytes;
      return true;
    }
    return this.writeToSink(frame);
  }

  event(ev: EventEnvelope): boolean {
    return this.raw(sseEventFrame(ev));
  }

  control(ev: EventEnvelope): boolean {
    return this.raw(sseControlFrame(ev));
  }

  async rawAndFlush(frame: string): Promise<void> {
    if (!this.raw(frame)) throw new Error("SSE connection is closed");
    await this.flushed();
  }

  async eventAndFlush(ev: EventEnvelope): Promise<void> {
    await this.rawAndFlush(sseEventFrame(ev));
  }

  async controlAndFlush(ev: EventEnvelope): Promise<void> {
    await this.rawAndFlush(sseControlFrame(ev));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.sink.off("drain", this.drain);
    this.rejectFlushWaiters(new Error("SSE connection closed"));
  }

  private readonly drain = (): void => {
    if (this.closed) return;
    this.blocked = false;
    while (!this.blocked && this.queue.length > 0) {
      const next = this.queue.shift()!;
      this.queuedBytes -= next.bytes;
      if (!this.writeToSink(next.frame)) return;
    }
    if (!this.blocked && this.queue.length === 0) this.resolveFlushWaiters();
  };

  private writeToSink(frame: string): boolean {
    try {
      if (!this.sink.write(frame)) {
        this.blocked = true;
        if ((this.sink.writableLength ?? 0) > this.limits.maxPendingBytes) {
          return this.overflow();
        }
      }
      return true;
    } catch {
      return this.overflow();
    }
  }

  private overflow(): false {
    if (this.closed) return false;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.sink.off("drain", this.drain);
    this.rejectFlushWaiters(new Error("SSE client exceeded the pending buffer limit"));
    this.onOverflow();
    return false;
  }

  private flushed(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("SSE connection closed"));
    if (!this.blocked && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.flushWaiters.add({ resolve, reject });
    });
  }

  private resolveFlushWaiters(): void {
    for (const waiter of this.flushWaiters) waiter.resolve();
    this.flushWaiters.clear();
  }

  private rejectFlushWaiters(error: Error): void {
    for (const waiter of this.flushWaiters) waiter.reject(error);
    this.flushWaiters.clear();
  }
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
    case "workspace_trust":
      return [
        envelope("workspace.trust", {
          sessionId,
          assessment: event.assessment,
        }),
      ];
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
  private buf: { event: EventEnvelope; bytes: number }[] = [];
  private bytes = 0;
  constructor(
    private max: number,
    private maxBytes: number,
  ) {}
  push(ev: EventEnvelope): void {
    const bytes = Buffer.byteLength(sseEventFrame(ev));
    if (bytes > this.maxBytes) {
      // The live writer applies its own bound. Do not retain one adversarial event forever;
      // reconnecting session clients will fall back to a fresh snapshot.
      this.buf = [];
      this.bytes = 0;
      return;
    }
    this.buf.push({ event: ev, bytes });
    this.bytes += bytes;
    while (this.buf.length > this.max || this.bytes > this.maxBytes) {
      this.bytes -= this.buf.shift()!.bytes;
    }
  }
  replayAfter(id: string): EventEnvelope[] | null {
    const i = this.buf.findIndex((item) => item.event.id === id);
    return i === -1 ? null : this.buf.slice(i + 1).map((item) => item.event);
  }
  clear(): void {
    this.buf = [];
    this.bytes = 0;
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
  feedLoads: Map<string, Promise<SessionFeed>>;
  /** Monotonic revocation generation; a pre-delete lazy load may never publish into a new epoch. */
  feedEpochs: Map<string, number>;
  firehose?: Firehose;
}

interface SseAttachment {
  connection: SseBackpressureWriter;
  activate: () => void;
}

export class HttpDaemonServer {
  private server: http.Server;
  private defaultManager: SessionManager;
  private readonly providerModelDiscovery: (providerId: string) => Promise<string[] | undefined>;
  private readonly token: string;
  private resolveInstance?: (directory: string) => SessionManager | Promise<SessionManager>;
  private replayBufferSize: number;
  private replayBufferBytes: number;
  private sseMaxPendingBytes: number;
  private sseMaxPendingEvents: number;
  private feedLingerMs: number;
  private onClose?: () => void | Promise<void>;
  private rateWindowMs: number;
  private rateMaxRequests: number;
  private shutdownGraceMs: number;
  private closing: Promise<void> | undefined;
  private requestRates = new Map<string, { startedAt: number; count: number }>();
  /** 活跃 SSE 连接的清理器，close 时逐个断开。 */
  private sseCleanups = new Set<() => void>();
  /** Attachments grouped by their feed, used to revoke streams before deleting a session. */
  private attachedCleanups = new Map<Set<Writer>, Set<(destroy?: boolean) => void>>();
  private deletingSessions = new Map<SessionManager, Map<string, number>>();
  /** 目录 → 实例的 memo（并发 boot 去重）。 */
  private instances = new Map<string, Promise<SessionManager>>();
  /** manager → 流状态；close 时统一释放。 */
  private streams = new Map<SessionManager, InstanceStreams>();

  constructor(opts: HttpDaemonOptions) {
    this.defaultManager = opts.manager;
    this.providerModelDiscovery = opts.discoverModels ?? discoverProviderModels;
    this.token =
      opts.token !== undefined ? validateDaemonAuthToken(opts.token) : generateDaemonAuthToken();
    if (opts.resolveInstance) this.resolveInstance = opts.resolveInstance;
    this.replayBufferSize = opts.replayBufferSize ?? 1024;
    this.replayBufferBytes = Math.max(64 * 1024, opts.replayBufferBytes ?? 8 * 1024 * 1024);
    this.sseMaxPendingBytes = Math.max(
      64 * 1024,
      opts.sseClientBuffer?.maxPendingBytes ?? 8 * 1024 * 1024,
    );
    this.sseMaxPendingEvents = Math.max(1, opts.sseClientBuffer?.maxPendingEvents ?? 1024);
    this.feedLingerMs = opts.feedLingerMs ?? 15_000;
    this.rateWindowMs = Math.max(1_000, opts.rateLimit?.windowMs ?? 60_000);
    this.rateMaxRequests = Math.max(1, opts.rateLimit?.maxRequests ?? 600);
    this.shutdownGraceMs = Math.max(100, Math.min(60_000, opts.shutdownGraceMs ?? 5_000));
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
          } else if (err instanceof CommandIdempotencyConflictError) {
            json(res, 409, { error: err.message, code: err.code });
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
    this.server.maxHeadersCount = 100;
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

  /** Trusted in-process launchers use this to configure clients or a private runtime token file. */
  authenticationToken(): string {
    return this.token;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    for (const cleanup of this.sseCleanups) cleanup();
    this.sseCleanups.clear();
    await Promise.allSettled(
      [...this.streams.values()].flatMap((inst) => [...inst.feedLoads.values()]),
    );
    for (const inst of this.streams.values()) {
      for (const feed of inst.feeds.values()) {
        if (feed.linger) clearTimeout(feed.linger);
        feed.close();
      }
      inst.firehose?.close();
    }
    this.streams.clear();
    this.attachedCleanups.clear();
    this.deletingSessions.clear();
    this.requestRates.clear();
    const listenerClosed = new Promise<void>((resolve, reject) => {
      this.server.close((error?: Error) => {
        if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    this.server.closeIdleConnections();
    let graceTimer: NodeJS.Timeout | undefined;
    const graceful = await Promise.race([
      listenerClosed.then(() => true),
      new Promise<false>((resolve) => {
        graceTimer = setTimeout(() => resolve(false), this.shutdownGraceMs);
        graceTimer.unref();
      }),
    ]);
    if (graceTimer) clearTimeout(graceTimer);
    if (!graceful) {
      this.server.closeAllConnections();
      await listenerClosed;
    }
    await this.onClose?.();
  }

  private authorized(req: http.IncomingMessage): boolean {
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
    const retrySeconds = Math.max(1, Math.ceil((rate.startedAt + this.rateWindowMs - now) / 1_000));
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
      inst = { manager, feeds: new Map(), feedLoads: new Map(), feedEpochs: new Map() };
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
    if (req.method === "GET") {
      if (url.pathname === "/healthz") return json(res, 200, { ok: true });
      if (url.pathname === "/global/health")
        return json(res, 200, { ok: true, name: "anicode", protocol: PROTOCOL_VERSION });
    }
    if (!this.authorized(req)) {
      res.setHeader("www-authenticate", 'Bearer realm="anicode"');
      return json(res, 401, { error: "unauthorized" });
    }

    const providerModels = /^\/providers\/([^/]+)\/models$/.exec(url.pathname);
    if (providerModels) {
      if (req.method !== "GET") return json(res, 405, { error: "method not allowed" });
      let decodedProviderId: string;
      try {
        decodedProviderId = decodeURIComponent(providerModels[1]!);
      } catch {
        return json(res, 400, { error: "invalid provider id" });
      }
      const providerId = sanitizeProviderId(decodedProviderId);
      if (!providerId) return json(res, 400, { error: "invalid provider id" });
      let models: string[] | undefined;
      try {
        models = sanitizeDiscoveredModels(await this.providerModelDiscovery(providerId));
      } catch {
        // Provider/network errors are an expected negative probe result. Do not expose upstream
        // credential or endpoint details and never fall back to a static catalog here.
        models = undefined;
      }
      return json(res, 200, { providerId, models: models ?? null });
    }

    if (req.method === "GET") {
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
        if (!res.write(chunk)) await waitForHttpDrain(res);
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
        this.markSessionDeleting(manager, sessionId, true);
        try {
          // Start the authoritative durable fence before doing any stream cleanup. In particular,
          // a lazy manager.open() may be hung in feedLoads and must never delay the deletion claim.
          const deletion = manager.deleteSession(sessionId);
          // Revocation is synchronous and bounded: close all materialized replay sources now and
          // attach a generation fence to any pending load without awaiting that untrusted promise.
          this.invalidateSessionStreams(manager, sessionId);
          await deletion;
          return noContent(res);
        } finally {
          // Catch a feed that materialized while durable deletion was draining its admitted work.
          this.invalidateSessionStreams(manager, sessionId);
          this.markSessionDeleting(manager, sessionId, false);
        }
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
      if (action === "checkpoints") return json(res, 200, await manager.listCheckpoints(sessionId));
      if (action === "permission-profiles")
        return json(res, 200, await manager.listPermissionProfiles(sessionId));
    }

    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = (await this.requestJson(req, url)) as Record<string, unknown>;

    switch (action) {
      case "send": {
        const idempotencyHeader = req.headers["idempotency-key"];
        const traceparentHeader = req.headers.traceparent;
        if (
          Array.isArray(idempotencyHeader) ||
          (typeof idempotencyHeader === "string" &&
            (!idempotencyHeader || idempotencyHeader.length > 256))
        ) {
          return json(res, 400, { error: "Idempotency-Key must contain 1 to 256 characters" });
        }
        if (
          Array.isArray(traceparentHeader) ||
          (typeof traceparentHeader === "string" &&
            (!traceparentHeader || traceparentHeader.length > 512))
        ) {
          return json(res, 400, { error: "traceparent must contain 1 to 512 characters" });
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
                ...(typeof traceparentHeader === "string"
                  ? { traceparent: traceparentHeader }
                  : {}),
              }
            : typeof traceparentHeader === "string"
              ? { traceparent: traceparentHeader }
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
            ...(typeof body.model === "string" ? { model: body.model } : {}),
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

  private markSessionDeleting(manager: SessionManager, sessionId: string, deleting: boolean): void {
    let sessions = this.deletingSessions.get(manager);
    if (deleting) {
      if (!sessions) {
        sessions = new Map();
        this.deletingSessions.set(manager, sessions);
      }
      sessions.set(sessionId, (sessions.get(sessionId) ?? 0) + 1);
      return;
    }
    const count = sessions?.get(sessionId) ?? 0;
    if (count <= 1) sessions?.delete(sessionId);
    else sessions?.set(sessionId, count - 1);
    if (sessions?.size === 0) this.deletingSessions.delete(manager);
  }

  private sessionIsDeleting(manager: SessionManager, sessionId: string): boolean {
    return (this.deletingSessions.get(manager)?.get(sessionId) ?? 0) > 0;
  }

  private closeAttached(writers: Set<Writer>): void {
    for (const cleanup of [...(this.attachedCleanups.get(writers) ?? [])]) cleanup(true);
  }

  private invalidateSessionStreams(manager: SessionManager, sessionId: string): void {
    const inst = this.streams.get(manager);
    if (!inst) return;
    inst.feedEpochs.set(sessionId, (inst.feedEpochs.get(sessionId) ?? 0) + 1);
    const feed = inst.feeds.get(sessionId);
    if (feed) {
      if (feed.linger) clearTimeout(feed.linger);
      this.closeAttached(feed.writers);
      feed.ring.clear();
      feed.close();
    }
    // Never await a lazy load here. Its manager.open() may be blocked indefinitely. The epoch
    // check in sessionFeed prevents publication, while this continuation closes even a custom
    // manager implementation that resolves with a handle after the durable delete completes.
    const pending = inst.feedLoads.get(sessionId);
    if (pending) {
      void pending.then(
        (loaded) => {
          if (loaded.linger) clearTimeout(loaded.linger);
          this.closeAttached(loaded.writers);
          loaded.ring.clear();
          loaded.close();
        },
        () => undefined,
      );
    }
    // The global ring can contain this session and active firehose writers can have its frames
    // queued. Revoke the whole firehose; clients reconnect and rebuild from current live state.
    const firehose = inst.firehose;
    if (firehose) {
      this.closeAttached(firehose.writers);
      firehose.ring.clear();
      firehose.close();
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
    const pending = inst.feedLoads.get(sessionId);
    if (pending) return pending;
    const feedEpoch = inst.feedEpochs.get(sessionId) ?? 0;
    const load = (async (): Promise<SessionFeed> => {
      if (this.sessionIsDeleting(inst.manager, sessionId)) {
        throw new HttpRequestError(404, "NOT_FOUND", "session is being deleted");
      }
      const writers = new Set<Writer>();
      const ring = new EventRing(this.replayBufferSize, this.replayBufferBytes);
      const projector = new PartsProjector(sessionId);
      const emit = (ev: EventEnvelope) => {
        ring.push(ev);
        for (const w of writers) w(ev);
      };
      const handle = await inst.manager
        .open(sessionId, (event: SessionEvent) => {
          emit(envelope("session.event", { sessionId, event }));
          for (const named of deriveNamedEvents(sessionId, projector, event)) emit(named);
        })
        .catch((error: unknown) => {
          if (
            this.sessionIsDeleting(inst.manager, sessionId) ||
            (inst.feedEpochs.get(sessionId) ?? 0) !== feedEpoch
          ) {
            throw new HttpRequestError(404, "NOT_FOUND", "session is being deleted");
          }
          throw error;
        });
      let closed = false;
      const feed: SessionFeed = {
        writers,
        ring,
        peek: () => inst.manager.peek(sessionId),
        close: () => {
          if (closed) return;
          closed = true;
          if (feed.linger) clearTimeout(feed.linger);
          ring.clear();
          writers.clear();
          handle.close();
          inst.feeds.delete(sessionId);
        },
      };
      if (
        this.sessionIsDeleting(inst.manager, sessionId) ||
        (inst.feedEpochs.get(sessionId) ?? 0) !== feedEpoch
      ) {
        feed.close();
        throw new HttpRequestError(404, "NOT_FOUND", "session is being deleted");
      }
      inst.feeds.set(sessionId, feed);
      return feed;
    })();
    inst.feedLoads.set(sessionId, load);
    try {
      return await load;
    } finally {
      if (inst.feedLoads.get(sessionId) === load) inst.feedLoads.delete(sessionId);
    }
  }

  /** 订阅单会话：server.connected →（Last-Event-ID 增量补发 | session.snapshot）→ 实时。 */
  private async sse(
    manager: SessionManager,
    sessionId: string,
    res: http.ServerResponse,
    lastEventId?: string,
  ): Promise<void> {
    if (this.sessionIsDeleting(manager, sessionId)) {
      throw new HttpRequestError(404, "NOT_FOUND", "session is being deleted");
    }
    if (!(await this.snapshotOf(manager, sessionId))) {
      throw new HttpRequestError(404, "NOT_FOUND", "session not found");
    }
    const inst = this.streamsFor(manager);
    const feed = await this.sessionFeed(inst, sessionId);
    if (this.sessionIsDeleting(manager, sessionId)) {
      throw new HttpRequestError(404, "NOT_FOUND", "session is being deleted");
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const onEmpty = () => {
      // 最后一个订阅者断开：延迟释放，给断线重连留一个 replay 窗口。
      if (inst.feeds.get(sessionId) !== feed || feed.writers.size > 0 || feed.linger) return;
      feed.linger = setTimeout(() => {
        if (feed.writers.size === 0) feed.close();
      }, this.feedLingerMs);
      feed.linger.unref?.();
    };
    const pending: { event: EventEnvelope; bytes: number }[] = [];
    let pendingBytes = 0;
    let captureOverflow = false;
    const capture: Writer = (event) => {
      const bytes = Buffer.byteLength(sseEventFrame(event));
      if (
        pending.length >= this.sseMaxPendingEvents ||
        pendingBytes + bytes > this.sseMaxPendingBytes
      ) {
        captureOverflow = true;
        return;
      }
      pending.push({ event, bytes });
      pendingBytes += bytes;
    };
    feed.writers.add(capture);
    const attachment = this.attach(res, feed.writers, onEmpty, undefined, false);
    const { connection } = attachment;
    try {
      await connection.rawAndFlush("retry: 1000\n\n");
      await connection.controlAndFlush(
        envelope("server.connected", { protocol: PROTOCOL_VERSION }),
      );
      const replay = lastEventId ? feed.ring.replayAfter(lastEventId) : null;
      if (replay) {
        for (const event of replay) await connection.eventAndFlush(event);
      } else {
        const snapshot = feed.peek();
        if (!snapshot) throw new HttpRequestError(404, "NOT_FOUND", "session not found");
        await this.writeSnapshot(connection, sessionId, snapshot);
      }
      while (pending.length > 0) {
        if (captureOverflow) throw new Error("SSE initial event buffer exceeded its safety limit");
        const next = pending.shift()!;
        pendingBytes -= next.bytes;
        await connection.eventAndFlush(next.event);
      }
      if (captureOverflow) throw new Error("SSE initial event buffer exceeded its safety limit");
      // Synchronous handoff: no manager event can land between removing capture and activating the
      // live writer, so snapshot/replay is delivered exactly once and always precedes live events.
      feed.writers.delete(capture);
      attachment.activate();
    } catch (error) {
      feed.writers.delete(capture);
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
      onEmpty();
    }
  }

  private async writeSnapshot(
    connection: SseBackpressureWriter,
    sessionId: string,
    snapshot: SessionSnapshot,
  ): Promise<void> {
    const serialized = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(serialized);
    if (bytes > MAX_SSE_SNAPSHOT_BYTES) {
      throw new Error(`SSE snapshot exceeds ${MAX_SSE_SNAPSHOT_BYTES} bytes`);
    }
    if (bytes <= INLINE_SSE_SNAPSHOT_BYTES) {
      await connection.controlAndFlush(envelope("session.snapshot", { sessionId, snapshot }));
      return;
    }
    const transferId = randomUUID();
    const chunkChars = Math.max(
      1024,
      Math.min(SSE_SNAPSHOT_CHUNK_CHARS, Math.floor(this.sseMaxPendingBytes / 8)),
    );
    let index = 0;
    for (let offset = 0; offset < serialized.length; offset += chunkChars) {
      const end = Math.min(serialized.length, offset + chunkChars);
      await connection.controlAndFlush(
        envelope("session.snapshot.chunk", {
          sessionId,
          transferId,
          index,
          data: serialized.slice(offset, end),
          done: end === serialized.length,
        }),
      );
      index++;
    }
  }

  /** 取（或建）全局 firehose 扇出（跨所有 live 会话）。 */
  private ensureFirehose(inst: InstanceStreams): Firehose {
    if (inst.firehose) return inst.firehose;
    const writers = new Set<Writer>();
    const ring = new EventRing(this.replayBufferSize, this.replayBufferBytes);
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
    let closed = false;
    const firehose: Firehose = {
      writers,
      ring,
      close: () => {
        if (closed) return;
        closed = true;
        ring.clear();
        writers.clear();
        unsub();
        if (inst.firehose === firehose) delete inst.firehose;
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
    this.attach(
      res,
      fh.writers,
      () => {
        if (fh.writers.size === 0) fh.close();
      },
      (connection) => {
        connection.raw("retry: 1000\n\n");
        connection.control(envelope("server.connected", { protocol: PROTOCOL_VERSION }));
        const replay = lastEventId ? fh.ring.replayAfter(lastEventId) : null;
        if (replay) for (const ev of replay) connection.event(ev);
      },
    );
  }

  /** 挂载有界 writer：drain 恢复、慢客户端断开、心跳与引用计数清理。 */
  private attach(
    res: http.ServerResponse,
    writers: Set<Writer>,
    onEmpty: () => void,
    initialize?: (connection: SseBackpressureWriter) => void,
    activateImmediately = true,
  ): SseAttachment {
    let cleaned = false;
    let active = false;
    let connection: SseBackpressureWriter;
    const writer: Writer = (ev) => connection.event(ev);
    const cleanup = (destroy = false) => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      connection.close();
      writers.delete(writer);
      onEmpty();
      this.sseCleanups.delete(cleanup);
      const grouped = this.attachedCleanups.get(writers);
      grouped?.delete(cleanup);
      if (grouped?.size === 0) this.attachedCleanups.delete(writers);
      res.off("close", close);
      res.off("error", close);
      if (destroy) {
        if (!res.destroyed) res.destroy();
      } else if (!res.destroyed && !res.writableEnded) {
        res.end();
      }
    };
    connection = new SseBackpressureWriter(
      res,
      {
        maxPendingBytes: this.sseMaxPendingBytes,
        maxPendingEvents: this.sseMaxPendingEvents,
      },
      () => cleanup(true),
    );
    const heartbeat = setInterval(
      () => connection.control(envelope("server.heartbeat", {})),
      30_000,
    );
    const close = () => cleanup();
    this.sseCleanups.add(cleanup);
    let grouped = this.attachedCleanups.get(writers);
    if (!grouped) {
      grouped = new Set();
      this.attachedCleanups.set(writers, grouped);
    }
    grouped.add(cleanup);
    res.on("close", close);
    res.on("error", close);
    initialize?.(connection);
    const activate = () => {
      if (cleaned || active) return;
      active = true;
      writers.add(writer);
    };
    if (activateImmediately) activate();
    return { connection, activate };
  }
}
