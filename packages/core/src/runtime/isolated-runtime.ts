/** 统一命令隔离执行边界：沙箱不可用时可 fail-close，输出/时限/环境均受控。 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { CredentialBroker } from "../security/credentials.js";
import {
  resolveSandboxPolicy,
  sandboxBinaryAvailable,
  wrapWithSandbox,
  type SandboxPolicy,
} from "../tools/sandbox.js";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
import type { SpanContext } from "./telemetry.js";

export interface IsolatedRunRequest {
  command: string;
  cwd: string;
  policy?: SandboxPolicy;
  network?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  credentialLeases?: string[];
  traceContext?: SpanContext;
  /** 可信控制面元数据；用于 runtime ownership label，不注入命令环境。 */
  workload?: { tenantId?: string; actor?: string; executionId?: string; fencingToken?: number };
}

export interface IsolatedRunResult {
  exitCode: number | null;
  output: string;
  timedOut: boolean;
  sandboxed: boolean;
  durationMs: number;
}

export interface PreparedIsolatedCommand {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  sandboxed: boolean;
  cwd: string;
}

export interface IsolatedRuntimeOptions {
  failClosed?: boolean;
  outputLimitChars?: number;
  broker?: CredentialBroker;
  proxyUrl?: string;
  /** network=true 时没有代理就拒绝；默认 true，杜绝静默直连。 */
  requireProxy?: boolean;
}

/** 本地与远程执行后端的共同边界；远程后端不支持交互式/background prepare。 */
export interface ExecutionRuntime {
  run(request: IsolatedRunRequest): Promise<IsolatedRunResult>;
  prepare?(request: IsolatedRunRequest): PreparedIsolatedCommand;
}

function canonical(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

export class IsolatedRuntime implements ExecutionRuntime {
  private readonly failClosed: boolean;
  private readonly outputLimit: number;
  private readonly broker?: CredentialBroker;
  private readonly proxyUrl?: string;
  private readonly requireProxy: boolean;

  constructor(options: IsolatedRuntimeOptions = {}) {
    this.failClosed = options.failClosed ?? true;
    this.outputLimit = Math.max(1_000, options.outputLimitChars ?? 60_000);
    if (options.broker) this.broker = options.broker;
    if (options.proxyUrl) this.proxyUrl = options.proxyUrl;
    this.requireProxy = options.requireProxy ?? true;
  }

  prepare(request: IsolatedRunRequest): PreparedIsolatedCommand {
    const cwd = canonical(request.cwd);
    const policy = resolveSandboxPolicy(request.policy);
    // 默认断网。只有工具调用显式 network=true 才打开网络，而且默认必须经代理。
    const network = request.network ?? false;
    if (network && this.requireProxy && !this.proxyUrl) {
      throw new Error("Network access requires the configured AniCode proxy");
    }
    const proxyEndpoint = network && this.proxyUrl ? parseProxyEndpoint(this.proxyUrl) : undefined;
    if (network && process.platform === "linux") {
      throw new Error(
        "Network-enabled Linux execution requires ContainerIsolatedRuntime with an internal egress network",
      );
    }
    const wrapped = wrapWithSandbox(request.command, {
      policy,
      cwd,
      network: false,
      ...(proxyEndpoint ? { networkProxy: proxyEndpoint } : {}),
      ...(policy === "workspace-write"
        ? { readOnlySubpaths: [path.join(cwd, ".git"), path.join(cwd, ".anicode")] }
        : {}),
    });
    let file = "/bin/bash";
    let args = ["-c", request.command];
    let sandboxed = false;
    if (wrapped && sandboxBinaryAvailable(wrapped.file)) {
      file = wrapped.file;
      args = wrapped.args;
      sandboxed = true;
    } else if (policy !== "none" && this.failClosed) {
      throw new Error(`Sandbox policy ${policy} cannot be enforced on this host`);
    }

    let env = { ...sanitizedShellEnv(), ...request.env };
    for (const lease of request.credentialLeases ?? []) {
      if (!this.broker) throw new Error("No credential broker configured");
      env = this.broker.injectEnv(lease, env);
    }
    if (network && this.proxyUrl) {
      env["HTTP_PROXY"] = this.proxyUrl;
      env["HTTPS_PROXY"] = this.proxyUrl;
      env["NO_PROXY"] = "";
    }
    return { file, args, env, sandboxed, cwd };
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    const started = Date.now();
    const prepared = this.prepare(request);

    return new Promise((resolve, reject) => {
      const child = spawn(prepared.file, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      const capture = (chunk: Buffer) => {
        if (output.length < this.outputLimit) {
          output += chunk.toString().slice(0, this.outputLimit - output.length);
        }
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      let timedOut = false;
      const timeoutMs = Math.max(1_000, request.timeoutMs ?? 120_000);
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      const onAbort = () => child.kill("SIGKILL");
      request.signal?.addEventListener("abort", onAbort, { once: true });
      child.on("error", reject);
      child.on("close", (exitCode) => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode,
          output: this.broker?.redact(output) ?? output,
          timedOut,
          sandboxed: prepared.sandboxed,
          durationMs: Date.now() - started,
        });
      });
    });
  }
}

function parseProxyEndpoint(value: string): { host: string; port: number } {
  const url = new URL(value);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0) throw new Error("Invalid AniCode proxy port");
  if (!/^(?:127(?:\.\d{1,3}){3}|::1|localhost)$/.test(url.hostname)) {
    throw new Error("OS sandbox proxy must be loopback; use ContainerIsolatedRuntime otherwise");
  }
  return { host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname, port };
}
