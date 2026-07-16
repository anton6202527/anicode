import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import type { OpenHandle, PermissionDecisionKind, SessionEvent, SessionHost } from "@anicode/core";

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{8,})\b/g,
  /\b(Bearer\s+)[^\s"']+/gi,
  /\b(api[_-]?key["']?\s*[:=]\s*["']?)[^\s,"']+/gi,
];

function redact(value: string): string {
  let result = value;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (_match, prefix: string | undefined) =>
      prefix && /^Bearer|api/i.test(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return result;
}

function safeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = value.map((item) => safeValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, safeValue(item, seen)]),
    );
    seen.delete(value);
    return result;
  }
  return value;
}

export class DebugLogger {
  readonly file: string;
  private failed = false;

  constructor(
    file: string,
    private readonly traceContent = false,
  ) {
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true });
    // 启动阶段就验证路径可写；运行中的磁盘错误则降级停记，不能截断 TUI 事件。
    appendFileSync(this.file, "", { encoding: "utf8", mode: 0o600 });
    // mode 只影响新建文件；既有日志也必须收紧，尤其 trace-content 会含原文。
    chmodSync(this.file, 0o600);
  }

  log(kind: string, data: Record<string, unknown> = {}): void {
    if (this.failed) return;
    try {
      const record = safeValue({
        time: new Date().toISOString(),
        kind,
        ...data,
      });
      appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf8");
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
          close: () => {
            logger.log("host.close", { sessionId });
            handle.close();
          },
        };
      }),
    send: (sessionId, text) =>
      timed(logger, "send", { sessionId, ...logger.textField("text", text) }, () =>
        host.send(sessionId, text),
      ),
    interrupt: (sessionId) =>
      timed(logger, "interrupt", { sessionId }, () => host.interrupt(sessionId)),
    undo: (sessionId, checkpointId) =>
      timed(logger, "undo", { sessionId, ...(checkpointId ? { checkpointId } : {}) }, () =>
        host.undo(sessionId, checkpointId),
      ),
    answerPermission: (sessionId: string, permId: string, decision: PermissionDecisionKind) =>
      timed(logger, "answerPermission", { sessionId, permId, decision }, () =>
        host.answerPermission(sessionId, permId, decision),
      ),
    dispose: () => {
      try {
        logger.log("host.dispose");
      } finally {
        host.dispose();
      }
    },
  };
}
