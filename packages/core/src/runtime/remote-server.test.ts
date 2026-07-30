import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionRuntime } from "./isolated-runtime.js";
import { createClaimRemoteRuntimeAuthorizer, RemoteRuntimeHttpServer } from "./remote-server.js";
import { InMemoryTelemetry } from "./telemetry.js";
import { DurableWorkerQueue } from "./worker.js";

test("Remote Runtime server: OIDC boundary、durable queue、ephemeral execution 与 trace parent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-server-"));
  await fs.mkdir(path.join(root, "project"));
  const telemetry = new InMemoryTelemetry();
  let runtimeTraceId: string | undefined;
  let runtimeParentSpanId: string | undefined;
  const runtime: ExecutionRuntime = {
    async run(request) {
      runtimeTraceId = request.traceContext?.traceId;
      runtimeParentSpanId = request.traceContext?.spanId;
      return {
        exitCode: 0,
        output: `${path.basename(request.cwd)}:ok`,
        timedOut: false,
        sandboxed: true,
        durationMs: 1,
      };
    },
  };
  const server = new RemoteRuntimeHttpServer({
    queue: new DurableWorkerQueue(),
    executionRuntime: runtime,
    workspaceRoot: root,
    authenticate: async (request) => {
      if (request.headers.authorization !== "Bearer oidc") throw new Error("authentication failed");
      return { actor: "user-1", claims: { tenant_id: "tenant-1" } };
    },
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return {
          tenantId: "tenant-1",
          workspaceId: request.workspaceId,
          policy: request.policy,
          network: request.network,
          ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
        };
      },
      async authorizeJob(identity, _action, job) {
        if (job.payload.actor !== identity.actor) throw new Error("authorization denied");
      },
    },
    readiness: async () => ({ queue: true, runtime: true }),
    telemetry,
  });
  try {
    const endpoint = await server.listen();
    assert.equal((await fetch(`${endpoint}/healthz`)).status, 200);
    assert.equal((await fetch(`${endpoint}/readyz`)).status, 200);
    assert.equal(
      (await fetch(`${endpoint}/v1/executions`, { method: "POST", body: "{}" })).status,
      401,
    );
    const parent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    const submitted = await fetch(`${endpoint}/v1/executions`, {
      method: "POST",
      headers: { authorization: "Bearer oidc", "content-type": "application/json" },
      body: JSON.stringify({
        command: "true",
        workspaceId: "project",
        cwd: ".",
        policy: "read-only",
        network: false,
        idempotencyKey: "same-run",
        traceparent: parent,
      }),
    });
    assert.equal(submitted.status, 202);
    const view = (await submitted.json()) as { id: string };
    assert.equal(await server.service.runOnce(), true);
    const completed = await fetch(`${endpoint}/v1/executions/${view.id}`, {
      headers: { authorization: "Bearer oidc" },
    });
    const result = (await completed.json()) as { status: string; result: { output: string } };
    assert.equal(result.status, "succeeded");
    assert.equal(result.result.output, "project:ok");
    const span = telemetry.spans.find((item) => item.name === "anicode.remote.execution");
    assert.equal(span?.traceId, "a".repeat(32));
    assert.equal(span?.parentSpanId, "b".repeat(16));
    assert.equal(runtimeTraceId, span?.traceId);
    assert.equal(runtimeParentSpanId, span?.spanId);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime server: OIDC claims enforce tenant、workspace 与 capability boundaries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-authz-"));
  await fs.mkdir(path.join(root, "project"));
  const runtime: ExecutionRuntime = {
    async run() {
      return { exitCode: 0, output: "ok", timedOut: false, sandboxed: true, durationMs: 1 };
    },
  };
  const identities = {
    owner: {
      actor: "user-1",
      claims: {
        tenant_id: "tenant-1",
        anicode_workspaces: ["project"],
        anicode_permissions: ["workspace:write"],
      },
    },
    stranger: {
      actor: "user-2",
      claims: {
        tenant_id: "tenant-2",
        anicode_workspaces: ["project"],
        anicode_permissions: ["workspace:write", "network:egress"],
      },
    },
  } as const;
  const server = new RemoteRuntimeHttpServer({
    queue: new DurableWorkerQueue(),
    executionRuntime: runtime,
    workspaceRoot: root,
    authenticate: async (request) => {
      const token = request.headers.authorization?.replace(
        "Bearer ",
        "",
      ) as keyof typeof identities;
      const identity = identities[token];
      if (!identity) throw new Error("authentication failed");
      return identity;
    },
    authorizer: createClaimRemoteRuntimeAuthorizer({ maxTimeoutMs: 5_000 }),
    readiness: async () => ({ postgres: true, runtime: true }),
  });
  try {
    const endpoint = await server.listen();
    const submit = (token: keyof typeof identities, overrides: Record<string, unknown> = {}) =>
      fetch(`${endpoint}/v1/executions`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          command: "true",
          workspaceId: "project",
          policy: "workspace-write",
          network: false,
          idempotencyKey: "authz-test",
          ...overrides,
        }),
      });
    const accepted = await submit("owner");
    assert.equal(accepted.status, 202);
    const view = (await accepted.json()) as { id: string };

    const networkDenied = await submit("owner", { network: true });
    assert.equal(networkDenied.status, 403);
    assert.equal(
      ((await networkDenied.json()) as { error: { code: string } }).error.code,
      "network_denied",
    );
    assert.equal(
      (
        await fetch(`${endpoint}/v1/executions/${view.id}`, {
          headers: { authorization: "Bearer stranger" },
        })
      ).status,
      404,
    );

    server.beginDrain();
    assert.equal((await fetch(`${endpoint}/readyz`)).status, 503);
    assert.equal((await submit("owner", { idempotencyKey: "during-drain" })).status, 503);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
