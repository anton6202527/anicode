import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeTerminationError, type ExecutionRuntime } from "./isolated-runtime.js";
import {
  createClaimRemoteRuntimeAuthorizer,
  RemoteRuntimeHttpServer,
  safeWorkspace,
  type RemoteRuntimeAuthorizer,
} from "./remote-server.js";
import { InMemoryTelemetry } from "./telemetry.js";
import {
  DurableWorkerQueue,
  WorkerQueueQuotaError,
  type WorkerJob,
  type WorkerQueueStore,
} from "./worker.js";

function testGrant(
  request: {
    workspaceId: string;
    policy: "read-only" | "workspace-write";
    network: boolean;
    timeoutMs?: number;
  },
  tenantId = "tenant-1",
) {
  const authorizedAt = new Date().toISOString();
  return {
    tenantId,
    workspaceId: request.workspaceId,
    policy: request.policy,
    network: request.network,
    ...(request.timeoutMs ? { timeoutMs: request.timeoutMs } : {}),
    authorizedAt,
    grantExpiresAt: new Date(Date.parse(authorizedAt) + 60_000).toISOString(),
  };
}

test("Remote Runtime: workspace and cwd symlinks cannot cross the tenant boundary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-path-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-outside-"));
  try {
    await fs.mkdir(path.join(root, "project", "src"), { recursive: true });
    assert.equal(
      safeWorkspace(root, "project", "src"),
      await fs.realpath(path.join(root, "project", "src")),
    );
    await fs.symlink(outside, path.join(root, "project", "escape"));
    assert.throws(() => safeWorkspace(root, "project", "escape"), /symlink|escapes/);
    await fs.symlink(outside, path.join(root, "linked-project"));
    assert.throws(() => safeWorkspace(root, "linked-project"), /symlink/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("Remote Runtime: idempotency uses a canonical tuple and re-authorizes duplicates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-idempotency-"));
  await fs.mkdir(path.join(root, "project"));
  const queue = new DurableWorkerQueue();
  let jobAuthorizations = 0;
  let submitAuthorized: boolean;
  const server = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime: {
      async run() {
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 0 };
      },
    },
    workspaceRoot: root,
    authenticate: async () => ({ actor: "unused" }),
    authorizer: {
      async authorizeSubmit(identity, request) {
        submitAuthorized = true;
        if (request.workspaceId === "missing") throw new Error("denied before filesystem lookup");
        return testGrant(request, "tenant");
      },
      async authorizeJob(identity, _action, job) {
        jobAuthorizations++;
        if (job.payload.actor !== identity.actor) throw new Error("job owner mismatch");
      },
      async authorizeExecution() {},
    },
  });
  const request = {
    command: "true",
    workspaceId: "project",
    policy: "read-only" as const,
    network: false,
  };
  try {
    // These tuples collided under `tenant:actor:idempotencyKey` string concatenation.
    const first = await server.service.submit(
      { actor: "alice:ops" },
      { ...request, idempotencyKey: "same" },
    );
    const second = await server.service.submit(
      { actor: "alice" },
      { ...request, idempotencyKey: "ops:same" },
    );
    assert.notEqual(first.id, second.id);
    const duplicate = await server.service.submit(
      { actor: "alice:ops" },
      { ...request, idempotencyKey: "same" },
    );
    assert.equal(duplicate.id, first.id);
    assert.equal(jobAuthorizations, 3, "new and duplicate jobs must all pass concrete-job authz");
    assert.equal((await queue.list()).filter((job) => job.type === "remote-execution").length, 2);
    await assert.rejects(
      () =>
        server.service.submit(
          { actor: "alice:ops" },
          { ...request, command: "different", idempotencyKey: "same" },
        ),
      /Idempotency key was already used/,
    );

    submitAuthorized = false;
    await assert.rejects(
      () =>
        server.service.submit(
          { actor: "alice" },
          { ...request, workspaceId: "missing", idempotencyKey: "hidden-workspace" },
        ),
      /denied before filesystem lookup/,
    );
    assert.equal(submitAuthorized, true);
    await assert.rejects(
      () => server.service.submit({ actor: "" }, { ...request, idempotencyKey: "invalid-actor" }),
      /Invalid remote actor/,
    );
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime: cancelling an active job aborts side effects without late settle errors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-cancel-"));
  await fs.mkdir(path.join(root, "project"));
  const queue = new DurableWorkerQueue();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  let observedAbort = false;
  const runtime: ExecutionRuntime = {
    async run(request) {
      started();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      observedAbort = Boolean(request.signal?.aborted);
      return { exitCode: 0, output: "late", timedOut: false, sandboxed: true, durationMs: 1 };
    },
  };
  const identity = { actor: "user-1", claims: { tenant_id: "tenant-1" } };
  const server = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime: runtime,
    workspaceRoot: root,
    authenticate: async () => identity,
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request);
      },
      async authorizeJob() {},
      async authorizeExecution() {},
    },
  });
  try {
    const job = await server.service.submit(identity, {
      command: "side-effect",
      workspaceId: "project",
      policy: "read-only",
      network: false,
      idempotencyKey: "cancel-active",
    });
    const running = server.service.runOnce();
    await didStart;
    assert.equal(await server.service.cancel(identity, job.id), "cancellation_requested");
    assert.equal(await running, true, "cancelled work must not throw from late finish/fail paths");
    assert.equal(observedAbort, true);
    assert.equal((await queue.get(job.id))?.status, "cancelled");
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime: cancellation is never acknowledged when termination cannot be proved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-cancel-unknown-"));
  await fs.mkdir(path.join(root, "project"));
  const queue = new DurableWorkerQueue();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  const identity = { actor: "user-1", claims: { tenant_id: "tenant-1" } };
  const server = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime: {
      async run(request) {
        started();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new RuntimeTerminationError();
      },
    },
    workspaceRoot: root,
    authenticate: async () => identity,
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request);
      },
      async authorizeJob() {},
      async authorizeExecution() {},
    },
  });
  try {
    const job = await server.service.submit(identity, {
      command: "side-effect",
      workspaceId: "project",
      policy: "read-only",
      network: false,
      idempotencyKey: "cancel-indeterminate",
    });
    const running = server.service.runOnce();
    await didStart;
    assert.equal(await server.service.cancel(identity, job.id), "cancellation_requested");
    assert.equal(await running, true);
    assert.equal(
      (await queue.get(job.id))?.status,
      "cancellation_requested",
      "unknown termination must remain durable and consume capacity until reconciled",
    );
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime: non-cancellation termination proof failures are indeterminate and never retried", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-proof-failure-"));
  await fs.mkdir(path.join(root, "project"));
  const queue = new DurableWorkerQueue();
  let calls = 0;
  const identity = { actor: "user-1", claims: { tenant_id: "tenant-1" } };
  const server = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime: {
      async run() {
        calls++;
        throw new RuntimeTerminationError();
      },
    },
    workspaceRoot: root,
    authenticate: async () => identity,
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request);
      },
      async authorizeJob() {},
      async authorizeExecution() {},
    },
  });
  try {
    const job = await server.service.submit(identity, {
      command: "read-only-but-possibly-still-running",
      workspaceId: "project",
      policy: "read-only",
      network: false,
      retryPolicy: "safe",
      idempotencyKey: "proof-failure-no-retry",
    });
    assert.equal(await server.service.runOnce(), true);
    assert.equal(await server.service.runOnce(), false);
    assert.equal(calls, 1);
    const view = await server.service.get(identity, job.id);
    assert.equal(view?.status, "failed");
    assert.equal(view?.outcome, "indeterminate");
    assert.match(view?.error ?? "", /termination indeterminate.*cleanup proof required/i);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime: cross-process cancellation stays non-terminal until the lease owner acknowledges", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-cross-cancel-"));
  await fs.mkdir(path.join(root, "project"));
  const queue = new DurableWorkerQueue();
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  let observedAbort!: () => void;
  const didObserveAbort = new Promise<void>((resolve) => (observedAbort = resolve));
  let release!: () => void;
  const mayReturn = new Promise<void>((resolve) => (release = resolve));
  const identity = { actor: "user-1" };
  const authorizer: RemoteRuntimeAuthorizer = {
    async authorizeSubmit(_identity, request) {
      return testGrant(request);
    },
    async authorizeJob() {},
    async authorizeExecution() {},
  };
  const submitter = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime: {
      async run() {
        throw new Error("submitter must not execute the job");
      },
    },
    workspaceRoot: root,
    authenticate: async () => identity,
    authorizer,
    workerId: "submitter",
    authorizationPollMs: 100,
    quotas: { maxOutstandingPerTenant: 1 },
  });
  const worker = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime: {
      async run(request) {
        started();
        await new Promise<void>((resolve) =>
          request.signal?.addEventListener(
            "abort",
            () => {
              observedAbort();
              resolve();
            },
            { once: true },
          ),
        );
        await mayReturn;
        return { exitCode: 0, output: "late", timedOut: false, sandboxed: true, durationMs: 1 };
      },
    },
    workspaceRoot: root,
    authenticate: async () => identity,
    authorizer,
    workerId: "worker-b",
    authorizationPollMs: 100,
  });
  try {
    const job = await submitter.service.submit(identity, {
      command: "side-effect",
      workspaceId: "project",
      policy: "read-only",
      network: false,
      idempotencyKey: "cross-process-cancel",
    });
    const running = worker.service.runOnce();
    await didStart;
    assert.equal(await submitter.service.cancel(identity, job.id), "cancellation_requested");
    await didObserveAbort;
    assert.equal(
      (await queue.get(job.id))?.status,
      "cancellation_requested",
      "the API must not claim terminal cancellation while the worker is still unwinding",
    );
    await assert.rejects(
      () =>
        submitter.service.submit(identity, {
          command: "must-wait-for-cancellation-ack",
          workspaceId: "project",
          policy: "read-only",
          network: false,
          idempotencyKey: "blocked-behind-cancellation",
        }),
      /Tenant execution quota exceeded/,
      "cancellation_requested still consumes outstanding tenant capacity",
    );
    release();
    await running;
    assert.equal((await queue.get(job.id))?.status, "cancelled");
  } finally {
    await Promise.all([submitter.close(), worker.close()]);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime: an expired or revoked durable grant fails closed before execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-expired-grant-"));
  await fs.mkdir(path.join(root, "project"));
  const queue = new DurableWorkerQueue();
  let runtimeCalls = 0;
  let permitted = true;
  const identity = { actor: "user-1" };
  const server = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime: {
      async run() {
        runtimeCalls++;
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 0 };
      },
    },
    workspaceRoot: root,
    authenticate: async () => identity,
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request);
      },
      async authorizeJob() {},
      async authorizeExecution() {
        if (!permitted) throw new Error("grant revoked");
      },
    },
  });
  try {
    const expiredJob = await server.service.submit(identity, {
      command: "expired-must-not-run",
      workspaceId: "project",
      policy: "read-only",
      network: false,
      idempotencyKey: "expired-before-claim",
    });
    await queue.store.transact((jobs) => {
      const persisted = jobs.find((candidate) => candidate.id === expiredJob.id)!;
      const payload = persisted.payload as { authorizedAt: string; grantExpiresAt: string };
      payload.authorizedAt = new Date(Date.now() - 60_000).toISOString();
      payload.grantExpiresAt = new Date(Date.now() - 1_000).toISOString();
    });
    assert.equal(await server.service.runOnce(), true);
    assert.equal((await queue.get(expiredJob.id))?.status, "failed");
    assert.match((await queue.get(expiredJob.id))?.error ?? "", /grant has expired/i);

    const revokedJob = await server.service.submit(identity, {
      command: "must-not-run",
      workspaceId: "project",
      policy: "read-only",
      network: false,
      idempotencyKey: "revoked-before-claim",
    });
    permitted = false;
    assert.equal(await server.service.runOnce(), true);
    const failed = await queue.get(revokedJob.id);
    assert.equal(failed?.status, "failed");
    assert.match(failed?.error ?? "", /authorization was denied/i);
    assert.equal(runtimeCalls, 0);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
        return testGrant(request);
      },
      async authorizeJob(identity, _action, job) {
        if (job.payload.actor !== identity.actor) throw new Error("authorization denied");
      },
      async authorizeExecution() {},
    },
    readiness: async () => ({ queue: true, runtime: true }),
    telemetry,
  });
  try {
    const endpoint = await server.listen();
    assert.equal((await fetch(`${endpoint}/healthz`)).status, 200);
    const ready = await fetch(`${endpoint}/readyz`);
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ready: true, accepting: true });
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

test("Remote Runtime server: side effects default to no retry; quotas and retry-safe contract fail closed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-retry-"));
  await fs.mkdir(path.join(root, "project"));
  let calls = 0;
  let executionId: string | undefined;
  const runtime: ExecutionRuntime = {
    async run(request) {
      calls++;
      executionId = request.env?.["ANICODE_EXECUTION_ID"];
      throw new Error("runtime crashed after an unknown execution boundary");
    },
  };
  const server = new RemoteRuntimeHttpServer({
    queue: new DurableWorkerQueue(),
    executionRuntime: runtime,
    workspaceRoot: root,
    authenticate: async () => ({ actor: "user-1", claims: { tenant_id: "tenant-1" } }),
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request);
      },
      async authorizeJob() {},
      async authorizeExecution() {},
    },
    quotas: { maxQueuedPerActor: 1, maxOutstandingPerTenant: 2 },
  });
  try {
    const endpoint = await server.listen();
    const submit = (idempotencyKey: string, extra: Record<string, unknown> = {}) =>
      fetch(`${endpoint}/v1/executions`, {
        method: "POST",
        headers: { authorization: "Bearer ignored", "content-type": "application/json" },
        body: JSON.stringify({
          command: "dangerous-command",
          workspaceId: "project",
          policy: "read-only",
          network: false,
          idempotencyKey,
          ...extra,
        }),
      });

    const accepted = await submit("no-replay");
    assert.equal(accepted.status, 202);
    const first = (await accepted.json()) as { id: string };
    const duplicate = await submit("no-replay");
    assert.equal(((await duplicate.json()) as { id: string }).id, first.id);
    const quota = await submit("queued-behind-first");
    assert.equal(quota.status, 429);
    assert.equal(
      ((await quota.json()) as { error: { code: string } }).error.code,
      "actor_queue_full",
    );

    assert.equal(await server.service.runOnce(), true);
    assert.equal(await server.service.runOnce(), false);
    assert.equal(calls, 1, "default never policy must not replay an unknown side effect");
    assert.ok(executionId?.startsWith("job_"));
    const failed = (await (
      await fetch(`${endpoint}/v1/executions/${first.id}`, {
        headers: { authorization: "Bearer ignored" },
      })
    ).json()) as { status: string };
    assert.equal(failed.status, "failed");

    const unsafe = await submit("unsafe-retry", { retryPolicy: "safe", network: true });
    assert.equal(unsafe.status, 400);
    assert.equal(
      ((await unsafe.json()) as { error: { code: string } }).error.code,
      "unsafe_retry_policy",
    );
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime: shared stores enforce quota atomically without a process-local list scan", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-atomic-quota-"));
  await fs.mkdir(path.join(root, "project"));
  let listCalled = false;
  const store: WorkerQueueStore = {
    async transact<T>(_fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T> {
      throw new Error("legacy transaction path must not run");
    },
    async enqueueJobWithQuota() {
      throw new WorkerQueueQuotaError("tenant_quota_exceeded", "atomic quota reached");
    },
    async listJobs() {
      listCalled = true;
      return [];
    },
  };
  const server = new RemoteRuntimeHttpServer({
    queue: new DurableWorkerQueue(store),
    executionRuntime: {
      async run() {
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 0 };
      },
    },
    workspaceRoot: root,
    authenticate: async () => ({ actor: "actor", claims: { tenant_id: "tenant" } }),
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request, "tenant");
      },
      async authorizeJob() {},
      async authorizeExecution() {},
    },
  });
  try {
    const endpoint = await server.listen();
    const response = await fetch(`${endpoint}/v1/executions`, {
      method: "POST",
      headers: { authorization: "Bearer ignored", "content-type": "application/json" },
      body: JSON.stringify({
        command: "true",
        workspaceId: "project",
        policy: "read-only",
        network: false,
        idempotencyKey: "atomic-quota",
      }),
    });
    assert.equal(response.status, 429);
    assert.equal(
      ((await response.json()) as { error: { code: string } }).error.code,
      "tenant_quota_exceeded",
    );
    assert.equal(listCalled, false);
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
    revoked: {
      actor: "user-1",
      claims: {
        tenant_id: "tenant-1",
        anicode_workspaces: [],
        anicode_permissions: [],
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
          policy: "read-only",
          network: false,
          idempotencyKey: "authz-test",
          ...overrides,
        }),
      });
    const accepted = await submit("owner");
    assert.equal(accepted.status, 202);
    const view = (await accepted.json()) as { id: string };

    const writeUnavailable = await submit("owner", {
      policy: "workspace-write",
      idempotencyKey: "write-disabled",
    });
    assert.equal(writeUnavailable.status, 503);
    assert.equal(
      ((await writeUnavailable.json()) as { error: { code: string } }).error.code,
      "remote_write_unavailable",
    );

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
    assert.equal(
      (
        await fetch(`${endpoint}/v1/executions/${view.id}`, {
          headers: { authorization: "Bearer revoked" },
        })
      ).status,
      404,
      "revoking the current workspace claim must revoke access to an existing job",
    );

    server.beginDrain();
    assert.equal((await fetch(`${endpoint}/readyz`)).status, 503);
    assert.equal((await submit("owner", { idempotencyKey: "during-drain" })).status, 503);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime server: pre-auth rate limit bounds expensive identity verification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-remote-preauth-rate-"));
  let authentications = 0;
  const server = new RemoteRuntimeHttpServer({
    queue: new DurableWorkerQueue(),
    executionRuntime: {
      async run() {
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 0 };
      },
    },
    workspaceRoot: root,
    authenticate: async () => {
      authentications++;
      return { actor: "rate-user" };
    },
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request, "tenant");
      },
      async authorizeJob() {},
      async authorizeExecution() {},
    },
    httpRateLimit: { windowMs: 60_000, maxRequests: 1 },
  });
  try {
    const endpoint = await server.listen();
    const first = await fetch(`${endpoint}/v1/executions/missing`, {
      headers: { authorization: "Bearer first" },
    });
    assert.equal(first.status, 404);
    const limited = await fetch(`${endpoint}/v1/executions/missing`, {
      headers: { authorization: "Bearer second" },
    });
    assert.equal(limited.status, 429);
    assert.equal(authentications, 1);
  } finally {
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Remote Runtime server: non-loopback bearer transport fails closed without TLS boundary", async () => {
  const common = {
    queue: new DurableWorkerQueue(),
    executionRuntime: {
      async run() {
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 0 };
      },
    },
    workspaceRoot: process.cwd(),
    authenticate: async () => ({ actor: "transport-test" }),
    authorizer: {
      async authorizeSubmit(_identity, request) {
        return testGrant(request);
      },
      async authorizeJob() {},
      async authorizeExecution() {},
    } satisfies RemoteRuntimeAuthorizer,
  };
  const insecure = new RemoteRuntimeHttpServer(common);
  await assert.rejects(() => insecure.listen(0, "0.0.0.0"), /refuses plaintext non-loopback bind/);
  const incompleteNativeTls = new RemoteRuntimeHttpServer({
    ...common,
    transportSecurity: { mode: "tls", tls: {} },
  });
  await assert.rejects(
    () => incompleteNativeTls.listen(),
    /requires both certificate and private key/,
  );

  const terminatedUpstream = new RemoteRuntimeHttpServer({
    ...common,
    transportSecurity: { mode: "trusted-proxy" },
  });
  try {
    assert.match(await terminatedUpstream.listen(0, "0.0.0.0"), /^http:\/\/0\.0\.0\.0:/);
  } finally {
    await terminatedUpstream.close();
  }
});
