import { randomBytes } from "node:crypto";
import { context as otelContext, trace as otelTrace, TraceFlags } from "@opentelemetry/api";
import type { CredentialBroker } from "../security/credentials.js";

/**
 * OpenTelemetry bridge：只依赖 OTel API 的结构类型，宿主可注入真实 Tracer；
 * core 不强绑 SDK/exporter，未配置时保持零开销 no-op。
 */

export type TelemetryAttribute = string | number | boolean | string[] | number[] | boolean[];

export interface SpanContext {
  traceId: string;
  spanId: string;
  traceFlags?: number;
}

export interface TelemetrySpan {
  setAttribute(name: string, value: TelemetryAttribute): this;
  addEvent(name: string, attributes?: Record<string, TelemetryAttribute>): this;
  recordException(error: unknown): this;
  setStatus(status: { code: "unset" | "ok" | "error"; message?: string }): this;
  context(): SpanContext | undefined;
  end(): void;
}

export interface Telemetry {
  startSpan(
    name: string,
    attributes?: Record<string, TelemetryAttribute>,
    parent?: SpanContext,
  ): TelemetrySpan;
  /** Exporter 可选的进程退出门；no-op/in-memory 实现无需提供。 */
  forceFlush?(): Promise<void>;
  shutdown?(): Promise<void>;
}

const NOOP_SPAN: TelemetrySpan = {
  setAttribute: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  recordException: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  context: () => undefined,
  end: () => {},
};

export const noTelemetry: Telemetry = { startSpan: () => NOOP_SPAN };

/** @opentelemetry/api Tracer/Span 的最小结构子集。 */
export interface OpenTelemetryTracerLike {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, unknown> },
    context?: unknown,
  ): {
    setAttribute(name: string, value: unknown): unknown;
    addEvent(name: string, attributes?: Record<string, unknown>): unknown;
    recordException(error: unknown): unknown;
    setStatus(status: { code: number; message?: string }): unknown;
    spanContext(): { traceId: string; spanId: string; traceFlags?: number };
    end(): void;
  };
}

/** 将真实 OTel tracer 接到 core 的窄接口；状态码遵循 OTel UNSET=0/OK=1/ERROR=2。 */
export function fromOpenTelemetry(tracer: OpenTelemetryTracerLike): Telemetry {
  return {
    startSpan(name, attributes, parent) {
      const parentContext = parent
        ? otelTrace.setSpanContext(otelContext.active(), {
            traceId: parent.traceId,
            spanId: parent.spanId,
            traceFlags: parent.traceFlags ?? TraceFlags.SAMPLED,
            isRemote: true,
          })
        : undefined;
      const span = tracer.startSpan(name, attributes ? { attributes } : undefined, parentContext);
      const bridge: TelemetrySpan = {
        setAttribute(key, value) {
          span.setAttribute(key, value);
          return bridge;
        },
        addEvent(eventName, eventAttributes) {
          span.addEvent(eventName, eventAttributes);
          return bridge;
        },
        recordException(error) {
          span.recordException(error);
          return bridge;
        },
        setStatus(status) {
          span.setStatus({
            code: status.code === "ok" ? 1 : status.code === "error" ? 2 : 0,
            ...(status.message ? { message: status.message } : {}),
          });
          return bridge;
        },
        context: () => span.spanContext(),
        end: () => span.end(),
      };
      return bridge;
    },
  };
}

export interface RecordedSpan {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Record<string, TelemetryAttribute>;
  events: { name: string; attributes?: Record<string, TelemetryAttribute> }[];
  status: "unset" | "ok" | "error";
  ended: boolean;
}

/** 离线测试/本地诊断用 exporter。 */
export class InMemoryTelemetry implements Telemetry {
  readonly spans: RecordedSpan[] = [];

  startSpan(
    name: string,
    attributes: Record<string, TelemetryAttribute> = {},
    parent?: SpanContext,
  ): TelemetrySpan {
    const record: RecordedSpan = {
      name,
      traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      attributes: { ...attributes },
      events: [],
      status: "unset",
      ended: false,
    };
    this.spans.push(record);
    const span: TelemetrySpan = {
      setAttribute(key, value) {
        record.attributes[key] = value;
        return span;
      },
      addEvent(eventName, eventAttributes) {
        record.events.push({
          name: eventName,
          ...(eventAttributes ? { attributes: eventAttributes } : {}),
        });
        return span;
      },
      recordException(error) {
        record.events.push({
          name: "exception",
          attributes: {
            "exception.message": error instanceof Error ? error.message : String(error),
          },
        });
        return span;
      },
      setStatus(status) {
        record.status = status.code;
        if (status.message) record.attributes["otel.status_description"] = status.message;
        return span;
      },
      context: () => ({
        traceId: record.traceId,
        spanId: record.spanId,
        traceFlags: parent?.traceFlags ?? 1,
      }),
      end() {
        record.ended = true;
      },
    };
    return span;
  }
}

export interface OtlpHttpTelemetryOptions {
  endpoint: string;
  serviceName?: string;
  resourceAttributes?: Record<string, TelemetryAttribute>;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  batchSize?: number;
  maxQueueSize?: number;
  flushIntervalMs?: number;
  exportTimeoutMs?: number;
  maxExportAttempts?: number;
  retryBaseMs?: number;
  redact?: (value: string) => string;
  onExportError?: (error: Error, stats: TelemetryExporterStats) => void | Promise<void>;
}

export interface TelemetryExporterStats {
  pendingSpans: number;
  exportedSpans: number;
  droppedSpans: number;
  failedExports: number;
  lastError?: string;
}

interface OtlpPendingSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, TelemetryAttribute>;
  events: { name: string; timeUnixNano: string; attributes?: Record<string, TelemetryAttribute> }[];
  status: "unset" | "ok" | "error";
  statusMessage?: string;
  traceFlags: number;
}

function nanoTime(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function otlpValue(
  value: TelemetryAttribute,
  redact: (value: string) => string,
): Record<string, unknown> {
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => otlpValue(item, redact)) } };
  }
  if (typeof value === "string") return { stringValue: redact(value) };
  if (typeof value === "boolean") return { boolValue: value };
  if (!Number.isFinite(value)) return { stringValue: String(value) };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function otlpAttributes(
  attributes: Record<string, TelemetryAttribute>,
  redact: (value: string) => string = (value) => value,
) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: /(?:authorization|cookie|password|secret|token|api[-_.]?key|credential)/i.test(key)
      ? { stringValue: "[REDACTED]" }
      : otlpValue(value, redact),
  }));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}`);
  return value;
}

function otlpBytes(hex: string, bytes: number, label: string): string {
  if (!new RegExp(`^[a-f0-9]{${bytes * 2}}$`, "i").test(hex) || /^0+$/.test(hex)) {
    throw new Error(`Invalid ${label}`);
  }
  return Buffer.from(hex, "hex").toString("base64");
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** OTLP/HTTP JSON exporter；无 SDK 依赖，适合 CLI/daemon 直接接 Collector。 */
export class OtlpHttpTelemetry implements Telemetry {
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly resourceAttributes: Record<string, TelemetryAttribute>;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;
  private readonly batchSize: number;
  private readonly maxQueueSize: number;
  private readonly exportTimeoutMs: number;
  private readonly maxExportAttempts: number;
  private readonly retryBaseMs: number;
  private readonly redact: (value: string) => string;
  private readonly onExportError?: OtlpHttpTelemetryOptions["onExportError"];
  private readonly flushTimer: NodeJS.Timeout;
  private pending: OtlpPendingSpan[] = [];
  private flushing: Promise<void> | null = null;
  private closed = false;
  private exportedSpans = 0;
  private droppedSpans = 0;
  private failedExports = 0;
  private lastError?: string;

  constructor(options: OtlpHttpTelemetryOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
      throw new Error("OTLP endpoint must use http or https");
    }
    const pathname = endpoint.pathname.replace(/\/$/, "");
    endpoint.pathname = pathname.endsWith("/v1/traces") ? pathname : `${pathname}/v1/traces`;
    this.endpoint = endpoint.toString();
    this.serviceName = options.serviceName ?? "anicode";
    this.resourceAttributes = { ...(options.resourceAttributes ?? {}) };
    this.headers = options.headers ?? {};
    this.doFetch = options.fetch ?? fetch;
    this.batchSize = positiveInteger(options.batchSize ?? 32, "OTLP batch size");
    this.maxQueueSize = positiveInteger(options.maxQueueSize ?? 2_048, "OTLP queue size");
    if (this.batchSize > 10_000 || this.maxQueueSize > 100_000) {
      throw new Error("OTLP batch/queue size exceeds the safety limit");
    }
    if (this.batchSize > this.maxQueueSize) {
      throw new Error("OTLP batch size cannot exceed queue size");
    }
    this.exportTimeoutMs = positiveInteger(
      options.exportTimeoutMs ?? 10_000,
      "OTLP export timeout",
    );
    this.maxExportAttempts = positiveInteger(
      options.maxExportAttempts ?? 3,
      "OTLP export attempts",
    );
    if (this.maxExportAttempts > 10) throw new Error("OTLP export attempts cannot exceed 10");
    this.retryBaseMs = positiveInteger(options.retryBaseMs ?? 250, "OTLP retry delay");
    if (this.retryBaseMs > 30_000) throw new Error("OTLP retry delay cannot exceed 30000ms");
    this.redact = options.redact ?? ((value) => value);
    if (options.onExportError) this.onExportError = options.onExportError;
    const flushIntervalMs = positiveInteger(
      options.flushIntervalMs ?? 5_000,
      "OTLP flush interval",
    );
    this.flushTimer = setInterval(() => {
      void this.forceFlush().catch(() => undefined);
    }, flushIntervalMs);
    this.flushTimer.unref();
  }

  stats(): TelemetryExporterStats {
    return {
      pendingSpans: this.pending.length,
      exportedSpans: this.exportedSpans,
      droppedSpans: this.droppedSpans,
      failedExports: this.failedExports,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  startSpan(
    name: string,
    attributes: Record<string, TelemetryAttribute> = {},
    parent?: SpanContext,
  ): TelemetrySpan {
    const record: OtlpPendingSpan = {
      traceId: parent?.traceId ?? randomBytes(16).toString("hex"),
      spanId: randomBytes(8).toString("hex"),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      startTimeUnixNano: nanoTime(),
      endTimeUnixNano: "0",
      attributes: { ...attributes },
      events: [],
      status: "unset",
      traceFlags: parent?.traceFlags ?? 1,
    };
    const span: TelemetrySpan = {
      setAttribute(key, value) {
        record.attributes[key] = value;
        return span;
      },
      addEvent(eventName, eventAttributes) {
        record.events.push({
          name: eventName,
          timeUnixNano: nanoTime(),
          ...(eventAttributes ? { attributes: eventAttributes } : {}),
        });
        return span;
      },
      recordException(error) {
        record.events.push({
          name: "exception",
          timeUnixNano: nanoTime(),
          attributes: {
            "exception.message": error instanceof Error ? error.message : String(error),
          },
        });
        return span;
      },
      setStatus(status) {
        record.status = status.code;
        if (status.message) record.statusMessage = status.message;
        return span;
      },
      context: () => ({ traceId: record.traceId, spanId: record.spanId, traceFlags: 1 }),
      end: () => {
        if (record.endTimeUnixNano !== "0") return;
        record.endTimeUnixNano = nanoTime();
        if (this.closed) {
          this.droppedSpans++;
          this.reportError(new Error("OTLP exporter is shut down"));
          return;
        }
        this.pending.push(record);
        if (this.pending.length > this.maxQueueSize) {
          this.pending.splice(0, this.pending.length - this.maxQueueSize);
          this.droppedSpans++;
          this.reportError(new Error("OTLP span queue overflow"));
        }
        if (this.pending.length >= this.batchSize) {
          void this.forceFlush().catch(() => undefined);
        }
      },
    };
    return span;
  }

  forceFlush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.pending.length === 0) return Promise.resolve();
    this.flushing = this.flushPending().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  async shutdown(): Promise<void> {
    if (this.closed) {
      if (this.flushing) await this.flushing;
      return;
    }
    this.closed = true;
    clearInterval(this.flushTimer);
    await this.forceFlush();
  }

  private async flushPending(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.batchSize);
      try {
        await this.exportBatch(batch);
        this.exportedSpans += batch.length;
      } catch (error) {
        // Preserve the failed batch for the next periodic/explicit attempt. Queue bounds still apply.
        this.pending.unshift(...batch);
        if (this.pending.length > this.maxQueueSize) {
          const overflow = this.pending.length - this.maxQueueSize;
          this.pending.splice(this.maxQueueSize, overflow);
          this.droppedSpans += overflow;
        }
        const failure = errorOf(error);
        this.failedExports++;
        this.reportError(failure);
        throw failure;
      }
    }
  }

  private async exportBatch(batch: OtlpPendingSpan[]): Promise<void> {
    const body = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: otlpAttributes(
              {
                ...this.resourceAttributes,
                "service.name": this.serviceName,
              },
              this.redact,
            ),
          },
          scopeSpans: [
            {
              scope: { name: "@anicode/core" },
              spans: batch.map((span) => ({
                traceId: otlpBytes(span.traceId, 16, "trace id"),
                spanId: otlpBytes(span.spanId, 8, "span id"),
                ...(span.parentSpanId
                  ? { parentSpanId: otlpBytes(span.parentSpanId, 8, "parent span id") }
                  : {}),
                flags: span.traceFlags,
                name: span.name,
                kind: 1,
                startTimeUnixNano: span.startTimeUnixNano,
                endTimeUnixNano: span.endTimeUnixNano,
                attributes: otlpAttributes(span.attributes, this.redact),
                events: span.events.map((event) => ({
                  name: event.name,
                  timeUnixNano: event.timeUnixNano,
                  attributes: otlpAttributes(event.attributes ?? {}, this.redact),
                })),
                status: {
                  code: span.status === "ok" ? 1 : span.status === "error" ? 2 : 0,
                  ...(span.statusMessage ? { message: span.statusMessage } : {}),
                },
              })),
            },
          ],
        },
      ],
    });
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= this.maxExportAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.exportTimeoutMs);
      let retryable = true;
      try {
        const response = await this.doFetch(this.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...this.headers },
          body,
          signal: controller.signal,
        });
        if (response.ok) return;
        retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        lastError = new Error(`OTLP exporter HTTP ${response.status}`);
      } catch (error) {
        lastError = errorOf(error);
      } finally {
        clearTimeout(timer);
      }
      if (!retryable) break;
      if (attempt < this.maxExportAttempts) {
        await wait(Math.min(30_000, this.retryBaseMs * 2 ** (attempt - 1)));
      }
    }
    throw lastError ?? new Error("OTLP export failed");
  }

  private reportError(error: Error): void {
    this.lastError = error.message;
    void Promise.resolve(this.onExportError?.(error, this.stats())).catch(() => undefined);
  }
}

export interface TelemetryFromEnvOptions {
  /** 生产宿主传入 NetworkProxy.fetch，避免 exporter 绕过受控出口。 */
  fetch?: typeof fetch;
  broker?: CredentialBroker;
  onExportError?: OtlpHttpTelemetryOptions["onExportError"];
}

function parseEnvironmentAttributes(value: string | undefined): Record<string, TelemetryAttribute> {
  if (!value) return {};
  return Object.fromEntries(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const cut = entry.indexOf("=");
        if (cut <= 0) throw new Error(`Invalid OTEL_RESOURCE_ATTRIBUTES entry: ${entry}`);
        return [decodeURIComponent(entry.slice(0, cut)), decodeURIComponent(entry.slice(cut + 1))];
      }),
  );
}

function environmentInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return positiveInteger(parsed, name);
}

export function telemetryFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: TelemetryFromEnvOptions = {},
): Telemetry {
  const endpoint = env["OTEL_EXPORTER_OTLP_TRACES_ENDPOINT"] ?? env["OTEL_EXPORTER_OTLP_ENDPOINT"];
  if (!endpoint) return noTelemetry;
  const rawHeaders = env["OTEL_EXPORTER_OTLP_HEADERS"] ?? "";
  const headers = Object.fromEntries(
    rawHeaders
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const cut = entry.indexOf("=");
        return cut < 0
          ? [decodeURIComponent(entry), ""]
          : [decodeURIComponent(entry.slice(0, cut)), decodeURIComponent(entry.slice(cut + 1))];
      }),
  );
  const sensitiveStaticHeader = Object.keys(headers).find((name) =>
    /(?:authorization|api[-_]?key|token|secret|cookie)/i.test(name),
  );
  if (sensitiveStaticHeader) {
    throw new Error(
      `Sensitive OTLP header ${sensitiveStaticHeader} must use ANICODE_OTEL_CREDENTIAL_ID`,
    );
  }
  const credentialId = env["ANICODE_OTEL_CREDENTIAL_ID"]?.trim();
  if (credentialId && !options.broker) {
    throw new Error("ANICODE_OTEL_CREDENTIAL_ID requires Credential Broker");
  }
  const doFetch: typeof fetch = async (input, init) => {
    const requestHeaders = new Headers(init?.headers);
    if (credentialId) {
      const target = new URL(input instanceof Request ? input.url : String(input));
      const header = (env["ANICODE_OTEL_CREDENTIAL_HEADER"] ?? "authorization").toLowerCase();
      if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) {
        throw new Error("Invalid ANICODE_OTEL_CREDENTIAL_HEADER");
      }
      const value = await options.broker!.trustedValueAsync(credentialId, {
        audience: "telemetry:otlp",
        host: target.hostname,
      });
      const scheme = env["ANICODE_OTEL_CREDENTIAL_SCHEME"] ?? "Bearer";
      requestHeaders.set(header, scheme.toLowerCase() === "none" ? value : `${scheme} ${value}`);
    }
    return (options.fetch ?? fetch)(input, { ...init, headers: requestHeaders });
  };
  return new OtlpHttpTelemetry({
    endpoint,
    serviceName: env["OTEL_SERVICE_NAME"] ?? "anicode",
    resourceAttributes: parseEnvironmentAttributes(env["OTEL_RESOURCE_ATTRIBUTES"]),
    headers,
    fetch: doFetch,
    batchSize: environmentInteger(env, "OTEL_BSP_MAX_EXPORT_BATCH_SIZE", 32),
    maxQueueSize: environmentInteger(env, "OTEL_BSP_MAX_QUEUE_SIZE", 2_048),
    flushIntervalMs: environmentInteger(env, "OTEL_BSP_SCHEDULE_DELAY", 5_000),
    exportTimeoutMs: environmentInteger(env, "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT", 10_000),
    maxExportAttempts: environmentInteger(env, "ANICODE_OTEL_MAX_EXPORT_ATTEMPTS", 3),
    retryBaseMs: environmentInteger(env, "ANICODE_OTEL_RETRY_BASE_MS", 250),
    ...(options.broker ? { redact: (value: string) => options.broker!.redact(value) } : {}),
    ...(options.onExportError ? { onExportError: options.onExportError } : {}),
  });
}

/** W3C trace-context 注入；跨 HTTP/MCP/worker 传递时可直接复用。 */
export function traceparent(context: SpanContext): string {
  const flags = (context.traceFlags ?? 1).toString(16).padStart(2, "0");
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

/** 严格解析 W3C traceparent；非法/全零 id 一律丢弃，避免污染 trace 图。 */
export function parseTraceparent(value: string | undefined): SpanContext | undefined {
  if (!value) return undefined;
  const matched = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})(?:-|$)/i.exec(
    value.trim(),
  );
  if (!matched || matched[1] === "ff") return undefined;
  const traceId = matched[2]!.toLowerCase();
  const spanId = matched[3]!.toLowerCase();
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId, traceFlags: Number.parseInt(matched[4]!, 16) };
}
