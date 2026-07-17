/**
 * 守护进程服务端 —— SessionManager 之上的一层 socket 转发。
 *
 * 极薄：所有会话逻辑都在 SessionManager。server 只做三件事——
 *   1. 把 ClientRequest 翻译成 manager 调用
 *   2. open 时给该连接挂一个订阅，manager 的会话事件 → session_event 帧
 *   3. 连接断开时清理它的所有订阅
 *
 * 因为逻辑都在 manager，进程内（LocalSessionHost）与跨进程（daemon）行为天然等价。
 */

import * as net from "node:net";
import { t } from "../i18n.js";
import { SessionManager, type SessionEvent } from "../session-manager.js";
import {
  decodeLines,
  encodeFrame,
  isClientRequest,
  MAX_FRAME_BYTES,
  MAX_RESULT_BYTES,
  RESULT_CHUNK_CHARS,
  type ClientRequest,
  type ServerFrame,
} from "./protocol.js";

export interface DaemonServerOptions {
  manager: SessionManager;
}

export class DaemonServer {
  private server: net.Server;
  private manager: SessionManager;
  private conns = new Set<net.Socket>();

  constructor(opts: DaemonServerOptions) {
    this.manager = opts.manager;
    this.server = net.createServer((sock) => this.onConnection(sock));
  }

  listen(socketPath: string): Promise<void> {
    return new Promise((res, rej) => {
      this.server.once("error", rej);
      this.server.listen(socketPath, () => res());
    });
  }

  /** 关闭：先断开所有连接（否则 server.close 会等待它们自然结束），再停监听 */
  close(): Promise<void> {
    this.manager.dispose();
    for (const sock of this.conns) sock.destroy();
    this.conns.clear();
    return new Promise((res) => this.server.close(() => res()));
  }

  private onConnection(sock: net.Socket): void {
    this.conns.add(sock);
    // 让 Node 的 StringDecoder 跨 Buffer 边界保留 UTF-8 多字节字符。
    sock.setEncoding("utf8");
    let buffer = "";
    let connectionClosed = false;
    // 该连接的订阅：sessionId → unsubscribe
    const subs = new Map<string, () => void>();
    // 仅把同一 session 的 open/close 串行化；send/permission 仍可并行，避免
    // send 等授权时把 answerPermission 排在自己后面造成死锁。
    const subscriptionOps = new Map<string, Promise<void>>();
    const write = (frame: ServerFrame): boolean => {
      if (sock.destroyed) return true;
      const encoded = encodeFrame(frame);
      const bytes = Buffer.byteLength(encoded, "utf8");
      // session_event 由同步 listener 发出，无法 await drain；慢客户端最多占用
      // 有界 writable buffer，超过后只断该观察连接，不拖垮 daemon。
      if (bytes > MAX_FRAME_BYTES || sock.writableLength + bytes > MAX_FRAME_BYTES * 4) {
        sock.destroy();
        return true;
      }
      return sock.write(encoded);
    };
    const waitForDrain = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const cleanupWait = () => {
          sock.off("drain", onDrain);
          sock.off("close", onClose);
          sock.off("error", onError);
        };
        const onDrain = () => {
          cleanupWait();
          resolve();
        };
        const onClose = () => {
          cleanupWait();
          reject(new Error(t("Client connection closed", "客户端连接已关闭")));
        };
        const onError = (error: Error) => {
          cleanupWait();
          reject(error);
        };
        sock.once("drain", onDrain);
        sock.once("close", onClose);
        sock.once("error", onError);
      });

    sock.on("data", (chunk) => {
      try {
        buffer += chunk;
        const { messages, rest } = decodeLines<unknown>(buffer);
        buffer = rest;
        for (const req of messages) {
          if (!isClientRequest(req)) {
            sock.destroy();
            return;
          }
          void this.handle(req, write, waitForDrain, subs, subscriptionOps, () => connectionClosed);
        }
      } catch {
        // 协议错误只关闭当前连接，不能让未捕获的 JSON.parse 异常击穿 daemon。
        sock.destroy();
      }
    });
    const cleanup = () => {
      connectionClosed = true;
      for (const unsub of subs.values()) unsub();
      subs.clear();
      this.conns.delete(sock);
    };
    sock.on("close", cleanup);
    sock.on("error", cleanup);
  }

  private async handle(
    req: ClientRequest,
    write: (f: ServerFrame) => boolean,
    waitForDrain: () => Promise<void>,
    subs: Map<string, () => void>,
    subscriptionOps: Map<string, Promise<void>>,
    isConnectionClosed: () => boolean,
  ): Promise<void> {
    const sessionId = req.method === "open" || req.method === "close" ? req.sessionId : undefined;
    const run = () => this.dispatch(req, write, subs, isConnectionClosed);
    let operation: Promise<unknown>;
    let gate: Promise<void> | undefined;
    if (sessionId) {
      const previous = subscriptionOps.get(sessionId) ?? Promise.resolve();
      operation = previous.catch(() => undefined).then(run);
      gate = operation.then(
        () => undefined,
        () => undefined,
      );
      subscriptionOps.set(sessionId, gate);
    } else {
      operation = run();
    }
    try {
      const data = await operation;
      await this.writeResult(req.id, data, write, waitForDrain);
    } catch (err) {
      write({
        type: "result",
        id: req.id,
        ok: false,
        error: String((err as Error).message).slice(0, 16_384),
      });
    } finally {
      if (sessionId && gate && subscriptionOps.get(sessionId) === gate) {
        subscriptionOps.delete(sessionId);
      }
    }
  }

  private async writeResult(
    id: number,
    data: unknown,
    write: (frame: ServerFrame) => boolean,
    waitForDrain: () => Promise<void>,
  ): Promise<void> {
    const frame: ServerFrame = { type: "result", id, ok: true, data };
    // 先只序列化 data，避免为了判断是否需分块而先构造一份数百 MiB 的完整 frame。
    const serialized = JSON.stringify(data) ?? "null";
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > MAX_RESULT_BYTES) {
      throw new Error(
        t(
          `daemon result exceeds ${MAX_RESULT_BYTES} bytes`,
          `daemon 结果超过 ${MAX_RESULT_BYTES} bytes`,
        ),
      );
    }
    // 固定字段开销远小于 256 bytes；这里保守预留，边界附近宁可分块。
    if (serializedBytes + 256 <= MAX_FRAME_BYTES) {
      write(frame);
      return;
    }

    // 只分割 result.data 的 JSON 表示，client 收齐后再 parse。每个 NDJSON frame
    // 都保持独立合法；不会因为一个 4 MiB+ transcript 断开整个连接。
    for (let offset = 0; offset < serialized.length; offset += RESULT_CHUNK_CHARS) {
      const end = Math.min(serialized.length, offset + RESULT_CHUNK_CHARS);
      const writable = write({
        type: "result_chunk",
        id,
        chunk: serialized.slice(offset, end),
        done: end === serialized.length,
      });
      if (!writable) await waitForDrain();
    }
  }

  private async dispatch(
    req: ClientRequest,
    write: (f: ServerFrame) => void,
    subs: Map<string, () => void>,
    isConnectionClosed: () => boolean,
  ): Promise<unknown> {
    switch (req.method) {
      case "listSessions":
        return this.manager.listSessions();
      case "createSession":
        return this.manager.createSession({
          cwd: req.cwd,
          model: req.model,
          ...(req.title ? { title: req.title } : {}),
        });
      case "open": {
        if (isConnectionClosed())
          throw new Error(t("Client connection closed", "客户端连接已关闭"));
        if (subs.has(req.sessionId)) {
          // 同一连接重复 open 时复用已有订阅，但仍必须履行
          // SessionHost.open 的快照契约。临时 open 只用于取最新 snapshot，
          // 立即关闭其 listener，不增加远程事件订阅。
          const handle = await this.manager.open(req.sessionId, () => {});
          handle.close();
          return { snapshot: handle.snapshot, alreadyOpen: true };
        }
        const listener = (event: SessionEvent) =>
          write({ type: "session_event", sessionId: req.sessionId, event });
        const handle = await this.manager.open(req.sessionId, listener);
        if (isConnectionClosed()) handle.close();
        else subs.set(req.sessionId, handle.close);
        return { snapshot: handle.snapshot };
      }
      case "close": {
        subs.get(req.sessionId)?.();
        subs.delete(req.sessionId);
        return null;
      }
      case "send":
        await this.manager.send(req.sessionId, req.text, req.model ? { model: req.model } : undefined);
        return null;
      case "interrupt":
        await this.manager.interrupt(req.sessionId);
        return null;
      case "undo":
        return this.manager.undo(req.sessionId, req.checkpointId);
      case "answerPermission":
        return this.manager.answerPermission(req.sessionId, req.permId, req.decision);
    }
  }
}
