/**
 * 极简 WebSocket 客户端（RFC 6455）—— 零依赖，仅够驱动 Chrome DevTools Protocol。
 *
 * 为什么自研：本仓坚持「自研·零依赖」，而 CDP 只走本机 ws://（localhost），
 * 不需要 TLS / permessage-deflate / 子协议协商等重型特性。于是这里只实现：
 *   - 客户端握手（Sec-WebSocket-Key / Accept 校验）
 *   - 文本帧收发（客户端发出的帧必须掩码；服务端帧不掩码）
 *   - 分片重组（continuation）、ping→pong、close
 * 二进制帧原样忽略（CDP 全走文本 JSON）。帧编解码抽成纯函数，离线可单测。
 */
import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** 计算握手应答 key：base64(sha1(clientKey + GUID))，用于校验服务端 101 应答。 */
export function acceptKey(clientKey: string): string {
  return createHash("sha1")
    .update(clientKey + GUID)
    .digest("base64");
}

/**
 * 编码一个客户端文本帧（FIN=1、opcode=0x1、掩码=1）。掩码键由调用方注入（便于测试）。
 * 负载长度按 7 / 7+16 / 7+64 位三档编码。
 */
export function encodeTextFrame(text: string, maskKey: Buffer): Buffer {
  const payload = Buffer.from(text, "utf8");
  return encodeFrame(0x1, payload, maskKey);
}

function encodeFrame(opcode: number, payload: Buffer, maskKey: Buffer): Buffer {
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len]);
  } else if (len < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    // 高 32 位置 0（Node Buffer 无 64 位写入且负载不会超 4GB）。
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(len, 6);
  }
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i]! ^ maskKey[i & 3]!;
  return Buffer.concat([header, maskKey, masked]);
}

export interface DecodedFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
  /** 消费掉的总字节数（头 + 负载）。 */
  size: number;
}

/**
 * 尝试从 buffer 头部解出一个帧。数据不足返回 null（调用方续等）。
 * 服务端→客户端帧不带掩码；若带掩码也照解（宽容）。
 */
export function decodeFrame(buf: Buffer): DecodedFrame | null {
  if (buf.length < 2) return null;
  const b0 = buf[0]!;
  const b1 = buf[1]!;
  const fin = (b0 & 0x80) !== 0;
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) {
    if (buf.length < offset + 2) return null;
    len = buf.readUInt16BE(offset);
    offset += 2;
  } else if (len === 127) {
    if (buf.length < offset + 8) return null;
    const hi = buf.readUInt32BE(offset);
    const lo = buf.readUInt32BE(offset + 4);
    len = hi * 0x100000000 + lo;
    offset += 8;
  }
  let maskKey: Buffer | undefined;
  if (masked) {
    if (buf.length < offset + 4) return null;
    maskKey = buf.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buf.length < offset + len) return null;
  let payload = buf.subarray(offset, offset + len);
  if (maskKey) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i]! ^ maskKey[i & 3]!;
    payload = out;
  }
  return { fin, opcode, payload, size: offset + len };
}

export interface WsHandlers {
  onMessage?: (text: string) => void;
  onClose?: (reason?: string) => void;
  onError?: (err: Error) => void;
}

/** 一条已连上的 WebSocket。仅暴露 send(text) / close()；文本消息经 handlers.onMessage 回流。 */
export class WsClient {
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragOpcode = 0;
  private closed = false;

  private constructor(
    private readonly sock: Socket,
    private readonly handlers: WsHandlers,
  ) {
    // unref：CDP socket 不拖住 Node 事件循环退出（有活时照常收发）。
    sock.unref();
    sock.on("data", (chunk) => this.onData(chunk));
    sock.on("close", () => this.finish());
    sock.on("error", (err) => {
      if (!this.closed) this.handlers.onError?.(err);
    });
  }

  static connect(url: string, handlers: WsHandlers, timeoutMs = 10_000): Promise<WsClient> {
    const u = new URL(url);
    if (u.protocol !== "ws:") {
      return Promise.reject(new Error(`unsupported ws protocol: ${u.protocol} (only ws:// )`));
    }
    const host = u.hostname;
    const port = Number(u.port || 80);
    const path = u.pathname + u.search;
    const key = randomBytes(16).toString("base64");
    return new Promise((resolve, reject) => {
      const sock = connect({ host, port }, () => {
        sock.write(
          `GET ${path} HTTP/1.1\r\n` +
            `Host: ${host}:${port}\r\n` +
            `Upgrade: websocket\r\n` +
            `Connection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\n` +
            `Sec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`ws connect timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      let handshake = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        handshake = Buffer.concat([handshake, chunk]);
        const sep = handshake.indexOf("\r\n\r\n");
        if (sep === -1) return;
        clearTimeout(timer);
        sock.removeListener("data", onData);
        const head = handshake.subarray(0, sep).toString("utf8");
        const status = head.split("\r\n")[0] ?? "";
        if (!/ 101 /.test(status)) {
          sock.destroy();
          reject(new Error(`ws handshake failed: ${status}`));
          return;
        }
        const accept = /sec-websocket-accept:\s*(.+)/i.exec(head)?.[1]?.trim();
        if (accept !== acceptKey(key)) {
          sock.destroy();
          reject(new Error("ws handshake failed: bad Sec-WebSocket-Accept"));
          return;
        }
        const client = new WsClient(sock, handlers);
        const rest = handshake.subarray(sep + 4);
        if (rest.length > 0) client.onData(rest);
        resolve(client);
      };
      sock.on("data", onData);
      sock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  send(text: string): void {
    if (this.closed) return;
    this.sock.write(encodeTextFrame(text, randomBytes(4)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      // 0x8 = close，带掩码空负载。
      this.sock.write(encodeFrame(0x8, Buffer.alloc(0), randomBytes(4)));
      this.sock.end();
    } catch {
      /* 已断开，忽略 */
    }
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      const frame = decodeFrame(this.buf);
      if (!frame) return;
      this.buf = this.buf.subarray(frame.size);
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: DecodedFrame): void {
    const { fin, opcode, payload } = frame;
    if (opcode === 0x8) {
      this.close();
      this.finish();
      return;
    }
    if (opcode === 0x9) {
      // ping → pong（原样回负载）。
      if (!this.closed) this.sock.write(encodeFrame(0xa, payload, randomBytes(4)));
      return;
    }
    if (opcode === 0xa) return; // pong
    // 数据帧：0x1 文本 / 0x2 二进制 / 0x0 续帧。
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragOpcode = opcode;
      this.fragments = [payload];
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    }
    if (fin) {
      const full = this.fragments.length === 1 ? this.fragments[0]! : Buffer.concat(this.fragments);
      this.fragments = [];
      if (this.fragOpcode === 0x1) this.handlers.onMessage?.(full.toString("utf8"));
    }
  }

  private finish(): void {
    if (this.closed && this.buf.length === 0) {
      /* 已由 close() 触发 */
    }
    const wasClosed = this.closed;
    this.closed = true;
    if (!wasClosed) this.handlers.onClose?.();
  }
}
