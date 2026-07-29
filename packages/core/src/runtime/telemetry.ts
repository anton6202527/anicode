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
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  batchSize?: number;
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
}

function nanoTime(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function otlpValue(value: TelemetryAttribute): Record<string, unknown> {
  if (Array.isArray(value)) return { arrayValue: { values: value.map((item) => otlpValue(item)) } };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

function otlpAttributes(attributes: Record<string, TelemetryAttribute>) {
  return Object.entries(attributes).map(([key, value]) => ({ key, value: otlpValue(value) }));
}

/** OTLP/HTTP JSON exporter；无 SDK 依赖，适合 CLI/daemon 直接接 Collector。 */
export class OtlpHttpTelemetry implements Telemetry {
  private readonly endpoint: string;
  private readonly serviceName: string;
  private readonly headers: Record<string, string>;
  private readonly doFetch: typeof fetch;
  private readonly batchSize: number;
  private pending: OtlpPendingSpan[] = [];
  private flushing: Promise<void> | null = null;

  constructor(options: OtlpHttpTelemetryOptions) {
    this.endpoint = options.endpoint.replace(/\/$/, "").endsWith("/v1/traces")
      ? options.endpoint.replace(/\/$/, "")
      : `${options.endpoint.replace(/\/$/, "")}/v1/traces`;
    this.serviceName = options.serviceName ?? "anicode";
    this.headers = options.headers ?? {};
    this.doFetch = options.fetch ?? fetch;
    this.batchSize = Math.max(1, options.batchSize ?? 32);
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
        if (status.message) record.attributes["otel.status_description"] = status.message;
        return span;
      },
      context: () => ({ traceId: record.traceId, spanId: record.spanId, traceFlags: 1 }),
      end: () => {
        if (record.endTimeUnixNano !== "0") return;
        record.endTimeUnixNano = nanoTime();
        this.pending.push(record);
        if (this.pending.length >= this.batchSize) void this.forceFlush();
      },
    };
    return span;
  }

  forceFlush(): Promise<void> {
    if (this.flushing) return this.flushing;
    const batch = this.pending.splice(0);
    if (batch.length === 0) return Promise.resolve();
    this.flushing = this.doFetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: this.serviceName } }],
            },
            scopeSpans: [
              {
                scope: { name: "@anicode/core" },
                spans: batch.map((span) => ({
                  traceId: span.traceId,
                  spanId: span.spanId,
                  ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
                  name: span.name,
                  kind: 1,
                  startTimeUnixNano: span.startTimeUnixNano,
                  endTimeUnixNano: span.endTimeUnixNano,
                  attributes: otlpAttributes(span.attributes),
                  events: span.events.map((event) => ({
                    name: event.name,
                    timeUnixNano: event.timeUnixNano,
                    attributes: otlpAttributes(event.attributes ?? {}),
                  })),
                  status: { code: span.status === "ok" ? 1 : span.status === "error" ? 2 : 0 },
                })),
              },
            ],
          },
        ],
      }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`OTLP exporter HTTP ${response.status}`);
      })
      .catch(() => {
        // 遥测不能拖垮 agent；失败批次留给宿主指标/collector 侧告警。
      })
      .finally(() => {
        this.flushing = null;
        if (this.pending.length >= this.batchSize) void this.forceFlush();
      });
    return this.flushing;
  }
}

export interface TelemetryFromEnvOptions {
  /** 生产宿主传入 NetworkProxy.fetch，避免 exporter 绕过受控出口。 */
  fetch?: typeof fetch;
  broker?: CredentialBroker;
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
      const value = options.broker!.trustedValue(credentialId, {
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
    headers,
    fetch: doFetch,
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
