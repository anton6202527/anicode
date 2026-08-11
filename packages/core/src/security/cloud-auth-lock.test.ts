import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  CloudAuthLockError,
  FileCloudAuthExclusiveLock,
  cloudAuthLockFileForNamespace,
} from "./cloud-auth-lock.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function spawnLockWorker(source: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForOutput(child: ChildProcess, expected: string): Promise<void> {
  let output = "";
  let errors = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(`Timed out waiting for child output ${JSON.stringify(expected)}: ${errors}`),
      );
    }, 5_000);
    const onStdout = (chunk: string) => {
      output += chunk;
      if (output.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onStderr = (chunk: string) => {
      errors += chunk;
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Child exited before ready (${String(code)}/${String(signal)}): ${errors}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("exit", onExit);
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("exit", onExit);
  });
}

async function waitForSuccessfulExit(child: ChildProcess): Promise<void> {
  let errors = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    errors += chunk;
  });
  const [code, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
  assert.equal(signal, null, errors);
  assert.equal(code, 0, errors);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for child-process barrier");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("cloud auth file lock: stable path exposes only a namespace hash", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-path-"));
  try {
    const namespace = '["os-keychain","dev.anicode.cloud-auth"]';
    const first = cloudAuthLockFileForNamespace(namespace, root);
    const second = cloudAuthLockFileForNamespace(namespace, root);
    assert.equal(first, second);
    assert.equal(path.dirname(first), path.join(root, ".anicode", "cloud-auth-locks"));
    assert.match(path.basename(first), /^[a-f0-9]{64}\.lock$/u);
    assert.equal(first.includes("dev.anicode"), false);
    assert.equal(first.includes('cloud-auth"]'), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: two instances serialize through a private secret-free database", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-shared-"));
  const lockFile = path.join(root, "private", "shared.lock");
  const first = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 2_000 });
  const second = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 2_000 });
  const entered = deferred<void>();
  const release = deferred<void>();
  let secondEntered = false;
  try {
    const firstOperation = first.runExclusive(async () => {
      const directoryStat = await fs.lstat(path.dirname(lockFile));
      const lockStat = await fs.lstat(lockFile);
      if (process.platform !== "win32") {
        assert.equal(directoryStat.mode & 0o077, 0);
        assert.equal(lockStat.mode & 0o077, 0);
      }
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    const secondOperation = second.runExclusive(async () => {
      secondEntered = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondEntered, false);
    release.resolve(undefined);
    await Promise.all([firstOperation, secondOperation]);
    assert.equal(secondEntered, true);
    assert.equal((await fs.lstat(lockFile)).isFile(), true);
    const contents = await fs.readFile(lockFile);
    assert.equal(contents.includes(Buffer.from("refresh", "utf8")), false);
    assert.equal(contents.includes(Buffer.from("access_token", "utf8")), false);

    // The persistent empty database is reusable; ownership is the live SQLite transaction only.
    await first.runExclusive(async () => undefined);
  } finally {
    release.resolve(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: a crash after empty-file creation cannot strand an invalid owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-empty-"));
  const lockFile = path.join(root, "private", "shared.lock");
  try {
    await fs.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(lockFile, "", { mode: 0o600, flag: "wx" });
    let entered = false;
    await new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 500 }).runExclusive(async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: killing a child owner releases the lease without recovery unlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-crash-"));
  const lockFile = path.join(root, "private", "shared.lock");
  const moduleUrl = new URL("./cloud-auth-lock.ts", import.meta.url).href;
  const child = spawnLockWorker(`
    import { FileCloudAuthExclusiveLock } from ${JSON.stringify(moduleUrl)};
    const lock = new FileCloudAuthExclusiveLock(${JSON.stringify(lockFile)}, { timeoutMs: 5000 });
    await lock.runExclusive(async () => {
      process.stdout.write("ready\\n");
      await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `);
  try {
    await waitForOutput(child, "ready\n");
    const successor = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 5_000 });
    let successorEntered = false;
    const takeover = successor.runExclusive(async () => {
      successorEntered = true;
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    assert.equal(successorEntered, false);

    const childExit = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    await childExit;
    await takeover;
    assert.equal(successorEntered, true);
    assert.equal((await fs.lstat(lockFile)).isFile(), true);
  } finally {
    await terminateChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: three processes have deterministic maxActive=1", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-processes-"));
  const lockFile = path.join(root, "private", "shared.lock");
  const readyDirectory = path.join(root, "ready");
  const activeDirectory = path.join(root, "active");
  const startFile = path.join(root, "start");
  const observations = path.join(root, "observations.log");
  const moduleUrl = new URL("./cloud-auth-lock.ts", import.meta.url).href;
  await fs.mkdir(readyDirectory);
  await fs.mkdir(activeDirectory);
  const children = Array.from({ length: 3 }, (_, index) =>
    spawnLockWorker(`
      import { promises as fs } from "node:fs";
      import * as path from "node:path";
      import { FileCloudAuthExclusiveLock } from ${JSON.stringify(moduleUrl)};
      const worker = ${index};
      await fs.writeFile(path.join(${JSON.stringify(readyDirectory)}, String(worker)), "ready", { flag: "wx" });
      while (!(await fs.stat(${JSON.stringify(startFile)}).then(() => true, () => false))) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const lock = new FileCloudAuthExclusiveLock(${JSON.stringify(lockFile)}, { timeoutMs: 5000 });
      await lock.runExclusive(async () => {
        const marker = path.join(${JSON.stringify(activeDirectory)}, String(worker));
        await fs.writeFile(marker, "active", { flag: "wx" });
        const active = (await fs.readdir(${JSON.stringify(activeDirectory)})).length;
        await fs.appendFile(${JSON.stringify(observations)}, String(active) + "\\n");
        await new Promise((resolve) => setTimeout(resolve, 75));
        await fs.unlink(marker);
      });
    `),
  );
  try {
    await waitUntil(async () => (await fs.readdir(readyDirectory)).length === 3);
    const exits = children.map((child) => waitForSuccessfulExit(child));
    await fs.writeFile(startFile, "start", { flag: "wx" });
    await Promise.all(exits);

    const activeCounts = (await fs.readFile(observations, "utf8")).trim().split("\n").map(Number);
    assert.deepEqual(activeCounts, [1, 1, 1]);
    assert.equal(Math.max(...activeCounts), 1);
  } finally {
    await Promise.all(children.map((child) => terminateChild(child)));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: concurrent first initialization cannot drop a same-process lease", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-first-init-"));
  const lockFile = path.join(root, "private", "shared.lock");
  const activeDirectory = path.join(root, "active");
  const startFile = path.join(root, "start");
  const observations = path.join(root, "observations.log");
  const moduleUrl = new URL("./cloud-auth-lock.ts", import.meta.url).href;
  await fs.mkdir(activeDirectory);
  const child = spawnLockWorker(`
    import { promises as fs } from "node:fs";
    import * as path from "node:path";
    import { FileCloudAuthExclusiveLock } from ${JSON.stringify(moduleUrl)};
    process.stdout.write("ready\\n");
    while (!(await fs.stat(${JSON.stringify(startFile)}).then(() => true, () => false))) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const lock = new FileCloudAuthExclusiveLock(${JSON.stringify(lockFile)}, { timeoutMs: 5000 });
    await lock.runExclusive(async () => {
      const marker = path.join(${JSON.stringify(activeDirectory)}, "child");
      await fs.writeFile(marker, "active", { flag: "wx" });
      const active = (await fs.readdir(${JSON.stringify(activeDirectory)})).length;
      await fs.appendFile(${JSON.stringify(observations)}, String(active) + "\\n");
      await new Promise((resolve) => setTimeout(resolve, 75));
      await fs.unlink(marker);
    });
  `);
  const runLocal = async (worker: string) => {
    const lock = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 5_000 });
    await lock.runExclusive(async () => {
      const marker = path.join(activeDirectory, worker);
      await fs.writeFile(marker, "active", { flag: "wx" });
      const active = (await fs.readdir(activeDirectory)).length;
      await fs.appendFile(observations, `${String(active)}\n`);
      await new Promise<void>((resolve) => setTimeout(resolve, 75));
      await fs.unlink(marker);
    });
  };
  try {
    await waitForOutput(child, "ready\n");
    const childExit = waitForSuccessfulExit(child);
    await fs.writeFile(startFile, "start", { flag: "wx" });
    // Both calls encounter an absent file in the same event-loop turn. Initialization must finish
    // once for this process before either contender can BEGIN its transaction.
    await Promise.all([runLocal("local-1"), runLocal("local-2"), childExit]);

    const activeCounts = (await fs.readFile(observations, "utf8")).trim().split("\n").map(Number);
    assert.equal(activeCounts.length, 3);
    assert.equal(Math.max(...activeCounts), 1);
  } finally {
    await terminateChild(child);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: malformed database fails closed without replacing it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-invalid-"));
  const lockFile = path.join(root, "private", "shared.lock");
  try {
    await fs.mkdir(path.dirname(lockFile), { recursive: true, mode: 0o700 });
    await fs.writeFile(lockFile, "invalid-owner", { mode: 0o600 });
    const lock = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 25 });
    await assert.rejects(
      lock.runExclusive(async () => undefined),
      (error) => error instanceof CloudAuthLockError && error.reason === "invalid-lock",
    );
    assert.equal(await fs.readFile(lockFile, "utf8"), "invalid-owner");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: a live owner is never reclaimed and waiters hit the hard deadline", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-timeout-"));
  const lockFile = path.join(root, "private", "shared.lock");
  const owner = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 2_000 });
  const waiter = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 25 });
  const entered = deferred<void>();
  const release = deferred<void>();
  try {
    const holding = owner.runExclusive(async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    await assert.rejects(
      waiter.runExclusive(async () => undefined),
      (error) => error instanceof CloudAuthLockError && error.reason === "timed-out",
    );
    release.resolve(undefined);
    await holding;
  } finally {
    release.resolve(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: operation errors retain identity and still release the transaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-operation-error-"));
  const lockFile = path.join(root, "private", "shared.lock");
  const expected = new Error("operation failed");
  const lock = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 500 });
  try {
    await assert.rejects(
      lock.runExclusive(async () => {
        throw expected;
      }),
      (error) => error === expected,
    );
    let successorEntered = false;
    await lock.runExclusive(async () => {
      successorEntered = true;
    });
    assert.equal(successorEntered, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cloud auth file lock: an aborted waiter settles without disturbing the live owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cloud-lock-abort-"));
  const lockFile = path.join(root, "private", "shared.lock");
  const owner = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 2_000 });
  const waiter = new FileCloudAuthExclusiveLock(lockFile, { timeoutMs: 2_000 });
  const entered = deferred<void>();
  const release = deferred<void>();
  try {
    const holding = owner.runExclusive(async () => {
      entered.resolve(undefined);
      await release.promise;
    });
    await entered.promise;
    const controller = new AbortController();
    const waiting = waiter.runExclusive(async () => undefined, { signal: controller.signal });
    controller.abort();
    await assert.rejects(
      waiting,
      (error) => error instanceof CloudAuthLockError && error.reason === "cancelled",
    );
    assert.equal((await fs.lstat(lockFile)).isFile(), true);
    release.resolve(undefined);
    await holding;
  } finally {
    release.resolve(undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});
