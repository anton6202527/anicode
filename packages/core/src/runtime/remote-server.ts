/** Remote Runtime 控制面：认证 HTTP API + durable queue + 每任务隔离 ExecutionRuntime。 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import type { Telemetry } from "./telemetry.js";
import { noTelemetry, parseTraceparent } from "./telemetry.js";
import type { ExecutionRuntime, IsolatedRunResult } from "./isolated-runtime.js";
import { DurableWorkerQueue, type WorkerJob } from "./worker.js";

export interface RemoteExecutionRequest {
  command: string;
  workspaceId: string;
  cwd?: string;
  policy: "read-only" | "workspace-write";
  network: boolean;
  timeoutMs?: number;
  idempotencyKey: string;
  traceparent?: string;
}

export interface RemoteExecutionView {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  result?: IsolatedRunResult;
  error?: string;
  attempts: number;
  fencingToken?: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemoteRuntimeServerOptions {
  queue: DurableWorkerQueue;
  executionRuntime: ExecutionRuntime;
  workspaceRoot: string;
  authenticate: (request: IncomingMessage) => Promise<{ actor: string }>;
  telemetry?: Telemetry;
  maxBodyBytes?: number;
  leaseMs?: number;
  workerId?: string;
}

function validId(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

function safeWorkspace(root: string, workspaceId: string, cwd = "."): string {
  const workspace = path.resolve(root, validId(workspaceId, "workspace id"));
  const resolved = path.resolve(workspace, cwd);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error("Remote cwd escapes workspace");
  }
  return resolved;
}

function toView(job: WorkerJob<RemoteExecutionRequest, IsolatedRunResult>): RemoteExecutionView {
  const status =
    job.status === "leased" ? "running" : job.status === "succeeded" ? "succeeded" : job.status;
  return {
    id: job.id,
    status,
    ...(job.result ? { result: job.result } : {}),
    ...(job.error ? { error: job.error } : {}),
    attempts: job.attempts,
    ...(job.fencingToken !== undefined ? { fencingToken: job.fencingToken } : {}),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export class RemoteExecutionService {
  private readonly telemetry: Telemetry;
  private readonly workerId: string;
  private readonly leaseMs: number;
  constructor(private readonly options: RemoteRuntimeServerOptions) {
    this.telemetry = options.telemetry ?? noTelemetry;
    this.workerId = options.workerId ?? `remote-${process.pid}`;
    this.leaseMs = Math.max(5_000, options.leaseMs ?? 60_000);
  }

  async submit(request: RemoteExecutionRequest): Promise<RemoteExecutionView> {
    validId(request.workspaceId, "workspace id");
    if (!request.command.trim()) throw new Error("Remote command cannot be empty");
    if (!request.idempotencyKey || request.idempotencyKey.length > 256) {
      throw new Error("Invalid remote idempotency key");
    }
    safeWorkspace(this.options.workspaceRoot, request.workspaceId, request.cwd);
    const job = await this.options.queue.enqueue("remote-execution", request, {
      idempotencyKey: request.idempotencyKey,
      maxAttempts: 3,
    });
    return toView(job as WorkerJob<RemoteExecutionRequest, IsolatedRunResult>);
  }

  async get(id: string): Promise<RemoteExecutionView | undefined> {
    validId(id, "execution id");
    const job = (await this.options.queue.list()).find((candidate) => candidate.id === id);
    return job ? toView(job as WorkerJob<RemoteExecutionRequest, IsolatedRunResult>) : undefined;
  }

  cancel(id: string): Promise<boolean> {
    validId(id, "execution id");
    return this.options.queue.cancel(id);
  }

  async runOnce(signal = new AbortController().signal): Promise<boolean> {
    const job = (await this.options.queue.claim(
      this.workerId,
      ["remote-execution"],
      this.leaseMs,
    )) as WorkerJob<RemoteExecutionRequest, IsolatedRunResult> | undefined;
    if (!job) return false;
    const span = this.telemetry.startSpan(
      "anicode.remote.execution",
      {
        "anicode.remote.execution.id": job.id,
        "anicode.remote.workspace.id": job.payload.workspaceId,
        "anicode.worker.fencing_token": job.fencingToken ?? 0,
        "anicode.remote.network": job.payload.network,
      },
      parseTraceparent(job.payload.traceparent),
    );
    const context = span.context();
    const heartbeat = setInterval(
      () =>
        void this.options.queue
          .heartbeat(job.id, this.workerId, this.leaseMs, job.fencingToken)
          .catch(() => undefined),
      Math.max(1_000, Math.floor(this.leaseMs / 3)),
    );
    try {
      const result = await this.options.executionRuntime.run({
        command: job.payload.command,
        cwd: safeWorkspace(this.options.workspaceRoot, job.payload.workspaceId, job.payload.cwd),
        policy: job.payload.policy,
        network: job.payload.network,
        ...(job.payload.timeoutMs ? { timeoutMs: job.payload.timeoutMs } : {}),
        ...(context ? { traceContext: context } : {}),
        signal,
      });
      await this.options.queue.finish(job.id, this.workerId, result, job.fencingToken);
      span
        .setAttribute("process.exit.code", result.exitCode ?? -1)
        .setAttribute("anicode.remote.duration_ms", result.durationMs)
        .setStatus({ code: result.exitCode === 0 ? "ok" : "error" });
    } catch (error) {
      await this.options.queue.fail(
        job.id,
        this.workerId,
        error instanceof Error ? error.message : String(error),
        true,
        job.fencingToken,
      );
      span.recordException(error).setStatus({ code: "error" });
    } finally {
      clearInterval(heartbeat);
      span.end();
    }
    return true;
  }

  async run(options: { signal?: AbortSignal; pollMs?: number } = {}): Promise<void> {
    while (!options.signal?.aborted) {
      if (!(await this.runOnce(options.signal))) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(25, options.pollMs ?? 250)));
      }
    }
  }
}

export class RemoteRuntimeHttpServer {
  readonly service: RemoteExecutionService;
  private server: Server | undefined;
  constructor(private readonly options: RemoteRuntimeServerOptions) {
    this.service = new RemoteExecutionService(options);
  }

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    if (this.server) throw new Error("Remote Runtime server is already listening");
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        const status = /auth/i.test(error instanceof Error ? error.message : "") ? 401 : 400;
        jsonResponse(response, status, {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Remote Runtime bind failed");
    return `http://${host}:${address.port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://remote-runtime.local");
    if (request.method === "GET" && url.pathname === "/healthz") {
      jsonResponse(response, 200, { ok: true });
      return;
    }
    await this.options.authenticate(request);
    if (request.method === "POST" && url.pathname === "/v1/executions") {
      const body = await readJson<RemoteExecutionRequest>(
        request,
        this.options.maxBodyBytes ?? 256 * 1024,
      );
      jsonResponse(response, 202, await this.service.submit(body));
      return;
    }
    const matched = /^\/v1\/executions\/([^/]+)$/.exec(url.pathname);
    if (matched && request.method === "GET") {
      const execution = await this.service.get(decodeURIComponent(matched[1]!));
      jsonResponse(response, execution ? 200 : 404, execution ?? { error: "not found" });
      return;
    }
    if (matched && request.method === "DELETE") {
      const cancelled = await this.service.cancel(decodeURIComponent(matched[1]!));
      jsonResponse(response, cancelled ? 202 : 409, { cancelled });
      return;
    }
    jsonResponse(response, 404, { error: "not found" });
  }
}

async function readJson<T>(request: IncomingMessage, limit: number): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.byteLength;
    if (size > limit) throw new Error(`request exceeds ${limit} bytes`);
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
