/**
 * 守护进程客户端 = RemoteSessionHost —— 实现 SessionHost 接口，与 LocalSessionHost 等价可换。
 *
 * 事件路由：daemon 推来的 session_event 帧按 sessionId 分发给对应 open 时注册的 listener。
 * request/result 用自增 id 关联。
 */

import * as net from "node:net";
import { t } from "../i18n.js";
import type {
  RewindMode,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
} from "../session-manager.js";
import type { SessionHost, OpenHandle, PermissionDecisionKind } from "../host.js";
import {
  decodeLines,
  encodeFrame,
  isServerFrame,
  MAX_RESULT_BYTES,
  type ClientRequest,
  type ServerFrame,
} from "./protocol.js";

interface ClientSubscription {
  listener: (ev: SessionEvent) => void;
  buffered: SessionEvent[];
  active: boolean;
  closed: boolean;
  activation?: NodeJS.Immediate;
}

export class DaemonClient implements SessionHost {
  private sock: net.Socket;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      chunks?: string[];
      chunkBytes?: number;
    }
  >();
  private listeners = new Map<string, ClientSubscription>();
  /** 同一 session 的远端 open/close 必须按序确认，避免旧世代事件混入新 snapshot。 */
  private subscriptionOps = new Map<string, Promise<void>>();
  private terminalError: Error | undefined;

  private constructor(sock: net.Socket) {
    this.sock = sock;
    // 使用 socket 内建 StringDecoder，避免中文等 UTF-8 字符跨网络 chunk 时损坏。
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => this.onData(chunk as unknown as string));
    sock.on("error", (error) => this.markTerminal(error));
    sock.on("close", () => {
      this.markTerminal(new Error(t("daemon connection lost", "daemon 连接已断开")));
    });
  }

  static connect(socketPath: string): Promise<DaemonClient> {
    return new Promise((res, rej) => {
      const sock = net.createConnection(socketPath, () => res(new DaemonClient(sock)));
      sock.once("error", rej);
    });
  }

  private onData(chunk: string): void {
    try {
      this.buffer += chunk;
      const { messages, rest } = decodeLines<unknown>(this.buffer);
      this.buffer = rest;
      for (const frame of messages) {
        if (!isServerFrame(frame)) throw new Error(t("Invalid daemon frame", "无效 daemon frame"));
        this.dispatch(frame);
      }
    } catch {
      this.markTerminal(
        new Error(
          t(
            "daemon returned an invalid or oversized protocol frame",
            "daemon 返回了无效或过大的协议帧",
          ),
        ),
      );
      this.sock.destroy();
    }
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private markTerminal(error: Error): void {
    this.terminalError ??= error;
    this.failPending(this.terminalError);
  }

  /** 用户 listener 属于 UI 边界；单个渲染器异常不能截断 socket 帧分发。 */
  private deliver(sub: ClientSubscription, event: SessionEvent): void {
    try {
      sub.listener(event);
    } catch {
      // SessionManager 的本地广播同样隔离 listener；远端保持一致语义。
    }
  }

  private dispatch(frame: ServerFrame): void {
    if (frame.type === "result") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.data);
      else p.reject(new Error(frame.error));
    } else if (frame.type === "result_chunk") {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      pending.chunks ??= [];
      pending.chunkBytes = (pending.chunkBytes ?? 0) + Buffer.byteLength(frame.chunk, "utf8");
      // daemon 是本机受信进程，但仍给损坏/恶意 peer 一个总结果硬上限。
      if (pending.chunkBytes > MAX_RESULT_BYTES) {
        this.pending.delete(frame.id);
        pending.reject(
          new Error(
            t(
              `daemon chunked result exceeds ${MAX_RESULT_BYTES} bytes`,
              `daemon 分块结果超过 ${MAX_RESULT_BYTES} bytes`,
            ),
          ),
        );
        this.markTerminal(
          new Error(
            t("daemon chunked result exceeds the safety limit", "daemon 分块结果超过安全上限"),
          ),
        );
        this.sock.destroy();
        return;
      }
      pending.chunks.push(frame.chunk);
      if (frame.done) {
        this.pending.delete(frame.id);
        try {
          pending.resolve(JSON.parse(pending.chunks.join("")) as unknown);
        } catch {
          pending.reject(
            new Error(t("daemon chunked result is not valid JSON", "daemon 分块结果不是有效 JSON")),
          );
          this.markTerminal(
            new Error(t("daemon chunked result is not valid JSON", "daemon 分块结果不是有效 JSON")),
          );
          this.sock.destroy();
        }
      }
    } else if (frame.type === "session_event") {
      const sub = this.listeners.get(frame.sessionId);
      if (!sub || sub.closed) return;
      if (sub.active) this.deliver(sub, frame.event);
      else sub.buffered.push(frame.event);
    }
  }

  private request<T>(build: (id: number) => ClientRequest): Promise<T> {
    if (this.terminalError || this.sock.destroyed) {
      return Promise.reject(
        this.terminalError ?? new Error(t("daemon connection closed", "daemon 连接已关闭")),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.sock.write(encodeFrame(build(id)));
    });
  }

  private subscriptionOperation<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.subscriptionOps.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    const gate = operation.then(
      () => undefined,
      () => undefined,
    );
    this.subscriptionOps.set(sessionId, gate);
    void gate.then(() => {
      if (this.subscriptionOps.get(sessionId) === gate) this.subscriptionOps.delete(sessionId);
    });
    return operation;
  }

  // ---------- SessionHost ----------

  listSessions(): Promise<SessionSummary[]> {
    return this.request((id) => ({ id, method: "listSessions" }));
  }

  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    return this.request((id) => ({
      id,
      method: "createSession",
      cwd: input.cwd,
      model: input.model,
      ...(input.title ? { title: input.title } : {}),
    }));
  }

  open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle> {
    return this.subscriptionOperation(sessionId, () => this.openSerialized(sessionId, listener));
  }

  private async openSerialized(
    sessionId: string,
    listener: (ev: SessionEvent) => void,
  ): Promise<OpenHandle> {
    // 服务端为避免 snapshot 与订阅之间出现空窗，会先订阅再回结果。因此结果帧
    // 飞行期间可能已经有实时事件到达；先缓冲，等调用方拿到并应用 snapshot 后
    // 再于下一 macrotask 顺序回放，避免旧 snapshot 覆盖新事件。
    const previous = this.listeners.get(sessionId);
    if (previous && !previous.closed) {
      // 重新 open 是新订阅世代。先停止本地路由并等服务端确认 close，期间旧
      // listener 的尾事件直接丢弃；它们会进入随后取得的 snapshot，不能再回放。
      previous.closed = true;
      if (previous.activation) clearImmediate(previous.activation);
      this.listeners.delete(sessionId);
      await this.request((id) => ({ id, method: "close", sessionId }));
    }
    const sub: ClientSubscription = { listener, buffered: [], active: false, closed: false };
    this.listeners.set(sessionId, sub);
    let response: { snapshot?: SessionSnapshot; alreadyOpen?: boolean };
    try {
      response = await this.request((id) => ({ id, method: "open", sessionId }));
    } catch (err) {
      if (this.listeners.get(sessionId) === sub) {
        sub.closed = true;
        this.listeners.delete(sessionId);
      }
      throw err;
    }
    if (!response.snapshot) {
      if (this.listeners.get(sessionId) === sub) {
        sub.closed = true;
        this.listeners.delete(sessionId);
      }
      throw new Error(
        `daemon open(${sessionId}) 未返回 snapshot` +
          (response.alreadyOpen ? "：当前 daemon 不支持安全的重复 open，请升级 daemon" : ""),
      );
    }
    const snapshot = response.snapshot;
    sub.activation = setImmediate(() => {
      if (sub.closed || this.listeners.get(sessionId) !== sub) return;
      sub.active = true;
      for (const event of sub.buffered.splice(0)) this.deliver(sub, event);
    });
    return {
      snapshot,
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        if (sub.activation) clearImmediate(sub.activation);
        if (this.listeners.get(sessionId) !== sub) return;
        this.listeners.delete(sessionId);
        void this.subscriptionOperation(sessionId, () =>
          this.request((id) => ({ id, method: "close", sessionId })),
        ).catch(() => {
          // 连接关闭时取消订阅本就是 best-effort，不能制造 unhandled rejection。
        });
      },
    };
  }

  async send(sessionId: string, text: string, opts?: { model?: string }): Promise<void> {
    await this.request((id) => ({
      id,
      method: "send",
      sessionId,
      text,
      ...(opts?.model ? { model: opts.model } : {}),
    }));
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.request((id) => ({ id, method: "interrupt", sessionId }));
  }

  async undo(
    sessionId: string,
    checkpointId?: string,
    mode?: RewindMode,
  ): Promise<{ restored: number; deleted: number; removedMessages: number }> {
    const data = await this.request((id) => ({
      id,
      method: "undo",
      sessionId,
      ...(checkpointId ? { checkpointId } : {}),
      ...(mode ? { mode } : {}),
    }));
    const r = (data ?? {}) as { restored?: unknown; deleted?: unknown; removedMessages?: unknown };
    return {
      restored: typeof r.restored === "number" ? r.restored : 0,
      deleted: typeof r.deleted === "number" ? r.deleted : 0,
      removedMessages: typeof r.removedMessages === "number" ? r.removedMessages : 0,
    };
  }

  async compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    const data = await this.request((id) => ({ id, method: "compact", sessionId }));
    const r = (data ?? {}) as Record<string, unknown>;
    return {
      compacted: r.compacted === true,
      beforeTokens: typeof r.beforeTokens === "number" ? r.beforeTokens : 0,
      afterTokens: typeof r.afterTokens === "number" ? r.afterTokens : 0,
    };
  }

  async forkSession(
    sessionId: string,
    opts?: { title?: string; upToMessage?: number },
  ): Promise<SessionSummary> {
    const data = await this.request((id) => ({
      id,
      method: "fork",
      sessionId,
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.upToMessage !== undefined ? { upToMessage: opts.upToMessage } : {}),
    }));
    return data as SessionSummary;
  }

  answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionDecisionKind,
  ): Promise<boolean> {
    return this.request((id) => ({ id, method: "answerPermission", sessionId, permId, decision }));
  }

  dispose(): void {
    for (const sub of this.listeners.values()) {
      sub.closed = true;
      if (sub.activation) clearImmediate(sub.activation);
    }
    this.listeners.clear();
    this.markTerminal(new Error(t("daemon client has been disposed", "daemon client 已释放")));
    // end() 只关闭 writable half；异常/旧 daemon 若不回 FIN，会留下 readOnly
    // socket 挂住进程退出。dispose 是终态，直接销毁双向连接。
    this.sock.destroy();
  }
}
