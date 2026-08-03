import { createHmac } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialBroker } from "../security/credentials.js";
import { GitHubDelivery, buildSlsaProvenance } from "./github-delivery.js";
import {
  GitHubWebhookController,
  createGitHubRepairWorker,
  verifyGitHubWebhookSignature,
} from "./github-webhook.js";
import { NetworkProxy } from "./network-proxy.js";
import { InMemoryTelemetry } from "./telemetry.js";
import { DurableWorkerQueue } from "./worker.js";

test("GitHub webhook: HMAC、delivery 去重、失败修复、Check Run 与 merge queue", async () => {
  const broker = new CredentialBroker();
  broker.register({
    id: "webhook",
    value: "hook-secret",
    scopes: [{ audiences: ["github-webhook"], tools: ["verify-signature"] }],
  });
  broker.register({
    id: "github",
    value: "Bearer app-token",
    scopes: [
      { audiences: ["github-delivery"], hosts: ["api.github.test"], header: "authorization" },
    ],
  });
  const calls: { path: string; method: string }[] = [];
  let checkId = 100;
  const telemetry = new InMemoryTelemetry();
  const proxy = new NetworkProxy({
    broker,
    resolver: async () => ["93.184.216.34"],
    fetch: async (target, init) => {
      const path = new URL(String(target)).pathname;
      calls.push({ path, method: String(init?.method) });
      if (path === "/graphql") {
        return Response.json({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "mq-1" } } } });
      }
      if (path.endsWith("/check-runs") && init?.method === "POST") {
        return Response.json({ id: checkId++, status: "in_progress" });
      }
      if (/\/check-runs\/\d+$/.test(path)) {
        return Response.json({
          id: Number(path.split("/").pop()),
          status: "completed",
          conclusion: "success",
        });
      }
      return Response.json({ ok: true });
    },
  });
  const delivery = new GitHubDelivery({
    owner: "owner",
    repo: "repo",
    apiBase: "https://api.github.test",
    proxy,
    broker,
    credentialId: "github",
    telemetry,
  });
  const queue = new DurableWorkerQueue();
  const controller = new GitHubWebhookController({
    broker,
    webhookSecretCredentialId: "webhook",
    queue,
    delivery,
    telemetry,
    expectedRepository: "owner/repo",
    expectedInstallationId: 42,
  });
  const payload = Buffer.from(
    JSON.stringify({
      action: "completed",
      repository: { full_name: "owner/repo" },
      installation: { id: 42 },
      workflow_run: {
        head_sha: "a".repeat(40),
        conclusion: "failure",
        html_url: "https://ci/1",
        pull_requests: [{ number: 7, node_id: "PR_node" }],
      },
    }),
  );
  const signature = `sha256=${createHmac("sha256", "hook-secret").update(payload).digest("hex")}`;
  const upstreamTraceparent = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
  assert.equal(verifyGitHubWebhookSignature("hook-secret", payload, signature), true);
  const first = await controller.handle({
    event: "workflow_run",
    deliveryId: "abcd1234-abcd-1234-abcd-1234567890ab",
    signature,
    rawBody: payload,
    traceparent: upstreamTraceparent,
  });
  const duplicate = await controller.handle({
    event: "workflow_run",
    deliveryId: "abcd1234-abcd-1234-abcd-1234567890ab",
    signature,
    rawBody: payload,
    traceparent: upstreamTraceparent,
  });
  assert.equal(first.queuedJobId, duplicate.queuedJobId);
  assert.equal((await queue.list()).length, 1);
  assert.equal(((await queue.list())[0]?.payload as any).pullRequestNumber, 7);
  assert.equal(((await queue.list())[0]?.payload as any).pullRequestNodeId, "PR_node");
  assert.equal(((await queue.list())[0]?.payload as any).installationId, 42);
  await assert.rejects(
    () =>
      controller.handle({
        event: "workflow_run",
        deliveryId: "badbadbad",
        signature: "sha256=00",
        rawBody: payload,
      }),
    /authentication failed/,
  );

  const worker = createGitHubRepairWorker({
    id: "repair-1",
    queue,
    delivery,
    telemetry,
    repair: async () => ({
      summary: "tests passed after repair",
      pullRequestNodeId: "PR_node",
      enqueueWhenSuccessful: true,
    }),
  });
  assert.equal(await worker.runOnce(), true);
  assert.equal((await queue.list())[0]?.status, "succeeded");
  assert.ok(calls.some((call) => call.path.endsWith("/check-runs") && call.method === "POST"));
  assert.ok(calls.some((call) => call.path === "/graphql"));
  assert.ok(telemetry.spans.some((span) => span.name === "anicode.github.webhook"));
  assert.ok(telemetry.spans.some((span) => span.name === "anicode.worker.execute"));
  const webhookSpan = telemetry.spans.find((span) => span.name === "anicode.github.webhook")!;
  const workerSpan = telemetry.spans.find((span) => span.name === "anicode.worker.execute")!;
  const deliverySpans = telemetry.spans.filter((span) => span.name === "anicode.github.request");
  assert.equal(webhookSpan.traceId, "a".repeat(32));
  assert.equal(webhookSpan.parentSpanId, "b".repeat(16));
  assert.equal(workerSpan.traceId, webhookSpan.traceId);
  assert.equal(workerSpan.parentSpanId, webhookSpan.spanId);
  assert.ok(deliverySpans.length >= 3);
  assert.ok(
    deliverySpans.every(
      (span) => span.traceId === workerSpan.traceId && span.parentSpanId === workerSpan.spanId,
    ),
  );
});

test("SLSA provenance: subject、source digest 与 invocation 可追溯", () => {
  const statement = buildSlsaProvenance({
    artifactName: "dist/anicode.tgz",
    sha256: "b".repeat(64),
    sourceUri: "https://github.com/owner/repo",
    sourceDigest: "a".repeat(40),
    workflowRef: ".github/workflows/release.yml@refs/heads/main",
    invocationId: "https://github.com/owner/repo/actions/runs/1/attempts/1",
  });
  assert.equal(statement["predicateType"], "https://slsa.dev/provenance/v1");
  assert.match(JSON.stringify(statement), /dist\/anicode\.tgz/);
  assert.match(JSON.stringify(statement), new RegExp("a{40}"));
});
