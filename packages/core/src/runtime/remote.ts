/** 远程隔离执行客户端：幂等提交、轮询、取消、Credential Broker 注入。 */

import { createHash, randomUUID } from "node:crypto";
import type { CredentialBroker } from "../security/credentials.js";
import {
  RuntimeTerminationError,
  type ExecutionRuntime,
  type IsolatedRunRequest,
  type IsolatedRunResult,
} from "./isolated-runtime.js";
import type { NetworkProxy } from "./network-proxy.js";
import { noTelemetry, traceparent, type SpanContext, type Telemetry } from "./telemetry.js";

export interface RemoteRuntimeOptions {
  endpoint: string;
  proxy: NetworkProxy;
  broker?: CredentialBroker;
  credentialId?: string;
  /** Per-control-plane request deadline. It does not change the remote job timeout. */
  requestTimeoutMs?: number;
  /** Retries for transient control-plane failures. Submission is safe because it is idempotent. */
  maxRequestRetries?: number;
  /** Maximum decoded JSON bytes accepted from the control plane. */
  maxResponseBytes?: number;
  pollMs?: number;
  maxPollMs?: number;
  /** Maximum time to request cancellation and prove the remote workload reached a terminal state. */
  terminationTimeoutMs?: number;
  workspaceId?: string;
  remoteCwd?: string;
  telemetry?: Telemetry;
}

interface RemoteExecution {
  id: string;
  status: "queued" | "running" | "cancellation_requested" | "succeeded" | "failed" | "cancelled";
  outcome?: "known" | "indeterminate";
  result?: IsolatedRunResult;
  error?: string;
}

export class RemoteRuntime implements ExecutionRuntime {
  readonly toolModuleEnvironment = "unsupported" as const;
  private readonly endpoint: string;
  private readonly telemetry: Telemetry;
  private readonly requestTimeoutMs: number;
  private readonly maxRequestRetries: number;
  private readonly maxResponseBytes: number;
  private readonly terminationTimeoutMs: number;

  constructor(private readonly options: RemoteRuntimeOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.telemetry = options.telemetry ?? noTelemetry;
    this.requestTimeoutMs = boundedInteger(options.requestTimeoutMs, 30_000, 250, 5 * 60_000);
    this.maxRequestRetries = boundedInteger(options.maxRequestRetries, 2, 0, 5);
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes,
      4 * 1024 * 1024,
      1_024,
      64 * 1024 * 1024,
    );
    this.terminationTimeoutMs = boundedInteger(
      options.terminationTimeoutMs,
      30_000,
      1_000,
      5 * 60_000,
    );
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    if (request.stdin !== undefined) {
      throw new Error("Remote execution does not support stdin payloads");
    }
    const span = this.telemetry.startSpan(
      "anicode.remote.client",
      {
        "anicode.remote.endpoint": this.endpoint,
        "anicode.remote.workspace.id": this.options.workspaceId ?? "default",
        "anicode.remote.network": request.network ?? false,
      },
      request.traceContext,
    );
    const context = span.context();
    request.signal?.throwIfAborted();
    const runIdentity = request.workload?.executionId
      ? `${request.workload.tenantId ?? "default"}\0${request.workload.executionId}`
      : randomUUID();
    const idempotencyKey = createHash("sha256")
      .update(
        `${runIdentity}\0${request.cwd}\0${request.command}\0${request.policy ?? ""}\0${request.network ?? false}`,
      )
      .digest("hex");
    let created: RemoteExecution;
    try {
      created = await this.call<RemoteExecution>(
        "POST",
        "/v1/executions",
        {
          command: request.command,
          workspaceId: this.options.workspaceId ?? "default",
          cwd: this.options.remoteCwd ?? ".",
          policy: request.policy ?? "workspace-write",
          network: request.network ?? false,
          timeoutMs: request.timeoutMs,
          idempotencyKey,
          ...(context ? { traceparent: traceparent(context) } : {}),
        },
        context,
      );
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" }).end();
      if (submissionMayHaveCommitted(error)) throw new RuntimeTerminationError();
      throw error;
    }
    const deadline = Date.now() + Math.max(1_000, this.options.maxPollMs ?? 10 * 60_000);
    let execution = created;
    try {
      while (["queued", "running", "cancellation_requested"].includes(execution.status)) {
        if (request.signal?.aborted) {
          await this.cancelAndProve(created.id, context);
          throw abortError(request.signal);
        }
        if (Date.now() >= deadline) {
          await this.cancelAndProve(created.id, context);
          throw new Error("Remote execution polling timed out");
        }
        try {
          await abortableDelay(Math.max(25, this.options.pollMs ?? 250), request.signal);
          execution = await this.call(
            "GET",
            `/v1/executions/${encodeURIComponent(created.id)}`,
            undefined,
            context,
            request.signal,
            Math.max(1, deadline - Date.now()),
          );
        } catch (error) {
          if (!request.signal?.aborted) throw error;
          await this.cancelAndProve(created.id, context);
          throw abortError(request.signal);
        }
      }
      if (execution.outcome === "indeterminate") {
        throw new RuntimeTerminationError();
      }
      if (execution.status !== "succeeded" || !execution.result)
        throw new Error(execution.error ?? `Remote execution ${execution.status}`);
      span.setAttribute("anicode.remote.execution.id", execution.id).setStatus({ code: "ok" });
      return execution.result;
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" });
      throw error;
    } finally {
      span.end();
    }
  }

  private async cancelAndProve(id: string, context?: SpanContext): Promise<void> {
    const deadline = Date.now() + this.terminationTimeoutMs;
    await this.call(
      "DELETE",
      `/v1/executions/${encodeURIComponent(id)}`,
      undefined,
      context,
      undefined,
      Math.max(1, deadline - Date.now()),
    ).catch(() => undefined);
    while (Date.now() < deadline) {
      let execution: RemoteExecution | undefined;
      try {
        execution = await this.call<RemoteExecution>(
          "GET",
          `/v1/executions/${encodeURIComponent(id)}`,
          undefined,
          context,
          undefined,
          Math.max(1, deadline - Date.now()),
        );
      } catch {
        await abortableDelay(Math.min(250, Math.max(1, deadline - Date.now())));
        continue;
      }
      if (execution.outcome === "indeterminate") throw new RuntimeTerminationError();
      if (!["queued", "running", "cancellation_requested"].includes(execution.status)) {
        if (execution.status === "failed" && execution.outcome !== "known") {
          throw new RuntimeTerminationError();
        }
        return;
      }
      await abortableDelay(
        Math.min(Math.max(25, this.options.pollMs ?? 250), Math.max(1, deadline - Date.now())),
      );
    }
    throw new RuntimeTerminationError();
  }

  private async call<T>(
    method: string,
    suffix: string,
    body?: unknown,
    context?: SpanContext,
    signal?: AbortSignal,
    timeoutOverrideMs?: number,
  ): Promise<T> {
    const target = new URL(`${this.endpoint}${suffix}`);
    const requestId = randomUUID();
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRequestRetries; attempt++) {
      if (signal?.aborted) throw abortError(signal);
      const controller = new AbortController();
      const onAbort = () => controller.abort(abortError(signal!));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = Math.min(
        this.requestTimeoutMs,
        Math.max(1, timeoutOverrideMs ?? this.requestTimeoutMs),
      );
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`Remote Runtime request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        const headers = new Headers({
          "content-type": "application/json",
          "x-request-id": requestId,
          ...(context ? { traceparent: traceparent(context) } : {}),
        });
        let credentialLease: string | undefined;
        if (this.options.credentialId) {
          if (!this.options.broker) throw new Error("Remote Runtime credential requires a broker");
          credentialLease = this.options.broker.lease({
            credentialId: this.options.credentialId,
            audience: "remote-runtime",
            host: target.hostname,
            ttlMs: Math.min(60_000, Math.max(1_000, timeoutMs)),
            maxUses: 1,
          });
        }
        const pending = this.options.proxy.fetch(target, {
          method,
          headers,
          ...(encodedBody !== undefined ? { body: encodedBody } : {}),
          ...(credentialLease ? { credentialLease } : {}),
          signal: controller.signal,
        });
        const response = await withAbort(pending, controller.signal);
        if (!response.ok) {
          if (attempt < this.maxRequestRetries && transientStatus(response.status)) {
            const delayMs = retryDelayMs(response, attempt);
            await response.body
              ?.cancel("retrying transient Remote Runtime response")
              .catch(() => undefined);
            await abortableDelay(delayMs, signal);
            continue;
          }
          const detail = await readBoundedText(
            response,
            Math.min(this.maxResponseBytes, 64 * 1024),
            controller.signal,
          );
          throw remoteHttpError(response.status, detail);
        }
        return (await readBoundedJson(response, this.maxResponseBytes, controller.signal)) as T;
      } catch (error) {
        lastError = timedOut
          ? new Error(`Remote Runtime request timed out after ${timeoutMs}ms`, { cause: error })
          : error;
        if (
          signal?.aborted ||
          attempt >= this.maxRequestRetries ||
          !transientNetworkError(lastError)
        ) {
          throw signal?.aborted ? abortError(signal) : lastError;
        }
        await abortableDelay(retryDelayMs(undefined, attempt), signal);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    }
    throw lastError;
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(value!)));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Remote execution cancelled");
}

function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(abortError(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      void pending.catch(() => undefined);
      reject(abortError(signal));
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function transientStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function submissionMayHaveCommitted(error: unknown): boolean {
  const status = Number((error as { status?: unknown })?.status);
  return !Number.isInteger(status) || transientStatus(status);
}

function transientNetworkError(error: unknown): boolean {
  const status = Number((error as { status?: unknown })?.status);
  if (Number.isInteger(status)) return transientStatus(status);
  const code = String((error as { code?: unknown })?.code ?? "");
  const message = String((error as { message?: unknown })?.message ?? error);
  if (
    /^(?:EAI_AGAIN|ENOTFOUND|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY|SOCKET)_TIMEOUT)$/i.test(
      code,
    ) ||
    /fetch failed|network|socket hang up|connection (?:closed|error)|timed? ?out|timeout/i.test(
      message,
    )
  ) {
    return true;
  }
  const cause = (error as { cause?: unknown })?.cause;
  return cause !== undefined && cause !== error ? transientNetworkError(cause) : false;
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const raw = response?.headers.get("retry-after");
  if (raw) {
    const seconds = Number(raw);
    const parsed = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(raw) - Date.now();
    if (Number.isFinite(parsed) && parsed >= 0) return Math.min(5_000, Math.round(parsed));
  }
  const base = Math.min(2_000, 100 * 2 ** attempt);
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(resolve), Math.max(0, ms));
    const onAbort = () => finish(() => reject(abortError(signal!)));
    const finish = (settle: () => void) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function remoteHttpError(status: number, detail: string): Error {
  return Object.assign(new Error(`Remote Runtime HTTP ${status}${detail ? `: ${detail}` : ""}`), {
    status,
  });
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<unknown> {
  const text = await readBoundedText(response, maximumBytes, signal);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error("Remote Runtime returned invalid JSON", { cause: error });
  }
}

async function readBoundedText(
  response: Response,
  maximumBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel("Remote Runtime response is too large").catch(() => undefined);
    throw new Error(`Remote Runtime response exceeds ${maximumBytes} bytes`);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await (signal ? withAbort(reader.read(), signal) : reader.read());
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel("Remote Runtime response is too large").catch(() => undefined);
        throw new Error(`Remote Runtime response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
