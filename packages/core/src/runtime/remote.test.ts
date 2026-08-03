import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialBroker } from "../security/credentials.js";
import { GitHubDelivery } from "./github-delivery.js";
import { NetworkProxy } from "./network-proxy.js";
import { RemoteRuntime } from "./remote.js";
import { InMemoryTelemetry, parseTraceparent } from "./telemetry.js";

test("RemoteRuntime: 经受控代理鉴权、幂等提交并轮询完成", async () => {
  const seen: {
    url: string;
    method: string;
    auth: string | null;
    traceparent: string | null;
    bodyTraceparent?: string;
  }[] = [];
  let polls = 0;
  const broker = new CredentialBroker();
  broker.register({
    id: "remote",
    value: "Bearer remote-secret",
    scopes: [
      { audiences: ["remote-runtime"], hosts: ["runtime.example"], header: "authorization" },
    ],
  });
  const proxy = new NetworkProxy({
    broker,
    resolver: async () => ["93.184.216.34"],
    fetch: async (target, init) => {
      const url = String(target);
      const headers = new Headers(init?.headers);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      seen.push({
        url,
        method: String(init?.method),
        auth: headers.get("authorization"),
        traceparent: headers.get("traceparent"),
        ...(typeof body.traceparent === "string" ? { bodyTraceparent: body.traceparent } : {}),
      });
      if (url.endsWith("/v1/executions") && init?.method === "POST")
        return Response.json({ id: "run-1", status: "queued" });
      polls++;
      return Response.json(
        polls === 1
          ? { id: "run-1", status: "running" }
          : {
              id: "run-1",
              status: "succeeded",
              result: {
                exitCode: 0,
                output: "ok",
                timedOut: false,
                sandboxed: true,
                durationMs: 5,
              },
            },
      );
    },
  });
  const telemetry = new InMemoryTelemetry();
  const runtime = new RemoteRuntime({
    endpoint: "https://runtime.example",
    proxy,
    broker,
    credentialId: "remote",
    pollMs: 1,
    telemetry,
  });
  const upstream = { traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1 };
  const result = await runtime.run({
    command: "npm test",
    cwd: "/workspace",
    traceContext: upstream,
  });
  assert.equal(result.output, "ok");
  assert.ok(seen.every((request) => request.auth === "Bearer remote-secret"));
  const clientSpan = telemetry.spans.find((span) => span.name === "anicode.remote.client")!;
  const propagated = parseTraceparent(seen[0]?.bodyTraceparent);
  assert.equal(clientSpan.traceId, upstream.traceId);
  assert.equal(clientSpan.parentSpanId, upstream.spanId);
  assert.equal(propagated?.traceId, clientSpan.traceId);
  assert.equal(propagated?.spanId, clientSpan.spanId);
  assert.ok(
    seen.every(
      (request) => parseTraceparent(request.traceparent ?? undefined)?.spanId === clientSpan.spanId,
    ),
  );
});

test("GitHubDelivery: branch/files/draft PR/workflow 构成闭环", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const broker = new CredentialBroker();
  broker.register({
    id: "github",
    value: "Bearer gh-secret",
    scopes: [
      { audiences: ["github-delivery"], hosts: ["api.github.test"], header: "authorization" },
    ],
  });
  const proxy = new NetworkProxy({
    broker,
    resolver: async () => ["93.184.216.34"],
    fetch: async (target, init) => {
      const path = new URL(String(target)).pathname;
      calls.push({
        path,
        method: String(init?.method),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (path.endsWith("/git/ref/heads/agent%2Fchange")) {
        return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
      }
      if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: "abc" } });
      if (path.endsWith("/git/commits/abc")) return Response.json({ tree: { sha: "base-tree" } });
      if (path.endsWith("/git/blobs")) return Response.json({ sha: "blob-1" });
      if (path.endsWith("/git/trees")) return Response.json({ sha: "tree-1" });
      if (path.endsWith("/git/commits") && init?.method === "POST") {
        return Response.json({ sha: "commit-1" });
      }
      if (path.endsWith("/pulls") && init?.method === "GET") return Response.json([]);
      if (path.endsWith("/pulls")) return Response.json({ number: 7, html_url: "https://pr/7" });
      if (path.endsWith("/dispatches")) return new Response(null, { status: 204 });
      return Response.json({ ok: true });
    },
  });
  const delivery = new GitHubDelivery({
    owner: "o",
    repo: "r",
    apiBase: "https://api.github.test",
    proxy,
    broker,
    credentialId: "github",
  });
  const result = await delivery.deliver({
    base: "main",
    branch: "agent/change",
    title: "Agent delivery",
    files: [{ path: "src/a.ts", content: "export {}" }],
    workflow: "agent-runtime.yml",
  });
  assert.equal(result.pullRequestNumber, 7);
  assert.equal(result.commitSha, "commit-1");
  assert.equal(result.workflowDispatched, true);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["GET", "GET", "GET", "POST", "POST", "POST", "POST", "GET", "POST", "POST"],
  );
  assert.equal((calls[8]!.body as { draft: boolean }).draft, true);
  assert.ok(!calls.some((call) => call.method === "PUT"));
  assert.deepEqual((calls[4]!.body as { base_tree: string }).base_tree, "base-tree");
});
