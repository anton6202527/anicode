/** GitHub App authentication: Broker-held private key -> short-lived installation token. */

import { importPKCS8, SignJWT } from "jose";
import type { CredentialBroker } from "../security/credentials.js";
import {
  credentialFetch,
  credentialRequestTimeout,
  credentialResponseLimit,
  discardCredentialResponse,
  readCredentialJson,
  safeCredentialError,
  withCredentialDeadline,
} from "../security/credential-io.js";
import type { NetworkProxy } from "./network-proxy.js";

export interface GitHubAccessTokenProvider {
  /** Return a raw access token (without a `Bearer ` prefix). */
  token(forceRefresh?: boolean, signal?: AbortSignal): Promise<string>;
}

export interface GitHubAppInstallationTokenOptions {
  appId: string | number;
  installationId: string | number;
  owner: string;
  repo: string;
  broker: CredentialBroker;
  privateKeyCredentialId: string;
  proxy: NetworkProxy;
  apiBase?: string;
  apiVersion?: string;
  permissions?: Record<string, "read" | "write">;
  now?: () => number;
  /** Absolute installation-token request deadline. Default: 30 seconds. */
  requestTimeoutMs?: number;
  /** Maximum installation-token response size. Default: 256 KiB. */
  maxResponseBytes?: number;
}

interface InstallationTokenResponse {
  token?: string;
  expires_at?: string;
  repositories?: Array<{ full_name?: string; name?: string }>;
}

const MAX_INSTALLATION_TOKEN_TTL_MS = 2 * 60 * 60_000;

function positiveInteger(value: string | number, name: string): string {
  const parsed = String(value);
  if (!/^[1-9][0-9]*$/.test(parsed)) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/**
 * Mints repository-scoped GitHub App installation tokens and refreshes them before expiry.
 * The private key never enters an environment variable, request body, log, or artifact.
 */
export class GitHubAppInstallationTokenSource implements GitHubAccessTokenProvider {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly base: string;
  private readonly apiVersion: string;
  private cached: { token: string; expiresAt: number } | undefined;
  private refreshing: Promise<{ token: string; expiresAt: number }> | undefined;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: GitHubAppInstallationTokenOptions) {
    this.appId = positiveInteger(options.appId, "GitHub App id");
    this.installationId = positiveInteger(options.installationId, "GitHub installation id");
    if (!/^[A-Za-z0-9_.-]+$/.test(options.owner) || !/^[A-Za-z0-9_.-]+$/.test(options.repo)) {
      throw new Error("GitHub owner and repository names are invalid");
    }
    this.base = (options.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
    this.apiVersion = options.apiVersion ?? "2026-03-10";
    this.requestTimeoutMs = credentialRequestTimeout(options.requestTimeoutMs, 30_000);
    this.maxResponseBytes = credentialResponseLimit(options.maxResponseBytes, 256 * 1024);
  }

  async token(forceRefresh = false, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted)
      throw safeCredentialError("GitHub installation token request was cancelled");
    const now = this.now();
    if (!forceRefresh && this.cached && this.cached.expiresAt - 5 * 60_000 > now) {
      return this.cached.token;
    }
    const refresh = this.refreshing ?? this.startRefresh();
    // Minting is shared and owns its own deadline. One disconnected waiter must not abort the
    // refresh required by the remaining callers.
    return withCredentialDeadline(
      "GitHub installation token request",
      this.requestTimeoutMs,
      signal,
      async () => (await refresh).token,
    );
  }

  private startRefresh(): Promise<{ token: string; expiresAt: number }> {
    const refresh = this.mint()
      .then((value) => {
        this.cached = value;
        return value;
      })
      .finally(() => {
        if (this.refreshing === refresh) this.refreshing = undefined;
      });
    this.refreshing = refresh;
    return refresh;
  }

  clear(): void {
    this.cached = undefined;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private mint(): Promise<{ token: string; expiresAt: number }> {
    return withCredentialDeadline(
      "GitHub installation token request",
      this.requestTimeoutMs,
      undefined,
      (signal) => this.mintWithinBoundary(signal),
    );
  }

  private async mintWithinBoundary(
    signal: AbortSignal,
  ): Promise<{ token: string; expiresAt: number }> {
    const target = new URL(
      `${this.base}/app/installations/${encodeURIComponent(this.installationId)}/access_tokens`,
    );
    const privateKey = await this.options.broker.trustedValueAsync(
      this.options.privateKeyCredentialId,
      {
        audience: "github-app-auth",
        host: target.hostname,
        tool: "sign-installation-token",
      },
    );
    const key = await importPKCS8(privateKey, "RS256");
    const nowSeconds = Math.floor(this.now() / 1_000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.appId)
      .setIssuedAt(nowSeconds - 60)
      .setExpirationTime(nowSeconds + 9 * 60)
      .sign(key);
    return credentialFetch(
      {
        label: "GitHub installation token request",
        fetch: (input, init) =>
          this.options.proxy.fetch(input instanceof Request ? input.url : input, init),
        input: target,
        init: {
          method: "POST",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${jwt}`,
            "content-type": "application/json",
            "x-github-api-version": this.apiVersion,
          },
          body: JSON.stringify({
            repositories: [this.options.repo],
            permissions: this.options.permissions ?? {
              actions: "write",
              checks: "write",
              contents: "write",
              pull_requests: "write",
            },
          }),
        },
        requestTimeoutMs: this.requestTimeoutMs,
        maxResponseBytes: this.maxResponseBytes,
        signal,
      },
      async (response, responseSignal, maximumBytes) => {
        if (!response.ok) {
          discardCredentialResponse(response, "GitHub installation token request rejected");
          throw safeCredentialError(
            `GitHub installation token request failed: HTTP ${response.status}`,
          );
        }
        const body = await readCredentialJson<InstallationTokenResponse>(
          response,
          maximumBytes,
          responseSignal,
          "GitHub installation token request",
        );
        if (!body.token || !body.expires_at) {
          throw safeCredentialError("GitHub installation token response is incomplete");
        }
        const expiresAt = Date.parse(body.expires_at);
        const now = this.now();
        if (
          !Number.isFinite(expiresAt) ||
          expiresAt <= now + 60_000 ||
          expiresAt > now + MAX_INSTALLATION_TOKEN_TTL_MS
        ) {
          throw safeCredentialError("GitHub installation token expiry is invalid or too short");
        }
        if (
          body.repositories?.length &&
          !body.repositories.some(
            (repository) =>
              repository.full_name?.toLowerCase() ===
                `${this.options.owner}/${this.options.repo}`.toLowerCase() ||
              repository.name?.toLowerCase() === this.options.repo.toLowerCase(),
          )
        ) {
          throw safeCredentialError(
            "GitHub installation token was not scoped to the configured repository",
          );
        }
        return { token: body.token, expiresAt };
      },
    );
  }
}
