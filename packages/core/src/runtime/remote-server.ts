/** Remote Runtime 控制面：认证 HTTP API + durable queue + 每任务隔离 ExecutionRuntime。 */

import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { SecureContextOptions } from "node:tls";
import { lstatSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { Telemetry } from "./telemetry.js";
import { noTelemetry, parseTraceparent } from "./telemetry.js";
import type { ExecutionRuntime, IsolatedRunResult } from "./isolated-runtime.js";
import { DurableWorkerQueue, WorkerQueueQuotaError, type WorkerJob } from "./worker.js";

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
  authorizedActor: string;
  authorizedTenantId: string;
  authorizedWorkspaceId: string;
  authorizedPolicy: RemoteExecutionRequest["policy"];
  authorizedNetwork: boolean;
  authorizedTimeoutMs?: number;
  authorizedAt: string;
  grantExpiresAt: string;
}

export interface RemoteExecutionGrant {
  tenantId: string;
  workspaceId: string;
  policy: RemoteExecutionRequest["policy"];
  network: boolean;
  timeoutMs?: number;
  /** Authorization decision time and hard execution deadline, persisted with the durable job. */
  authorizedAt: string;
  grantExpiresAt: string;
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
  /** Revalidate the persisted grant after claim and while the worker is executing it. */
  authorizeExecution(
    job: WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult>,
  ): Promise<void>;
}

export interface ClaimRemoteRuntimeAuthorizerOptions {
  tenantClaim?: string;
  workspaceClaim?: string;
  permissionClaim?: string;
  maxTimeoutMs?: number;
  grantTtlMs?: number;
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
  const grantTtlMs = Math.max(1_000, Math.min(60 * 60_000, options.grantTtlMs ?? maxTimeoutMs));
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
      const authorizedAtMs = Date.now();
      const identityExpiresAt =
        typeof identity.claims?.["exp"] === "number"
          ? Math.floor(identity.claims["exp"] * 1_000)
          : Number.POSITIVE_INFINITY;
      const grantExpiresAtMs = Math.min(authorizedAtMs + grantTtlMs, identityExpiresAt);
      if (!Number.isFinite(grantExpiresAtMs) || grantExpiresAtMs <= authorizedAtMs) {
        throw new RemoteHttpError(403, "authorization_expired", "OIDC authorization has expired");
      }
      return {
        tenantId,
        workspaceId: request.workspaceId,
        policy: request.policy,
        network: request.network,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        authorizedAt: new Date(authorizedAtMs).toISOString(),
        grantExpiresAt: new Date(grantExpiresAtMs).toISOString(),
      };
    },
    async authorizeJob(identity, _action, job) {
      const tenantId = requireClaim(identity, tenantClaim);
      const permissions = claimStrings(identity.claims, permissionClaim);
      const administrator = permissions.includes("*") || permissions.includes("jobs:admin");
      const workspaces = claimStrings(identity.claims, workspaceClaim);
      const workspaceAllowed =
        workspaces.includes("*") || workspaces.includes(job.payload.workspaceId);
      if (
        job.payload.tenantId !== tenantId ||
        !workspaceAllowed ||
        (!administrator && job.payload.actor !== identity.actor)
      ) {
        throw new RemoteHttpError(404, "execution_not_found", "Execution not found");
      }
    },
    async authorizeExecution(job) {
      assertPersistedExecutionGrant(job.payload);
    },
  };
}

export interface RemoteExecutionView {
  id: string;
  status: "queued" | "running" | "cancellation_requested" | "succeeded" | "failed" | "cancelled";
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

export type RemoteRuntimeTransportSecurity =
  | { mode: "tls"; tls: Pick<SecureContextOptions, "cert" | "key" | "ca"> }
  | { mode: "trusted-proxy" };

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
  authorizationPollMs?: number;
  transportSecurity?: RemoteRuntimeTransportSecurity;
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

class RemoteWorkerAuthorizationError extends Error {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "RemoteWorkerAuthorizationError";
  }
}

class RemoteCancellationRequestedError extends Error {
  constructor(id: string) {
    super(`Remote execution ${id} cancellation requested`);
    this.name = "RemoteCancellationRequestedError";
  }
}

function strictTimestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new RemoteWorkerAuthorizationError(`Invalid persisted ${label}`);
  }
  return parsed;
}

function assertPersistedExecutionGrant(payload: AuthorizedRemoteExecutionRequest): void {
  validId(payload.tenantId, "persisted tenant id");
  validId(payload.workspaceId, "persisted workspace id");
  validOpaqueIdentity(payload.actor, "persisted remote actor");
  if (payload.policy !== "read-only" && payload.policy !== "workspace-write") {
    throw new RemoteWorkerAuthorizationError("Invalid persisted workspace permission");
  }
  if (typeof payload.network !== "boolean") {
    throw new RemoteWorkerAuthorizationError("Invalid persisted network permission");
  }
  if (
    payload.authorizedActor !== payload.actor ||
    payload.authorizedTenantId !== payload.tenantId ||
    payload.authorizedWorkspaceId !== payload.workspaceId ||
    payload.authorizedPolicy !== payload.policy ||
    payload.authorizedNetwork !== payload.network ||
    payload.authorizedTimeoutMs !== payload.timeoutMs
  ) {
    throw new RemoteWorkerAuthorizationError(
      "Persisted execution identity or capability does not match its authorization grant",
    );
  }
  const authorizedAt = strictTimestamp(payload.authorizedAt, "authorization time");
  const grantExpiresAt = strictTimestamp(payload.grantExpiresAt, "authorization expiry");
  if (grantExpiresAt <= authorizedAt) {
    throw new RemoteWorkerAuthorizationError("Persisted execution grant has an invalid lifetime");
  }
  if (Date.now() >= grantExpiresAt) {
    throw new RemoteWorkerAuthorizationError("Persisted execution grant has expired");
  }
}

function validId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function validOpaqueIdentity(value: string, label: string, maximumBytes = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)
  ) {
    throw new RemoteHttpError(401, "invalid_identity", `Invalid ${label}`);
  }
  return value;
}

function remoteQueueKey(tenantId: string, actor: string, idempotencyKey: string): string {
  // Hash a canonical tuple instead of joining attacker-controlled fields with a delimiter. This
  // also gives every durable queue backend a fixed-size key and prevents legacy tuple collisions.
  const digest = createHash("sha256")
    .update(JSON.stringify([tenantId, actor, idempotencyKey]), "utf8")
    .digest("hex");
  return `remote:v2:${digest}`;
}

function remoteRequestFingerprint(request: RemoteExecutionRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.command,
        request.workspaceId,
        request.cwd ?? null,
        request.policy,
        request.network,
        request.timeoutMs ?? null,
        request.retryPolicy ?? "never",
      ]),
      "utf8",
    )
    .digest("hex");
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

export function safeWorkspace(root: string, workspaceId: string, cwd = "."): string {
  const canonicalRoot = realpathSync.native(root);
  const workspace = path.resolve(canonicalRoot, validId(workspaceId, "workspace id"));
  const resolved = path.resolve(workspace, cwd);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Remote cwd escapes workspace");
  }
  // Tenant roots and cwd must be concrete directories, not symlink aliases to another tenant.
  // Resolve after the lexical boundary check and require exact identity to reject any component
  // that crosses the declared workspace via a symlink.
  if (lstatSync(workspace).isSymbolicLink())
    throw new Error("Remote workspace cannot be a symlink");
  const canonicalWorkspace = realpathSync.native(workspace);
  if (canonicalWorkspace !== workspace) throw new Error("Remote workspace crosses a symlink");
  const canonicalResolved = realpathSync.native(resolved);
  if (
    canonicalResolved !== canonicalWorkspace &&
    !canonicalResolved.startsWith(`${canonicalWorkspace}${path.sep}`)
  ) {
    throw new Error("Remote cwd escapes workspace through a symlink");
  }
  if (canonicalResolved !== resolved) throw new Error("Remote cwd cannot cross a symlink");
  return canonicalResolved;
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
      job.status === "cancellation_requested" ||
      (job.status === "failed" && /lease expired|indeterminate/i.test(job.error ?? ""))
        ? "indeterminate"
        : "known",
  };
}

function linkedExecutionAbort(parent: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? new Error("Remote worker stopped"));
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return { controller, dispose: () => parent.removeEventListener("abort", abort) };
}

function remoteJobOwned(job: WorkerJob | undefined, owner: string, fencingToken?: number): boolean {
  return Boolean(
    job &&
    job.status === "leased" &&
    job.leaseOwner === owner &&
    (fencingToken === undefined || job.fencingToken === fencingToken),
  );
}

export class RemoteExecutionService {
  private readonly telemetry: Telemetry;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxOutstandingPerTenant: number;
  private readonly maxQueuedPerActor: number;
  private readonly maxCommandChars: number;
  private readonly activeExecutions = new Map<string, AbortController>();
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
    const actor = validOpaqueIdentity(identity.actor, "remote actor");
    validId(request.workspaceId, "workspace id");
    if (!request.command.trim()) throw new Error("Remote command cannot be empty");
    if (request.command.length > this.maxCommandChars) {
      throw new RemoteHttpError(413, "command_too_large", "Remote command exceeds policy limit");
    }
    if (!request.idempotencyKey || request.idempotencyKey.length > 256) {
      throw new Error("Invalid remote idempotency key");
    }
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
    validId(grant.tenantId, "tenant id");
    if (grant.workspaceId !== request.workspaceId) {
      throw new RemoteHttpError(403, "workspace_denied", "Authorized workspace mismatch");
    }
    if (grant.policy !== request.policy || grant.network !== request.network) {
      throw new RemoteHttpError(403, "authorization_mismatch", "Authorized capability mismatch");
    }
    if (grant.policy === "workspace-write") {
      throw new RemoteHttpError(
        503,
        "remote_write_unavailable",
        "Remote workspace-write is disabled until an authoritative queue-fenced committer is configured",
      );
    }
    // Filesystem existence and symlink diagnostics are evaluated only after authorization, so an
    // unauthorised identity cannot use error differences to enumerate control-plane workspaces.
    safeWorkspace(this.options.workspaceRoot, grant.workspaceId, request.cwd);
    const payload: AuthorizedRemoteExecutionRequest = {
      ...request,
      workspaceId: grant.workspaceId,
      policy: grant.policy,
      network: grant.network,
      ...(grant.timeoutMs !== undefined ? { timeoutMs: grant.timeoutMs } : {}),
      retryPolicy,
      actor,
      tenantId: grant.tenantId,
      authorizedActor: actor,
      authorizedTenantId: grant.tenantId,
      authorizedWorkspaceId: grant.workspaceId,
      authorizedPolicy: grant.policy,
      authorizedNetwork: grant.network,
      ...(grant.timeoutMs !== undefined ? { authorizedTimeoutMs: grant.timeoutMs } : {}),
      authorizedAt: grant.authorizedAt,
      grantExpiresAt: grant.grantExpiresAt,
    };
    try {
      assertPersistedExecutionGrant(payload);
    } catch (error) {
      throw new RemoteHttpError(
        403,
        "authorization_expired",
        error instanceof Error ? error.message : "Execution authorization is invalid",
      );
    }
    const queueKey = remoteQueueKey(grant.tenantId, actor, request.idempotencyKey);
    const pending = this.submitTail
      .catch(() => undefined)
      .then(async () => {
        // The process-local quota tail may wait behind other submissions. Never persist a grant
        // which expired while waiting for admission.
        try {
          assertPersistedExecutionGrant(payload);
        } catch (error) {
          throw new RemoteHttpError(
            403,
            "authorization_expired",
            error instanceof Error ? error.message : "Execution authorization is invalid",
          );
        }
        if (this.options.queue.store.enqueueJobWithQuota) {
          try {
            return (await this.options.queue.enqueue("remote-execution", payload, {
              idempotencyKey: queueKey,
              maxAttempts: retryPolicy === "safe" ? 3 : 1,
              quota: {
                tenantId: grant.tenantId,
                actor,
                maxOutstandingPerTenant: this.maxOutstandingPerTenant,
                maxQueuedPerActor: this.maxQueuedPerActor,
              },
            })) as WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult>;
          } catch (error) {
            if (error instanceof WorkerQueueQuotaError) {
              throw new RemoteHttpError(429, error.code, error.message);
            }
            throw error;
          }
        }
        const jobs = (await this.options.queue.list()) as WorkerJob<
          AuthorizedRemoteExecutionRequest,
          IsolatedRunResult
        >[];
        const duplicate = jobs.find((job) => job.idempotencyKey === queueKey);
        if (duplicate) return duplicate;
        const outstanding = jobs.filter(
          (job) =>
            job.payload?.tenantId === grant.tenantId &&
            (job.status === "queued" ||
              job.status === "leased" ||
              job.status === "cancellation_requested"),
        );
        if (outstanding.length >= this.maxOutstandingPerTenant) {
          throw new RemoteHttpError(
            429,
            "tenant_quota_exceeded",
            "Tenant execution quota exceeded",
          );
        }
        const actorQueued = outstanding.filter(
          (job) => job.payload.actor === actor && job.status === "queued",
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
    const job = await pending;
    // Enqueue can return a durable duplicate. Re-authorize that concrete job before exposing its id
    // or result, including records written by an older queue-key scheme.
    await this.options.authorizer.authorizeJob(identity, "read", job);
    try {
      assertPersistedExecutionGrant(job.payload);
      await this.options.authorizer.authorizeExecution(job);
    } catch (error) {
      throw new RemoteHttpError(
        403,
        "authorization_expired",
        error instanceof Error ? error.message : "Execution authorization is invalid",
      );
    }
    if (remoteRequestFingerprint(job.payload) !== remoteRequestFingerprint(payload)) {
      throw new RemoteHttpError(
        409,
        "idempotency_conflict",
        "Idempotency key was already used for a different execution request",
      );
    }
    return toView(job);
  }

  async get(identity: RemoteIdentity, id: string): Promise<RemoteExecutionView | undefined> {
    validId(id, "execution id");
    const job = (await this.options.queue.get(id)) as
      WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult> | undefined;
    if (!job) return undefined;
    await this.options.authorizer.authorizeJob(identity, "read", job);
    return toView(job);
  }

  async cancel(
    identity: RemoteIdentity,
    id: string,
  ): Promise<"cancelled" | "cancellation_requested" | false> {
    validId(id, "execution id");
    const job = (await this.options.queue.get(id)) as
      WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult> | undefined;
    if (!job) return false;
    await this.options.authorizer.authorizeJob(identity, "cancel", job);
    const cancellation = await this.options.queue.requestCancellation(id);
    if (cancellation === "cancellation_requested") {
      this.activeExecutions.get(id)?.abort(new RemoteCancellationRequestedError(id));
    }
    return cancellation === "not_cancellable" ? false : cancellation;
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
    const linked = linkedExecutionAbort(signal);
    this.activeExecutions.set(job.id, linked.controller);
    const heartbeat = setInterval(
      () =>
        void this.options.queue
          .heartbeat(job.id, this.workerId, this.leaseMs, job.fencingToken)
          .catch((error) => linked.controller.abort(error)),
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    let checkingControlState = false;
    const controlStatePoll = setInterval(
      () => {
        if (checkingControlState || linked.controller.signal.aborted) return;
        checkingControlState = true;
        void this.options.queue
          .get(job.id)
          .then(async (current) => {
            const claimed = current as
              WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult> | undefined;
            if (
              claimed?.status === "cancellation_requested" &&
              claimed.leaseOwner === this.workerId &&
              claimed.fencingToken === job.fencingToken
            ) {
              linked.controller.abort(new RemoteCancellationRequestedError(job.id));
              return;
            }
            if (!claimed || !remoteJobOwned(claimed, this.workerId, job.fencingToken)) {
              linked.controller.abort(new Error(`Remote execution ${job.id} lease was lost`));
              return;
            }
            await this.revalidateExecutionGrant(claimed);
          })
          .catch((error) => linked.controller.abort(error))
          .finally(() => {
            checkingControlState = false;
          });
      },
      Math.max(100, Math.min(5_000, this.options.authorizationPollMs ?? 500)),
    );
    try {
      await this.revalidateExecutionGrant(job);
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
          ...(job.fencingToken !== undefined ? { fencingToken: job.fencingToken } : {}),
        },
        signal: linked.controller.signal,
      });
      linked.controller.signal.throwIfAborted();
      await this.options.queue.finish(job.id, this.workerId, result, job.fencingToken);
      span
        .setAttribute("process.exit.code", result.exitCode ?? -1)
        .setAttribute("anicode.remote.duration_ms", result.durationMs)
        .setStatus({ code: result.exitCode === 0 ? "ok" : "error" });
    } catch (error) {
      const current = (await this.options.queue.get(job.id).catch(() => undefined)) as
        WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult> | undefined;
      if (
        current?.status === "cancellation_requested" &&
        current.leaseOwner === this.workerId &&
        current.fencingToken === job.fencingToken
      ) {
        // Only the worker which held the execution lease can acknowledge that it observed the
        // durable request and stopped. Until this transition, clients see cancellation_requested.
        await this.options.queue
          .acknowledgeCancellation(job.id, this.workerId, job.fencingToken)
          .catch(() => undefined);
      } else if (remoteJobOwned(current, this.workerId, job.fencingToken)) {
        await this.options.queue
          .fail(
            job.id,
            this.workerId,
            error instanceof Error ? error.message : String(error),
            job.payload.retryPolicy === "safe" &&
              !(error instanceof RemoteWorkerAuthorizationError),
            job.fencingToken,
          )
          .catch(() => undefined);
      }
      span.recordException(error).setStatus({ code: "error" });
    } finally {
      clearInterval(heartbeat);
      clearInterval(controlStatePoll);
      linked.dispose();
      if (this.activeExecutions.get(job.id) === linked.controller) {
        this.activeExecutions.delete(job.id);
      }
      span.end();
    }
    return true;
  }

  private async revalidateExecutionGrant(
    job: WorkerJob<AuthorizedRemoteExecutionRequest, IsolatedRunResult>,
  ): Promise<void> {
    try {
      assertPersistedExecutionGrant(job.payload);
      await this.options.authorizer.authorizeExecution(job);
      // An external policy check may take long enough for the grant to expire.
      assertPersistedExecutionGrant(job.payload);
    } catch (error) {
      if (error instanceof RemoteWorkerAuthorizationError) throw error;
      throw new RemoteWorkerAuthorizationError("Remote execution authorization was denied", {
        cause: error,
      });
    }
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

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    /^127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
}

export class RemoteRuntimeHttpServer {
  readonly service: RemoteExecutionService;
  private server: HttpServer | HttpsServer | undefined;
  private accepting = true;
  private readonly telemetry: Telemetry;
  private readonly requestRates = new Map<string, { startedAt: number; count: number }>();
  constructor(private readonly options: RemoteRuntimeServerOptions) {
    this.telemetry = options.telemetry ?? noTelemetry;
    this.service = new RemoteExecutionService(options);
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    if (this.server) throw new Error("Remote Runtime server is already listening");
    const transport = this.options.transportSecurity;
    if (!isLoopbackHost(host) && !transport) {
      throw new Error(
        "Remote Runtime refuses plaintext non-loopback bind; configure native TLS or a trusted TLS-terminating proxy",
      );
    }
    if (transport?.mode === "tls" && (!transport.tls.cert || !transport.tls.key)) {
      throw new Error("Remote Runtime native TLS requires both certificate and private key");
    }
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      void this.route(request, response).catch((error) => {
        const expected = error instanceof RemoteHttpError;
        if (!expected) this.recordServerError("anicode.remote.http.error", error);
        const status = expected ? error.status : 500;
        jsonResponse(response, status, {
          error: {
            code: expected ? error.code : "internal_error",
            message: expected ? error.message : "Remote Runtime request failed",
          },
        });
      });
    };
    const server =
      transport?.mode === "tls"
        ? createHttpsServer(
            { ...transport.tls, minVersion: "TLSv1.2", honorCipherOrder: true },
            handler,
          )
        : createHttpServer(handler);
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
    return `${transport?.mode === "tls" ? "https" : "http"}://${host}:${address.port}`;
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
    const url = new URL(request.url ?? "/", "http://remote-runtime.local");
    if (request.method === "GET" && url.pathname === "/healthz") {
      if (!this.withinRateLimit(request, response, "public")) return;
      jsonResponse(response, 200, { ok: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      if (!this.withinRateLimit(request, response, "public")) return;
      let checks: Record<string, boolean | string>;
      try {
        checks = (await this.options.readiness?.()) ?? {};
      } catch (error) {
        this.recordServerError("anicode.remote.readiness.error", error);
        checks = { dependencies: false };
      }
      const ready =
        this.accepting && Object.values(checks).every((value) => value === true || value === "ok");
      jsonResponse(response, ready ? 200 : 503, {
        ready,
        accepting: this.accepting,
      });
      return;
    }
    // Bound expensive JWT/JWKS authentication by source before invoking the verifier. Successful
    // identities are additionally limited in their actor bucket below.
    if (!this.withinRateLimit(request, response, "preauth")) return;
    let identity: RemoteIdentity;
    try {
      identity = await this.options.authenticate(request);
    } catch {
      if (!this.withinRateLimit(request, response, "unauthenticated")) return;
      throw new RemoteHttpError(401, "unauthorized", "Authentication required");
    }
    const actor = validOpaqueIdentity(identity.actor, "remote actor");
    const actorBucket = createHash("sha256").update(actor, "utf8").digest("hex");
    if (!this.withinRateLimit(request, response, `actor:${actorBucket}`)) return;
    if (request.method === "POST" && url.pathname === "/v1/executions") {
      if (!this.accepting) {
        throw new RemoteHttpError(503, "runtime_draining", "Remote Runtime is draining");
      }
      let body: RemoteExecutionRequest;
      try {
        body = parseRemoteExecutionRequest(
          await readJson<unknown>(request, this.options.maxBodyBytes ?? 256 * 1024),
        );
      } catch (error) {
        if (error instanceof RemoteHttpError) throw error;
        throw new RemoteHttpError(400, "invalid_request", "Invalid execution request");
      }
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
      const cancellation = await this.service.cancel(identity, decodeURIComponent(matched[1]!));
      jsonResponse(response, cancellation ? 202 : 409, {
        cancelled: cancellation === "cancelled",
        cancellationRequested: cancellation === "cancellation_requested",
        status: cancellation || "not_cancellable",
      });
      return;
    }
    jsonResponse(response, 404, { error: "not found" });
  }

  private withinRateLimit(
    request: IncomingMessage,
    response: ServerResponse,
    bucket: string,
  ): boolean {
    const windowMs = Math.max(1_000, this.options.httpRateLimit?.windowMs ?? 60_000);
    const maximum = Math.max(1, this.options.httpRateLimit?.maxRequests ?? 1_200);
    const now = Date.now();
    const key = `${bucket}:${request.socket.remoteAddress ?? "unknown"}`;
    if (this.requestRates.size >= 4_096 && !this.requestRates.has(key)) {
      for (const [candidate, value] of this.requestRates) {
        if (now - value.startedAt >= windowMs) this.requestRates.delete(candidate);
      }
      if (this.requestRates.size >= 4_096) {
        jsonResponse(response, 429, {
          error: { code: "rate_limited", message: "Remote Runtime rate buckets are full" },
        });
        return false;
      }
    }
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

  private recordServerError(name: string, error: unknown): void {
    const span = this.telemetry.startSpan(name);
    span.recordException(error).setStatus({ code: "error" }).end();
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
