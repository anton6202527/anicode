import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KubernetesJobRuntime } from "./kubernetes-runtime.js";

test("Kubernetes runtime: 只读任务使用临时副本、固定代理 IP 并完成清理", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  let jobBody: any;
  let secretBody: any;
  const ephemeralToken = "kubernetes-job-proxy-token-must-not-leak";
  let revoked = 0;
  const calls: { method: string; path: string }[] = [];
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"a".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    proxyUrl: "http://anicode-egress-proxy:8080",
    proxyCredentialIssuer: {
      issue: async ({ proxyUrl, tenantId, executionId }) => {
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
    resolver: async (hostname) => {
      assert.equal(hostname, "anicode-egress-proxy");
      return ["10.96.42.42"];
    },
    pollMs: 1,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      calls.push({ method, path: url.pathname });
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer service-account-token");
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        jobBody = JSON.parse(String(init?.body));
        return Response.json(jobBody, { status: 201 });
      }
      if (method === "POST" && url.pathname.endsWith("/secrets")) {
        secretBody = JSON.parse(String(init?.body));
        return Response.json({ metadata: { name: secretBody.metadata.name } }, { status: 201 });
      }
      if (url.pathname.endsWith("/pods")) {
        return Response.json({ items: [{ metadata: { name: "runner-pod" } }] });
      }
      if (url.pathname.endsWith("/log")) return new Response(`runner-ok ${ephemeralToken}`);
      if (method === "DELETE") return new Response(null, { status: 200 });
      return Response.json({ status: { succeeded: 1 } });
    }) as typeof fetch,
  });
  try {
    const result = await runtime.run({
      command: "echo ok",
      cwd: path.join(root, "workspaces", "repo-1", "src"),
      policy: "read-only",
      network: true,
      workload: { tenantId: "tenant-a", executionId: "job-a" },
      traceContext: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "runner-ok [REDACTED]");
    const podSpec = jobBody.spec.template.spec;
    const environment = Object.fromEntries(
      podSpec.containers[0].env.map((entry: { name: string; value: string }) => [
        entry.name,
        entry.value,
      ]),
    );
    assert.equal(environment.HTTP_PROXY, undefined);
    const proxyEnvironment = podSpec.containers[0].env.find(
      (entry: { name: string }) => entry.name === "HTTP_PROXY",
    );
    assert.deepEqual(proxyEnvironment.valueFrom.secretKeyRef, {
      name: secretBody.metadata.name,
      key: "proxy-url",
      optional: false,
    });
    assert.equal(JSON.stringify(jobBody).includes(ephemeralToken), false);
    assert.equal(secretBody.immutable, true);
    assert.equal(secretBody.metadata.labels["anicode.dev/owner-job"], jobBody.metadata.name);
    assert.equal(
      Buffer.from(secretBody.data["proxy-url"], "base64").toString("utf8"),
      `http://job-principal:${ephemeralToken}@10.96.42.42:8080/`,
    );
    assert.equal(environment.ANICODE_JOB_COMMAND, undefined);
    assert.equal(environment.ANICODE_JOB_SOURCE, undefined);
    assert.equal(environment.TRACEPARENT, `00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
    assert.equal(podSpec.automountServiceAccountToken, false);
    assert.equal(podSpec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(podSpec.containers[0].command, ["/bin/sh", "-lc", "echo ok"]);
    assert.equal(
      podSpec.initContainers[0].volumeMounts.find(
        (mount: { name: string }) => mount.name === "workspace-source",
      ).readOnly,
      true,
    );
    assert.equal(
      podSpec.initContainers[0].volumeMounts.find(
        (mount: { name: string }) => mount.name === "workspace-source",
      ).subPath,
      "repo-1",
    );
    assert.equal(
      podSpec.volumes.find((volume: { name: string }) => volume.name === "workspace-source")
        .persistentVolumeClaim.readOnly,
      true,
    );
    assert.ok(calls.some((call) => call.method === "DELETE"));
    assert.ok(calls.some((call) => call.method === "DELETE" && call.path.includes("/secrets/")));
    assert.equal(revoked, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: shared inline proxy credentials fail closed", async () => {
  assert.throws(
    () =>
      new KubernetesJobRuntime({
        image: `runner@sha256:${"e".repeat(64)}`,
        workspacePvc: "workspaces",
        hostWorkspaceRoot: "/workspaces",
        proxyUrl: "http://shared:long-lived-token@egress-proxy:8080",
        fetch: (async () => Response.json({})) as typeof fetch,
      }),
    /credential-free/,
  );
});

test("Kubernetes runtime: network access fails closed without a scoped credential issuer", async () => {
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"e".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: "/workspaces",
    proxyUrl: "http://egress-proxy:8080",
    fetch: (async () => Response.json({})) as typeof fetch,
  });
  await assert.rejects(
    () =>
      runtime.run({
        command: "true",
        cwd: "/workspaces/repo-1",
        policy: "read-only",
        network: true,
      }),
    /execution-scoped proxy credential/,
  );
});

test("Kubernetes runtime: Secret API diagnostics cannot leak scoped proxy material", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-proxy-error-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const ephemeralToken = "secret-api-diagnostic-token-must-not-leak";
  let revoked = 0;
  const pinnedUrl = `http://job-principal:${ephemeralToken}@10.96.42.42:8080/`;
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"f".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    proxyUrl: "http://anicode-egress-proxy:8080",
    proxyCredentialIssuer: {
      issue: async ({ proxyUrl }) => {
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
    resolver: async () => ["10.96.42.42"],
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      if (init?.method === "POST" && url.pathname.endsWith("/secrets")) {
        return new Response(String(init.body), { status: 500 });
      }
      if (init?.method === "DELETE") return new Response(null, { status: 200 });
      return Response.json({});
    }) as typeof fetch,
  });
  try {
    let message = "";
    try {
      await runtime.run({
        command: "env",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: true,
        workload: { tenantId: "tenant-a", executionId: "job-a" },
      });
      assert.fail("Secret creation should fail");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    assert.equal(message.includes(ephemeralToken), false);
    assert.equal(message.includes(Buffer.from(pinnedUrl).toString("base64")), false);
    assert.equal(revoked, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: read-only 临时副本只读挂载，所有写任务 fail-close", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-readonly-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "token", { mode: 0o600 });
  let jobBody: any;
  const fetch = (async (target, init) => {
    const url = new URL(String(target));
    if (init?.method === "POST") {
      jobBody = JSON.parse(String(init.body));
      return Response.json(jobBody, { status: 201 });
    }
    if (url.pathname.endsWith("/pods")) {
      return Response.json({ items: [{ metadata: { name: "runner-pod" } }] });
    }
    if (url.pathname.endsWith("/log")) return new Response("ok");
    if (init?.method === "DELETE") return new Response(null, { status: 200 });
    return Response.json({ status: { succeeded: 1 } });
  }) as typeof globalThis.fetch;
  try {
    const runtime = new KubernetesJobRuntime({
      image: `runner@sha256:${"c".repeat(64)}`,
      workspacePvc: "workspaces",
      hostWorkspaceRoot: path.join(root, "workspaces"),
      tokenFile,
      fetch,
      useWatch: false,
      pollMs: 1,
    });
    await runtime.run({
      command: "echo inspect",
      cwd: path.join(root, "workspaces", "repo-1"),
      policy: "read-only",
      network: false,
    });
    assert.equal(jobBody.spec.template.spec.initContainers[0].volumeMounts[0].readOnly, true);
    assert.deepEqual(jobBody.spec.template.spec.containers[0].command, [
      "/bin/sh",
      "-lc",
      "echo inspect",
    ]);
    assert.equal(
      jobBody.spec.template.spec.containers[0].volumeMounts.find(
        (mount: { name: string }) => mount.name === "workspace",
      ).readOnly,
      true,
    );
    const unsafe = new KubernetesJobRuntime({
      image: `runner@sha256:${"d".repeat(64)}`,
      workspacePvc: "workspaces",
      hostWorkspaceRoot: path.join(root, "workspaces"),
      tokenFile,
      fetch,
      ephemeralWorkspace: false,
    });
    await unsafe.run({
      command: "echo inspect",
      cwd: path.join(root, "workspaces", "repo-1"),
      network: false,
    });
    assert.equal(
      jobBody.spec.template.spec.containers[0].volumeMounts.find(
        (mount: { name: string }) => mount.name === "workspace",
      ).readOnly,
      true,
    );
    assert.equal(
      jobBody.spec.template.spec.containers[0].volumeMounts.find(
        (mount: { name: string }) => mount.name === "workspace",
      ).subPath,
      "repo-1",
    );
    assert.equal(jobBody.spec.template.spec.containers[0].workingDir, "/workspace");
    assert.equal(
      jobBody.spec.template.spec.volumes.find(
        (volume: { name: string }) => volume.name === "workspace",
      ).persistentVolumeClaim.readOnly,
      true,
    );
    await assert.rejects(
      () =>
        unsafe.run({
          command: "touch changed",
          cwd: path.join(root, "workspaces", "repo-1"),
          policy: "workspace-write",
          network: false,
        }),
      /workspace-write is disabled.*trusted control-plane patch committer/,
    );

    await assert.rejects(
      () =>
        runtime.run({
          command: "touch changed",
          cwd: path.join(root, "workspaces", "repo-1"),
          policy: "workspace-write",
          network: false,
        }),
      /workspace-write is disabled.*trusted control-plane patch committer/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
