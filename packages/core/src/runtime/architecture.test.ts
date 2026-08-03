import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { FileArtifactStore } from "./artifacts.js";
import { DurableRuntime, FileRuntimeEventStore } from "./durable.js";
import { ContextCompiler } from "./context-compiler.js";
import { TaskScheduler } from "./scheduler.js";
import { Verifier } from "./verifier.js";
import {
  InMemoryTelemetry,
  OtlpHttpTelemetry,
  parseTraceparent,
  telemetryFromEnv,
  traceparent,
} from "./telemetry.js";
import { canonicalizeIpAddress, NetworkProxy, isPrivateAddress } from "./network-proxy.js";
import { IsolatedRuntime } from "./isolated-runtime.js";
import { CapabilityAuthority, SecurityPolicyEngine } from "../security/policy.js";
import { CredentialBroker } from "../security/credentials.js";
import { Agent } from "../agent.js";
import { ToolRegistry, type Tool } from "../tools/tool.js";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
import type { ChatMessage, Provider, StreamEvent } from "../types.js";

test("runtime: artifact 内容寻址、持久化与 session 隔离", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-artifacts-"));
  try {
    const store = new FileArtifactStore(dir);
    const a = await store.put({
      sessionId: "s_one",
      kind: "report",
      name: "report.txt",
      mediaType: "text/plain",
      data: "hello",
    });
    const duplicate = await store.put({
      sessionId: "s_one",
      kind: "report",
      name: "duplicate.txt",
      data: "hello",
    });
    assert.equal(duplicate.id, a.id);
    assert.equal((await store.list("s_one")).length, 1);
    assert.equal(Buffer.from((await store.get("s_one", a.id))!.data).toString(), "hello");
    assert.equal(await store.get("s_two", a.id), undefined);
    const sameContentOtherSession = await store.put({
      sessionId: "s_two",
      kind: "report",
      name: "same.txt",
      data: "hello",
    });
    const firstPayload = path.join(
      dir,
      "sessions",
      "s_one",
      "blobs",
      a.sha256.slice(0, 2),
      a.sha256,
    );
    const secondPayload = path.join(
      dir,
      "sessions",
      "s_two",
      "blobs",
      a.sha256.slice(0, 2),
      a.sha256,
    );
    await fs.access(firstPayload);
    await fs.access(secondPayload);
    assert.equal(await store.delete("s_one", a.id), true);
    await assert.rejects(fs.access(firstPayload));
    assert.equal(
      Buffer.from((await store.get("s_two", sameContentOtherSession.id))!.data).toString(),
      "hello",
    );
    await fs.access(secondPayload);

    const legacy = await store.put({
      sessionId: "s_legacy",
      kind: "log",
      name: "legacy.txt",
      data: "old layout",
    });
    const scopedLegacyPayload = path.join(
      dir,
      "sessions",
      "s_legacy",
      "blobs",
      legacy.sha256.slice(0, 2),
      legacy.sha256,
    );
    const globalLegacyPayload = path.join(dir, "blobs", legacy.sha256.slice(0, 2), legacy.sha256);
    await fs.mkdir(path.dirname(globalLegacyPayload), { recursive: true });
    await fs.rename(scopedLegacyPayload, globalLegacyPayload);
    assert.equal(
      Buffer.from((await store.get("s_legacy", legacy.id))!.data).toString(),
      "old layout",
    );
    assert.equal(await store.delete("s_legacy", legacy.id), true);
    await fs.access(globalLegacyPayload);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runtime: FileArtifactStore deleteSession removes its namespace and retains shared v1 blobs", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-artifact-purge-"));
  try {
    const store = new FileArtifactStore(dir);
    await store.put({
      sessionId: "purge_me",
      kind: "report",
      name: "normal.txt",
      data: "normal secret",
    });
    const purgeRoot = path.join(dir, "sessions", "purge_me");
    await fs.writeFile(path.join(purgeRoot, "corrupt.json"), "{broken", "utf8");
    await fs.mkdir(path.join(purgeRoot, "orphan"), { recursive: true });
    await fs.writeFile(path.join(purgeRoot, "orphan", "payload"), "orphan secret", "utf8");

    await store.deleteSession("purge_me");
    await assert.rejects(fs.access(purgeRoot));
    assert.deepEqual(await store.list("purge_me"), []);
    await assert.rejects(() => store.deleteSession("../escape"), /Invalid session id/);

    const first = await store.put({
      sessionId: "legacy_first",
      kind: "report",
      name: "shared.txt",
      data: "legacy shared secret",
    });
    await store.put({
      sessionId: "legacy_second",
      kind: "report",
      name: "shared.txt",
      data: "legacy shared secret",
    });
    const firstScoped = path.join(
      dir,
      "sessions",
      "legacy_first",
      "blobs",
      first.sha256.slice(0, 2),
      first.sha256,
    );
    const secondScoped = path.join(
      dir,
      "sessions",
      "legacy_second",
      "blobs",
      first.sha256.slice(0, 2),
      first.sha256,
    );
    const global = path.join(dir, "blobs", first.sha256.slice(0, 2), first.sha256);
    await fs.mkdir(path.dirname(global), { recursive: true });
    await fs.rename(firstScoped, global);
    await fs.rm(secondScoped);

    await store.deleteSession("legacy_first");
    await fs.access(global);
    await store.deleteSession("legacy_second");
    await fs.access(global);

    const outside = path.join(dir, "outside");
    await fs.mkdir(outside);
    const link = path.join(dir, "sessions", "linked_session");
    await fs.symlink(outside, link, "dir");
    await fs.writeFile(path.join(outside, "canary"), "keep", "utf8");
    await store.deleteSession("linked_session");
    await fs.access(path.join(outside, "canary"));
    await assert.rejects(fs.lstat(link));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runtime: durable event sequence、幂等与恢复投影", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-runtime-"));
  try {
    const runtime = new DurableRuntime(new FileRuntimeEventStore(dir));
    const first = await runtime.record({
      streamId: "s_demo",
      type: "prompt.accepted",
      data: {},
      idempotencyKey: "prompt-1",
    });
    const same = await runtime.record({
      streamId: "s_demo",
      type: "prompt.accepted",
      data: {},
      idempotencyKey: "prompt-1",
    });
    assert.equal(same.id, first.id);
    await runtime.record({
      streamId: "s_demo",
      type: "session.state",
      data: { running: true },
      expectedSequence: 1,
    });
    await runtime.record({
      streamId: "s_demo",
      type: "tool.started",
      data: { id: "call_1" },
    });
    const state = await runtime.recover("s_demo");
    assert.equal(state.phase, "running");
    assert.deepEqual(state.activeTools, ["call_1"]);
    assert.equal(state.sequence, 3);
    await assert.rejects(() =>
      runtime.record({
        streamId: "s_demo",
        type: "bad",
        data: {},
        expectedSequence: 1,
      }),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("runtime: context compiler 按预算、必选、相关性与去重编译", () => {
  const compiler = new ContextCompiler({ tokenBudget: 256, charsPerToken: 1, now: () => 0 });
  const compiled = compiler.compile({
    query: "scheduler bug",
    sources: [
      { id: "memory", kind: "memory", content: "required rules", required: true, priority: 100 },
      { id: "relevant", kind: "retrieval", content: "scheduler bug fix details", priority: 20 },
      { id: "duplicate", kind: "memory", content: "required rules", priority: 99 },
      { id: "noise", kind: "retrieval", content: "x".repeat(300), priority: 1 },
    ],
  });
  assert.ok(compiled.text.includes("required rules"));
  assert.ok(compiled.selected.some((source) => source.id === "relevant"));
  assert.ok(
    compiled.dropped.some((source) => source.id === "duplicate" && source.reason === "duplicate"),
  );
  assert.ok(compiled.estimatedTokens <= 256);
});

test("runtime: scheduler 尊重依赖与写资源互斥", async () => {
  const order: string[] = [];
  let activeWriters = 0;
  let maxWriters = 0;
  const scheduler = new TaskScheduler({ concurrency: 3 });
  const result = await scheduler.run([
    {
      id: "a",
      resources: [{ key: "workspace", mode: "write" }],
      async run() {
        activeWriters++;
        maxWriters = Math.max(maxWriters, activeWriters);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeWriters--;
        order.push("a");
        return 1;
      },
    },
    {
      id: "b",
      resources: [{ key: "workspace", mode: "write" }],
      async run() {
        activeWriters++;
        maxWriters = Math.max(maxWriters, activeWriters);
        activeWriters--;
        order.push("b");
        return 2;
      },
    },
    {
      id: "c",
      dependencies: ["a", "b"],
      async run() {
        order.push("c");
        return 3;
      },
    },
  ]);
  assert.equal(result.ok, true);
  assert.equal(maxWriters, 1);
  assert.equal(order.at(-1), "c");
});

test("runtime: verifier 并行执行并以 required check 作为完成门槛", async () => {
  const verifier = new Verifier({
    policy: {
      checks: [
        { id: "pass", command: process.execPath, args: ["-e", "process.exit(0)"] },
        { id: "fail", command: process.execPath, args: ["-e", "process.exit(3)"], required: true },
      ],
    },
  });
  const report = await verifier.verify({ cwd: process.cwd() });
  assert.equal(report.status, "failed");
  assert.equal(report.checks.find((check) => check.id === "fail")?.exitCode, 3);
});

test("security: deny 优先、capability 绑定 audience/scope/resource", () => {
  const policy = new SecurityPolicyEngine({
    rules: [
      { id: "allow", effect: "allow", actions: ["tool:*"], resources: ["*"] },
      { id: "deny", effect: "deny", actions: ["tool:bash"], resources: ["rm *"] },
    ],
  });
  assert.equal(
    policy.authorize({ principal: "agent", action: "tool:bash", resource: "rm file" }).effect,
    "deny",
  );
  const authority = new CapabilityAuthority(randomBytes(32));
  const token = authority.issue({
    audience: "runtime",
    subject: "agent",
    scopes: ["tool:read"],
    resources: ["workspace/*"],
  });
  assert.equal(
    authority.verify(token, {
      audience: "runtime",
      subject: "agent",
      scope: "tool:read",
      resource: "workspace/a.ts",
    }).sub,
    "agent",
  );
  assert.throws(() =>
    authority.verify(token, {
      audience: "proxy",
      scope: "tool:read",
      resource: "workspace/a.ts",
    }),
  );
});

test("security: credential lease 限域、限次且日志脱敏", () => {
  const broker = new CredentialBroker();
  broker.register({
    id: "github",
    value: "secret-value-1234",
    scopes: [{ audiences: ["network"], hosts: ["api.github.com"], header: "authorization" }],
  });
  const lease = broker.lease({
    credentialId: "github",
    audience: "network",
    host: "api.github.com",
  });
  assert.equal(broker.injectHeaders(lease).get("authorization"), "secret-value-1234");
  assert.throws(() => broker.injectHeaders(lease));
  assert.equal(broker.redact("token=secret-value-1234"), "token=[REDACTED]");
});

test("security: shell 不继承宿主密钥，credential 文件命中硬拒绝", () => {
  const previous = process.env["ANICODE_TEST_API_KEY"];
  process.env["ANICODE_TEST_API_KEY"] = "must-not-reach-shell";
  try {
    assert.equal(sanitizedShellEnv()["ANICODE_TEST_API_KEY"], undefined);
  } finally {
    if (previous === undefined) delete process.env["ANICODE_TEST_API_KEY"];
    else process.env["ANICODE_TEST_API_KEY"] = previous;
  }
  assert.equal(
    SecurityPolicyEngine.workspaceBoundary().authorize({
      principal: "agent",
      action: "tool:read",
      resource: "packages/app/.env.production",
    }).effect,
    "deny",
  );
  assert.equal(
    SecurityPolicyEngine.workspaceBoundary().authorize({
      principal: "agent",
      action: "tool:write",
      resource: ".anicode-debug.txt",
    }).effect,
    "allow",
    "相似文件名不能被误判为 runtime 目录",
  );
  assert.equal(
    SecurityPolicyEngine.workspaceBoundary().authorize({
      principal: "agent",
      action: "tool:write",
      resource: "nested/.git/config",
    }).effect,
    "deny",
  );
});

test("network proxy: 默认阻断私网/回环，允许显式公网域", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  for (const reserved of [
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.2",
    "203.0.113.3",
    "100::1",
    "2001:db8::1",
    "3fff::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::127.0.0.1",
  ]) {
    assert.equal(isPrivateAddress(reserved), true, `${reserved} must not reach the public network`);
  }
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  assert.equal(isPrivateAddress("::ffff:808:808"), false);
  assert.equal(canonicalizeIpAddress("::ffff:127.0.0.1"), canonicalizeIpAddress("::ffff:7f00:1"));
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["example.com"] },
    resolver: async () => ["93.184.216.34"],
  });
  assert.equal((await proxy.authorize("https://example.com/a")).url.hostname, "example.com");
  const blocked = new NetworkProxy({ resolver: async () => ["127.0.0.1"] });
  await assert.rejects(() => blocked.authorize("http://localhost"), /private/);
});

test("network proxy: fetch 固定授权 IP，避免二次 DNS/rebinding", async () => {
  const server = createServer((_request, response) => response.end("pinned"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const proxy = new NetworkProxy({
    policy: {
      allowDomains: ["unresolvable.anicode.test"],
      allowPorts: [address.port],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  try {
    const response = await proxy.fetch(`http://unresolvable.anicode.test:${address.port}/`);
    assert.equal(await response.text(), "pinned");
  } finally {
    await proxy.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("isolated runtime: policy none 仍受超时/输出边界管理", async () => {
  const runtime = new IsolatedRuntime({ failClosed: true });
  const result = await runtime.run({
    command: "printf runtime-ok",
    cwd: process.cwd(),
    policy: "none",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, "runtime-ok");
  assert.equal(result.sandboxed, false);
});

test("isolated runtime: 申请联网但没有强制代理时 fail-close", () => {
  const runtime = new IsolatedRuntime({ failClosed: true, requireProxy: true });
  assert.throws(
    () => runtime.prepare({ command: "true", cwd: process.cwd(), policy: "none", network: true }),
    /requires the configured AniCode proxy/,
  );
});

test("telemetry: 内存 span 与 OTLP/HTTP JSON exporter", async () => {
  const memory = new InMemoryTelemetry();
  memory.startSpan("agent").setAttribute("turns", 1).setStatus({ code: "ok" }).end();
  assert.equal(memory.spans[0]?.ended, true);
  assert.equal(traceparent({ traceId: "a".repeat(32), spanId: "b".repeat(16) }).length, 55);
  const parent = parseTraceparent(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`)!;
  const child = memory.startSpan("child", {}, parent);
  child.end();
  assert.equal(memory.spans[1]?.traceId, "a".repeat(32));
  assert.equal(memory.spans[1]?.parentSpanId, "b".repeat(16));
  assert.equal(parseTraceparent(`00-${"0".repeat(32)}-${"b".repeat(16)}-01`), undefined);

  let body = "";
  const otlp = new OtlpHttpTelemetry({
    endpoint: "http://collector:4318",
    batchSize: 1,
    fetch: (async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(null, { status: 200 });
    }) as typeof fetch,
  });
  otlp.startSpan("model").setStatus({ code: "ok" }).end();
  await otlp.forceFlush();
  assert.ok(body.includes("resourceSpans"));
  assert.ok(body.includes("model"));
});

test("telemetry: 静态敏感 header fail-close，Broker 引用按域注入且不进 payload", async () => {
  assert.throws(
    () =>
      telemetryFromEnv({
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
        OTEL_EXPORTER_OTLP_HEADERS: "Authorization=should-not-live-in-env",
      }),
    /must use ANICODE_OTEL_CREDENTIAL_ID/,
  );

  const broker = new CredentialBroker();
  broker.register({
    id: "otel",
    value: "collector-secret",
    scopes: [{ audiences: ["telemetry:otlp"], hosts: ["collector.example"] }],
  });
  let sentHeaders = new Headers();
  let sentBody = "";
  const telemetry = telemetryFromEnv(
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
      ANICODE_OTEL_CREDENTIAL_ID: "otel",
    },
    {
      broker,
      fetch: (async (_input, init) => {
        sentHeaders = new Headers(init?.headers);
        sentBody = String(init?.body ?? "");
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    },
  );
  telemetry.startSpan("secured-export").end();
  await telemetry.forceFlush?.();
  assert.equal(sentHeaders.get("authorization"), "Bearer collector-secret");
  assert.equal(sentBody.includes("collector-secret"), false);
});

test("agent 主路径: Security Policy → tool → Verifier → OpenTelemetry", async () => {
  let turn = 0;
  const scripts: ChatMessage[] = [
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "edit_1", name: "change", args: { path: "a.ts" } }],
    },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const provider: Provider = {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const message = scripts[turn++]!;
      yield {
        type: "done",
        stopReason: message.content.some((part) => part.type === "tool_call")
          ? "tool_use"
          : "end_turn",
        message,
        usage: { inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  let ran = 0;
  const change: Tool = {
    readOnly: false,
    mutatesFiles: true,
    def: { name: "change", description: "change", parameters: { type: "object" } },
    ruleKey: (input) => String(input["path"] ?? ""),
    async run() {
      ran++;
      return "changed";
    },
  };
  const telemetry = new InMemoryTelemetry();
  const agent = new Agent({
    provider,
    model: "scripted",
    cwd: process.cwd(),
    tools: new ToolRegistry().register(change),
    permission: { mode: "bypass" },
    projectMemory: false,
    injectEnv: false,
    telemetry,
    securityPolicy: new SecurityPolicyEngine(),
    verifier: new Verifier({
      policy: {
        checks: [{ id: "pass", command: process.execPath, args: ["-e", "process.exit(0)"] }],
      },
    }),
  });
  const events = [];
  for await (const event of agent.send("change it")) events.push(event);
  assert.equal(ran, 1);
  assert.ok(
    events.some((event) => event.type === "verification" && event.report.status === "passed"),
  );
  assert.ok(events.some((event) => event.type === "done"));
  assert.ok(telemetry.spans.some((span) => span.name === "anicode.model.stream"));
  assert.ok(telemetry.spans.some((span) => span.name === "anicode.tool.execute"));
  assert.ok(telemetry.spans.every((span) => span.ended));
});
