import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ContainerIsolatedRuntime,
  containerEngineEnvironment,
  containerWorkspaceMount,
  runContainerCliProcess,
  type ContainerProcessRunner,
} from "./container-runtime.js";

const POSIX_ONLY = {
  skip: process.platform === "win32" ? "requires a POSIX process group" : false,
};

test(
  "Container CLI runner does not lose an abort during listener registration",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-abort-race-"));
    const marker = path.join(root, "orphan-marker");
    try {
      await runContainerCliProcess(
        process.execPath,
        [
          "-e",
          `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 800); setTimeout(() => {}, 2000)`,
        ],
        process.env,
        5_000,
        10_000,
        abortDuringListenerRegistration(),
      );
      await new Promise((resolve) => setTimeout(resolve, 900));
      await assert.rejects(fs.access(marker), /ENOENT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("Container CLI runner reaps helpers after a successful parent exit", POSIX_ONLY, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-success-tree-"));
  const marker = path.join(root, "orphan-marker");
  const grandchild = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(marker)}, "orphan"), 300)`;
  const parent = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(grandchild)}],{stdio:"ignore"});child.unref()`;
  try {
    const result = await runContainerCliProcess(
      process.execPath,
      ["-e", parent],
      process.env,
      5_000,
      10_000,
    );
    assert.equal(result.exitCode, 0);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(fs.access(marker), /ENOENT/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: read-only policy never receives a writable workspace bind", () => {
  assert.equal(
    containerWorkspaceMount("/workspace/project", "read-only"),
    "type=bind,src=/workspace/project,dst=/workspace,readonly",
  );
  assert.equal(
    containerWorkspaceMount("/workspace/project", undefined),
    "type=bind,src=/workspace/project,dst=/workspace,readonly",
  );
  assert.equal(
    containerWorkspaceMount("/workspace/project", "workspace-write"),
    "type=bind,src=/workspace/project,dst=/workspace,rw",
  );
});

test("Container runtime: stdin is passed through docker interactive mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-stdin-"));
  let runInput: string | undefined;
  let interactive = false;
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    processRunner: async (_file, args, _env, _timeout, _limit, _signal, stdin) => {
      if (args[0] === "run") {
        runInput = stdin;
        interactive = args.includes("--interactive");
      }
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    await runtime.run({ command: "cat", cwd: root, policy: "workspace-write", stdin: "payload" });
    assert.equal(runInput, "payload");
    assert.equal(interactive, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: production default rejects mutable image tags", () => {
  assert.throws(
    () => new ContainerIsolatedRuntime({ image: "runtime:latest" }),
    /pinned by sha256 digest/,
  );
});

test("Container runtime: engine config stays in control plane and is not forwarded to workload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-control-env-"));
  let runArgs: string[] = [];
  let runEnv: NodeJS.ProcessEnv = {};
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    controlEnvironment: {
      PATH: "/usr/bin:/bin",
      HOME: "/host/home",
      DOCKER_CONFIG: "/host/docker-config",
      HOST_API_KEY: "must-not-inherit",
    },
    processRunner: async (_file, args, env) => {
      if (args[0] === "run") {
        runArgs = args;
        runEnv = env;
      }
      if (args[0] === "container") {
        return { exitCode: 1, output: `No such container: ${args.at(-1)}`, timedOut: false };
      }
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    await runtime.run({
      command: "true",
      cwd: root,
      policy: "read-only",
      env: { WORKLOAD_VALUE: "visible" },
    });
    assert.equal(runEnv["HOME"], "/host/home");
    assert.equal(runEnv["DOCKER_CONFIG"], "/host/docker-config");
    assert.equal(runEnv["HOST_API_KEY"], undefined);
    assert.equal(runEnv["WORKLOAD_VALUE"], "visible");
    const forwarded = runArgs
      .flatMap((value, index) => (value === "--env" ? [runArgs[index + 1]] : []))
      .filter((value): value is string => Boolean(value));
    assert.ok(forwarded.includes("WORKLOAD_VALUE"));
    assert.ok(!forwarded.includes("HOME"));
    assert.ok(!forwarded.includes("DOCKER_CONFIG"));
    assert.ok(!forwarded.includes("HOST_API_KEY"));
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("containerEngineEnvironment keeps only audited engine control keys", () => {
  const env = containerEngineEnvironment(
    { LEASED_TOKEN: "scoped" },
    {
      PATH: "/usr/bin",
      HOME: "/host/home",
      DOCKER_HOST: "unix:///host/docker.sock",
      RANDOM_DATABASE_URL: "postgres://secret",
    },
  );
  assert.equal(env["HOME"], "/host/home");
  assert.equal(env["DOCKER_HOST"], "unix:///host/docker.sock");
  assert.equal(env["LEASED_TOKEN"], "scoped");
  assert.equal(env["RANDOM_DATABASE_URL"], undefined);
});

test("Container runtime: timeout/error paths synchronously force-remove the named container", async () => {
  const calls: string[][] = [];
  const runner: ContainerProcessRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "run") return { exitCode: null, output: "timed out", timedOut: true };
    if (args[0] === "rm") return { exitCode: 1, output: "already removed", timedOut: false };
    if (args[0] === "container") {
      return {
        exitCode: 1,
        output: `Error: No such container: ${args[2]}`,
        timedOut: false,
      };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    processRunner: runner,
  });

  const result = await runtime.run({
    command: "true",
    cwd: process.cwd(),
    policy: "read-only",
  });
  assert.equal(result.timedOut, true);
  const run = calls.find((args) => args[0] === "run");
  const stop = calls.find((args) => args[0] === "stop");
  const cleanup = calls.find((args) => args[0] === "rm");
  assert.ok(run?.some((arg) => arg.endsWith(",readonly")));
  assert.deepEqual(stop?.slice(0, 3), ["stop", "--time", "1"]);
  assert.equal(stop?.[3], run?.[run.indexOf("--name") + 1]);
  assert.deepEqual(cleanup?.slice(0, 2), ["rm", "--force"]);
  assert.equal(cleanup?.[2], run?.[run.indexOf("--name") + 1]);
  assert.deepEqual(calls.find((args) => args[0] === "container")?.slice(0, 2), [
    "container",
    "inspect",
  ]);
});

test("Container runtime: abort awaits stop and force-remove before rejecting", async () => {
  const calls: string[][] = [];
  let releaseRun!: () => void;
  const runStarted = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });
  let cleanupFinished = false;
  const runner: ContainerProcessRunner = async (_file, args, _env, _timeout, _limit, signal) => {
    calls.push(args);
    if (args[0] === "run") {
      releaseRun();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted run")), { once: true });
      });
    }
    if (args[0] === "rm") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      cleanupFinished = true;
    }
    if (args[0] === "container") {
      return {
        exitCode: 1,
        output: `Error: No such container: ${args[2]}`,
        timedOut: false,
      };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    processRunner: runner,
  });
  const controller = new AbortController();
  const running = runtime.run({
    command: "sleep 60",
    cwd: process.cwd(),
    policy: "read-only",
    signal: controller.signal,
  });
  await runStarted;
  controller.abort(new Error("test abort"));
  await assert.rejects(running, /aborted run/);
  assert.equal(cleanupFinished, true);
  assert.deepEqual(
    calls.filter((args) => args[0] === "stop" || args[0] === "rm").map((args) => args[0]),
    ["stop", "rm"],
  );
});

test("Container runtime: timeout fails closed when OCI inspect still sees the container", async () => {
  const runner: ContainerProcessRunner = async (_file, args) => {
    if (args[0] === "run") return { exitCode: null, output: "", timedOut: true };
    if (args[0] === "rm") return { exitCode: 1, output: "remove failed", timedOut: false };
    if (args[0] === "container") return { exitCode: 0, output: "still here", timedOut: false };
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    processRunner: runner,
  });
  await assert.rejects(
    () => runtime.run({ command: "sleep 60", cwd: process.cwd(), policy: "read-only" }),
    /still exists after stop\/rm cleanup/,
  );
});

test("Container runtime: successful command still fails closed if cleanup leaves a container", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-success-orphan-"));
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    processRunner: async (_file, args) => {
      if (args[0] === "run") return { exitCode: 0, output: "ok", timedOut: false };
      if (args[0] === "rm") return { exitCode: 1, output: "daemon error", timedOut: false };
      if (args[0] === "container" && args[1] === "inspect") {
        return { exitCode: 0, output: args.at(-1) ?? "", timedOut: false };
      }
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    await assert.rejects(
      runtime.run({ command: "true", cwd: root, policy: "read-only" }),
      /still exists after stop\/rm cleanup/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: scoped proxy capability is redacted and revoked after the job", async () => {
  const ephemeralToken = "per-execution-proxy-token-must-not-leak";
  let revoked = 0;
  let runnerEnvironment: NodeJS.ProcessEnv | undefined;
  const runner: ContainerProcessRunner = async (_file, args, env) => {
    if (args[0] === "network") return { exitCode: 0, output: "true\n", timedOut: false };
    if (args[0] === "run") {
      runnerEnvironment = env;
      return {
        exitCode: 0,
        output: `HTTP_PROXY=${env.HTTP_PROXY}\ntoken=${ephemeralToken}`,
        timedOut: false,
      };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    internalNetwork: "anicode-internal",
    proxyUrl: "http://egress-proxy:8080",
    proxyCredentialIssuer: {
      issue: async ({ tenantId, executionId, proxyUrl }) => {
        assert.equal(tenantId, "tenant-a");
        assert.equal(executionId, "job-a");
        const url = new URL(proxyUrl);
        url.username = "job-principal";
        url.password = ephemeralToken;
        return {
          proxyUrl: url.toString(),
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          redact: (value) => value.split(ephemeralToken).join("[REDACTED]"),
          revoke: async () => {
            revoked++;
          },
        };
      },
    },
    processRunner: runner,
  });

  const result = await runtime.run({
    command: "env",
    cwd: process.cwd(),
    policy: "read-only",
    network: true,
    workload: { tenantId: "tenant-a", executionId: "job-a" },
  });
  assert.doesNotMatch(result.output, new RegExp(ephemeralToken));
  assert.match(String(runnerEnvironment?.HTTP_PROXY), /job-principal/);
  assert.equal(revoked, 1);
});

test("Container runtime: shared inline proxy credentials fail closed", () => {
  assert.throws(
    () =>
      new ContainerIsolatedRuntime({
        image: "runtime@sha256:deadbeef",
        proxyUrl: "http://shared:long-lived-token@egress-proxy:8080",
      }),
    /credential-free/,
  );
});

test("Container runtime: network access fails closed without a scoped credential issuer", async () => {
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    internalNetwork: "anicode-internal",
    proxyUrl: "http://egress-proxy:8080",
    processRunner: async () => ({ exitCode: 0, output: "", timedOut: false }),
  });
  await assert.rejects(
    () =>
      runtime.run({
        command: "true",
        cwd: process.cwd(),
        policy: "read-only",
        network: true,
      }),
    /execution-scoped proxy credential/,
  );
});

test("Container runtime: durable startup reconciliation removes a crash-orphan journal entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-journal-"));
  const journal = path.join(root, "orphans.json");
  const name = "anicode-crashed-1";
  await fs.writeFile(
    journal,
    `${JSON.stringify({
      version: 1,
      records: [
        {
          name,
          engine: "docker",
          startedAt: new Date().toISOString(),
          tenantId: "tenant-a",
          executionId: "execution-a",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const calls: string[][] = [];
  const runner: ContainerProcessRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "rm") return { exitCode: 1, output: "already gone", timedOut: false };
    if (args[0] === "container") {
      return { exitCode: 1, output: `Error: No such container: ${name}`, timedOut: false };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    processRunner: runner,
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
  });
  try {
    await runtime.reconcileOrphans();
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as { records: unknown[] };
    assert.deepEqual(state.records, []);
    assert.ok(calls.some((args) => args[0] === "stop" && args.at(-1) === name));
    assert.ok(calls.some((args) => args[0] === "rm" && args.at(-1) === name));
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: unresolved crash orphan remains journaled and blocks reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-stuck-"));
  const journal = path.join(root, "orphans.json");
  const name = "anicode-stuck-1";
  await fs.writeFile(
    journal,
    `${JSON.stringify({
      version: 1,
      records: [{ name, engine: "docker", startedAt: new Date().toISOString() }],
    })}\n`,
    { mode: 0o600 },
  );
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: async (_file, args) =>
      args[0] === "container"
        ? { exitCode: 0, output: name, timedOut: false }
        : { exitCode: 1, output: "failed", timedOut: false },
  });
  try {
    await assert.rejects(runtime.reconcileOrphans(), /orphan reconciliation failed/);
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as {
      records: { name: string }[];
    };
    assert.equal(state.records[0]?.name, name);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: journals ownership before run and clears it only after awaited cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-active-"));
  const journal = path.join(root, "orphans.json");
  let sawDurableOwner = false;
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:deadbeef",
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: async (_file, args) => {
      if (args[0] === "run") {
        const state = JSON.parse(await fs.readFile(journal, "utf8")) as {
          records: { tenantId?: string; executionId?: string }[];
        };
        sawDurableOwner =
          state.records[0]?.tenantId === "tenant-a" &&
          state.records[0]?.executionId === "execution-a";
      }
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    await runtime.run({
      command: "true",
      cwd: root,
      workload: { tenantId: "tenant-a", executionId: "execution-a" },
    });
    assert.equal(sawDurableOwner, true);
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as { records: unknown[] };
    assert.deepEqual(state.records, []);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

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
      aborted = true;
    },
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
  } as AbortSignal;
}
