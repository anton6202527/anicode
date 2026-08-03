import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureProviderCredentialBroker,
  configureProviderNetworkProxy,
} from "../provider/registry.js";
import { createLocalRuntimeStack } from "./local-stack.js";
import { createConfiguredLocalRuntimeStack } from "./local-stack.js";
import type { SecretBackend } from "../security/secret-backends.js";

test("LocalRuntimeStack: 密钥迁入 Broker，运行态在 SQLite 严格事务持久化", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-"));
  const env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "sk-test-secret",
    AWS_ACCESS_KEY_ID: "AKIA_TEST_ONLY",
    ANICODE_NETWORK_ALLOW_DOMAINS: "93.184.216.34",
    ANICODE_CREDENTIAL_BACKEND: "memory",
  };
  const stack = createLocalRuntimeStack(root, env);
  try {
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.ANICODE_CREDENTIAL_BACKEND, "memory");
    const command = await stack.commandInbox.accept({ sessionId: "s1", text: "continue" });
    await stack.outbox.publish({
      streamId: "s1",
      type: "prompt.accepted",
      data: { commandId: command.id },
      idempotencyKey: "stack-event",
    });
    assert.equal((await stack.runtime.events("s1")).length, 1);
    assert.equal((await fs.stat(path.join(root, "runtime.db"))).isFile(), true);
    assert.equal(
      (await stack.networkProxy.authorize("https://93.184.216.34/docs")).url.hostname,
      "93.184.216.34",
    );
    assert.ok((await stack.database.auditLog()).some((event) => event.category === "network"));
  } finally {
    await stack.database.close();
    configureProviderCredentialBroker(undefined);
    configureProviderNetworkProxy(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ConfiguredLocalRuntimeStack: Vault/KMS 风格后端发现 env:* 并清理进程密钥", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-backend-"));
  const values = new Map([["env:OPENAI_API_KEY", "backend-secret"]]);
  const backend: SecretBackend = {
    kind: "test-vault",
    get: async (key) => values.get(key),
    put: async (key, value) => void values.set(key, value),
    delete: async (key) => values.delete(key),
    list: async () => [...values.keys()],
  };
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_BACKEND: "vault",
    OPENAI_API_KEY: "must-be-removed",
  };
  const stack = await createConfiguredLocalRuntimeStack(root, env, { backend });
  try {
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANICODE_CREDENTIAL_BACKEND, "vault");
    assert.equal(
      stack.broker.trustedValue("env:OPENAI_API_KEY", {
        audience: "provider:openai",
        host: "api.openai.com",
      }),
      "backend-secret",
    );
    assert.ok((await stack.database.auditLog()).some((event) => event.category === "credential"));
  } finally {
    await stack.database.close();
    configureProviderCredentialBroker(undefined);
    configureProviderNetworkProxy(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
