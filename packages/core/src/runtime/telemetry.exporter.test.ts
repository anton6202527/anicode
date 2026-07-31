import assert from "node:assert/strict";
import { test } from "node:test";
import { CredentialBroker } from "../security/credentials.js";
import { OtlpHttpTelemetry, telemetryFromEnv } from "./telemetry.js";

test("OTLP exporter emits protobuf-JSON bytes, resource fields, status and retries transient errors", async () => {
  let attempts = 0;
  let payload: Record<string, unknown> | undefined;
  const errors: string[] = [];
  const telemetry = new OtlpHttpTelemetry({
    endpoint: "https://collector.example/base",
    serviceName: "anicode-test",
    resourceAttributes: { "deployment.environment.name": "test" },
    batchSize: 10,
    flushIntervalMs: 60_000,
    retryBaseMs: 1,
    maxExportAttempts: 3,
    onExportError: (error) => {
      errors.push(error.message);
    },
    fetch: (async (input, init) => {
      attempts++;
      assert.equal(String(input), "https://collector.example/base/v1/traces");
      payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(null, { status: attempts < 3 ? 503 : 200 });
    }) as typeof fetch,
  });
  const traceId = "11".repeat(16);
  const parentSpanId = "22".repeat(8);
  telemetry
    .startSpan(
      "worker.execute",
      { attempt: 2, api_token: "must-not-leak" },
      { traceId, spanId: parentSpanId, traceFlags: 1 },
    )
    .recordException(new Error("workspace /private/project contained must-not-export"))
    .setStatus({ code: "error", message: "verification failed" })
    .end();
  await telemetry.forceFlush();
  assert.equal(attempts, 3);
  assert.deepEqual(errors, []);
  assert.deepEqual(telemetry.stats(), {
    pendingSpans: 0,
    exportedSpans: 1,
    droppedSpans: 0,
    failedExports: 0,
  });

  const resourceSpans = payload?.["resourceSpans"] as Array<Record<string, unknown>>;
  const resource = resourceSpans[0]?.["resource"] as Record<string, unknown>;
  assert.match(JSON.stringify(resource), /anicode-test/);
  assert.match(JSON.stringify(resource), /deployment.environment.name/);
  assert.equal(JSON.stringify(payload).includes("must-not-leak"), false);
  assert.equal(JSON.stringify(payload).includes("[REDACTED]"), true);
  const scopeSpans = resourceSpans[0]?.["scopeSpans"] as Array<Record<string, unknown>>;
  const spans = scopeSpans[0]?.["spans"] as Array<Record<string, unknown>>;
  assert.equal(spans[0]?.["traceId"], Buffer.from(traceId, "hex").toString("base64"));
  assert.equal(spans[0]?.["parentSpanId"], Buffer.from(parentSpanId, "hex").toString("base64"));
  const serialized = JSON.stringify(spans[0]);
  assert.equal(serialized.includes("/private/project"), false);
  assert.equal(serialized.includes("verification failed"), false);
  assert.match(String((spans[0]?.["status"] as Record<string, unknown>)["message"]), /^error:/);
  await telemetry.shutdown();
});

test("OTLP exporter preserves failed batches, exposes health stats, then recovers", async () => {
  let healthy = false;
  const errors: string[] = [];
  const telemetry = new OtlpHttpTelemetry({
    endpoint: "https://collector.example",
    batchSize: 10,
    flushIntervalMs: 60_000,
    retryBaseMs: 1,
    maxExportAttempts: 2,
    onExportError: (error) => {
      errors.push(error.message);
    },
    fetch: (async () => new Response(null, { status: healthy ? 200 : 429 })) as typeof fetch,
  });
  telemetry.startSpan("durable.command").end();
  await assert.rejects(() => telemetry.forceFlush(), /HTTP 429/);
  assert.equal(telemetry.stats().pendingSpans, 1);
  assert.equal(telemetry.stats().failedExports, 1);
  assert.deepEqual(errors, ["OTLP exporter HTTP 429"]);
  healthy = true;
  await telemetry.forceFlush();
  assert.equal(telemetry.stats().pendingSpans, 0);
  assert.equal(telemetry.stats().exportedSpans, 1);
  await telemetry.shutdown();
});

test("OTLP exporter periodically flushes and resolves async Broker credentials at send time", async () => {
  let secret = "first-token";
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "otel-async",
    backend: {
      kind: "test",
      get: async () => secret,
      put: async (_key: string, value: string) => {
        secret = value;
      },
      delete: async () => true,
    },
    scopes: [{ audiences: ["telemetry:otlp"], hosts: ["collector.example"] }],
  });
  const authorizations: string[] = [];
  let resolveExport: (() => void) | undefined;
  const exported = new Promise<void>((resolve) => {
    resolveExport = resolve;
  });
  const telemetry = telemetryFromEnv(
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "10",
      OTEL_BSP_SCHEDULE_DELAY: "10",
      ANICODE_OTEL_CREDENTIAL_ID: "otel-async",
    },
    {
      broker,
      fetch: (async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
        resolveExport?.();
        return new Response(null, { status: 200 });
      }) as typeof fetch,
    },
  );
  telemetry.startSpan("scheduled").end();
  await Promise.race([
    exported,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("periodic OTLP flush timed out")), 1_000),
    ),
  ]);
  assert.deepEqual(authorizations, ["Bearer first-token"]);
  await telemetry.shutdown?.();
});
