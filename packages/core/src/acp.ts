/**
 * ACP v1 adapter：把稳定的 Agent Client Protocol 边界映射到 SessionHost。
 * 内部事件模型不泄漏给编辑器；未来 v2 只需替换本文件。
 */

import { createInterface } from "node:readline";
import * as path from "node:path";
import {
  PROTOCOL_VERSION,
  type InitializeResponse,
  type SessionModeState,
} from "@agentclientprotocol/sdk";
import { createId } from "./id.js";
import type { OpenHandle, SessionHost } from "./host.js";
import type { AgentEvent } from "./agent.js";
import type { ContentPart } from "./types.js";
import type { SessionEvent, SessionSnapshot, SessionSummary } from "./session-manager.js";
import type { PermissionMode } from "./permission.js";
import {
  noTelemetry,
  parseTraceparent,
  traceparent,
  type SpanContext,
  type Telemetry,
} from "./runtime/telemetry.js";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpPeer {
  notify(message: JsonRpcNotification): void | Promise<void>;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface AcpAdapterOptions {
  host: SessionHost;
  peer: AcpPeer;
  defaultModel: string;
  agentInfo?: { name: string; title?: string; version: string };
  deleteSession?: (sessionId: string) => Promise<void>;
  telemetry?: Telemetry;
}

export const ACP_V1_METHODS = [
  "initialize",
  "session/new",
  "session/load",
  "session/prompt",
  "session/cancel",
  "session/resume",
  "session/list",
  "session/close",
  "session/delete",
  "session/fork",
  "session/set_mode",
] as const;

/** ACP v1 JSON-RPC 边界的确定性校验；dispatch 前执行，返回标准 Invalid Params。 */
export function validateAcpV1Request(request: JsonRpcRequest | JsonRpcNotification): string[] {
  const errors: string[] = [];
  if (!request || request.jsonrpc !== "2.0") errors.push('jsonrpc must be "2.0"');
  if (typeof request.method !== "string" || !request.method)
    errors.push("method must be non-empty");
  if ("id" in request && typeof request.id !== "string" && typeof request.id !== "number")
    errors.push("id must be a string or number");
  const params = request.params;
  if (params !== undefined && (!params || typeof params !== "object" || Array.isArray(params)))
    errors.push("params must be an object");
  if (request.method === "initialize") {
    if (
      !Number.isInteger(params?.["protocolVersion"]) ||
      Number(params?.["protocolVersion"]) < 0 ||
      Number(params?.["protocolVersion"]) > 65_535
    )
      errors.push("protocolVersion must be integer");
  } else if (
    request.method.startsWith("session/") &&
    request.method !== "session/new" &&
    request.method !== "session/list"
  ) {
    if (typeof params?.["sessionId"] !== "string" || !params["sessionId"])
      errors.push("sessionId must be non-empty");
  }
  if (request.method === "session/new" || request.method === "session/load") {
    if (typeof params?.["cwd"] !== "string" || !path.isAbsolute(params["cwd"]))
      errors.push("cwd must be absolute");
    if (!Array.isArray(params?.["mcpServers"])) errors.push("mcpServers must be an array");
    else if ((params?.["mcpServers"] as unknown[]).length > 0)
      errors.push("dynamic MCP servers are not supported by this adapter");
    if (params?.["additionalDirectories"] !== undefined) {
      if (!Array.isArray(params["additionalDirectories"])) {
        errors.push("additionalDirectories must be an array");
      } else if ((params["additionalDirectories"] as unknown[]).length > 0) {
        errors.push("additionalDirectories are not supported by this adapter");
      }
    }
  }
  if (request.method === "session/list") {
    if (params?.["cwd"] !== undefined && params["cwd"] !== null) {
      if (typeof params["cwd"] !== "string" || !path.isAbsolute(params["cwd"]))
        errors.push("cwd must be absolute");
    }
    if (
      params?.["cursor"] !== undefined &&
      params["cursor"] !== null &&
      typeof params["cursor"] !== "string"
    )
      errors.push("cursor must be a string");
  }
  if (request.method === "session/set_mode" && typeof params?.["modeId"] !== "string") {
    errors.push("modeId must be non-empty");
  }
  if (request.method === "session/prompt") {
    try {
      textOfPrompt(params?.["prompt"]);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

function textOfPrompt(prompt: unknown): string {
  if (!Array.isArray(prompt)) throw new Error("prompt must be an array");
  const chunks: string[] = [];
  for (const block of prompt) {
    if (!block || typeof block !== "object") continue;
    const value = block as Record<string, unknown>;
    if (value["type"] === "text" && typeof value["text"] === "string") {
      chunks.push(value["text"]);
    } else if (value["type"] === "resource") {
      const resource = value["resource"] as Record<string, unknown> | undefined;
      if (resource && typeof resource["text"] === "string") {
        chunks.push(
          `<resource uri=${JSON.stringify(String(resource["uri"] ?? ""))}>\n${resource["text"]}\n</resource>`,
        );
      }
    } else if (value["type"] === "resource_link") {
      chunks.push(`[resource: ${String(value["uri"] ?? "")}]`);
    }
  }
  const text = chunks.join("\n\n").trim();
  if (!text) throw new Error("prompt contains no supported content");
  return text;
}

function contentBlock(part: ContentPart): Record<string, unknown> | undefined {
  if (part.type === "text") return { type: "text", text: part.text };
  if (part.type === "image") {
    return { type: "image", mimeType: part.mediaType, data: part.data };
  }
  return undefined;
}

const ACP_MODES = [
  { id: "default", name: "Default", description: "Ask before sensitive operations." },
  { id: "accept_edits", name: "Accept edits", description: "Apply workspace edits automatically." },
  { id: "auto", name: "Auto", description: "Run allowed tools without interactive confirmation." },
  { id: "plan", name: "Plan", description: "Read-only planning and analysis." },
] as const;

function permissionMode(id: string): PermissionMode {
  if (id === "accept_edits") return "acceptEdits";
  if (id === "default" || id === "auto" || id === "plan") return id;
  throw new AcpError(-32602, `unknown session mode: ${id}`);
}

function modeId(mode: PermissionMode): string {
  if (mode === "acceptEdits") return "accept_edits";
  // bypass is intentionally never advertised through the remote protocol.
  return mode === "bypass" ? "auto" : mode;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, offset }), "utf8").toString("base64url");
}

function decodeCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")) as {
      v?: number;
      offset?: number;
    };
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.offset) || parsed.offset! < 0)
      throw new Error();
    return parsed.offset!;
  } catch {
    throw new AcpError(-32602, "invalid session cursor");
  }
}

export class AcpAgentAdapter {
  private readonly host: SessionHost;
  private readonly peer: AcpPeer;
  private readonly defaultModel: string;
  private readonly agentInfo: NonNullable<AcpAdapterOptions["agentInfo"]>;
  private readonly deleteSession?: AcpAdapterOptions["deleteSession"];
  private readonly telemetry: Telemetry;
  private readonly handles = new Map<string, OpenHandle>();
  private readonly messageSequences = new Map<string, number>();
  private readonly currentModes = new Map<string, PermissionMode>();
  private readonly cancelledSessions = new Set<string>();
  private initialized = false;

  constructor(options: AcpAdapterOptions) {
    this.host = options.host;
    this.peer = options.peer;
    this.defaultModel = options.defaultModel;
    this.agentInfo = options.agentInfo ?? { name: "anicode", title: "AniCode", version: "0.1.0" };
    this.telemetry = options.telemetry ?? noTelemetry;
    if (options.deleteSession) this.deleteSession = options.deleteSession;
  }

  async handle(
    request: JsonRpcRequest | JsonRpcNotification,
  ): Promise<JsonRpcResponse | undefined> {
    const id = "id" in request ? request.id : undefined;
    const meta = request.params?.["_meta"];
    const parent =
      meta && typeof meta === "object"
        ? parseTraceparent(String((meta as Record<string, unknown>)["traceparent"] ?? ""))
        : undefined;
    const span = this.telemetry.startSpan(
      "anicode.acp.request",
      {
        "rpc.system": "jsonrpc",
        "rpc.method": request.method,
        "anicode.acp.protocol_version": Number(request.params?.["protocolVersion"] ?? 1),
      },
      parent,
    );
    try {
      const validation = validateAcpV1Request(request);
      if (validation.length) throw new AcpError(-32602, validation.join("; "));
      const result = await this.dispatch(request.method, request.params ?? {}, span.context());
      span.setStatus({ code: "ok" });
      return id === undefined ? undefined : { jsonrpc: "2.0", id, result };
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" });
      if (id === undefined) return undefined;
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: error instanceof AcpError ? error.code : -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      };
    } finally {
      span.end();
    }
  }

  private async dispatch(
    method: string,
    params: Record<string, unknown>,
    context?: SpanContext,
  ): Promise<unknown> {
    if (method === "initialize") {
      if (this.initialized) throw new AcpError(-32600, "connection is already initialized");
      const requested = Number(params["protocolVersion"] ?? 1);
      this.initialized = true;
      const response = {
        protocolVersion: requested === PROTOCOL_VERSION ? requested : PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: true },
          mcpCapabilities: { http: false, sse: false, acp: false },
          sessionCapabilities: {
            resume: {},
            close: {},
            list: {},
            ...(this.host.forkSession ? { fork: {} } : {}),
            ...(this.deleteSession ? { delete: {} } : {}),
          },
          auth: {},
        },
        agentInfo: this.agentInfo,
        authMethods: [],
      } satisfies InitializeResponse;
      return response;
    }
    if (!this.initialized) throw new AcpError(-32002, "connection is not initialized");

    if (method === "session/new") {
      const cwd = String(params["cwd"] ?? "");
      const created = await this.host.createSession({ cwd, model: this.defaultModel });
      await this.attach(created.id);
      this.currentModes.set(created.id, "default");
      return {
        sessionId: created.id,
        ...(this.host.setPermissionMode ? { modes: this.modeState(created.id) } : {}),
      };
    }
    if (method === "session/load") {
      const sessionId = String(params["sessionId"] ?? "");
      const handle = await this.attach(sessionId);
      await this.replay(sessionId, handle.snapshot);
      this.currentModes.set(sessionId, "default");
      return this.host.setPermissionMode ? { modes: this.modeState(sessionId) } : {};
    }
    if (method === "session/resume") {
      const sessionId = String(params["sessionId"] ?? "");
      await this.attach(sessionId);
      if (!this.currentModes.has(sessionId)) this.currentModes.set(sessionId, "default");
      return this.host.setPermissionMode ? { modes: this.modeState(sessionId) } : {};
    }
    if (method === "session/list") {
      let sessions = await this.host.listSessions();
      if (typeof params["cwd"] === "string") {
        const cwd = path.resolve(params["cwd"]);
        sessions = sessions.filter((session) => path.resolve(session.cwd) === cwd);
      }
      const offset = decodeCursor(params["cursor"]);
      const page = sessions.slice(offset, offset + 100);
      const next = offset + page.length;
      return {
        sessions: page.map(acpSessionInfo),
        ...(next < sessions.length ? { nextCursor: encodeCursor(next) } : {}),
      };
    }
    if (method === "session/delete") {
      if (!this.deleteSession) throw new AcpError(-32601, "session/delete is not supported");
      const sessionId = String(params["sessionId"] ?? "");
      this.handles.get(sessionId)?.close();
      this.handles.delete(sessionId);
      this.currentModes.delete(sessionId);
      await this.deleteSession(sessionId);
      return {};
    }
    if (method === "session/close") {
      const sessionId = String(params["sessionId"] ?? "");
      await this.host.interrupt(sessionId);
      this.handles.get(sessionId)?.close();
      this.handles.delete(sessionId);
      this.currentModes.delete(sessionId);
      return {};
    }
    if (method === "session/cancel") {
      const sessionId = String(params["sessionId"] ?? "");
      this.cancelledSessions.add(sessionId);
      await this.host.interrupt(sessionId);
      return undefined;
    }
    if (method === "session/set_mode") {
      if (!this.host.setPermissionMode) throw new AcpError(-32601, "session modes are unsupported");
      const sessionId = String(params["sessionId"] ?? "");
      const mode = permissionMode(String(params["modeId"] ?? ""));
      await this.host.setPermissionMode(sessionId, mode);
      this.currentModes.set(sessionId, mode);
      return {};
    }
    if (method === "session/fork") {
      if (!this.host.forkSession) throw new AcpError(-32601, "session/fork is not supported");
      const created = await this.host.forkSession(String(params["sessionId"] ?? ""));
      await this.attach(created.id);
      this.currentModes.set(created.id, "default");
      return {
        sessionId: created.id,
        ...(this.host.setPermissionMode ? { modes: this.modeState(created.id) } : {}),
      };
    }
    if (method === "session/prompt") {
      const sessionId = String(params["sessionId"] ?? "");
      await this.attach(sessionId);
      this.cancelledSessions.delete(sessionId);
      try {
        await this.host.send(sessionId, textOfPrompt(params["prompt"]), {
          ...(context ? { traceparent: traceparent(context) } : {}),
        });
      } catch (error) {
        if (!this.cancelledSessions.has(sessionId)) throw error;
      }
      const cancelled = this.cancelledSessions.delete(sessionId);
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    }
    throw new AcpError(-32601, `method not found: ${method}`);
  }

  private modeState(sessionId: string): SessionModeState {
    const current = this.currentModes.get(sessionId) ?? "default";
    return {
      currentModeId: modeId(current),
      availableModes: ACP_MODES.map((mode) => ({ ...mode })),
    };
  }

  private async attach(sessionId: string): Promise<OpenHandle> {
    const existing = this.handles.get(sessionId);
    if (existing) return existing;
    const handle = await this.host.open(sessionId, (event) => {
      void this.forward(sessionId, event);
    });
    this.handles.set(sessionId, handle);
    return handle;
  }

  private update(sessionId: string, update: Record<string, unknown>): void | Promise<void> {
    return this.peer.notify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId, update },
    });
  }

  private async forward(sessionId: string, event: SessionEvent): Promise<void> {
    if (event.type === "permission_request") {
      const networkApproval = event.toolName.toLowerCase() === "bash" && event.network === true;
      const result = (await this.peer.request("session/request_permission", {
        sessionId,
        toolCall: {
          toolCallId: event.permId,
          title: networkApproval ? `Network access: ${event.ruleKey}` : event.ruleKey,
          kind: "other",
        },
        options: [
          {
            optionId: "allow_once",
            name: networkApproval ? "Allow network once" : "Allow once",
            kind: "allow_once",
          },
          ...(!networkApproval
            ? [{ optionId: "allow_always", name: "Always allow", kind: "allow_always" as const }]
            : []),
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
        ],
      })) as { outcome?: { optionId?: string } };
      const option = result?.outcome?.optionId;
      await this.host.answerPermission(
        sessionId,
        event.permId,
        option === "allow_once"
          ? "allow"
          : !networkApproval && option === "allow_always"
            ? "allow_always"
            : "deny",
      );
      return;
    }
    if (event.type === "state") return;
    if (event.type !== "agent") return;
    await this.forwardAgent(sessionId, event.event);
  }

  private async forwardAgent(sessionId: string, event: AgentEvent): Promise<void> {
    if (event.type === "text") {
      await this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: `msg_${sessionId}_${this.messageSequences.get(sessionId) ?? 0}`,
        content: { type: "text", text: event.text },
      });
    } else if (event.type === "thinking") {
      await this.update(sessionId, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
      });
    } else if (event.type === "tool_start") {
      await this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: event.id,
        title: `${event.name}: ${event.ruleKey}`,
        kind: "other",
        status: "pending",
      });
    } else if (event.type === "tool_permission" && event.decision === "allow") {
      await this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.id,
        status: "in_progress",
      });
    } else if (event.type === "tool_result") {
      await this.update(sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId: event.id,
        status: event.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: event.content } }],
      });
    } else if (event.type === "verification") {
      const id = `verify_${event.report.id}`;
      await this.update(sessionId, {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: "Deterministic verification",
        kind: "other",
        status: event.report.status === "failed" ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: event.report.summary } }],
      });
    } else if (event.type === "turn_end") {
      const used = event.usage.inputTokens + event.usage.outputTokens;
      await this.update(sessionId, { sessionUpdate: "usage_update", used, size: used });
    } else if (event.type === "done") {
      this.messageSequences.set(sessionId, (this.messageSequences.get(sessionId) ?? 0) + 1);
    } else if (event.type === "error") {
      await this.update(sessionId, {
        sessionUpdate: "agent_message_chunk",
        messageId: `msg_${sessionId}_${this.messageSequences.get(sessionId) ?? 0}`,
        content: { type: "text", text: `\n[Agent error] ${event.message}` },
      });
    }
  }

  private async replay(sessionId: string, snapshot: SessionSnapshot): Promise<void> {
    let sequence = 0;
    for (const message of snapshot.messages) {
      const messageId = `msg_replay_${sequence++}`;
      for (const part of message.content) {
        const content = contentBlock(part);
        if (!content) continue;
        await this.update(sessionId, {
          sessionUpdate: message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
          messageId,
          content,
        });
      }
    }
  }

  close(): void {
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
  }
}

function acpSessionInfo(session: SessionSummary): Record<string, unknown> {
  return {
    sessionId: session.id,
    cwd: session.cwd,
    title: session.title ?? session.id,
    updatedAt: session.updatedAt,
    _meta: { model: session.model, running: session.running },
  };
}

class AcpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AcpStdioOptions extends Omit<AcpAdapterOptions, "peer"> {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/** ACP stdio 传输：每行一条 JSON-RPC 消息，支持 agent→client 双向请求。 */
export function serveAcpStdio(options: AcpStdioOptions): { close(): void } {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const write = (message: unknown) => output.write(JSON.stringify(message) + "\n");
  const adapter = new AcpAgentAdapter({
    ...options,
    peer: {
      notify(message) {
        write(message);
      },
      request(method, params) {
        const id = createId("evt");
        write({ jsonrpc: "2.0", id, method, params });
        return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      },
    },
  });
  const lines = createInterface({ input });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    void (async () => {
      let message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;
      try {
        message = JSON.parse(line) as typeof message;
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      if ("id" in message && !("method" in message)) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message));
        else waiter.resolve(message.result);
        return;
      }
      const response = await adapter.handle(message as JsonRpcRequest | JsonRpcNotification);
      if (response) write(response);
    })();
  });
  return {
    close() {
      lines.close();
      adapter.close();
      for (const waiter of pending.values()) waiter.reject(new Error("ACP connection closed"));
      pending.clear();
    },
  };
}
