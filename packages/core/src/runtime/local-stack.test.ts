import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  configureProviderCredentialBroker,
  configureProviderNetworkProxy,
  registerOpenAICompatibleProvider,
} from "../provider/registry.js";
import {
  createConfiguredLocalRuntimeStack,
  createLocalRuntimeStack,
  resolveLocalExecutionMode,
} from "./local-stack.js";
import type { SecretBackend } from "../security/secret-backends.js";
import { DisabledExecutionRuntime } from "./isolated-runtime.js";

test("LocalRuntimeStack: unsupported native hosts fail closed unless a container is selected", async () => {
  assert.equal(resolveLocalExecutionMode({}, "win32"), "restricted");
  assert.equal(
    resolveLocalExecutionMode({ ANICODE_EXECUTION_BACKEND: "native" }, "win32"),
    "restricted",
  );
  assert.equal(
    resolveLocalExecutionMode({ ANICODE_EXECUTION_BACKEND: "container" }, "win32"),
    "container",
  );
  assert.throws(
    () => resolveLocalExecutionMode({ ANICODE_EXECUTION_BACKEND: "powershell" }, "win32"),
    /Unsupported ANICODE_EXECUTION_BACKEND/,
  );

  const runtime = new DisabledExecutionRuntime("windows process execution blocked");
  assert.equal("prepare" in runtime, false);
  await assert.rejects(
    () =>
      runtime.run({
        command: "whoami",
        cwd: process.cwd(),
      }),
    /windows process execution blocked/,
  );
});

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

test("LocalRuntimeStack: parallel stacks keep provider credentials and discovery egress isolated", async () => {
  registerOpenAICompatibleProvider({
    id: "stack-isolation",
    baseURL: "https://models.example.test/v1",
    apiKeyEnv: "STACK_ISOLATION_API_KEY",
  });
  const [rootA, rootB] = await Promise.all([
    fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-a-")),
    fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-b-")),
  ]);
  const stackA = createLocalRuntimeStack(rootA, {
    ANICODE_CREDENTIAL_BACKEND: "memory",
    STACK_ISOLATION_API_KEY: "secret-stack-a",
  });
  const stackB = createLocalRuntimeStack(rootB, {
    ANICODE_CREDENTIAL_BACKEND: "memory",
    STACK_ISOLATION_API_KEY: "secret-stack-b",
  });
  const observedA: string[] = [];
  const observedB: string[] = [];
  stackA.networkProxy.fetch = (async (_url: string | URL, init?: RequestInit) => {
    observedA.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ data: [{ id: "model-a" }] });
  }) as typeof stackA.networkProxy.fetch;
  stackB.networkProxy.fetch = (async (_url: string | URL, init?: RequestInit) => {
    observedB.push(new Headers(init?.headers).get("authorization") ?? "");
    return Response.json({ data: [{ id: "model-b" }] });
  }) as typeof stackB.networkProxy.fetch;

  try {
    const [modelsA, modelsB] = await Promise.all([
      stackA.discoverModels("stack-isolation"),
      stackB.discoverModels("stack-isolation"),
    ]);
    assert.deepEqual(modelsA, ["model-a"]);
    assert.deepEqual(modelsB, ["model-b"]);
    assert.deepEqual(observedA, ["Bearer secret-stack-a"]);
    assert.deepEqual(observedB, ["Bearer secret-stack-b"]);
    assert.equal(
      stackA.resolveProvider("stack-isolation/model-a").diagnostics.hasCredentials,
      true,
    );
    assert.equal(
      stackB.resolveProvider("stack-isolation/model-b").diagnostics.hasCredentials,
      true,
    );
  } finally {
    await Promise.all([
      stackA.networkProxy.close(),
      stackB.networkProxy.close(),
      stackA.database.close(),
      stackB.database.close(),
    ]);
    await Promise.all([
      fs.rm(rootA, { recursive: true, force: true }),
      fs.rm(rootB, { recursive: true, force: true }),
    ]);
  }
});
