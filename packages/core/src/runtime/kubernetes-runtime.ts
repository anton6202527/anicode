/** Kubernetes Job 执行后端：每条命令一个短生命周期 Pod，完成后删除。 */

import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { promises as fs, readFileSync } from "node:fs";
import { isIP } from "node:net";
import * as path from "node:path";
import { Agent as UndiciAgent } from "undici";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
} from "./isolated-runtime.js";
import { RuntimeTerminationError } from "./isolated-runtime.js";
import type { ScopedProxyCredentialIssuer, ScopedProxyCredentialLease } from "./network-proxy.js";
import { traceparent } from "./telemetry.js";

export interface KubernetesJobRuntimeOptions {
  image: string;
  namespace?: string;
  apiServer?: string;
  tokenFile?: string;
  caFile?: string;
  workspacePvc: string;
  hostWorkspaceRoot: string;
  /** 默认把 PVC 中的 workspace 复制到每个 Job 独享的 emptyDir，任务结束即销毁。 */
  ephemeralWorkspace?: boolean;
  workspaceSizeLimit?: string;
  proxyUrl?: string;
  /** Trusted control-plane issuer. The Pod never receives a shared long-lived credential. */
  proxyCredentialIssuer?: ScopedProxyCredentialIssuer;
  serviceAccount?: string;
  pollMs?: number;
  /** Test-runner seam only. Production API calls must use HTTPS with the configured cluster CA. */
  fetch?: typeof fetch;
  resolver?: (hostname: string) => Promise<string[]>;
  requirePinnedImage?: boolean;
  maxLogBytes?: number;
  useWatch?: boolean;
  /** Hard deadline for one Kubernetes API or control-plane DNS operation. Default: 35 seconds. */
  requestTimeoutMs?: number;
  /** Maximum JSON response body accepted from the Kubernetes API. Default: 4 MiB. */
  maxApiResponseBytes?: number;
  /** Dispatcher graceful-close window before sockets are destroyed. Default: 1 second. */
  shutdownGraceMs?: number;
  /** Maximum time allowed to prove a deleted Job and all of its Pods are gone. */
  terminationTimeoutMs?: number;
}

interface KubernetesJobStatus {
  metadata?: { name?: string; uid?: string; labels?: Record<string, string> };
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: { type?: string; status?: string; message?: string }[];
  };
}

interface KubernetesSecretStatus {
  metadata?: { name?: string; uid?: string; labels?: Record<string, string> };
}

interface KubernetesPodList {
  items?: {
    metadata?: {
      name?: string;
      labels?: Record<string, string>;
      ownerReferences?: { apiVersion?: string; kind?: string; name?: string; uid?: string }[];
    };
  }[];
}

/**
 * The workload may be gone while its execution-scoped egress capability remains usable until TTL.
 * Treat that state as indeterminate and poison network admission instead of reporting success.
 */
export class KubernetesCredentialRevocationError extends Error {
  constructor() {
    super("Kubernetes runtime could not prove proxy credential revocation");
    this.name = "KubernetesCredentialRevocationError";
  }
}

type KubernetesEnvironmentVariable =
  | { name: string; value: string }
  | {
      name: string;
      valueFrom: { secretKeyRef: { name: string; key: string; optional: false } };
    };

export class KubernetesJobRuntime implements ExecutionRuntime {
  // KubernetesJobRuntime currently rejects request.stdin; the isolated-module adapter therefore
  // fails closed instead of pretending its bounded source/invocation protocol can be delivered.
  readonly toolModuleEnvironment = "unsupported" as const;
  private readonly namespace: string;
  private readonly apiServer: string;
  private readonly tokenFile: string;
  private readonly doFetch: typeof fetch;
  private readonly resolver: (hostname: string, signal?: AbortSignal) => Promise<string[]>;
  private readonly requestTimeoutMs: number;
  private readonly maxApiResponseBytes: number;
  private readonly shutdownGraceMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly dispatcher: UndiciAgent | undefined;
  private readonly activeOperations = new Set<AbortController>();
  private readonly activeRuns = new Map<AbortController, Promise<unknown>>();
  private accepting = true;
  private closed = false;
  private proofFailure: RuntimeTerminationError | undefined;
  private credentialRevocationFailure: KubernetesCredentialRevocationError | undefined;
  private shutdownTask: Promise<void> | undefined;
  constructor(private readonly options: KubernetesJobRuntimeOptions) {
    this.namespace = options.namespace ?? "anicode-runtime";
    this.apiServer = (options.apiServer ?? "https://kubernetes.default.svc").replace(/\/+$/, "");
    this.tokenFile = options.tokenFile ?? "/var/run/secrets/kubernetes.io/serviceaccount/token";
    if (options.proxyUrl) assertCredentialFreeProxyUrl(options.proxyUrl);
    if (options.fetch) {
      if (!process.env.NODE_TEST_CONTEXT) {
        throw new Error("Kubernetes custom fetch is restricted to the Node test runner");
      }
      this.doFetch = options.fetch;
    } else {
      if (!this.apiServer.startsWith("https://")) {
        throw new Error("Kubernetes API server must use HTTPS");
      }
      const ca = readFileSync(
        options.caFile ?? "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
      );
      const dispatcher = new UndiciAgent({
        connect: { ca },
        connections: 8,
        pipelining: 1,
      });
      this.dispatcher = dispatcher;
      this.doFetch = ((input, init) =>
        fetch(input, { ...init, dispatcher } as RequestInit)) as typeof fetch;
    }
    this.resolver =
      options.resolver ??
      (async (hostname) =>
        (await dns.lookup(hostname, { all: true })).map((entry) => entry.address));
    this.requestTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs,
      35_000,
      "requestTimeoutMs",
      5 * 60_000,
    );
    this.maxApiResponseBytes = boundedPositiveInteger(
      options.maxApiResponseBytes,
      4 * 1024 * 1024,
      "maxApiResponseBytes",
      64 * 1024 * 1024,
    );
    this.shutdownGraceMs = boundedPositiveInteger(
      options.shutdownGraceMs,
      1_000,
      "shutdownGraceMs",
      30_000,
    );
    this.terminationTimeoutMs = boundedPositiveInteger(
      options.terminationTimeoutMs,
      30_000,
      "terminationTimeoutMs",
      5 * 60_000,
    );
    if ((options.requirePinnedImage ?? true) && !options.image.includes("@sha256:")) {
      throw new Error("Kubernetes runtime image must be pinned by sha256 digest");
    }
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    if (!this.accepting) throw new Error("Kubernetes runtime is shut down");
    if (this.proofFailure) throw new RuntimeTerminationError();
    if (request.network && this.credentialRevocationFailure) {
      throw new KubernetesCredentialRevocationError();
    }
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) onCallerAbort();
    else request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    const running = this.runOwned({ ...request, signal: controller.signal });
    const settled = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    this.activeRuns.set(controller, settled);
    try {
      return await running;
    } catch (error) {
      if (error instanceof RuntimeTerminationError) {
        this.proofFailure ??= error;
      }
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", onCallerAbort);
      this.activeRuns.delete(controller);
    }
  }

  private async runOwned(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    if (request.stdin !== undefined) {
      throw new Error("Kubernetes Job execution does not support stdin payloads");
    }
    const started = Date.now();
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 120_000);
    if (request.network && !this.options.proxyUrl) {
      throw new Error("Network-enabled Kubernetes job requires the egress proxy");
    }
    if (request.network && !this.options.proxyCredentialIssuer) {
      throw new Error(
        "Network-enabled Kubernetes job requires an execution-scoped proxy credential",
      );
    }
    let proxyCredential: ScopedProxyCredentialLease | undefined;
    let encodedPinnedProxyCredential: string | undefined;
    const redact = (value: string) => {
      const redacted = proxyCredential?.redact(value) ?? value;
      return encodedPinnedProxyCredential
        ? redacted.split(encodedPinnedProxyCredential).join("[REDACTED]")
        : redacted;
    };
    let primaryFailure: unknown;
    let result: IsolatedRunResult | undefined;
    try {
      if (request.network && this.options.proxyCredentialIssuer) {
        const tenantId = request.workload?.tenantId;
        const executionId = request.workload?.executionId;
        if (!tenantId || !executionId) {
          throw new Error("Scoped proxy credentials require tenant and execution ownership");
        }
        proxyCredential = await this.options.proxyCredentialIssuer.issue({
          proxyUrl: this.options.proxyUrl!,
          tenantId,
          executionId,
          ttlMs: Math.min(16 * 60_000, timeoutMs + 30_000),
          ...(request.signal ? { signal: request.signal } : {}),
        });
      }
      const proxyUrl = request.network
        ? await this.pinnedProxyUrl(
            proxyCredential?.proxyUrl ?? this.options.proxyUrl!,
            request.signal,
          )
        : undefined;
      if (proxyCredential && proxyUrl) {
        encodedPinnedProxyCredential = Buffer.from(proxyUrl).toString("base64");
      }
      const relative = path.relative(
        path.resolve(this.options.hostWorkspaceRoot),
        path.resolve(request.cwd),
      );
      if (relative.startsWith("..") || path.isAbsolute(relative))
        throw new Error("Kubernetes cwd escapes workspace root");
      const [workspaceSubPath, ...cwdParts] = relative.split(path.sep).filter(Boolean);
      if (!workspaceSubPath || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceSubPath)) {
        throw new Error("Kubernetes execution requires a valid workspace id below workspace root");
      }
      const ephemeral = this.options.ephemeralWorkspace ?? true;
      if (request.policy === "workspace-write") {
        throw new Error(
          "Kubernetes workspace-write is disabled until a trusted control-plane patch committer is configured",
        );
      }
      const executionId = request.workload?.executionId;
      if (!executionId) {
        throw new Error("Kubernetes execution requires a stable workload.executionId");
      }
      const executionIdentity = `${request.workload?.tenantId ?? "default"}\0${executionId}`;
      const name = `anicode-${createHash("sha256").update(executionIdentity).digest("hex").slice(0, 40)}`;
      const ownerToken = createHash("sha256")
        .update(`owner\0${executionIdentity}`)
        .digest("hex")
        .slice(0, 32);
      const labels = {
        "app.kubernetes.io/name": "anicode-runner",
        "anicode.dev/owner-token": ownerToken,
        "anicode.dev/network": request.network ? "proxy" : "denied",
        ...(request.workload?.tenantId
          ? { "anicode.dev/tenant": labelHash(request.workload.tenantId) }
          : {}),
        ...(request.workload?.actor
          ? { "anicode.dev/actor": labelHash(request.workload.actor) }
          : {}),
        ...(request.workload?.executionId
          ? { "anicode.dev/execution": labelValue(request.workload.executionId) }
          : {}),
      };
      const proxySecretName = proxyCredential ? `${name}-proxy` : undefined;
      const reservedEnvironment = new Set([
        "ANICODE_JOB_COMMAND",
        "ANICODE_JOB_NETWORK",
        "ANICODE_JOB_RELATIVE_CWD",
        "ANICODE_JOB_SOURCE",
        "ANICODE_JOB_TIMEOUT_MS",
        "TMPDIR",
        "TRACEPARENT",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
      ]);
      const environment: KubernetesEnvironmentVariable[] = Object.entries(request.env ?? {})
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .filter(([name]) => !reservedEnvironment.has(name.toUpperCase()))
        .map(([name, value]) => ({ name, value }));
      if (request.network) {
        if (proxySecretName) {
          const secretKeyRef = {
            secretKeyRef: { name: proxySecretName, key: "proxy-url", optional: false as const },
          };
          environment.push(
            { name: "HTTP_PROXY", valueFrom: secretKeyRef },
            { name: "HTTPS_PROXY", valueFrom: secretKeyRef },
            { name: "ALL_PROXY", valueFrom: secretKeyRef },
            { name: "http_proxy", valueFrom: secretKeyRef },
            { name: "https_proxy", valueFrom: secretKeyRef },
            { name: "all_proxy", valueFrom: secretKeyRef },
            { name: "NO_PROXY", value: "" },
            { name: "no_proxy", value: "" },
          );
        } else {
          environment.push(
            { name: "HTTP_PROXY", value: proxyUrl! },
            { name: "HTTPS_PROXY", value: proxyUrl! },
            { name: "ALL_PROXY", value: proxyUrl! },
            { name: "http_proxy", value: proxyUrl! },
            { name: "https_proxy", value: proxyUrl! },
            { name: "all_proxy", value: proxyUrl! },
            { name: "NO_PROXY", value: "" },
            { name: "no_proxy", value: "" },
          );
        }
      }
      if (request.traceContext) {
        environment.push({ name: "TRACEPARENT", value: traceparent(request.traceContext) });
      }
      const body = {
        apiVersion: "batch/v1",
        kind: "Job",
        metadata: { name, namespace: this.namespace, labels },
        spec: {
          // Creation/recovery is intentionally inert. Only a UID-bound JSON Patch after the caller
          // is still live may activate Pods; retrying an ambiguous POST during cleanup can never
          // launch the user command.
          suspend: true,
          backoffLimit: 0,
          ttlSecondsAfterFinished: 300,
          activeDeadlineSeconds: Math.ceil(timeoutMs / 1_000),
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: "Never",
              automountServiceAccountToken: false,
              serviceAccountName: this.options.serviceAccount ?? "anicode-runner",
              securityContext: { runAsNonRoot: true, seccompProfile: { type: "RuntimeDefault" } },
              containers: [
                {
                  name: "runner",
                  image: this.options.image,
                  imagePullPolicy: "IfNotPresent",
                  command: ["/bin/sh", "-lc", request.command],
                  workingDir: path.posix.join("/workspace", cwdParts.join("/")),
                  env: environment,
                  securityContext: {
                    allowPrivilegeEscalation: false,
                    readOnlyRootFilesystem: true,
                    capabilities: { drop: ["ALL"] },
                  },
                  resources: {
                    requests: { cpu: "250m", memory: "256Mi" },
                    limits: { cpu: "2", memory: "2Gi" },
                  },
                  volumeMounts: [
                    {
                      name: "workspace",
                      mountPath: "/workspace",
                      readOnly: true,
                      ...(!ephemeral ? { subPath: workspaceSubPath } : {}),
                    },
                    { name: "tmp", mountPath: "/tmp" },
                  ],
                },
              ],
              ...(ephemeral
                ? {
                    initContainers: [
                      {
                        name: "workspace-copy",
                        image: this.options.image,
                        imagePullPolicy: "IfNotPresent",
                        command: ["/bin/sh", "-lc", "cp -a /source/. /workspace/"],
                        securityContext: {
                          allowPrivilegeEscalation: false,
                          readOnlyRootFilesystem: true,
                          capabilities: { drop: ["ALL"] },
                        },
                        resources: {
                          requests: { cpu: "100m", memory: "128Mi" },
                          limits: { cpu: "1", memory: "1Gi" },
                        },
                        volumeMounts: [
                          {
                            name: "workspace-source",
                            mountPath: "/source",
                            readOnly: true,
                            subPath: workspaceSubPath,
                          },
                          { name: "workspace", mountPath: "/workspace" },
                          { name: "tmp", mountPath: "/tmp" },
                        ],
                      },
                    ],
                  }
                : {}),
              volumes: [
                ...(ephemeral
                  ? [
                      {
                        name: "workspace-source",
                        persistentVolumeClaim: {
                          claimName: this.options.workspacePvc,
                          readOnly: true,
                        },
                      },
                      {
                        name: "workspace",
                        emptyDir: { sizeLimit: this.options.workspaceSizeLimit ?? "10Gi" },
                      },
                    ]
                  : [
                      {
                        name: "workspace",
                        persistentVolumeClaim: {
                          claimName: this.options.workspacePvc,
                          readOnly: true,
                        },
                      },
                    ]),
                { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
              ],
            },
          },
        },
      };
      let creationAttempted = false;
      let createdJobUid: string | undefined;
      let secretCreationAttempted = false;
      let createdSecretUid: string | undefined;
      let cleanupTask: Promise<void> | undefined;
      const cleanup = (): Promise<void> => {
        if (cleanupTask) return cleanupTask;
        cleanupTask = (async () => {
          let terminationFailure: unknown;
          if (creationAttempted) {
            try {
              await this.deleteJobAndProveTermination(name, ownerToken, createdJobUid);
            } catch (error) {
              terminationFailure = error;
            }
          }
          if (proxySecretName && secretCreationAttempted) {
            try {
              await this.deleteSecretAndProveTermination(
                proxySecretName,
                ownerToken,
                createdSecretUid,
              );
            } catch (error) {
              terminationFailure = terminationFailure
                ? new AggregateError([terminationFailure, error], "Kubernetes cleanup failed")
                : error;
            }
          }
          if (terminationFailure) throw new RuntimeTerminationError();
        })();
        return cleanupTask;
      };
      try {
        request.signal?.throwIfAborted();
        await this.reconcileExistingJob(name, ownerToken);
        request.signal?.throwIfAborted();
        if (proxySecretName) {
          await this.reconcileExistingSecret(proxySecretName, ownerToken);
          secretCreationAttempted = true;
          const createdSecret = await this.callJson<KubernetesSecretStatus>(
            `/api/v1/namespaces/${this.namespace}/secrets`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                apiVersion: "v1",
                kind: "Secret",
                metadata: {
                  name: proxySecretName,
                  namespace: this.namespace,
                  labels: { ...labels, "anicode.dev/owner-job": name },
                },
                immutable: true,
                type: "Opaque",
                data: { "proxy-url": Buffer.from(proxyUrl!).toString("base64") },
              }),
            },
          );
          createdSecretUid = validKubernetesUid(createdSecret.metadata?.uid);
          if (!createdSecretUid) {
            throw new Error("Kubernetes Secret creation response omitted metadata.uid");
          }
        }
        request.signal?.throwIfAborted();
        creationAttempted = true;
        // Do not couple Job creation to the caller's cancellation signal. An interrupted POST can
        // commit server-side without delivering its UID, making truthful cleanup impossible. The
        // API operation still has the runtime's hard control-plane deadline.
        let creation = await this.callJsonAllowConflict<KubernetesJobStatus>(
          `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (creation.kind === "conflict") {
          await this.reconcileExistingJob(name, ownerToken, true);
          creation = await this.callJsonAllowConflict<KubernetesJobStatus>(
            `/apis/batch/v1/namespaces/${this.namespace}/jobs`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
        }
        if (creation.kind !== "created") {
          throw new Error("Kubernetes Job name remained occupied after UID reconciliation");
        }
        const created = creation.value;
        createdJobUid = validKubernetesUid(created.metadata?.uid);
        if (!createdJobUid) {
          throw new Error("Kubernetes Job creation response omitted metadata.uid");
        }
        request.signal?.throwIfAborted();
        await this.callVoid(
          `/apis/batch/v1/namespaces/${this.namespace}/jobs/${encodeURIComponent(name)}`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json-patch+json" },
            body: JSON.stringify([
              { op: "test", path: "/metadata/uid", value: createdJobUid },
              {
                op: "test",
                path: "/metadata/labels/anicode.dev~1owner-token",
                value: ownerToken,
              },
              { op: "replace", path: "/spec/suspend", value: false },
            ]),
          },
        );
        request.signal?.throwIfAborted();
        const deadline = Date.now() + Math.max(1_000, request.timeoutMs ?? 120_000);
        const status = await this.waitForCompletion(name, deadline, request.signal);
        const timedOut = status === "timeout";
        const exitCode = status === "succeeded" ? 0 : status === "failed" ? 1 : null;
        const output = redact(await this.logs(name, request.signal).catch(() => ""));
        result = {
          exitCode,
          output,
          timedOut,
          sandboxed: true,
          durationMs: Date.now() - started,
        };
      } finally {
        await cleanup();
      }
    } catch (error) {
      if (error instanceof RuntimeTerminationError) {
        // Preserve the workload proof poison even if credential revocation also fails and the
        // caller-facing error must become an AggregateError below.
        this.proofFailure ??= error;
        primaryFailure = error;
      } else {
        const message = redact(error instanceof Error ? error.message : String(error));
        // Kubernetes/fetch errors can echo Secret request data. The original error must not
        // survive as `cause`, otherwise structured loggers could serialize the unredacted
        // capability.
        primaryFailure = new Error(message);
      }
    }

    let revocationFailure: KubernetesCredentialRevocationError | undefined;
    if (proxyCredential) {
      try {
        await proxyCredential.revoke();
      } catch {
        revocationFailure = new KubernetesCredentialRevocationError();
        this.credentialRevocationFailure ??= revocationFailure;
      }
    }
    if (primaryFailure && revocationFailure) {
      throw new AggregateError(
        [primaryFailure, revocationFailure],
        "Kubernetes execution failed and proxy credential revocation is indeterminate",
      );
    }
    if (revocationFailure) throw revocationFailure;
    if (primaryFailure) throw primaryFailure;
    if (!result) throw new Error("Kubernetes execution ended without a result");
    return result;
  }

  async healthCheck(): Promise<void> {
    if (!this.accepting) throw new Error("Kubernetes runtime is shut down");
    if (this.credentialRevocationFailure) throw new KubernetesCredentialRevocationError();
    await this.callVoid(`/apis/batch/v1/namespaces/${this.namespace}/jobs?limit=1`, {
      method: "GET",
    });
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.accepting = false;
    const reason = new Error("Kubernetes runtime is shutting down");
    for (const controller of this.activeRuns.keys()) controller.abort(reason);
    this.shutdownTask = this.shutdownNow();
    return this.shutdownTask;
  }

  private async shutdownNow(): Promise<void> {
    const runResults = await Promise.all([...this.activeRuns.values()]);
    const proofFailed =
      Boolean(this.proofFailure) ||
      runResults.some((result) => result instanceof RuntimeTerminationError);
    this.closed = true;
    const reason = new Error("Kubernetes runtime is shut down");
    for (const operation of this.activeOperations) operation.abort(reason);
    let dispatcherFailure: unknown;
    try {
      await this.closeDispatcher();
    } catch (error) {
      dispatcherFailure = error;
    }
    const failures: unknown[] = [];
    if (proofFailed) failures.push(new RuntimeTerminationError());
    if (this.credentialRevocationFailure) failures.push(this.credentialRevocationFailure);
    if (dispatcherFailure) failures.push(dispatcherFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Kubernetes runtime shutdown detected lifecycle failures");
    }
  }

  /** Runner 不获 DNS egress；控制面先解析集群代理并把短任务固定到一个 proxy Pod/IP。 */
  private async pinnedProxyUrl(value: string, signal?: AbortSignal): Promise<string> {
    const url = new URL(value);
    if (isIP(url.hostname)) return url.toString();
    const addresses = await this.withControlPlaneDeadline(
      `Kubernetes egress proxy DNS lookup for ${url.hostname}`,
      signal,
      (operationSignal) => this.resolver(url.hostname, operationSignal),
    );
    const address = addresses.find((candidate) => isIP(candidate));
    if (!address) throw new Error(`Egress proxy DNS returned no IP for ${url.hostname}`);
    url.hostname = isIP(address) === 6 ? `[${address}]` : address;
    return url.toString();
  }

  /**
   * A successful Kubernetes DELETE only means the API accepted deletion. Cancellation/timeout is
   * truthful only after the exact Job UID and every Pod owned by that UID have disappeared (or the
   * name has been replaced by a different UID). All calls use fresh control-plane deadlines and
   * deliberately ignore the already-aborted workload signal.
   */
  private async reconcileExistingJob(
    jobName: string,
    ownerToken: string,
    requireExisting = false,
  ): Promise<void> {
    const existing = await this.callOptionalJson<KubernetesJobStatus>(
      `/apis/batch/v1/namespaces/${this.namespace}/jobs/${encodeURIComponent(jobName)}`,
      { method: "GET" },
    );
    if (!existing) {
      if (requireExisting) throw new RuntimeTerminationError();
      return;
    }
    if (existing.metadata?.labels?.["anicode.dev/owner-token"] !== ownerToken) {
      throw new Error("Kubernetes execution name is occupied by a foreign ownership token");
    }
    const uid = validKubernetesUid(existing.metadata?.uid);
    if (!uid) throw new RuntimeTerminationError();
    await this.deleteJobAndProveTermination(jobName, ownerToken, uid);
  }

  private async deleteJobAndProveTermination(
    jobName: string,
    ownerToken: string,
    createdUid?: string,
  ): Promise<void> {
    const encodedName = encodeURIComponent(jobName);
    const jobPath = `/apis/batch/v1/namespaces/${this.namespace}/jobs/${encodedName}`;
    const podsPath = `/api/v1/namespaces/${this.namespace}/pods?labelSelector=job-name%3D${encodedName}`;
    const deadline = Date.now() + this.terminationTimeoutMs;
    let jobUid = createdUid;
    let lastDeleteAttempt = 0;

    while (Date.now() < deadline) {
      if (jobUid && lastDeleteAttempt === 0) {
        lastDeleteAttempt = Date.now();
        await this.callDeleteAllowMissing(jobPath, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            propagationPolicy: "Foreground",
            gracePeriodSeconds: 0,
            preconditions: { uid: jobUid },
          }),
        }).catch(() => undefined);
      }
      let job: KubernetesJobStatus | undefined;
      let pods: KubernetesPodList | undefined;
      try {
        [job, pods] = await Promise.all([
          this.callOptionalJson<KubernetesJobStatus>(jobPath, { method: "GET" }),
          this.callJson<KubernetesPodList>(podsPath, { method: "GET" }),
        ]);
      } catch {
        await terminationPollDelay(deadline, this.options.pollMs);
        continue;
      }

      const observedOwned = job?.metadata?.labels?.["anicode.dev/owner-token"] === ownerToken;
      const observedUid = observedOwned ? validKubernetesUid(job?.metadata?.uid) : undefined;
      if (job && observedOwned && !observedUid) {
        await terminationPollDelay(deadline, this.options.pollMs);
        continue;
      }
      if (!jobUid && observedUid) jobUid = observedUid;

      if (!jobUid && !job) {
        const inferred = podOwnerUids(pods, jobName, ownerToken);
        if (inferred.size === 1) jobUid = [...inferred][0];
      }

      const ownedPods = (pods.items ?? []).filter(
        (pod) => pod.metadata?.labels?.["anicode.dev/owner-token"] === ownerToken,
      );
      const originalJobExists = Boolean(jobUid && observedUid === jobUid);
      const originalPodsGone = jobUid
        ? ownedPods.every((pod) => {
            const owners = pod.metadata?.ownerReferences ?? [];
            return owners.length > 0 && owners.every((owner) => owner.uid !== jobUid);
          })
        : ownedPods.length === 0;
      if (jobUid && job && !observedOwned && originalPodsGone) return;
      // A timed-out create can still commit after an early 404. We only accept absence after an
      // immutable UID was recovered from a 201 response, GET, or ownerReference.
      if (jobUid && !originalJobExists && originalPodsGone) return;

      if (originalJobExists && jobUid && Date.now() - lastDeleteAttempt >= 250) {
        lastDeleteAttempt = Date.now();
        await this.callDeleteAllowMissing(jobPath, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            propagationPolicy: "Foreground",
            gracePeriodSeconds: 0,
            preconditions: { uid: jobUid },
          }),
        }).catch(() => undefined);
      }
      await terminationPollDelay(deadline, this.options.pollMs);
    }
    throw new RuntimeTerminationError();
  }

  private async reconcileExistingSecret(secretName: string, ownerToken: string): Promise<void> {
    const existing = await this.callOptionalJson<KubernetesSecretStatus>(
      `/api/v1/namespaces/${this.namespace}/secrets/${encodeURIComponent(secretName)}`,
      { method: "GET" },
    );
    if (!existing) return;
    if (existing.metadata?.labels?.["anicode.dev/owner-token"] !== ownerToken) {
      throw new Error("Kubernetes Secret name is occupied by a foreign ownership token");
    }
    const uid = validKubernetesUid(existing.metadata?.uid);
    if (!uid) throw new RuntimeTerminationError();
    await this.deleteSecretAndProveTermination(secretName, ownerToken, uid);
  }

  private async deleteSecretAndProveTermination(
    secretName: string,
    ownerToken: string,
    createdUid?: string,
  ): Promise<void> {
    const secretPath = `/api/v1/namespaces/${this.namespace}/secrets/${encodeURIComponent(secretName)}`;
    const deadline = Date.now() + this.terminationTimeoutMs;
    let secretUid = createdUid;
    let lastDeleteAttempt = 0;
    while (Date.now() < deadline) {
      let secret: KubernetesSecretStatus | undefined;
      try {
        secret = await this.callOptionalJson<KubernetesSecretStatus>(secretPath, { method: "GET" });
      } catch {
        await terminationPollDelay(deadline, this.options.pollMs);
        continue;
      }
      const owned = secret?.metadata?.labels?.["anicode.dev/owner-token"] === ownerToken;
      const observedUid = owned ? validKubernetesUid(secret?.metadata?.uid) : undefined;
      if (secret && owned && !observedUid) {
        await terminationPollDelay(deadline, this.options.pollMs);
        continue;
      }
      if (!secretUid && observedUid) secretUid = observedUid;
      if (secretUid && (!secret || observedUid !== secretUid)) return;
      if (secret && !owned) {
        if (secretUid) return;
        throw new RuntimeTerminationError();
      }
      if (secretUid && observedUid === secretUid && Date.now() - lastDeleteAttempt >= 250) {
        lastDeleteAttempt = Date.now();
        await this.callDeleteAllowMissing(secretPath, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            gracePeriodSeconds: 0,
            preconditions: { uid: secretUid },
          }),
        }).catch(() => undefined);
      }
      await terminationPollDelay(deadline, this.options.pollMs);
    }
    throw new RuntimeTerminationError();
  }

  private async logs(jobName: string, signal?: AbortSignal): Promise<string> {
    const pods = await this.callJson<{ items?: { metadata?: { name?: string } }[] }>(
      `/api/v1/namespaces/${this.namespace}/pods?labelSelector=job-name%3D${encodeURIComponent(jobName)}`,
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    const pod = pods.items?.[0]?.metadata?.name;
    if (!pod) return "";
    return this.callText(
      `/api/v1/namespaces/${this.namespace}/pods/${encodeURIComponent(pod)}/log?container=runner`,
      { method: "GET", ...(signal ? { signal } : {}) },
      Math.max(1_024, this.options.maxLogBytes ?? 1024 * 1024),
      true,
    );
  }

  private async waitForCompletion(
    name: string,
    deadline: number,
    signal?: AbortSignal,
  ): Promise<"succeeded" | "failed" | "timeout"> {
    if (this.options.useWatch ?? true) {
      while (Date.now() < deadline) {
        if (signal?.aborted) throw new Error("Kubernetes job cancelled");
        const remainingSeconds = Math.max(
          1,
          Math.min(30, Math.ceil((deadline - Date.now()) / 1_000)),
        );
        const text = await this.callText(
          `/apis/batch/v1/namespaces/${this.namespace}/jobs?watch=1&fieldSelector=${encodeURIComponent(
            `metadata.name=${name}`,
          )}&timeoutSeconds=${remainingSeconds}`,
          { method: "GET", ...(signal ? { signal } : {}) },
          1024 * 1024,
        );
        for (const line of text.split("\n").filter(Boolean)) {
          const event = JSON.parse(line) as { object?: KubernetesJobStatus } & KubernetesJobStatus;
          const job = event.object ?? event;
          if ((job.status?.succeeded ?? 0) > 0) return "succeeded";
          if ((job.status?.failed ?? 0) > 0) return "failed";
        }
      }
      return "timeout";
    }
    for (;;) {
      if (signal?.aborted) throw new Error("Kubernetes job cancelled");
      if (Date.now() >= deadline) return "timeout";
      const job = await this.callJson<KubernetesJobStatus>(
        `/apis/batch/v1/namespaces/${this.namespace}/jobs/${name}`,
        { method: "GET", ...(signal ? { signal } : {}) },
      );
      if ((job.status?.succeeded ?? 0) > 0) return "succeeded";
      if ((job.status?.failed ?? 0) > 0) return "failed";
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(100, this.options.pollMs ?? 500)),
      );
    }
  }

  private callJson<T>(suffix: string, init: RequestInit = { method: "GET" }): Promise<T> {
    return this.request(suffix, init, async (response) => {
      const text = await readBoundedText(response, this.maxApiResponseBytes);
      return JSON.parse(text) as T;
    });
  }

  private callOptionalJson<T>(
    suffix: string,
    init: RequestInit = { method: "GET" },
  ): Promise<T | undefined> {
    return this.request<T | undefined>(
      suffix,
      init,
      async (response) => {
        const text = await readBoundedText(response, this.maxApiResponseBytes);
        return JSON.parse(text) as T;
      },
      () => undefined,
    );
  }

  private callJsonAllowConflict<T>(
    suffix: string,
    init: RequestInit,
  ): Promise<{ kind: "created"; value: T } | { kind: "conflict" }> {
    return this.request<{ kind: "created"; value: T } | { kind: "conflict" }>(
      suffix,
      init,
      async (response) => ({
        kind: "created" as const,
        value: JSON.parse(await readBoundedText(response, this.maxApiResponseBytes)) as T,
      }),
      undefined,
      () => ({ kind: "conflict" as const }),
    );
  }

  private callText(
    suffix: string,
    init: RequestInit,
    limit: number,
    truncate = false,
  ): Promise<string> {
    return this.request(suffix, init, (response) =>
      truncate ? readLimitedText(response, limit) : readBoundedText(response, limit),
    );
  }

  private callVoid(suffix: string, init: RequestInit): Promise<void> {
    return this.request(suffix, init, async (response) => {
      await response.body?.cancel().catch(() => undefined);
    });
  }

  private callDeleteAllowMissing(suffix: string, init: RequestInit): Promise<void> {
    return this.request(
      suffix,
      init,
      async (response) => {
        await response.body?.cancel().catch(() => undefined);
      },
      () => undefined,
    );
  }

  private request<T>(
    suffix: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    notFound?: () => T,
    conflict?: () => T,
  ): Promise<T> {
    const method = String(init.method ?? "GET").toUpperCase();
    return this.withControlPlaneDeadline(
      `Kubernetes API ${method} ${suffix}`,
      init.signal ?? undefined,
      async (signal) => {
        const token = (await fs.readFile(this.tokenFile, "utf8")).trim();
        const headers = new Headers(init.headers);
        headers.set("authorization", `Bearer ${token}`);
        headers.set("accept", "application/json");
        const response = await this.doFetch(`${this.apiServer}${suffix}`, {
          ...init,
          headers,
          signal,
        });
        if (response.status === 404 && notFound) {
          await response.body?.cancel().catch(() => undefined);
          return notFound();
        }
        if (response.status === 409 && conflict) {
          await response.body?.cancel().catch(() => undefined);
          return conflict();
        }
        if (!response.ok) {
          const detail = await readLimitedText(response, 1_000).catch(() => "");
          throw new Error(`Kubernetes API HTTP ${response.status}: ${detail}`);
        }
        return consume(response);
      },
    );
  }

  private async withControlPlaneDeadline<T>(
    label: string,
    parent: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error("Kubernetes runtime is shut down");
    const controller = new AbortController();
    this.activeOperations.add(controller);
    let timedOut = false;
    const onParentAbort = () =>
      controller.abort(parent?.reason ?? new Error(`${label} was cancelled`));
    if (parent?.aborted) onParentAbort();
    else parent?.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`${label} timed out after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);
    // A non-cooperative control-plane transport may leave this as the only active handle. The
    // hard request deadline must remain enforceable until the caller-visible race settles.
    const aborted = new Promise<never>((_resolve, reject) => {
      const fail = () =>
        reject(
          controller.signal.reason instanceof Error
            ? controller.signal.reason
            : new Error(`${label} was cancelled`),
        );
      if (controller.signal.aborted) fail();
      else controller.signal.addEventListener("abort", fail, { once: true });
    });
    try {
      return await Promise.race([operation(controller.signal), aborted]);
    } catch (error) {
      if (timedOut) {
        throw new Error(`${label} timed out after ${this.requestTimeoutMs}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
      this.activeOperations.delete(controller);
    }
  }

  private async closeDispatcher(): Promise<void> {
    if (!this.dispatcher) return;
    const closing = this.dispatcher.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      const graceful = await Promise.race([
        closing.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), this.shutdownGraceMs);
          // Dispatcher shutdown is bounded even when close() itself exposes no active handles.
        }),
      ]);
      if (!graceful) await this.dispatcher.destroy();
    } catch (error) {
      await this.dispatcher.destroy().catch(() => undefined);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return candidate;
}

function assertCredentialFreeProxyUrl(value: string): void {
  const url = new URL(value);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  ) {
    throw new Error("Kubernetes proxy URL must be credential-free HTTP(S)");
  }
}

function labelHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function labelValue(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 63);
  return normalized && /^[A-Za-z0-9]/.test(normalized) ? normalized : labelHash(value);
}

function validKubernetesUid(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    ? value
    : undefined;
}

function podOwnerUids(pods: KubernetesPodList, jobName: string, ownerToken: string): Set<string> {
  const values = new Set<string>();
  for (const pod of pods.items ?? []) {
    if (pod.metadata?.labels?.["anicode.dev/owner-token"] !== ownerToken) continue;
    for (const owner of pod.metadata?.ownerReferences ?? []) {
      if (owner.kind !== "Job" || owner.name !== jobName) continue;
      const uid = validKubernetesUid(owner.uid);
      if (uid) values.add(uid);
    }
  }
  return values;
}

async function terminationPollDelay(deadline: number, configured?: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise((resolve) =>
    setTimeout(resolve, Math.min(remaining, Math.max(25, configured ?? 500))),
  );
}

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  let complete = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        break;
      }
      const remaining = limit - size;
      if (remaining > 0) {
        const value = Buffer.from(item.value);
        chunks.push(value.subarray(0, remaining));
        size += Math.min(value.byteLength, remaining);
      }
      if (item.value.byteLength > remaining) {
        truncated = true;
        break;
      }
    }
  } finally {
    if (!complete) await reader.cancel("response size limit reached").catch(() => undefined);
    reader.releaseLock();
  }
  return `${Buffer.concat(chunks).toString("utf8")}${truncated ? `\n[truncated at ${limit} bytes]` : ""}`;
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel("response size limit reached").catch(() => undefined);
    throw new Error(`Kubernetes API response exceeds ${limit} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  let complete = false;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) {
        complete = true;
        return Buffer.concat(chunks).toString("utf8");
      }
      size += item.value.byteLength;
      if (size > limit) throw new Error(`Kubernetes API response exceeds ${limit} bytes`);
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    if (!complete) await reader.cancel("response size limit reached").catch(() => undefined);
    reader.releaseLock();
  }
}
