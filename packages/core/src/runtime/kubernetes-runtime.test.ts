import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { RuntimeTerminationError } from "./isolated-runtime.js";
import { KubernetesCredentialRevocationError, KubernetesJobRuntime } from "./kubernetes-runtime.js";

test("Kubernetes runtime: 只读任务使用临时副本、固定代理 IP 并完成清理", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  let jobBody: any;
  let secretBody: any;
  const ephemeralToken = "kubernetes-job-proxy-token-must-not-leak";
  const jobUid = "11111111-1111-4111-8111-111111111111";
  const secretUid = "22222222-2222-4222-8222-222222222223";
  let jobDeleted = false;
  let secretDeleted = true;
  let revoked = 0;
  let activationPatch: unknown;
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
        return Response.json(
          { ...jobBody, metadata: { ...jobBody.metadata, uid: jobUid } },
          { status: 201 },
        );
      }
      if (method === "POST" && url.pathname.endsWith("/secrets")) {
        secretBody = JSON.parse(String(init?.body));
        secretDeleted = false;
        return Response.json(
          { metadata: { ...secretBody.metadata, uid: secretUid } },
          { status: 201 },
        );
      }
      if (method === "PATCH" && url.pathname.includes("/jobs/")) {
        activationPatch = JSON.parse(String(init?.body));
        return Response.json({ metadata: { uid: jobUid } });
      }
      if (method === "GET" && url.pathname.includes("/jobs/")) {
        if (!jobBody || jobDeleted) {
          return Response.json({ message: "not found" }, { status: 404 });
        }
        return Response.json({
          metadata: { ...jobBody.metadata, uid: jobUid },
          status: { succeeded: 1 },
        });
      }
      if (method === "GET" && url.pathname.includes("/secrets/")) {
        return !secretBody || secretDeleted
          ? Response.json({ message: "not found" }, { status: 404 })
          : Response.json({ metadata: { ...secretBody.metadata, uid: secretUid } });
      }
      if (url.pathname.endsWith("/pods")) {
        return Response.json({
          items: jobDeleted
            ? []
            : [
                {
                  metadata: {
                    name: "runner-pod",
                    labels: jobBody.metadata.labels,
                    ownerReferences: [
                      {
                        apiVersion: "batch/v1",
                        kind: "Job",
                        name: jobBody.metadata.name,
                        uid: jobUid,
                      },
                    ],
                  },
                },
              ],
        });
      }
      if (url.pathname.endsWith("/log")) return new Response(`runner-ok ${ephemeralToken}`);
      if (method === "DELETE") {
        if (url.pathname.includes("/jobs/")) jobDeleted = true;
        if (url.pathname.includes("/secrets/")) secretDeleted = true;
        return new Response(null, { status: 200 });
      }
      return Response.json({ status: { succeeded: 1 } });
    }) as typeof fetch,
  });
  try {
    const result = await runtime.run({
      command: "echo ok",
      cwd: path.join(root, "workspaces", "repo-1", "src"),
      policy: "read-only",
      network: true,
      env: {
        HTTP_PROXY: "http://untrusted.invalid:9000",
        http_proxy: "http://untrusted.invalid:9001",
        HTTPS_PROXY: "http://untrusted.invalid:9002",
        https_proxy: "http://untrusted.invalid:9003",
        ALL_PROXY: "http://untrusted.invalid:9004",
        all_proxy: "http://untrusted.invalid:9005",
        NO_PROXY: "*",
        no_proxy: "*",
      },
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
    const expectedSecretKeyRef = {
      name: secretBody.metadata.name,
      key: "proxy-url",
      optional: false,
    };
    for (const name of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ]) {
      const matches = podSpec.containers[0].env.filter(
        (entry: { name: string }) => entry.name === name,
      );
      assert.equal(matches.length, 1, `${name} must have exactly one controlled value`);
      assert.deepEqual(matches[0].valueFrom.secretKeyRef, expectedSecretKeyRef);
    }
    assert.equal(environment.NO_PROXY, "");
    assert.equal(environment.no_proxy, "");
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
    assert.equal(jobBody.spec.suspend, true);
    assert.equal(jobBody.spec.activeDeadlineSeconds, 120);
    assert.equal(jobBody.spec.ttlSecondsAfterFinished, 300);
    assert.deepEqual(activationPatch, [
      { op: "test", path: "/metadata/uid", value: jobUid },
      {
        op: "test",
        path: "/metadata/labels/anicode.dev~1owner-token",
        value: jobBody.metadata.labels["anicode.dev/owner-token"],
      },
      { op: "replace", path: "/spec/suspend", value: false },
    ]);
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

test("Kubernetes runtime: failed proxy revocation poisons network admission and shutdown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-revoke-proof-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const jobUid = "12121212-1212-4212-8212-121212121212";
  const secretUid = "34343434-3434-4434-8434-343434343434";
  let issued = 0;
  let jobBody: any;
  let secretBody: any;
  let jobExists = false;
  let secretExists = false;
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"3".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    proxyUrl: "http://egress-proxy:8080",
    proxyCredentialIssuer: {
      issue: async ({ proxyUrl }) => {
        issued++;
        return {
          proxyUrl,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
          redact: (value) => value,
          revoke: async () => {
            throw new Error("credential authority unavailable");
          },
        };
      },
    },
    resolver: async () => ["10.96.42.42"],
    useWatch: false,
    pollMs: 1,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      if (method === "POST" && url.pathname.endsWith("/secrets")) {
        secretBody = JSON.parse(String(init?.body));
        secretExists = true;
        return Response.json(
          { metadata: { ...secretBody.metadata, uid: secretUid } },
          { status: 201 },
        );
      }
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        jobBody = JSON.parse(String(init?.body));
        jobExists = true;
        return Response.json({ metadata: { ...jobBody.metadata, uid: jobUid } }, { status: 201 });
      }
      if (method === "PATCH" && url.pathname.includes("/jobs/")) {
        return Response.json({ metadata: { ...jobBody.metadata, uid: jobUid } });
      }
      if (method === "GET" && url.pathname.includes("/secrets/")) {
        return secretExists
          ? Response.json({ metadata: { ...secretBody.metadata, uid: secretUid } })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (method === "GET" && url.pathname.includes("/jobs/")) {
        return jobExists
          ? Response.json({
              metadata: { ...jobBody.metadata, uid: jobUid },
              status: { succeeded: 1 },
            })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (url.pathname.endsWith("/pods")) {
        return Response.json({
          items: jobExists
            ? [
                {
                  metadata: {
                    name: "runner-pod",
                    labels: jobBody.metadata.labels,
                    ownerReferences: [{ kind: "Job", name: jobBody.metadata.name, uid: jobUid }],
                  },
                },
              ]
            : [],
        });
      }
      if (url.pathname.endsWith("/log")) return new Response("ok");
      if (method === "DELETE" && url.pathname.includes("/secrets/")) {
        secretExists = false;
        return new Response(null, { status: 200 });
      }
      if (method === "DELETE" && url.pathname.includes("/jobs/")) {
        jobExists = false;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected Kubernetes request ${method} ${url.pathname}`);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      runtime.run({
        command: "true",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: true,
        workload: { tenantId: "tenant-a", executionId: "revoke-proof" },
      }),
      (error: unknown) => error instanceof KubernetesCredentialRevocationError,
    );
    assert.equal(jobExists, false);
    assert.equal(secretExists, false);
    assert.equal(issued, 1);
    await assert.rejects(
      runtime.run({
        command: "must-not-start",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: true,
        workload: { tenantId: "tenant-a", executionId: "after-revoke-failure" },
      }),
      (error: unknown) => error instanceof KubernetesCredentialRevocationError,
    );
    assert.equal(issued, 1, "poisoned network admission must reject before issuing another lease");
    await assert.rejects(
      runtime.healthCheck(),
      (error: unknown) => error instanceof KubernetesCredentialRevocationError,
    );
    await assert.rejects(
      runtime.shutdown(),
      (error: unknown) => error instanceof KubernetesCredentialRevocationError,
    );
  } finally {
    await runtime.shutdown().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: execution and proxy revocation failures remain aggregated", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-revoke-aggregate-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"2".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    proxyUrl: "http://egress-proxy:8080",
    proxyCredentialIssuer: {
      issue: async ({ proxyUrl }) => ({
        proxyUrl,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        redact: (value) => value,
        revoke: async () => {
          throw new Error("credential authority unavailable");
        },
      }),
    },
    resolver: async () => {
      throw new Error("proxy resolution failed");
    },
    fetch: (async () => {
      throw new Error("Kubernetes API must not be reached");
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      runtime.run({
        command: "true",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: true,
        workload: { tenantId: "tenant-a", executionId: "aggregate-failure" },
      }),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.match(error.message, /execution failed.*revocation is indeterminate/i);
        assert.equal(error.errors.length, 2);
        assert.match(String(error.errors[0]), /proxy resolution failed/);
        assert.ok(error.errors[1] instanceof KubernetesCredentialRevocationError);
        return true;
      },
    );
    await assert.rejects(
      runtime.shutdown(),
      (error: unknown) => error instanceof KubernetesCredentialRevocationError,
    );
  } finally {
    await runtime.shutdown().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: cancellation remains indeterminate when UID-scoped deletion cannot be proved", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-termination-proof-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const uid = "33333333-3333-4333-8333-333333333333";
  let submittedBody: any;
  let created!: () => void;
  const didCreate = new Promise<void>((resolve) => (created = resolve));
  const deleteBodies: unknown[] = [];
  let activationCalls = 0;
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"9".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    useWatch: false,
    pollMs: 1,
    terminationTimeoutMs: 60,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        const submitted = JSON.parse(String(init?.body));
        submittedBody = submitted;
        created();
        return Response.json({ metadata: { ...submitted.metadata, uid } }, { status: 201 });
      }
      if (method === "DELETE" && url.pathname.includes("/jobs/")) {
        deleteBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ message: "forbidden" }, { status: 403 });
      }
      if (method === "PATCH") {
        activationCalls++;
        return Response.json({});
      }
      if (url.pathname.endsWith("/pods")) {
        const name = url.searchParams.get("labelSelector")?.split("=")[1] ?? "";
        return Response.json({
          items: [
            {
              metadata: {
                name: "still-running",
                labels: submittedBody.metadata.labels,
                ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid }],
              },
            },
          ],
        });
      }
      if (!submittedBody) return Response.json({ message: "not found" }, { status: 404 });
      return Response.json({ metadata: { ...submittedBody.metadata, uid }, status: {} });
    }) as typeof fetch,
  });
  const controller = new AbortController();
  try {
    const running = runtime.run({
      command: "side-effect",
      cwd: path.join(root, "workspaces", "repo-1"),
      policy: "read-only",
      network: false,
      signal: controller.signal,
      workload: { tenantId: "tenant-a", executionId: "termination-proof" },
    });
    await didCreate;
    controller.abort(new Error("cancel requested"));
    await assert.rejects(running, (error: unknown) => error instanceof RuntimeTerminationError);
    assert.ok(deleteBodies.length > 0);
    assert.equal(activationCalls, 0);
    assert.deepEqual(deleteBodies[0], {
      propagationPolicy: "Foreground",
      gracePeriodSeconds: 0,
      preconditions: { uid },
    });
    await assert.rejects(
      runtime.run({
        command: "must-not-run",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: false,
        workload: { tenantId: "tenant-a", executionId: "after-proof-failure" },
      }),
      (error: unknown) => error instanceof RuntimeTerminationError,
    );
  } finally {
    await assert.rejects(
      runtime.shutdown(),
      (error: unknown) => error instanceof RuntimeTerminationError,
    );
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: a timed-out create only observes and removes the single late commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-late-create-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const uid = "77777777-7777-4777-8777-777777777777";
  let submitted: any;
  let exists = false;
  let deleted = false;
  let postCalls = 0;
  const submittedBodies: any[] = [];
  let activationCalls = 0;
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"8".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    useWatch: false,
    pollMs: 5,
    requestTimeoutMs: 15,
    terminationTimeoutMs: 700,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        postCalls++;
        const submittedBody = JSON.parse(String(init?.body));
        submittedBodies.push(submittedBody);
        submitted ??= submittedBody;
        if (postCalls === 1) {
          return new Promise<Response>((resolve) => {
            setTimeout(() => {
              if (exists) {
                resolve(Response.json({ message: "already exists" }, { status: 409 }));
              } else {
                exists = true;
                resolve(
                  Response.json({ metadata: { ...submitted.metadata, uid } }, { status: 201 }),
                );
              }
            }, 40);
          });
        }
        return exists
          ? Response.json({ message: "already exists" }, { status: 409 })
          : Response.json({ metadata: { ...submitted.metadata, uid } }, { status: 201 });
      }
      if (method === "GET" && url.pathname.includes("/jobs/")) {
        return exists
          ? Response.json({ metadata: { ...submitted.metadata, uid }, status: {} })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (url.pathname.endsWith("/pods")) {
        return Response.json({
          items: exists
            ? [
                {
                  metadata: {
                    name: "late-pod",
                    labels: submitted.metadata.labels,
                    ownerReferences: [
                      { apiVersion: "batch/v1", kind: "Job", name: submitted.metadata.name, uid },
                    ],
                  },
                },
              ]
            : [],
        });
      }
      if (method === "DELETE" && url.pathname.includes("/jobs/")) {
        const body = JSON.parse(String(init?.body));
        assert.equal(body.preconditions.uid, uid);
        exists = false;
        deleted = true;
        return new Response(null, { status: 200 });
      }
      if (method === "PATCH") {
        activationCalls++;
        return Response.json({});
      }
      throw new Error(`unexpected Kubernetes request ${method} ${url.pathname}`);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      runtime.run({
        command: "side-effect",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: false,
        workload: { tenantId: "tenant-a", executionId: "stable-late-create" },
      }),
      /timed out/,
    );
    assert.equal(deleted, true);
    assert.equal(exists, false);
    assert.equal(postCalls, 1);
    assert.ok(submittedBodies.every((candidate) => candidate.spec.suspend === true));
    assert.equal(activationCalls, 0);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: a timed-out Secret POST observes and removes only its late UID", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-late-secret-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const uid = "99999999-9999-4999-8999-999999999999";
  let secretBody: any;
  let exists = false;
  let deleted = false;
  let postCalls = 0;
  let revoked = 0;
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"6".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    proxyUrl: "http://egress-proxy:8080",
    proxyCredentialIssuer: {
      issue: async ({ proxyUrl }) => ({
        proxyUrl,
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        redact: (value) => value,
        revoke: async () => {
          revoked++;
        },
      }),
    },
    resolver: async () => ["10.96.42.42"],
    pollMs: 5,
    requestTimeoutMs: 250,
    terminationTimeoutMs: 1_000,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      if (method === "GET" && url.pathname.includes("/jobs/")) {
        return Response.json({ message: "not found" }, { status: 404 });
      }
      if (method === "GET" && url.pathname.includes("/secrets/")) {
        return exists
          ? Response.json({ metadata: { ...secretBody.metadata, uid } })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (method === "POST" && url.pathname.endsWith("/secrets")) {
        postCalls++;
        secretBody = JSON.parse(String(init?.body));
        const signal = init?.signal;
        assert.ok(signal);
        return new Promise<Response>((resolve) => {
          const commitAfterTimeout = () => {
            setImmediate(() => {
              exists = true;
              resolve(
                Response.json({ metadata: { ...secretBody.metadata, uid } }, { status: 201 }),
              );
            });
          };
          if (signal.aborted) commitAfterTimeout();
          else signal.addEventListener("abort", commitAfterTimeout, { once: true });
        });
      }
      if (method === "DELETE" && url.pathname.includes("/secrets/")) {
        assert.deepEqual(JSON.parse(String(init?.body)).preconditions, { uid });
        exists = false;
        deleted = true;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected Kubernetes request ${method} ${url.pathname}`);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      runtime.run({
        command: "side-effect",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: true,
        workload: { tenantId: "tenant-a", executionId: "late-secret" },
      }),
      /Kubernetes API POST .*\/secrets timed out/,
    );
    assert.equal(postCalls, 1);
    assert.equal(deleted, true);
    assert.equal(exists, false);
    assert.equal(revoked, 1);
    await runtime.shutdown();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: foreign replacement cannot prove an unknown create did not commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-foreign-unknown-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  let postCalls = 0;
  let deleteCalls = 0;
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"5".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    useWatch: false,
    pollMs: 5,
    requestTimeoutMs: 15,
    terminationTimeoutMs: 60,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        postCalls++;
        return new Promise<Response>(() => undefined);
      }
      if (method === "GET" && url.pathname.includes("/jobs/")) {
        if (postCalls === 0) return Response.json({ message: "not found" }, { status: 404 });
        return Response.json({
          metadata: {
            uid: "foreign-uid",
            labels: { "anicode.dev/owner-token": "foreign-owner" },
          },
        });
      }
      if (url.pathname.endsWith("/pods")) return Response.json({ items: [] });
      if (method === "DELETE") {
        deleteCalls++;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected Kubernetes request ${method} ${url.pathname}`);
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      runtime.run({
        command: "side-effect",
        cwd: path.join(root, "workspaces", "repo-1"),
        policy: "read-only",
        network: false,
        workload: { tenantId: "tenant-a", executionId: "unknown-foreign" },
      }),
      (error: unknown) => error instanceof RuntimeTerminationError,
    );
    assert.equal(postCalls, 1);
    assert.equal(deleteCalls, 0);
    await assert.rejects(
      runtime.shutdown(),
      (error: unknown) => error instanceof RuntimeTerminationError,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: shutdown fences admission, aborts workloads, and drains UID cleanup", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-shutdown-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const uid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let body: any;
  let exists = false;
  let deleted = false;
  let markActivated!: () => void;
  const activated = new Promise<void>((resolve) => (markActivated = resolve));
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"4".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    useWatch: false,
    pollMs: 1,
    terminationTimeoutMs: 500,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        body = JSON.parse(String(init?.body));
        exists = true;
        return Response.json({ metadata: { ...body.metadata, uid } }, { status: 201 });
      }
      if (method === "PATCH") {
        markActivated();
        return Response.json({ metadata: { uid } });
      }
      if (method === "GET" && url.pathname.includes("/jobs/")) {
        return exists
          ? Response.json({ metadata: { ...body.metadata, uid }, status: {} })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (url.pathname.endsWith("/pods")) return Response.json({ items: [] });
      if (method === "DELETE" && url.pathname.includes("/jobs/")) {
        exists = false;
        deleted = true;
        return new Response(null, { status: 200 });
      }
      throw new Error(`unexpected Kubernetes request ${method} ${url.pathname}`);
    }) as typeof fetch,
  });
  try {
    const running = runtime.run({
      command: "sleep 60",
      cwd: path.join(root, "workspaces", "repo-1"),
      policy: "read-only",
      network: false,
      workload: { tenantId: "tenant-a", executionId: "shutdown-drain" },
    });
    await activated;
    const closing = runtime.shutdown();
    await assert.rejects(
      runtime.run({
        command: "must-not-start",
        cwd: path.join(root, "workspaces", "repo-1"),
        workload: { executionId: "after-shutdown" },
      }),
      /shut down/,
    );
    await assert.rejects(running, /shutting down/);
    await closing;
    assert.equal(deleted, true);
    assert.equal(exists, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: reclaim reconciles the prior stable execution UID before creating", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-reclaim-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const executionIdentity = "tenant-a\0stable-reclaim";
  const name = `anicode-${createHash("sha256").update(executionIdentity).digest("hex").slice(0, 40)}`;
  const ownerToken = createHash("sha256")
    .update(`owner\0${executionIdentity}`)
    .digest("hex")
    .slice(0, 32);
  let uid = "88888888-8888-4888-8888-888888888888";
  let exists = true;
  let activeObjects = 1;
  let maximumActive = 1;
  const createdNames: string[] = [];
  let body: any = { metadata: { name, labels: { "anicode.dev/owner-token": ownerToken } } };
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"7".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    useWatch: false,
    pollMs: 1,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      const method = String(init?.method ?? "GET");
      if (method === "GET" && url.pathname.includes("/jobs/")) {
        return exists
          ? Response.json({ metadata: { ...body.metadata, uid }, status: { succeeded: 1 } })
          : Response.json({ message: "not found" }, { status: 404 });
      }
      if (url.pathname.endsWith("/pods")) {
        return Response.json({
          items: exists
            ? [
                {
                  metadata: {
                    name: "owned-pod",
                    labels: body.metadata.labels,
                    ownerReferences: [{ apiVersion: "batch/v1", kind: "Job", name, uid }],
                  },
                },
              ]
            : [],
        });
      }
      if (method === "DELETE" && url.pathname.includes("/jobs/")) {
        exists = false;
        activeObjects = 0;
        return new Response(null, { status: 200 });
      }
      if (method === "POST" && url.pathname.endsWith("/jobs")) {
        body = JSON.parse(String(init?.body));
        createdNames.push(body.metadata.name);
        uid = "99999999-9999-4999-8999-999999999999";
        exists = true;
        activeObjects++;
        maximumActive = Math.max(maximumActive, activeObjects);
        return Response.json({ metadata: { ...body.metadata, uid } }, { status: 201 });
      }
      if (method === "PATCH" && url.pathname.includes("/jobs/")) {
        return Response.json({ metadata: { ...body.metadata, uid } });
      }
      if (url.pathname.endsWith("/log")) return new Response("ok");
      throw new Error(`unexpected Kubernetes request ${method} ${url.pathname}`);
    }) as typeof fetch,
  });
  try {
    await runtime.run({
      command: "true",
      cwd: path.join(root, "workspaces", "repo-1"),
      policy: "read-only",
      network: false,
      workload: { tenantId: "tenant-a", executionId: "stable-reclaim" },
    });
    assert.deepEqual(createdNames, [name]);
    assert.equal(maximumActive, 1);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: control-plane requests have a hard deadline even for non-cooperative fetch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-request-timeout-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  const runtime = new KubernetesJobRuntime({
    image: `runner@sha256:${"1".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    requestTimeoutMs: 25,
    fetch: (() => new Promise<Response>(() => {})) as typeof fetch,
  });
  try {
    await assert.rejects(() => runtime.healthCheck(), /timed out after 25ms/);
  } finally {
    await runtime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Kubernetes runtime: void responses are released and JSON bodies are bounded", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-kube-response-bounds-"));
  const tokenFile = path.join(root, "token");
  await fs.writeFile(tokenFile, "service-account-token", { mode: 0o600 });
  let cancelled = 0;
  const healthRuntime = new KubernetesJobRuntime({
    image: `runner@sha256:${"2".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    fetch: (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      )) as typeof fetch,
  });
  try {
    await healthRuntime.healthCheck();
    assert.equal(cancelled, 1);
  } finally {
    await healthRuntime.shutdown();
  }

  let boundedJobDeleted = false;
  let boundedJobSubmitted = false;
  const boundedRuntime = new KubernetesJobRuntime({
    image: `runner@sha256:${"3".repeat(64)}`,
    workspacePvc: "workspaces",
    hostWorkspaceRoot: path.join(root, "workspaces"),
    tokenFile,
    useWatch: false,
    maxApiResponseBytes: 64,
    fetch: (async (target, init) => {
      const url = new URL(String(target));
      if (init?.method === "POST") {
        boundedJobSubmitted = true;
        return Response.json({ metadata: { uid: "bounded-job-uid" } }, { status: 201 });
      }
      if (init?.method === "DELETE") {
        boundedJobDeleted = true;
        return new Response(null, { status: 200 });
      }
      if (url.pathname.includes("/jobs/")) {
        return !boundedJobSubmitted || boundedJobDeleted
          ? Response.json({ message: "not found" }, { status: 404 })
          : Response.json({ padding: "x".repeat(256) });
      }
      return Response.json({ items: [] });
    }) as typeof fetch,
  });
  try {
    await assert.rejects(
      () =>
        boundedRuntime.run({
          command: "true",
          cwd: path.join(root, "workspaces", "repo-1"),
          policy: "read-only",
          network: false,
          workload: { executionId: "bounded-response" },
        }),
      /response exceeds 64 bytes/,
    );
  } finally {
    await boundedRuntime.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  }
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
      if (init?.method === "GET" && url.pathname.includes("/jobs/")) {
        return Response.json({ message: "not found" }, { status: 404 });
      }
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
  let jobDeleted = false;
  const jobUid = "22222222-2222-4222-8222-222222222222";
  const fetch = (async (target, init) => {
    const url = new URL(String(target));
    if (init?.method === "POST") {
      jobBody = JSON.parse(String(init.body));
      jobDeleted = false;
      return Response.json(
        { ...jobBody, metadata: { ...jobBody.metadata, uid: jobUid } },
        { status: 201 },
      );
    }
    if (init?.method === "GET" && url.pathname.includes("/jobs/")) {
      if (!jobBody || jobDeleted) {
        return Response.json({ message: "not found" }, { status: 404 });
      }
      return Response.json({
        metadata: { ...jobBody.metadata, uid: jobUid },
        status: { succeeded: 1 },
      });
    }
    if (url.pathname.endsWith("/pods")) {
      return Response.json({
        items: jobDeleted
          ? []
          : [
              {
                metadata: {
                  name: "runner-pod",
                  labels: jobBody.metadata.labels,
                  ownerReferences: [
                    {
                      apiVersion: "batch/v1",
                      kind: "Job",
                      name: jobBody.metadata.name,
                      uid: jobUid,
                    },
                  ],
                },
              },
            ],
      });
    }
    if (url.pathname.endsWith("/log")) return new Response("ok");
    if (init?.method === "DELETE") {
      jobDeleted = true;
      return new Response(null, { status: 200 });
    }
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
      workload: { executionId: "readonly-ephemeral" },
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
      workload: { executionId: "readonly-pvc" },
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
