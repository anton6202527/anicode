import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { KubernetesJobRuntime } from "./kubernetes-runtime.js";

test("Kubernetes runtime: 写入走临时副本 + PatchSet、固定代理 IP 并完成清理", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  let jobBody: any;
  const calls: { method: string; path: string }[] = [];
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"a".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    proxyUrl: "http://anicode-egress-proxy:8080",
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
      if (url.pathname.endsWith("/pods")) {
        return Response.json({ items: [{ metadata: { name: "runner-pod" } }] });
      }
      if (url.pathname.endsWith("/log")) return new Response("runner-ok");
      if (method === "DELETE") return new Response(null, { status: 200 });
      return Response.json({ status: { succeeded: 1 } });
    }) as typeof fetch,
  });
  try {
    const result = await runtime.run({
      command: "echo ok",
      cwd: path.join(root, "workspaces", "repo-1", "src"),
      policy: "workspace-write",
      network: true,
      traceContext: { traceId: "a".repeat(32), spanId: "b".repeat(16) },
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.output, "runner-ok");
    const podSpec = jobBody.spec.template.spec;
    const environment = Object.fromEntries(
      podSpec.containers[0].env.map((entry: { name: string; value: string }) => [
        entry.name,
        entry.value,
      ]),
    );
    assert.equal(environment.HTTP_PROXY, "http://10.96.42.42:8080/");
    assert.equal(environment.ANICODE_JOB_COMMAND, "echo ok");
    assert.equal(environment.ANICODE_JOB_RELATIVE_CWD, "src");
    assert.equal(environment.ANICODE_JOB_SOURCE, "/source");
    assert.equal(environment.TMPDIR, "/workspace");
    assert.equal(environment.TRACEPARENT, `00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
    assert.equal(podSpec.automountServiceAccountToken, false);
    assert.equal(podSpec.containers[0].securityContext.readOnlyRootFilesystem, true);
    assert.equal(podSpec.initContainers, undefined);
    assert.deepEqual(podSpec.containers[0].command, [
      "node",
      "--import",
      "tsx",
      "/app/packages/core/src/runtime/kubernetes-job-entry.ts",
    ]);
    assert.equal(
      podSpec.containers[0].volumeMounts.find(
        (mount: { name: string }) => mount.name === "workspace-source",
      ).subPath,
      "repo-1",
    );
    assert.equal(
      podSpec.volumes.find((volume: { name: string }) => volume.name === "workspace-source")
        .persistentVolumeClaim.readOnly,
      false,
    );
    assert.ok(calls.some((call) => call.method === "DELETE"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: read-only 临时副本只读挂载，禁用事务副本时拒绝写入", async () => {
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

    const unsafe = new KubernetesJobRuntime({
      image: `runner@sha256:${"d".repeat(64)}`,
      workspacePvc: "workspaces",
      hostWorkspaceRoot: path.join(root, "workspaces"),
      tokenFile,
      fetch,
      ephemeralWorkspace: false,
    });
    await assert.rejects(
      () =>
        unsafe.run({
          command: "touch changed",
          cwd: path.join(root, "workspaces", "repo-1"),
          policy: "workspace-write",
          network: false,
        }),
      /requires transactional ephemeralWorkspace/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
