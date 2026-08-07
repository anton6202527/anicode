import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AcpAgentAdapter,
  ACP_V1_METHODS,
  validateAcpV1Request,
  type JsonRpcNotification,
} from "./acp.js";
import type { SessionHost, OpenHandle, PermissionDecisionKind } from "./host.js";
import type { SessionEvent, SessionSnapshot, SessionSummary } from "./session-manager.js";
import { InMemoryTelemetry, parseTraceparent } from "./runtime/telemetry.js";

class FakeHost implements SessionHost {
  private listeners = new Map<string, (event: SessionEvent) => void>();
  readonly permissions: { sessionId: string; permId: string; decision: PermissionDecisionKind }[] =
    [];
  readonly sent: Array<{
    sessionId: string;
    text: string;
    opts?: { model?: string; idempotencyKey?: string; traceparent?: string };
  }> = [];
  private summary: SessionSummary = {
    id: "s_acp",
    cwd: "/tmp/project",
    model: "debug/demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    running: false,
  };

  constructor(private readonly networkPermission = false) {}

  listSessions(): Promise<SessionSummary[]> {
    return Promise.resolve([this.summary]);
  }
  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    this.summary = { ...this.summary, cwd: input.cwd, model: input.model };
    return Promise.resolve(this.summary);
  }
  open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle> {
    this.listeners.set(sessionId, listener);
    const snapshot: SessionSnapshot = {
      meta: this.summary,
      messages: [
        { role: "user", content: [{ type: "text", text: "历史问题" }] },
        { role: "assistant", content: [{ type: "text", text: "历史回答" }] },
      ],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      running: false,
      pendingPermissions: [],
    };
    return Promise.resolve({ snapshot, close: () => this.listeners.delete(sessionId) });
  }
  async send(
    sessionId: string,
    text: string,
    opts?: { model?: string; idempotencyKey?: string; traceparent?: string },
  ): Promise<void> {
    this.sent.push({ sessionId, text, ...(opts ? { opts } : {}) });
    const listener = this.listeners.get(sessionId)!;
    listener({ type: "state", running: true });
    listener({ type: "agent", event: { type: "text", text: "ACP answer" } });
    listener({
      type: "agent",
      event: {
        type: "tool_start",
        id: "call_1",
        name: this.networkPermission ? "bash" : "read",
        ruleKey: this.networkPermission ? "curl https://example.com" : "a.ts",
      },
    });
    listener({
      type: "permission_request",
      permId: "call_1",
      toolName: this.networkPermission ? "bash" : "read",
      ruleKey: this.networkPermission ? "curl https://example.com" : "a.ts",
      ...(this.networkPermission ? { network: true, risk: "high" as const } : {}),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    listener({
      type: "agent",
      event: { type: "tool_result", id: "call_1", name: "read", content: "ok", isError: false },
    });
    listener({ type: "state", running: false });
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionDecisionKind,
  ): Promise<boolean> {
    this.permissions.push({ sessionId, permId, decision });
    return Promise.resolve(true);
  }
  undo(): Promise<{ restored: number; deleted: number }> {
    return Promise.resolve({ restored: 0, deleted: 0 });
  }
  dispose(): void {}
}

test("ACP v1: initialize/new/prompt/update/permission 映射到 SessionHost", async () => {
  const host = new FakeHost();
  const telemetry = new InMemoryTelemetry();
  const notifications: JsonRpcNotification[] = [];
  const adapter = new AcpAgentAdapter({
    host,
    defaultModel: "debug/demo",
    peer: {
      notify(message) {
        notifications.push(message);
      },
      async request(method) {
        assert.equal(method, "session/request_permission");
        return { outcome: { optionId: "allow_once" } };
      },
    },
    telemetry,
  });

  const init = await adapter.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  assert.equal((init?.result as { protocolVersion: number }).protocolVersion, 1);

  const created = await adapter.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/tmp/project", mcpServers: [] },
  });
  assert.equal((created?.result as { sessionId: string }).sessionId, "s_acp");

  const prompted = await adapter.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: {
      sessionId: "s_acp",
      prompt: [{ type: "text", text: "hello" }],
      _meta: { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` },
    },
  });
  assert.equal((prompted?.result as { stopReason: string }).stopReason, "end_turn");
  await new Promise((resolve) => setTimeout(resolve, 0));
  const updates = notifications.map(
    (message) => (message.params?.["update"] as Record<string, unknown>)["sessionUpdate"],
  );
  assert.ok(updates.includes("agent_message_chunk"));
  assert.ok(updates.includes("tool_call"));
  assert.ok(updates.includes("tool_call_update"));
  assert.equal(host.permissions[0]?.decision, "allow");
  const promptSpan = telemetry.spans.find(
    (span) =>
      span.name === "anicode.acp.request" && span.attributes["rpc.method"] === "session/prompt",
  )!;
  const forwarded = parseTraceparent(host.sent[0]?.opts?.traceparent);
  assert.equal(promptSpan.traceId, "a".repeat(32));
  assert.equal(promptSpan.parentSpanId, "b".repeat(16));
  assert.equal(forwarded?.traceId, promptSpan.traceId);
  assert.equal(forwarded?.spanId, promptSpan.spanId);

  const listed = await adapter.handle({ jsonrpc: "2.0", id: 3, method: "session/list" });
  assert.equal((listed?.result as { sessions: unknown[] }).sessions.length, 1);
  adapter.close();
});

test("ACP v1: shell 联网授权只提供一次性选项并拒绝伪造的 allow_always", async () => {
  const host = new FakeHost(true);
  let permissionRequest: Record<string, unknown> | undefined;
  const adapter = new AcpAgentAdapter({
    host,
    defaultModel: "debug/demo",
    peer: {
      notify: () => {},
      request: async (_method, params) => {
        permissionRequest = params;
        return { outcome: { optionId: "allow_always" } };
      },
    },
  });
  await adapter.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  await adapter.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "session/new",
    params: { cwd: "/tmp/project", mcpServers: [] },
  });
  await adapter.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: { sessionId: "s_acp", prompt: [{ type: "text", text: "network" }] },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const options = permissionRequest?.["options"] as Array<{ optionId: string }>;
  assert.deepEqual(
    options.map((option) => option.optionId),
    ["allow_once", "reject_once"],
  );
  assert.match(
    String((permissionRequest?.["toolCall"] as Record<string, unknown>)?.["title"]),
    /Network access/,
  );
  assert.equal(host.permissions[0]?.decision, "deny");
  adapter.close();
});

test("ACP v1: session/load 重放 user/assistant 历史", async () => {
  const notifications: JsonRpcNotification[] = [];
  const adapter = new AcpAgentAdapter({
    host: new FakeHost(),
    defaultModel: "debug/demo",
    peer: {
      notify: (message) => {
        notifications.push(message);
      },
      request: async () => ({ outcome: { optionId: "reject_once" } }),
    },
  });
  await adapter.handle({
    jsonrpc: "2.0",
    id: 0,
    method: "initialize",
    params: { protocolVersion: 1 },
  });
  await adapter.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "session/load",
    params: { sessionId: "s_acp", cwd: "/tmp/project", mcpServers: [] },
  });
  const kinds = notifications.map(
    (message) => (message.params?.["update"] as Record<string, unknown>)["sessionUpdate"],
  );
  assert.deepEqual(kinds, ["user_message_chunk", "agent_message_chunk"]);
  adapter.close();
});

test("ACP v1 conformance: 初始化门、参数校验、核心方法目录", async () => {
  assert.ok(ACP_V1_METHODS.includes("session/prompt"));
  assert.deepEqual(
    validateAcpV1Request({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "/tmp/project", mcpServers: [] },
    }),
    [],
  );
  assert.match(
    validateAcpV1Request({
      jsonrpc: "2.0",
      id: 1,
      method: "session/new",
      params: { cwd: "relative", mcpServers: "bad" },
    }).join(";"),
    /cwd must be absolute.*mcpServers must be an array/,
  );
  const adapter = new AcpAgentAdapter({
    host: new FakeHost(),
    defaultModel: "debug/demo",
    peer: { notify() {}, request: async () => ({}) },
  });
  const beforeInit = await adapter.handle({
    jsonrpc: "2.0",
    id: 1,
    method: "session/list",
  });
  assert.equal(beforeInit?.error?.code, -32002);
  const badPrompt = await adapter.handle({
    jsonrpc: "2.0",
    id: 2,
    method: "session/prompt",
    params: { sessionId: "s_acp", prompt: [] },
  });
  assert.equal(badPrompt?.error?.code, -32602);
});
