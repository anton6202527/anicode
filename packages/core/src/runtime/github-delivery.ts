/** GitHub/CI 交付闭环：PR、Check Run、merge queue 与 provenance。 */

import type { CredentialBroker } from "../security/credentials.js";
import type { NetworkProxy } from "./network-proxy.js";
import { noTelemetry, type SpanContext, type Telemetry } from "./telemetry.js";

export interface GitHubDeliveryOptions {
  owner: string;
  repo: string;
  proxy: NetworkProxy;
  broker: CredentialBroker;
  credentialId: string;
  apiBase?: string;
  graphqlUrl?: string;
  telemetry?: Telemetry;
  onAudit?: (event: GitHubAuditEvent) => void | Promise<void>;
}

export interface GitHubAuditEvent {
  timestamp: string;
  operation: string;
  method: string;
  path: string;
  status?: number;
  success: boolean;
  traceId?: string;
}

export interface GitHubDeliveryInput {
  base: string;
  branch: string;
  title: string;
  body?: string;
  files: { path: string; content: string; message?: string }[];
  workflow?: string;
  workflowInputs?: Record<string, string>;
}

export interface GitHubDeliveryResult {
  branch: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  workflowDispatched: boolean;
}

export interface GitHubCheckOutput {
  title: string;
  summary: string;
  text?: string;
  annotations?: Array<{
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: "notice" | "warning" | "failure";
    message: string;
    title?: string;
  }>;
}

export type GitHubCheckConclusion =
  | "action_required"
  | "cancelled"
  | "failure"
  | "neutral"
  | "skipped"
  | "stale"
  | "success"
  | "timed_out";

export interface GitHubCheckRun {
  id: number;
  node_id?: string;
  html_url?: string;
  status: "queued" | "in_progress" | "completed";
  conclusion?: GitHubCheckConclusion | null;
}

export interface SlsaProvenanceInput {
  artifactName: string;
  sha256: string;
  sourceUri: string;
  sourceDigest: string;
  workflowRef: string;
  invocationId: string;
  builderId?: string;
  startedAt?: string;
  finishedAt?: string;
  parameters?: Record<string, unknown>;
}

export class GitHubDelivery {
  private readonly base: string;
  private readonly graphqlUrl: string;
  private readonly telemetry: Telemetry;

  constructor(private readonly options: GitHubDeliveryOptions) {
    this.base = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.graphqlUrl = options.graphqlUrl ?? `${this.base}/graphql`;
    this.telemetry = options.telemetry ?? noTelemetry;
  }

  async createCheckRun(
    input: {
      name: string;
      headSha: string;
      detailsUrl?: string;
      externalId?: string;
      status?: "queued" | "in_progress" | "completed";
      conclusion?: GitHubCheckConclusion;
      output?: GitHubCheckOutput;
    },
    parent?: SpanContext,
  ): Promise<GitHubCheckRun> {
    return this.request(
      "POST",
      "/check-runs",
      {
        name: input.name,
        head_sha: input.headSha,
        status: input.status ?? (input.conclusion ? "completed" : "in_progress"),
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
        ...(input.externalId ? { external_id: input.externalId } : {}),
        ...(input.conclusion
          ? { conclusion: input.conclusion, completed_at: new Date().toISOString() }
          : {}),
        ...(input.output ? { output: input.output } : {}),
      },
      false,
      parent,
    );
  }

  async updateCheckRun(
    id: number,
    input: {
      status?: "queued" | "in_progress" | "completed";
      conclusion?: GitHubCheckConclusion;
      output?: GitHubCheckOutput;
      detailsUrl?: string;
    },
    parent?: SpanContext,
  ): Promise<GitHubCheckRun> {
    return this.request(
      "PATCH",
      `/check-runs/${id}`,
      {
        ...(input.status ? { status: input.status } : {}),
        ...(input.conclusion
          ? { conclusion: input.conclusion, completed_at: new Date().toISOString() }
          : {}),
        ...(input.output ? { output: input.output } : {}),
        ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
      },
      false,
      parent,
    );
  }

  /** GraphQL node id 必须来自 PullRequest.node_id；GitHub 会执行 branch protection/queue 规则。 */
  async enqueuePullRequest(pullRequestNodeId: string, parent?: SpanContext): Promise<string> {
    const result = await this.graphql<{
      enqueuePullRequest?: { mergeQueueEntry?: { id?: string } };
    }>(
      `mutation EnqueuePullRequest($input: EnqueuePullRequestInput!) {
        enqueuePullRequest(input: $input) { mergeQueueEntry { id } }
      }`,
      { input: { pullRequestId: pullRequestNodeId } },
      parent,
    );
    const id = result.enqueuePullRequest?.mergeQueueEntry?.id;
    if (!id) throw new Error("GitHub merge queue did not return an entry id");
    return id;
  }

  /** bundle 必须由 Sigstore/GitHub OIDC 签名；控制面不会伪造一个无签名 attestation。 */
  async publishAttestation(
    bundle: Record<string, unknown>,
    parent?: SpanContext,
  ): Promise<{ id?: number }> {
    return this.request("POST", "/attestations", { bundle }, false, parent);
  }

  async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    parent?: SpanContext,
  ): Promise<T> {
    const response = await this.rawRequest<{ data?: T; errors?: { message?: string }[] }>(
      "POST",
      new URL(this.graphqlUrl),
      { query, variables },
      false,
      "graphql",
      parent,
    );
    if (response.errors?.length) {
      throw new Error(`GitHub GraphQL: ${response.errors.map((item) => item.message).join("; ")}`);
    }
    if (!response.data) throw new Error("GitHub GraphQL returned no data");
    return response.data;
  }

  async deliver(input: GitHubDeliveryInput, parent?: SpanContext): Promise<GitHubDeliveryResult> {
    const baseRef = await this.request<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(input.base)}`,
      undefined,
      false,
      parent,
    );
    await this.request(
      "POST",
      "/git/refs",
      {
        ref: `refs/heads/${input.branch}`,
        sha: baseRef.object.sha,
      },
      false,
      parent,
    );
    for (const file of input.files) {
      await this.request(
        "PUT",
        `/contents/${file.path.split("/").map(encodeURIComponent).join("/")}`,
        {
          message: file.message ?? `Update ${file.path}`,
          content: Buffer.from(file.content).toString("base64"),
          branch: input.branch,
        },
        false,
        parent,
      );
    }
    const pull = await this.request<{ number: number; html_url: string }>(
      "POST",
      "/pulls",
      {
        title: input.title,
        body: input.body ?? "",
        head: input.branch,
        base: input.base,
        draft: true,
      },
      false,
      parent,
    );
    if (input.workflow) {
      await this.request(
        "POST",
        `/actions/workflows/${encodeURIComponent(input.workflow)}/dispatches`,
        { ref: input.branch, inputs: input.workflowInputs ?? {} },
        true,
        parent,
      );
    }
    return {
      branch: input.branch,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url,
      workflowDispatched: Boolean(input.workflow),
    };
  }

  async request<T = unknown>(
    method: string,
    pathSuffix: string,
    body?: unknown,
    acceptsNoContent = false,
    parent?: SpanContext,
  ): Promise<T> {
    const url = new URL(
      `${this.base}/repos/${this.options.owner}/${this.options.repo}${pathSuffix}`,
    );
    return this.rawRequest(method, url, body, acceptsNoContent, pathSuffix, parent);
  }

  private async rawRequest<T>(
    method: string,
    url: URL,
    body: unknown,
    acceptsNoContent: boolean,
    operation: string,
    parent?: SpanContext,
  ): Promise<T> {
    const span = this.telemetry.startSpan(
      "anicode.github.request",
      {
        "http.request.method": method,
        "server.address": url.hostname,
        "url.path": url.pathname,
        "anicode.github.operation": operation,
        "anicode.github.repository": `${this.options.owner}/${this.options.repo}`,
      },
      parent,
    );
    const lease = this.options.broker.lease({
      credentialId: this.options.credentialId,
      audience: "github-delivery",
      host: url.hostname,
      ttlMs: 30_000,
    });
    try {
      const response = await this.options.proxy.fetch(url, {
        method,
        credentialLease: lease,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      span.setAttribute("http.response.status_code", response.status);
      const traceId = span.context()?.traceId;
      await this.audit({
        operation,
        method,
        path: url.pathname,
        status: response.status,
        success: response.ok,
        ...(traceId ? { traceId } : {}),
      });
      if (!response.ok)
        throw new Error(
          `GitHub delivery HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`,
        );
      span.setStatus({ code: "ok" });
      if (acceptsNoContent || response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" });
      throw error;
    } finally {
      span.end();
    }
  }

  private async audit(event: Omit<GitHubAuditEvent, "timestamp">): Promise<void> {
    await this.options.onAudit?.({ timestamp: new Date().toISOString(), ...event });
  }
}

/** SLSA v1 predicate；实际签名/透明日志由 GitHub OIDC + attest-build-provenance 完成。 */
export function buildSlsaProvenance(input: SlsaProvenanceInput): Record<string, unknown> {
  const started = input.startedAt ?? new Date().toISOString();
  const finished = input.finishedAt ?? started;
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: input.artifactName, digest: { sha256: input.sha256 } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: { ref: input.workflowRef, repository: input.sourceUri },
          ...(input.parameters ? { parameters: input.parameters } : {}),
        },
        internalParameters: {},
        resolvedDependencies: [{ uri: input.sourceUri, digest: { gitCommit: input.sourceDigest } }],
      },
      runDetails: {
        builder: { id: input.builderId ?? "https://github.com/actions/runner" },
        metadata: {
          invocationId: input.invocationId,
          startedOn: started,
          finishedOn: finished,
        },
      },
    },
  };
}
