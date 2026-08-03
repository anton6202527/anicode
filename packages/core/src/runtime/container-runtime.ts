/** OCI 容器执行边界：只读根、最小 capabilities、资源上限和 internal-only 网络。 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import * as path from "node:path";
import type { CredentialBroker } from "../security/credentials.js";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
} from "./isolated-runtime.js";
import type { ScopedProxyCredentialIssuer, ScopedProxyCredentialLease } from "./network-proxy.js";

export interface ContainerProcessResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export type ContainerProcessRunner = (
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  signal?: AbortSignal,
) => Promise<ContainerProcessResult>;

export interface ContainerIsolatedRuntimeOptions {
  image: string;
  engine?: "docker" | "podman";
  broker?: CredentialBroker;
  /** 必须是 docker/podman 的 --internal network。 */
  internalNetwork?: string;
  /** internal network 内的出口代理，例如 http://egress-proxy:3128。 */
  proxyUrl?: string;
  /** Trusted control-plane issuer. Remote jobs receive a unique short-lived proxy capability. */
  proxyCredentialIssuer?: ScopedProxyCredentialIssuer;
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  outputLimitChars?: number;
  requirePinnedImage?: boolean;
  /** Test/embedding seam; production uses the local OCI CLI runner. */
  processRunner?: ContainerProcessRunner;
}

function safeName(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function canonical(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

export class ContainerIsolatedRuntime implements ExecutionRuntime {
  private readonly engine: "docker" | "podman";
  private readonly outputLimit: number;
  private readonly broker?: CredentialBroker;
  private readonly processRunner: ContainerProcessRunner;
  private networkChecked = false;

  constructor(private readonly options: ContainerIsolatedRuntimeOptions) {
    this.engine = options.engine ?? "docker";
    this.outputLimit = Math.max(1_000, options.outputLimitChars ?? 60_000);
    this.processRunner = options.processRunner ?? runProcess;
    if (options.broker) this.broker = options.broker;
    if (options.proxyUrl) assertCredentialFreeProxyUrl(options.proxyUrl);
    if ((options.requirePinnedImage ?? true) && !options.image.includes("@sha256:")) {
      throw new Error("Container runtime image must be pinned by sha256 digest");
    }
  }

  private async verifyInternalNetwork(): Promise<void> {
    if (this.networkChecked) return;
    const network = safeName(this.options.internalNetwork ?? "", "container network");
    const result = await this.processRunner(
      this.engine,
      ["network", "inspect", "--format", "{{.Internal}}", network],
      sanitizedShellEnv(),
      10_000,
      4_000,
    );
    if (result.exitCode !== 0 || result.output.trim() !== "true") {
      throw new Error(`Container network ${network} must exist and be --internal`);
    }
    this.networkChecked = true;
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    const started = Date.now();
    request.signal?.throwIfAborted();
    const cwd = canonical(request.cwd);
    const network = request.network ?? false;
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 120_000);
    if (network) {
      if (!this.options.internalNetwork || !this.options.proxyUrl) {
        throw new Error("Container network access requires an internal network and egress proxy");
      }
      if (!this.options.proxyCredentialIssuer) {
        throw new Error("Container network access requires an execution-scoped proxy credential");
      }
      await this.verifyInternalNetwork();
    }

    let proxyCredential: ScopedProxyCredentialLease | undefined;
    if (network && this.options.proxyCredentialIssuer) {
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
    const redact = (value: string) =>
      this.broker?.redact(proxyCredential?.redact(value) ?? value) ??
      proxyCredential?.redact(value) ??
      value;

    const name = `anicode-${process.pid}-${randomUUID().slice(0, 12)}`;
    try {
      let containerEnv: NodeJS.ProcessEnv = { ...sanitizedShellEnv(), ...request.env };
      for (const lease of request.credentialLeases ?? []) {
        if (!this.broker) throw new Error("No credential broker configured");
        containerEnv = this.broker.injectEnv(lease, containerEnv);
      }
      if (network) {
        const effectiveProxyUrl = proxyCredential?.proxyUrl ?? this.options.proxyUrl!;
        containerEnv.HTTP_PROXY = effectiveProxyUrl;
        containerEnv.HTTPS_PROXY = effectiveProxyUrl;
        containerEnv.ALL_PROXY = effectiveProxyUrl;
        containerEnv.NO_PROXY = "";
      } else {
        delete containerEnv.HTTP_PROXY;
        delete containerEnv.HTTPS_PROXY;
        delete containerEnv.ALL_PROXY;
        delete containerEnv.NO_PROXY;
      }

      const args = [
        "run",
        "--rm",
        "--name",
        name,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit",
        String(Math.max(16, this.options.pidsLimit ?? 256)),
        "--memory",
        this.options.memory ?? "2g",
        "--cpus",
        String(Math.max(0.1, this.options.cpus ?? 2)),
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,nodev,size=512m",
        "--workdir",
        "/workspace",
        "--mount",
        containerWorkspaceMount(cwd, request.policy),
        "--network",
        network ? safeName(this.options.internalNetwork!, "container network") : "none",
      ];
      if (typeof process.getuid === "function" && typeof process.getgid === "function") {
        args.push("--user", `${process.getuid()}:${process.getgid()}`);
      }
      for (const protectedPath of [".git", ".anicode"]) {
        const source = path.join(cwd, protectedPath);
        if (existsSync(source)) {
          args.push("--mount", `type=bind,src=${source},dst=/workspace/${protectedPath},readonly`);
        }
      }
      for (const key of Object.keys(containerEnv).sort()) args.push("--env", key);
      args.push(this.options.image, "/bin/sh", "-lc", request.command);

      const result = await this.processRunner(
        this.engine,
        args,
        containerEnv,
        timeoutMs,
        this.outputLimit,
        request.signal,
      );
      return {
        exitCode: result.exitCode,
        output: redact(result.output),
        timedOut: result.timedOut,
        sandboxed: true,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      const message = redact(error instanceof Error ? error.message : String(error));
      // The original error can contain the injected capability in env/argv diagnostics. Keeping it
      // as `cause` would bypass the redaction boundary.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(message);
    } finally {
      // `docker run --rm` normally removes the container itself. Timeout, abort, daemon errors and
      // a killed Docker CLI can leave it running, so every exit path performs an awaited cleanup.
      await this.processRunner(
        this.engine,
        ["rm", "--force", name],
        sanitizedShellEnv(),
        10_000,
        2_000,
      ).catch(() => undefined);
      await proxyCredential?.revoke().catch(() => undefined);
    }
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
    throw new Error("Container proxy URL must be credential-free HTTP(S)");
  }
}

export function containerWorkspaceMount(cwd: string, policy: IsolatedRunRequest["policy"]): string {
  const access = policy === "workspace-write" ? "rw" : "readonly";
  return `type=bind,src=${cwd},dst=/workspace,${access}`;
}

async function runProcess(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  signal?: AbortSignal,
): Promise<ContainerProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Container execution aborted"));
      return;
    }
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const capture = (chunk: Buffer) => {
      if (output.length < outputLimit) {
        output += chunk.toString().slice(0, outputLimit - output.length);
      }
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    const onAbort = () => child.kill("SIGKILL");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, output, timedOut });
    });
  });
}
