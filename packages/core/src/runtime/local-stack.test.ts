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
import { OsKeychainDisabledError, type SecretBackend } from "../security/secret-backends.js";
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

test("LocalRuntimeStack: production factories reject sandbox and transaction downgrade switches", async () => {
  for (const environment of [
    { ANICODE_SANDBOX_FAIL_CLOSED: "0" },
    { ANICODE_TRANSACTIONAL_SHELL: "0" },
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-downgrade-"));
    const env: NodeJS.ProcessEnv = {
      ANICODE_CREDENTIAL_BACKEND: "memory",
      OPENAI_API_KEY: "must-survive-construction-failure",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "control-secret-must-also-survive",
      ...environment,
    };
    try {
      assert.throws(() => createLocalRuntimeStack(root, env), /Production runtime does not allow/);
      assert.equal(env.OPENAI_API_KEY, "must-survive-construction-failure");
      assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "control-secret-must-also-survive");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("LocalRuntimeStack: explicit no-Keychain sentinel fails before runtime construction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-no-keychain-"));
  try {
    assert.throws(
      () =>
        createLocalRuntimeStack(root, {
          ANICODE_CREDENTIAL_BACKEND: "keychain",
          ANICODE_DISABLE_OS_KEYCHAIN: "1",
          OPENAI_API_KEY: "must-stay-process-only",
        }),
      OsKeychainDisabledError,
    );
    assert.deepEqual(await fs.readdir(root), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LocalRuntimeStack: 密钥迁入 Broker，运行态在 SQLite 严格事务持久化", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-"));
  const env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "sk-test-secret",
    AWS_ACCESS_KEY_ID: "AKIA_TEST_ONLY",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-control-secret",
    ANICODE_NETWORK_ALLOW_DOMAINS: "93.184.216.34",
    ANICODE_CREDENTIAL_BACKEND: "memory",
  };
  const stack = createLocalRuntimeStack(root, env);
  try {
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
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

test("ConfiguredLocalRuntimeStack: failed assembly leaves the caller environment unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-backend-failure-"));
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_BACKEND: "vault",
    ANICODE_CREDENTIAL_KEYS: "ANTHROPIC_API_KEY",
    OPENAI_API_KEY: "inline-secret-must-remain",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "control-secret-must-remain",
    ANICODE_SANDBOX_FAIL_CLOSED: "0",
  };
  const backend: SecretBackend = {
    kind: "test-vault",
    get: async () => "backend-secret",
    put: async () => undefined,
    delete: async () => false,
  };
  try {
    await assert.rejects(
      createConfiguredLocalRuntimeStack(root, env, { backend }),
      /Production runtime does not allow/,
    );
    assert.equal(env.OPENAI_API_KEY, "inline-secret-must-remain");
    assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "control-secret-must-remain");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ConfiguredLocalRuntimeStack: compare-and-delete preserves concurrently replaced secrets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-env-race-"));
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_BACKEND: "vault",
    ANICODE_CREDENTIAL_KEYS: "ANTHROPIC_API_KEY",
    OPENAI_API_KEY: "original-inline-secret",
  };
  const backend: SecretBackend = {
    kind: "test-vault",
    get: async () => {
      env.OPENAI_API_KEY = "concurrently-replaced-secret";
      return "backend-secret";
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const stack = await createConfiguredLocalRuntimeStack(root, env, { backend });
  try {
    assert.equal(env.OPENAI_API_KEY, "concurrently-replaced-secret");
    assert.equal(
      stack.broker.trustedValue("env:OPENAI_API_KEY", {
        audience: "provider:openai",
        host: "api.openai.com",
      }),
      "original-inline-secret",
    );
  } finally {
    await stack.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ConfiguredLocalRuntimeStack: Vault/KMS only reads explicitly named keys without listing", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-backend-"));
  const values = new Map([
    ["env:OPENAI_API_KEY", "old-backend-secret"],
    ["env:ANTHROPIC_API_KEY", "backend-anthropic-secret"],
  ]);
  let listCalls = 0;
  const getCalls: string[] = [];
  const backend: SecretBackend = {
    kind: "test-vault",
    get: async (key) => {
      getCalls.push(key);
      return values.get(key);
    },
    put: async (key, value) => void values.set(key, value),
    delete: async (key) => values.delete(key),
    list: async () => {
      listCalls++;
      throw new Error("credential enumeration must not be called");
    },
  };
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_BACKEND: "vault",
    ANICODE_CREDENTIAL_KEYS: "OPENAI_API_KEY,ANTHROPIC_API_KEY",
    OPENAI_API_KEY: "must-be-removed",
  };
  const stack = await createConfiguredLocalRuntimeStack(root, env, { backend });
  try {
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANICODE_CREDENTIAL_BACKEND, "vault");
    assert.equal(listCalls, 0);
    assert.deepEqual(getCalls, ["env:ANTHROPIC_API_KEY"]);
    assert.equal(
      stack.broker.trustedValue("env:OPENAI_API_KEY", {
        audience: "provider:openai",
        host: "api.openai.com",
      }),
      "must-be-removed",
    );
    assert.equal(
      stack.broker.trustedValue("env:ANTHROPIC_API_KEY", {
        audience: "provider:anthropic",
        host: "api.anthropic.com",
      }),
      "backend-anthropic-secret",
    );
    assert.ok((await stack.database.auditLog()).some((event) => event.category === "credential"));
  } finally {
    await stack.database.close();
    configureProviderCredentialBroker(undefined);
    configureProviderNetworkProxy(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ConfiguredLocalRuntimeStack: injected async Keychain remains lazy until selected provider use", async () => {
  registerOpenAICompatibleProvider({
    id: "async-keychain-fixture",
    baseURL: "https://async-keychain.example.test/v1",
    apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-async-keychain-"));
  const getCalls: string[] = [];
  const backend: SecretBackend = {
    kind: "test-utility-keychain",
    get: async (key) => {
      getCalls.push(key);
      return key === "env:CUSTOM_OPENAI_API_KEY" ? "utility-process-secret" : undefined;
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const stack = await createConfiguredLocalRuntimeStack(
    root,
    {
      ANICODE_CREDENTIAL_BACKEND: "keychain",
      ANICODE_CREDENTIAL_KEYS: "CUSTOM_OPENAI_API_KEY",
    },
    { backend },
  );
  try {
    assert.deepEqual(getCalls, []);
    assert.equal(
      stack.providers.inspectProvider("async-keychain-fixture/model").diagnostics
        .credentialAvailability,
      "configured",
    );
    assert.equal(stack.providers.resolveDefaultModel(), "debug/demo");
    assert.deepEqual(getCalls, []);

    const resolved = await stack.resolveProviderAsync("async-keychain-fixture/model");
    assert.equal(resolved.diagnostics.hasCredentials, true);
    assert.deepEqual(getCalls, ["env:CUSTOM_OPENAI_API_KEY"]);

    await stack.resolveProviderAsync("async-keychain-fixture/model");
    assert.deepEqual(getCalls, ["env:CUSTOM_OPENAI_API_KEY"]);
  } finally {
    await stack.networkProxy.close();
    await stack.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("LocalRuntimeStack: parallel stacks keep provider credentials and discovery egress isolated", async () => {
  registerOpenAICompatibleProvider({
    id: "stack-isolation",
    baseURL: "https://models.example.test/v1",
    apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
  });
  const [rootA, rootB] = await Promise.all([
    fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-a-")),
    fs.mkdtemp(path.join(os.tmpdir(), "anicode-stack-b-")),
  ]);
  const stackA = createLocalRuntimeStack(rootA, {
    ANICODE_CREDENTIAL_BACKEND: "memory",
    CUSTOM_OPENAI_API_KEY: "secret-stack-a",
  });
  const stackB = createLocalRuntimeStack(rootB, {
    ANICODE_CREDENTIAL_BACKEND: "memory",
    CUSTOM_OPENAI_API_KEY: "secret-stack-b",
  });
  const observedA: string[] = [];
  const observedB: string[] = [];
  const chatResponse = () =>
    new Response(
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
      })}\n\ndata: ${JSON.stringify({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })}\n\ndata: [DONE]\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  stackA.networkProxy.fetch = (async (url: string | URL, init?: RequestInit) => {
    observedA.push(new Headers(init?.headers).get("authorization") ?? "");
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "model-a" }] })
      : chatResponse();
  }) as typeof stackA.networkProxy.fetch;
  stackB.networkProxy.fetch = (async (url: string | URL, init?: RequestInit) => {
    observedB.push(new Headers(init?.headers).get("authorization") ?? "");
    return String(url).endsWith("/models")
      ? Response.json({ data: [{ id: "model-b" }] })
      : chatResponse();
  }) as typeof stackB.networkProxy.fetch;

  try {
    const [modelsA, modelsB] = await Promise.all([
      stackA.discoverModels("stack-isolation"),
      stackB.discoverModels("stack-isolation"),
    ]);
    assert.deepEqual(modelsA, ["model-a"]);
    assert.deepEqual(modelsB, ["model-b"]);
    const resolvedA = stackA.resolveProvider("stack-isolation/model-a");
    const resolvedB = stackB.resolveProvider("stack-isolation/model-b");
    assert.equal(resolvedA.diagnostics.hasCredentials, true);
    assert.equal(resolvedB.diagnostics.hasCredentials, true);
    for await (const _event of resolvedA.provider.stream({
      model: resolvedA.model,
      messages: [],
    })) {
      // consume the complete fixture stream
    }
    for await (const _event of resolvedB.provider.stream({
      model: resolvedB.model,
      messages: [],
    })) {
      // consume the complete fixture stream
    }
    assert.deepEqual(observedA, ["Bearer secret-stack-a", "Bearer secret-stack-a"]);
    assert.deepEqual(observedB, ["Bearer secret-stack-b", "Bearer secret-stack-b"]);
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
