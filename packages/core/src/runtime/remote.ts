/** 远程隔离执行客户端：幂等提交、轮询、取消、Credential Broker 注入。 */

import { createHash, randomUUID } from "node:crypto";
import type { CredentialBroker } from "../security/credentials.js";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
} from "./isolated-runtime.js";
import type { NetworkProxy } from "./network-proxy.js";
import { noTelemetry, traceparent, type SpanContext, type Telemetry } from "./telemetry.js";

export interface RemoteRuntimeOptions {
  endpoint: string;
  proxy: NetworkProxy;
  broker?: CredentialBroker;
  credentialId?: string;
  pollMs?: number;
  maxPollMs?: number;
  workspaceId?: string;
  remoteCwd?: string;
  telemetry?: Telemetry;
}

interface RemoteExecution {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result?: IsolatedRunResult;
  error?: string;
}

export class RemoteRuntime implements ExecutionRuntime {
  private readonly endpoint: string;
  private readonly telemetry: Telemetry;

  constructor(private readonly options: RemoteRuntimeOptions) {
    this.endpoint = options.endpoint.replace(/\/+$/, "");
    this.telemetry = options.telemetry ?? noTelemetry;
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
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
    const idempotencyKey = createHash("sha256")
      .update(
        `${request.cwd}\0${request.command}\0${request.policy ?? ""}\0${request.network ?? false}`,
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
      throw error;
    }
    const deadline = Date.now() + Math.max(1_000, this.options.maxPollMs ?? 10 * 60_000);
    let execution = created;
    const abort = () =>
      void this.call(
        "DELETE",
        `/v1/executions/${encodeURIComponent(created.id)}`,
        undefined,
        context,
      ).catch(() => undefined);
    request.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (["queued", "running"].includes(execution.status)) {
        if (request.signal?.aborted) throw new Error("Remote execution cancelled");
        if (Date.now() >= deadline) {
          await this.call(
            "DELETE",
            `/v1/executions/${encodeURIComponent(created.id)}`,
            undefined,
            context,
          ).catch(() => undefined);
          throw new Error("Remote execution polling timed out");
        }
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(25, this.options.pollMs ?? 250)),
        );
        execution = await this.call(
          "GET",
          `/v1/executions/${encodeURIComponent(created.id)}`,
          undefined,
          context,
        );
      }
      if (execution.status !== "succeeded" || !execution.result)
        throw new Error(execution.error ?? `Remote execution ${execution.status}`);
      span.setAttribute("anicode.remote.execution.id", execution.id).setStatus({ code: "ok" });
      return execution.result;
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" });
      throw error;
    } finally {
      request.signal?.removeEventListener("abort", abort);
      span.end();
    }
  }

  private async call<T>(
    method: string,
    suffix: string,
    body?: unknown,
    context?: SpanContext,
  ): Promise<T> {
    const target = new URL(`${this.endpoint}${suffix}`);
    const headers = new Headers({
      "content-type": "application/json",
      "x-request-id": randomUUID(),
      ...(context ? { traceparent: traceparent(context) } : {}),
    });
    let credentialLease: string | undefined;
    if (this.options.credentialId) {
      if (!this.options.broker) throw new Error("Remote Runtime credential requires a broker");
      credentialLease = this.options.broker.lease({
        credentialId: this.options.credentialId,
        audience: "remote-runtime",
        host: target.hostname,
        ttlMs: 30_000,
      });
    }
    const response = await this.options.proxy.fetch(target, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(credentialLease ? { credentialLease } : {}),
    });
    if (!response.ok)
      throw new Error(`Remote Runtime HTTP ${response.status}: ${await response.text()}`);
    return (await response.json()) as T;
  }
}
