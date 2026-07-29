/** 生产宿主共用装配：持久事件/快照/inbox/outbox、Broker、受控网络与 worker。 */

import * as path from "node:path";
import {
  configureProviderCredentialBroker,
  configureProviderNetworkProxy,
} from "../provider/registry.js";
import {
  CredentialBroker,
  credentialBrokerFromBackend,
  credentialBrokerFromEnv,
  isCredentialEnvironmentName,
  type CredentialAuditEvent,
} from "../security/credentials.js";
import {
  configuredSecretBackendFromEnv,
  OsKeychainSecretBackend,
  type SecretBackend,
} from "../security/secret-backends.js";
import { CommandInbox, DurableOutbox } from "./commands.js";
import type { ISessionStore } from "../session.js";
import { DurableRuntime } from "./durable.js";
import { ContainerIsolatedRuntime } from "./container-runtime.js";
import { IsolatedRuntime, type ExecutionRuntime } from "./isolated-runtime.js";
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
  artifacts: SqliteArtifactStore;
  sessions: ISessionStore;
  commandInbox: CommandInbox;
  outbox: DurableOutbox;
  networkProxy: NetworkProxy;
  isolatedRuntime: ExecutionRuntime;
  workerQueue: DurableWorkerQueue;
  worktreeOwnership: WorktreeOwnership;
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
): LocalRuntimeStack {
  const kind = env.ANICODE_CREDENTIAL_BACKEND ?? "keychain";
  if (kind === "vault" || kind === "kms") {
    throw new Error(`${kind} credentials require createConfiguredLocalRuntimeStack()`);
  }
  const root = path.resolve(baseDir);
  const database = new SqliteRuntimeDatabase(path.join(root, "runtime.db"));
  const backend =
    kind === "memory"
      ? undefined
      : new OsKeychainSecretBackend(env.ANICODE_KEYCHAIN_SERVICE ?? "dev.anicode.credentials");
  // 读取后从传入环境移除；provider 只能经 broker trusted boundary 获取，shell 默认继承不到。
  const broker = credentialBrokerFromEnv(env, {
    remove: true,
    ...(backend ? { backend } : {}),
    onAudit: credentialAudit(database),
  });
  return assembleLocalRuntimeStack(root, env, database, broker);
}

/**
 * Vault/KMS/OIDC 生产装配。后端连接参数先复制，再从真实进程环境清除密钥型变量；
 * 长期值只从后端按 `env:NAME` 读取，宿主内仅保留运行所需的 broker materialization。
 */
export async function createConfiguredLocalRuntimeStack(
  baseDir: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { backend?: SecretBackend } = {},
): Promise<LocalRuntimeStack> {
  const kind = env.ANICODE_CREDENTIAL_BACKEND ?? "keychain";
  if (kind === "keychain" || kind === "memory") return createLocalRuntimeStack(baseDir, env);
  const root = path.resolve(baseDir);
  const database = new SqliteRuntimeDatabase(path.join(root, "runtime.db"));
  try {
    // OIDC provider 持有快照，清理 process.env 后仍能刷新工作负载身份 token。
    const backend = options.backend ?? (await configuredSecretBackendFromEnv({ ...env }));
    const explicit = csv(env.ANICODE_CREDENTIAL_KEYS, []);
    let discovered: string[] = [];
    if (backend.list) {
      try {
        discovered = (await backend.list())
          .filter((key) => key.startsWith("env:"))
          .map((key) => key.slice(4));
      } catch (error) {
        if (explicit.length === 0) throw error;
      }
    }
    const names = [...new Set([...explicit, ...discovered])].filter(isCredentialEnvironmentName);
    if (names.length === 0) {
      throw new Error(`${kind} backend returned no env:* credentials; set ANICODE_CREDENTIAL_KEYS`);
    }
    const broker = await credentialBrokerFromBackend(backend, names, {
      onAudit: credentialAudit(database),
    });
    // 原始 provider keys、GitHub OIDC request token、静态 cloud keys 等不再向子进程继承。
    for (const name of Object.keys(env)) {
      if (isCredentialEnvironmentName(name)) delete env[name];
    }
    return assembleLocalRuntimeStack(root, env, database, broker);
  } catch (error) {
    await database.close();
    throw error;
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
  configureProviderCredentialBroker(broker);
  const runtime = new DurableRuntime(
    new SqliteRuntimeEventStore(database),
    new SqliteRuntimeSnapshotStore(database),
  );
  const networkProxy = new NetworkProxy({
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
  configureProviderNetworkProxy(networkProxy);
  const workerStore = new SqliteWorkerQueueStore(database);
  const isolatedRuntime: ExecutionRuntime =
    env.ANICODE_EXECUTION_BACKEND === "container"
      ? new ContainerIsolatedRuntime({
          image:
            env.ANICODE_RUNTIME_IMAGE ??
            (() => {
              throw new Error("ANICODE_RUNTIME_IMAGE is required for container execution");
            })(),
          broker,
          ...(env.ANICODE_CONTAINER_NETWORK
            ? { internalNetwork: env.ANICODE_CONTAINER_NETWORK }
            : {}),
          ...(env.ANICODE_CONTAINER_PROXY_URL ? { proxyUrl: env.ANICODE_CONTAINER_PROXY_URL } : {}),
          requirePinnedImage: env.ANICODE_ALLOW_UNPINNED_RUNTIME_IMAGE !== "1",
        })
      : new IsolatedRuntime({
          failClosed: env.ANICODE_SANDBOX_FAIL_CLOSED !== "0",
          broker,
          ...(env.ANICODE_NETWORK_PROXY_URL ? { proxyUrl: env.ANICODE_NETWORK_PROXY_URL } : {}),
          requireProxy: true,
        });
  return {
    runtime,
    database,
    broker,
    artifacts: new SqliteArtifactStore(database),
    sessions: new SqliteRuntimeSessionStore(database),
    commandInbox: new CommandInbox(new SqliteCommandInboxStore(database)),
    outbox: new DurableOutbox(new SqliteOutboxStore(database), runtime),
    networkProxy,
    isolatedRuntime,
    workerQueue: new DurableWorkerQueue(workerStore),
    worktreeOwnership: new WorktreeOwnership(workerStore),
  };
}
