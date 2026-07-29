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

export interface ContainerIsolatedRuntimeOptions {
  image: string;
  engine?: "docker" | "podman";
  broker?: CredentialBroker;
  /** 必须是 docker/podman 的 --internal network。 */
  internalNetwork?: string;
  /** internal network 内的出口代理，例如 http://egress-proxy:3128。 */
  proxyUrl?: string;
  memory?: string;
  cpus?: number;
  pidsLimit?: number;
  outputLimitChars?: number;
  requirePinnedImage?: boolean;
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
  private networkChecked = false;

  constructor(private readonly options: ContainerIsolatedRuntimeOptions) {
    this.engine = options.engine ?? "docker";
    this.outputLimit = Math.max(1_000, options.outputLimitChars ?? 60_000);
    if (options.broker) this.broker = options.broker;
    if ((options.requirePinnedImage ?? true) && !options.image.includes("@sha256:")) {
      throw new Error("Container runtime image must be pinned by sha256 digest");
    }
  }

  private async verifyInternalNetwork(): Promise<void> {
    if (this.networkChecked) return;
    const network = safeName(this.options.internalNetwork ?? "", "container network");
    const result = await runProcess(
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
    const cwd = canonical(request.cwd);
    const network = request.network ?? false;
    if (network) {
      if (!this.options.internalNetwork || !this.options.proxyUrl) {
        throw new Error("Container network access requires an internal network and egress proxy");
      }
      await this.verifyInternalNetwork();
    }

    let containerEnv: NodeJS.ProcessEnv = { ...sanitizedShellEnv(), ...request.env };
    for (const lease of request.credentialLeases ?? []) {
      if (!this.broker) throw new Error("No credential broker configured");
      containerEnv = this.broker.injectEnv(lease, containerEnv);
    }
    if (network) {
      containerEnv.HTTP_PROXY = this.options.proxyUrl;
      containerEnv.HTTPS_PROXY = this.options.proxyUrl;
      containerEnv.ALL_PROXY = this.options.proxyUrl;
      containerEnv.NO_PROXY = "";
    } else {
      delete containerEnv.HTTP_PROXY;
      delete containerEnv.HTTPS_PROXY;
      delete containerEnv.ALL_PROXY;
      delete containerEnv.NO_PROXY;
    }

    const name = `anicode-${process.pid}-${randomUUID().slice(0, 12)}`;
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
      `type=bind,src=${cwd},dst=/workspace,rw`,
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

    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 120_000);
    const onAbort = () => {
      void runProcess(
        this.engine,
        ["rm", "--force", name],
        sanitizedShellEnv(),
        10_000,
        2_000,
      ).catch(() => undefined);
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await runProcess(this.engine, args, containerEnv, timeoutMs, this.outputLimit);
      return {
        exitCode: result.exitCode,
        output: this.broker?.redact(result.output) ?? result.output,
        timedOut: result.timedOut,
        sandboxed: true,
        durationMs: Date.now() - started,
      };
    } finally {
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function runProcess(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
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
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, output, timedOut });
    });
  });
}
