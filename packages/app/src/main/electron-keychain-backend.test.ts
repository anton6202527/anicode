import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  OS_KEYCHAIN_DISABLED_ENV,
  OsKeychainDisabledError,
  OsKeychainMutationError,
} from "@anicode/core";
import {
  ElectronKeychainReadError,
  ElectronUtilityKeychainBackend,
  electronKeychainUtilityEnvironment,
  type ElectronKeychainUtilityFactory,
  type ElectronKeychainUtilityProcess,
} from "./electron-keychain-backend.js";

type FakeMode = "failure" | "invalid" | "success" | "timeout";

class FakeUtility extends EventEmitter implements ElectronKeychainUtilityProcess {
  readonly pid = 4242;
  killed = false;
  request: Record<string, unknown> | undefined;

  constructor(private readonly mode: FakeMode) {
    super();
    queueMicrotask(() => this.emit("spawn"));
  }

  postMessage(message: unknown): void {
    this.request = structuredClone(message) as Record<string, unknown>;
    if (this.mode === "timeout") return;
    queueMicrotask(() => {
      if (this.mode === "failure") {
        this.emit("exit", 1);
        return;
      }
      if (this.mode === "invalid") {
        this.emit("message", { version: 1, ok: true, operation: "wrong" });
        return;
      }
      const operation = this.request?.["operation"];
      if (operation === "get") {
        this.emit("message", {
          version: 1,
          ok: true,
          operation,
          found: true,
          value: "fake-keychain-value",
        });
      } else if (operation === "put") {
        this.emit("message", { version: 1, ok: true, operation });
      } else {
        this.emit("message", { version: 1, ok: true, operation: "delete", deleted: true });
      }
    });
  }

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

class FakeUtilityFactory implements ElectronKeychainUtilityFactory {
  readonly children: FakeUtility[] = [];
  readonly invocations: Array<{
    modulePath: string;
    args: readonly string[];
    options: Parameters<ElectronKeychainUtilityFactory["fork"]>[2];
  }> = [];

  constructor(private readonly mode: FakeMode) {}

  fork(
    modulePath: string,
    args: readonly string[],
    options: Parameters<ElectronKeychainUtilityFactory["fork"]>[2],
  ): FakeUtility {
    this.invocations.push({ modulePath, args, options });
    const child = new FakeUtility(this.mode);
    this.children.push(child);
    return child;
  }
}

async function withKeychainEnabled<T>(operation: () => T | Promise<T>): Promise<T> {
  const previous = process.env[OS_KEYCHAIN_DISABLED_ENV];
  delete process.env[OS_KEYCHAIN_DISABLED_ENV];
  try {
    return await operation();
  } finally {
    if (previous === undefined) delete process.env[OS_KEYCHAIN_DISABLED_ENV];
    else process.env[OS_KEYCHAIN_DISABLED_ENV] = previous;
  }
}

function paths() {
  const root = path.join(os.tmpdir(), "anicode-electron-keychain-test");
  return {
    helperPath: path.join(root, "keychain-utility-helper.js"),
    modulePath: path.join(root, "node_modules", "@napi-rs", "keyring", "index.js"),
  };
}

test("Electron Keychain backend sentinel prevents utility process creation", () => {
  const factory = new FakeUtilityFactory("success");
  const previous = process.env[OS_KEYCHAIN_DISABLED_ENV];
  process.env[OS_KEYCHAIN_DISABLED_ENV] = "1";
  try {
    assert.throws(
      () => new ElectronUtilityKeychainBackend({ ...paths(), utilityFactory: factory }),
      OsKeychainDisabledError,
    );
    assert.equal(factory.children.length, 0);
  } finally {
    if (previous === undefined) delete process.env[OS_KEYCHAIN_DISABLED_ENV];
    else process.env[OS_KEYCHAIN_DISABLED_ENV] = previous;
  }
});

test("Electron Keychain backend spawns one bounded utility only on explicit operations", async () => {
  await withKeychainEnabled(async () => {
    const secret = "fake-put-secret-never-in-process-metadata";
    const factory = new FakeUtilityFactory("success");
    const backend = new ElectronUtilityKeychainBackend({
      ...paths(),
      utilityFactory: factory,
      environment: {
        HOME: "/isolated/home",
        LANG: "zh_CN.UTF-8",
        NODE_OPTIONS: "--require hostile-preload",
        PUBLISH_TOKEN: secret,
      },
    });
    assert.equal(factory.children.length, 0, "construction must not spawn a utility process");

    assert.equal(await backend.get("provider-key"), "fake-keychain-value");
    await backend.put("provider-key", secret);
    assert.equal(await backend.delete("provider-key"), true);
    assert.equal(factory.children.length, 3);

    assert.deepEqual(
      factory.children.map((child) => child.request?.["operation"]),
      ["get", "put", "delete"],
    );
    assert.equal(factory.children[1]?.request?.["value"], secret);
    for (const invocation of factory.invocations) {
      assert.deepEqual(invocation.args, []);
      assert.equal(invocation.modulePath, paths().helperPath);
      assert.equal(invocation.options.execArgv.length, 0);
      assert.equal(invocation.options.stdio, "ignore");
      assert.equal(invocation.options.cwd, path.dirname(process.execPath));
      assert.equal(invocation.options.env.HOME, "/isolated/home");
      assert.equal(invocation.options.env.LANG, "zh_CN.UTF-8");
      assert.equal(invocation.options.env.NODE_OPTIONS, undefined);
      assert.equal(invocation.options.env.PUBLISH_TOKEN, undefined);
      assert.equal(JSON.stringify(invocation).includes(secret), false);
    }
    assert.ok(factory.children.every((child) => child.killed));
  });
});

test("Electron Keychain hard timeout is safe for reads and indeterminate for mutations", async () => {
  await withKeychainEnabled(async () => {
    const secret = "timeout-secret-must-not-escape";
    const factory = new FakeUtilityFactory("timeout");
    const forceKilled: ElectronKeychainUtilityProcess[] = [];
    const backend = new ElectronUtilityKeychainBackend({
      ...paths(),
      utilityFactory: factory,
      timeoutMs: 10,
      forceKill: (child) => forceKilled.push(child),
    });

    await assert.rejects(backend.get("read-timeout"), (error) => {
      assert.ok(error instanceof ElectronKeychainReadError);
      assert.match(error.message, /timed out after 10ms/);
      assert.doesNotMatch(error.stack ?? error.message, new RegExp(secret));
      return true;
    });
    await assert.rejects(backend.put("write-timeout", secret), (error) => {
      assert.ok(error instanceof OsKeychainMutationError);
      assert.equal(error.outcome, "indeterminate");
      assert.equal(error.reason, "timed-out");
      assert.doesNotMatch(error.stack ?? error.message, new RegExp(secret));
      return true;
    });
    assert.equal(forceKilled.length, 2);
  });
});

test("Electron Keychain abort and malformed replies fail closed without native access", async () => {
  await withKeychainEnabled(async () => {
    const preAbortedFactory = new FakeUtilityFactory("success");
    const preAborted = new ElectronUtilityKeychainBackend({
      ...paths(),
      utilityFactory: preAbortedFactory,
    });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(preAborted.get("cancelled", controller.signal), /cancelled/);
    assert.equal(preAbortedFactory.children.length, 0);

    const invalidFactory = new FakeUtilityFactory("invalid");
    const invalid = new ElectronUtilityKeychainBackend({
      ...paths(),
      utilityFactory: invalidFactory,
    });
    await assert.rejects(invalid.get("invalid"), /invalid response/);
  });
});

test("Electron Keychain backend close force-terminates and settles active utilities", async () => {
  await withKeychainEnabled(async () => {
    const factory = new FakeUtilityFactory("timeout");
    const forceKilled: ElectronKeychainUtilityProcess[] = [];
    const backend = new ElectronUtilityKeychainBackend({
      ...paths(),
      utilityFactory: factory,
      timeoutMs: 1_000,
      forceKill: (child) => forceKilled.push(child),
    });
    const pending = backend.get("active-read");
    await Promise.resolve();
    backend.close();
    await assert.rejects(pending, /cancelled/);
    assert.equal(forceKilled.length, 1);
    await assert.rejects(backend.get("closed-read"), /read failed/);
    assert.equal(factory.children.length, 1);
  });
});

test("Electron Keychain utility environment is an explicit non-secret allowlist", () => {
  const environment = electronKeychainUtilityEnvironment({
    home: "/case-insensitive-home",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    AWS_SECRET_ACCESS_KEY: "forbidden",
    ELECTRON_RUN_AS_NODE: "1",
    NAPI_RS_NATIVE_LIBRARY_PATH: "/tmp/hostile.node",
    NODE_PATH: "/tmp/hostile-modules",
  });
  assert.equal(environment.HOME, "/case-insensitive-home");
  assert.equal(environment.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1000/bus");
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(environment.NAPI_RS_NATIVE_LIBRARY_PATH, undefined);
  assert.equal(environment.NODE_PATH, undefined);
});
