import { appendFileSync, chmodSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { appendFile, chmod, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { OpenHandle, PermissionDecisionKind, SessionEvent, SessionHost } from "@anicode/core";

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b((?:authorization|proxy-authorization)\s*:\s*(?:Basic|Bearer|Digest|Token)?\s*)[^\s"',;]+/gi,
  /\b(api[_-]?key["']?\s*[:=]\s*["']?)[^\s,"']+/gi,
  /\b((?:access[_-]?token|password|client[_-]?secret|cookie)["']?\s*[:=]\s*["']?)[^\s,"']+/gi,
  /\b(?:AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[0-9A-Za-z]{20,})\b/g,
];

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FIELD_CHARS = 64 * 1024;
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 50;
const MAX_COLLECTION_ITEMS = 200;
const SECRET_FIELD = /(?:api[_-]?key|authorization|password|secret|credential|cookie|token)$/i;

export interface DebugLoggerOptions {
  /** Rotate to `<file>.1` before this JSONL file would exceed the limit. */
  maxBytes?: number;
  /** Bound individual trace-content strings so one provider event cannot exhaust memory/disk. */
  maxFieldChars?: number;
  /** Bound queued records while an unusually slow filesystem is being flushed. */
  maxPendingBytes?: number;
  /** Batch interval; zero is useful for deterministic tests. */
  flushIntervalMs?: number;
}

function redact(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix: string | undefined) =>
      prefix && /^Bearer|api/i.test(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return result;
}

function safeValue(
  value: unknown,
  seen = new WeakSet<object>(),
  key = "",
  maxFieldChars = DEFAULT_MAX_FIELD_CHARS,
): unknown {
  if (typeof value === "string") {
    if (SECRET_FIELD.test(key)) return "[REDACTED]";
    const safe = redact(value);
    return safe.length <= maxFieldChars
      ? safe
      : `${safe.slice(0, maxFieldChars)}…[truncated ${safe.length - maxFieldChars} chars]`;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = value
      .slice(0, MAX_COLLECTION_ITEMS)
      .map((item) => safeValue(item, seen, key, maxFieldChars));
    if (value.length > MAX_COLLECTION_ITEMS) {
      result.push(`[truncated ${value.length - MAX_COLLECTION_ITEMS} items]`);
    }
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const entries = Object.entries(value);
    const result = Object.fromEntries(
      entries
        .slice(0, MAX_COLLECTION_ITEMS)
        .map(([itemKey, item]) => [itemKey, safeValue(item, seen, itemKey, maxFieldChars)]),
    );
    if (entries.length > MAX_COLLECTION_ITEMS) {
      result["_truncatedFields"] = entries.length - MAX_COLLECTION_ITEMS;
    }
    seen.delete(value);
    return result;
  }
  return value;
}

export class DebugLogger {
  readonly file: string;
  private failed = false;
  private closing = false;
  private readonly maxBytes: number;
  private readonly maxFieldChars: number;
  private readonly maxPendingBytes: number;
  private readonly flushIntervalMs: number;
  private currentBytes = 0;
  private pending: string[] = [];
  private pendingBytes = 0;
  private droppedRecords = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    file: string,
    private readonly traceContent = false,
    options: DebugLoggerOptions = {},
  ) {
    this.file = path.resolve(file);
    this.maxBytes = positiveInteger(options.maxBytes ?? DEFAULT_MAX_BYTES, "maxBytes", 512);
    this.maxFieldChars = positiveInteger(
      options.maxFieldChars ?? DEFAULT_MAX_FIELD_CHARS,
      "maxFieldChars",
      32,
    );
    this.maxPendingBytes = positiveInteger(
      options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES,
      "maxPendingBytes",
      512,
    );
    this.flushIntervalMs = nonNegativeInteger(
      options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS,
      "flushIntervalMs",
    );
    mkdirSync(path.dirname(this.file), { recursive: true });
    // 启动阶段就验证路径可写；运行中的磁盘错误则降级停记，不能截断 TUI 事件。
    appendFileSync(this.file, "", { encoding: "utf8", mode: 0o600 });
    // mode 只影响新建文件；既有日志也必须收紧，尤其 trace-content 会含原文。
    chmodSync(this.file, 0o600);
    this.currentBytes = statSync(this.file).size;
    this.rotateIfNeeded(0);
  }

  log(kind: string, data: Record<string, unknown> = {}): void {
    if (this.failed || this.closing) return;
    try {
      const record = safeValue(
        {
          ...data,
          time: new Date().toISOString(),
          kind,
        },
        new WeakSet<object>(),
        "",
        this.maxFieldChars,
      );
      let line = `${JSON.stringify(record)}\n`;
      let bytes = Buffer.byteLength(line);
      if (bytes > this.maxBytes) {
        line = `${JSON.stringify({
          time: new Date().toISOString(),
          kind,
          truncated: true,
          originalBytes: bytes,
        })}\n`;
        bytes = Buffer.byteLength(line);
      }
      if (this.pendingBytes + bytes > this.maxPendingBytes) {
        this.droppedRecords++;
        this.scheduleFlush();
        return;
      }
      this.pending.push(line);
      this.pendingBytes += bytes;
      this.scheduleFlush();
    } catch {
      this.failed = true;
    }
  }

  /** Flush buffered records without blocking the TUI event loop. */
  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.queueWrite();
    await this.writeChain;
  }

  /** Normal shutdown path. Kept separate so future sinks can release handles here. */
  async close(): Promise<void> {
    this.closing = true;
    await this.flush();
  }

  /** Signal/exception fallback: terminal teardown cannot await promises. */
  flushSync(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const lines = this.takePending();
    if (lines.length === 0 || this.failed) return;
    try {
      for (const line of lines) {
        const bytes = Buffer.byteLength(line);
        this.rotateIfNeeded(bytes);
        appendFileSync(this.file, line, "utf8");
        this.currentBytes += bytes;
      }
    } catch {
      this.failed = true;
    }
  }

  sessionEvent(sessionId: string, event: SessionEvent): void {
    this.log("session.event", {
      sessionId,
      event: summarizeEvent(event, this.traceContent),
    });
  }

  textField(name: string, value: string): Record<string, unknown> {
    return this.traceContent ? { [name]: value } : { [`${name}Chars`]: value.length };
  }

  private rotateIfNeeded(incomingBytes: number): void {
    if (this.currentBytes === 0 || this.currentBytes + incomingBytes <= this.maxBytes) return;
    const backup = `${this.file}.1`;
    rmSync(backup, { force: true });
    renameSync(this.file, backup);
    appendFileSync(this.file, "", { encoding: "utf8", mode: 0o600 });
    chmodSync(this.file, 0o600);
    this.currentBytes = 0;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.failed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      this.queueWrite();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private takePending(): string[] {
    const lines = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    if (this.droppedRecords > 0) {
      lines.push(
        `${JSON.stringify({
          time: new Date().toISOString(),
          kind: "logger.dropped",
          records: this.droppedRecords,
        })}\n`,
      );
      this.droppedRecords = 0;
    }
    return lines;
  }

  private queueWrite(): void {
    const lines = this.takePending();
    if (lines.length === 0 || this.failed) return;
    this.writeChain = this.writeChain
      .then(() => this.writeBatch(lines))
      .catch(() => {
        this.failed = true;
      });
  }

  private async writeBatch(lines: readonly string[]): Promise<void> {
    let chunk = "";
    let chunkBytes = 0;
    const appendChunk = async (): Promise<void> => {
      if (!chunk) return;
      await appendFile(this.file, chunk, "utf8");
      this.currentBytes += chunkBytes;
      chunk = "";
      chunkBytes = 0;
    };
    const rotateFile = async (): Promise<void> => {
      await appendChunk();
      const backup = `${this.file}.1`;
      await rm(backup, { force: true });
      await rename(this.file, backup);
      await writeFile(this.file, "", { encoding: "utf8", mode: 0o600 });
      await chmod(this.file, 0o600);
      this.currentBytes = 0;
    };

    for (const line of lines) {
      const bytes = Buffer.byteLength(line);
      if (
        this.currentBytes + chunkBytes > 0 &&
        this.currentBytes + chunkBytes + bytes > this.maxBytes
      ) {
        await rotateFile();
      }
      chunk += line;
      chunkBytes += bytes;
    }
    await appendChunk();
  }
}

function positiveInteger(value: number, name: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`Debug log ${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Debug log ${name} must be a non-negative safe integer`);
  }
  return value;
}

function summarizeEvent(event: SessionEvent, traceContent: boolean): Record<string, unknown> {
  if (event.type === "state") return { type: event.type, running: event.running };
  if (event.type === "permission_request") {
    return {
      type: event.type,
      permId: event.permId,
      toolName: event.toolName,
      ...(traceContent ? { ruleKey: event.ruleKey } : { ruleKeyChars: event.ruleKey.length }),
    };
  }
  // permission_resolved 等会话级控制事件可能由更新后的 core 增加；只记录标量字段。
  if (event.type !== "agent") return safeValue(event) as Record<string, unknown>;

  const agent = event.event;
  switch (agent.type) {
    case "user_message":
      return {
        type: "agent.user_message",
        queued: agent.queued,
        ...(traceContent ? { text: agent.text } : { chars: agent.text.length }),
      };
    case "text":
    case "thinking":
      return {
        type: `agent.${agent.type}`,
        ...(traceContent ? { text: agent.text } : { chars: agent.text.length }),
      };
    case "tool_input_delta":
      return {
        type: "agent.tool_input_delta",
        id: agent.id,
        name: agent.name,
        ...(traceContent ? { delta: agent.delta } : { chars: agent.delta.length }),
      };
    case "tool_result":
      return {
        type: "agent.tool_result",
        id: agent.id,
        name: agent.name,
        isError: agent.isError,
        ...(traceContent ? { content: agent.content } : { chars: agent.content.length }),
      };
    case "tool_start":
      return {
        type: "agent.tool_start",
        id: agent.id,
        name: agent.name,
        ...(traceContent ? { ruleKey: agent.ruleKey } : { ruleKeyChars: agent.ruleKey.length }),
      };
    case "tool_permission":
      return {
        type: "agent.tool_permission",
        id: agent.id,
        name: agent.name,
        decision: agent.decision,
      };
    case "tool_progress":
      return {
        type: "agent.tool_progress",
        id: agent.id,
        name: agent.name,
        ...(traceContent ? { event: agent.event } : {}),
      };
    case "retry":
      return {
        type: "agent.retry",
        attempt: agent.attempt,
        delayMs: agent.delayMs,
        ...(traceContent ? { reason: agent.reason } : { reasonChars: agent.reason.length }),
      };
    case "error":
      return {
        type: "agent.error",
        ...(traceContent ? { message: agent.message } : { messageChars: agent.message.length }),
      };
    case "turn_end":
      return { type: "agent.turn_end", usage: agent.usage };
    case "done":
      return { type: "agent.done", usage: agent.usage, turns: agent.turns };
    case "compacted":
      return {
        type: "agent.compacted",
        beforeTokens: agent.beforeTokens,
        afterTokens: agent.afterTokens,
      };
    case "turn_reset":
      return { type: "agent.turn_reset" };
    default:
      // 新增事件默认只记录类型；内容字段必须显式进入上面的白名单。
      return { type: `agent.${(agent as { type: string }).type}` };
  }
}

async function timed<T>(
  logger: DebugLogger,
  operation: string,
  data: Record<string, unknown>,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  logger.log("host.start", { operation, ...data });
  try {
    const result = await run();
    logger.log("host.end", { operation, durationMs: Date.now() - started, ok: true });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.log("host.end", {
      operation,
      durationMs: Date.now() - started,
      ok: false,
      ...logger.textField("error", message),
    });
    throw error;
  }
}

/** 给任意本地/远程 SessionHost 加同一套安全 JSONL 诊断，不改变其行为。 */
export function withDebugLogging(host: SessionHost, logger: DebugLogger): SessionHost {
  return {
    ...(host.discoverModels
      ? {
          discoverModels: (providerId: string) =>
            timed(logger, "discoverModels", { providerId }, () => host.discoverModels!(providerId)),
        }
      : {}),
    listSessions: () => timed(logger, "listSessions", {}, () => host.listSessions()),
    createSession: (input) =>
      timed(
        logger,
        "createSession",
        {
          cwd: input.cwd,
          model: input.model,
          ...(input.title ? logger.textField("title", input.title) : {}),
        },
        () => host.createSession(input),
      ),
    open: (sessionId, listener): Promise<OpenHandle> =>
      timed(logger, "open", { sessionId }, async () => {
        const handle = await host.open(sessionId, (event) => {
          logger.sessionEvent(sessionId, event);
          listener(event);
        });
        logger.log("session.snapshot", {
          sessionId,
          model: handle.snapshot.meta.model,
          cwd: handle.snapshot.meta.cwd,
          messages: handle.snapshot.messages.length,
          running: handle.snapshot.running,
          pendingPermissions: handle.snapshot.pendingPermissions.length,
        });
        return {
          snapshot: handle.snapshot,
          ...(handle.closed ? { closed: handle.closed } : {}),
          close: () => {
            logger.log("host.close", { sessionId });
            handle.close();
          },
        };
      }),
    send: (sessionId, text, opts) =>
      timed(
        logger,
        "send",
        {
          sessionId,
          ...logger.textField("text", text),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
          ...(opts?.traceparent ? { traceparent: opts.traceparent } : {}),
        },
        () => host.send(sessionId, text, opts),
      ),
    interrupt: (sessionId) =>
      timed(logger, "interrupt", { sessionId }, () => host.interrupt(sessionId)),
    undo: (sessionId, checkpointId, mode) =>
      timed(
        logger,
        "undo",
        { sessionId, ...(checkpointId ? { checkpointId } : {}), ...(mode ? { mode } : {}) },
        () => host.undo(sessionId, checkpointId, mode),
      ),
    answerPermission: (sessionId: string, permId: string, decision: PermissionDecisionKind) =>
      timed(logger, "answerPermission", { sessionId, permId, decision }, () =>
        host.answerPermission(sessionId, permId, decision),
      ),
    ...(host.forkSession
      ? {
          forkSession: (
            sessionId: string,
            opts?: { title?: string; upToMessage?: number; model?: string },
          ) =>
            timed(
              logger,
              "forkSession",
              {
                sessionId,
                ...(opts?.title ? logger.textField("title", opts.title) : {}),
                ...(opts?.upToMessage !== undefined ? { upToMessage: opts.upToMessage } : {}),
              },
              () => host.forkSession!(sessionId, opts),
            ),
        }
      : {}),
    ...(host.compact
      ? {
          compact: (sessionId: string) =>
            timed(logger, "compact", { sessionId }, () => host.compact!(sessionId)),
        }
      : {}),
    ...(host.setPermissionMode
      ? {
          setPermissionMode: (
            sessionId: string,
            mode: Parameters<NonNullable<SessionHost["setPermissionMode"]>>[1],
          ) =>
            timed(logger, "setPermissionMode", { sessionId, mode }, () =>
              host.setPermissionMode!(sessionId, mode),
            ),
        }
      : {}),
    ...(host.setPermissionProfile
      ? {
          setPermissionProfile: (sessionId: string, name: string) =>
            timed(logger, "setPermissionProfile", { sessionId, name }, () =>
              host.setPermissionProfile!(sessionId, name),
            ),
        }
      : {}),
    ...(host.listPermissionProfiles
      ? {
          listPermissionProfiles: (sessionId: string) =>
            timed(logger, "listPermissionProfiles", { sessionId }, () =>
              host.listPermissionProfiles!(sessionId),
            ),
        }
      : {}),
    dispose: () => {
      try {
        logger.log("host.dispose");
      } finally {
        host.dispose();
      }
    },
  };
}
