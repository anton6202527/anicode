/** 生产宿主共用装配：持久事件/快照/inbox/outbox、Broker、受控网络与 worker。 */

import * as path from "node:path";
import { bindProviderRegistry, type BoundProviderRegistry } from "../provider/registry.js";
import {
  CredentialBroker,
  credentialBrokerFromBackend,
  credentialBrokerFromEnv,
  credentialBrokerFromLazyBackend,
  credentialEnvironmentAllowlist,
  isSensitiveEnvironmentName,
  type CredentialAuditEvent,
} from "../security/credentials.js";
import {
  configuredSecretBackendFromEnv,
  OS_KEYCHAIN_DISABLED_ENV,
  OsKeychainDisabledError,
  OsKeychainSecretBackend,
  type OsKeychainSecretBackendOptions,
  type SecretBackend,
} from "../security/secret-backends.js";
import { CommandInbox, DurableOutbox } from "./commands.js";
import { configuredS3ArtifactStoreFromEnv, type ArtifactStore } from "./artifacts.js";
import type { ISessionStore } from "../session.js";
import { DurableRuntime } from "./durable.js";
import { ContainerIsolatedRuntime } from "./container-runtime.js";
import {
  DisabledExecutionRuntime,
  IsolatedRuntime,
  type ExecutionRuntime,
} from "./isolated-runtime.js";
import { NetworkProxy } from "./network-proxy.js";
import {
  SqliteArtifactStore,
  SqliteCommandInboxStore,
  SqliteOutboxStore,
  SqliteRuntimeDatabase,
  SqliteRuntimeEventStore,
  SqliteRuntimeSnapshotStore,
  SqliteRuntimeSessionStore,
  SqliteWorkerQueueStore,
} from "./sqlite.js";
import { DurableWorkerQueue, WorktreeOwnership } from "./worker.js";
import { telemetryFromEnv, type Telemetry } from "./telemetry.js";
import { TransactionalExecutionRuntime } from "./transactional-runtime.js";

function csv(value: string | undefined, fallback: string[]): string[] {
  const parsed = value
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return parsed?.length ? parsed : fallback;
}

export interface LocalRuntimeStack {
  runtime: DurableRuntime;
  database: SqliteRuntimeDatabase;
  broker: CredentialBroker;
  artifacts: ArtifactStore;
  sessions: ISessionStore;
  commandInbox: CommandInbox;
  outbox: DurableOutbox;
  networkProxy: NetworkProxy;
  /** Host execution capability selected before any model-visible tools are assembled. */
  executionMode: LocalExecutionMode;
  isolatedRuntime: ExecutionRuntime;
  workerQueue: DurableWorkerQueue;
  worktreeOwnership: WorktreeOwnership;
  /** Provider operations permanently bound to this stack's broker and network policy. */
  providers: BoundProviderRegistry;
  resolveProvider: BoundProviderRegistry["resolveProvider"];
  resolveProviderAsync: BoundProviderRegistry["resolveProviderAsync"];
  discoverModels: BoundProviderRegistry["discoverModels"];
}

export interface LocalRuntimeStackOptions {
  /** Trusted host composition for the isolated native Keychain helper. */
  osKeychain?: OsKeychainSecretBackendOptions;
}

/**
 * `restricted` is the production-safe fallback when the host has no supported native sandbox.
 * It is deliberately distinct from workspace trust's restricted mode: this capability cannot be
 * enlarged by a permission answer or by trusting project files.
 */
export type LocalExecutionMode = "native-isolated" | "container" | "restricted";

export function resolveLocalExecutionMode(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): LocalExecutionMode {
  const backend = env.ANICODE_EXECUTION_BACKEND?.trim() || "native";
  if (backend === "container") return "container";
  if (backend !== "native") {
    throw new Error(`Unsupported ANICODE_EXECUTION_BACKEND: ${backend}`);
  }
  // Seatbelt and the Linux namespace sandbox are the only native production backends today.
  // In particular, Windows must never degrade to an unrestricted cmd.exe/PowerShell spawn.
  return platform === "darwin" || platform === "linux" ? "native-isolated" : "restricted";
}

/** OTLP exporter 复用本地安全栈：网络策略 + Broker credential reference。 */
export function telemetryForLocalStack(
  stack: Pick<LocalRuntimeStack, "networkProxy" | "broker">,
  env: NodeJS.ProcessEnv = process.env,
): Telemetry {
  const controlledFetch = ((input: string | URL | Request, init?: RequestInit) =>
    stack.networkProxy.fetch(input instanceof Request ? input.url : input, init)) as typeof fetch;
  return telemetryFromEnv(env, {
    fetch: controlledFetch,
    broker: stack.broker,
  });
}

export function createLocalRuntimeStack(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: LocalRuntimeStackOptions = {},
): LocalRuntimeStack {
  const sourceEnv = { ...env };
  const sensitiveValues = sensitiveEnvironmentSnapshot(sourceEnv);
  const runtimeEnv = withoutSensitiveEnvironment(sourceEnv);
  const kind = sourceEnv.ANICODE_CREDENTIAL_BACKEND ?? "keychain";
  if (kind === "vault" || kind === "kms") {
    throw new Error(`${kind} credentials require createConfiguredLocalRuntimeStack()`);
  }
  if (kind !== "keychain" && kind !== "memory") {
    throw new Error(`Unsupported ANICODE_CREDENTIAL_BACKEND: ${kind}`);
  }
  if (kind === "keychain" && sourceEnv[OS_KEYCHAIN_DISABLED_ENV] === "1") {
    throw new OsKeychainDisabledError();
  }
  const root = path.resolve(baseDir);
  const backend =
    kind === "memory"
      ? undefined
      : new OsKeychainSecretBackend(
          sourceEnv.ANICODE_KEYCHAIN_SERVICE ?? "dev.anicode.credentials",
          options.osKeychain,
        );
  const database = new SqliteRuntimeDatabase(path.join(root, "runtime.db"));
  try {
    // 环境值只进当前进程 Broker，绝不覆盖 Keychain；Keychain 只注册显式 allowlist 引用。
    const broker = credentialBrokerFromEnv(sourceEnv, {
      remove: false,
      ...(backend ? { backend } : {}),
      onAudit: credentialAudit(database),
    });
    const stack = assembleLocalRuntimeStack(root, runtimeEnv, database, broker);
    commitSensitiveEnvironmentRemoval(env, sensitiveValues);
    return stack;
  } catch (error) {
    // Synchronous factory compatibility: construction itself has no pending database work, so
    // close begins immediately; attach a rejection handler because the error must escape now.
    void database.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Vault/KMS/OIDC 生产装配。后端连接参数先复制；完整装配成功后才提交清理调用方环境，
 * 失败则保持不变。长期值只从后端按 `env:NAME` 读取。
 */
export async function createConfiguredLocalRuntimeStack(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { backend?: SecretBackend } = {},
): Promise<LocalRuntimeStack> {
  const sourceEnv = { ...env };
  const sensitiveValues = sensitiveEnvironmentSnapshot(sourceEnv);
  const runtimeEnv = withoutSensitiveEnvironment(sourceEnv);
  const kind = sourceEnv.ANICODE_CREDENTIAL_BACKEND ?? "keychain";
  if (kind === "memory") return createLocalRuntimeStack(baseDir, env);
  if (kind === "keychain" && !options.backend) return createLocalRuntimeStack(baseDir, env);
  if (kind === "keychain" && sourceEnv[OS_KEYCHAIN_DISABLED_ENV] === "1") {
    throw new OsKeychainDisabledError();
  }
  const root = path.resolve(baseDir);
  const database = new SqliteRuntimeDatabase(path.join(root, "runtime.db"));
  try {
    // OIDC provider 持有快照，清理 process.env 后仍能刷新工作负载身份 token。
    const backend = options.backend ?? (await configuredSecretBackendFromEnv(sourceEnv));
    const names = credentialEnvironmentAllowlist(sourceEnv);
    if (kind !== "keychain" && names.length === 0) {
      throw new Error(`${kind} credentials require ANICODE_CREDENTIAL_KEYS`);
    }
    const broker =
      kind === "keychain"
        ? credentialBrokerFromLazyBackend(backend, names, {
            onAudit: credentialAudit(database),
            environment: sourceEnv,
          })
        : await credentialBrokerFromBackend(backend, names, {
            onAudit: credentialAudit(database),
            environment: sourceEnv,
          });
    const stack = assembleLocalRuntimeStack(root, runtimeEnv, database, broker);
    // 原始 provider keys、GitHub OIDC request token、静态 cloud keys 等不再向子进程继承。
    // Compare-and-delete preserves a value concurrently replaced by the caller while async backend
    // setup was in flight. The running stack is bound to the already-sanitized snapshot either way.
    commitSensitiveEnvironmentRemoval(env, sensitiveValues);
    return stack;
  } catch (error) {
    await database.close();
    throw error;
  }
}

type SensitiveEnvironmentValue = { name: string; value: string };

function sensitiveEnvironmentSnapshot(env: NodeJS.ProcessEnv): SensitiveEnvironmentValue[] {
  const values: SensitiveEnvironmentValue[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && isSensitiveEnvironmentName(name)) values.push({ name, value });
  }
  return values;
}

function withoutSensitiveEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const sanitized = { ...env };
  for (const name of Object.keys(sanitized)) {
    if (isSensitiveEnvironmentName(name)) delete sanitized[name];
  }
  return sanitized;
}

function commitSensitiveEnvironmentRemoval(
  env: NodeJS.ProcessEnv,
  captured: readonly SensitiveEnvironmentValue[],
): void {
  for (const { name, value } of captured) {
    if (env[name] === value) delete env[name];
  }
}

function credentialAudit(database: SqliteRuntimeDatabase) {
  return (event: CredentialAuditEvent) =>
    database.audit({
      category: "credential",
      action: event.action,
      subject: event.credentialId,
      decision: event.success ? "success" : "failure",
      metadata: {
        audience: event.audience ?? "",
        host: event.host ?? "",
        tool: event.tool ?? "",
        leaseId: event.leaseId ?? "",
        version: event.version ?? 0,
        reason: event.reason ?? "",
      },
    });
}

function assembleLocalRuntimeStack(
  root: string,
  env: NodeJS.ProcessEnv,
  database: SqliteRuntimeDatabase,
  broker: CredentialBroker,
): LocalRuntimeStack {
  if (env.ANICODE_SANDBOX_FAIL_CLOSED === "0") {
    throw new Error("Production runtime does not allow ANICODE_SANDBOX_FAIL_CLOSED=0");
  }
  if (env.ANICODE_TRANSACTIONAL_SHELL === "0") {
    throw new Error("Production runtime does not allow ANICODE_TRANSACTIONAL_SHELL=0");
  }
  let artifacts: ArtifactStore | undefined;
  let networkProxy: NetworkProxy | undefined;
  let isolatedRuntime: ExecutionRuntime | undefined;
  try {
    const runtime = new DurableRuntime(
      new SqliteRuntimeEventStore(database),
      new SqliteRuntimeSnapshotStore(database),
    );
    networkProxy = new NetworkProxy({
      broker,
      policy: {
        allowDomains: csv(env.ANICODE_NETWORK_ALLOW_DOMAINS, ["*"]),
        denyDomains: csv(env.ANICODE_NETWORK_DENY_DOMAINS, []),
        allowPrivateAddresses: env.ANICODE_NETWORK_ALLOW_PRIVATE === "1",
        allowPorts: csv(env.ANICODE_NETWORK_ALLOW_PORTS, ["80", "443"])
          .map(Number)
          .filter((port) => Number.isInteger(port) && port > 0),
      },
      onAudit: (event) =>
        database.audit({
          category: "network",
          action: "authorize",
          subject: event.host,
          decision: event.decision,
          metadata: { url: event.url, reason: event.reason, addresses: event.addresses ?? [] },
        }),
    });
    const workerStore = new SqliteWorkerQueueStore(database);
    const executionMode = resolveLocalExecutionMode(env);
    const executionBackend: ExecutionRuntime =
      executionMode === "container"
        ? new ContainerIsolatedRuntime({
            image:
              env.ANICODE_RUNTIME_IMAGE ??
              (() => {
                throw new Error("ANICODE_RUNTIME_IMAGE is required for container execution");
              })(),
            ...(env.ANICODE_CONTAINER_ENGINE_BIN
              ? { engineExecutable: env.ANICODE_CONTAINER_ENGINE_BIN }
              : {}),
            ...(env.ANICODE_CONTAINER_ENGINE_ENDPOINT
              ? { engineEndpoint: env.ANICODE_CONTAINER_ENGINE_ENDPOINT }
              : {}),
            broker,
            ...(env.ANICODE_CONTAINER_NETWORK
              ? { internalNetwork: env.ANICODE_CONTAINER_NETWORK }
              : {}),
            ...(env.ANICODE_CONTAINER_PROXY_URL
              ? { proxyUrl: env.ANICODE_CONTAINER_PROXY_URL }
              : {}),
            // The production composition never accepts a mutable tag. Embedders that intentionally
            // need an unpinned development image can instantiate ContainerIsolatedRuntime directly.
            requirePinnedImage: true,
            orphanJournalPath: path.join(root, "container-orphans.json"),
          })
        : executionMode === "native-isolated"
          ? new IsolatedRuntime({
              failClosed: true,
              broker,
              ...(env.ANICODE_NETWORK_PROXY_URL ? { proxyUrl: env.ANICODE_NETWORK_PROXY_URL } : {}),
              requireProxy: true,
            })
          : new DisabledExecutionRuntime();
    isolatedRuntime =
      executionMode === "restricted"
        ? executionBackend
        : new TransactionalExecutionRuntime(executionBackend, {
            maxFiles: Number(env.ANICODE_TRANSACTIONAL_SHELL_MAX_FILES ?? 200_000),
            maxChangedBytes: Number(
              env.ANICODE_TRANSACTIONAL_SHELL_MAX_CHANGED_BYTES ?? 100 * 1024 * 1024,
            ),
          });
    artifacts =
      env.ANICODE_ARTIFACT_BACKEND === "s3"
        ? configuredS3ArtifactStoreFromEnv(env)
        : new SqliteArtifactStore(database);
    const providers = bindProviderRegistry({
      broker,
      networkProxy,
      environment: env,
      allowEnvironmentFallback: false,
    });
    const stack: LocalRuntimeStack = {
      runtime,
      database,
      broker,
      artifacts,
      sessions: new SqliteRuntimeSessionStore(database),
      commandInbox: new CommandInbox(new SqliteCommandInboxStore(database)),
      outbox: new DurableOutbox(new SqliteOutboxStore(database), runtime),
      networkProxy,
      executionMode,
      isolatedRuntime,
      workerQueue: new DurableWorkerQueue(workerStore),
      worktreeOwnership: new WorktreeOwnership(workerStore),
      providers,
      resolveProvider: providers.resolveProvider,
      resolveProviderAsync: providers.resolveProviderAsync,
      discoverModels: providers.discoverModels,
    };
    return stack;
  } catch (error) {
    void Promise.resolve(isolatedRuntime?.shutdown?.()).catch(() => undefined);
    void Promise.resolve(artifacts?.close?.()).catch(() => undefined);
    void networkProxy?.close().catch(() => undefined);
    throw error;
  }
}
