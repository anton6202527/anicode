/** OCI 容器执行边界：只读根、最小 capabilities、资源上限和 internal-only 网络。 */

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, statSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StringDecoder } from "node:string_decoder";
import type { CredentialBroker } from "../security/credentials.js";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
} from "./isolated-runtime.js";
import {
  assertBoundedStdin,
  RuntimeTerminationError,
  scopedProxyEnvironment,
  terminateProcessTree,
} from "./isolated-runtime.js";
import type { ScopedProxyCredentialIssuer } from "./network-proxy.js";

export interface ContainerProcessResult {
  exitCode: number | null;
  output: string;
  /** stdout only; stderr is retained solely in bounded combined diagnostics. */
  controlOutput?: string;
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
  /** Trusted absolute OCI CLI path; never resolved through workspace-controlled PATH. */
  engineExecutable?: string;
  /** Explicit local unix/npipe daemon endpoint (recommended for Docker Desktop/Podman machines). */
  engineEndpoint?: string;
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

type ContainerOrphanPhase = "reserved" | "creating" | "identified";

interface ContainerOrphanRecord {
  name: string;
  engine: "docker" | "podman";
  /** Validated local daemon identity used by run and every later cleanup/reconciliation call. */
  endpoint: string;
  ownerToken: string;
  startedAt: string;
  /**
   * `reserved` is durable before any daemon request is issued. `creating` is persisted immediately
   * before the one and only create request. Only `identified` may treat an immutable-ID 404 as a
   * terminal cleanup proof.
   */
  phase: ContainerOrphanPhase;
  containerId?: string;
  tenantId?: string;
  actor?: string;
  executionId?: string;
}

const CONTAINER_OWNER_LABEL = "dev.anicode.owner";

const OCI_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}(?:@sha256:[a-f0-9]{64})?$/;
const PINNED_OCI_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,511}@sha256:[a-f0-9]{64}$/;

function assertOciImageReference(image: string, requirePinned: boolean): void {
  if (!OCI_IMAGE_REFERENCE.test(image)) {
    throw new Error("Container runtime image is not a valid OCI image reference");
  }
  if (requirePinned && !PINNED_OCI_IMAGE_REFERENCE.test(image)) {
    throw new Error("Container runtime image must be pinned by a full sha256 digest");
  }
}

function canonical(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function assertContainerBindSource(value: string, label: string): void {
  // Docker/Podman parse --mount values as comma-delimited CSV inside one argv. There is no
  // portable escaping for a comma in src=, so rejecting it is the only non-ambiguous contract.
  if (!path.isAbsolute(value) || value.includes(",") || /[\0\r\n]/.test(value)) {
    throw new Error(`Container ${label} path cannot be represented safely as a bind mount`);
  }
}

function assertLocalContainerEndpoint(value: string, label: string): void {
  if (
    /[\0\r\n,]/.test(value) ||
    (!value.startsWith("unix:///") && !value.startsWith("npipe:////./pipe/"))
  ) {
    throw new Error(`${label} must be an explicit local unix/npipe endpoint`);
  }
}

function localContainerEngineEndpoint(
  engine: "docker" | "podman",
  control: NodeJS.ProcessEnv,
  explicit?: string,
  testSeam = false,
): string {
  const configured = explicit?.trim() || control["ANICODE_CONTAINER_ENGINE_ENDPOINT"]?.trim();
  if (configured) {
    assertLocalContainerEndpoint(configured, "Container engine endpoint");
    return configured;
  }
  if (engine === "docker") {
    const context = control["DOCKER_CONTEXT"]?.trim();
    if (context && context !== "default") {
      throw new Error("Container runtime rejects non-default Docker contexts for host bind mounts");
    }
    const fromEnvironment = control["DOCKER_HOST"]?.trim();
    const endpoint =
      fromEnvironment ||
      (process.platform === "win32"
        ? "npipe:////./pipe/docker_engine"
        : "unix:///var/run/docker.sock");
    assertLocalContainerEndpoint(endpoint, "Docker endpoint");
    if (!fromEnvironment && !testSeam && endpoint.startsWith("unix://")) {
      const socket = endpoint.slice("unix://".length);
      if (!existsSync(socket)) {
        throw new Error(
          "Default Docker socket is unavailable; configure ANICODE_CONTAINER_ENGINE_ENDPOINT with an explicit local unix socket",
        );
      }
    }
    return endpoint;
  }
  if (control["CONTAINER_CONNECTION"]?.trim() || control["CONTAINERS_CONF"]?.trim()) {
    throw new Error(
      "Container runtime rejects Podman remote/configured connections for bind mounts",
    );
  }
  const endpoint =
    control["CONTAINER_HOST"]?.trim() ||
    (process.platform === "win32"
      ? "npipe:////./pipe/podman-machine-default"
      : typeof process.getuid === "function"
        ? `unix:///run/user/${process.getuid()}/podman/podman.sock`
        : "unix:///run/podman/podman.sock");
  assertLocalContainerEndpoint(endpoint, "Podman endpoint");
  return endpoint;
}

function trustedContainerEngineBinary(
  engine: "docker" | "podman",
  explicit: string | undefined,
  control: NodeJS.ProcessEnv,
): string {
  const programFiles = control["ProgramFiles"] ?? "C:\\Program Files";
  const candidates = explicit
    ? [explicit]
    : process.platform === "win32"
      ? [
          engine === "docker"
            ? path.join(programFiles, "Docker", "Docker", "resources", "bin", "docker.exe")
            : path.join(programFiles, "RedHat", "Podman", "podman.exe"),
        ]
      : [`/usr/bin/${engine}`, `/usr/local/bin/${engine}`, `/opt/homebrew/bin/${engine}`];
  for (const candidate of candidates) {
    try {
      if (!path.isAbsolute(candidate)) continue;
      const resolved = realpathSync(candidate);
      const stat = statSync(resolved);
      if (
        stat.isFile() &&
        (process.platform === "win32" || ((stat.mode & 0o111) !== 0 && (stat.mode & 0o022) === 0))
      ) {
        return resolved;
      }
    } catch {
      // Continue through the fixed, non-workspace candidate list.
    }
  }
  throw new Error(`No trusted absolute executable ${engine} engine binary is available`);
}

const CONTAINER_ENGINE_CONTROL_ENV = [
  "PATH",
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
  "ANICODE_CONTAINER_ENGINE_BIN",
  "ANICODE_CONTAINER_ENGINE_ENDPOINT",
] as const;

/**
 * Docker/Podman is trusted control-plane code and may need its context, registry auth and socket.
 * Workload variables are merged only so `docker --env KEY` can source their values; control-plane
 * keys are never added to that argv list by the caller.
 */
export function containerEngineEnvironment(
  workload: NodeJS.ProcessEnv = {},
  control: NodeJS.ProcessEnv = process.env,
  proxyUrl?: string,
): NodeJS.ProcessEnv {
  const env = { ...sanitizedShellEnv(control), ...workload };
  for (const key of CONTAINER_ENGINE_CONTROL_ENV) {
    const value = control[key];
    if (value !== undefined) env[key] = value;
  }
  // Docker/Podman is itself a child process. Do not let its inherited host proxy variables disagree
  // with the workload proxy values that `--env KEY` sources from this same environment.
  return scopedProxyEnvironment(env, proxyUrl);
}

export class ContainerIsolatedRuntime implements ExecutionRuntime {
  readonly toolModuleEnvironment: "container" | "unsupported";
  readonly managedProcessBoundary = "unsupported" as const;
  // A shared `--internal` network still permits east-west traffic and direct proxy/service access.
  // Until each run owns an isolated network namespace with a single proxy peer, module egress is
  // not advertised even when the general container runtime has a credential issuer.
  readonly toolModuleNetworkBoundary = "unsupported" as const;
  private readonly engine: "docker" | "podman";
  private readonly engineFile: string;
  private readonly outputLimit: number;
  private readonly broker?: CredentialBroker;
  private readonly processRunner: ContainerProcessRunner;
  private readonly controlEnvironment: NodeJS.ProcessEnv;
  private readonly engineEndpoint: string;
  private readonly orphanJournal?: ContainerOrphanJournal;
  private readonly activeContainers = new Set<string>();
  private readonly activeRunControllers = new Set<AbortController>();
  private inFlightRuns = 0;
  private drainWaiters: (() => void)[] = [];
  private closed = false;
  private reconciliationTail: Promise<void> = Promise.resolve();
  private reconciliationTimer: NodeJS.Timeout | undefined;
  private shutdownTask?: Promise<void>;

  constructor(private readonly options: ContainerIsolatedRuntimeOptions) {
    this.engine = options.engine ?? "docker";
    this.outputLimit = Math.max(1_000, options.outputLimitChars ?? 60_000);
    this.processRunner = options.processRunner ?? runContainerCliProcess;
    const controlSnapshot = { ...(options.controlEnvironment ?? process.env) };
    assertOciImageReference(options.image, options.requirePinnedImage ?? true);
    if (options.proxyUrl) assertCredentialFreeProxyUrl(options.proxyUrl);
    this.toolModuleEnvironment = (options.requirePinnedImage ?? true) ? "container" : "unsupported";
    this.engineEndpoint = localContainerEngineEndpoint(
      this.engine,
      controlSnapshot,
      options.engineEndpoint,
      Boolean(options.processRunner),
    );
    const configuredEngineBinary =
      options.engineExecutable ?? controlSnapshot["ANICODE_CONTAINER_ENGINE_BIN"];
    this.engineFile =
      options.processRunner && !configuredEngineBinary
        ? this.engine
        : trustedContainerEngineBinary(this.engine, configuredEngineBinary, controlSnapshot);
    // Freeze one validated daemon identity for the whole runtime lifetime. In particular, later
    // process.env/context mutations cannot send run to daemon A and cleanup/inspect to daemon B.
    if (this.engine === "docker") {
      controlSnapshot["DOCKER_HOST"] = this.engineEndpoint;
      delete controlSnapshot["DOCKER_CONTEXT"];
    } else {
      controlSnapshot["CONTAINER_HOST"] = this.engineEndpoint;
      delete controlSnapshot["CONTAINER_CONNECTION"];
      delete controlSnapshot["CONTAINERS_CONF"];
    }
    this.controlEnvironment = Object.freeze(controlSnapshot);
    if (options.broker) this.broker = options.broker;
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

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.closed = true;
    this.shutdownTask = this.shutdownNow();
    const reason = new Error("Container runtime is shutting down");
    for (const controller of this.activeRunControllers) controller.abort(reason);
    return this.shutdownTask;
  }

  private async shutdownNow(): Promise<void> {
    if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
    this.reconciliationTimer = undefined;
    let failure: unknown;
    try {
      if (this.inFlightRuns > 0) {
        await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
      }
      await this.reconciliationTail;
      if (this.orphanJournal) await this.reconcileOrphans();
    } catch (error) {
      failure = error;
    }
    if (this.activeContainers.size > 0) {
      failure = new RuntimeTerminationError();
    } else {
      try {
        this.orphanJournal?.close();
      } catch (error) {
        failure = failure
          ? new AggregateError([failure, error], "Container shutdown and owner-lock release failed")
          : error;
      }
    }
    if (failure) throw failure;
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    if (this.closed) throw new Error("Container runtime is shut down");
    const lifecycle = new AbortController();
    this.activeRunControllers.add(lifecycle);
    this.inFlightRuns++;
    try {
      return await this.runOwned(request, lifecycle.signal);
    } finally {
      this.activeRunControllers.delete(lifecycle);
      this.inFlightRuns--;
      if (this.inFlightRuns === 0) {
        const waiters = this.drainWaiters;
        this.drainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  private async runOwned(
    request: IsolatedRunRequest,
    lifecycleSignal: AbortSignal,
  ): Promise<IsolatedRunResult> {
    const started = Date.now();
    const executionSignal = request.signal
      ? AbortSignal.any([request.signal, lifecycleSignal])
      : lifecycleSignal;
    executionSignal.throwIfAborted();
    assertBoundedStdin(request.stdin);
    if (this.orphanJournal) await this.reconcileOrphans();
    executionSignal.throwIfAborted();
    const exposeWorkspace = (request.workspaceExposure ?? "normal") === "normal";
    const cwd = exposeWorkspace ? canonical(request.cwd) : undefined;
    if (cwd) assertContainerBindSource(cwd, "workspace");
    const network = request.network ?? false;
    const timeoutMs = Math.max(1_000, request.timeoutMs ?? 120_000);
    if (network) {
      throw new Error(
        "Container network access is disabled until every execution has a private proxy-only network namespace",
      );
    }

    const redact = (value: string) => this.broker?.redact(value) ?? value;

    const name = `anicode-${randomUUID()}`;
    const ownerToken = randomUUID();
    let outcome: IsolatedRunResult | undefined;
    let failure: Error | undefined;
    let phase: ContainerOrphanPhase = "reserved";
    let journaled = false;
    let containerId: string | undefined;
    this.activeContainers.add(name);
    try {
      await this.orphanJournal?.add({
        name,
        engine: this.engine,
        endpoint: this.engineEndpoint,
        ownerToken,
        startedAt: new Date().toISOString(),
        phase: "reserved",
        ...(request.workload?.tenantId ? { tenantId: request.workload.tenantId } : {}),
        ...(request.workload?.actor ? { actor: request.workload.actor } : {}),
        ...(request.workload?.executionId ? { executionId: request.workload.executionId } : {}),
      });
      journaled = Boolean(this.orphanJournal);
      // Workload environment is an allow-by-construction plane: start only from request-scoped
      // values. The engine gets trusted host context separately through containerEngineEnvironment;
      // inheriting the controller here would forward unrelated CI/telemetry metadata via --env.
      let containerEnv: NodeJS.ProcessEnv = sanitizedShellEnv(request.env ?? {});
      for (const lease of request.credentialLeases ?? []) {
        if (!this.broker) throw new Error("No credential broker configured");
        containerEnv = this.broker.injectEnv(lease, containerEnv);
      }
      // Local container networking is currently fail-closed, so no host/workload proxy spelling
      // reaches the image. This also clears proxy values baked into the controller environment.
      containerEnv = scopedProxyEnvironment(containerEnv);
      // The container has no host HOME to discover. Omitting these keys preserves the image's
      // internal HOME while keeping the Docker/Podman CLI's trusted config plane separate.
      for (const key of [
        ...CONTAINER_ENGINE_CONTROL_ENV,
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
      ]) {
        delete containerEnv[key];
      }
      // Override image-provided Node injection points for the core-owned harness.
      containerEnv["NODE_OPTIONS"] = "";
      containerEnv["NODE_PATH"] = "";
      containerEnv["NODE_EXTRA_CA_CERTS"] = "";
      const engineEnv = this.engineEnvironment(containerEnv);

      const args = [
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `${CONTAINER_OWNER_LABEL}=${ownerToken}`,
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
        ...(cwd
          ? ["--mount", containerWorkspaceMount(cwd, request.policy)]
          : ["--tmpfs", "/workspace:rw,noexec,nosuid,nodev,size=16m"]),
        "--network",
        "none",
      ];
      if (typeof process.getuid === "function" && typeof process.getgid === "function") {
        args.push("--user", `${process.getuid()}:${process.getgid()}`);
      }
      for (const protectedPath of cwd ? [".git", ".anicode"] : []) {
        const workspace = cwd!;
        const source = path.join(workspace, protectedPath);
        const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (!stat) continue;
        if (stat.isSymbolicLink()) {
          throw new Error(`Protected workspace path ${protectedPath} must not be a symbolic link`);
        }
        const resolved = await fs.realpath(source);
        assertContainerBindSource(resolved, `protected workspace path ${protectedPath}`);
        const relative = path.relative(workspace, resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error(`Protected workspace path ${protectedPath} escapes the workspace`);
        }
        args.push("--mount", `type=bind,src=${resolved},dst=/workspace/${protectedPath},readonly`);
      }
      for (const key of Object.keys(containerEnv).sort()) args.push("--env", key);
      args.push("--entrypoint", "/bin/sh", this.options.image, "-lc", request.command);
      executionSignal.throwIfAborted();
      // There is deliberately no await between the durable transition and invoking the one create
      // request. A crash at either point is therefore conservatively recovered as `creating`.
      if (this.orphanJournal) await this.orphanJournal.markCreating(name);
      phase = "creating";
      const created = await this.processRunner(
        this.engineFile,
        args,
        engineEnv,
        timeoutMs,
        this.outputLimit,
        lifecycleSignal,
      );
      const reportedId = parseContainerId(this.controlText(created));
      if (created.exitCode !== 0 || created.timedOut || !reportedId) {
        throw new Error("OCI container creation did not return a stable container ID");
      }
      containerId = reportedId;
      phase = "identified";
      await this.orphanJournal?.identify(name, reportedId);
      const ownership = await this.inspectOwnedContainer(
        reportedId,
        ownerToken,
        this.engineEndpoint,
      );
      if (ownership.kind !== "owned" || ownership.id !== reportedId) {
        throw new Error("OCI container creation ownership could not be proved");
      }
      executionSignal.throwIfAborted();
      const remainingMs = timeoutMs - (Date.now() - started);
      if (remainingMs <= 0)
        throw new Error("OCI container execution deadline elapsed before start");
      const result = await this.processRunner(
        this.engineFile,
        [
          "start",
          "--attach",
          ...(request.stdin === undefined ? [] : ["--interactive"]),
          reportedId,
        ],
        this.engineEnvironment(),
        remainingMs,
        this.outputLimit,
        executionSignal,
        request.stdin,
      );
      outcome = {
        exitCode: result.exitCode,
        output: redact(result.output),
        ...(result.controlOutput !== undefined
          ? { controlOutput: redact(result.controlOutput) }
          : {}),
        timedOut: result.timedOut,
        sandboxed: true,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof RuntimeTerminationError) {
        failure = error;
      } else {
        const message = redact(error instanceof Error ? error.message : String(error));
        // The original error can contain the injected capability in env/argv diagnostics. Keeping
        // it as `cause` would bypass the redaction boundary.
        failure = new Error(message);
      }
    } finally {
      let cleanupProved: boolean;
      try {
        cleanupProved =
          phase === "reserved"
            ? true
            : phase === "identified" && containerId
              ? await this.removeOwnedContainer(containerId, ownerToken, this.engineEndpoint)
              : await this.resolveCreatingContainer(name, ownerToken, this.engineEndpoint);
        if (cleanupProved && journaled) await this.orphanJournal!.remove(name);
      } catch {
        cleanupProved = false;
      } finally {
        this.activeContainers.delete(name);
      }
      if (!cleanupProved) {
        // Cleanup diagnostics can include engine endpoints or injected proxy material. The durable
        // orphan journal retains operator evidence; callers receive only a typed, stable proof
        // failure which lifecycle shutdown is required to propagate.
        failure = new RuntimeTerminationError();
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
      if (record.engine !== this.engine || record.endpoint !== this.engineEndpoint) {
        failures.push(
          new Error(`Orphan ${record.name} belongs to a different engine or daemon endpoint`),
        );
        continue;
      }
      const cleanupProved =
        record.phase === "reserved"
          ? true
          : record.phase === "identified"
            ? await this.removeOwnedContainer(
                record.containerId!,
                record.ownerToken,
                record.endpoint,
              )
            : await this.resolveCreatingContainer(record.name, record.ownerToken, record.endpoint);
      if (cleanupProved) {
        await this.orphanJournal.remove(record.name);
        continue;
      }
      failures.push(new Error(`Cannot reconcile orphan container ${record.name}`));
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "Container orphan reconciliation failed");
    }
  }

  private async removeOwnedContainer(
    reference: string,
    ownerToken: string,
    endpoint: string,
  ): Promise<boolean> {
    const inspected = await this.inspectOwnedContainer(reference, ownerToken, endpoint);
    if (inspected.kind === "missing") return true;
    if (inspected.kind !== "owned") return false;
    await this.processRunner(
      this.engineFile,
      ["stop", "--time", "1", inspected.id],
      this.engineEnvironment(undefined, undefined, endpoint),
      10_000,
      2_000,
    ).catch(() => undefined);
    await this.processRunner(
      this.engineFile,
      ["rm", "--force", inspected.id],
      this.engineEnvironment(undefined, undefined, endpoint),
      10_000,
      2_000,
    ).catch(() => undefined);
    return (
      (await this.inspectOwnedContainer(inspected.id, ownerToken, endpoint)).kind === "missing"
    );
  }

  /**
   * Resolve the single create request represented by a `creating` record. Missing-by-name is not a
   * proof: the daemon request may still commit later. Once the owned object is observed, persist its
   * immutable ID before removal so a crash during cleanup remains exactly recoverable.
   */
  private async resolveCreatingContainer(
    name: string,
    ownerToken: string,
    endpoint: string,
  ): Promise<boolean> {
    const inspected = await this.inspectOwnedContainer(name, ownerToken, endpoint);
    if (inspected.kind !== "owned") return false;
    await this.orphanJournal?.identify(name, inspected.id);
    return this.removeOwnedContainer(inspected.id, ownerToken, endpoint);
  }

  private async inspectOwnedContainer(
    reference: string,
    ownerToken: string,
    endpoint: string,
  ): Promise<{ kind: "missing" } | { kind: "unknown" } | { kind: "owned"; id: string }> {
    const result = await this.processRunner(
      this.engineFile,
      [
        "container",
        "inspect",
        "--format",
        `{{.Id}} {{ index .Config.Labels "${CONTAINER_OWNER_LABEL}" }}`,
        reference,
      ],
      this.engineEnvironment(undefined, undefined, endpoint),
      10_000,
      2_000,
    ).catch(() => undefined);
    if (!result || result.timedOut) return { kind: "unknown" };
    if (containerInspectProvesMissing(result, reference)) return { kind: "missing" };
    if (result.exitCode !== 0) return { kind: "unknown" };
    const control = this.controlText(result).trim().split(/\s+/);
    if (control.length !== 2 || !/^[a-f0-9]{64}$/.test(control[0] ?? "")) {
      return { kind: "unknown" };
    }
    if (control[1] !== ownerToken) return { kind: "unknown" };
    return { kind: "owned", id: control[0]! };
  }

  private controlText(result: ContainerProcessResult): string {
    return result.controlOutput ?? (this.options.processRunner ? result.output : "");
  }

  private engineEnvironment(
    workload?: NodeJS.ProcessEnv,
    proxyUrl?: string,
    endpoint = this.engineEndpoint,
  ): NodeJS.ProcessEnv {
    assertLocalContainerEndpoint(endpoint, "journaled container endpoint");
    const control = { ...this.controlEnvironment };
    if (this.engine === "docker") {
      control["DOCKER_HOST"] = endpoint;
      delete control["DOCKER_CONTEXT"];
    } else {
      control["CONTAINER_HOST"] = endpoint;
      delete control["CONTAINER_CONNECTION"];
    }
    return containerEngineEnvironment(workload, control, proxyUrl);
  }
}

class ContainerOrphanJournal {
  private tail: Promise<void> = Promise.resolve();
  private readonly limit: number;
  private readonly ownerDb: DatabaseSync;
  private closed = false;

  constructor(
    private readonly file: string,
    limit?: number,
  ) {
    this.limit = Math.max(1, Math.min(10_000, Math.floor(limit ?? 1_024)));
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const ownerFile = `${file}.owner.sqlite`;
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(ownerFile);
      chmodSync(ownerFile, 0o600);
      database.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE;");
      // SQLite's kernel-backed write lock is released automatically on close, process exit and
      // SIGKILL. Unlike a persistent O_EXCL sentinel, it therefore preserves crash recovery while
      // still preventing two runtimes from reconciling the same JSON journal concurrently.
      database.exec("BEGIN IMMEDIATE");
    } catch (error) {
      try {
        database?.close();
      } catch {
        // Constructor failure is already fail-closed.
      }
      throw new Error("Container orphan journal is already owned by another runtime", {
        cause: error,
      });
    }
    if (!database) throw new Error("Container orphan journal owner database did not open");
    this.ownerDb = database;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let failure: unknown;
    try {
      this.ownerDb.exec("ROLLBACK");
    } catch (error) {
      failure = error;
    }
    try {
      this.ownerDb.close();
    } catch (error) {
      failure = failure
        ? new AggregateError([failure, error], "Container journal owner lock close failed")
        : error;
    }
    if (failure) throw failure;
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

  markCreating(name: string): Promise<void> {
    return this.update(name, (record) => {
      if (record.phase !== "reserved") {
        throw new Error(`Container orphan ${name} cannot transition to creating`);
      }
      return { ...record, phase: "creating" };
    });
  }

  identify(name: string, containerId: string): Promise<void> {
    const identified = parseContainerId(containerId);
    if (!identified) return Promise.reject(new Error("Invalid immutable container ID"));
    return this.update(name, (record) => {
      if (record.phase === "identified" && record.containerId !== identified) {
        throw new Error(`Container orphan ${name} changed immutable identity`);
      }
      if (record.phase === "reserved") {
        throw new Error(`Container orphan ${name} was identified before create`);
      }
      return { ...record, phase: "identified", containerId: identified };
    });
  }

  remove(name: string): Promise<void> {
    return this.lock(async () => {
      const records = await this.read();
      const next = records.filter((record) => record.name !== name);
      if (next.length !== records.length) await this.write(next);
    });
  }

  private update(
    name: string,
    transition: (record: ContainerOrphanRecord) => ContainerOrphanRecord,
  ): Promise<void> {
    return this.lock(async () => {
      const records = await this.read();
      const index = records.findIndex((record) => record.name === name);
      if (index < 0) throw new Error(`Container orphan journal lost reservation ${name}`);
      records[index] = transition(records[index]!);
      await this.write(records);
    });
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Container orphan journal is closed"));
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
    if ((parsed.version !== 1 && parsed.version !== 2) || !Array.isArray(parsed.records)) {
      throw new Error("Invalid container orphan journal format");
    }
    const version = parsed.version as 1 | 2;
    const records = parsed.records.map((record) => parseOrphanRecord(record, version));
    if (version === 1) {
      // Version 1 was written before create intent and immutable identity were durable. Treat every
      // such record as an issued/ambiguous create and persist the conservative migration now.
      await this.write(records);
    }
    return records;
  }

  private async write(records: ContainerOrphanRecord[]): Promise<void> {
    const normalized = records.map((record) => parseOrphanRecord(record, 2));
    const serialized = `${JSON.stringify({ version: 2, records: normalized })}\n`;
    if (Buffer.byteLength(serialized) > 2 * 1024 * 1024) {
      throw new Error("Container orphan journal exceeds its bounded size");
    }
    const directory = path.dirname(this.file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(serialized, "utf8");
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

function parseOrphanRecord(value: unknown, journalVersion: 1 | 2): ContainerOrphanRecord {
  const record = value as Partial<ContainerOrphanRecord> | null;
  if (
    !record ||
    !safeContainerIdentifier(record.name) ||
    (record.engine !== "docker" && record.engine !== "podman") ||
    typeof record.endpoint !== "string" ||
    record.endpoint.length > 1_024 ||
    typeof record.ownerToken !== "string" ||
    !/^[a-f0-9-]{36}$/.test(record.ownerToken) ||
    typeof record.startedAt !== "string" ||
    record.startedAt.length > 64 ||
    !Number.isFinite(Date.parse(record.startedAt))
  ) {
    throw new Error("Invalid container orphan journal record");
  }
  const phase = journalVersion === 1 ? "creating" : record.phase;
  if (phase !== "reserved" && phase !== "creating" && phase !== "identified") {
    throw new Error("Invalid container orphan journal phase");
  }
  const containerId =
    phase === "identified" ? parseContainerId(record.containerId ?? "") : undefined;
  if (
    (phase === "identified" && !containerId) ||
    (phase !== "identified" && record.containerId !== undefined)
  ) {
    throw new Error("Invalid container orphan journal identity");
  }
  assertLocalContainerEndpoint(record.endpoint, "orphan journal endpoint");
  for (const field of [record.tenantId, record.actor, record.executionId]) {
    if (field !== undefined && (typeof field !== "string" || field.length > 512)) {
      throw new Error("Invalid container orphan ownership metadata");
    }
  }
  return {
    name: record.name,
    engine: record.engine,
    endpoint: record.endpoint,
    ownerToken: record.ownerToken,
    startedAt: record.startedAt,
    phase,
    ...(containerId ? { containerId } : {}),
    ...(record.tenantId ? { tenantId: record.tenantId } : {}),
    ...(record.actor ? { actor: record.actor } : {}),
    ...(record.executionId ? { executionId: record.executionId } : {}),
  };
}

function safeContainerIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^anicode-[A-Za-z0-9_.-]{1,120}$/.test(value);
}

function parseContainerId(value: string): string | undefined {
  const normalized = value.trim();
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : undefined;
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
  assertContainerBindSource(cwd, "workspace");
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
    let controlOutput = "";
    let timedOut = false;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const capture = (value: string) => {
      if (output.length < outputLimit) {
        output += value.slice(0, outputLimit - output.length);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      const value = stdoutDecoder.write(chunk);
      capture(value);
      if (controlOutput.length < outputLimit) {
        controlOutput += value.slice(0, outputLimit - controlOutput.length);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => capture(stderrDecoder.write(chunk)));
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
          const stdoutTail = stdoutDecoder.end();
          capture(stdoutTail);
          if (controlOutput.length < outputLimit) {
            controlOutput += stdoutTail.slice(0, outputLimit - controlOutput.length);
          }
          capture(stderrDecoder.end());
          if (!termination && process.platform !== "win32") {
            termination = terminateProcessTree(child);
          }
          await termination;
          resolve({ exitCode, output, controlOutput, timedOut });
        } catch (error) {
          reject(error);
        }
      })();
    });
  });
}
