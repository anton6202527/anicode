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
import { generatedPath } from "./generated.js";
export {
  GENERATED_ROUTES,
  OPENAPI_CONTRACT_SHA256,
  generatedPath,
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
}

/** 非 2xx 响应抛出：带状态码与 server 返回的 error 文本。 */
export class AnicodeApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
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

  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...extra,
  });

  async function call<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const res = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: headers({
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...extraHeaders,
      }),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      try {
        const parsed = (await res.json()) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        /* 保持状态码信息 */
      }
      throw new AnicodeApiError(res.status, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
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

  return {
    global: {
      health: () => call("GET", generatedPath("getGlobalHealth")),
      doc: () => call("GET", generatedPath("getDoc")),
    },
    session: {
      list: () => call("GET", generatedPath("getSessions")),
      create: (input) => call("POST", generatedPath("postSessions"), input),
      get: (id) => call("GET", generatedPath("getSessionsId", { id })),
      delete: (id) => call("DELETE", generatedPath("deleteSessionsId", { id })),
      setTitle: (id, title) => call("PATCH", generatedPath("patchSessionsId", { id }), { title }),
      messages: (id) => call("GET", generatedPath("getSessionsIdMessages", { id })),
      checkpoints: (id) => call("GET", generatedPath("getSessionsIdCheckpoints", { id })),
      send: (id, text, sendOpts) =>
        call(
          "POST",
          generatedPath("postSessionsIdSend", { id }),
          {
            text,
            ...(sendOpts?.model ? { model: sendOpts.model } : {}),
            ...(sendOpts?.idempotencyKey ? { idempotencyKey: sendOpts.idempotencyKey } : {}),
          },
          sendOpts?.traceparent ? { traceparent: sendOpts.traceparent } : {},
        ),
      interrupt: (id) => call("POST", generatedPath("postSessionsIdInterrupt", { id }), {}),
      undo: (id, undoOpts) =>
        call("POST", generatedPath("postSessionsIdUndo", { id }), {
          ...(undoOpts?.checkpointId ? { checkpointId: undoOpts.checkpointId } : {}),
          ...(undoOpts?.mode ? { mode: undoOpts.mode } : {}),
        }),
      compact: (id) => call("POST", generatedPath("postSessionsIdCompact", { id }), {}),
      fork: (id, forkOpts) =>
        call("POST", generatedPath("postSessionsIdFork", { id }), {
          ...(forkOpts?.title !== undefined ? { title: forkOpts.title } : {}),
          ...(forkOpts?.upToMessage !== undefined ? { upToMessage: forkOpts.upToMessage } : {}),
        }),
    },
    permission: {
      reply: async (sessionId, permId, decision) => {
        const r = await call<{ answered: boolean }>(
          "POST",
          generatedPath("postSessionsIdPermission", { id: sessionId }),
          { permId, decision },
        );
        return r.answered;
      },
      setMode: (sessionId, mode) =>
        call("POST", generatedPath("postSessionsIdPermissionMode", { id: sessionId }), { mode }),
      setProfile: async (sessionId, name) => {
        const r = await call<{ mode: PermissionMode }>(
          "POST",
          generatedPath("postSessionsIdPermissionProfile", { id: sessionId }),
          { name },
        );
        return r.mode;
      },
      listProfiles: (sessionId) =>
        call("GET", generatedPath("getSessionsIdPermissionProfiles", { id: sessionId })),
    },
    artifact: {
      list: (sessionId) => call("GET", generatedPath("getSessionsIdArtifacts", { id: sessionId })),
      create: (sessionId, input) =>
        call("POST", generatedPath("postSessionsIdArtifacts", { id: sessionId }), input),
      get: (sessionId, artifactId) =>
        call(
          "GET",
          generatedPath("getSessionsIdArtifactsArtifactId", { id: sessionId, artifactId }),
        ),
      delete: (sessionId, artifactId) =>
        call(
          "DELETE",
          generatedPath("deleteSessionsIdArtifactsArtifactId", { id: sessionId, artifactId }),
        ),
    },
    patchset: {
      prepare: (sessionId, input) =>
        call("POST", generatedPath("postSessionsIdPatchsets", { id: sessionId }), input),
      get: (sessionId, patchsetId) =>
        call(
          "GET",
          generatedPath("getSessionsIdPatchsetsPatchsetId", { id: sessionId, patchsetId }),
        ),
      approve: (sessionId, patchsetId, input) =>
        call(
          "POST",
          generatedPath("postSessionsIdPatchsetsPatchsetIdApprove", {
            id: sessionId,
            patchsetId,
          }),
          input,
        ),
      apply: (sessionId, patchsetId) =>
        call(
          "POST",
          generatedPath("postSessionsIdPatchsetsPatchsetIdApply", {
            id: sessionId,
            patchsetId,
          }),
          {},
        ),
      rebase: (sessionId, patchsetId) =>
        call(
          "POST",
          generatedPath("postSessionsIdPatchsetsPatchsetIdRebase", {
            id: sessionId,
            patchsetId,
          }),
          {},
        ),
      rollback: (sessionId, patchsetId, force = false) =>
        call(
          "POST",
          generatedPath("postSessionsIdPatchsetsPatchsetIdRollback", {
            id: sessionId,
            patchsetId,
          }),
          { force },
        ),
    },
    runtime: {
      events: (sessionId, afterSequence) =>
        call(
          "GET",
          `${generatedPath("getSessionsIdRuntimeEvents", { id: sessionId })}${
            afterSequence === undefined ? "" : `?afterSequence=${encodeURIComponent(afterSequence)}`
          }`,
        ),
      state: (sessionId) =>
        call("GET", generatedPath("getSessionsIdRuntimeState", { id: sessionId })),
    },
    event: { subscribe, subscribeAll },
  };
}
