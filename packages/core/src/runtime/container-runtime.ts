/** OCI 容器执行边界：只读根、最小 capabilities、资源上限和 internal-only 网络。 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, realpathSync, promises as fs } from "node:fs";
import * as path from "node:path";
import type { CredentialBroker } from "../security/credentials.js";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
} from "./isolated-runtime.js";
import { assertBoundedStdin, terminateProcessTree } from "./isolated-runtime.js";
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
  stdin?: string,
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
  /** Trusted Docker/Podman CLI control-plane environment; never forwarded with container --env. */
  controlEnvironment?: NodeJS.ProcessEnv;
  /** Durable bounded journal used to reconcile containers after host/daemon crashes. */
  orphanJournalPath?: string;
  orphanJournalLimit?: number;
  /** `false` disables periodic replay (tests); production defaults to one minute. */
  orphanReconcileIntervalMs?: number | false;
}

interface ContainerOrphanRecord {
  name: string;
  engine: "docker" | "podman";
  startedAt: string;
  tenantId?: string;
  actor?: string;
  executionId?: string;
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

const CONTAINER_ENGINE_CONTROL_ENV = [
  "HOME",
  "USERPROFILE",
  "DOCKER_CONFIG",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINERS_CONF",
  "REGISTRY_AUTH_FILE",
  "XDG_RUNTIME_DIR",
  "SSH_AUTH_SOCK",
] as const;

/**
 * Docker/Podman is trusted control-plane code and may need its context, registry auth and socket.
 * Workload variables are merged only so `docker --env KEY` can source their values; control-plane
 * keys are never added to that argv list by the caller.
 */
export function containerEngineEnvironment(
  workload: NodeJS.ProcessEnv = {},
  control: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...sanitizedShellEnv(control), ...workload };
  for (const key of CONTAINER_ENGINE_CONTROL_ENV) {
    const value = control[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export class ContainerIsolatedRuntime implements ExecutionRuntime {
  private readonly engine: "docker" | "podman";
  private readonly outputLimit: number;
  private readonly broker?: CredentialBroker;
  private readonly processRunner: ContainerProcessRunner;
  private readonly controlEnvironment: NodeJS.ProcessEnv;
  private networkChecked = false;
  private readonly orphanJournal?: ContainerOrphanJournal;
  private readonly activeContainers = new Set<string>();
  private reconciliationTail: Promise<void> = Promise.resolve();
  private reconciliationTimer: NodeJS.Timeout | undefined;

  constructor(private readonly options: ContainerIsolatedRuntimeOptions) {
    this.engine = options.engine ?? "docker";
    this.outputLimit = Math.max(1_000, options.outputLimitChars ?? 60_000);
    this.processRunner = options.processRunner ?? runContainerCliProcess;
    this.controlEnvironment = options.controlEnvironment ?? process.env;
    if (options.broker) this.broker = options.broker;
    if (options.proxyUrl) assertCredentialFreeProxyUrl(options.proxyUrl);
    if ((options.requirePinnedImage ?? true) && !options.image.includes("@sha256:")) {
      throw new Error("Container runtime image must be pinned by sha256 digest");
    }
    if (options.orphanJournalPath) {
      this.orphanJournal = new ContainerOrphanJournal(
        options.orphanJournalPath,
        options.orphanJournalLimit,
      );
      void this.reconcileOrphans().catch(() => undefined);
      if (options.orphanReconcileIntervalMs !== false) {
        const intervalMs = Math.max(1_000, options.orphanReconcileIntervalMs ?? 60_000);
        this.reconciliationTimer = setInterval(
          () => void this.reconcileOrphans().catch(() => undefined),
          intervalMs,
        );
        this.reconciliationTimer.unref?.();
      }
    }
  }

  /** Startup/periodic/operator replay. A failed proof keeps the record and rejects fail-closed. */
  reconcileOrphans(): Promise<void> {
    const task = this.reconciliationTail.then(() => this.reconcileOrphansNow());
    this.reconciliationTail = task.catch(() => undefined);
    return task;
  }

  async shutdown(): Promise<void> {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = undefined;
    await this.reconciliationTail;
  }

  private async verifyInternalNetwork(): Promise<void> {
    if (this.networkChecked) return;
    const network = safeName(this.options.internalNetwork ?? "", "container network");
    const result = await this.processRunner(
      this.engine,
      ["network", "inspect", "--format", "{{.Internal}}", network],
      containerEngineEnvironment(undefined, this.controlEnvironment),
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
    assertBoundedStdin(request.stdin);
    if (this.orphanJournal) await this.reconcileOrphans();
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
    let outcome: IsolatedRunResult | undefined;
    let failure: Error | undefined;
    this.activeContainers.add(name);
    try {
      await this.orphanJournal?.add({
        name,
        engine: this.engine,
        startedAt: new Date().toISOString(),
        ...(request.workload?.tenantId ? { tenantId: request.workload.tenantId } : {}),
        ...(request.workload?.actor ? { actor: request.workload.actor } : {}),
        ...(request.workload?.executionId ? { executionId: request.workload.executionId } : {}),
      });
      let containerEnv: NodeJS.ProcessEnv = sanitizedShellEnv({
        ...this.controlEnvironment,
        ...request.env,
      });
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
      // The container has no host HOME to discover. Omitting these keys preserves the image's
      // internal HOME while keeping the Docker/Podman CLI's trusted config plane separate.
      for (const key of [
        "HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
      ]) {
        delete containerEnv[key];
      }
      const engineEnv = containerEngineEnvironment(containerEnv, this.controlEnvironment);

      const args = [
        "run",
        "--rm",
        "--name",
        name,
        ...(request.stdin === undefined ? [] : ["--interactive"]),
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
        engineEnv,
        timeoutMs,
        this.outputLimit,
        request.signal,
        request.stdin,
      );
      outcome = {
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
      failure = new Error(message);
    } finally {
      // `docker run --rm` normally removes the container itself. Timeout, abort, daemon errors and
      // a killed Docker CLI can leave it running, so every exit path performs an awaited stop/remove
      // by its unique container identifier. Cleanup is intentionally detached from request.signal:
      // an already-aborted caller must not cancel the operation that makes cancellation truthful.
      await this.processRunner(
        this.engine,
        ["stop", "--time", "1", name],
        containerEngineEnvironment(undefined, this.controlEnvironment),
        10_000,
        2_000,
      ).catch(() => undefined);
      let cleanupError: Error | undefined;
      const removed = await this.processRunner(
        this.engine,
        ["rm", "--force", name],
        containerEngineEnvironment(undefined, this.controlEnvironment),
        10_000,
        2_000,
      ).catch((error) => {
        cleanupError = error instanceof Error ? error : new Error(String(error));
        return undefined;
      });
      if (!removed || removed.timedOut || removed.exitCode !== 0) {
        const inspected = await this.processRunner(
          this.engine,
          ["container", "inspect", name],
          containerEngineEnvironment(undefined, this.controlEnvironment),
          10_000,
          2_000,
        ).catch((error) => {
          cleanupError = new Error(
            `Cannot prove container ${name} was removed: ${error instanceof Error ? error.message : String(error)}`,
          );
          return undefined;
        });
        if (inspected?.exitCode === 0) {
          cleanupError = new Error(`Container ${name} still exists after stop/rm cleanup`);
        } else if (inspected && containerInspectProvesMissing(inspected, name)) {
          cleanupError = undefined;
        } else if (inspected) {
          cleanupError = new Error(
            `Cannot prove container ${name} was removed (inspect exit=${inspected.exitCode}, timedOut=${inspected.timedOut})`,
          );
        }
      }
      await proxyCredential?.revoke().catch(() => undefined);
      this.activeContainers.delete(name);
      if (!cleanupError) {
        await this.orphanJournal?.remove(name);
      }
      if (cleanupError) {
        const cleanupFailure = new Error(redact(cleanupError.message));
        failure = failure
          ? new AggregateError([failure, cleanupFailure], "Container execution and cleanup failed")
          : cleanupFailure;
      }
    }
    if (failure) throw failure;
    if (!outcome) throw new Error("Container execution completed without a result");
    return outcome;
  }

  private async reconcileOrphansNow(): Promise<void> {
    if (!this.orphanJournal) return;
    const records = await this.orphanJournal.list();
    const failures: Error[] = [];
    for (const record of records) {
      if (this.activeContainers.has(record.name)) continue;
      await this.processRunner(
        record.engine,
        ["stop", "--time", "1", record.name],
        containerEngineEnvironment(undefined, this.controlEnvironment),
        10_000,
        2_000,
      ).catch(() => undefined);
      const removed = await this.processRunner(
        record.engine,
        ["rm", "--force", record.name],
        containerEngineEnvironment(undefined, this.controlEnvironment),
        10_000,
        2_000,
      ).catch(() => undefined);
      if (removed?.exitCode === 0 && !removed.timedOut) {
        await this.orphanJournal.remove(record.name);
        continue;
      }
      const inspected = await this.processRunner(
        record.engine,
        ["container", "inspect", record.name],
        containerEngineEnvironment(undefined, this.controlEnvironment),
        10_000,
        2_000,
      ).catch(() => undefined);
      if (inspected && containerInspectProvesMissing(inspected, record.name)) {
        await this.orphanJournal.remove(record.name);
        continue;
      }
      failures.push(new Error(`Cannot reconcile orphan container ${record.name}`));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Container orphan reconciliation failed");
    }
  }
}

class ContainerOrphanJournal {
  private tail: Promise<void> = Promise.resolve();
  private readonly limit: number;

  constructor(
    private readonly file: string,
    limit?: number,
  ) {
    this.limit = Math.max(1, Math.min(10_000, Math.floor(limit ?? 1_024)));
  }

  list(): Promise<ContainerOrphanRecord[]> {
    return this.lock(() => this.read());
  }

  add(record: ContainerOrphanRecord): Promise<void> {
    return this.lock(async () => {
      const records = await this.read();
      if (records.some((item) => item.name === record.name)) return;
      if (records.length >= this.limit) {
        throw new Error(`Container orphan journal reached its ${this.limit} record limit`);
      }
      records.push(record);
      await this.write(records);
    });
  }

  remove(name: string): Promise<void> {
    return this.lock(async () => {
      const records = await this.read();
      const next = records.filter((record) => record.name !== name);
      if (next.length !== records.length) await this.write(next);
    });
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<ContainerOrphanRecord[]> {
    let raw: string;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) {
        throw new Error("Container orphan journal must be a regular bounded file");
      }
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const parsed = JSON.parse(raw) as { version?: unknown; records?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.records)) {
      throw new Error("Invalid container orphan journal format");
    }
    return parsed.records.map(parseOrphanRecord);
  }

  private async write(records: ContainerOrphanRecord[]): Promise<void> {
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ version: 1, records })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temporary, this.file);
      if (process.platform !== "win32") {
        const directoryHandle = await fs.open(directory, "r");
        try {
          await directoryHandle.sync();
        } finally {
          await directoryHandle.close();
        }
      }
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

function parseOrphanRecord(value: unknown): ContainerOrphanRecord {
  const record = value as Partial<ContainerOrphanRecord> | null;
  if (
    !record ||
    !safeContainerIdentifier(record.name) ||
    (record.engine !== "docker" && record.engine !== "podman") ||
    typeof record.startedAt !== "string" ||
    !Number.isFinite(Date.parse(record.startedAt))
  ) {
    throw new Error("Invalid container orphan journal record");
  }
  for (const field of [record.tenantId, record.actor, record.executionId]) {
    if (field !== undefined && (typeof field !== "string" || field.length > 512)) {
      throw new Error("Invalid container orphan ownership metadata");
    }
  }
  return {
    name: record.name,
    engine: record.engine,
    startedAt: record.startedAt,
    ...(record.tenantId ? { tenantId: record.tenantId } : {}),
    ...(record.actor ? { actor: record.actor } : {}),
    ...(record.executionId ? { executionId: record.executionId } : {}),
  };
}

function safeContainerIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^anicode-[A-Za-z0-9_.-]{1,120}$/.test(value);
}

function containerInspectProvesMissing(result: ContainerProcessResult, name: string): boolean {
  if (result.timedOut || result.exitCode === 0 || result.exitCode === null) return false;
  const output = result.output.toLowerCase();
  return (
    output.includes(name.toLowerCase()) &&
    /no such (?:object|container)|no container with name or id|does not exist/.test(output)
  );
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

export async function runContainerCliProcess(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  outputLimit: number,
  signal?: AbortSignal,
  stdin?: string,
): Promise<ContainerProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Container execution aborted"));
      return;
    }
    const child = spawn(file, args, {
      env,
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    const capture = (chunk: Buffer) => {
      if (output.length < outputLimit) {
        output += chunk.toString().slice(0, outputLimit - output.length);
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    if (child.stdin) {
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    }
    let termination: Promise<void> | undefined;
    const terminate = () => {
      if (termination) return;
      termination = terminateProcessTree(child);
      // Reject after the bounded tree-kill proof fails; waiting only for `close` here could hang on
      // an escaped descendant that still owns the Docker CLI's stdio pipes.
      void termination.catch(reject);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => terminate();
    signal?.addEventListener("abort", onAbort, { once: true });
    // Cover an abort occurring between the pre-spawn check and listener installation.
    if (signal?.aborted) onAbort();
    child.once("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void (async () => {
        try {
          if (!termination && process.platform !== "win32") {
            termination = terminateProcessTree(child);
          }
          await termination;
          resolve({ exitCode, output, timedOut });
        } catch (error) {
          reject(error);
        }
      })();
    });
  });
}
