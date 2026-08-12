import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import {
  CredentialBroker,
  CredentialRotationError,
  credentialBrokerFromEnv,
  credentialEnvironmentAllowlist,
  credentialScopesForEnvironment,
  isCredentialEnvironmentName,
  isSensitiveEnvironmentName,
  type CredentialAuditEvent,
} from "./credentials.js";
import {
  AwsKmsSecretBackend,
  OS_KEYCHAIN_DISABLED_ENV,
  OsKeychainChildProcessRunner,
  OsKeychainDisabledError,
  OsKeychainMutationError,
  OsKeychainSecretBackend,
  StaticVaultTokenProvider,
  VaultKvV2SecretBackend,
  VaultJwtTokenProvider,
  configuredSecretBackendFromEnv,
  githubActionsOidcProvider,
  oidcTokenFileProvider,
  type KmsLikeClient,
  type SecretBackend,
  type OsKeychainProcessRunner,
  type SyncSecretBackend,
} from "./secret-backends.js";
import { CredentialRotationManager } from "./rotation.js";

async function capturedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected promise to reject");
}

async function flushCredentialAudit(): Promise<void> {
  // CredentialBroker deliberately invokes observational audit sinks after two microtask hops.
  await Promise.resolve();
  await Promise.resolve();
}

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

class ObservedRotationBroker extends CredentialBroker {
  observedWriteTimeoutMs: number | undefined;

  override rotateBackend(...args: Parameters<CredentialBroker["rotateBackend"]>) {
    this.observedWriteTimeoutMs = args[4]?.timeoutMs;
    return super.rotateBackend(...args);
  }
}

class ObservedSecretBackend implements SyncSecretBackend {
  readonly kind = "observed-keychain";
  readonly values = new Map<string, string>();
  reads = 0;
  writes = 0;
  lists = 0;
  readError: Error | undefined;

  getSync(key: string): string | undefined {
    this.reads++;
    if (this.readError) throw this.readError;
    return this.values.get(key);
  }
  putSync(key: string, value: string): void {
    this.writes++;
    this.values.set(key, value);
  }
  deleteSync(key: string): boolean {
    return this.values.delete(key);
  }
  listSync(): string[] {
    this.lists++;
    throw new Error("credential enumeration must not be called");
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

class ProtocolOnlyKeychainRunner implements OsKeychainProcessRunner {
  readonly requests: Array<Record<string, unknown>> = [];

  private respond(input: Uint8Array): Uint8Array {
    const request = JSON.parse(Buffer.from(input).toString("utf8")) as Record<string, unknown>;
    this.requests.push(request);
    const operation = request["operation"];
    if (operation === "get") {
      return Buffer.from(
        JSON.stringify({
          version: 1,
          ok: true,
          operation,
          found: true,
          value: `value-for-${String(request["key"])}`,
        }),
      );
    }
    if (operation === "put") {
      return Buffer.from(JSON.stringify({ version: 1, ok: true, operation }));
    }
    return Buffer.from(
      JSON.stringify({ version: 1, ok: true, operation: "delete", deleted: true }),
    );
  }

  runSync(input: Uint8Array): Uint8Array {
    return this.respond(input);
  }

  async run(input: Uint8Array): Promise<Uint8Array> {
    return this.respond(input);
  }
}

async function withOsKeychainEnabled<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = process.env[OS_KEYCHAIN_DISABLED_ENV];
  delete process.env[OS_KEYCHAIN_DISABLED_ENV];
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env[OS_KEYCHAIN_DISABLED_ENV];
    else process.env[OS_KEYCHAIN_DISABLED_ENV] = previous;
  }
}

test("OS Keychain: hermetic safety switch fails before a native credential operation", () => {
  assert.equal("list" in OsKeychainSecretBackend.prototype, false);
  assert.equal("listSync" in OsKeychainSecretBackend.prototype, false);
  const previous = process.env[OS_KEYCHAIN_DISABLED_ENV];
  process.env[OS_KEYCHAIN_DISABLED_ENV] = "1";
  try {
    assert.throws(
      () => new OsKeychainSecretBackend("dev.anicode.test-must-not-open-keychain"),
      OsKeychainDisabledError,
    );
  } finally {
    if (previous === undefined) delete process.env[OS_KEYCHAIN_DISABLED_ENV];
    else process.env[OS_KEYCHAIN_DISABLED_ENV] = previous;
  }
});

test("OS Keychain: main module has no static native import and sentinel blocks before runner", async () => {
  const source = await fs.readFile(new URL("./secret-backends.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /^import .*@napi-rs\/keyring/m);
  let calls = 0;
  const runner: OsKeychainProcessRunner = {
    runSync: () => {
      calls++;
      throw new Error("must not run");
    },
    run: async () => {
      calls++;
      throw new Error("must not run");
    },
  };
  const previous = process.env[OS_KEYCHAIN_DISABLED_ENV];
  process.env[OS_KEYCHAIN_DISABLED_ENV] = "1";
  try {
    assert.throws(
      () => new OsKeychainSecretBackend("dev.anicode.no-spawn", { runner }),
      OsKeychainDisabledError,
    );
    assert.equal(calls, 0);
  } finally {
    if (previous === undefined) delete process.env[OS_KEYCHAIN_DISABLED_ENV];
    else process.env[OS_KEYCHAIN_DISABLED_ENV] = previous;
  }
});

test("OS Keychain: sync and async APIs use only the bounded stdin/stdout protocol", async () => {
  await withOsKeychainEnabled(async () => {
    const runner = new ProtocolOnlyKeychainRunner();
    const modulePath = path.join(os.tmpdir(), "anicode-keyring-protocol", "index.js");
    const backend = new OsKeychainSecretBackend("dev.anicode.protocol-test", {
      modulePath,
      runner,
    });
    const secret = "put-secret-that-must-only-appear-on-stdin";

    assert.equal(backend.getSync("sync-key"), "value-for-sync-key");
    backend.putSync("sync-key", secret);
    assert.equal(backend.deleteSync("sync-key"), true);
    assert.equal(await backend.get("async-key"), "value-for-async-key");
    await backend.put("async-key", secret);
    assert.equal(await backend.delete("async-key"), true);

    assert.deepEqual(
      runner.requests.map((request) => request["operation"]),
      ["get", "put", "delete", "get", "put", "delete"],
    );
    for (const request of runner.requests) {
      assert.equal(request["version"], 1);
      assert.equal(request["service"], "dev.anicode.protocol-test");
      assert.equal(request["modulePath"], modulePath);
      if (request["operation"] === "put") assert.equal(request["value"], secret);
      else assert.equal("value" in request, false);
    }
  });
});

test("OS Keychain: module path is absolute, bounded, and trusted before helper execution", async () => {
  await withOsKeychainEnabled(() => {
    let calls = 0;
    const runner: OsKeychainProcessRunner = {
      runSync: () => {
        calls++;
        throw new Error("must not run");
      },
      run: async () => {
        calls++;
        throw new Error("must not run");
      },
    };
    for (const modulePath of [
      "relative/keyring.js",
      path.join(os.tmpdir(), "keyring.node"),
      `${path.join(os.tmpdir(), "keyring.js")}\npreload`,
    ]) {
      assert.throws(
        () => new OsKeychainSecretBackend("dev.anicode.invalid-module", { modulePath, runner }),
        /Invalid OS Keychain module path/,
      );
    }
    assert.equal(calls, 0);
  });
});

test("OS Keychain: default resolver locates package metadata without loading native Entry", async () => {
  await withOsKeychainEnabled(() => {
    const runner = new ProtocolOnlyKeychainRunner();
    const backend = new OsKeychainSecretBackend("dev.anicode.default-module", { runner });
    assert.equal(backend.getSync("metadata-only"), "value-for-metadata-only");
    const modulePath = runner.requests[0]?.["modulePath"];
    assert.equal(typeof modulePath, "string");
    assert.equal(path.isAbsolute(String(modulePath)), true);
    assert.equal(path.basename(String(modulePath)), "index.js");
  });
});

test("OS Keychain: audited helper resolves packaged dependencies and keeps values out of argv/env", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-keychain-helper-"));
  const moduleDirectory = path.join(directory, "node_modules", "@napi-rs", "keyring");
  try {
    await fs.mkdir(moduleDirectory, { recursive: true });
    await fs.writeFile(
      path.join(moduleDirectory, "package.json"),
      JSON.stringify({ name: "@napi-rs/keyring", version: "0.0.0-test", main: "index.js" }),
    );
    await fs.writeFile(
      path.join(moduleDirectory, "index.js"),
      `"use strict";
class Entry {
  constructor(service, key) {
    if (process.env.ELECTRON_RUN_AS_NODE !== "1") throw new Error("not node mode");
    if (process.env.PARENT_LEAK_TOKEN !== undefined) throw new Error("inherited token");
    if (process.env.SystemRoot !== "C:\\\\Windows") throw new Error("missing SystemRoot");
    if (process.env.ComSpec !== "C:\\\\Windows\\\\System32\\\\cmd.exe") throw new Error("missing ComSpec");
    this.service = service;
    this.key = key;
  }
  getPassword() { return this.service + ":" + this.key; }
  setPassword(value) {
    if (value !== this.service + ":" + this.key) throw new Error("wrong stdin value");
    if (process.argv.some((item) => item.includes(value))) throw new Error("value leaked to argv");
    if (Object.values(process.env).includes(value)) throw new Error("value leaked to env");
  }
  deleteCredential() { return true; }
}
module.exports = { Entry };
`,
    );
    const runner = new OsKeychainChildProcessRunner({
      environment: {
        PARENT_LEAK_TOKEN: "must-not-enter-helper",
        systemroot: "C:\\Windows",
        comspec: "C:\\Windows\\System32\\cmd.exe",
      },
      workingDirectory: directory,
    });
    const modulePath = path.join(moduleDirectory, "index.js");
    const request = (operation: "get" | "put" | "delete", value?: string) =>
      Buffer.from(
        JSON.stringify({
          version: 1,
          operation,
          modulePath,
          service: "packaged-service",
          key: "packaged-key",
          ...(value !== undefined ? { value } : {}),
        }),
      );
    const options = { timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 };
    const expected = "packaged-service:packaged-key";
    assert.deepEqual(
      JSON.parse(
        Buffer.from(
          runner.runSync(
            Buffer.from(
              JSON.stringify({
                version: 1,
                operation: "get",
                modulePath: "relative/index.js",
                service: "packaged-service",
                key: "packaged-key",
              }),
            ),
            options,
          ),
        ).toString(),
      ),
      { version: 1, ok: false, code: "invalid_request" },
    );
    assert.deepEqual(JSON.parse(Buffer.from(runner.runSync(request("get"), options)).toString()), {
      version: 1,
      ok: true,
      operation: "get",
      found: true,
      value: expected,
    });
    assert.deepEqual(
      JSON.parse(Buffer.from(await runner.run(request("put", expected), options)).toString()),
      { version: 1, ok: true, operation: "put" },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("OS Keychain: hard timeout/abort force-close helpers and mutations are indeterminate", async () => {
  await withOsKeychainEnabled(async () => {
    const secret = "never-echo-timeout-secret";
    const runner = new OsKeychainChildProcessRunner({
      helperSource: `process.stdin.resume(); setInterval(() => {}, 1000);`,
    });
    const syncBackend = new OsKeychainSecretBackend("dev.anicode.timeout-test", {
      runner,
      timeoutMs: 25,
    });
    const started = Date.now();
    assert.throws(
      () => syncBackend.putSync("timeout-key", secret),
      (error) => {
        assert.ok(error instanceof OsKeychainMutationError);
        assert.equal(error.outcome, "indeterminate");
        assert.equal(error.reason, "timed-out");
        assert.doesNotMatch(error.stack ?? error.message, new RegExp(secret));
        return true;
      },
    );
    assert.ok(Date.now() - started < 2_000, "spawnSync must return after SIGKILL close proof");
    assert.throws(
      () => syncBackend.getSync("timeout-read"),
      (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error instanceof OsKeychainMutationError, false);
        assert.match(error.message, /read timed out after 25ms/);
        return true;
      },
    );

    const asyncBackend = new OsKeychainSecretBackend("dev.anicode.abort-test", {
      runner,
      timeoutMs: 2_000,
    });
    const controller = new AbortController();
    const pending = asyncBackend.delete("abort-key", controller.signal);
    await delay(20);
    controller.abort(new Error(secret));
    const error = await capturedError(pending);
    assert.ok(error instanceof OsKeychainMutationError);
    assert.equal(error.outcome, "indeterminate");
    assert.equal(error.reason, "cancelled");
    assert.doesNotMatch(error.stack ?? error.message, new RegExp(secret));

    const noisy = new OsKeychainChildProcessRunner({
      helperSource:
        `process.stdin.resume(); process.stdin.on("end", () => ` +
        `process.stdout.write("x".repeat(4096)));`,
    });
    assert.throws(
      () =>
        noisy.runSync(Buffer.from("{}"), {
          timeoutMs: 2_000,
          maxOutputBytes: 1_024,
        }),
      /subprocess boundary failed/,
    );
  });
});

test("Credential Broker: Keychain references are explicit, lazy and never overwritten from env", () => {
  const backend = new ObservedSecretBackend();
  backend.values.set("env:OPENAI_API_KEY", "old-keychain-value");
  backend.values.set("env:ANTHROPIC_API_KEY", "keychain-anthropic-value");
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_KEYS: "OPENAI_API_KEY, ANTHROPIC_API_KEY",
    OPENAI_API_KEY: "process-only-openai-value",
  };

  const broker = credentialBrokerFromEnv(env, { backend, remove: true });

  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(backend.lists, 0, "startup must not enumerate the credential store");
  assert.equal(backend.writes, 0, "an environment secret must not overwrite persistent storage");
  assert.equal(backend.reads, 0, "registration and availability checks must be lazy");
  assert.equal(broker.availability("env:OPENAI_API_KEY"), "available");
  assert.equal(broker.availability("env:ANTHROPIC_API_KEY"), "configured");
  assert.equal(broker.has("env:ANTHROPIC_API_KEY"), true);
  assert.equal(backend.reads, 0);
  assert.equal(
    broker.trustedValue("env:OPENAI_API_KEY", {
      audience: "provider:openai",
      host: "api.openai.com",
    }),
    "process-only-openai-value",
  );
  assert.equal(backend.reads, 0, "the process value must take precedence over Keychain");
  const anthropicRequest = {
    audience: "provider:anthropic",
    host: "api.anthropic.com",
  } as const;
  assert.equal(
    broker.trustedValue("env:ANTHROPIC_API_KEY", anthropicRequest),
    "keychain-anthropic-value",
  );
  assert.equal(
    broker.trustedValue("env:ANTHROPIC_API_KEY", anthropicRequest),
    "keychain-anthropic-value",
  );
  assert.equal(backend.reads, 1, "trusted reads share the bounded process cache");
});

test("Credential Broker: unavailable explicit references are negatively cached without enumeration", () => {
  const backend = new ObservedSecretBackend();
  const broker = credentialBrokerFromEnv(
    { ANICODE_CREDENTIAL_KEYS: "OPENROUTER_API_KEY" },
    { backend },
  );
  const request = { audience: "provider:openrouter", host: "openrouter.ai" } as const;

  assert.equal(broker.availability("env:OPENROUTER_API_KEY"), "configured");
  assert.throws(() => broker.trustedValue("env:OPENROUTER_API_KEY", request), /unavailable/);
  assert.equal(broker.availability("env:OPENROUTER_API_KEY"), "unavailable");
  assert.equal(broker.has("env:OPENROUTER_API_KEY"), false);
  assert.throws(() => broker.trustedValue("env:OPENROUTER_API_KEY", request), /unavailable/);
  assert.equal(backend.reads, 1);
  assert.equal(backend.lists, 0);
  assert.equal(backend.writes, 0);
});

test("Credential Broker: backend read errors are sanitized before negative caching", async () => {
  const backend = new ObservedSecretBackend();
  const echoedSecret = "backend-echoed-sensitive-value";
  const refusal = Object.assign(new Error(`SDK rejected ${echoedSecret}`), {
    metadata: { secret: echoedSecret },
  });
  backend.readError = refusal;
  const broker = credentialBrokerFromEnv(
    { ANICODE_CREDENTIAL_KEYS: "ANTHROPIC_API_KEY" },
    { backend },
  );
  const request = { audience: "provider:anthropic", host: "api.anthropic.com" } as const;

  let syncFailure: Error | undefined;
  assert.throws(
    () => broker.trustedValue("env:ANTHROPIC_API_KEY", request),
    (error) => {
      assert.ok(error instanceof Error);
      syncFailure = error;
      assert.notStrictEqual(error, refusal);
      assert.equal(error.message, "Credential backend read failed");
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.doesNotMatch(JSON.stringify(error), new RegExp(echoedSecret));
      return true;
    },
  );
  assert.throws(
    () => broker.trustedValue("env:ANTHROPIC_API_KEY", request),
    (error) => error === syncFailure,
  );
  assert.equal(backend.reads, 1);

  let asyncReads = 0;
  const asyncBackend: SecretBackend = {
    kind: "echoing-async-backend",
    get: async () => {
      asyncReads++;
      throw refusal;
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const asyncBroker = new CredentialBroker();
  asyncBroker.registerAsyncReference({
    id: "async-error",
    backend: asyncBackend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  const asyncFailure = await capturedError(
    asyncBroker.trustedValueAsync("async-error", { audience: "provider:test" }),
  );
  assert.equal(asyncFailure.message, "Credential backend read failed");
  assert.equal(Object.hasOwn(asyncFailure, "cause"), false);
  assert.doesNotMatch(JSON.stringify(asyncFailure), new RegExp(echoedSecret));
  assert.strictEqual(
    await capturedError(
      asyncBroker.trustedValueAsync("async-error", { audience: "provider:test" }),
    ),
    asyncFailure,
  );
  assert.equal(asyncReads, 1);
});

test("Credential Broker: async references are single-flight and rotation fences stale reads", async () => {
  let oldReads = 0;
  let resolveOld!: (value: string) => void;
  const oldValue = new Promise<string>((resolve) => {
    resolveOld = resolve;
  });
  const oldBackend: SecretBackend = {
    kind: "old-vault",
    get: async () => {
      oldReads++;
      return oldValue;
    },
    put: async () => undefined,
    delete: async () => false,
  };
  let newReads = 0;
  const newBackend: SecretBackend = {
    kind: "new-vault",
    get: async () => {
      newReads++;
      return "new-value";
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "async-provider",
    backend: oldBackend,
    scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
  });
  const request = { audience: "provider:test", host: "provider.example" } as const;
  const first = broker.trustedValueAsync("async-provider", request);
  const shared = broker.trustedValueAsync("async-provider", request);
  assert.equal(oldReads, 1);

  await broker.rotateBackend("async-provider", newBackend, "new-value");
  resolveOld("stale-value");
  await assert.rejects(first, /changed during backend resolution/);
  await assert.rejects(shared, /changed during backend resolution/);
  assert.equal(await broker.trustedValueAsync("async-provider", request), "new-value");
  assert.equal(await broker.trustedValueAsync("async-provider", request), "new-value");
  assert.equal(newReads, 0, "successful rotation seeds the bounded reference cache");
});

test("Credential Broker: audit sinks cannot synchronously revoke trusted access outcomes", async () => {
  const audited: CredentialAuditEvent[] = [];
  const reentered = new Set<string>();
  const broker = new CredentialBroker({
    onAudit: (event) => {
      audited.push(event);
      if (event.action !== "read" || reentered.has(event.credentialId)) return;
      reentered.add(event.credentialId);
      broker.revoke(event.credentialId);
      broker.register({
        id: event.credentialId,
        value: `replacement-${event.credentialId}`,
        scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
        ...(event.version !== undefined ? { version: event.version } : {}),
      });
    },
  });
  const request = { audience: "provider:test", host: "provider.example" };

  broker.register({
    id: "sync-audit",
    value: "sync-original",
    scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
  });
  await flushCredentialAudit();
  assert.equal(broker.trustedValue("sync-audit", request), "sync-original");
  assert.equal(reentered.has("sync-audit"), false, "sync read must return before audit re-entry");
  request.host = "mutated-after-read.example";
  await flushCredentialAudit();
  assert.equal(reentered.has("sync-audit"), true);
  assert.equal(broker.availability("sync-audit"), "available");

  const asyncBackend: SecretBackend = {
    kind: "audit-reentry-async-backend",
    get: async () => "async-original",
    put: async () => undefined,
    delete: async () => false,
  };
  broker.registerAsyncReference({
    id: "async-audit",
    backend: asyncBackend,
    scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
  });
  await flushCredentialAudit();
  request.host = "provider.example";
  assert.equal(await broker.trustedValueAsync("async-audit", request), "async-original");
  assert.equal(
    reentered.has("async-audit"),
    false,
    "async caller continuation must run before audit re-entry",
  );
  await flushCredentialAudit();
  assert.equal(reentered.has("async-audit"), true);
  assert.equal(broker.availability("async-audit"), "available");

  const syncRead = audited.find(
    (event) => event.action === "read" && event.credentialId === "sync-audit",
  );
  assert.equal(syncRead?.host, "provider.example", "audit must snapshot caller-owned fields");
  assert.equal(Object.isFrozen(syncRead), true, "audit snapshots must be immutable");
});

test("Credential Broker: sync backend re-entry cannot poison a same-version replacement cache", () => {
  let broker!: CredentialBroker;
  let reads = 0;
  let installedReplacement = false;
  let stored = "stale-backend-value";
  const backend: SyncSecretBackend = {
    kind: "reentrant-sync-backend",
    getSync: () => {
      reads++;
      const captured = stored;
      if (!installedReplacement) {
        installedReplacement = true;
        broker.revoke("reentrant-reference");
        stored = "current-backend-value";
        broker.registerReference({
          id: "reentrant-reference",
          backend,
          backendKey: "shared-key",
          scopes: [{ audiences: ["provider:test"] }],
          version: 1,
        });
      }
      return captured;
    },
    putSync: (_key, value) => {
      stored = value;
    },
    deleteSync: () => false,
    get: async () => stored,
    put: async (_key, value) => {
      stored = value;
    },
    delete: async () => false,
  };
  broker = new CredentialBroker();
  broker.registerReference({
    id: "reentrant-reference",
    backend,
    backendKey: "shared-key",
    scopes: [{ audiences: ["provider:test"] }],
    version: 1,
  });

  assert.throws(
    () => broker.trustedValue("reentrant-reference", { audience: "provider:test" }),
    /changed during backend resolution/,
  );
  assert.equal(reads, 1);
  assert.equal(
    broker.availability("reentrant-reference"),
    "configured",
    "the stale value must not be cached for the replacement registration",
  );
  assert.equal(
    broker.trustedValue("reentrant-reference", { audience: "provider:test" }),
    "current-backend-value",
  );
  assert.equal(reads, 2, "the replacement must perform its own backend read");
});

test("Credential Broker: generation is a pure CAS token for one registration lifecycle", () => {
  const backend = new ObservedSecretBackend();
  backend.values.set("generation-key", "generation-value");
  const broker = new CredentialBroker();
  const registration = () =>
    broker.registerReference({
      id: "generation-reference",
      backend,
      backendKey: "generation-key",
      scopes: [{ audiences: ["provider:test"] }],
      version: 1,
    });

  assert.equal(broker.credentialGeneration("unknown"), undefined);
  registration();
  const first = broker.credentialGeneration("generation-reference");
  assert.equal(typeof first, "symbol");
  assert.strictEqual(broker.credentialGeneration("generation-reference"), first);
  assert.equal(backend.reads, 0, "generation inspection must not resolve the backend reference");

  assert.equal(broker.revoke("generation-reference"), true);
  assert.equal(broker.credentialGeneration("generation-reference"), undefined);
  registration();
  const replacement = broker.credentialGeneration("generation-reference");
  assert.equal(typeof replacement, "symbol");
  assert.notStrictEqual(replacement, first, "same id/version replacement needs a fresh CAS token");
  assert.equal(backend.reads, 0);

  broker.register({
    id: "expired-generation",
    value: "expired-value",
    scopes: [{ audiences: ["provider:test"] }],
    expiresAt: new Date(Date.now() - 1).toISOString(),
  });
  assert.equal(broker.credentialGeneration("expired-generation"), undefined);

  let rotationBroker!: CredentialBroker;
  let failWrite = true;
  let generationDuringWrite: symbol | undefined;
  const rotationBackend: SyncSecretBackend = {
    kind: "generation-rotation-backend",
    getSync: () => "rotation-old-value",
    putSync: () => {
      generationDuringWrite = rotationBroker.credentialGeneration("generation-rotation");
      if (failWrite) throw new Error("indeterminate test write");
    },
    deleteSync: () => false,
    get: async () => "rotation-old-value",
    put: async () => undefined,
    delete: async () => false,
  };
  rotationBroker = new CredentialBroker();
  rotationBroker.registerReference({
    id: "generation-rotation",
    backend: rotationBackend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  const rotationGeneration = rotationBroker.credentialGeneration("generation-rotation");
  assert.throws(
    () => rotationBroker.rotate("generation-rotation", "rotation-new-value"),
    CredentialRotationError,
  );
  assert.strictEqual(generationDuringWrite, rotationGeneration);
  assert.equal(rotationBroker.rotationStatus("generation-rotation"), "quarantined");
  assert.strictEqual(
    rotationBroker.credentialGeneration("generation-rotation"),
    rotationGeneration,
    "indeterminate quarantine must retain the pre-issue generation",
  );
  failWrite = false;
  assert.equal(rotationBroker.rotate("generation-rotation", "rotation-new-value"), 2);
  assert.strictEqual(
    rotationBroker.credentialGeneration("generation-rotation"),
    rotationGeneration,
    "forward completion is internal to the same registration lifecycle",
  );
});

test("Credential Broker: indeterminate sync rotation quarantines reads and supports forward retry", async () => {
  const values = new Map([["provider-key", "old-provider-secret"]]);
  let reads = 0;
  let writes = 0;
  let deletes = 0;
  let failAfterCommit = true;
  const backend: SyncSecretBackend = {
    kind: "commit-then-throw-keychain",
    getSync: (key) => {
      reads++;
      return values.get(key);
    },
    putSync: (key, value) => {
      writes++;
      values.set(key, value);
      if (failAfterCommit) {
        throw new OsKeychainMutationError("put", "timed-out", 10);
      }
    },
    deleteSync: (key) => {
      deletes++;
      return values.delete(key);
    },
    get: async (key) => backend.getSync(key),
    put: async (key, value) => backend.putSync(key, value),
    delete: async (key) => backend.deleteSync(key),
  };
  const audit: CredentialAuditEvent[] = [];
  const broker = new CredentialBroker({
    onAudit: (event) => {
      audit.push(event);
    },
  });
  const request = { audience: "provider:test", host: "provider.example" } as const;
  broker.registerReference({
    id: "provider",
    backend,
    backendKey: "provider-key",
    scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
  });
  assert.equal(broker.trustedValue("provider", request), "old-provider-secret");
  const lease = broker.lease({ credentialId: "provider", ...request });

  assert.throws(
    () => broker.rotate("provider", "new-provider-secret"),
    (error) => {
      assert.ok(error instanceof CredentialRotationError);
      assert.equal(error.outcome, "indeterminate");
      assert.equal(error.reason, "write-indeterminate");
      return true;
    },
  );
  assert.equal(values.get("provider-key"), "new-provider-secret");
  assert.equal(broker.availability("provider"), "unavailable");
  assert.throws(() => broker.injectHeaders(lease), /expired|revoked|replaced/);
  assert.throws(() => broker.trustedValue("provider", request), /rotation reconciliation/);
  assert.equal(reads, 1, "quarantine must not perform a confirmation Keychain read");
  assert.equal(deletes, 0, "an indeterminate write must never be rolled back with delete");
  assert.equal(broker.redact("old-provider-secret new-provider-secret"), "[REDACTED] [REDACTED]");
  await flushCredentialAudit();
  assert.equal(audit.filter((event) => event.action === "rotate").at(-1)?.success, false);

  failAfterCommit = false;
  assert.equal(broker.rotate("provider", "new-provider-secret"), 2);
  assert.equal(writes, 2);
  assert.equal(broker.trustedValue("provider", request), "new-provider-secret");
});

test("Credential Broker: async rotation quarantine rejects target changes before backend I/O", async () => {
  const values = new Map([["provider-key", "old-async-secret"]]);
  let reads = 0;
  let writes = 0;
  let deletes = 0;
  let failAfterCommit = true;
  const backend: SecretBackend = {
    kind: "commit-then-throw-vault",
    get: async (key) => {
      reads++;
      return values.get(key);
    },
    put: async (key, value) => {
      writes++;
      values.set(key, value);
      if (failAfterCommit) throw new Error("completion proof lost");
    },
    delete: async (key) => {
      deletes++;
      return values.delete(key);
    },
  };
  let otherWrites = 0;
  const otherBackend: SecretBackend = {
    kind: "other-vault",
    get: async () => undefined,
    put: async () => {
      otherWrites++;
    },
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  const request = { audience: "provider:test", host: "provider.example" } as const;
  broker.registerAsyncReference({
    id: "async-provider",
    backend,
    backendKey: "provider-key",
    scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
  });
  assert.equal(await broker.trustedValueAsync("async-provider", request), "old-async-secret");

  const error = await capturedError(
    broker.rotateBackend("async-provider", backend, "new-async-secret", "provider-key"),
  );
  assert.ok(error instanceof CredentialRotationError);
  assert.equal(error.outcome, "indeterminate");
  assert.equal(broker.availability("async-provider"), "unavailable");
  await assert.rejects(
    broker.trustedValueAsync("async-provider", request),
    /rotation reconciliation/,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    broker.rotateBackend("async-provider", otherBackend, "third-secret", "provider-key"),
    (rotationError) => {
      assert.ok(rotationError instanceof CredentialRotationError);
      assert.equal(rotationError.outcome, "not-written");
      assert.equal(rotationError.reason, "quarantined");
      return true;
    },
  );
  assert.equal(otherWrites, 0);
  await assert.rejects(
    broker.rotateBackend("async-provider", backend, "different-forward-secret", "provider-key"),
    (rotationError) => {
      assert.ok(rotationError instanceof CredentialRotationError);
      assert.equal(rotationError.outcome, "not-written");
      assert.equal(rotationError.reason, "quarantined");
      return true;
    },
  );
  assert.equal(writes, 1, "quarantine permits only an idempotent same-value forward retry");
  assert.equal(deletes, 0);

  failAfterCommit = false;
  assert.equal(
    await broker.rotateBackend("async-provider", backend, "new-async-secret", "provider-key"),
    2,
  );
  assert.equal(writes, 2);
  assert.equal(await broker.trustedValueAsync("async-provider", request), "new-async-secret");
});

test("Credential Broker: rotation validates registration and version before external writes", async () => {
  let writes = 0;
  const backend: SecretBackend = {
    kind: "observed-vault",
    get: async () => "old-secret",
    put: async () => {
      writes++;
    },
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  await assert.rejects(broker.rotateBackend("missing", backend, "new-secret"), /Unknown/);
  broker.registerAsyncReference({
    id: "max-version",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
    version: Number.MAX_SAFE_INTEGER,
  });
  await assert.rejects(
    broker.rotateBackend("max-version", backend, "new-max-secret"),
    /cannot be rotated further/,
  );
  assert.equal(writes, 0);
});

test("Credential Broker: revoke during async rotation cannot resurrect the credential", async () => {
  let releaseWrite!: () => void;
  let markStarted!: () => void;
  const writeGate = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let writes = 0;
  let deletes = 0;
  const backend: SecretBackend = {
    kind: "delayed-vault",
    get: async () => "old-secret",
    put: async () => {
      writes++;
      markStarted();
      await writeGate;
    },
    delete: async () => {
      deletes++;
      return true;
    },
  };
  const broker = new CredentialBroker();
  const registration = {
    id: "delayed-provider",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  };
  broker.registerAsyncReference(registration);
  const rotation = broker.rotateBackend("delayed-provider", backend, "new-secret");
  await started;
  await assert.rejects(
    broker.rotateBackend("delayed-provider", backend, "second-secret"),
    (error) => {
      assert.ok(error instanceof CredentialRotationError);
      assert.equal(error.reason, "in-progress");
      return true;
    },
  );
  assert.equal(writes, 1);
  assert.equal(broker.revoke("delayed-provider"), true);
  assert.throws(
    () => broker.registerAsyncReference(registration),
    (error) => error instanceof CredentialRotationError && error.reason === "in-progress",
  );
  releaseWrite();
  const error = await capturedError(rotation);
  assert.ok(error instanceof CredentialRotationError);
  assert.equal(error.outcome, "written-not-activated");
  assert.equal(error.reason, "superseded-after-write");
  assert.equal(broker.availability("delayed-provider"), "unavailable");
  assert.equal(deletes, 0);
  broker.registerAsyncReference(registration);
});

test("Credential Broker: rotated and revoked inline values remain redacted for the bounded TTL", () => {
  const broker = new CredentialBroker();
  broker.register({
    id: "inline-redaction",
    value: "old-inline-redaction-secret",
    scopes: [{ audiences: ["provider:test"] }],
  });
  assert.equal(broker.rotate("inline-redaction", "new-inline-redaction-secret"), 2);
  broker.revoke("inline-redaction");
  assert.equal(
    broker.redact("old-inline-redaction-secret new-inline-redaction-secret"),
    "[REDACTED] [REDACTED]",
  );
});

test("Credential Broker: redaction TTL rejects non-finite and unbounded values", () => {
  for (const redactionTtlMs of [Number.NaN, Number.POSITIVE_INFINITY, 999, 1_000.5, 86_400_001]) {
    assert.throws(
      () => new CredentialBroker({ redactionTtlMs }),
      /redaction TTL must be an integer from 1000 to 86400000/,
    );
  }
  assert.doesNotThrow(() => new CredentialBroker({ redactionTtlMs: 86_400_000 }));
});

test("Credential Broker: hydrated Vault values retain their backing target and rotate in place", async () => {
  const values = new Map([["provider-key", "hydrated-old-secret"]]);
  let reads = 0;
  let writes = 0;
  const backend: SecretBackend = {
    kind: "hydrated-vault",
    credentialNamespace: "test:hydrated-vault",
    get: async (key) => {
      reads++;
      return values.get(key);
    },
    put: async (key, value) => {
      writes++;
      values.set(key, value);
    },
    delete: async (key) => values.delete(key),
  };
  const broker = new CredentialBroker();
  await broker.registerFromBackend({
    id: "hydrated-provider",
    backend,
    backendKey: "provider-key",
    scopes: [{ audiences: ["provider:test"] }],
  });
  const manager = new CredentialRotationManager(broker);
  manager.register({
    credentialId: "hydrated-provider",
    backend,
    backendKey: "provider-key",
    intervalMs: 60_000,
    issue: async () => ({
      value: "hydrated-new-secret",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });

  assert.equal(await manager.rotateNow("hydrated-provider"), 2);
  assert.equal(values.get("provider-key"), "hydrated-new-secret");
  assert.equal(writes, 1);
  assert.equal(
    broker.trustedValue("hydrated-provider", { audience: "provider:test" }),
    "hydrated-new-secret",
  );
  assert.equal(reads, 1, "hydrated inline values do not immediately reopen the backend");
});

test("Credential Broker: delayed backend hydration cannot overwrite a newer rotation", async () => {
  let resolveStale!: (value: string) => void;
  let markSecondRead!: () => void;
  const staleRead = new Promise<string>((resolve) => {
    resolveStale = resolve;
  });
  const secondReadStarted = new Promise<void>((resolve) => {
    markSecondRead = resolve;
  });
  let reads = 0;
  const values = new Map([["provider-key", "initial-secret"]]);
  const backend: SecretBackend = {
    kind: "deferred-vault",
    credentialNamespace: "test:deferred-vault",
    get: async (key) => {
      reads++;
      if (reads === 1) return values.get(key);
      markSecondRead();
      return staleRead;
    },
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => values.delete(key),
  };
  const broker = new CredentialBroker();
  const registration = {
    id: "hydration-fence",
    backend,
    backendKey: "provider-key",
    scopes: [{ audiences: ["provider:test"] }],
  };
  await broker.registerFromBackend(registration);
  const staleHydration = broker.registerFromBackend(registration);
  await secondReadStarted;
  assert.equal(
    await broker.rotateBackend("hydration-fence", backend, "rotated-secret", "provider-key"),
    2,
  );
  resolveStale("stale-secret");
  await assert.rejects(staleHydration, /changed during backend hydration/);
  assert.equal(
    broker.trustedValue("hydration-fence", { audience: "provider:test" }),
    "rotated-secret",
  );
});

test("Credential Broker: stable namespace and canonical target reject physical aliases", () => {
  const readKeys: string[] = [];
  const createBackend = (): SyncSecretBackend => ({
    kind: "wrapped-keychain",
    credentialNamespace: "os-keychain:test-shared-service",
    credentialTargetKey: (key) => key.normalize("NFC").toLowerCase(),
    getSync: (key) => {
      readKeys.push(key);
      return "shared-secret";
    },
    putSync: () => undefined,
    deleteSync: () => false,
    get: async (key) => {
      readKeys.push(key);
      return "shared-secret";
    },
    put: async () => undefined,
    delete: async () => false,
  });
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "first-alias",
    backend: createBackend(),
    backendKey: "SHARED-key",
    scopes: [{ audiences: ["provider:first"] }],
  });
  assert.equal(broker.trustedValue("first-alias", { audience: "provider:first" }), "shared-secret");
  assert.deepEqual(readKeys, ["SHARED-key"], "canonicalization must never rewrite backend I/O");
  assert.throws(
    () =>
      broker.registerReference({
        id: "second-alias",
        backend: createBackend(),
        backendKey: "shared-key",
        scopes: [{ audiences: ["provider:second"] }],
      }),
    /target is already registered/,
  );
});

test("Credential Broker: KMS target identity follows the real ciphertext directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kms-target-"));
  const directory = path.join(root, "ciphertexts");
  const alias = path.join(root, "ciphertexts-alias");
  try {
    await fs.mkdir(directory);
    await fs.symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const client: KmsLikeClient = { send: async () => ({}) };
    const first = new AwsKmsSecretBackend({ keyId: "alias/first", directory, client });
    const second = new AwsKmsSecretBackend({ keyId: "alias/second", directory: alias, client });
    assert.equal(first.credentialNamespace, second.credentialNamespace);

    const broker = new CredentialBroker();
    broker.registerAsyncReference({
      id: "kms-first",
      backend: first,
      backendKey: "shared",
      scopes: [{ audiences: ["provider:test"] }],
    });
    assert.throws(
      () =>
        broker.registerAsyncReference({
          id: "kms-second",
          backend: second,
          backendKey: "shared",
          scopes: [{ audiences: ["provider:test"] }],
        }),
      /backend target is already registered/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Credential Broker: non-cooperative rotation times out, aborts and stays redacted", async () => {
  let writeSignal: AbortSignal | undefined;
  const attempted = "timeout-attempted-secret";
  const backend: SecretBackend = {
    kind: "non-cooperative-vault",
    get: async () => "old-secret",
    put: async (_key, _value, signal) => {
      writeSignal = signal;
      return new Promise<void>(() => undefined);
    },
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "timeout-provider",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  const error = await capturedError(
    broker.rotateBackend("timeout-provider", backend, attempted, undefined, { timeoutMs: 10 }),
  );
  assert.ok(error instanceof CredentialRotationError);
  assert.equal(error.outcome, "indeterminate");
  assert.equal(writeSignal?.aborted, true);
  assert.equal(broker.rotationStatus("timeout-provider"), "quarantined");
  assert.equal(broker.availability("timeout-provider"), "unavailable");
  assert.equal(broker.redact(attempted), "[REDACTED]");
});

test("Credential Broker: backend failures cannot escape a secret through Error.cause", async () => {
  const attempted = "backend-echoed-attempted-secret";
  const backend: SecretBackend = {
    kind: "leaking-vault",
    get: async () => "old-secret",
    put: async () => {
      throw new Error(`backend echoed ${attempted}`);
    },
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "leaking-provider",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  const error = await capturedError(broker.rotateBackend("leaking-provider", backend, attempted));
  assert.ok(error instanceof CredentialRotationError);
  assert.doesNotMatch(error.stack ?? error.message, new RegExp(attempted));
  assert.equal("cause" in error, false);
  assert.equal(broker.redact(attempted), "[REDACTED]");
});

test("Credential Broker: Keychain allowlist rejects non-canonical and unsupported names", () => {
  for (const configured of [
    "env:OPENAI_API_KEY",
    "OPENAI_*",
    "PATH",
    "UNKNOWN_API_KEY",
    "openai_api_key",
    "OPENAI_API_KEY,openai_api_key",
  ]) {
    const backend = new ObservedSecretBackend();
    assert.throws(
      () => credentialBrokerFromEnv({ ANICODE_CREDENTIAL_KEYS: configured }, { backend }),
      /invalid credential name/,
    );
    assert.deepEqual(
      { reads: backend.reads, writes: backend.writes, lists: backend.lists },
      { reads: 0, writes: 0, lists: 0 },
    );
  }
});

test("Credential Broker: control-plane and unknown secrets are scrubbed but never registered", () => {
  const env: NodeJS.ProcessEnv = {
    OPENAI_API_KEY: "provider-secret",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "github-oidc-control-secret",
    ANICODE_HTTP_TOKEN: "anicode-control-secret",
    UNKNOWN_API_KEY: "unknown-secret",
    openai_api_key: "non-canonical-secret",
    GITHUB_TOKEN: "github-mcp-secret",
    SENTRY_ACCESS_TOKEN: "sentry-mcp-secret",
  };
  const broker = credentialBrokerFromEnv(env, { remove: true });

  assert.equal(broker.has("env:OPENAI_API_KEY"), true);
  assert.equal(broker.has("env:ACTIONS_ID_TOKEN_REQUEST_TOKEN"), false);
  assert.equal(broker.has("env:ANICODE_HTTP_TOKEN"), false);
  assert.equal(broker.has("env:UNKNOWN_API_KEY"), false);
  assert.equal(broker.has("env:openai_api_key"), false);
  assert.equal(
    broker.trustedValue("env:GITHUB_TOKEN", {
      audience: "mcp:github",
      host: "api.githubcopilot.com",
      tool: "http",
    }),
    "github-mcp-secret",
  );
  assert.equal(
    broker.trustedValue("env:SENTRY_ACCESS_TOKEN", {
      audience: "mcp:sentry",
      host: "mcp.sentry.dev",
      tool: "http",
    }),
    "sentry-mcp-secret",
  );
  assert.throws(
    () =>
      broker.trustedValue("env:GITHUB_TOKEN", {
        audience: "provider:github",
        host: "api.github.com",
      }),
    /scope denied/,
  );
  assert.deepEqual(env, {});
  assert.equal(isSensitiveEnvironmentName("ACTIONS_ID_TOKEN_REQUEST_TOKEN"), true);
  assert.equal(isCredentialEnvironmentName("ACTIONS_ID_TOKEN_REQUEST_TOKEN"), false);
  assert.equal(isSensitiveEnvironmentName("UNKNOWN_API_KEY"), true);
  assert.equal(isCredentialEnvironmentName("UNKNOWN_API_KEY"), false);
  assert.equal(isCredentialEnvironmentName("openai_api_key"), false);
  assert.deepEqual(credentialScopesForEnvironment("openai_api_key"), []);
  assert.equal(isCredentialEnvironmentName("GITHUB_TOKEN"), true);
  assert.equal(isCredentialEnvironmentName("SENTRY_ACCESS_TOKEN"), true);
  assert.deepEqual(credentialScopesForEnvironment("UNKNOWN_API_KEY"), []);
  assert.throws(
    () => credentialEnvironmentAllowlist({ ANICODE_CREDENTIAL_KEYS: "UNKNOWN_API_KEY" }),
    /invalid credential name/,
  );
});

test("Credential Broker: registration snapshots scopes and replacement revokes old leases", () => {
  const audiences = ["provider:old"];
  const hosts = ["old.example"];
  const scope = {
    audiences,
    hosts,
    env: "OLD_ENV",
  };
  const broker = new CredentialBroker();
  broker.register({ id: "mutable", value: "old-value", scopes: [scope] });
  const staleLease = broker.lease({
    credentialId: "mutable",
    audience: "provider:old",
    host: "old.example",
  });

  audiences[0] = "provider:attacker";
  hosts[0] = "attacker.example";
  scope.env = "ATTACKER_ENV";
  assert.equal(
    broker.trustedValue("mutable", { audience: "provider:old", host: "old.example" }),
    "old-value",
  );
  assert.throws(
    () =>
      broker.trustedValue("mutable", {
        audience: "provider:attacker",
        host: "attacker.example",
      }),
    /scope denied/,
  );

  broker.register({
    id: "mutable",
    value: "new-value",
    version: 1,
    scopes: [{ audiences: ["provider:new"], env: "NEW_ENV" }],
  });
  assert.throws(() => broker.injectEnv(staleLease), /expired|revoked|replaced/);
  const currentLease = broker.lease({ credentialId: "mutable", audience: "provider:new" });
  assert.deepEqual(broker.injectEnv(currentLease), { NEW_ENV: "new-value" });
});

test("Credential Broker: lease limits, registration version and expiry are strict", async () => {
  const broker = new CredentialBroker();
  broker.register({
    id: "strict",
    value: "secret",
    scopes: [{ audiences: ["provider:test"], header: "authorization" }],
  });
  for (const ttlMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 3_600_001, 1.5]) {
    assert.throws(
      () => broker.lease({ credentialId: "strict", audience: "provider:test", ttlMs }),
      /ttlMs/,
    );
  }
  for (const maxUses of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1_001, 1.5]) {
    assert.throws(
      () => broker.lease({ credentialId: "strict", audience: "provider:test", maxUses }),
      /maxUses/,
    );
  }
  assert.throws(
    () =>
      broker.register({
        id: "bad-version",
        value: "secret",
        version: Number.NaN,
        scopes: [{ audiences: ["provider:test"] }],
      }),
    /version/,
  );
  assert.throws(
    () =>
      broker.register({
        id: "bad-expiry",
        value: "secret",
        expiresAt: "not-a-date",
        scopes: [{ audiences: ["provider:test"] }],
      }),
    /expiry/,
  );

  broker.register({
    id: "expiring",
    value: "short-lived",
    expiresAt: new Date(Date.now() + 20).toISOString(),
    scopes: [{ audiences: ["provider:test"], header: "authorization" }],
  });
  const lease = broker.lease({
    credentialId: "expiring",
    audience: "provider:test",
    ttlMs: 60_000,
  });
  await delay(30);
  assert.throws(() => broker.injectHeaders(lease), /expired/);
});

test("Credential Broker: async resolution cannot outlive credential expiry", async () => {
  let resolveRead!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    resolveRead = resolve;
  });
  let reads = 0;
  const backend: SecretBackend = {
    kind: "delayed-vault",
    get: async () => {
      reads++;
      return pending;
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "async-expiring",
    backend,
    expiresAt: new Date(Date.now() + 20).toISOString(),
    scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
  });
  const read = broker.trustedValueAsync("async-expiring", {
    audience: "provider:test",
    host: "provider.example",
  });
  await delay(30);
  resolveRead("must-not-escape");
  await assert.rejects(read, /expired/);
  assert.equal(broker.availability("async-expiring"), "unavailable");
  assert.equal(reads, 1);
});

test("Credential Broker: sync reference cache expires, rereads and observes external deletion", async () => {
  const backend = new ObservedSecretBackend();
  backend.values.set("rotating", "value-v1");
  const broker = new CredentialBroker({
    referenceCacheTtlMs: 10,
    unavailableCacheTtlMs: 1_000,
  });
  broker.registerReference({
    id: "rotating",
    backend,
    scopes: [{ audiences: ["provider:test"], hosts: ["provider.example"] }],
  });
  const request = { audience: "provider:test", host: "provider.example" } as const;

  assert.equal(broker.trustedValue("rotating", request), "value-v1");
  backend.values.set("rotating", "value-v2");
  assert.equal(broker.trustedValue("rotating", request), "value-v1");
  assert.equal(backend.reads, 1);
  await delay(20);
  assert.equal(broker.trustedValue("rotating", request), "value-v2");
  assert.equal(backend.reads, 2);

  backend.values.delete("rotating");
  assert.equal(broker.trustedValue("rotating", request), "value-v2");
  await delay(20);
  assert.throws(() => broker.trustedValue("rotating", request), /unavailable/);
  assert.throws(() => broker.trustedValue("rotating", request), /unavailable/);
  assert.equal(backend.reads, 3, "external deletion is reread once, then negatively cached");
});

test("Credential Broker: oversized environment secrets fail before registration without echoing values", () => {
  const secret = `do-not-echo-${"x".repeat(64 * 1024)}`;
  const env: NodeJS.ProcessEnv = {
    FIRST_API_KEY: "must-remain-on-atomic-failure",
    OVERSIZED_API_TOKEN: secret,
  };
  assert.throws(
    () => credentialBrokerFromEnv(env, { remove: true }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /OVERSIZED_API_TOKEN.*65536 bytes/);
      assert.doesNotMatch(error.message, /do-not-echo/);
      return true;
    },
  );
  assert.equal(env.FIRST_API_KEY, "must-remain-on-atomic-failure");

  const overlongName = `${"A".repeat(121)}_API_KEY`;
  assert.throws(
    () =>
      credentialBrokerFromEnv(
        { ANICODE_CREDENTIAL_KEYS: overlongName },
        { backend: new ObservedSecretBackend() },
      ),
    /invalid credential name/,
  );
});

test("Credential Broker: 后端引用、轮换、旧 lease 撤销和审计", async () => {
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
  await flushCredentialAudit();
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

test("Vault: plaintext HTTP is restricted to explicit loopback addresses", () => {
  const tokenProvider = new StaticVaultTokenProvider("test-token");
  for (const address of [
    "https://vault.example",
    "http://localhost:8200",
    "http://localhost.:8200",
    "http://127.0.0.1:8200",
    "http://127.255.255.255:8200",
    "http://[::1]:8200",
  ]) {
    assert.doesNotThrow(() => new VaultKvV2SecretBackend({ address, tokenProvider }), address);
  }
  for (const address of [
    "http://vault.example:8200",
    "http://10.0.0.1:8200",
    "http://169.254.169.254:8200",
    "http://0.0.0.0:8200",
    "http://[::]:8200",
    "http://foo.localhost:8200",
  ]) {
    assert.throws(
      () => new VaultKvV2SecretBackend({ address, tokenProvider }),
      /must use HTTPS.*explicit loopback/,
      address,
    );
  }
});

test("Vault KV: mount and prefix cannot traverse or create coordination aliases", async () => {
  const tokenProvider = new StaticVaultTokenProvider("test-token");
  for (const options of [
    { prefix: "." },
    { prefix: ".." },
    { prefix: "tenant/../../sys" },
    { prefix: "tenant//prod" },
    { prefix: "tenant/\u0000/prod" },
    { mount: "../secret" },
  ]) {
    assert.throws(
      () =>
        new VaultKvV2SecretBackend({ address: "https://vault.example", tokenProvider, ...options }),
      /without dot traversal or controls/,
    );
  }

  let requested = "";
  const backend = new VaultKvV2SecretBackend({
    address: "https://vault.example",
    tokenProvider,
    mount: "/team vault/secret/",
    prefix: "/tenant a/prod/",
    fetch: (async (input) => {
      requested = String(input);
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  });
  await backend.get("provider:key");
  assert.equal(
    requested,
    "https://vault.example/v1/team%20vault/secret/data/tenant%20a/prod/provider%3Akey",
  );
});

test("Vault backends snapshot routing, identity and auth options at construction", async () => {
  let kvRequest: { url: string; headers: Headers } | undefined;
  let originalTokenCalls = 0;
  const tokenProvider = {
    token: async () => {
      originalTokenCalls++;
      return "original-token";
    },
  };
  const kvOptions = {
    address: "https://vault.example",
    tokenProvider,
    prefix: "tenant/original",
    namespace: "namespace/original",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      kvRequest = { url: String(input), headers: new Headers(init?.headers) };
      return new Response(null, { status: 404 });
    }) as typeof fetch,
  };
  const kv = new VaultKvV2SecretBackend(kvOptions);
  kvOptions.prefix = "../../sys";
  kvOptions.namespace = "namespace/mutated";
  tokenProvider.token = async () => "mutated-token";
  await kv.get("key");
  assert.equal(originalTokenCalls, 1);
  assert.equal(kvRequest?.url, "https://vault.example/v1/secret/data/tenant/original/key");
  assert.equal(kvRequest?.headers.get("x-vault-token"), "original-token");
  assert.equal(kvRequest?.headers.get("x-vault-namespace"), "namespace/original");

  let jwtRequest: { url: string; headers: Headers; body: string } | undefined;
  let observedAudience: string | undefined;
  const jwtOptions = {
    address: "https://vault.example",
    role: "original-role",
    mount: "auth-team/jwt",
    namespace: "namespace/original",
    audience: "original-audience",
    oidc: async (audience?: string) => {
      observedAudience = audience;
      return "original-jwt";
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      jwtRequest = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: String(init?.body),
      };
      return Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } });
    }) as typeof fetch,
  };
  const jwt = new VaultJwtTokenProvider(jwtOptions);
  jwtOptions.role = "mutated-role";
  jwtOptions.mount = "../../sys";
  jwtOptions.namespace = "namespace/mutated";
  jwtOptions.audience = "mutated-audience";
  jwtOptions.oidc = async () => "mutated-jwt";
  jwtOptions.fetch = (async () => {
    throw new Error("mutated fetch must not run");
  }) as typeof fetch;
  assert.equal(await jwt.token(), "vault-token");
  assert.equal(observedAudience, "original-audience");
  assert.equal(jwtRequest?.url, "https://vault.example/v1/auth/auth-team/jwt/login");
  assert.equal(jwtRequest?.headers.get("x-vault-namespace"), "namespace/original");
  assert.deepEqual(JSON.parse(jwtRequest?.body ?? ""), {
    role: "original-role",
    jwt: "original-jwt",
  });
});

test("OIDC: non-cooperative fetch 受硬截止、收到 abort 且异常不泄漏 request token", async () => {
  const requestToken = "oidc-request-secret-value";
  let requestSignal: AbortSignal | undefined;
  const oidc = githubActionsOidcProvider(
    {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: requestToken,
    },
    (async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch,
    { requestTimeoutMs: 20 },
  );
  const error = await capturedError(oidc("vault"));
  assert.match(error.message, /OIDC token request timed out after 20ms/);
  assert.doesNotMatch(error.stack ?? error.message, new RegExp(requestToken));
  assert.equal(requestSignal?.aborted, true);
});

test("OIDC: oversized response is cancelled before JSON parsing", async () => {
  let cancelled = false;
  const oidc = githubActionsOidcProvider(
    {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
    },
    (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from(JSON.stringify({ value: "x".repeat(256) })));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
    { maxResponseBytes: 64 },
  );
  await assert.rejects(oidc(), /response exceeds 64 bytes/);
  assert.equal(cancelled, true);
});

test("OIDC: projected token files are bounded and honor pre-aborted callers", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-oidc-file-"));
  const file = path.join(directory, "token");
  try {
    await fs.writeFile(file, "x".repeat(65));
    const provider = oidcTokenFileProvider(file, { maxTokenBytes: 64 });
    await assert.rejects(provider(), /OIDC token file exceeds 64 bytes/);
    const controller = new AbortController();
    controller.abort(new Error("sensitive abort reason"));
    const error = await capturedError(provider(undefined, controller.signal));
    assert.equal(error.message, "OIDC token file was cancelled");
    assert.doesNotMatch(error.stack ?? error.message, /sensitive abort reason/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("Vault: OIDC、token provider 与 response consumption 共享绝对截止", async () => {
  let oidcSignal: AbortSignal | undefined;
  let vaultCalls = 0;
  const provider = new VaultJwtTokenProvider({
    address: "https://vault.example",
    role: "anicode",
    requestTimeoutMs: 20,
    oidc: async (_audience, signal) => {
      oidcSignal = signal;
      return new Promise<string>(() => undefined);
    },
    fetch: (async () => {
      vaultCalls++;
      return Response.json({});
    }) as typeof fetch,
  });
  await assert.rejects(provider.token(), /Vault JWT login timed out after 20ms/);
  assert.equal(oidcSignal?.aborted, true);
  assert.equal(vaultCalls, 0);
});

test("Vault: concurrent refresh is single-flight and one caller abort cannot poison others", async () => {
  let resolveLogin!: (response: Response) => void;
  let loginStarted!: () => void;
  const login = new Promise<Response>((resolve) => {
    resolveLogin = resolve;
  });
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  let vaultCalls = 0;
  let requestSignal: AbortSignal | undefined;
  const provider = new VaultJwtTokenProvider({
    address: "https://vault.example",
    role: "anicode",
    oidc: async () => "short-jwt",
    fetch: (async (_url, init) => {
      vaultCalls++;
      requestSignal = init?.signal ?? undefined;
      loginStarted();
      return login;
    }) as typeof fetch,
  });
  const controller = new AbortController();
  const disconnected = provider.token(controller.signal);
  const healthy = provider.token();
  await started;
  controller.abort();
  await assert.rejects(disconnected, /Vault JWT login was cancelled/);
  assert.equal(requestSignal?.aborted, false);
  resolveLogin(Response.json({ auth: { client_token: "vault-token", lease_duration: 300 } }));
  assert.equal(await healthy, "vault-token");
  assert.equal(await provider.token(), "vault-token");
  assert.equal(vaultCalls, 1);
});

test("Vault: unreasonable token lease duration is rejected instead of cached indefinitely", async () => {
  const provider = new VaultJwtTokenProvider({
    address: "https://vault.example",
    role: "anicode",
    oidc: async () => "short-jwt",
    fetch: (async () =>
      Response.json({
        auth: { client_token: "vault-token", lease_duration: 86_401 },
      })) as typeof fetch,
  });
  await assert.rejects(provider.token(), /invalid lease duration/);
});

test("Vault KV: hard timeout, caller abort and void-response release are fail closed", async () => {
  let requestSignal: AbortSignal | undefined;
  const stalled = new VaultKvV2SecretBackend({
    address: "https://vault.example",
    tokenProvider: new StaticVaultTokenProvider("vault-secret-token"),
    requestTimeoutMs: 20,
    fetch: (async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch,
  });
  await assert.rejects(stalled.get("key"), /Vault secret read timed out after 20ms/);
  assert.equal(requestSignal?.aborted, true);

  let cancelled = false;
  const writable = new VaultKvV2SecretBackend({
    address: "https://vault.example",
    tokenProvider: new StaticVaultTokenProvider("vault-secret-token"),
    fetch: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from("ignored"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      )) as typeof fetch,
  });
  await writable.put("key", "sensitive-value");
  assert.equal(cancelled, true);
});

test("Vault KV: transport exceptions do not expose token or secret value", async () => {
  const token = "vault-sensitive-token";
  const value = "vault-sensitive-value";
  const backend = new VaultKvV2SecretBackend({
    address: "https://vault.example",
    tokenProvider: new StaticVaultTokenProvider(token),
    fetch: (async () => {
      throw new Error(`transport echoed ${token} ${value}`);
    }) as typeof fetch,
  });
  const error = await capturedError(backend.put("key", value));
  assert.equal(error.message, "Vault secret write failed");
  assert.doesNotMatch(error.stack ?? error.message, /vault-sensitive-token|vault-sensitive-value/);
});

test("Vault KV: streamed secret responses are bounded and cancelled", async () => {
  let cancelled = false;
  const backend = new VaultKvV2SecretBackend({
    address: "https://vault.example",
    tokenProvider: new StaticVaultTokenProvider("vault-token"),
    maxResponseBytes: 64,
    fetch: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              Buffer.from(JSON.stringify({ data: { data: { value: "x".repeat(256) } } })),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  });
  await assert.rejects(backend.get("key"), /response exceeds 64 bytes/);
  assert.equal(cancelled, true);
});

test("KMS: snapshots key/context options and protects reserved credential binding", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kms-snapshot-"));
  let encryptInput: Record<string, unknown> | undefined;
  const client: KmsLikeClient = {
    send: async (command) => {
      encryptInput = (command as { input?: Record<string, unknown> }).input;
      return { CiphertextBlob: Buffer.from("ciphertext") };
    },
  };
  const encryptionContext = { tenant: "original" };
  const options = {
    keyId: "alias/original",
    directory,
    encryptionContext,
    client,
  };
  try {
    const backend = new AwsKmsSecretBackend(options);
    options.keyId = "alias/mutated";
    encryptionContext.tenant = "mutated";
    options.encryptionContext = { tenant: "replaced" };
    await backend.put("provider", "safe-value");
    assert.equal(encryptInput?.["KeyId"], "alias/original");
    assert.deepEqual(encryptInput?.["EncryptionContext"], {
      tenant: "original",
      service: "anicode",
      credential: "provider",
    });
    assert.throws(
      () =>
        new AwsKmsSecretBackend({
          keyId: "alias/test",
          directory,
          encryptionContext: { credential: "override" },
          client,
        }),
      /cannot override reserved field credential/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("KMS: SDK calls have hard abort deadlines and never persist late ciphertext", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kms-timeout-"));
  let requestSignal: AbortSignal | undefined;
  try {
    const backend = new AwsKmsSecretBackend({
      keyId: "alias/test",
      directory,
      requestTimeoutMs: 20,
      client: {
        send: async (_command, options) => {
          requestSignal = options?.abortSignal;
          return new Promise<never>(() => undefined);
        },
      },
    });
    await assert.rejects(backend.put("key", "secret"), /KMS encrypt timed out after 20ms/);
    assert.equal(requestSignal?.aborted, true);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("KMS: SDK error metadata and oversized ciphertext fail without leaking plaintext", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kms-boundary-"));
  const plaintext = "kms-sensitive-plaintext";
  try {
    const leaking = new AwsKmsSecretBackend({
      keyId: "alias/test",
      directory,
      client: {
        send: async () => {
          throw new Error(`SDK echoed ${plaintext}`);
        },
      },
    });
    const error = await capturedError(leaking.put("key", plaintext));
    assert.equal(error.message, "KMS encrypt failed");
    assert.doesNotMatch(error.stack ?? error.message, new RegExp(plaintext));

    const oversized = new AwsKmsSecretBackend({
      keyId: "alias/test",
      directory,
      maxResponseBytes: 64,
      client: { send: async () => ({ CiphertextBlob: Buffer.alloc(65) }) },
    });
    await assert.rejects(oversized.put("key", "safe"), /KMS ciphertext exceeds 64 bytes/);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
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
  await Promise.resolve();
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.success, true);
  assert.equal(audit[0]?.version, 2);
});

test("CredentialRotationManager: rejects timer values that Node would clamp into a write storm", () => {
  const broker = new CredentialBroker();
  const backend = new MemorySecretBackend();
  for (const intervalMs of [Number.NaN, Number.POSITIVE_INFINITY, 59_999, 2_147_483_648]) {
    const manager = new CredentialRotationManager(broker);
    assert.throws(
      () =>
        manager.register({
          credentialId: "invalid-interval",
          backend,
          intervalMs,
          issue: async () => "new-secret",
        }),
      /rotation interval must be a safe integer/,
    );
  }
  for (const timeoutMs of [Number.NaN, Number.POSITIVE_INFINITY, 0, 300_001]) {
    const manager = new CredentialRotationManager(broker);
    assert.throws(
      () =>
        manager.register({
          credentialId: `invalid-timeout-${String(timeoutMs)}`,
          backend,
          intervalMs: 60_000,
          timeoutMs,
          issue: async () => "new-secret",
        }),
      /rotation timeout must be a safe integer/,
    );
  }
});

test("CredentialRotationManager: snapshots policy routing before callers can mutate it", async () => {
  const backend = new MemorySecretBackend();
  backend.putSync("stable-key", "token-v1");
  let redirectedWrites = 0;
  const redirected: SecretBackend = {
    kind: "redirected-backend",
    get: async () => undefined,
    put: async () => void redirectedWrites++,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "policy-snapshot",
    backend,
    backendKey: "stable-key",
    scopes: [{ audiences: ["provider:test"] }],
  });
  let originalIssues = 0;
  const policy = {
    credentialId: "policy-snapshot",
    backend: backend as SecretBackend,
    backendKey: "stable-key",
    intervalMs: 60_000,
    timeoutMs: 1_000,
    issue: async () => {
      originalIssues++;
      return "original-candidate";
    },
  };
  const manager = new CredentialRotationManager(broker);
  manager.register(policy);
  policy.credentialId = "redirected-id";
  policy.backend = redirected;
  policy.backendKey = "redirected-key";
  policy.intervalMs = Number.NaN;
  policy.timeoutMs = 1;
  policy.issue = async () => "redirected-candidate";
  manager.start();
  manager.stop();

  assert.equal(await manager.rotateNow("policy-snapshot"), 2);
  assert.equal(originalIssues, 1);
  assert.equal(redirectedWrites, 0);
  assert.equal(backend.getSync("stable-key"), "original-candidate");
});

test("CredentialRotationManager: preflights generation and never issues for unknown or expired ids", async () => {
  const backend = new MemorySecretBackend();
  const broker = new CredentialBroker();
  broker.register({
    id: "expired-rotation",
    value: "expired-value",
    scopes: [{ audiences: ["provider:test"] }],
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
  });
  let issues = 0;
  const manager = new CredentialRotationManager(broker);
  for (const credentialId of ["unknown-rotation", "expired-rotation"]) {
    manager.register({
      credentialId,
      backend,
      intervalMs: 60_000,
      issue: async () => {
        issues++;
        return "must-not-be-issued";
      },
    });
    await assert.rejects(manager.rotateNow(credentialId), /unknown or expired/);
  }
  assert.equal(issues, 0);
});

test("CredentialRotationManager: generation changes quarantine a stale issued candidate", async () => {
  const backend = new MemorySecretBackend();
  backend.putSync("generation-key", "token-v1");
  const broker = new CredentialBroker();
  const register = () =>
    broker.registerReference({
      id: "manager-generation",
      backend,
      backendKey: "generation-key",
      scopes: [{ audiences: ["provider:test"] }],
    });
  register();
  let releaseIssue!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseIssue = resolve;
  });
  let issues = 0;
  const revoked: string[] = [];
  const manager = new CredentialRotationManager(broker);
  manager.register({
    credentialId: "manager-generation",
    backend,
    backendKey: "generation-key",
    intervalMs: 60_000,
    issue: async () => {
      issues++;
      await gate;
      return "stale-issued-candidate";
    },
    revokeIssued: async (issued) => void revoked.push(issued.value),
  });

  const rotating = manager.rotateNow("manager-generation");
  await Promise.resolve();
  assert.equal(broker.revoke("manager-generation"), true);
  backend.putSync("generation-key", "operator-recovery");
  register();
  releaseIssue();
  await assert.rejects(rotating, /generation changed/);
  await assert.rejects(manager.rotateNow("manager-generation"), /generation changed/);
  assert.equal(issues, 1);
  assert.equal(backend.getSync("generation-key"), "operator-recovery");
  assert.equal(await manager.discardPending("manager-generation"), true);
  assert.deepEqual(revoked, ["stale-issued-candidate"]);
});

test("CredentialRotationManager: issuer deadline aborts without losing a late candidate", async () => {
  const backend = new MemorySecretBackend();
  backend.putSync("slow-issuer", "token-v1");
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "slow-issuer",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  let resolveIssue!: (value: string) => void;
  const issuedLater = new Promise<string>((resolve) => {
    resolveIssue = resolve;
  });
  let issues = 0;
  let issuerSignal: AbortSignal | undefined;
  const revoked: string[] = [];
  const manager = new CredentialRotationManager(broker);
  manager.register({
    credentialId: "slow-issuer",
    backend,
    intervalMs: 60_000,
    timeoutMs: 10,
    issue: async (signal) => {
      issues++;
      issuerSignal = signal;
      return issuedLater;
    },
    revokeIssued: async (issued) => void revoked.push(issued.value),
  });

  await assert.rejects(manager.rotateNow("slow-issuer"), /issuance exceeded its deadline/);
  assert.equal(issuerSignal?.aborted, true);
  await assert.rejects(manager.rotateNow("slow-issuer"), /issuance exceeded its deadline/);
  assert.equal(issues, 1, "a timed-out non-cooperative issuer remains single-flight");
  resolveIssue("late-issued-candidate");
  await delay(0);
  assert.equal(await manager.discardPending("slow-issuer"), true);
  assert.deepEqual(revoked, ["late-issued-candidate"]);
  assert.equal(backend.getSync("slow-issuer"), "token-v1");
});

test("CredentialRotationManager: issuance consumes the shared write deadline budget", async () => {
  const backend = new MemorySecretBackend();
  backend.putSync("shared-deadline", "token-v1");
  const broker = new ObservedRotationBroker();
  broker.registerReference({
    id: "shared-deadline",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  let issueStarted = 0;
  let issueFinished = 0;
  const timeoutMs = 5_000;
  const manager = new CredentialRotationManager(broker);
  manager.register({
    credentialId: "shared-deadline",
    backend,
    intervalMs: 60_000,
    timeoutMs,
    issue: async () => {
      issueStarted = performance.now();
      await delay(40);
      issueFinished = performance.now();
      return "token-v2";
    },
  });

  assert.equal(await manager.rotateNow("shared-deadline"), 2);
  const writeTimeoutMs = broker.observedWriteTimeoutMs;
  assert.ok(writeTimeoutMs !== undefined);
  const issueElapsedMs = issueFinished - issueStarted;
  assert.ok(issueElapsedMs >= 20, "the issuer must consume a measurable part of the budget");
  assert.ok(writeTimeoutMs > 0);
  assert.ok(writeTimeoutMs < timeoutMs);
  assert.ok(
    writeTimeoutMs <= timeoutMs - Math.floor(issueElapsedMs),
    "the backend must receive only the budget left after issuance",
  );
  assert.equal(backend.getSync("shared-deadline"), "token-v2");
});

test("CredentialRotationManager: cleanup timeout is bounded, quarantined, and safely retryable", async () => {
  const candidate = "cleanup-candidate-must-not-leak";
  // Leave enough of the shared issue/write budget for a preempted CI worker to reach the backend.
  // Cleanup still uses the real policy timer below, so timeout, abort, quarantine, and retry stay
  // covered without relying on a sub-scheduler-quantum deadline.
  const timeoutMs = 250;
  const backend: SecretBackend = {
    kind: "cleanup-timeout-backend",
    get: async () => "token-v1",
    put: async () => {
      throw new Error("backend write failed");
    },
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "cleanup-timeout",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  let rejectLateCleanup!: (reason: Error) => void;
  const cleanupSignals: AbortSignal[] = [];
  const cleanupValues: string[] = [];
  let cleanupAttempts = 0;
  const manager = new CredentialRotationManager(broker);
  manager.register({
    credentialId: "cleanup-timeout",
    backend,
    intervalMs: 60_000,
    timeoutMs,
    issue: async () => candidate,
    revokeIssued: async (issued, signal) => {
      cleanupAttempts++;
      assert.ok(signal);
      cleanupSignals.push(signal);
      cleanupValues.push(issued.value);
      if (cleanupAttempts === 1) {
        return new Promise<void>((_resolve, reject) => {
          rejectLateCleanup = reject;
        });
      }
    },
  });

  await assert.rejects(manager.rotateNow("cleanup-timeout"), CredentialRotationError);
  const cleanupStarted = performance.now();
  const firstCleanup = manager.discardPending("cleanup-timeout");
  const sharedCleanup = manager.discardPending("cleanup-timeout");
  assert.strictEqual(sharedCleanup, firstCleanup, "concurrent cleanup must be single-flight");
  const cleanupError = await capturedError(firstCleanup);
  assert.equal(cleanupError.message, "Credential issuer cleanup exceeded its deadline");
  assert.doesNotMatch(cleanupError.stack ?? cleanupError.message, new RegExp(candidate));
  assert.ok(performance.now() - cleanupStarted < 1_000, "cleanup must bound caller wait");
  assert.equal(cleanupAttempts, 1);
  assert.equal(cleanupSignals[0]?.aborted, true);

  await assert.rejects(
    manager.rotateNow("cleanup-timeout"),
    /issuer cleanup requires explicit retry/,
  );
  assert.equal(await manager.discardPending("cleanup-timeout"), true);
  assert.equal(cleanupAttempts, 2);
  assert.deepEqual(cleanupValues, [candidate, candidate]);
  assert.equal(cleanupSignals[1]?.aborted, false);
  assert.equal(await manager.discardPending("cleanup-timeout"), false);

  // A non-cooperative first attempt may reject after the caller has retried successfully. The
  // bounded waiter must still observe that rejection instead of leaking an unhandled rejection.
  rejectLateCleanup(new Error(`issuer echoed ${candidate}`));
  await delay(0);
});

test("CredentialRotationManager: issuer-controlled errors cannot inject audit fields", async () => {
  const backend = new MemorySecretBackend();
  backend.putSync("audit-injection", "token-v1");
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "audit-injection",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  const audit: Array<{ error?: string }> = [];
  const manager = new CredentialRotationManager(broker, (event) => void audit.push(event));
  manager.register({
    credentialId: "audit-injection",
    backend,
    intervalMs: 60_000,
    issue: async () => {
      const error = new Error("issuer failure") as Error & { reason: string };
      error.name = "CredentialRotationError";
      error.reason = "AUDIT_SECRET\nforged=true";
      throw error;
    },
  });
  await assert.rejects(manager.rotateNow("audit-injection"), /Credential issuance failed/);
  await Promise.resolve();
  assert.equal(audit.length, 1);
  assert.equal(audit[0]?.error, "credential rotation failed");
});

test("CredentialRotationManager: issue+write single-flight and audit failures are observational", async () => {
  const backend = new MemorySecretBackend();
  backend.putSync("single-flight", "token-v1");
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "single-flight",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  let releaseIssue!: () => void;
  const issueGate = new Promise<void>((resolve) => {
    releaseIssue = resolve;
  });
  let issues = 0;
  const manager = new CredentialRotationManager(broker, () => {
    throw new Error("audit sink unavailable");
  });
  manager.register({
    credentialId: "single-flight",
    backend,
    intervalMs: 60_000,
    issue: async () => {
      issues++;
      await issueGate;
      return "token-v2";
    },
  });

  const first = manager.rotateNow("single-flight");
  const shared = manager.rotateNow("single-flight");
  assert.strictEqual(first, shared);
  releaseIssue();
  assert.equal(await first, 2);
  assert.equal(await shared, 2);
  assert.equal(issues, 1);
  assert.equal(backend.getSync("single-flight"), "token-v2");
});

test("CredentialRotationManager: indeterminate retry reuses the same issued candidate", async () => {
  let writes = 0;
  let failAfterCommit = true;
  let stored = "token-v1";
  const backend: SecretBackend = {
    kind: "rotation-retry-vault",
    get: async () => stored,
    put: async (_key, value) => {
      writes++;
      stored = value;
      if (failAfterCommit) throw new Error(`backend echoed ${value}`);
    },
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "retry-provider",
    backend,
    scopes: [{ audiences: ["provider:test"] }],
  });
  let issues = 0;
  const audit: Array<{ success: boolean; error?: string }> = [];
  const manager = new CredentialRotationManager(broker, (event) => {
    audit.push(event);
  });
  manager.register({
    credentialId: "retry-provider",
    backend,
    intervalMs: 60_000,
    issue: async () => {
      issues++;
      return "issued-candidate-secret";
    },
  });

  await assert.rejects(manager.rotateNow("retry-provider"), CredentialRotationError);
  failAfterCommit = false;
  assert.equal(await manager.rotateNow("retry-provider"), 2);
  assert.equal(issues, 1);
  assert.equal(writes, 2);
  assert.equal(stored, "issued-candidate-secret");
  await Promise.resolve();
  assert.deepEqual(
    audit.map((event) => event.success),
    [false, true],
  );
  assert.doesNotMatch(audit[0]?.error ?? "", /issued-candidate-secret/);
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
