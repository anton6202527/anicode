import { PassThrough, Readable, Writable } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { serveAcpStdio } from "./acp.js";
import type { OpenHandle, PermissionDecisionKind, SessionHost } from "./host.js";
import type { PermissionMode } from "./permission.js";
import type { SessionEvent, SessionSnapshot, SessionSummary } from "./session-manager.js";

class OfficialConformanceHost implements SessionHost {
  readonly summary: SessionSummary = {
    id: "s_official",
    cwd: "/tmp/project",
    model: "debug/demo",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    running: false,
  };
  listener: ((event: SessionEvent) => void) | undefined;
  mode: PermissionMode = "default";

  listSessions(): Promise<SessionSummary[]> {
    return Promise.resolve([this.summary]);
  }
  createSession(): Promise<SessionSummary> {
    return Promise.resolve(this.summary);
  }
  open(_sessionId: string, listener: (event: SessionEvent) => void): Promise<OpenHandle> {
    this.listener = listener;
    const snapshot: SessionSnapshot = {
      meta: this.summary,
      messages: [],
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      running: false,
      pendingPermissions: [],
    };
    return Promise.resolve({ snapshot, close: () => (this.listener = undefined) });
  }
  async send(): Promise<void> {
    this.listener?.({ type: "agent", event: { type: "text", text: "official client answer" } });
    this.listener?.({
      type: "agent",
      event: { type: "tool_start", id: "tool_1", name: "read", ruleKey: "a.ts" },
    });
    this.listener?.({
      type: "permission_request",
      permId: "tool_1",
      toolName: "read",
      ruleKey: "a.ts",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.listener?.({
      type: "agent",
      event: { type: "tool_result", id: "tool_1", name: "read", content: "ok", isError: false },
    });
  }
  interrupt(): Promise<void> {
    return Promise.resolve();
  }
  answerPermission(
    _sessionId: string,
    _permId: string,
    _decision: PermissionDecisionKind,
  ): Promise<boolean> {
    return Promise.resolve(true);
  }
  undo(): Promise<{ restored: number; deleted: number }> {
    return Promise.resolve({ restored: 0, deleted: 0 });
  }
  setPermissionMode(_sessionId: string, mode: PermissionMode): Promise<void> {
    this.mode = mode;
    return Promise.resolve();
  }
  dispose(): void {}
}

test("ACP v1 official SDK: wire schema、capability、mode、prompt 与 update conformance", async () => {
  const host = new OfficialConformanceHost();
  const clientToAgent = new PassThrough();
  const agentToClient = new PassThrough();
  const server = serveAcpStdio({
    host,
    defaultModel: "debug/demo",
    input: clientToAgent,
    output: agentToClient,
  });
  const updates: SessionUpdate[] = [];
  const app = client({ name: "anicode-conformance" })
    .onRequest(methods.client.session.requestPermission, ({ params }) => ({
      outcome: {
        outcome: "selected" as const,
        optionId: params.options[0]!.optionId,
      },
    }))
    .onNotification(methods.client.session.update, ({ params }) => {
      updates.push(params.update);
    });
  const stream = ndJsonStream(
    Writable.toWeb(clientToAgent) as WritableStream<Uint8Array>,
    Readable.toWeb(agentToClient) as ReadableStream<Uint8Array>,
  );
  try {
    await app.connectWith(stream, async (agent) => {
      const initialized = await agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "anicode-conformance", version: "1.0.0" },
      });
      assert.equal(initialized.protocolVersion, PROTOCOL_VERSION);
      assert.equal(initialized.agentCapabilities?.sessionCapabilities?.list !== undefined, true);
      const created = await agent.request(methods.agent.session.new, {
        cwd: "/tmp/project",
        mcpServers: [],
      });
      assert.equal(created.sessionId, "s_official");
      assert.equal(created.modes?.currentModeId, "default");
      await agent.request(methods.agent.session.setMode, {
        sessionId: created.sessionId,
        modeId: "plan",
      });
      assert.equal(host.mode, "plan");
      const response = await agent.request(methods.agent.session.prompt, {
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.equal(response.stopReason, "end_turn");
      const listed = await agent.request(methods.agent.session.list, {});
      assert.equal(listed.sessions[0]?.sessionId, created.sessionId);
    });
    assert.ok(updates.some((update) => update.sessionUpdate === "agent_message_chunk"));
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call"));
    assert.ok(updates.some((update) => update.sessionUpdate === "tool_call_update"));
  } finally {
    server.close();
    clientToAgent.destroy();
    agentToClient.destroy();
  }
});
