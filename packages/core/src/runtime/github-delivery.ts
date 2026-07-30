/** GitHub/CI 交付闭环：PR、Check Run、merge queue 与 provenance。 */

import type { CredentialBroker } from "../security/credentials.js";
import type { GitHubAccessTokenProvider } from "./github-app.js";
import type { NetworkProxy } from "./network-proxy.js";
import { noTelemetry, type SpanContext, type Telemetry } from "./telemetry.js";

export interface GitHubDeliveryOptions {
  owner: string;
  repo: string;
  proxy: NetworkProxy;
  /** Legacy/static credentials are retained for local tests only. Production uses accessTokenProvider. */
  broker?: CredentialBroker;
  credentialId?: string;
  accessTokenProvider?: GitHubAccessTokenProvider;
  apiBase?: string;
  graphqlUrl?: string;
  apiVersion?: string;
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
  commitMessage?: string;
  files: { path: string; content: string; mode?: "100644" | "100755" }[];
  workflow?: string;
  workflowInputs?: Record<string, string>;
}

export interface GitHubDeliveryResult {
  branch: string;
  commitSha: string;
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
  private readonly apiVersion: string;
  private readonly telemetry: Telemetry;

  constructor(private readonly options: GitHubDeliveryOptions) {
    if (!options.accessTokenProvider && (!options.broker || !options.credentialId)) {
      throw new Error("GitHub delivery requires an installation token provider");
    }
    if (!/^[A-Za-z0-9_.-]+$/.test(options.owner) || !/^[A-Za-z0-9_.-]+$/.test(options.repo)) {
      throw new Error("GitHub owner and repository names are invalid");
    }
    this.base = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.graphqlUrl = options.graphqlUrl ?? `${this.base}/graphql`;
    this.apiVersion = options.apiVersion ?? "2026-03-10";
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

  async dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
    parent?: SpanContext,
  ): Promise<void> {
    if (!/^[A-Za-z0-9_.-]+\.ya?ml$/.test(workflow)) {
      throw new Error("GitHub workflow name is invalid");
    }
    validRef(ref, "GitHub workflow ref");
    await this.request(
      "POST",
      `/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      { ref, inputs },
      true,
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
    validateDeliveryInput(input);
    const findOpenPulls = () =>
      this.request<Array<{ number: number; html_url: string }>>(
        "GET",
        `/pulls?state=open&head=${encodeURIComponent(`${this.options.owner}:${input.branch}`)}&base=${encodeURIComponent(input.base)}`,
        undefined,
        false,
        parent,
      );
    // A branch name is the delivery idempotency boundary. A retry resumes at PR/workflow creation
    // instead of creating sibling commits or force-updating an existing branch.
    try {
      const existingRef = await this.request<{ object: { sha: string } }>(
        "GET",
        `/git/ref/heads/${encodeURIComponent(input.branch)}`,
        undefined,
        false,
        parent,
      );
      const existingPulls = await findOpenPulls();
      const pull =
        existingPulls[0] ??
        (await this.request<{ number: number; html_url: string }>(
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
        ));
      if (input.workflow && existingPulls.length === 0) {
        await this.dispatchWorkflow(
          input.workflow,
          input.branch,
          input.workflowInputs ?? {},
          parent,
        );
      }
      return {
        branch: input.branch,
        commitSha: existingRef.object.sha,
        pullRequestNumber: pull.number,
        pullRequestUrl: pull.html_url,
        workflowDispatched: Boolean(input.workflow && existingPulls.length === 0),
      };
    } catch (error) {
      if (!githubStatus(error, 404)) throw error;
    }
    const baseRef = await this.request<{ object: { sha: string } }>(
      "GET",
      `/git/ref/heads/${encodeURIComponent(input.base)}`,
      undefined,
      false,
      parent,
    );
    const baseCommit = await this.request<{ tree: { sha: string } }>(
      "GET",
      `/git/commits/${encodeURIComponent(baseRef.object.sha)}`,
      undefined,
      false,
      parent,
    );
    const blobs = await Promise.all(
      input.files.map(async (file) => ({
        path: file.path,
        mode: file.mode ?? "100644",
        sha: (
          await this.request<{ sha: string }>(
            "POST",
            "/git/blobs",
            { content: file.content, encoding: "utf-8" },
            false,
            parent,
          )
        ).sha,
      })),
    );
    const tree = await this.request<{ sha: string }>(
      "POST",
      "/git/trees",
      {
        base_tree: baseCommit.tree.sha,
        tree: blobs.map((file) => ({
          path: file.path,
          mode: file.mode,
          type: "blob",
          sha: file.sha,
        })),
      },
      false,
      parent,
    );
    const commit = await this.request<{ sha: string }>(
      "POST",
      "/git/commits",
      {
        message: input.commitMessage ?? input.title,
        tree: tree.sha,
        parents: [baseRef.object.sha],
      },
      false,
      parent,
    );
    try {
      await this.request(
        "POST",
        "/git/refs",
        {
          ref: `refs/heads/${input.branch}`,
          sha: commit.sha,
        },
        false,
        parent,
      );
    } catch (error) {
      if (!githubStatus(error, 422)) throw error;
      // Another worker won the idempotency race. Resume through the existing branch.
      return this.deliver(input, parent);
    }
    const existingPulls = await findOpenPulls();
    const pull =
      existingPulls[0] ??
      (await this.request<{ number: number; html_url: string }>(
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
      ));
    // A durable retry can safely rebuild the branch/commit. Do not dispatch the workflow twice.
    if (input.workflow && existingPulls.length === 0) {
      await this.dispatchWorkflow(input.workflow, input.branch, input.workflowInputs ?? {}, parent);
    }
    return {
      branch: input.branch,
      commitSha: commit.sha,
      pullRequestNumber: pull.number,
      pullRequestUrl: pull.html_url,
      workflowDispatched: Boolean(input.workflow && existingPulls.length === 0),
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
    try {
      const execute = async (forceRefresh = false): Promise<Response> => {
        const headers: Record<string, string> = {
          accept: "application/vnd.github+json",
          "x-github-api-version": this.apiVersion,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        };
        let credentialLease: string | undefined;
        if (this.options.accessTokenProvider) {
          headers.authorization = `Bearer ${await this.options.accessTokenProvider.token(forceRefresh)}`;
        } else {
          credentialLease = this.options.broker!.lease({
            credentialId: this.options.credentialId!,
            audience: "github-delivery",
            host: url.hostname,
            ttlMs: 30_000,
          });
        }
        return this.options.proxy.fetch(url, {
          method,
          headers,
          ...(credentialLease ? { credentialLease } : {}),
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      };
      let response = await execute();
      if (response.status === 401 && this.options.accessTokenProvider) {
        await response.body?.cancel().catch(() => undefined);
        response = await execute(true);
      }
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
      if (!response.ok) {
        throw new GitHubHttpError(
          response.status,
          `GitHub delivery HTTP ${response.status}: ${(await response.text()).slice(0, 1_000)}`,
        );
      }
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

class GitHubHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitHubHttpError";
  }
}

function githubStatus(error: unknown, status: number): boolean {
  return error instanceof GitHubHttpError && error.status === status;
}

function validRef(value: string, label: string): void {
  if (
    !value ||
    value.length > 240 ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) <= 0x20 ||
        character.charCodeAt(0) === 0x7f ||
        "~^:?*[\\".includes(character),
    ) ||
    value.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) {
    throw new Error(`${label} is not a safe Git ref`);
  }
}

function validateDeliveryInput(input: GitHubDeliveryInput): void {
  validRef(input.base, "GitHub base branch");
  validRef(input.branch, "GitHub delivery branch");
  if (input.base === input.branch) throw new Error("GitHub delivery branch must differ from base");
  if (!input.title.trim()) throw new Error("GitHub delivery title is required");
  if (input.files.length === 0 || input.files.length > 1_000) {
    throw new Error("GitHub delivery requires 1-1000 files");
  }
  const seen = new Set<string>();
  let bytes = 0;
  for (const file of input.files) {
    const parts = file.path.split("/");
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      parts.some((part) => !part || part === "." || part === ".." || part === ".git")
    ) {
      throw new Error(`Unsafe GitHub delivery path: ${file.path}`);
    }
    if (seen.has(file.path)) throw new Error(`Duplicate GitHub delivery path: ${file.path}`);
    seen.add(file.path);
    const size = Buffer.byteLength(file.content);
    if (size > 10 * 1024 * 1024) throw new Error(`GitHub delivery file is too large: ${file.path}`);
    bytes += size;
  }
  if (bytes > 50 * 1024 * 1024) throw new Error("GitHub delivery exceeds 50 MiB");
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
