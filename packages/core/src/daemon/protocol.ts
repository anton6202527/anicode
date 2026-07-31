/**
 * 守护进程协议 —— NDJSON over unix socket。
 *
 * 关键改动（相较旧版）：会话事件不再绑定发起 send 的请求，而是走 subscribe 广播。
 * 一个连接 open(subscribe) 某会话后，该会话的所有事件都推给它 —— 无论是谁触发的。
 * 这让多个连接（CLI + App）观察/接管同一会话成为可能。
 */

import { t } from "../i18n.js";
import type {
  RewindMode,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
} from "../session-manager.js";
import type { PermissionDecisionKind } from "../host.js";
import type { PermissionMode } from "../permission.js";

const PERMISSION_MODES: readonly string[] = ["default", "acceptEdits", "auto", "bypass", "plan"];

const REWIND_MODES: readonly string[] = ["files", "conversation", "both"];

const MAX_CWD_CHARS = 32_768;
const MAX_MODEL_CHARS = 512;
const MAX_TITLE_CHARS = 4_096;
const MAX_TEXT_CHARS = 2 * 1024 * 1024;
const MAX_IDEMPOTENCY_KEY_CHARS = 256;
const MAX_TRACEPARENT_CHARS = 512;
const MAX_PROFILE_NAME_CHARS = 128;
const MAX_OPAQUE_ID_CHARS = 256;

// ---------- 客户端 → 守护进程 ----------

export type ClientRequest =
  | { id: number; method: "listSessions" }
  | { id: number; method: "createSession"; cwd: string; model: string; title?: string }
  /** 订阅会话事件；结果里带 snapshot，之后经 session_event 帧推送 */
  | { id: number; method: "open"; sessionId: string }
  /** 取消订阅 */
  | { id: number; method: "close"; sessionId: string }
  | {
      id: number;
      method: "send";
      sessionId: string;
      text: string;
      model?: string;
      idempotencyKey?: string;
      traceparent?: string;
    }
  | { id: number; method: "interrupt"; sessionId: string }
  | { id: number; method: "undo"; sessionId: string; checkpointId?: string; mode?: RewindMode }
  /** fork：复制会话历史成新会话（可截断，或在保留历史时切换模型）。 */
  | {
      id: number;
      method: "fork";
      sessionId: string;
      title?: string;
      upToMessage?: number;
      model?: string;
    }
  /** 手动压缩上下文（/compact）。 */
  | { id: number; method: "compact"; sessionId: string }
  | {
      id: number;
      method: "answerPermission";
      sessionId: string;
      permId: string;
      decision: PermissionDecisionKind;
    }
  /** 运行时切换权限模式（/plan 等）。socket 与 HTTP 传输能力对齐。 */
  | { id: number; method: "setPermissionMode"; sessionId: string; mode: PermissionMode }
  /** 运行时切换权限档位，返回生效 mode。 */
  | { id: number; method: "setPermissionProfile"; sessionId: string; name: string }
  /** 列出会话可用的权限档位。 */
  | { id: number; method: "listPermissionProfiles"; sessionId: string };

// ---------- 守护进程 → 客户端 ----------

export type ServerFrame =
  | { type: "result"; id: number; ok: true; data: unknown }
  | { type: "result"; id: number; ok: false; error: string }
  /** 大结果（主要是长会话 snapshot）按 data 的 JSON 文本分帧，避免单行撞上限。 */
  | { type: "result_chunk"; id: number; chunk: string; done: boolean }
  /** 已订阅会话的实时事件（与触发它的 request 解耦） */
  | { type: "session_event"; sessionId: string; event: SessionEvent };

// 复用 SessionManager 的类型作为线上数据形状
export type { SessionSnapshot, SessionSummary };

// ---------- NDJSON 编解码 ----------

export function encodeFrame(frame: ServerFrame | ClientRequest): string {
  return JSON.stringify(frame) + "\n";
}

/** 单个 NDJSON frame 的默认上限，避免异常对端让未完成 buffer 无界增长。 */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** 单个 request/result 聚合后的总上限；长 snapshot 会分帧，但不能无限占用内存。 */
export const MAX_RESULT_BYTES = 256 * 1024 * 1024;

/** 256K UTF-16 code units；即使全是 JSON 六字节转义也远低于单帧 4 MiB。 */
export const RESULT_CHUNK_CHARS = 256 * 1024;

/** 把字节流按行切成完整 JSON 对象；返回解析结果 + 剩余未完成 buffer */
export function decodeLines<T>(
  buffer: string,
  maxFrameBytes = MAX_FRAME_BYTES,
): { messages: T[]; rest: string } {
  const messages: T[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf("\n")) >= 0) {
    const line = rest.slice(0, idx);
    rest = rest.slice(idx + 1);
    if (Buffer.byteLength(line, "utf8") > maxFrameBytes) {
      throw new Error(
        t(
          `daemon frame exceeds ${maxFrameBytes} bytes`,
          `daemon frame 超过 ${maxFrameBytes} bytes`,
        ),
      );
    }
    if (line.trim()) messages.push(JSON.parse(line) as T);
  }
  if (Buffer.byteLength(rest, "utf8") > maxFrameBytes) {
    throw new Error(
      t(`daemon frame exceeds ${maxFrameBytes} bytes`, `daemon frame 超过 ${maxFrameBytes} bytes`),
    );
  }
  return { messages, rest };
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringBetween(value: unknown, min: number, max: number): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function optionalStringBetween(value: unknown, min: number, max: number): boolean {
  return value === undefined || stringBetween(value, min, max);
}

function sessionId(value: unknown): value is string {
  return stringBetween(value, 1, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

/** JSON.parse 只保证语法，不保证协议形状；在进入异步 dispatch 前做边界校验。 */
export function isClientRequest(value: unknown): value is ClientRequest {
  const frame = objectRecord(value);
  if (
    !frame ||
    typeof frame.id !== "number" ||
    !Number.isSafeInteger(frame.id) ||
    frame.id < 0 ||
    typeof frame.method !== "string"
  )
    return false;
  switch (frame.method) {
    case "listSessions":
      return true;
    case "createSession":
      return (
        stringBetween(frame.cwd, 1, MAX_CWD_CHARS) &&
        stringBetween(frame.model, 1, MAX_MODEL_CHARS) &&
        optionalStringBetween(frame.title, 1, MAX_TITLE_CHARS)
      );
    case "open":
    case "close":
    case "interrupt":
    case "compact":
    case "listPermissionProfiles":
      return sessionId(frame.sessionId);
    case "setPermissionMode":
      return (
        sessionId(frame.sessionId) &&
        typeof frame.mode === "string" &&
        PERMISSION_MODES.includes(frame.mode)
      );
    case "setPermissionProfile":
      return sessionId(frame.sessionId) && stringBetween(frame.name, 1, MAX_PROFILE_NAME_CHARS);
    case "undo":
      return (
        sessionId(frame.sessionId) &&
        optionalStringBetween(frame.checkpointId, 1, MAX_OPAQUE_ID_CHARS) &&
        (frame.mode === undefined ||
          (typeof frame.mode === "string" && REWIND_MODES.includes(frame.mode)))
      );
    case "fork":
      return (
        sessionId(frame.sessionId) &&
        optionalStringBetween(frame.title, 1, MAX_TITLE_CHARS) &&
        optionalStringBetween(frame.model, 1, MAX_MODEL_CHARS) &&
        (frame.upToMessage === undefined ||
          (typeof frame.upToMessage === "number" &&
            Number.isSafeInteger(frame.upToMessage) &&
            frame.upToMessage >= 0))
      );
    case "send":
      return (
        sessionId(frame.sessionId) &&
        stringBetween(frame.text, 1, MAX_TEXT_CHARS) &&
        optionalStringBetween(frame.model, 1, MAX_MODEL_CHARS) &&
        optionalStringBetween(frame.idempotencyKey, 1, MAX_IDEMPOTENCY_KEY_CHARS) &&
        optionalStringBetween(frame.traceparent, 1, MAX_TRACEPARENT_CHARS)
      );
    case "answerPermission":
      return (
        sessionId(frame.sessionId) &&
        stringBetween(frame.permId, 1, MAX_OPAQUE_ID_CHARS) &&
        (frame.decision === "allow" ||
          frame.decision === "allow_remember" ||
          frame.decision === "allow_always" ||
          frame.decision === "deny")
      );
    default:
      return false;
  }
}

export function isServerFrame(value: unknown): value is ServerFrame {
  const frame = objectRecord(value);
  if (!frame || typeof frame.type !== "string") return false;
  if (frame.type === "result") {
    return (
      typeof frame.id === "number" &&
      Number.isSafeInteger(frame.id) &&
      (frame.ok === true || (frame.ok === false && typeof frame.error === "string"))
    );
  }
  if (frame.type === "result_chunk") {
    return (
      typeof frame.id === "number" &&
      Number.isSafeInteger(frame.id) &&
      typeof frame.chunk === "string" &&
      typeof frame.done === "boolean"
    );
  }
  return (
    frame.type === "session_event" &&
    typeof frame.sessionId === "string" &&
    objectRecord(frame.event) !== undefined
  );
}
