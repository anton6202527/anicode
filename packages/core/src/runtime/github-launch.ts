/** Production GitHub App control plane launcher. */

import { CredentialBroker, type CredentialAuditEvent } from "../security/credentials.js";
import { configuredSecretBackendFromEnv } from "../security/secret-backends.js";
import { GitHubAppInstallationTokenSource } from "./github-app.js";
import { GitHubDelivery, type GitHubAuditEvent } from "./github-delivery.js";
import {
  createGitHubAgentWorker,
  createGitHubWorkflowExecutor,
  GitHubWebhookController,
  GitHubWebhookServer,
} from "./github-webhook.js";
import { NetworkProxy } from "./network-proxy.js";
import { PostgresRuntimeDatabase, PostgresWorkerQueueStore } from "./postgres.js";
import { telemetryFromEnv } from "./telemetry.js";
import { DurableWorkerQueue } from "./worker.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positive(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be positive`);
  return value;
}

async function main(): Promise<void> {
  for (const name of [
    "DATABASE_URL",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_WEBHOOK_SECRET",
  ]) {
    if (process.env[name]) {
      delete process.env[name];
      throw new Error(`${name} is forbidden; use the configured Credential Broker backend`);
    }
  }
  if (!process.env.ANICODE_CREDENTIAL_BACKEND) {
    throw new Error("ANICODE_CREDENTIAL_BACKEND is required for GitHub control plane");
  }
  const owner = required("ANICODE_GITHUB_OWNER");
  const repo = required("ANICODE_GITHUB_REPO");
  const appId = required("ANICODE_GITHUB_APP_ID");
  const installationId = positive("ANICODE_GITHUB_INSTALLATION_ID");
  const apiBase = process.env.ANICODE_GITHUB_API_BASE ?? "https://api.github.com";
  const apiHost = new URL(apiBase).hostname;
  const backend = await configuredSecretBackendFromEnv({ ...process.env });
  const databaseUrl = await backend.get(
    process.env.ANICODE_DATABASE_CREDENTIAL_KEY ?? "runtime:DATABASE_URL",
  );
  if (!databaseUrl) throw new Error("PostgreSQL credential is missing from secret backend");
  const postgres = await PostgresRuntimeDatabase.open({
    connectionString: databaseUrl,
    max: Number(process.env.ANICODE_DATABASE_POOL_SIZE ?? 10),
    ssl: process.env.ANICODE_DATABASE_SSL === "0" ? false : undefined,
  });
  const broker = new CredentialBroker({
    onAudit: (event) => credentialAudit(postgres, event),
  });
  const privateKeyCredentialId = "github-app-private-key";
  const webhookSecretCredentialId = "github-webhook-secret";
  const telemetryEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  broker.registerAsyncReference({
    id: privateKeyCredentialId,
    backend,
    backendKey: process.env.ANICODE_GITHUB_PRIVATE_KEY_CREDENTIAL_KEY ?? "github:APP_PRIVATE_KEY",
    scopes: [
      {
        audiences: ["github-app-auth"],
        hosts: [apiHost],
        tools: ["sign-installation-token"],
      },
    ],
  });
  broker.registerAsyncReference({
    id: webhookSecretCredentialId,
    backend,
    backendKey: process.env.ANICODE_GITHUB_WEBHOOK_CREDENTIAL_KEY ?? "github:WEBHOOK_SECRET",
    scopes: [{ audiences: ["github-webhook"], tools: ["verify-signature"] }],
  });
  const telemetryCredentialId = process.env.ANICODE_OTEL_CREDENTIAL_ID?.trim();
  if (telemetryCredentialId) {
    if (!telemetryEndpoint) {
      throw new Error("ANICODE_OTEL_CREDENTIAL_ID requires OTEL_EXPORTER_OTLP_ENDPOINT");
    }
    broker.registerAsyncReference({
      id: telemetryCredentialId,
      backend,
      backendKey: process.env.ANICODE_OTEL_CREDENTIAL_KEY ?? telemetryCredentialId,
      scopes: [
        {
          audiences: ["telemetry:otlp"],
          hosts: [new URL(telemetryEndpoint).hostname],
        },
      ],
    });
  }
  const allowedDomains = [
    apiHost,
    ...(telemetryEndpoint ? [new URL(telemetryEndpoint).hostname] : []),
  ];
  const networkProxy = new NetworkProxy({
    broker,
    policy: {
      allowDomains: [...new Set(allowedDomains)],
      allowPorts: [443, 4318],
      allowPrivateAddresses: process.env.ANICODE_CONTROL_PLANE_ALLOW_PRIVATE === "1",
    },
    onAudit: (event) =>
      postgres.audit({
        category: "network",
        action: "authorize",
        subject: event.host,
        decision: event.decision,
        metadata: { url: event.url, reason: event.reason, addresses: event.addresses ?? [] },
      }),
  });
  const telemetry = telemetryFromEnv(process.env, {
    broker,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      networkProxy.fetch(input instanceof Request ? input.url : input, init)) as typeof fetch,
  });
  const tokenSource = new GitHubAppInstallationTokenSource({
    appId,
    installationId,
    owner,
    repo,
    broker,
    privateKeyCredentialId,
    proxy: networkProxy,
    apiBase,
  });
  const delivery = new GitHubDelivery({
    owner,
    repo,
    proxy: networkProxy,
    accessTokenProvider: tokenSource,
    apiBase,
    telemetry,
    onAudit: (event) => githubAudit(postgres, event),
  });
  const queue = new DurableWorkerQueue(new PostgresWorkerQueueStore(postgres));
  const controller = new GitHubWebhookController({
    broker,
    webhookSecretCredentialId,
    queue,
    delivery,
    telemetry,
    expectedRepository: `${owner}/${repo}`,
    expectedInstallationId: installationId,
    maxRepairAttempts: Number(process.env.ANICODE_GITHUB_MAX_ATTEMPTS ?? 3),
  });
  const server = new GitHubWebhookServer(
    controller,
    Number(process.env.ANICODE_GITHUB_MAX_WEBHOOK_BYTES ?? 2 * 1024 * 1024),
    () => postgres.healthCheck(),
  );
  const abort = new AbortController();
  const stop = () => {
    server.beginDrain();
    abort.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const endpoint = await server.listen(
    Number(process.env.PORT ?? 8081),
    process.env.HOST ?? "0.0.0.0",
  );
  console.error(`AniCode GitHub control plane listening on ${endpoint}`);
  const concurrency = Math.max(1, Number(process.env.ANICODE_GITHUB_WORKER_CONCURRENCY ?? 4));
  const execute = createGitHubWorkflowExecutor(delivery, {
    workflow: process.env.ANICODE_GITHUB_AGENT_WORKFLOW ?? "github-agent.yml",
    ref: process.env.ANICODE_GITHUB_WORKFLOW_REF ?? "main",
  });
  const workers = Array.from({ length: concurrency }, (_, index) =>
    createGitHubAgentWorker({
      id: `${process.env.ANICODE_GITHUB_WORKER_ID ?? `github-${process.pid}`}-${index}`,
      queue,
      delivery,
      execute,
      telemetry,
      leaseMs: Number(process.env.ANICODE_GITHUB_LEASE_MS ?? 60_000),
    }).run({ signal: abort.signal }),
  );
  await new Promise<void>((resolve) =>
    abort.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  await server.close();
  await Promise.all(workers);
  try {
    if (telemetry.shutdown) await telemetry.shutdown();
    else await telemetry.forceFlush?.();
  } catch {
    console.error("AniCode GitHub control plane: OTLP flush failed during shutdown");
  } finally {
    await networkProxy.close();
    await postgres.close();
  }
}

function credentialAudit(database: PostgresRuntimeDatabase, event: CredentialAuditEvent) {
  return database.audit({
    category: "credential",
    action: event.action,
    subject: event.credentialId,
    decision: event.success ? "success" : "failure",
    metadata: {
      audience: event.audience ?? "",
      host: event.host ?? "",
      tool: event.tool ?? "",
      version: event.version ?? 0,
      reason: event.reason ?? "",
    },
  });
}

function githubAudit(database: PostgresRuntimeDatabase, event: GitHubAuditEvent) {
  return database.audit({
    category: "github",
    action: event.operation,
    subject: event.path,
    decision: event.success ? "success" : "failure",
    metadata: {
      method: event.method,
      status: event.status ?? 0,
      traceId: event.traceId ?? "",
    },
  });
}

void main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
