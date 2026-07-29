/** Kubernetes Job 执行后端：每条命令一个短生命周期 Pod，完成后删除。 */

import { randomUUID } from "node:crypto";
import { promises as dns } from "node:dns";
import { promises as fs } from "node:fs";
import { isIP } from "node:net";
import * as path from "node:path";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
} from "./isolated-runtime.js";

export interface KubernetesJobRuntimeOptions {
  image: string;
  namespace?: string;
  apiServer?: string;
  tokenFile?: string;
  workspacePvc: string;
  hostWorkspaceRoot: string;
  /** 默认把 PVC 中的 workspace 复制到每个 Job 独享的 emptyDir，任务结束即销毁。 */
  ephemeralWorkspace?: boolean;
  workspaceSizeLimit?: string;
  proxyUrl?: string;
  serviceAccount?: string;
  pollMs?: number;
  fetch?: typeof fetch;
  resolver?: (hostname: string) => Promise<string[]>;
  requirePinnedImage?: boolean;
}

interface KubernetesJobStatus {
  status?: {
    succeeded?: number;
    failed?: number;
    conditions?: { type?: string; status?: string; message?: string }[];
  };
}

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
    this.doFetch = options.fetch ?? fetch;
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
    if (request.network && !this.options.proxyUrl) {
      throw new Error("Network-enabled Kubernetes job requires the egress proxy");
    }
    const proxyUrl = request.network
      ? await this.pinnedProxyUrl(this.options.proxyUrl!)
      : undefined;
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
    const name = `anicode-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const labels = {
      "app.kubernetes.io/name": "anicode-runner",
      "anicode.dev/network": request.network ? "proxy" : "denied",
    };
    const environment = Object.entries(request.env ?? {})
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, value]) => ({ name, value }));
    if (request.network) {
      environment.push(
        { name: "HTTP_PROXY", value: proxyUrl! },
        { name: "HTTPS_PROXY", value: proxyUrl! },
        { name: "ALL_PROXY", value: proxyUrl! },
        { name: "NO_PROXY", value: "" },
      );
    }
    const body = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, namespace: this.namespace, labels },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 300,
        activeDeadlineSeconds: Math.ceil(Math.max(1_000, request.timeoutMs ?? 120_000) / 1_000),
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
                  { name: "workspace", mountPath: "/workspace" },
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
                      persistentVolumeClaim: { claimName: this.options.workspacePvc },
                    },
                  ]),
              { name: "tmp", emptyDir: { sizeLimit: "512Mi" } },
            ],
          },
        },
      },
    };
    await this.call(`/apis/batch/v1/namespaces/${this.namespace}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const cleanup = () =>
      this.call(`/apis/batch/v1/namespaces/${this.namespace}/jobs/${name}`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ propagationPolicy: "Foreground", gracePeriodSeconds: 0 }),
      }).catch(() => undefined);
    const onAbort = () => void cleanup();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    let exitCode: number | null = null;
    let output = "";
    try {
      const deadline = Date.now() + Math.max(1_000, request.timeoutMs ?? 120_000);
      for (;;) {
        if (request.signal?.aborted) throw new Error("Kubernetes job cancelled");
        if (Date.now() >= deadline) {
          timedOut = true;
          break;
        }
        const job = await this.callJson<KubernetesJobStatus>(
          `/apis/batch/v1/namespaces/${this.namespace}/jobs/${name}`,
        );
        if ((job.status?.succeeded ?? 0) > 0) {
          exitCode = 0;
          break;
        }
        if ((job.status?.failed ?? 0) > 0) {
          exitCode = 1;
          break;
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(100, this.options.pollMs ?? 500)),
        );
      }
      output = await this.logs(name).catch(() => "");
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
    return response.text();
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
