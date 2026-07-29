/** Production Remote Runtime launcher：PostgreSQL/SQLite queue + OIDC + ephemeral Kubernetes Jobs。 */

import * as path from "node:path";
import { CredentialBroker, isCredentialEnvironmentName } from "../security/credentials.js";
import { configuredSecretBackendFromEnv, type SecretBackend } from "../security/secret-backends.js";
import { ContainerIsolatedRuntime } from "./container-runtime.js";
import { KubernetesJobRuntime } from "./kubernetes-runtime.js";
import { PostgresRuntimeDatabase, PostgresWorkerQueueStore } from "./postgres.js";
import { RemoteRuntimeHttpServer } from "./remote-server.js";
import { createRemoteOidcAuthenticator } from "./remote-auth.js";
import { SqliteRuntimeDatabase, SqliteWorkerQueueStore } from "./sqlite.js";
import { telemetryFromEnv } from "./telemetry.js";
import { NetworkProxy } from "./network-proxy.js";
import { DurableWorkerQueue } from "./worker.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(): Promise<void> {
  const workspaceRoot = path.resolve(process.env.ANICODE_REMOTE_WORKSPACE_ROOT ?? "/workspaces");
  const credentials = await runtimeCredentials();
  const networkProxy = remoteControlPlaneProxy(credentials.broker);
  const telemetry = telemetryFromEnv(process.env, {
    broker: credentials.broker,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      networkProxy.fetch(input instanceof Request ? input.url : input, init)) as typeof fetch,
  });
  const databaseUrl = credentials.databaseUrl;
  const postgres = databaseUrl
    ? await PostgresRuntimeDatabase.open({
        connectionString: databaseUrl,
        max: Number(process.env.ANICODE_DATABASE_POOL_SIZE ?? 10),
        ssl: process.env.ANICODE_DATABASE_SSL === "0" ? false : undefined,
      })
    : undefined;
  const sqlite = postgres
    ? undefined
    : new SqliteRuntimeDatabase(
        path.resolve(process.env.ANICODE_RUNTIME_DATABASE ?? "/tmp/anicode/remote-runtime.db"),
      );
  const queue = new DurableWorkerQueue(
    postgres ? new PostgresWorkerQueueStore(postgres) : new SqliteWorkerQueueStore(sqlite!),
  );
  const executionRuntime =
    (process.env.ANICODE_REMOTE_EXECUTION ?? "kubernetes") === "kubernetes"
      ? new KubernetesJobRuntime({
          image: required("ANICODE_RUNTIME_IMAGE"),
          namespace: process.env.ANICODE_RUNTIME_NAMESPACE ?? "anicode-runtime",
          workspacePvc: required("ANICODE_WORKSPACE_PVC"),
          hostWorkspaceRoot: workspaceRoot,
          ...(process.env.ANICODE_RUNTIME_PROXY_URL
            ? { proxyUrl: process.env.ANICODE_RUNTIME_PROXY_URL }
            : {}),
          serviceAccount: process.env.ANICODE_RUNNER_SERVICE_ACCOUNT ?? "anicode-runner",
          ephemeralWorkspace: process.env.ANICODE_EPHEMERAL_WORKSPACE !== "0",
          workspaceSizeLimit: process.env.ANICODE_WORKSPACE_SIZE_LIMIT ?? "10Gi",
        })
      : new ContainerIsolatedRuntime({
          image: required("ANICODE_RUNTIME_IMAGE"),
          engine: process.env.ANICODE_CONTAINER_ENGINE === "podman" ? "podman" : "docker",
          ...(process.env.ANICODE_CONTAINER_NETWORK
            ? { internalNetwork: process.env.ANICODE_CONTAINER_NETWORK }
            : {}),
          ...(process.env.ANICODE_RUNTIME_PROXY_URL
            ? { proxyUrl: process.env.ANICODE_RUNTIME_PROXY_URL }
            : {}),
        });
  const authenticate = createRemoteOidcAuthenticator({
    issuer: required("ANICODE_OIDC_ISSUER"),
    audience: required("ANICODE_OIDC_AUDIENCE")
      .split(",")
      .map((value) => value.trim()),
    jwksUri: required("ANICODE_OIDC_JWKS_URI"),
  });
  const server = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime,
    workspaceRoot,
    authenticate,
    telemetry,
    workerId: process.env.ANICODE_REMOTE_WORKER_ID ?? `remote-${process.pid}`,
    leaseMs: Number(process.env.ANICODE_REMOTE_LEASE_MS ?? 60_000),
  });
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const endpoint = await server.listen(
    Number(process.env.PORT ?? 8080),
    process.env.HOST ?? "0.0.0.0",
  );
  console.error(`AniCode Remote Runtime listening on ${endpoint}`);
  const worker = server.service.run({ signal: controller.signal });
  await new Promise<void>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  await server.close();
  await worker;
  await telemetry.forceFlush?.();
  await networkProxy.close();
  await postgres?.close();
  await sqlite?.close();
}

interface RemoteCredentials {
  databaseUrl?: string;
  broker: CredentialBroker;
}

async function runtimeCredentials(): Promise<RemoteCredentials> {
  const legacy = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  if (legacy) {
    throw new Error(
      "DATABASE_URL is forbidden in the process environment; store runtime:DATABASE_URL in Keychain/Vault/KMS",
    );
  }
  const broker = new CredentialBroker();
  if (!process.env.ANICODE_CREDENTIAL_BACKEND) {
    if (process.env.ANICODE_OTEL_CREDENTIAL_ID) {
      throw new Error("ANICODE_OTEL_CREDENTIAL_ID requires a configured credential backend");
    }
    return { broker };
  }
  const backend = await configuredSecretBackendFromEnv({ ...process.env });
  try {
    const databaseUrl = await backend.get(
      process.env.ANICODE_DATABASE_CREDENTIAL_KEY ?? "runtime:DATABASE_URL",
    );
    await registerRemoteTelemetryCredential(broker, backend);
    return { ...(databaseUrl ? { databaseUrl } : {}), broker };
  } finally {
    for (const name of Object.keys(process.env)) {
      if (isCredentialEnvironmentName(name)) delete process.env[name];
    }
  }
}

async function registerRemoteTelemetryCredential(
  broker: CredentialBroker,
  backend: SecretBackend,
): Promise<void> {
  const credentialId = process.env.ANICODE_OTEL_CREDENTIAL_ID?.trim();
  if (!credentialId) return;
  await broker.registerFromBackend({
    id: credentialId,
    backend,
    backendKey: credentialId,
    scopes: [{ audiences: ["telemetry:otlp"], hosts: ["*"] }],
  });
}

function csv(value: string | undefined, fallback: string[]): string[] {
  const parsed = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed?.length ? parsed : fallback;
}

/** 控制面自身的 HTTP 出口（OTLP）；runner 仍由 CNI 的 default-deny 做 OS 级强制。 */
function remoteControlPlaneProxy(broker: CredentialBroker): NetworkProxy {
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const target = endpoint ? new URL(endpoint) : undefined;
  const inferredPort = target
    ? Number(target.port || (target.protocol === "https:" ? 443 : 80))
    : 443;
  return new NetworkProxy({
    broker,
    policy: {
      allowDomains: csv(process.env.ANICODE_CONTROL_PLANE_NETWORK_ALLOW_DOMAINS, [
        target?.hostname ?? "*",
      ]),
      denyDomains: csv(process.env.ANICODE_CONTROL_PLANE_NETWORK_DENY_DOMAINS, []),
      allowPorts: csv(process.env.ANICODE_CONTROL_PLANE_NETWORK_ALLOW_PORTS, [String(inferredPort)])
        .map(Number)
        .filter((port) => Number.isInteger(port) && port > 0),
      // Cluster-local collectors resolve to private service IPs; hostname + port remain allowlisted.
      allowPrivateAddresses: process.env.ANICODE_CONTROL_PLANE_ALLOW_PRIVATE !== "0",
    },
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
