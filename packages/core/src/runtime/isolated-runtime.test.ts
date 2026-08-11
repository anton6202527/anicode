import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertBoundedStdin,
  IsolatedRuntime,
  resolveWindowsTaskkillPath,
  scopedProxyEnvironment,
} from "./isolated-runtime.js";

const POSIX_ONLY = {
  skip: process.platform === "win32" ? "requires a POSIX process group" : false,
};

const PROXY_ENVIRONMENT_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

test("Windows process-tree cleanup resolves taskkill from absolute SystemRoot", () => {
  assert.equal(
    resolveWindowsTaskkillPath({ SystemRoot: "C:\\Windows" }),
    "C:\\Windows\\System32\\taskkill.exe",
  );
  assert.throws(() => resolveWindowsTaskkillPath({}), /absolute SystemRoot/);
  assert.throws(
    () => resolveWindowsTaskkillPath({ SystemRoot: "relative\\windows" }),
    /absolute SystemRoot/,
  );
});

test("IsolatedRuntime: stdin byte limit is platform-independent", () => {
  assert.doesNotThrow(() => assertBoundedStdin("x".repeat(1024 * 1024)));
  assert.throws(
    () => assertBoundedStdin("x".repeat(1024 * 1024 + 1)),
    /stdin exceeds 1048576 bytes/,
  );
});

test("IsolatedRuntime: proxy normalization is child-scoped and parent env stays unchanged", () => {
  const previous = proxyEnvironmentSnapshot(process.env);
  try {
    for (const key of PROXY_ENVIRONMENT_KEYS) {
      process.env[key] = `http://parent-${key.toLowerCase()}.invalid:9000`;
    }
    const parentSentinel = proxyEnvironmentSnapshot(process.env);
    const requestEnv = Object.fromEntries(
      PROXY_ENVIRONMENT_KEYS.map((key) => [
        key,
        `http://request-${key.toLowerCase()}.invalid:9001`,
      ]),
    );
    const requestSentinel = { ...requestEnv };
    const proxyUrl = "http://127.0.0.1:8321";
    const runtime = new IsolatedRuntime({ failClosed: false, proxyUrl });

    const denied = runtime.prepare({
      command: "true",
      cwd: process.cwd(),
      policy: "none",
      network: false,
      env: requestEnv,
    });
    for (const key of PROXY_ENVIRONMENT_KEYS) assert.equal(denied.env[key], undefined, key);

    // Native network execution intentionally fails closed on Linux, so exercise the shared pure
    // normalization helper there while other platforms also cover IsolatedRuntime.prepare wiring.
    const enabledEnv =
      process.platform === "linux"
        ? scopedProxyEnvironment({ ...process.env, ...requestEnv }, proxyUrl)
        : runtime.prepare({
            command: "true",
            cwd: process.cwd(),
            policy: "none",
            network: true,
            env: requestEnv,
          }).env;
    for (const key of PROXY_ENVIRONMENT_KEYS) {
      assert.equal(enabledEnv[key], key.toLowerCase() === "no_proxy" ? "" : proxyUrl, key);
    }

    assert.deepEqual(requestEnv, requestSentinel);
    assert.deepEqual(proxyEnvironmentSnapshot(process.env), parentSentinel);
  } finally {
    restoreProxyEnvironment(process.env, previous);
  }
});

test(
  "IsolatedRuntime: delivers bounded stdin without shell argv interpolation",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-stdin-"));
    const runtime = new IsolatedRuntime({ failClosed: false });
    try {
      const result = await runtime.run({
        command: "cat",
        cwd: root,
        policy: "none",
        stdin: "hook payload '$HOME'\n",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.output, "hook payload '$HOME'\n");
      await assert.rejects(
        runtime.run({
          command: "cat",
          cwd: root,
          policy: "none",
          stdin: "x".repeat(1024 * 1024 + 1),
        }),
        /stdin exceeds 1048576 bytes/,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "IsolatedRuntime: timeout kills the entire process group before a grandchild can write",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tree-timeout-"));
    const marker = path.join(root, "orphan-marker");
    const runtime = new IsolatedRuntime({ failClosed: false, terminationGraceMs: 100 });
    try {
      const result = await runtime.run({
        command: `(sleep 1.8; printf orphan > ${shellQuote(marker)}) & wait`,
        cwd: root,
        policy: "none",
        timeoutMs: 1_000,
      });
      assert.equal(result.timedOut, true);
      await delay(1_000);
      await assert.rejects(fs.access(marker), /ENOENT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "IsolatedRuntime: abort kills the entire process group before a grandchild can write",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tree-abort-"));
    const marker = path.join(root, "orphan-marker");
    const runtime = new IsolatedRuntime({ failClosed: false, terminationGraceMs: 100 });
    const controller = new AbortController();
    try {
      const running = runtime.run({
        command: `(sleep 0.8; printf orphan > ${shellQuote(marker)}) & wait`,
        cwd: root,
        policy: "none",
        signal: controller.signal,
      });
      setTimeout(() => controller.abort(new Error("test abort")), 100);
      const result = await running;
      assert.equal(result.timedOut, false);
      await delay(900);
      await assert.rejects(fs.access(marker), /ENOENT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "IsolatedRuntime: abort between spawn and listener registration is not lost",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tree-abort-race-"));
    const marker = path.join(root, "orphan-marker");
    const runtime = new IsolatedRuntime({ failClosed: false, terminationGraceMs: 100 });
    try {
      await runtime.run({
        command: `(sleep 0.8; printf orphan > ${shellQuote(marker)}) & wait`,
        cwd: root,
        policy: "none",
        signal: abortDuringListenerRegistration(),
      });
      await delay(900);
      await assert.rejects(fs.access(marker), /ENOENT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "IsolatedRuntime: successful parent exit still reaps background descendants",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-tree-success-reap-"));
    const marker = path.join(root, "orphan-marker");
    const runtime = new IsolatedRuntime({ failClosed: false, terminationGraceMs: 100 });
    try {
      const result = await runtime.run({
        command: `(sleep 0.8; printf orphan > ${shellQuote(marker)}) >/dev/null 2>&1 &`,
        cwd: root,
        policy: "none",
      });
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      await delay(900);
      await assert.rejects(fs.access(marker), /ENOENT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "IsolatedRuntime(macOS): actual Seatbelt hides HOME siblings while keeping cwd readable",
  {
    skip: process.platform !== "darwin" ? "requires macOS Seatbelt" : false,
  },
  async () => {
    const base = await fs.mkdtemp(path.join(os.homedir(), ".anicode-seatbelt-smoke-"));
    const workspace = path.join(base, "workspace");
    const secret = path.join(base, "sibling-secret.txt");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "visible.txt"), "workspace-visible");
    await fs.writeFile(secret, "host-secret-canary");
    const runtime = new IsolatedRuntime({ failClosed: true });
    try {
      const visible = await runtime.run({
        command: "cat visible.txt",
        cwd: workspace,
        policy: "workspace-write",
      });
      assert.equal(visible.exitCode, 0);
      assert.match(visible.output, /workspace-visible/);

      const hidden = await runtime.run({
        command: `cat ${shellQuote(secret)}`,
        cwd: workspace,
        policy: "workspace-write",
      });
      assert.notEqual(hidden.exitCode, 0);
      assert.doesNotMatch(hidden.output, /host-secret-canary/);
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  },
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function proxyEnvironmentSnapshot(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(PROXY_ENVIRONMENT_KEYS.map((key) => [key, env[key]]));
}

function restoreProxyEnvironment(
  env: NodeJS.ProcessEnv,
  snapshot: Record<string, string | undefined>,
): void {
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    const value = snapshot[key];
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

function abortDuringListenerRegistration(): AbortSignal {
  const reason = new Error("abort registration race");
  let aborted = false;
  return {
    get aborted() {
      return aborted;
    },
    get reason() {
      return reason;
    },
    onabort: null,
    throwIfAborted() {
      if (aborted) throw reason;
    },
    addEventListener() {
      // Model an abort in the pre-check -> listener-install window without dispatching the newly
      // installed listener. The mandatory post-install `aborted` check must observe it.
      aborted = true;
    },
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  } as AbortSignal;
}
