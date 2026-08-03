import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContainerIsolatedRuntime,
  containerWorkspaceMount,
  type ContainerProcessRunner,
} from "./container-runtime.js";

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

test("Container runtime: timeout/error paths synchronously force-remove the named container", async () => {
  const calls: string[][] = [];
  const runner: ContainerProcessRunner = async (_file, args) => {
    calls.push(args);
    if (args[0] === "run") return { exitCode: null, output: "timed out", timedOut: true };
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
  const cleanup = calls.find((args) => args[0] === "rm");
  assert.ok(run?.some((arg) => arg.endsWith(",readonly")));
  assert.deepEqual(cleanup?.slice(0, 2), ["rm", "--force"]);
  assert.equal(cleanup?.[2], run?.[run.indexOf("--name") + 1]);
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
