import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { promises as fs, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ContainerIsolatedRuntime,
  containerEngineEnvironment,
  containerWorkspaceMount,
  runContainerCliProcess,
  type ContainerProcessResult,
  type ContainerProcessRunner,
} from "./container-runtime.js";

const POSIX_ONLY = {
  skip: process.platform === "win32" ? "requires a POSIX process group" : false,
};

const TEST_DOCKER_ENDPOINT =
  process.platform === "win32" ? "npipe:////./pipe/docker_engine" : "unix:///var/run/docker.sock";

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

test("Container CLI runner preserves UTF-8 characters split across stdout chunks", async () => {
  const script =
    'const bytes=Buffer.from("中文","utf8"); process.stdout.write(bytes.subarray(0,2)); setTimeout(()=>process.stdout.write(bytes.subarray(2,4)),10); setTimeout(()=>process.stdout.end(bytes.subarray(4)),20)';
  const result = await runContainerCliProcess(
    process.execPath,
    ["-e", script],
    process.env,
    5_000,
    10_000,
  );
  assert.equal(result.controlOutput, "中文");
  assert.equal(result.output, "中文");
  assert.doesNotMatch(result.output, /�/);
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
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    processRunner: inMemoryOciRunner({
      onCreate: async (_file, args) => {
        interactive = args.includes("--interactive");
      },
      onStart: async (_file, args, _env, _timeout, _limit, _signal, stdin) => {
        runInput = stdin;
        assert.equal(args[0], "start");
        assert.equal(args.includes("--interactive"), true);
      },
    }),
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
    /pinned by a full sha256 digest/,
  );
  assert.throws(
    () =>
      new ContainerIsolatedRuntime({
        image: `runtime@sha256:${"a".repeat(63)}`,
      }),
    /valid OCI image reference|full sha256 digest/,
  );
  assert.throws(
    () =>
      new ContainerIsolatedRuntime({
        image: `--privileged@sha256:${"a".repeat(64)}`,
      }),
    /valid OCI image reference/,
  );
});

test("Container runtime: engine config stays in control plane and is not forwarded to workload", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-control-env-"));
  let runArgs: string[] = [];
  let runEnv: NodeJS.ProcessEnv = {};
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    controlEnvironment: {
      PATH: "/usr/bin:/bin",
      HOME: "/host/home",
      DOCKER_CONFIG: "/host/docker-config",
      DOCKER_HOST: "unix:///host/docker.sock",
      DOCKER_CONTEXT: "default",
      DOCKER_CERT_PATH: "/host/certs",
      CONTAINER_HOST: "unix:///host/podman.sock",
      REGISTRY_AUTH_FILE: "/host/registry-auth.json",
      HOST_API_KEY: "must-not-inherit",
    },
    processRunner: inMemoryOciRunner({
      onCreate: async (_file, args, env) => {
        runArgs = args;
        runEnv = env;
      },
    }),
  });
  try {
    await runtime.run({
      command: "true",
      cwd: root,
      policy: "read-only",
      env: {
        WORKLOAD_VALUE: "visible",
        DOCKER_HOST: "unix:///attacker.sock",
        DOCKER_CONTEXT: "attacker",
        DOCKER_CERT_PATH: "/workspace/certs",
        CONTAINER_HOST: "unix:///attacker-podman.sock",
        REGISTRY_AUTH_FILE: "/workspace/auth.json",
      },
    });
    assert.equal(runEnv["HOME"], "/host/home");
    assert.equal(runEnv["DOCKER_CONFIG"], "/host/docker-config");
    assert.equal(runEnv["DOCKER_HOST"], "unix:///host/docker.sock");
    assert.equal(runEnv["DOCKER_CONTEXT"], undefined);
    assert.equal(runEnv["DOCKER_CERT_PATH"], "/host/certs");
    assert.equal(runEnv["CONTAINER_HOST"], "unix:///host/podman.sock");
    assert.equal(runEnv["REGISTRY_AUTH_FILE"], "/host/registry-auth.json");
    assert.equal(runEnv["HOST_API_KEY"], undefined);
    assert.equal(runEnv["WORKLOAD_VALUE"], "visible");
    const forwarded = runArgs
      .flatMap((value, index) => (value === "--env" ? [runArgs[index + 1]] : []))
      .filter((value): value is string => Boolean(value));
    assert.ok(forwarded.includes("WORKLOAD_VALUE"));
    assert.ok(!forwarded.includes("HOME"));
    assert.ok(!forwarded.includes("DOCKER_CONFIG"));
    assert.ok(!forwarded.includes("DOCKER_HOST"));
    assert.ok(!forwarded.includes("DOCKER_CONTEXT"));
    assert.ok(!forwarded.includes("DOCKER_CERT_PATH"));
    assert.ok(!forwarded.includes("CONTAINER_HOST"));
    assert.ok(!forwarded.includes("REGISTRY_AUTH_FILE"));
    assert.ok(!forwarded.includes("HOST_API_KEY"));
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: remote daemon/context is rejected before host bind execution", () => {
  const image = `runtime@sha256:${"a".repeat(64)}`;
  assert.throws(
    () =>
      new ContainerIsolatedRuntime({
        image,
        controlEnvironment: { DOCKER_HOST: "tcp://remote.example:2376" },
      }),
    /explicit local unix\/npipe endpoint/,
  );
  assert.throws(
    () =>
      new ContainerIsolatedRuntime({
        image,
        controlEnvironment: { DOCKER_CONTEXT: "production" },
      }),
    /non-default Docker contexts/,
  );
  assert.throws(
    () =>
      new ContainerIsolatedRuntime({
        image,
        engine: "podman",
        controlEnvironment: { CONTAINER_CONNECTION: "remote-production" },
      }),
    /rejects Podman remote/i,
  );
});

test("Container runtime: an explicit trusted engine binary and local endpoint avoid PATH/context lookup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-engine-bin-"));
  const engine = path.join(root, "docker");
  await fs.writeFile(engine, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  let observedFile = "";
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    engineExecutable: engine,
    engineEndpoint: "unix:///explicit/docker.sock",
    controlEnvironment: { PATH: path.join(root, "attacker-path") },
    processRunner: inMemoryOciRunner({
      onCall: async (file) => {
        observedFile = file;
      },
    }),
  });
  try {
    await runtime.run({ command: "true", cwd: root, network: false });
    // The runtime deliberately uses one synchronous canonicalizer for the trusted executable.
    // Node's async realpath may expand a Windows 8.3 temp path to a different textual spelling.
    assert.equal(observedFile, realpathSync(engine));
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: comma-delimited bind source is rejected before workload run", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode,container-bind-"));
  let invokedWorkload = false;
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    processRunner: async (_file, args) => {
      if (args[0] === "create") invokedWorkload = true;
      return { exitCode: 1, output: `No such container: ${args.at(-1)}`, timedOut: false };
    },
  });
  try {
    assert.throws(() => containerWorkspaceMount(root, "read-only"), /cannot be represented safely/);
    await assert.rejects(
      runtime.run({ command: "true", cwd: root, policy: "read-only" }),
      /cannot be represented safely/,
    );
    assert.equal(invokedWorkload, false);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "Container runtime: protected workspace symlinks never become host bind mounts",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-protected-link-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-outside-"));
    await fs.symlink(outside, path.join(root, ".git"));
    let invokedWorkload = false;
    const runtime = new ContainerIsolatedRuntime({
      image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      processRunner: async (_file, args) => {
        if (args[0] === "create") invokedWorkload = true;
        if (args[0] === "container") {
          return { exitCode: 1, output: `No such container: ${args.at(-1)}`, timedOut: false };
        }
        return { exitCode: 0, output: "", timedOut: false };
      },
    });
    try {
      await assert.rejects(
        runtime.run({ command: "true", cwd: root, policy: "read-only" }),
        /must not be a symbolic link/,
      );
      assert.equal(invokedWorkload, false);
    } finally {
      await runtime.shutdown();
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  },
);

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

test("Container runtime: start timeout synchronously force-removes the immutable container ID", async () => {
  const calls: string[][] = [];
  const containerId = "a".repeat(64);
  let ownerToken = "";
  let exists = false;
  const runner: ContainerProcessRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "create") {
      exists = true;
      ownerToken = String(args[args.indexOf("--label") + 1]).split("=")[1]!;
      return { exitCode: 0, output: containerId, controlOutput: containerId, timedOut: false };
    }
    if (args[0] === "start") {
      return { exitCode: null, output: "timed out", timedOut: true };
    }
    if (args[0] === "rm") {
      exists = false;
      return { exitCode: 1, output: "already removed", timedOut: false };
    }
    if (args[0] === "container") {
      return exists
        ? {
            exitCode: 0,
            output: "",
            controlOutput: `${containerId} ${ownerToken}\n`,
            timedOut: false,
          }
        : { exitCode: 1, output: `Error: No such container: ${args.at(-1)}`, timedOut: false };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    processRunner: runner,
  });

  const result = await runtime.run({
    command: "true",
    cwd: process.cwd(),
    policy: "read-only",
  });
  assert.equal(result.timedOut, true);
  const create = calls.find((args) => args[0] === "create");
  const start = calls.find((args) => args[0] === "start");
  const stop = calls.find((args) => args[0] === "stop");
  const cleanup = calls.find((args) => args[0] === "rm");
  assert.ok(create?.some((arg) => arg.endsWith(",readonly")));
  assert.deepEqual(start?.slice(0, 3), ["start", "--attach", containerId]);
  assert.deepEqual(stop?.slice(0, 3), ["stop", "--time", "1"]);
  assert.equal(stop?.[3], containerId);
  assert.deepEqual(cleanup?.slice(0, 2), ["rm", "--force"]);
  assert.equal(cleanup?.[2], containerId);
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
  const containerId = "b".repeat(64);
  let ownerToken = "";
  let exists = false;
  const runner: ContainerProcessRunner = async (_file, args, _env, _timeout, _limit, signal) => {
    calls.push(args);
    if (args[0] === "create") {
      exists = true;
      ownerToken = String(args[args.indexOf("--label") + 1]).split("=")[1]!;
      return { exitCode: 0, output: containerId, controlOutput: containerId, timedOut: false };
    }
    if (args[0] === "start") {
      releaseRun();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted run")), { once: true });
      });
    }
    if (args[0] === "rm") {
      await new Promise((resolve) => setTimeout(resolve, 25));
      exists = false;
      cleanupFinished = true;
    }
    if (args[0] === "container") {
      return exists
        ? {
            exitCode: 0,
            output: "",
            controlOutput: `${containerId} ${ownerToken}\n`,
            timedOut: false,
          }
        : { exitCode: 1, output: `Error: No such container: ${args.at(-1)}`, timedOut: false };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
  const containerId = "c".repeat(64);
  let ownerToken = "";
  let createCalls = 0;
  let startCalls = 0;
  const runner: ContainerProcessRunner = async (_file, args) => {
    if (args[0] === "create") {
      createCalls++;
      ownerToken = String(args[args.indexOf("--label") + 1]).split("=")[1]!;
      return { exitCode: null, output: "", timedOut: true };
    }
    if (args[0] === "start") startCalls++;
    if (args[0] === "rm") return { exitCode: 1, output: "remove failed", timedOut: false };
    if (args[0] === "container") {
      return {
        exitCode: 0,
        output: "",
        controlOutput: `${containerId} ${ownerToken}`,
        timedOut: false,
      };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    processRunner: runner,
  });
  await assert.rejects(
    () => runtime.run({ command: "sleep 60", cwd: process.cwd(), policy: "read-only" }),
    (error: unknown) => error instanceof Error && error.name === "RuntimeTerminationError",
  );
  assert.equal(createCalls, 1);
  assert.equal(startCalls, 0);
});

test("Container runtime: successful command still fails closed if cleanup leaves a container", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-success-orphan-"));
  const containerId = "d".repeat(64);
  let ownerToken = "";
  let exists = false;
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    processRunner: async (_file, args) => {
      if (args[0] === "create") {
        ownerToken = String(args[args.indexOf("--label") + 1]).split("=")[1]!;
        exists = true;
        return { exitCode: 0, output: containerId, controlOutput: containerId, timedOut: false };
      }
      if (args[0] === "start") return { exitCode: 0, output: "ok", timedOut: false };
      if (args[0] === "rm") return { exitCode: 1, output: "daemon error", timedOut: false };
      if (args[0] === "container" && args[1] === "inspect") {
        return exists
          ? {
              exitCode: 0,
              output: "",
              controlOutput: `${containerId} ${ownerToken}`,
              timedOut: false,
            }
          : {
              exitCode: 1,
              output: `No such container: ${args.at(-1)}`,
              timedOut: false,
            };
      }
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    await assert.rejects(
      runtime.run({ command: "true", cwd: root, policy: "read-only" }),
      (error: unknown) => error instanceof Error && error.name === "RuntimeTerminationError",
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: owner-label mismatch never stops or removes a foreign reused name", async () => {
  const calls: string[][] = [];
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    processRunner: async (_file, args) => {
      calls.push(args);
      if (args[0] === "create") {
        return {
          exitCode: 0,
          output: "7".repeat(64),
          controlOutput: "7".repeat(64),
          timedOut: false,
        };
      }
      if (args[0] === "container") {
        return {
          exitCode: 0,
          output: "",
          controlOutput: `${"7".repeat(64)} foreign-owner-token`,
          timedOut: false,
        };
      }
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  await assert.rejects(
    runtime.run({ command: "true", cwd: process.cwd(), network: false }),
    (error: unknown) => error instanceof Error && error.name === "RuntimeTerminationError",
  );
  assert.equal(
    calls.some((args) => args[0] === "stop" || args[0] === "rm"),
    false,
  );
});

test("Container runtime: network is rejected before issuer or OCI execution", async () => {
  let issued = 0;
  let runnerCalls = 0;
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    internalNetwork: "anicode-internal",
    proxyUrl: "http://egress-proxy:8080",
    proxyCredentialIssuer: {
      issue: async ({ proxyUrl }) => {
        issued++;
        return {
          proxyUrl,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          redact: (value) => value,
          revoke: async () => undefined,
        };
      },
    },
    processRunner: async () => {
      runnerCalls++;
      return { exitCode: 0, output: "", timedOut: false };
    },
  });

  await assert.rejects(
    () =>
      runtime.run({
        command: "env",
        cwd: process.cwd(),
        policy: "read-only",
        network: true,
        workload: { tenantId: "tenant-a", executionId: "job-a" },
      }),
    /private proxy-only network namespace/,
  );
  assert.equal(issued, 0);
  assert.equal(runnerCalls, 0);
});

test("Container runtime: proxy env is normalized per job without mutating parent sentinels", async () => {
  const controlledProxyUrl = "http://job:scoped-token@egress-proxy:8080/";
  const controlEnvironment: NodeJS.ProcessEnv = {
    PATH: "/usr/bin:/bin",
    ...Object.fromEntries(
      PROXY_ENVIRONMENT_KEYS.map((key) => [key, `http://parent-${key.toLowerCase()}.invalid:9000`]),
    ),
  };
  const controlSentinel = { ...controlEnvironment };
  const parentProcessSentinel = proxyEnvironmentSnapshot(process.env);
  const disabledRequestEnv = Object.fromEntries(
    PROXY_ENVIRONMENT_KEYS.map((key) => [key, `http://disabled-${key.toLowerCase()}.invalid:9001`]),
  );
  const enabledRequestEnv = Object.fromEntries(
    PROXY_ENVIRONMENT_KEYS.map((key) => [key, `http://enabled-${key.toLowerCase()}.invalid:9002`]),
  );
  const disabledRequestSentinel = { ...disabledRequestEnv };
  const enabledRequestSentinel = { ...enabledRequestEnv };
  const runs: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    internalNetwork: "anicode-internal",
    proxyUrl: "http://egress-proxy:8080",
    controlEnvironment,
    proxyCredentialIssuer: {
      issue: async () => ({
        proxyUrl: controlledProxyUrl,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        redact: (value) => value,
        revoke: async () => undefined,
      }),
    },
    processRunner: inMemoryOciRunner({
      onCreate: async (_file, args, env) => {
        runs.push({ args: [...args], env: { ...env } });
      },
    }),
  });

  await runtime.run({
    command: "true",
    cwd: process.cwd(),
    policy: "read-only",
    network: false,
    env: disabledRequestEnv,
  });
  await assert.rejects(
    () =>
      runtime.run({
        command: "true",
        cwd: process.cwd(),
        policy: "read-only",
        network: true,
        env: enabledRequestEnv,
        workload: { tenantId: "tenant-a", executionId: "job-a" },
      }),
    /private proxy-only network namespace/,
  );

  assert.equal(runs.length, 1);
  const disabled = runs[0]!;
  const disabledForwarded = forwardedEnvironmentNames(disabled.args);
  for (const key of PROXY_ENVIRONMENT_KEYS) {
    assert.equal(disabled.env[key], undefined, key);
    assert.ok(!disabledForwarded.includes(key), key);
  }

  assert.deepEqual(controlEnvironment, controlSentinel);
  assert.deepEqual(disabledRequestEnv, disabledRequestSentinel);
  assert.deepEqual(enabledRequestEnv, enabledRequestSentinel);
  assert.deepEqual(proxyEnvironmentSnapshot(process.env), parentProcessSentinel);
});

test("Container runtime: shared inline proxy credentials fail closed", () => {
  assert.throws(
    () =>
      new ContainerIsolatedRuntime({
        image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        proxyUrl: "http://shared:long-lived-token@egress-proxy:8080",
      }),
    /credential-free/,
  );
});

test("Container runtime: network access fails closed without a scoped credential issuer", async () => {
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    /private proxy-only network namespace/,
  );
});

test("Container runtime: durable startup reconciliation removes a crash-orphan journal entry", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-journal-"));
  const journal = path.join(root, "orphans.json");
  const name = "anicode-crashed-1";
  const ownerToken = "44444444-4444-4444-8444-444444444444";
  const containerId = "e".repeat(64);
  await fs.writeFile(
    journal,
    `${JSON.stringify({
      version: 1,
      records: [
        {
          name,
          engine: "docker",
          endpoint: TEST_DOCKER_ENDPOINT,
          ownerToken,
          startedAt: new Date().toISOString(),
          tenantId: "tenant-a",
          executionId: "execution-a",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const calls: string[][] = [];
  let exists = true;
  const runner: ContainerProcessRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "rm") {
      exists = false;
      return { exitCode: 0, output: "removed", timedOut: false };
    }
    if (args[0] === "container") {
      return exists
        ? {
            exitCode: 0,
            output: "",
            controlOutput: `${containerId} ${ownerToken}`,
            timedOut: false,
          }
        : { exitCode: 1, output: `Error: No such container: ${args.at(-1)}`, timedOut: false };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    processRunner: runner,
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
  });
  try {
    await runtime.reconcileOrphans();
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as { records: unknown[] };
    assert.deepEqual(state.records, []);
    assert.ok(calls.some((args) => args[0] === "stop" && args.at(-1) === containerId));
    assert.ok(calls.some((args) => args[0] === "rm" && args.at(-1) === containerId));
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: legacy missing records migrate to creating and never prove absence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-legacy-creating-"));
  const journal = path.join(root, "orphans.json");
  const name = "anicode-legacy-ambiguous";
  const startedAt = new Date().toISOString();
  await fs.writeFile(
    journal,
    `${JSON.stringify({
      version: 1,
      records: [
        {
          name,
          engine: "docker",
          endpoint: TEST_DOCKER_ENDPOINT,
          ownerToken: "45454545-4545-4545-8545-454545454545",
          startedAt,
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: async (_file, args) =>
      args[0] === "container"
        ? {
            exitCode: 1,
            output: `No such container: ${args.at(-1)}`,
            timedOut: false,
          }
        : { exitCode: 0, output: "", timedOut: false },
  });
  try {
    await assert.rejects(runtime.reconcileOrphans(), /orphan reconciliation failed/);
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as {
      version: number;
      records: { name: string; phase?: string; containerId?: string }[];
    };
    assert.equal(state.version, 2);
    assert.deepEqual(state.records, [
      {
        name,
        engine: "docker",
        endpoint: TEST_DOCKER_ENDPOINT,
        ownerToken: "45454545-4545-4545-8545-454545454545",
        startedAt,
        phase: "creating",
      },
    ]);
  } finally {
    await assert.rejects(runtime.shutdown(), /orphan reconciliation failed/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: a durable reserved record clears without touching the daemon", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-reserved-"));
  const journal = path.join(root, "orphans.json");
  await fs.writeFile(
    journal,
    `${JSON.stringify({
      version: 2,
      records: [
        {
          name: "anicode-reserved-no-create",
          engine: "docker",
          endpoint: TEST_DOCKER_ENDPOINT,
          ownerToken: "46464646-4646-4646-8646-464646464646",
          startedAt: new Date().toISOString(),
          phase: "reserved",
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  let daemonCalls = 0;
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: async () => {
      daemonCalls++;
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    await runtime.reconcileOrphans();
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as { records: unknown[] };
    assert.deepEqual(state.records, []);
    assert.equal(daemonCalls, 0);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: ambiguous create is never retried and a missing name stays journaled until its late object is removed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-late-create-"));
  const journal = path.join(root, "orphans.json");
  const containerId = "9".repeat(64);
  let name = "";
  let ownerToken = "";
  let exists = false;
  let createCalls = 0;
  let startCalls = 0;
  const calls: string[][] = [];
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: async (_file, args) => {
      calls.push([...args]);
      if (args[0] === "create") {
        createCalls++;
        name = String(args[args.indexOf("--name") + 1]);
        ownerToken = String(args[args.indexOf("--label") + 1]).split("=")[1]!;
        return { exitCode: null, output: "create response lost", timedOut: true };
      }
      if (args[0] === "start") {
        startCalls++;
        return { exitCode: 0, output: "must-not-run", timedOut: false };
      }
      if (args[0] === "container") {
        return exists
          ? {
              exitCode: 0,
              output: "",
              controlOutput: `${containerId} ${ownerToken}`,
              timedOut: false,
            }
          : {
              exitCode: 1,
              output: `No such container: ${args.at(-1)}`,
              timedOut: false,
            };
      }
      if (args[0] === "rm") exists = false;
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    await assert.rejects(
      runtime.run({ command: "side-effect", cwd: root, network: false }),
      (error: unknown) => error instanceof Error && error.name === "RuntimeTerminationError",
    );
    assert.equal(createCalls, 1);
    assert.equal(startCalls, 0);
    await assert.rejects(runtime.reconcileOrphans(), /orphan reconciliation failed/);
    let state = JSON.parse(await fs.readFile(journal, "utf8")) as {
      version: number;
      records: { name: string; phase: string; containerId?: string }[];
    };
    assert.equal(state.version, 2);
    assert.deepEqual(
      state.records.map((record) => ({
        name: record.name,
        phase: record.phase,
        containerId: record.containerId,
      })),
      [{ name, phase: "creating", containerId: undefined }],
    );

    // Simulate the one original daemon request committing only after the early missing observation.
    exists = true;
    await runtime.reconcileOrphans();
    state = JSON.parse(await fs.readFile(journal, "utf8")) as typeof state;
    assert.deepEqual(state.records, []);
    assert.equal(exists, false);
    assert.equal(createCalls, 1);
    assert.equal(startCalls, 0);
    assert.ok(calls.some((args) => args[0] === "rm" && args[2] === containerId));
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: unresolved crash orphan remains journaled and blocks reconciliation", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-stuck-"));
  const journal = path.join(root, "orphans.json");
  const name = "anicode-stuck-1";
  const ownerToken = "55555555-5555-4555-8555-555555555555";
  await fs.writeFile(
    journal,
    `${JSON.stringify({
      version: 1,
      records: [
        {
          name,
          engine: "docker",
          endpoint: TEST_DOCKER_ENDPOINT,
          ownerToken,
          startedAt: new Date().toISOString(),
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: async (_file, args) =>
      args[0] === "container"
        ? {
            exitCode: 0,
            output: "",
            controlOutput: `${"f".repeat(64)} wrong-owner`,
            timedOut: false,
          }
        : { exitCode: 1, output: "failed", timedOut: false },
  });
  try {
    await assert.rejects(runtime.reconcileOrphans(), /orphan reconciliation failed/);
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as {
      records: { name: string }[];
    };
    assert.equal(state.records[0]?.name, name);
  } finally {
    await assert.rejects(runtime.shutdown(), /orphan reconciliation failed/);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: journals ownership before run and clears it only after awaited cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-active-"));
  const journal = path.join(root, "orphans.json");
  let sawCreatingOwner = false;
  let sawIdentifiedOwner = false;
  const runtime = new ContainerIsolatedRuntime({
    image: "runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: inMemoryOciRunner({
      onCreate: async () => {
        const state = JSON.parse(await fs.readFile(journal, "utf8")) as {
          version: number;
          records: { phase?: string; tenantId?: string; executionId?: string }[];
        };
        sawCreatingOwner =
          state.version === 2 &&
          state.records[0]?.phase === "creating" &&
          state.records[0]?.tenantId === "tenant-a" &&
          state.records[0]?.executionId === "execution-a";
      },
      onStart: async () => {
        const state = JSON.parse(await fs.readFile(journal, "utf8")) as {
          records: { phase?: string; containerId?: string }[];
        };
        sawIdentifiedOwner =
          state.records[0]?.phase === "identified" &&
          state.records[0]?.containerId === "a".repeat(64);
      },
    }),
  });
  try {
    await runtime.run({
      command: "true",
      cwd: root,
      workload: { tenantId: "tenant-a", executionId: "execution-a" },
    });
    assert.equal(sawCreatingOwner, true);
    assert.equal(sawIdentifiedOwner, true);
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as { records: unknown[] };
    assert.deepEqual(state.records, []);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: SQLite owner lock excludes live runtimes and releases on shutdown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-owner-lock-"));
  const journal = path.join(root, "orphans.json");
  const runner: ContainerProcessRunner = async (_file, args) =>
    args[0] === "container"
      ? { exitCode: 1, output: `No such container: ${args.at(-1)}`, timedOut: false }
      : { exitCode: 0, output: "", timedOut: false };
  const first = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    processRunner: runner,
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
  });
  try {
    assert.throws(
      () =>
        new ContainerIsolatedRuntime({
          image: `runtime@sha256:${"a".repeat(64)}`,
          processRunner: runner,
          orphanJournalPath: journal,
          orphanReconcileIntervalMs: false,
        }),
      /already owned/,
    );
    await first.shutdown();
    const successor = new ContainerIsolatedRuntime({
      image: `runtime@sha256:${"a".repeat(64)}`,
      processRunner: runner,
      orphanJournalPath: journal,
      orphanReconcileIntervalMs: false,
    });
    await successor.shutdown();
  } finally {
    await first.shutdown().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test(
  "Container runtime: SIGKILL releases the SQLite owner lock and successor reconciles the journal",
  POSIX_ONLY,
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-owner-crash-"));
    const journal = path.join(root, "orphans.json");
    const ownerFile = `${journal}.owner.sqlite`;
    const name = "anicode-crash-recovery";
    const ownerToken = "66666666-6666-4666-8666-666666666666";
    const containerId = "6".repeat(64);
    await fs.writeFile(
      journal,
      `${JSON.stringify({
        version: 1,
        records: [
          {
            name,
            engine: "docker",
            endpoint: TEST_DOCKER_ENDPOINT,
            ownerToken,
            startedAt: new Date().toISOString(),
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { DatabaseSync } from "node:sqlite"; const db = new DatabaseSync(${JSON.stringify(ownerFile)}); db.exec("PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE"); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await once(child.stdout!, "data");
      assert.throws(
        () =>
          new ContainerIsolatedRuntime({
            image: `runtime@sha256:${"a".repeat(64)}`,
            processRunner: async () => ({ exitCode: 0, output: "", timedOut: false }),
            orphanJournalPath: journal,
            orphanReconcileIntervalMs: false,
          }),
        /already owned/,
      );
      child.kill("SIGKILL");
      await once(child, "exit");
      let exists = true;
      const successor = new ContainerIsolatedRuntime({
        image: `runtime@sha256:${"a".repeat(64)}`,
        orphanJournalPath: journal,
        orphanReconcileIntervalMs: false,
        processRunner: async (_file, args) => {
          if (args[0] === "container") {
            return exists
              ? {
                  exitCode: 0,
                  output: "",
                  controlOutput: `${containerId} ${ownerToken}`,
                  timedOut: false,
                }
              : {
                  exitCode: 1,
                  output: `No such container: ${args.at(-1)}`,
                  timedOut: false,
                };
          }
          if (args[0] === "rm") exists = false;
          return { exitCode: 0, output: "", timedOut: false };
        },
      });
      await successor.reconcileOrphans();
      assert.equal(exists, false);
      const state = JSON.parse(await fs.readFile(journal, "utf8")) as { records: unknown[] };
      assert.deepEqual(state.records, []);
      await successor.shutdown();
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("Container runtime: shutdown aborts an admitted start and resolves only after immutable-ID cleanup", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => (markStarted = resolve));
  let sawShutdownAbort = false;
  let cleanupFinished = false;
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    processRunner: inMemoryOciRunner({
      onStart: async (_file, _args, _env, _timeout, _limit, signal) => {
        markStarted();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              sawShutdownAbort = true;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      },
      onRemove: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        cleanupFinished = true;
      },
    }),
  });
  const running = runtime.run({ command: "true", cwd: process.cwd(), network: false });
  await started;
  const closing = runtime.shutdown();
  await assert.rejects(
    runtime.run({ command: "true", cwd: process.cwd(), network: false }),
    /shut down/,
  );
  let closed = false;
  void closing.then(() => (closed = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  await assert.rejects(running, /shutting down/);
  await closing;
  assert.equal(sawShutdownAbort, true);
  assert.equal(cleanupFinished, true);
});

test("Container runtime: shutdown aborts create but rejects when an ambiguous missing request cannot be proved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-shutdown-create-"));
  const journal = path.join(root, "orphans.json");
  let createCalls = 0;
  let markCreating!: () => void;
  const creating = new Promise<void>((resolve) => (markCreating = resolve));
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    orphanJournalPath: journal,
    orphanReconcileIntervalMs: false,
    processRunner: async (_file, args, _env, _timeout, _limit, signal) => {
      if (args[0] === "create") {
        createCalls++;
        markCreating();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      if (args[0] === "container") {
        return {
          exitCode: 1,
          output: `No such container: ${args.at(-1)}`,
          timedOut: false,
        };
      }
      return { exitCode: 0, output: "", timedOut: false };
    },
  });
  try {
    const running = runtime.run({ command: "side-effect", cwd: root, network: false });
    await creating;
    const closing = runtime.shutdown();
    await assert.rejects(
      running,
      (error: unknown) => error instanceof Error && error.name === "RuntimeTerminationError",
    );
    await assert.rejects(closing, /orphan reconciliation failed/);
    const state = JSON.parse(await fs.readFile(journal, "utf8")) as {
      records: { phase: string; containerId?: string }[];
    };
    assert.deepEqual(
      state.records.map(({ phase, containerId }) => ({ phase, containerId })),
      [{ phase: "creating", containerId: undefined }],
    );
    assert.equal(createCalls, 1);
  } finally {
    await runtime.shutdown().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Container runtime: private workspace exposure never binds or names the host cwd", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-container-private-workspace-"));
  await fs.writeFile(path.join(root, ".env"), "HOST_SECRET=must-not-mount");
  let runArgs: string[] = [];
  const runtime = new ContainerIsolatedRuntime({
    image: `runtime@sha256:${"a".repeat(64)}`,
    processRunner: inMemoryOciRunner({
      onCreate: async (_file, args) => {
        runArgs = [...args];
      },
    }),
  });
  try {
    await runtime.run({
      command: "true",
      cwd: root,
      policy: "read-only",
      workspaceExposure: "none",
      network: false,
    });
    assert.equal(runArgs.includes(root), false);
    assert.equal(
      runArgs.some((value) => value.includes(root)),
      false,
    );
    assert.equal(runArgs.includes("--mount"), false);
    assert.ok(runArgs.includes("/workspace:rw,noexec,nosuid,nodev,size=16m"));
    assert.deepEqual(runArgs.slice(runArgs.indexOf("--entrypoint"), -2), [
      "--entrypoint",
      "/bin/sh",
      `runtime@sha256:${"a".repeat(64)}`,
    ]);
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

function forwardedEnvironmentNames(args: readonly string[]): string[] {
  return args
    .flatMap((value, index) => (value === "--env" ? [args[index + 1]] : []))
    .filter((value): value is string => Boolean(value));
}

function proxyEnvironmentSnapshot(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(PROXY_ENVIRONMENT_KEYS.map((key) => [key, env[key]]));
}

type ContainerProcessHook = (
  ...args: Parameters<ContainerProcessRunner>
) => Promise<ContainerProcessResult | void> | ContainerProcessResult | void;

function inMemoryOciRunner(
  hooks: {
    onCreate?: ContainerProcessHook;
    onStart?: ContainerProcessHook;
    onRemove?: ContainerProcessHook;
    onCall?: ContainerProcessHook;
  } = {},
): ContainerProcessRunner {
  const id = "a".repeat(64);
  let ownerToken = "";
  let exists = false;
  return async (file, args, env, timeout, limit, signal, stdin) => {
    await hooks.onCall?.(file, args, env, timeout, limit, signal, stdin);
    if (args[0] === "create") {
      ownerToken = String(args[args.indexOf("--label") + 1]).split("=")[1]!;
      const custom = await hooks.onCreate?.(file, args, env, timeout, limit, signal, stdin);
      if (custom) {
        if (custom.exitCode === 0 && !custom.timedOut) exists = true;
        return custom;
      }
      exists = true;
      return { exitCode: 0, output: id, controlOutput: id, timedOut: false };
    }
    if (args[0] === "start") {
      return (
        (await hooks.onStart?.(file, args, env, timeout, limit, signal, stdin)) ?? {
          exitCode: 0,
          output: "",
          controlOutput: "",
          timedOut: false,
        }
      );
    }
    if (args[0] === "container") {
      return exists
        ? {
            exitCode: 0,
            output: "",
            controlOutput: `${id} ${ownerToken}`,
            timedOut: false,
          }
        : {
            exitCode: 1,
            output: `No such container: ${args.at(-1)}`,
            timedOut: false,
          };
    }
    if (args[0] === "rm") {
      const custom = await hooks.onRemove?.(file, args, env, timeout, limit, signal, stdin);
      if (!custom || (custom.exitCode === 0 && !custom.timedOut)) exists = false;
      return custom ?? { exitCode: 0, output: "", timedOut: false };
    }
    return { exitCode: 0, output: "", timedOut: false };
  };
}
