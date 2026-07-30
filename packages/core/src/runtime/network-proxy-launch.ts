/** Kubernetes/容器专用受控出口代理 launcher。 */

import { CredentialBroker, isCredentialEnvironmentName } from "../security/credentials.js";
import { configuredSecretBackendFromEnv } from "../security/secret-backends.js";
import { NetworkProxy, NetworkProxyServer } from "./network-proxy.js";

function csv(value: string | undefined, fallback: string[]): string[] {
  const parsed = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed?.length ? parsed : fallback;
}

async function proxyClientTokenProvider(): Promise<() => Promise<string>> {
  if (process.env.ANICODE_PROXY_CLIENT_TOKEN) {
    delete process.env.ANICODE_PROXY_CLIENT_TOKEN;
    throw new Error(
      "ANICODE_PROXY_CLIENT_TOKEN is forbidden; store runtime:PROXY_CLIENT_TOKEN in Keychain/Vault/KMS",
    );
  }
  if (!process.env.ANICODE_CREDENTIAL_BACKEND) {
    throw new Error("ANICODE_CREDENTIAL_BACKEND is required for the egress proxy");
  }
  const backend = await configuredSecretBackendFromEnv({ ...process.env });
  const backendKey =
    process.env.ANICODE_PROXY_CLIENT_CREDENTIAL_KEY ?? "runtime:PROXY_CLIENT_TOKEN";
  const credentialId = "network-proxy-client";
  const broker = new CredentialBroker({
    onAudit: (event) => console.error(JSON.stringify({ kind: "credential.audit", ...event })),
  });
  broker.registerAsyncReference({
    id: credentialId,
    backend,
    backendKey,
    scopes: [{ audiences: ["network-proxy-client"], tools: ["authenticate"] }],
  });
  const read = async () => {
    const token = await broker.trustedValueAsync(credentialId, {
      audience: "network-proxy-client",
      tool: "authenticate",
    });
    if (token.length < 24) throw new Error("Egress proxy client credential is missing or weak");
    return token;
  };
  try {
    await read();
    return read;
  } finally {
    for (const name of Object.keys(process.env)) {
      if (isCredentialEnvironmentName(name)) delete process.env[name];
    }
  }
}

async function main(): Promise<void> {
  const clientTokenProvider = await proxyClientTokenProvider();
  const proxy = new NetworkProxy({
    policy: {
      // 生产出口默认 deny-all；部署必须明确列出域名，不能靠“所有公网均可达”。
      allowDomains: csv(process.env.ANICODE_NETWORK_ALLOW_DOMAINS, []),
      denyDomains: csv(process.env.ANICODE_NETWORK_DENY_DOMAINS, []),
      allowPorts: csv(process.env.ANICODE_NETWORK_ALLOW_PORTS, ["80", "443"]).map(Number),
      allowPrivateAddresses: process.env.ANICODE_NETWORK_ALLOW_PRIVATE === "1",
    },
    onAudit: (event) => console.error(JSON.stringify({ kind: "network.audit", ...event })),
  });
  const server = new NetworkProxyServer({
    proxy,
    clientTokenProvider,
    host: process.env.HOST ?? "0.0.0.0",
    port: Number(process.env.PORT ?? 8080),
    maxRequestBytes: Number(process.env.ANICODE_PROXY_MAX_REQUEST_BYTES ?? 8 * 1024 * 1024),
    maxResponseBytes: Number(process.env.ANICODE_PROXY_MAX_RESPONSE_BYTES ?? 32 * 1024 * 1024),
    requestTimeoutMs: Number(process.env.ANICODE_PROXY_REQUEST_TIMEOUT_MS ?? 120_000),
    maxTunnelDurationMs: Number(process.env.ANICODE_PROXY_MAX_TUNNEL_MS ?? 10 * 60_000),
    maxTunnelBytes: Number(process.env.ANICODE_PROXY_MAX_TUNNEL_BYTES ?? 256 * 1024 * 1024),
    maxConcurrentTunnels: Number(process.env.ANICODE_PROXY_MAX_TUNNELS ?? 128),
  });
  const endpoint = await server.listen();
  console.error(`AniCode egress proxy listening on ${endpoint}`);
  const shutdown = async () => {
    await server.close();
    await proxy.close();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
