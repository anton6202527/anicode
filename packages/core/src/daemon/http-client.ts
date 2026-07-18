/**
 * HTTP SessionHost —— HttpDaemonServer 的客户端，实现 SessionHost 接口，
 * 与 LocalSessionHost / DaemonClient（socket）等价可换。
 *
 * 事件用 SSE（fetch 流式解析，零依赖）；请求用 fetch JSON。
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

export interface HttpSessionHostOptions {
  /** 形如 http://127.0.0.1:8317（不带尾斜杠）。 */
  baseUrl: string;
  token?: string;
}

interface SseFrame {
  event: string;
  data: string;
}

/** 增量解析 SSE 文本流：按空行分帧，取 event/data 字段（data 多行按规范拼接）。 */
export function parseSseChunk(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let rest = buffer;
  for (;;) {
    const cut = rest.indexOf("\n\n");
    if (cut === -1) break;
    const block = rest.slice(0, cut);
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

  constructor(opts: HttpSessionHostOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    if (opts.token) this.token = opts.token;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      ...extra,
    };
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(body !== undefined ? { "content-type": "application/json" } : {}),
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
      throw new Error(message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  listSessions(): Promise<SessionSummary[]> {
    return this.call("GET", "/sessions");
  }

  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    return this.call("POST", "/sessions", input);
  }

  /** SSE 订阅：等到首个 snapshot 帧才 resolve，之后事件推给 listener。 */
  async open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle> {
    const ac = new AbortController();
    this.aborts.add(ac);
    const url = new URL(`${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/events`);
    if (this.token) url.searchParams.set("token", this.token);
    const res = await fetch(url, { headers: this.headers(), signal: ac.signal });
    if (!res.ok || !res.body) {
      this.aborts.delete(ac);
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

    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { frames, rest } = parseSseChunk(buffer);
          buffer = rest;
          for (const frame of frames) {
            if (frame.event === "snapshot") {
              gotSnapshot = true;
              snapshotResolve(JSON.parse(frame.data) as SessionSnapshot);
            } else if (frame.event === "session") {
              listener(JSON.parse(frame.data) as SessionEvent);
            }
          }
        }
        if (!gotSnapshot)
          snapshotReject(new Error(t("SSE closed before snapshot", "SSE 在 snapshot 前关闭")));
      } catch (err) {
        if (!gotSnapshot) snapshotReject(err instanceof Error ? err : new Error(String(err)));
        // snapshot 之后的流错误：订阅静默终止（对齐 socket 客户端断连语义），
        // 前端可经 close/重开恢复。
      } finally {
        this.aborts.delete(ac);
      }
    };
    void pump();

    const snapshot = await snapshotP;
    return {
      snapshot,
      close: () => {
        ac.abort();
        this.aborts.delete(ac);
      },
    };
  }

  send(sessionId: string, text: string, opts?: { model?: string }): Promise<void> {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/send`, {
      text,
      ...(opts?.model ? { model: opts.model } : {}),
    });
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
    opts?: { title?: string; upToMessage?: number },
  ): Promise<SessionSummary> {
    return this.call("POST", `/sessions/${encodeURIComponent(sessionId)}/fork`, {
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.upToMessage !== undefined ? { upToMessage: opts.upToMessage } : {}),
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
