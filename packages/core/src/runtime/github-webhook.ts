/** GitHub App webhook 控制面：签名、去重、Check Run、修复队列与 merge queue。 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CredentialBroker } from "../security/credentials.js";
import {
  noTelemetry,
  parseTraceparent,
  traceparent,
  type SpanContext,
  type Telemetry,
} from "./telemetry.js";
import { DurableWorkerQueue, PersistentWorker, type WorkerJob } from "./worker.js";
import { GitHubDelivery, type GitHubCheckRun } from "./github-delivery.js";

export interface GitHubRepairJob {
  deliveryId: string;
  event: string;
  action: string;
  repository: string;
  headSha: string;
  pullRequestNumber?: number;
  pullRequestNodeId?: string;
  failedUrl?: string;
  traceparent?: string;
}

export interface GitHubWebhookControllerOptions {
  broker: CredentialBroker;
  webhookSecretCredentialId: string;
  queue: DurableWorkerQueue;
  delivery: GitHubDelivery;
  telemetry?: Telemetry;
  maxRepairAttempts?: number;
}

export interface GitHubWebhookResult {
  accepted: boolean;
  duplicate?: boolean;
  queuedJobId?: string;
  checkRun?: GitHubCheckRun;
}

export function verifyGitHubWebhookSignature(
  secret: string,
  rawBody: Uint8Array,
  signature: string | undefined,
): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`,
    "utf8",
  );
  const actual = Buffer.from(signature, "utf8");
  return expected.byteLength === actual.byteLength && timingSafeEqual(expected, actual);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function firstObject(value: unknown): Record<string, unknown> {
  return Array.isArray(value) && value.length > 0 ? object(value[0]) : {};
}

export class GitHubWebhookController {
  private readonly telemetry: Telemetry;
  constructor(private readonly options: GitHubWebhookControllerOptions) {
    this.telemetry = options.telemetry ?? noTelemetry;
  }

  async handle(input: {
    event: string;
    deliveryId: string;
    signature?: string;
    rawBody: Uint8Array;
    traceparent?: string;
  }): Promise<GitHubWebhookResult> {
    if (!/^[0-9a-f-]{8,128}$/i.test(input.deliveryId))
      throw new Error("Invalid GitHub delivery id");
    const secret = this.options.broker.trustedValue(this.options.webhookSecretCredentialId, {
      audience: "github-webhook",
      tool: "verify-signature",
    });
    if (!verifyGitHubWebhookSignature(secret, input.rawBody, input.signature)) {
      throw new Error("GitHub webhook authentication failed");
    }
    const payload = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as Record<
      string,
      unknown
    >;
    const parent = parseTraceparent(input.traceparent);
    const span = this.telemetry.startSpan(
      "anicode.github.webhook",
      {
        "anicode.github.event": input.event,
        "anicode.github.delivery_id": input.deliveryId,
      },
      parent,
    );
    const context = span.context();
    try {
      const result = await this.dispatch(
        input.event,
        input.deliveryId,
        payload,
        context ? traceparent(context) : undefined,
      );
      span.setStatus({ code: "ok" });
      return result;
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" });
      throw error;
    } finally {
      span.end();
    }
  }

  private async dispatch(
    event: string,
    deliveryId: string,
    payload: Record<string, unknown>,
    parentTrace?: string,
  ): Promise<GitHubWebhookResult> {
    const parent = parseTraceparent(parentTrace);
    const action = text(payload["action"]) ?? "unknown";
    const repository = object(payload["repository"]);
    const fullName = text(repository["full_name"]) ?? "unknown/unknown";
    const suite = object(payload["check_suite"]);
    const run = object(payload["workflow_run"]);
    const checkRun = object(payload["check_run"]);
    // workflow_run/check_suite/check_run 的真实 webhook 把关联 PR 放在 pull_requests 数组；
    // pull_request 事件才使用顶层 pull_request。统一归一化后再生成 durable job。
    const pull =
      Object.keys(object(payload["pull_request"])).length > 0
        ? object(payload["pull_request"])
        : firstObject(run["pull_requests"] ?? suite["pull_requests"] ?? checkRun["pull_requests"]);
    const headSha =
      text(pull["head"] && object(pull["head"])["sha"]) ??
      text(suite["head_sha"]) ??
      text(run["head_sha"]) ??
      text(checkRun["head_sha"]) ??
      text(object(payload["merge_group"])["head_sha"]);

    if (event === "check_suite" && ["requested", "rerequested"].includes(action) && headSha) {
      const created = await this.options.delivery.createCheckRun(
        {
          name: "AniCode Agent",
          headSha,
          externalId: deliveryId,
          status: "in_progress",
          output: {
            title: "AniCode is analysing this change",
            summary: "Durable agent job accepted.",
          },
        },
        parent,
      );
      const job = await this.enqueue("github-analysis", deliveryId, {
        deliveryId,
        event,
        action,
        repository: fullName,
        headSha,
        ...(parentTrace ? { traceparent: parentTrace } : {}),
      });
      return { accepted: true, queuedJobId: job.id, checkRun: created };
    }

    const conclusion =
      text(run["conclusion"]) ?? text(suite["conclusion"]) ?? text(checkRun["conclusion"]);
    const requestedAction = text(object(payload["requested_action"])["identifier"]);
    const failed =
      (event === "workflow_run" || event === "check_suite") &&
      action === "completed" &&
      ["failure", "timed_out", "cancelled", "action_required"].includes(conclusion ?? "");
    if ((failed || requestedAction === "anicode-repair") && headSha) {
      const job = await this.enqueue("github-repair", deliveryId, {
        deliveryId,
        event,
        action,
        repository: fullName,
        headSha,
        ...(number(pull["number"] ?? payload["number"]) !== undefined
          ? { pullRequestNumber: number(pull["number"] ?? payload["number"])! }
          : {}),
        ...(text(pull["node_id"]) ? { pullRequestNodeId: text(pull["node_id"])! } : {}),
        ...((text(run["html_url"]) ?? text(checkRun["html_url"]))
          ? { failedUrl: (text(run["html_url"]) ?? text(checkRun["html_url"]))! }
          : {}),
        ...(parentTrace ? { traceparent: parentTrace } : {}),
      });
      return { accepted: true, queuedJobId: job.id };
    }

    if (
      event === "pull_request" &&
      ["opened", "reopened", "synchronize"].includes(action) &&
      headSha
    ) {
      const job = await this.enqueue("github-analysis", deliveryId, {
        deliveryId,
        event,
        action,
        repository: fullName,
        headSha,
        ...(number(payload["number"]) !== undefined
          ? { pullRequestNumber: number(payload["number"])! }
          : {}),
        ...(text(pull["node_id"]) ? { pullRequestNodeId: text(pull["node_id"])! } : {}),
        ...(parentTrace ? { traceparent: parentTrace } : {}),
      });
      return { accepted: true, queuedJobId: job.id };
    }

    if (event === "merge_group" && headSha) {
      const job = await this.enqueue("github-merge-group", deliveryId, {
        deliveryId,
        event,
        action,
        repository: fullName,
        headSha,
        ...(parentTrace ? { traceparent: parentTrace } : {}),
      });
      return { accepted: true, queuedJobId: job.id };
    }
    return { accepted: true };
  }

  private enqueue(type: string, deliveryId: string, payload: GitHubRepairJob): Promise<WorkerJob> {
    return this.options.queue.enqueue(type, payload, {
      idempotencyKey: `github:${deliveryId}:${type}`,
      maxAttempts: Math.max(1, this.options.maxRepairAttempts ?? 3),
    });
  }
}

export interface GitHubRepairWorkerOptions {
  id: string;
  queue: DurableWorkerQueue;
  delivery: GitHubDelivery;
  repair: (
    job: GitHubRepairJob,
    signal: AbortSignal,
  ) => Promise<{
    summary: string;
    pullRequestNodeId?: string;
    enqueueWhenSuccessful?: boolean;
  }>;
  telemetry?: Telemetry;
  leaseMs?: number;
}

/** 修复回调负责跑 agent/verifier；本 worker 负责 durable retry、Check Run 和成功入队。 */
export function createGitHubRepairWorker(options: GitHubRepairWorkerOptions): PersistentWorker {
  return new PersistentWorker(
    options.id,
    options.queue,
    {
      "github-repair": async (raw, signal, context?: SpanContext) => {
        const job = raw as GitHubRepairJob;
        const check = await options.delivery.createCheckRun(
          {
            name: "AniCode Auto Repair",
            headSha: job.headSha,
            externalId: job.deliveryId,
            status: "in_progress",
            output: { title: "Automatic repair started", summary: job.failedUrl ?? "CI failed" },
          },
          context,
        );
        try {
          const result = await options.repair(job, signal);
          const nodeId = result.pullRequestNodeId ?? job.pullRequestNodeId;
          let queueEntry: string | undefined;
          if (result.enqueueWhenSuccessful && nodeId) {
            queueEntry = await options.delivery.enqueuePullRequest(nodeId, context);
          }
          await options.delivery.updateCheckRun(
            check.id,
            {
              status: "completed",
              conclusion: "success",
              output: {
                title: "Automatic repair verified",
                summary: `${result.summary}${queueEntry ? `\n\nMerge queue: ${queueEntry}` : ""}`,
              },
            },
            context,
          );
          return { ...result, queueEntry };
        } catch (error) {
          await options.delivery
            .updateCheckRun(
              check.id,
              {
                status: "completed",
                conclusion: "failure",
                output: {
                  title: "Automatic repair failed",
                  summary: error instanceof Error ? error.message : String(error),
                },
              },
              context,
            )
            .catch(() => undefined);
          throw error;
        }
      },
    },
    options.leaseMs ?? 60_000,
    options.telemetry ?? noTelemetry,
  );
}

export class GitHubWebhookServer {
  private server: Server | undefined;
  constructor(
    private readonly controller: GitHubWebhookController,
    private readonly maxBodyBytes = 2 * 1024 * 1024,
  ) {}

  async listen(port = 0, host = "127.0.0.1"): Promise<string> {
    if (this.server) throw new Error("GitHub webhook server is already listening");
    const server = createServer((request, response) => {
      void this.route(request, response).catch((error) => {
        json(response, /auth/i.test(error instanceof Error ? error.message : "") ? 401 : 400, {
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
    if (!address || typeof address === "string") throw new Error("GitHub webhook bind failed");
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
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { ok: true });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/github/webhook") {
      json(response, 404, { error: "not found" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += value.byteLength;
      if (size > this.maxBodyBytes) throw new Error("GitHub webhook body is too large");
      chunks.push(value);
    }
    const body = Buffer.concat(chunks);
    const signature =
      typeof request.headers["x-hub-signature-256"] === "string"
        ? request.headers["x-hub-signature-256"]
        : undefined;
    const parentTrace =
      typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined;
    const result = await this.controller.handle({
      event: String(request.headers["x-github-event"] ?? ""),
      deliveryId: String(request.headers["x-github-delivery"] ?? ""),
      ...(signature ? { signature } : {}),
      ...(parentTrace ? { traceparent: parentTrace } : {}),
      rawBody: body,
    });
    json(response, 202, result);
  }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
