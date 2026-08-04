/** 统一命令隔离执行边界：沙箱不可用时可 fail-close，输出/时限/环境均受控。 */

import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { CredentialBroker } from "../security/credentials.js";
import {
  resolveSandboxPolicy,
  resolveSandboxBinary,
  sensitiveHostReadPaths,
  sandboxHostReadBoundary,
  wrapWithSandbox,
  type SandboxPolicy,
} from "../tools/sandbox.js";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
import type { SpanContext } from "./telemetry.js";

export interface IsolatedRunRequest {
  command: string;
  cwd: string;
  /** Optional bounded stdin payload for trusted control-plane integrations such as command hooks. */
  stdin?: string;
  /** Internal callers may suppress the human PatchSet preview while retaining the atomic commit. */
  includeTransactionSummary?: boolean;
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
  /** 取消时先向整个 POSIX process group 发 TERM，随后升级为 KILL 的等待窗口。 */
  terminationGraceMs?: number;
}

/** 本地与远程执行后端的共同边界；远程后端不支持交互式/background prepare。 */
export interface ExecutionRuntime {
  run(request: IsolatedRunRequest): Promise<IsolatedRunResult>;
  prepare?(request: IsolatedRunRequest): PreparedIsolatedCommand;
  /** Drain runtime-owned process/journal reconciliation resources before host exit. */
  shutdown?(): Promise<void>;
  /**
   * Execute several evidence commands against one writable clone and discard the clone afterward.
   * The callback receives the non-transactional delegate so successful checks can never publish a
   * PatchSet back into the real workspace. Trusted control-plane code only.
   */
  withDiscardedWorkspace?<T>(
    cwd: string,
    signal: AbortSignal | undefined,
    callback: (runtime: ExecutionRuntime, stagedCwd: string) => Promise<T>,
  ): Promise<T>;
}

/**
 * Explicit fail-closed runtime for hosts without a supported process sandbox.
 *
 * Keeping this as an ExecutionRuntime (instead of passing `undefined`) is important: every
 * process-backed integration receives a concrete denial boundary and therefore cannot fall back
 * to its legacy raw-spawn path. It intentionally has no `prepare()` method, so persistent stdio
 * integrations such as hooks, MCP and LSP also fail closed before spawning a child process.
 */
export class DisabledExecutionRuntime implements ExecutionRuntime {
  constructor(
    private readonly reason = "Local process execution is disabled on this host. Configure the pinned OCI container backend to enable foreground commands.",
  ) {}

  async run(_request: IsolatedRunRequest): Promise<never> {
    throw new Error(this.reason);
  }
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
  private readonly terminationGraceMs: number;

  constructor(options: IsolatedRuntimeOptions = {}) {
    this.failClosed = options.failClosed ?? true;
    this.outputLimit = Math.max(1_000, options.outputLimitChars ?? 60_000);
    if (options.broker) this.broker = options.broker;
    if (options.proxyUrl) this.proxyUrl = options.proxyUrl;
    this.requireProxy = options.requireProxy ?? true;
    this.terminationGraceMs = Math.max(50, options.terminationGraceMs ?? 750);
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
    const readBoundary = sandboxHostReadBoundary();
    const wrapped = wrapWithSandbox(request.command, {
      policy,
      cwd,
      network: false,
      deniedReadPaths: sensitiveHostReadPaths(),
      hiddenReadRoots: readBoundary.hiddenReadRoots,
      readableRoots: readBoundary.readableRoots,
      ...(proxyEndpoint ? { networkProxy: proxyEndpoint } : {}),
      ...(policy === "workspace-write"
        ? { readOnlySubpaths: [path.join(cwd, ".git"), path.join(cwd, ".anicode")] }
        : {}),
    });
    let file = "/bin/bash";
    let args = ["-c", request.command];
    let sandboxed = false;
    const trustedSandboxBinary = wrapped ? resolveSandboxBinary(wrapped.file) : null;
    if (wrapped && trustedSandboxBinary) {
      file = trustedSandboxBinary;
      args = wrapped.args;
      sandboxed = true;
    } else if (policy !== "none" && this.failClosed) {
      throw new Error(`Sandbox policy ${policy} cannot be enforced on this host`);
    }

    let env = sanitizedShellEnv({ ...process.env, ...request.env });
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
    request.signal?.throwIfAborted();
    assertBoundedStdin(request.stdin);
    const prepared = this.prepare(request);

    const child = spawn(prepared.file, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      // A separate process group is the only reliable way to stop shell grandchildren on POSIX.
      // Windows uses taskkill /T below instead of pretending that child.kill() is tree-aware.
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      if (output.length < this.outputLimit) {
        output += chunk.toString().slice(0, this.outputLimit - output.length);
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    if (child.stdin) {
      child.stdin.on("error", () => {
        // A command may exit before consuming all input; close/exit remains authoritative.
      });
      child.stdin.end(request.stdin);
    }

    const close = childClose(child);
    let timedOut = false;
    let termination: Promise<void> | undefined;
    let rejectTermination!: (reason: unknown) => void;
    const terminationFailure = new Promise<never>((_resolve, reject) => {
      rejectTermination = reject;
    });
    const terminate = () => {
      if (termination) return;
      termination = terminateProcessTree(child, { graceMs: this.terminationGraceMs });
      // Race a bounded cleanup failure against `close`; otherwise a failed tree kill could leave
      // the caller waiting forever for a descendant that still owns the stdio pipes.
      void termination.catch(rejectTermination);
    };
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 120_000);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => terminate();
    request.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort may have happened after the pre-spawn check but before listener installation.
    // JavaScript abort dispatch is synchronous, so this closes the only remaining race window.
    if (request.signal?.aborted) onAbort();

    try {
      const exitCode = await Promise.race([close, terminationFailure]);
      if (!termination && process.platform !== "win32") terminate();
      await termination;
      return {
        exitCode,
        output: this.broker?.redact(output) ?? output,
        timedOut,
        sandboxed: prepared.sandboxed,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

const MAX_ISOLATED_STDIN_BYTES = 1024 * 1024;

export function assertBoundedStdin(value: string | undefined): void {
  if (value !== undefined && Buffer.byteLength(value, "utf8") > MAX_ISOLATED_STDIN_BYTES) {
    throw new Error(`Execution stdin exceeds ${MAX_ISOLATED_STDIN_BYTES} bytes`);
  }
}

export interface ProcessTreeTerminationOptions {
  graceMs?: number;
  killWaitMs?: number;
  platform?: NodeJS.Platform;
}

/**
 * Stop a spawned command and all descendants, then prove that the process boundary closed.
 *
 * POSIX children must have been spawned with `detached: true`, which makes their pid the process
 * group id. Windows has no equivalent signal contract, so the supported native implementation is
 * the OS tree primitive `taskkill /T /F`. This helper deliberately never falls back to killing only
 * the direct child: doing so would report cancellation while grandchildren keep mutating state.
 */
export async function terminateProcessTree(
  child: ChildProcess,
  options: ProcessTreeTerminationOptions = {},
): Promise<void> {
  const pid = child.pid;
  if (!pid) {
    if (isChildClosed(child)) return;
    throw new Error("Cannot terminate process tree before the child pid is available");
  }
  const graceMs = Math.max(50, options.graceMs ?? 750);
  const killWaitMs = Math.max(250, options.killWaitMs ?? 2_000);
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    await terminateWindowsProcessTree(child, pid, killWaitMs);
    return;
  }

  let signalError: unknown;
  try {
    signalProcessGroup(pid, "SIGTERM");
  } catch (error) {
    signalError = error;
  }
  const exitedAfterTerm = await waitForProcessGroupExit(pid, graceMs);
  if (!exitedAfterTerm) {
    try {
      signalProcessGroup(pid, "SIGKILL");
    } catch (error) {
      signalError ??= error;
    }
  }

  const [closed, groupExited] = await Promise.all([
    waitForChildClose(child, killWaitMs),
    waitForProcessGroupExit(pid, killWaitMs),
  ]);
  if (!closed || !groupExited) {
    const reason = signalError instanceof Error ? `: ${signalError.message}` : "";
    throw new Error(
      `Process tree ${pid} did not terminate cleanly (childClosed=${closed}, groupExited=${groupExited})${reason}`,
    );
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // EPERM still proves that the group exists; a later failed KILL is surfaced to the caller.
    return true;
  }
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await delay(Math.min(25, remaining));
  }
  return true;
}

async function terminateWindowsProcessTree(
  child: ChildProcess,
  pid: number,
  killWaitMs: number,
): Promise<void> {
  const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const killerClosed = await waitForChildClose(killer, killWaitMs);
  if (!killerClosed) {
    // This only stops the stuck taskkill helper; it is never used as a fallback for the target.
    killer.kill("SIGKILL");
    throw new Error(`taskkill did not finish while terminating process tree ${pid}`);
  }
  const targetClosed = await waitForChildClose(child, killWaitMs);
  if (!targetClosed) {
    throw new Error(`taskkill did not close process tree ${pid}`);
  }
  // Direct-child close alone cannot prove that descendants are gone. Only taskkill /T success is
  // a supported Windows tree-level proof; never silently downgrade after a non-zero taskkill.
  if (killer.exitCode !== 0) {
    throw new Error(`taskkill failed for process tree ${pid} with exit code ${killer.exitCode}`);
  }
}

function childClose(child: ChildProcess): Promise<number | null> {
  if (isChildClosed(child)) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
}

function isChildClosed(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (isChildClosed(child)) return true;
  return new Promise((resolve) => {
    const finish = (closed: boolean) => {
      clearTimeout(timer);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const onError = () => finish(false);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
