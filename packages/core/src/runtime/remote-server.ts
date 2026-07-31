/** Remote Runtime 控制面：认证 HTTP API + durable queue + 每任务隔离 ExecutionRuntime。 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import type { Telemetry } from "./telemetry.js";
import { noTelemetry, parseTraceparent } from "./telemetry.js";
import type { ExecutionRuntime, IsolatedRunResult } from "./isolated-runtime.js";
import { DurableWorkerQueue, type WorkerJob } from "./worker.js";

export interface RemoteIdentity {
  actor: string;
  claims?: Record<string, unknown>;
}

export interface RemoteExecutionRequest {
  command: string;
  workspaceId: string;
  cwd?: string;
  policy: "read-only" | "workspace-write";
  network: boolean;
  timeoutMs?: number;
  idempotencyKey: string;
  traceparent?: string;
  /** 默认 never。只有 read-only 且断网的命令可显式声明 safe 并在租约失败后重试。 */
  retryPolicy?: "never" | "safe";
}

interface AuthorizedRemoteExecutionRequest extends RemoteExecutionRequest {
  actor: string;
  tenantId: string;
}

export interface RemoteExecutionGrant {
  tenantId: string;
  workspaceId: string;
  policy: RemoteExecutionRequest["policy"];
  network: boolean;
  timeoutMs?: number;
}

export interface RemoteRuntimeAuthorizer {
  authorizeSubmit(
    identity: RemoteIdentity,
    request: RemoteExecutionRequest,
  ): Promise<RemoteExecutionGrant>;
  authorizeJob(
    identity: RemoteIdentity,
    action: "read" | "cancel",
    job: WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult>,
  ): Promise<void>;
}

export interface ClaimRemoteRuntimeAuthorizerOptions {
  tenantClaim?: string;
  workspaceClaim?: string;
  permissionClaim?: string;
  maxTimeoutMs?: number;
}

function claimStrings(claims: Record<string, unknown> | undefined, name: string): string[] {
  const value = claims?.[name];
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return value.split(/[ ,]+/).filter(Boolean);
  return value === undefined ? [] : [String(value)];
}

function requireClaim(identity: RemoteIdentity, name: string): string {
  const value = claimStrings(identity.claims, name)[0];
  if (!value) throw new RemoteHttpError(403, "authorization_denied", `Missing OIDC claim ${name}`);
  return validId(value, `OIDC ${name} claim`);
}

/**
 * 生产默认授权器。客户端只能申请能力，最终 workspace、写入、联网和超时上限均由
 * 已验证的 OIDC claims 决定，且 job 默认仅创建者本人可读/取消。
 */
export function createClaimRemoteRuntimeAuthorizer(
  options: ClaimRemoteRuntimeAuthorizerOptions = {},
): RemoteRuntimeAuthorizer {
  const tenantClaim = options.tenantClaim ?? "tenant_id";
  const workspaceClaim = options.workspaceClaim ?? "anicode_workspaces";
  const permissionClaim = options.permissionClaim ?? "anicode_permissions";
  const maxTimeoutMs = Math.max(1_000, options.maxTimeoutMs ?? 15 * 60_000);
  return {
    async authorizeSubmit(identity, request) {
      const tenantId = requireClaim(identity, tenantClaim);
      const workspaces = claimStrings(identity.claims, workspaceClaim);
      if (!workspaces.includes("*") && !workspaces.includes(request.workspaceId)) {
        throw new RemoteHttpError(403, "workspace_denied", "Workspace access is denied");
      }
      const permissions = claimStrings(identity.claims, permissionClaim);
      const allowed = (permission: string) =>
        permissions.includes("*") || permissions.includes(permission);
      if (request.policy === "workspace-write" && !allowed("workspace:write")) {
        throw new RemoteHttpError(403, "write_denied", "Workspace write access is denied");
      }
      if (request.network && !allowed("network:egress")) {
        throw new RemoteHttpError(403, "network_denied", "Network access is denied");
      }
      if (request.timeoutMs !== undefined && request.timeoutMs > maxTimeoutMs) {
        throw new RemoteHttpError(403, "timeout_denied", "Requested timeout exceeds policy");
      }
      return {
        tenantId,
        workspaceId: request.workspaceId,
        policy: request.policy,
        network: request.network,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
      };
    },
    async authorizeJob(identity, _action, job) {
      const tenantId = requireClaim(identity, tenantClaim);
      const permissions = claimStrings(identity.claims, permissionClaim);
      const administrator = permissions.includes("*") || permissions.includes("jobs:admin");
      if (
        !administrator &&
        (job.payload.tenantId !== tenantId || job.payload.actor !== identity.actor)
      ) {
        throw new RemoteHttpError(404, "execution_not_found", "Execution not found");
      }
    },
  };
}

export interface RemoteExecutionView {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result?: IsolatedRunResult;
  error?: string;
  attempts: number;
  fencingToken?: number;
  createdAt: string;
  updatedAt: string;
  /** indeterminate 表示执行租约丢失，外部观察者不能假定命令从未运行。 */
  outcome: "known" | "indeterminate";
}

export interface RemoteRuntimeQuotas {
  maxOutstandingPerTenant?: number;
  maxQueuedPerActor?: number;
  maxCommandChars?: number;
}

export interface RemoteRuntimeServerOptions {
  queue: DurableWorkerQueue;
  executionRuntime: ExecutionRuntime;
  workspaceRoot: string;
  authenticate: (request: IncomingMessage) => Promise<RemoteIdentity>;
  authorizer: RemoteRuntimeAuthorizer;
  readiness?: () => Promise<Record<string, boolean | string>>;
  telemetry?: Telemetry;
  maxBodyBytes?: number;
  leaseMs?: number;
  workerId?: string;
  quotas?: RemoteRuntimeQuotas;
  httpRateLimit?: { windowMs?: number; maxRequests?: number };
}

class RemoteHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function validId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function parseRemoteExecutionRequest(value: unknown): RemoteExecutionRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteHttpError(400, "invalid_request", "Execution request must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input["command"] !== "string") throw new Error("command must be a string");
  if (typeof input["workspaceId"] !== "string") throw new Error("workspaceId must be a string");
  if (input["cwd"] !== undefined && typeof input["cwd"] !== "string") {
    throw new Error("cwd must be a string");
  }
  if (input["policy"] !== "read-only" && input["policy"] !== "workspace-write") {
    throw new Error("policy must be read-only or workspace-write");
  }
  if (typeof input["network"] !== "boolean") throw new Error("network must be boolean");
  if (
    input["timeoutMs"] !== undefined &&
    (typeof input["timeoutMs"] !== "number" ||
      !Number.isSafeInteger(input["timeoutMs"]) ||
      input["timeoutMs"] < 1_000)
  ) {
    throw new Error("timeoutMs must be an integer of at least 1000");
  }
  if (typeof input["idempotencyKey"] !== "string") {
    throw new Error("idempotencyKey must be a string");
  }
  if (input["traceparent"] !== undefined && typeof input["traceparent"] !== "string") {
    throw new Error("traceparent must be a string");
  }
  if (
    input["retryPolicy"] !== undefined &&
    input["retryPolicy"] !== "never" &&
    input["retryPolicy"] !== "safe"
  ) {
    throw new Error("retryPolicy must be never or safe");
  }
  return {
    command: input["command"],
    workspaceId: input["workspaceId"],
    policy: input["policy"],
    network: input["network"],
    idempotencyKey: input["idempotencyKey"],
    ...(typeof input["cwd"] === "string" ? { cwd: input["cwd"] } : {}),
    ...(typeof input["timeoutMs"] === "number" ? { timeoutMs: input["timeoutMs"] } : {}),
    ...(typeof input["traceparent"] === "string" ? { traceparent: input["traceparent"] } : {}),
    ...(input["retryPolicy"] === "never" || input["retryPolicy"] === "safe"
      ? { retryPolicy: input["retryPolicy"] }
      : {}),
  };
}

function safeWorkspace(root: string, workspaceId: string, cwd = "."): string {
  const workspace = path.resolve(root, validId(workspaceId, "workspace id"));
  const resolved = path.resolve(workspace, cwd);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Remote cwd escapes workspace");
  }
  return resolved;
}

function toView(job: WorkerJob<RemoteExecutionRequest, IsolatedRunResult>): RemoteExecutionView {
  const status =
    job.status === "leased" ? "running" : job.status === "succeeded" ? "succeeded" : job.status;
  return {
    id: job.id,
    status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    attempts: job.attempts,
    ...(job.fencingToken !== undefined ? { fencingToken: job.fencingToken } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    outcome:
      job.status === "failed" && /lease expired|indeterminate/i.test(job.error ?? "")
        ? "indeterminate"
        : "known",
  };
}

export class RemoteExecutionService {
  private readonly telemetry: Telemetry;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxOutstandingPerTenant: number;
  private readonly maxQueuedPerActor: number;
  private readonly maxCommandChars: number;
  private submitTail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: RemoteRuntimeServerOptions) {
    this.telemetry = options.telemetry ?? noTelemetry;
    this.workerId = options.workerId ?? `remote-${process.pid}`;
    this.leaseMs = Math.max(5_000, options.leaseMs ?? 60_000);
    this.maxOutstandingPerTenant = Math.max(1, options.quotas?.maxOutstandingPerTenant ?? 100);
    this.maxQueuedPerActor = Math.max(1, options.quotas?.maxQueuedPerActor ?? 20);
    this.maxCommandChars = Math.max(1_024, options.quotas?.maxCommandChars ?? 32_768);
  }

  async submit(
    identity: RemoteIdentity,
    request: RemoteExecutionRequest,
  ): Promise<RemoteExecutionView> {
    validId(request.workspaceId, "workspace id");
    if (!request.command.trim()) throw new Error("Remote command cannot be empty");
    if (request.command.length > this.maxCommandChars) {
      throw new RemoteHttpError(413, "command_too_large", "Remote command exceeds policy limit");
    }
    if (!request.idempotencyKey || request.idempotencyKey.length > 256) {
      throw new Error("Invalid remote idempotency key");
    }
    safeWorkspace(this.options.workspaceRoot, request.workspaceId, request.cwd);
    const retryPolicy = request.retryPolicy ?? "never";
    if (retryPolicy !== "never" && retryPolicy !== "safe") {
      throw new Error("Invalid remote retry policy");
    }
    if (retryPolicy === "safe" && (request.policy !== "read-only" || request.network)) {
      throw new RemoteHttpError(
        400,
        "unsafe_retry_policy",
        "Retry-safe executions must be read-only with network disabled",
      );
    }
    const grant = await this.options.authorizer.authorizeSubmit(identity, request);
    if (grant.workspaceId !== request.workspaceId) {
      throw new RemoteHttpError(403, "workspace_denied", "Authorized workspace mismatch");
    }
    const payload: AuthorizedRemoteExecutionRequest = {
      ...request,
      workspaceId: grant.workspaceId,
      policy: grant.policy,
      network: grant.network,
      ...(grant.timeoutMs !== undefined ? { timeoutMs: grant.timeoutMs } : {}),
      retryPolicy,
      actor: identity.actor,
      tenantId: grant.tenantId,
    };
    const queueKey = `${grant.tenantId}:${identity.actor}:${request.idempotencyKey}`;
    const pending = this.submitTail
      .catch(() => undefined)
      .then(async () => {
        const jobs = (await this.options.queue.list()) as WorkerJob<
          AuthorizedRemoteExecutionRequest,
          IsolatedRunResult
        >[];
        const duplicate = jobs.find((job) => job.idempotencyKey === queueKey);
        if (duplicate) return duplicate;
        const outstanding = jobs.filter(
          (job) =>
            job.payload?.tenantId === grant.tenantId &&
            (job.status === "queued" || job.status === "leased"),
        );
        if (outstanding.length >= this.maxOutstandingPerTenant) {
          throw new RemoteHttpError(
            429,
            "tenant_quota_exceeded",
            "Tenant execution quota exceeded",
          );
        }
        const actorQueued = outstanding.filter(
          (job) => job.payload.actor === identity.actor && job.status === "queued",
        );
        if (actorQueued.length >= this.maxQueuedPerActor) {
          throw new RemoteHttpError(429, "actor_queue_full", "Actor execution queue is full");
        }
        return this.options.queue.enqueue("remote-execution", payload, {
          idempotencyKey: queueKey,
          maxAttempts: retryPolicy === "safe" ? 3 : 1,
        }) as Promise<WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult>>;
      });
    this.submitTail = pending;
    return toView(await pending);
  }

  async get(identity: RemoteIdentity, id: string): Promise<RemoteExecutionView | undefined> {
    validId(id, "execution id");
    const job = (await this.options.queue.get(id)) as
      WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult> | undefined;
    if (!job) return undefined;
    await this.options.authorizer.authorizeJob(identity, "read", job);
    return toView(job);
  }

  async cancel(identity: RemoteIdentity, id: string): Promise<boolean> {
    validId(id, "execution id");
    const job = (await this.options.queue.get(id)) as
      WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult> | undefined;
    if (!job) return false;
    await this.options.authorizer.authorizeJob(identity, "cancel", job);
    return this.options.queue.cancel(id);
  }

  async runOnce(signal = new AbortController().signal): Promise<boolean> {
    const job = (await this.options.queue.claim(
      this.workerId,
      ["remote-execution"],
      this.leaseMs,
    )) as WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult> | undefined;
    if (!job) return false;
    const span = this.telemetry.startSpan(
      "anicode.remote.execution",
      {
        "anicode.remote.execution.id": job.id,
        "anicode.remote.workspace.id": job.payload.workspaceId,
        "anicode.worker.fencing_token": job.fencingToken ?? 0,
        "anicode.remote.network": job.payload.network,
      },
      parseTraceparent(job.payload.traceparent),
    );
    const context = span.context();
    const heartbeat = setInterval(
      () =>
        void this.options.queue
          .heartbeat(job.id, this.workerId, this.leaseMs, job.fencingToken)
          .catch(() => undefined),
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    try {
      const result = await this.options.executionRuntime.run({
        command: job.payload.command,
        cwd: safeWorkspace(this.options.workspaceRoot, job.payload.workspaceId, job.payload.cwd),
        policy: job.payload.policy,
        network: job.payload.network,
        ...(job.payload.timeoutMs ? { timeoutMs: job.payload.timeoutMs } : {}),
        ...(context ? { traceContext: context } : {}),
        env: { ANICODE_EXECUTION_ID: job.id },
        workload: {
          tenantId: job.payload.tenantId,
          actor: job.payload.actor,
          executionId: job.id,
        },
        signal,
      });
      await this.options.queue.finish(job.id, this.workerId, result, job.fencingToken);
      span
        .setAttribute("process.exit.code", result.exitCode ?? -1)
        .setAttribute("anicode.remote.duration_ms", result.durationMs)
        .setStatus({ code: result.exitCode === 0 ? "ok" : "error" });
    } catch (error) {
      await this.options.queue.fail(
        job.id,
        this.workerId,
        error instanceof Error ? error.message : String(error),
        job.payload.retryPolicy === "safe",
        job.fencingToken,
      );
      span.recordException(error).setStatus({ code: "error" });
    } finally {
      clearInterval(heartbeat);
      span.end();
    }
    return true;
  }

  async run(
    options: { signal?: AbortSignal; pollMs?: number; concurrency?: number } = {},
  ): Promise<void> {
    const concurrency = Math.max(1, Math.min(64, Math.floor(options.concurrency ?? 1)));
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (!options.signal?.aborted) {
          if (!(await this.runOnce(options.signal))) {
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(25, options.pollMs ?? 250)),
            );
          }
        }
      }),
    );
  }
}

export class RemoteRuntimeHttpServer {
  readonly service: RemoteExecutionService;
  private server: Server | undefined;
  private accepting = true;
  private readonly requestRates = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly options: RemoteRuntimeServerOptions) {
    this.service = new RemoteExecutionService(options);
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    if (this.server) throw new Error("Remote Runtime server is already listening");
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        const status =
          error instanceof RemoteHttpError
            ? error.status
            : /auth/i.test(error instanceof Error ? error.message : "")
              ? 401
              : 400;
        jsonResponse(response, status, {
          error: {
            code: error instanceof RemoteHttpError ? error.code : "invalid_request",
            message: error instanceof Error ? error.message : String(error),
          },
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    server.keepAliveTimeout = 5_000;
    server.maxRequestsPerSocket = 100;
    server.maxConnections = 256;
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Remote Runtime bind failed");
    return `http://${host}:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    this.requestRates.clear();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  beginDrain(): void {
    this.accepting = false;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.withinRateLimit(request, response)) return;
    const url = new URL(request.url ?? "/", "http://remote-runtime.local");
    if (request.method === "GET" && url.pathname === "/healthz") {
      jsonResponse(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const checks = await this.options.readiness?.().catch((error) => ({
        dependencies: error instanceof Error ? error.message : String(error),
      }));
      const ready =
        this.accepting &&
        Object.values(checks ?? {}).every((value) => value === true || value === "ok");
      jsonResponse(response, ready ? 200 : 503, {
        ready,
        accepting: this.accepting,
        checks: checks ?? {},
      });
      return;
    }
    const identity = await this.options.authenticate(request);
    if (request.method === "POST" && url.pathname === "/v1/executions") {
      if (!this.accepting) {
        throw new RemoteHttpError(503, "runtime_draining", "Remote Runtime is draining");
      }
      const body = parseRemoteExecutionRequest(
        await readJson<unknown>(request, this.options.maxBodyBytes ?? 256 * 1024),
      );
      jsonResponse(response, 202, await this.service.submit(identity, body));
      return;
    }
    const matched = /^\/v1\/executions\/([^/]+)$/.exec(url.pathname);
    if (matched && request.method === "GET") {
      const execution = await this.service.get(identity, decodeURIComponent(matched[1]!));
      jsonResponse(response, execution ? 200 : 404, execution ?? { error: "not found" });
      return;
    }
    if (matched && request.method === "DELETE") {
      const cancelled = await this.service.cancel(identity, decodeURIComponent(matched[1]!));
      jsonResponse(response, cancelled ? 202 : 409, { cancelled });
      return;
    }
    jsonResponse(response, 404, { error: "not found" });
  }

  private withinRateLimit(request: IncomingMessage, response: ServerResponse): boolean {
    const windowMs = Math.max(1_000, this.options.httpRateLimit?.windowMs ?? 60_000);
    const maximum = Math.max(1, this.options.httpRateLimit?.maxRequests ?? 1_200);
    const now = Date.now();
    const key = request.socket.remoteAddress ?? "unknown";
    let rate = this.requestRates.get(key);
    if (!rate || now - rate.startedAt >= windowMs) {
      rate = { startedAt: now, count: 0 };
      this.requestRates.set(key, rate);
    }
    rate.count++;
    if (rate.count <= maximum) return true;
    response.setHeader(
      "retry-after",
      String(Math.max(1, Math.ceil((rate.startedAt + windowMs - now) / 1_000))),
    );
    jsonResponse(response, 429, {
      error: { code: "rate_limited", message: "Remote Runtime request rate exceeded" },
    });
    return false;
  }
}

async function readJson<T>(request: IncomingMessage, limit: number): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > limit) throw new Error(`request exceeds ${limit} bytes`);
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}
