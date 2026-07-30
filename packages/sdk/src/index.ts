/**
 * @anicode/sdk —— AniCode server 的类型化客户端（对齐 opencode 的 SDK 形态）。
 *
 * 与 server 的契约以 core 的 `daemon/api.ts`（ROUTES/EVENTS/信封）为单一事实源；
 * 本包只做 type-only 导入（运行时零依赖，仅用全局 fetch），便于将来独立发布。
 *
 * 用法：
 *   const client = createAnicodeClient({ baseUrl: "http://127.0.0.1:8317" });
 *   const s = await client.session.create({ cwd, model });
 *   for await (const ev of client.event.subscribe(s.id, { signal })) { ... }
 */

import type {
  Checkpoint,
  Artifact,
  ArtifactKind,
  EventEnvelope,
  MessageWithParts,
  PermissionAnswer,
  PermissionMode,
  PermissionProfile,
  RewindMode,
  SessionSnapshot,
  SessionSummary,
  RuntimeEvent,
  RecoveredRuntimeState,
  PatchSet,
  PatchSetRebaseResult,
} from "@anicode/core";
import {
  GENERATED_OPERATIONS,
  generatedPath,
  generatedRequestIssues,
  type GeneratedOperationId,
} from "./generated.js";
export {
  GENERATED_OPERATIONS,
  GENERATED_ROUTES,
  OPENAPI_CONTRACT_SHA256,
  generatedPath,
  generatedRequestIssues,
  type GeneratedOperationId,
} from "./generated.js";

export type {
  Checkpoint,
  Artifact,
  ArtifactKind,
  EventEnvelope,
  MessageWithParts,
  PermissionAnswer,
  PermissionMode,
  PermissionProfile,
  RewindMode,
  SessionSnapshot,
  SessionSummary,
  RuntimeEvent,
  RecoveredRuntimeState,
  PatchSet,
  PatchSetRebaseResult,
};

export interface PatchSetChangeRequest {
  path: string;
  text?: string;
  dataBase64?: string;
  delete?: boolean;
  renameFrom?: string;
}

export interface PreparedPatchSet {
  patchset: PatchSet;
  preview: string;
  artifact: Artifact;
}

export interface AnicodeClientOptions {
  /** 形如 http://127.0.0.1:8317（不带尾斜杠）。 */
  baseUrl: string;
  /** server 配置的 Bearer token（SSE 自动转查询参数）。 */
  token?: string;
  /** 自定义 fetch（测试注入）。缺省用全局 fetch。 */
  fetch?: typeof fetch;
  /** 幂等请求遇到网络错误/408/429/5xx 时的最大重试次数。默认 2。 */
  maxRetries?: number;
  /** 指数退避基准毫秒。默认 100。 */
  retryDelayMs?: number;
  /** 协议协商版本；通常无需覆盖。 */
  apiVersion?: number;
}

/** 非 2xx 响应抛出：带状态码与 server 返回的 error 文本。 */
export class AnicodeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = "HTTP_ERROR",
    readonly requestId?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AnicodeApiError";
  }
}

export interface SubscribeOptions {
  signal?: AbortSignal;
  /** 断线续传：从该事件 id 之后增量补发（缓冲失效时 server 回落整份快照）。 */
  lastEventId?: string;
}

export interface AnicodeClient {
  global: {
    health(): Promise<{ ok: boolean; name: string; protocol: number }>;
    /** OpenAPI 3.1 文档（GET /doc）。 */
    doc(): Promise<Record<string, unknown>>;
  };
  session: {
    list(): Promise<SessionSummary[]>;
    listPage(options?: {
      limit?: number;
      cursor?: string;
    }): Promise<{ items: SessionSummary[]; nextCursor?: string }>;
    create(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary>;
    get(id: string): Promise<SessionSnapshot>;
    delete(id: string): Promise<void>;
    setTitle(id: string, title: string): Promise<void>;
    /** Message+Parts 投影（GET /sessions/:id/messages）。 */
    messages(id: string): Promise<MessageWithParts[]>;
    checkpoints(id: string): Promise<Checkpoint[]>;
    /** 发消息驱动 agent loop；resolve 于本次 drive 收尾。 */
    send(
      id: string,
      text: string,
      opts?: { model?: string; idempotencyKey?: string; traceparent?: string },
    ): Promise<void>;
    interrupt(id: string): Promise<void>;
    undo(
      id: string,
      opts?: { checkpointId?: string; mode?: RewindMode },
    ): Promise<{ restored: number; deleted: number; removedMessages?: number }>;
    compact(id: string): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }>;
    fork(id: string, opts?: { title?: string; upToMessage?: number }): Promise<SessionSummary>;
  };
  permission: {
    reply(sessionId: string, permId: string, decision: PermissionAnswer): Promise<boolean>;
    setMode(sessionId: string, mode: PermissionMode): Promise<void>;
    setProfile(sessionId: string, name: string): Promise<PermissionMode>;
    listProfiles(sessionId: string): Promise<Record<string, PermissionProfile>>;
  };
  artifact: {
    list(sessionId: string): Promise<Artifact[]>;
    create(
      sessionId: string,
      input: {
        kind: ArtifactKind;
        name: string;
        mediaType?: string;
        text?: string;
        dataBase64?: string;
        metadata?: Record<string, unknown>;
      },
    ): Promise<Artifact>;
    get(sessionId: string, artifactId: string): Promise<{ artifact: Artifact; dataBase64: string }>;
    /** 返回原始 Response，调用方可直接消费 response.body 流。 */
    open(sessionId: string, artifactId: string): Promise<Response>;
    /** 流式端点下载后校验 content-digest，避免 base64 JSON 放大。 */
    download(sessionId: string, artifactId: string): Promise<Uint8Array>;
    delete(sessionId: string, artifactId: string): Promise<void>;
  };
  patchset: {
    prepare(
      sessionId: string,
      input: {
        changes: PatchSetChangeRequest[];
        requiredApprovals?: number;
        requiredRoles?: string[];
      },
    ): Promise<PreparedPatchSet>;
    get(sessionId: string, patchsetId: string): Promise<{ patchset: PatchSet; preview: string }>;
    approve(
      sessionId: string,
      patchsetId: string,
      input: {
        actor: string;
        role: string;
        decision: "approve" | "reject";
        comment?: string;
      },
    ): Promise<PatchSet>;
    apply(sessionId: string, patchsetId: string): Promise<PatchSet>;
    rebase(sessionId: string, patchsetId: string): Promise<PatchSetRebaseResult>;
    rollback(sessionId: string, patchsetId: string, force?: boolean): Promise<PatchSet>;
  };
  runtime: {
    events(sessionId: string, afterSequence?: number): Promise<RuntimeEvent[]>;
    state(sessionId: string): Promise<RecoveredRuntimeState>;
  };
  event: {
    /**
     * 订阅会话事件流（SSE 信封）。首帧保证 server.connected，随后 session.snapshot
     * （或 lastEventId 续传时的增量补发），之后实时事件。流断开即结束（不自动重连），
     * signal 可主动取消。
     */
    subscribe(sessionId: string, opts?: SubscribeOptions): AsyncGenerator<EventEnvelope>;
    /**
     * 订阅全局 firehose（GET /events）：跨所有 live 会话的事件流，每帧 properties
     * 带 sessionId。用于监控/多会话面板。同样支持 lastEventId 续传。
     */
    subscribeAll(opts?: SubscribeOptions): AsyncGenerator<EventEnvelope>;
  };
}

/** 增量解析 SSE：按空行分帧，拼接 data 行；忽略注释与 event/id 字段。 */
function splitSse(buffer: string): { payloads: string[]; rest: string } {
  const payloads: string[] = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut === -1) break;
    const block = rest.slice(0, cut);
    rest = rest.slice(cut + 2);
    const dataLines = block
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length > 0) payloads.push(dataLines.join("\n"));
  }
  return { payloads, rest };
}

export function createAnicodeClient(opts: AnicodeClientOptions): AnicodeClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const retryDelayMs = opts.retryDelayMs ?? 100;
  const apiVersion = opts.apiVersion ?? 1;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error("maxRetries must be an integer between 0 and 10");
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1 || retryDelayMs > 30_000) {
    throw new Error("retryDelayMs must be an integer between 1 and 30000");
  }
  if (!Number.isSafeInteger(apiVersion) || apiVersion < 1) {
    throw new Error("apiVersion must be a positive integer");
  }

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    "x-anicode-api-version": String(apiVersion),
    "x-request-id":
      globalThis.crypto?.randomUUID?.() ??
      `sdk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    ...extra,
  });

  function retryDelay(response: Response | undefined, attempt: number): number {
    const raw = response?.headers.get("retry-after");
    if (raw) {
      const seconds = Number(raw);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(30_000, seconds * 1_000);
      const date = Date.parse(raw);
      if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
    }
    return Math.min(30_000, retryDelayMs * 2 ** attempt);
  }

  async function execute(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const requestHeaders = headers({
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    });
    const serializedBody = body === undefined ? undefined : JSON.stringify(body);
    const idempotent =
      method === "GET" ||
      method === "HEAD" ||
      method === "DELETE" ||
      Object.keys(requestHeaders).some((name) => name.toLowerCase() === "idempotency-key");
    let res: Response | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        res = await doFetch(`${baseUrl}${path}`, {
          method,
          headers: requestHeaders,
          ...(serializedBody !== undefined ? { body: serializedBody } : {}),
        });
      } catch (error) {
        if (!idempotent || attempt === maxRetries) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelay(undefined, attempt)));
        continue;
      }
      const retryableStatus =
        res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500;
      if (!idempotent || !retryableStatus || attempt === maxRetries) break;
      await res.body?.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, retryDelay(res, attempt)));
    }
    if (!res) throw new Error("request failed without a response");
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let code = "HTTP_ERROR";
      let requestId = res.headers.get("x-request-id") ?? undefined;
      let details: unknown;
      try {
        const parsed = (await res.json()) as {
          error?: string;
          code?: string;
          requestId?: string;
          details?: unknown;
        };
        if (parsed.error) message = parsed.error;
        if (parsed.code) code = parsed.code;
        if (parsed.requestId) requestId = parsed.requestId;
        details = parsed.details;
      } catch {
        /* 保持状态码信息 */
      }
      throw new AnicodeApiError(res.status, message, code, requestId, details);
    }
    return res;
  }

  function operationPath(
    operationId: GeneratedOperationId,
    params: Record<string, string | number>,
    query?: Record<string, string | number | undefined>,
  ): string {
    const pathname = generatedPath(operationId, params);
    if (!query) return pathname;
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const encoded = search.toString();
    return encoded ? `${pathname}?${encoded}` : pathname;
  }

  async function callWithResponse<T>(
    operationId: GeneratedOperationId,
    params: Record<string, string | number> = {},
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    query?: Record<string, string | number | undefined>,
  ): Promise<{ data: T; response: Response }> {
    const contract = GENERATED_OPERATIONS[operationId];
    if (body !== undefined) {
      const issues = generatedRequestIssues(operationId, body);
      if (issues.length > 0) {
        throw new TypeError(`Invalid ${operationId} request: ${issues.join(", ")}`);
      }
    }
    const response = await execute(
      contract.method,
      operationPath(operationId, params, query),
      body,
      extraHeaders,
    );
    const data = response.status === 204 ? (undefined as T) : ((await response.json()) as T);
    return { data, response };
  }

  async function call<T>(
    operationId: GeneratedOperationId,
    params: Record<string, string | number> = {},
    body?: unknown,
    extraHeaders: Record<string, string> = {},
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return (await callWithResponse<T>(operationId, params, body, extraHeaders, query)).data;
  }

  async function* streamSse(
    path: string,
    subOpts: SubscribeOptions,
  ): AsyncGenerator<EventEnvelope> {
    const url = new URL(`${baseUrl}${path}`);
    if (opts.token) url.searchParams.set("token", opts.token);
    if (subOpts.lastEventId) url.searchParams.set("lastEventId", subOpts.lastEventId);
    const res = await doFetch(url, {
      headers: headers(subOpts.lastEventId ? { "last-event-id": subOpts.lastEventId } : {}),
      ...(subOpts.signal ? { signal: subOpts.signal } : {}),
    });
    if (!res.ok || !res.body)
      throw new AnicodeApiError(res.status, `SSE subscribe failed: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { payloads, rest } = splitSse(buffer);
        buffer = rest;
        for (const payload of payloads) yield JSON.parse(payload) as EventEnvelope;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  function subscribe(sessionId: string, subOpts: SubscribeOptions = {}) {
    return streamSse(generatedPath("getSessionsIdEvents", { id: sessionId }), subOpts);
  }

  function subscribeAll(subOpts: SubscribeOptions = {}) {
    return streamSse(generatedPath("getEvents"), subOpts);
  }

  function openArtifact(sessionId: string, artifactId: string): Promise<Response> {
    const operationId = "getSessionsIdArtifactsArtifactIdContent" as const;
    const contract = GENERATED_OPERATIONS[operationId];
    return execute(contract.method, generatedPath(operationId, { id: sessionId, artifactId }));
  }

  async function downloadArtifact(sessionId: string, artifactId: string): Promise<Uint8Array> {
    const response = await openArtifact(sessionId, artifactId);
    const data = new Uint8Array(await response.arrayBuffer());
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && Number(declaredLength) !== data.byteLength) {
      throw new AnicodeApiError(
        502,
        "artifact content-length mismatch",
        "ARTIFACT_INTEGRITY_ERROR",
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    const expected = /^sha-256=:([^:]+):$/.exec(response.headers.get("content-digest") ?? "")?.[1];
    if (!expected || !globalThis.crypto?.subtle) {
      throw new AnicodeApiError(
        502,
        "artifact content digest is unavailable",
        "ARTIFACT_INTEGRITY_ERROR",
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
    const actual = btoa(String.fromCharCode(...digest));
    if (actual !== expected) {
      throw new AnicodeApiError(
        502,
        "artifact content digest mismatch",
        "ARTIFACT_INTEGRITY_ERROR",
        response.headers.get("x-request-id") ?? undefined,
      );
    }
    return data;
  }

  return {
    global: {
      health: () => call("getGlobalHealth"),
      doc: () => call("getDoc"),
    },
    session: {
      list: () => call("getSessions"),
      listPage: async (options = {}) => {
        const { data, response } = await callWithResponse<SessionSummary[]>(
          "getSessions",
          {},
          undefined,
          {},
          { limit: options.limit ?? 50, cursor: options.cursor },
        );
        const nextCursor = response.headers.get("x-anicode-next-cursor") ?? undefined;
        return { items: data, ...(nextCursor ? { nextCursor } : {}) };
      },
      create: (input) => call("postSessions", {}, input),
      get: (id) => call("getSessionsId", { id }),
      delete: (id) => call("deleteSessionsId", { id }),
      setTitle: (id, title) => call("patchSessionsId", { id }, { title }),
      messages: (id) => call("getSessionsIdMessages", { id }),
      checkpoints: (id) => call("getSessionsIdCheckpoints", { id }),
      send: (id, text, sendOpts) =>
        call(
          "postSessionsIdSend",
          { id },
          {
            text,
            ...(sendOpts?.model ? { model: sendOpts.model } : {}),
            ...(sendOpts?.idempotencyKey ? { idempotencyKey: sendOpts.idempotencyKey } : {}),
          },
          {
            ...(sendOpts?.traceparent ? { traceparent: sendOpts.traceparent } : {}),
            ...(sendOpts?.idempotencyKey ? { "idempotency-key": sendOpts.idempotencyKey } : {}),
          },
        ),
      interrupt: (id) => call("postSessionsIdInterrupt", { id }, {}),
      undo: (id, undoOpts) =>
        call(
          "postSessionsIdUndo",
          { id },
          {
            ...(undoOpts?.checkpointId ? { checkpointId: undoOpts.checkpointId } : {}),
            ...(undoOpts?.mode ? { mode: undoOpts.mode } : {}),
          },
        ),
      compact: (id) => call("postSessionsIdCompact", { id }, {}),
      fork: (id, forkOpts) =>
        call(
          "postSessionsIdFork",
          { id },
          {
            ...(forkOpts?.title !== undefined ? { title: forkOpts.title } : {}),
            ...(forkOpts?.upToMessage !== undefined ? { upToMessage: forkOpts.upToMessage } : {}),
          },
        ),
    },
    permission: {
      reply: async (sessionId, permId, decision) => {
        const r = await call<{ answered: boolean }>(
          "postSessionsIdPermission",
          { id: sessionId },
          { permId, decision },
        );
        return r.answered;
      },
      setMode: (sessionId, mode) =>
        call("postSessionsIdPermissionMode", { id: sessionId }, { mode }),
      setProfile: async (sessionId, name) => {
        const r = await call<{ mode: PermissionMode }>(
          "postSessionsIdPermissionProfile",
          { id: sessionId },
          { name },
        );
        return r.mode;
      },
      listProfiles: (sessionId) => call("getSessionsIdPermissionProfiles", { id: sessionId }),
    },
    artifact: {
      list: (sessionId) => call("getSessionsIdArtifacts", { id: sessionId }),
      create: (sessionId, input) => call("postSessionsIdArtifacts", { id: sessionId }, input),
      get: (sessionId, artifactId) =>
        call("getSessionsIdArtifactsArtifactId", { id: sessionId, artifactId }),
      open: openArtifact,
      download: downloadArtifact,
      delete: (sessionId, artifactId) =>
        call("deleteSessionsIdArtifactsArtifactId", { id: sessionId, artifactId }),
    },
    patchset: {
      prepare: (sessionId, input) => call("postSessionsIdPatchsets", { id: sessionId }, input),
      get: (sessionId, patchsetId) =>
        call("getSessionsIdPatchsetsPatchsetId", { id: sessionId, patchsetId }),
      approve: (sessionId, patchsetId, input) =>
        call("postSessionsIdPatchsetsPatchsetIdApprove", { id: sessionId, patchsetId }, input),
      apply: (sessionId, patchsetId) =>
        call("postSessionsIdPatchsetsPatchsetIdApply", { id: sessionId, patchsetId }, {}),
      rebase: (sessionId, patchsetId) =>
        call("postSessionsIdPatchsetsPatchsetIdRebase", { id: sessionId, patchsetId }, {}),
      rollback: (sessionId, patchsetId, force = false) =>
        call("postSessionsIdPatchsetsPatchsetIdRollback", { id: sessionId, patchsetId }, { force }),
    },
    runtime: {
      events: (sessionId, afterSequence) =>
        call("getSessionsIdRuntimeEvents", { id: sessionId }, undefined, {}, { afterSequence }),
      state: (sessionId) => call("getSessionsIdRuntimeState", { id: sessionId }),
    },
    event: { subscribe, subscribeAll },
  };
}
