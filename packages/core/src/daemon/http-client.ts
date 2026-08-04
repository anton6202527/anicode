/**
 * HTTP SessionHost —— HttpDaemonServer 的客户端，实现 SessionHost 接口，
 * 与 LocalSessionHost / DaemonClient（socket）等价可换。
 *
 * 事件用 SSE（fetch 流式解析，零依赖）；请求用 fetch JSON。
 * SSE 帧为统一信封 `{id,type,properties}`（见 daemon/api.ts）：host 客户端只消费
 * `session.snapshot`（首个快照）与 `session.event`（SessionEvent 透传通道），
 * 其余命名事件（message.part.* 等）面向 SDK/外部客户端，此处忽略。
 * 相比 socket 版额外支持 setPermissionMode / setPermissionProfile（HTTP 端点已就绪）。
 */

import { t } from "../i18n.js";
import type {
  RewindMode,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
} from "../session-manager.js";
import type { OpenHandle, PermissionDecisionKind, SessionHost } from "../host.js";
import type { PermissionMode, PermissionProfile } from "../permission.js";
import { sanitizeDiscoveredModels, sanitizeProviderId } from "../provider/registry.js";

export interface HttpSessionHostOptions {
  /** 回环可用 http；非回环必须使用 https。 */
  baseUrl: string;
  token?: string;
  /** JSON request deadline. Long model turns may need a larger value. Default: 30 minutes. */
  requestTimeoutMs?: number;
  /** Deadline for receiving the first SSE session snapshot. Default: 15 seconds. */
  snapshotTimeoutMs?: number;
  /** Maximum JSON response body. Default: 16 MiB. */
  maxResponseBytes?: number;
  /** Maximum individual SSE frame. Default: 4 MiB. */
  maxSseFrameBytes?: number;
  /** Maximum decoded session snapshot, inline or chunked. Default: 256 MiB. */
  maxSseSnapshotBytes?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SSE_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_SSE_SNAPSHOT_BYTES = 256 * 1024 * 1024;
const MAX_ERROR_RESPONSE_BYTES = 64 * 1024;

export function secureHttpBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("Invalid AniCode server URL");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("AniCode server URL must not contain credentials, query, or fragment");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError("Non-loopback AniCode server URLs must use HTTPS");
  }
  return url.href.replace(/\/+$/, "");
}

interface SseFrame {
  event: string;
  data: string;
}

/** 增量解析 SSE 文本流：按空行分帧，取 event/data 字段（data 多行按规范拼接）。 */
export function parseSseChunk(
  buffer: string,
  maxFrameBytes = DEFAULT_MAX_SSE_FRAME_BYTES,
): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut === -1) {
      if (Buffer.byteLength(rest, "utf8") > maxFrameBytes) {
        throw new Error(t("SSE frame exceeds safety limit", "SSE 帧超过安全上限"));
      }
      break;
    }
    const block = rest.slice(0, cut);
    if (Buffer.byteLength(block, "utf8") > maxFrameBytes) {
      throw new Error(t("SSE frame exceeds safety limit", "SSE 帧超过安全上限"));
    }
    rest = rest.slice(cut + 2);
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // 注释/心跳
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) frames.push({ event, data: dataLines.join("\n") });
  }
  return { frames, rest };
}

export class HttpSessionHost implements SessionHost {
  private baseUrl: string;
  private token?: string;
  private aborts = new Set<AbortController>();
  private disposed = false;
  private requestTimeoutMs: number;
  private snapshotTimeoutMs: number;
  private maxResponseBytes: number;
  private maxSseFrameBytes: number;
  private maxSseSnapshotBytes: number;

  constructor(opts: HttpSessionHostOptions) {
    this.baseUrl = secureHttpBaseUrl(opts.baseUrl);
    if (opts.token) this.token = opts.token;
    this.requestTimeoutMs = positiveInteger(
      opts.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.snapshotTimeoutMs = positiveInteger(
      opts.snapshotTimeoutMs,
      DEFAULT_SNAPSHOT_TIMEOUT_MS,
      "snapshotTimeoutMs",
    );
    this.maxResponseBytes = positiveInteger(
      opts.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      "maxResponseBytes",
    );
    this.maxSseFrameBytes = positiveInteger(
      opts.maxSseFrameBytes,
      DEFAULT_MAX_SSE_FRAME_BYTES,
      "maxSseFrameBytes",
    );
    this.maxSseSnapshotBytes = positiveInteger(
      opts.maxSseSnapshotBytes,
      DEFAULT_MAX_SSE_SNAPSHOT_BYTES,
      "maxSseSnapshotBytes",
    );
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    if (this.disposed) throw new Error(t("HTTP session host is disposed", "HTTP 会话 host 已释放"));
    const ac = new AbortController();
    this.aborts.add(ac);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, this.requestTimeoutMs);
    timeout.unref();
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers({
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        }),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ac.signal,
      });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const parsed = JSON.parse(await readBoundedText(res, MAX_ERROR_RESPONSE_BYTES)) as {
            error?: string;
          };
          if (parsed.error) message = parsed.error;
        } catch {
          /* 保持状态码信息 */
        }
        throw new Error(message);
      }
      if (res.status === 204) return undefined as T;
      return JSON.parse(await readBoundedText(res, this.maxResponseBytes)) as T;
    } catch (error) {
      if (timedOut) {
        throw new Error(
          t(
            `HTTP request timed out after ${this.requestTimeoutMs} ms`,
            `HTTP 请求在 ${this.requestTimeoutMs} ms 后超时`,
          ),
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.aborts.delete(ac);
    }
  }

  async discoverModels(providerId: string): Promise<string[] | undefined> {
    const safeProviderId = sanitizeProviderId(providerId);
    if (!safeProviderId) throw new TypeError("Invalid provider id");
    const response = await this.call<{ providerId?: unknown; models?: unknown }>(
      "GET",
      `/providers/${encodeURIComponent(safeProviderId)}/models`,
    );
    if (response.providerId !== safeProviderId) return undefined;
    return sanitizeDiscoveredModels(response.models);
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.call("GET", "/sessions");
  }

  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    return this.call("POST", "/sessions", input);
  }

  /** SSE 订阅：等到首个 snapshot 帧才 resolve，之后事件推给 listener。 */
  async open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle> {
    if (this.disposed) throw new Error(t("HTTP session host is disposed", "HTTP 会话 host 已释放"));
    const ac = new AbortController();
    this.aborts.add(ac);
    let snapshotTimedOut = false;
    const snapshotTimeout = setTimeout(() => {
      snapshotTimedOut = true;
      ac.abort();
    }, this.snapshotTimeoutMs);
    snapshotTimeout.unref();
    const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`);
    let res: Response;
    try {
      res = await fetch(url, { headers: this.headers(), signal: ac.signal });
    } catch (error) {
      clearTimeout(snapshotTimeout);
      this.aborts.delete(ac);
      if (snapshotTimedOut) {
        throw new Error(
          t(
            `SSE snapshot timed out after ${this.snapshotTimeoutMs} ms`,
            `SSE snapshot 在 ${this.snapshotTimeoutMs} ms 后超时`,
          ),
          { cause: error },
        );
      }
      throw error;
    }
    if (!res.ok || !res.body) {
      clearTimeout(snapshotTimeout);
      this.aborts.delete(ac);
      ac.abort();
      throw new Error(
        t(`SSE subscribe failed: HTTP ${res.status}`, `SSE 订阅失败: HTTP ${res.status}`),
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let snapshotResolve!: (s: SessionSnapshot) => void;
    let snapshotReject!: (e: Error) => void;
    const snapshotP = new Promise<SessionSnapshot>((resolve, reject) => {
      snapshotResolve = resolve;
      snapshotReject = reject;
    });
    let gotSnapshot = false;
    let snapshotTransfer:
      { transferId: string; nextIndex: number; chunks: string[]; bytes: number } | undefined;
    let intentionalClose = false;
    let streamError: Error | undefined;
    let closedResolve!: (error: Error | undefined) => void;
    const closed = new Promise<Error | undefined>((resolve) => {
      closedResolve = resolve;
    });

    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseChunk(buffer, this.maxSseFrameBytes);
          buffer = rest;
          for (const frame of frames) {
            const env = parseSseEnvelope(frame.data);
            if (env.type === "session.snapshot") {
              if (snapshotTransfer || gotSnapshot) {
                throw new Error(t("Mixed SSE snapshot encodings", "SSE snapshot 编码混用"));
              }
              if (
                env.properties.sessionId !== sessionId ||
                !sessionSnapshotValue(env.properties.snapshot)
              ) {
                throw new Error(t("Invalid SSE snapshot", "无效 SSE snapshot"));
              }
              if (
                Buffer.byteLength(JSON.stringify(env.properties.snapshot), "utf8") >
                this.maxSseSnapshotBytes
              ) {
                throw new Error(
                  t(
                    `SSE snapshot exceeds ${this.maxSseSnapshotBytes} bytes`,
                    `SSE snapshot 超过 ${this.maxSseSnapshotBytes} bytes`,
                  ),
                );
              }
              if (!gotSnapshot) {
                gotSnapshot = true;
                clearTimeout(snapshotTimeout);
                snapshotResolve(env.properties.snapshot);
              }
            } else if (env.type === "session.snapshot.chunk") {
              if (gotSnapshot) {
                throw new Error(t("Unexpected SSE snapshot chunk", "收到意外的 SSE snapshot 分块"));
              }
              const transferId = env.properties.transferId;
              const index = env.properties.index;
              const data = env.properties.data;
              const done = env.properties.done;
              if (
                env.properties.sessionId !== sessionId ||
                typeof transferId !== "string" ||
                transferId.length < 1 ||
                transferId.length > 128 ||
                typeof index !== "number" ||
                !Number.isSafeInteger(index) ||
                index < 0 ||
                typeof data !== "string" ||
                typeof done !== "boolean"
              ) {
                throw new Error(t("Invalid SSE snapshot chunk", "无效 SSE snapshot 分块"));
              }
              if (!snapshotTransfer) {
                if (index !== 0) {
                  throw new Error(t("Out-of-order SSE snapshot chunk", "SSE snapshot 分块乱序"));
                }
                snapshotTransfer = { transferId, nextIndex: 0, chunks: [], bytes: 0 };
              }
              if (
                snapshotTransfer.transferId !== transferId ||
                snapshotTransfer.nextIndex !== index
              ) {
                throw new Error(t("Out-of-order SSE snapshot chunk", "SSE snapshot 分块乱序"));
              }
              snapshotTransfer.bytes += Buffer.byteLength(data, "utf8");
              if (snapshotTransfer.bytes > this.maxSseSnapshotBytes) {
                throw new Error(
                  t(
                    `SSE snapshot exceeds ${this.maxSseSnapshotBytes} bytes`,
                    `SSE snapshot 超过 ${this.maxSseSnapshotBytes} bytes`,
                  ),
                );
              }
              snapshotTransfer.chunks.push(data);
              snapshotTransfer.nextIndex++;
              if (done) {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(snapshotTransfer.chunks.join(""));
                } catch {
                  throw new Error(t("Invalid chunked SSE snapshot", "无效的分块 SSE snapshot"));
                }
                if (!sessionSnapshotValue(parsed)) {
                  throw new Error(t("Invalid SSE snapshot", "无效 SSE snapshot"));
                }
                gotSnapshot = true;
                snapshotTransfer = undefined;
                clearTimeout(snapshotTimeout);
                snapshotResolve(parsed);
              }
            } else if (env.type === "session.event") {
              if (!sessionEventValue(env.properties.event)) {
                throw new Error(t("Invalid SSE session event", "无效 SSE 会话事件"));
              }
              try {
                listener(env.properties.event);
              } catch {
                // UI listeners are isolation boundaries; one renderer must not kill the stream.
              }
            }
            // 其余命名事件（server.*/message.*/permission.*）面向 SDK，host 层忽略。
          }
        }
        if (!gotSnapshot) {
          snapshotReject(new Error(t("SSE closed before snapshot", "SSE 在 snapshot 前关闭")));
        } else {
          streamError = new Error(t("SSE subscription closed", "SSE 订阅已关闭"));
        }
      } catch (err) {
        streamError = snapshotTimedOut
          ? new Error(
              t(
                `SSE snapshot timed out after ${this.snapshotTimeoutMs} ms`,
                `SSE snapshot 在 ${this.snapshotTimeoutMs} ms 后超时`,
              ),
            )
          : intentionalClose
            ? undefined
            : err instanceof Error
              ? err
              : new Error(String(err));
        if (!gotSnapshot) {
          snapshotReject(
            streamError ?? new Error(t("SSE closed before snapshot", "SSE 在 snapshot 前关闭")),
          );
        }
        // snapshot 之后的流错误：订阅静默终止（对齐 socket 客户端断连语义），
        // 前端可经 close/重开恢复。
      } finally {
        clearTimeout(snapshotTimeout);
        ac.abort();
        this.aborts.delete(ac);
        closedResolve(streamError);
      }
    };
    void pump();

    const snapshot = await snapshotP;
    return {
      snapshot,
      closed,
      close: () => {
        intentionalClose = true;
        ac.abort();
        this.aborts.delete(ac);
      },
    };
  }

  send(
    sessionId: string,
    text: string,
    opts?: { model?: string; idempotencyKey?: string; traceparent?: string },
  ): Promise<void> {
    return this.call(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        text,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
      },
      opts?.traceparent ? { traceparent: opts.traceparent } : {},
    );
  }

  interrupt(sessionId: string): Promise<void> {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/interrupt`, {});
  }

  async answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionDecisionKind,
  ): Promise<boolean> {
    const r = await this.call<{ answered: boolean }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/permission`,
      { permId, decision },
    );
    return r.answered;
  }

  undo(
    sessionId: string,
    checkpointId?: string,
    mode?: RewindMode,
  ): Promise<{ restored: number; deleted: number; removedMessages?: number }> {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/undo`, {
      ...(checkpointId ? { checkpointId } : {}),
      ...(mode ? { mode } : {}),
    });
  }

  compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/compact`, {});
  }

  forkSession(
    sessionId: string,
    opts?: { title?: string; upToMessage?: number; model?: string },
  ): Promise<SessionSummary> {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/fork`, {
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.upToMessage !== undefined ? { upToMessage: opts.upToMessage } : {}),
      ...(opts?.model !== undefined ? { model: opts.model } : {}),
    });
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/permission-mode`, {
      mode,
    });
  }

  async setPermissionProfile(sessionId: string, name: string): Promise<PermissionMode> {
    const r = await this.call<{ mode: PermissionMode }>(
      "POST",
      `/sessions/${encodeURIComponent(sessionId)}/permission-profile`,
      { name },
    );
    return r.mode;
  }

  listPermissionProfiles(sessionId: string): Promise<Record<string, PermissionProfile>> {
    return this.call("GET", `/sessions/${encodeURIComponent(sessionId)}/permission-profiles`);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ac of this.aborts) ac.abort();
    this.aborts.clear();
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return result;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(t("HTTP response exceeds safety limit", "HTTP 响应超过安全上限"));
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(t("HTTP response exceeds safety limit", "HTTP 响应超过安全上限"));
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function parseSseEnvelope(data: string): { type: string; properties: Record<string, unknown> } {
  const value = JSON.parse(data) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(t("Invalid SSE envelope", "无效 SSE 信封"));
  }
  const envelope = value as Record<string, unknown>;
  if (
    typeof envelope.type !== "string" ||
    !envelope.properties ||
    typeof envelope.properties !== "object" ||
    Array.isArray(envelope.properties)
  ) {
    throw new Error(t("Invalid SSE envelope", "无效 SSE 信封"));
  }
  return { type: envelope.type, properties: envelope.properties as Record<string, unknown> };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function permissionModeValue(value: unknown): value is PermissionMode {
  return (
    value === "default" ||
    value === "acceptEdits" ||
    value === "auto" ||
    value === "bypass" ||
    value === "plan"
  );
}

function sessionSnapshotValue(value: unknown): value is SessionSnapshot {
  if (!recordValue(value)) return false;
  return (
    recordValue(value.meta) &&
    typeof value.meta.id === "string" &&
    Array.isArray(value.messages) &&
    recordValue(value.usage) &&
    typeof value.running === "boolean" &&
    (value.permissionMode === undefined || permissionModeValue(value.permissionMode)) &&
    Array.isArray(value.pendingPermissions)
  );
}

function sessionEventValue(value: unknown): value is SessionEvent {
  return recordValue(value) && typeof value.type === "string";
}
