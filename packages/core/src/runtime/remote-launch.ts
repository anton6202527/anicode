/** Production Remote Runtime launcher：PostgreSQL/SQLite queue + OIDC + ephemeral Kubernetes Jobs。 */

import * as path from "node:path";
import { CredentialBroker, isCredentialEnvironmentName } from "../security/credentials.js";
import { configuredSecretBackendFromEnv, type SecretBackend } from "../security/secret-backends.js";
import { ContainerIsolatedRuntime } from "./container-runtime.js";
import { KubernetesJobRuntime } from "./kubernetes-runtime.js";
import { PostgresRuntimeDatabase, PostgresWorkerQueueStore } from "./postgres.js";
import { createClaimRemoteRuntimeAuthorizer, RemoteRuntimeHttpServer } from "./remote-server.js";
import { createRemoteOidcAuthenticator } from "./remote-auth.js";
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
  const jwksUri = required("ANICODE_OIDC_JWKS_URI");
  const networkProxy = remoteControlPlaneProxy(credentials.broker, [jwksUri]);
  const telemetry = telemetryFromEnv(process.env, {
    broker: credentials.broker,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      networkProxy.fetch(input instanceof Request ? input.url : input, init)) as typeof fetch,
  });
  const postgres = await PostgresRuntimeDatabase.open({
    connectionString: credentials.databaseUrl,
    max: Number(process.env.ANICODE_DATABASE_POOL_SIZE ?? 10),
    ssl: process.env.ANICODE_DATABASE_SSL === "0" ? false : undefined,
  });
  const queue = new DurableWorkerQueue(new PostgresWorkerQueueStore(postgres));
  const proxyUrl = process.env.ANICODE_RUNTIME_PROXY_URL
    ? authenticatedProxyUrl(process.env.ANICODE_RUNTIME_PROXY_URL, credentials.proxyToken)
    : undefined;
  const executionRuntime =
    (process.env.ANICODE_REMOTE_EXECUTION ?? "kubernetes") === "kubernetes"
      ? new KubernetesJobRuntime({
          image: required("ANICODE_RUNTIME_IMAGE"),
          namespace: process.env.ANICODE_RUNTIME_NAMESPACE ?? "anicode-runtime",
          workspacePvc: required("ANICODE_WORKSPACE_PVC"),
          hostWorkspaceRoot: workspaceRoot,
          ...(proxyUrl ? { proxyUrl } : {}),
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
          ...(proxyUrl ? { proxyUrl } : {}),
          broker: credentials.broker,
        });
  const authenticate = createRemoteOidcAuthenticator({
    issuer: required("ANICODE_OIDC_ISSUER"),
    audience: required("ANICODE_OIDC_AUDIENCE")
      .split(",")
      .map((value) => value.trim()),
    jwksUri,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      networkProxy.fetch(input instanceof Request ? input.url : input, init)) as typeof fetch,
  });
  const server = new RemoteRuntimeHttpServer({
    queue,
    executionRuntime,
    workspaceRoot,
    authenticate,
    authorizer: createClaimRemoteRuntimeAuthorizer({
      tenantClaim: process.env.ANICODE_OIDC_TENANT_CLAIM ?? "tenant_id",
      workspaceClaim: process.env.ANICODE_OIDC_WORKSPACE_CLAIM ?? "anicode_workspaces",
      permissionClaim: process.env.ANICODE_OIDC_PERMISSION_CLAIM ?? "anicode_permissions",
      maxTimeoutMs: Number(process.env.ANICODE_REMOTE_MAX_TIMEOUT_MS ?? 15 * 60_000),
    }),
    readiness: async () => {
      await postgres.healthCheck();
      if (executionRuntime instanceof KubernetesJobRuntime) await executionRuntime.healthCheck();
      return { postgres: true, executionRuntime: true };
    },
    telemetry,
    workerId: process.env.ANICODE_REMOTE_WORKER_ID ?? `remote-${process.pid}`,
    leaseMs: Number(process.env.ANICODE_REMOTE_LEASE_MS ?? 60_000),
  });
  const controller = new AbortController();
  const stop = () => {
    server.beginDrain();
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const endpoint = await server.listen(
    Number(process.env.PORT ?? 8080),
    process.env.HOST ?? "0.0.0.0",
  );
  console.error(`AniCode Remote Runtime listening on ${endpoint}`);
  const worker = server.service.run({
    signal: controller.signal,
    concurrency: Number(process.env.ANICODE_REMOTE_WORKER_CONCURRENCY ?? 4),
  });
  await new Promise<void>((resolve) =>
    controller.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  await server.close();
  await worker;
  try {
    if (telemetry.shutdown) await telemetry.shutdown();
    else await telemetry.forceFlush?.();
  } catch {
    console.error("AniCode Remote Runtime: OTLP flush failed during shutdown");
  } finally {
    await networkProxy.close();
    await postgres.close();
  }
}

interface RemoteCredentials {
  databaseUrl: string;
  proxyToken: string;
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
  if (!process.env.ANICODE_CREDENTIAL_BACKEND)
    throw new Error("ANICODE_CREDENTIAL_BACKEND is required for Remote Runtime");
  const backend = await configuredSecretBackendFromEnv({ ...process.env });
  try {
    const databaseUrl = await backend.get(
      process.env.ANICODE_DATABASE_CREDENTIAL_KEY ?? "runtime:DATABASE_URL",
    );
    const proxyToken = await backend.get(
      process.env.ANICODE_PROXY_CLIENT_CREDENTIAL_KEY ?? "runtime:PROXY_CLIENT_TOKEN",
    );
    await registerRemoteTelemetryCredential(broker, backend);
    if (!databaseUrl) throw new Error("Remote Runtime PostgreSQL credential is missing");
    if (!proxyToken || proxyToken.length < 24) {
      throw new Error("Remote Runtime proxy client credential is missing or weak");
    }
    return { databaseUrl, proxyToken, broker };
  } finally {
    for (const name of Object.keys(process.env)) {
      if (isCredentialEnvironmentName(name)) delete process.env[name];
    }
  }
}

function authenticatedProxyUrl(value: string, token: string): string {
  const url = new URL(value);
  if (url.username || url.password) {
    throw new Error("ANICODE_RUNTIME_PROXY_URL must not contain inline credentials");
  }
  url.username = "anicode";
  url.password = token;
  return url.toString();
}

async function registerRemoteTelemetryCredential(
  broker: CredentialBroker,
  backend: SecretBackend,
): Promise<void> {
  const credentialId = process.env.ANICODE_OTEL_CREDENTIAL_ID?.trim();
  if (!credentialId) return;
  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) throw new Error("ANICODE_OTEL_CREDENTIAL_ID requires an OTLP endpoint");
  broker.registerAsyncReference({
    id: credentialId,
    backend,
    backendKey: process.env.ANICODE_OTEL_CREDENTIAL_KEY ?? credentialId,
    scopes: [{ audiences: ["telemetry:otlp"], hosts: [new URL(endpoint).hostname] }],
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
function remoteControlPlaneProxy(
  broker: CredentialBroker,
  requiredEndpoints: string[],
): NetworkProxy {
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
        ...new Set([
          ...requiredEndpoints.map((value) => new URL(value).hostname),
          ...(target ? [target.hostname] : []),
        ]),
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
