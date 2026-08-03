/** Kubernetes Job 执行后端：每条命令一个短生命周期 Pod，完成后删除。 */

import { createHash, randomUUID } from "node:crypto";
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
}

interface KubernetesJobStatus {
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: { type?: string; status?: string; message?: string }[];
  };
}

type KubernetesEnvironmentVariable =
  | { name: string; value: string }
  | {
      name: string;
      valueFrom: { secretKeyRef: { name: string; key: string; optional: false } };
    };

export class KubernetesJobRuntime implements ExecutionRuntime {
  private readonly namespace: string;
  private readonly apiServer: string;
  private readonly tokenFile: string;
  private readonly doFetch: typeof fetch;
  private readonly resolver: (hostname: string) => Promise<string[]>;
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
      const dispatcher = new UndiciAgent({ connect: { ca } });
      this.doFetch = ((input, init) =>
        fetch(input, { ...init, dispatcher } as RequestInit)) as typeof fetch;
    }
    this.resolver =
      options.resolver ??
      (async (hostname) =>
        (await dns.lookup(hostname, { all: true })).map((entry) => entry.address));
    if ((options.requirePinnedImage ?? true) && !options.image.includes("@sha256:")) {
      throw new Error("Kubernetes runtime image must be pinned by sha256 digest");
    }
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
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
        ? await this.pinnedProxyUrl(proxyCredential?.proxyUrl ?? this.options.proxyUrl!)
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
      const name = `anicode-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
      const labels = {
        "app.kubernetes.io/name": "anicode-runner",
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
            { name: "NO_PROXY", value: "" },
          );
        } else {
          environment.push(
            { name: "HTTP_PROXY", value: proxyUrl! },
            { name: "HTTPS_PROXY", value: proxyUrl! },
            { name: "ALL_PROXY", value: proxyUrl! },
            { name: "NO_PROXY", value: "" },
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
      const cleanup = async () => {
        const removals: Promise<unknown>[] = [
          this.call(`/apis/batch/v1/namespaces/${this.namespace}/jobs/${name}`, {
            method: "DELETE",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ propagationPolicy: "Foreground", gracePeriodSeconds: 0 }),
          }).catch(() => undefined),
        ];
        if (proxySecretName) {
          removals.push(
            this.call(
              `/api/v1/namespaces/${this.namespace}/secrets/${encodeURIComponent(proxySecretName)}`,
              {
                method: "DELETE",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ gracePeriodSeconds: 0 }),
              },
            ).catch(() => undefined),
          );
        }
        await Promise.all(removals);
      };
      const onAbort = () => void cleanup();
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        request.signal?.throwIfAborted();
        if (proxySecretName) {
          await this.call(`/api/v1/namespaces/${this.namespace}/secrets`, {
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
            ...(request.signal ? { signal: request.signal } : {}),
          });
        }
        request.signal?.throwIfAborted();
        await this.call(`/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(request.signal ? { signal: request.signal } : {}),
        });
        const deadline = Date.now() + Math.max(1_000, request.timeoutMs ?? 120_000);
        const status = await this.waitForCompletion(name, deadline, request.signal);
        const timedOut = status === "timeout";
        const exitCode = status === "succeeded" ? 0 : status === "failed" ? 1 : null;
        const output = redact(await this.logs(name).catch(() => ""));
        return {
          exitCode,
          output,
          timedOut,
          sandboxed: true,
          durationMs: Date.now() - started,
        };
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
        await cleanup();
      }
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      // Kubernetes/fetch errors can echo Secret request data. The original error must not survive
      // as `cause`, otherwise structured loggers could serialize the unredacted capability.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    } finally {
      await proxyCredential?.revoke().catch(() => undefined);
    }
  }

  async healthCheck(): Promise<void> {
    await this.call(`/apis/batch/v1/namespaces/${this.namespace}/jobs?limit=1`, {
      method: "GET",
    });
  }

  /** Runner 不获 DNS egress；控制面先解析集群代理并把短任务固定到一个 proxy Pod/IP。 */
  private async pinnedProxyUrl(value: string): Promise<string> {
    const url = new URL(value);
    if (isIP(url.hostname)) return url.toString();
    const addresses = await this.resolver(url.hostname);
    const address = addresses.find((candidate) => isIP(candidate));
    if (!address) throw new Error(`Egress proxy DNS returned no IP for ${url.hostname}`);
    url.hostname = isIP(address) === 6 ? `[${address}]` : address;
    return url.toString();
  }

  private async logs(jobName: string): Promise<string> {
    const pods = await this.callJson<{ items?: { metadata?: { name?: string } }[] }>(
      `/api/v1/namespaces/${this.namespace}/pods?labelSelector=job-name%3D${encodeURIComponent(jobName)}`,
    );
    const pod = pods.items?.[0]?.metadata?.name;
    if (!pod) return "";
    const response = await this.call(
      `/api/v1/namespaces/${this.namespace}/pods/${encodeURIComponent(pod)}/log?container=runner`,
      { method: "GET" },
    );
    return readLimitedText(response, Math.max(1_024, this.options.maxLogBytes ?? 1024 * 1024));
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
        const response = await this.call(
          `/apis/batch/v1/namespaces/${this.namespace}/jobs?watch=1&fieldSelector=${encodeURIComponent(
            `metadata.name=${name}`,
          )}&timeoutSeconds=${remainingSeconds}`,
          { method: "GET", ...(signal ? { signal } : {}) },
        );
        const text = await readLimitedText(response, 1024 * 1024);
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
      );
      if ((job.status?.succeeded ?? 0) > 0) return "succeeded";
      if ((job.status?.failed ?? 0) > 0) return "failed";
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(100, this.options.pollMs ?? 500)),
      );
    }
  }

  private async callJson<T>(suffix: string): Promise<T> {
    const response = await this.call(suffix, { method: "GET" });
    return (await response.json()) as T;
  }

  private async call(suffix: string, init: RequestInit): Promise<Response> {
    const token = (await fs.readFile(this.tokenFile, "utf8")).trim();
    const response = await this.doFetch(`${this.apiServer}${suffix}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...init.headers },
    });
    if (!response.ok) {
      throw new Error(
        `Kubernetes API HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`,
      );
    }
    return response;
  }
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

async function readLimitedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const item = await reader.read();
    if (item.done) break;
    const remaining = limit - size;
    if (remaining > 0) {
      const value = Buffer.from(item.value);
      chunks.push(value.subarray(0, remaining));
      size += Math.min(value.byteLength, remaining);
    }
    if (item.value.byteLength > remaining) {
      truncated = true;
      await reader.cancel("response size limit reached");
      break;
    }
  }
  return `${Buffer.concat(chunks).toString("utf8")}${truncated ? `\n[truncated at ${limit} bytes]` : ""}`;
}
