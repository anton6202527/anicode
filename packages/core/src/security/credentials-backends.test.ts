import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialBroker, type CredentialAuditEvent } from "./credentials.js";
import {
  VaultJwtTokenProvider,
  configuredSecretBackendFromEnv,
  githubActionsOidcProvider,
  type SyncSecretBackend,
} from "./secret-backends.js";
import { CredentialRotationManager } from "./rotation.js";

class MemorySecretBackend implements SyncSecretBackend {
  readonly kind = "test-memory";
  readonly values = new Map<string, string>();
  getSync(key: string): string | undefined {
    return this.values.get(key);
  }
  putSync(key: string, value: string): void {
    this.values.set(key, value);
  }
  deleteSync(key: string): boolean {
    return this.values.delete(key);
  }
  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }
  async put(key: string, value: string): Promise<void> {
    this.putSync(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.deleteSync(key);
  }
}

test("Credential Broker: 后端引用、轮换、旧 lease 撤销和审计", () => {
  const backend = new MemorySecretBackend();
  backend.putSync("github", "token-v1");
  const audit: CredentialAuditEvent[] = [];
  const broker = new CredentialBroker({
    onAudit: (event) => {
      audit.push(event);
    },
  });
  broker.registerReference({
    id: "github",
    backend,
    scopes: [
      { audiences: ["github-delivery"], hosts: ["api.github.com"], header: "authorization" },
    ],
  });
  const oldLease = broker.lease({
    credentialId: "github",
    audience: "github-delivery",
    host: "api.github.com",
  });
  assert.equal(broker.rotate("github", "token-v2"), 2);
  assert.equal(backend.getSync("github"), "token-v2");
  assert.throws(() => broker.injectHeaders(oldLease), /expired|exhausted/);
  const next = broker.lease({
    credentialId: "github",
    audience: "github-delivery",
    host: "api.github.com",
  });
  assert.equal(broker.injectHeaders(next).get("authorization"), "token-v2");
  assert.deepEqual(
    audit.map((event) => event.action),
    ["register", "lease", "rotate", "lease", "consume"],
  );
});

test("OIDC: GitHub Actions token exchange + Vault JWT token 缓存", async () => {
  let oidcCalls = 0;
  const oidc = githubActionsOidcProvider(
    {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    },
    (async (url, init) => {
      oidcCalls++;
      assert.equal(new URL(String(url)).searchParams.get("audience"), "vault");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer request-token");
      return Response.json({ value: "short-jwt" });
    }) as typeof fetch,
  );
  let vaultCalls = 0;
  const provider = new VaultJwtTokenProvider({
    address: "https://vault.example",
    role: "anicode",
    audience: "vault",
    oidc,
    fetch: (async (_url, init) => {
      vaultCalls++;
      assert.match(String(init?.body), /short-jwt/);
      return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } });
    }) as typeof fetch,
  });
  assert.equal(await provider.token(), "vault-token");
  assert.equal(await provider.token(), "vault-token");
  assert.equal(oidcCalls, 1);
  assert.equal(vaultCalls, 1);
});

test("CredentialRotationManager: 后端先更新、旧租约撤销并写审计", async () => {
  const backend = new MemorySecretBackend();
  backend.putSync("github", "token-v1");
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "github",
    backend,
    scopes: [{ audiences: ["github"], header: "authorization" }],
  });
  const oldLease = broker.lease({ credentialId: "github", audience: "github" });
  const audit: { success: boolean; version?: number }[] = [];
  const manager = new CredentialRotationManager(broker, (event) => {
    audit.push(event);
  });
  manager.register({
    credentialId: "github",
    backend,
    intervalMs: 60_000,
    issue: async () => "token-v2",
  });
  assert.equal(await manager.rotateNow("github"), 2);
  assert.equal(backend.getSync("github"), "token-v2");
  assert.throws(() => broker.injectHeaders(oldLease), /expired|exhausted/);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.success, true);
  assert.equal(audit[0]?.version, 2);
});

test("KMS: 拒绝进程级静态 AWS 密钥，要求 workload identity", async () => {
  await assert.rejects(
    configuredSecretBackendFromEnv({
      ANICODE_CREDENTIAL_BACKEND: "kms",
      ANICODE_KMS_KEY_ID: "arn:aws:kms:region:account:key/example",
      AWS_ACCESS_KEY_ID: "static-key",
      AWS_SECRET_ACCESS_KEY: "static-secret",
    }),
    /AWS_ACCESS_KEY_ID is forbidden.*workload identity/,
  );
});
