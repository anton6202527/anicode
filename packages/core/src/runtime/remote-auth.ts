/** Remote Runtime OIDC 鉴权：JWT/JWKS 校验，runner/control-plane 不持有长期用户 token。 */

import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";
import {
  credentialFetch,
  credentialRequestTimeout,
  credentialResponseLimit,
  readCredentialBytes,
  safeCredentialError,
  withCredentialDeadline,
} from "../security/credential-io.js";

export interface RemoteOidcAuthenticatorOptions {
  issuer: string;
  audience: string | string[];
  jwksUri: string;
  algorithms?: string[];
  requiredClaims?: Record<string, string | string[]>;
  fetch?: typeof fetch;
  /** Absolute JWT verification/JWKS deadline. Default: 10 seconds. */
  requestTimeoutMs?: number;
  /** Maximum JWKS response size. Default: 1 MiB. */
  maxResponseBytes?: number;
}

function claimMatches(actual: unknown, expected: string | string[]): boolean {
  const values = Array.isArray(expected) ? expected : [expected];
  if (Array.isArray(actual)) return actual.some((value) => values.includes(String(value)));
  return actual !== undefined && values.includes(String(actual));
}

export function createRemoteOidcAuthenticator(options: RemoteOidcAuthenticatorOptions) {
  const requestTimeoutMs = credentialRequestTimeout(options.requestTimeoutMs, 10_000);
  const maxResponseBytes = credentialResponseLimit(options.maxResponseBytes, 1024 * 1024);
  const activeRequestSignal = new AsyncLocalStorage<AbortSignal>();
  const boundedFetch = (input: string | URL, init?: RequestInit): Promise<Response> => {
    const requestSignal = activeRequestSignal.getStore();
    return credentialFetch(
      {
        label: "OIDC JWKS request",
        fetch: options.fetch ?? fetch,
        input,
        ...(init ? { init } : {}),
        requestTimeoutMs,
        maxResponseBytes,
        ...(requestSignal ? { signal: requestSignal } : {}),
      },
      async (response, signal, maximumBytes) => {
        const body = await readCredentialBytes(response, maximumBytes, signal, "OIDC JWKS request");
        return new Response(Buffer.from(body).toString("utf8"), {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      },
    );
  };
  let jwksUrl: URL;
  try {
    jwksUrl = new URL(options.jwksUri);
  } catch {
    throw new Error("OIDC JWKS URL is invalid");
  }
  if (jwksUrl.protocol !== "https:" || jwksUrl.username || jwksUrl.password || jwksUrl.hash) {
    throw new Error("OIDC JWKS URL must be credential-free HTTPS");
  }
  const jwks = createRemoteJWKSet(jwksUrl, {
    [customFetch]: boundedFetch,
    timeoutDuration: requestTimeoutMs,
  });
  const issuer = options.issuer.replace(/\/$/, "");
  return async (
    request: IncomingMessage,
    signal?: AbortSignal,
  ): Promise<{ actor: string; claims: JWTPayload }> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new Error("Remote authentication required");
    if (Buffer.byteLength(authorization, "utf8") > 64 * 1024) {
      throw new Error("Remote authentication token is too large");
    }
    const token = authorization.slice(7).trim();
    if (!token) throw new Error("Remote authentication token is empty");
    const disconnected = new AbortController();
    const onAborted = () =>
      disconnected.abort(safeCredentialError("Remote OIDC authentication was cancelled"));
    request.once("aborted", onAborted);
    const parentSignal = signal
      ? AbortSignal.any([signal, disconnected.signal])
      : disconnected.signal;
    let verified: Awaited<ReturnType<typeof jwtVerify>>;
    try {
      verified = await withCredentialDeadline(
        "Remote OIDC authentication",
        requestTimeoutMs,
        parentSignal,
        (requestSignal) =>
          activeRequestSignal.run(requestSignal, () =>
            jwtVerify(token, jwks, {
              issuer,
              audience: options.audience,
              algorithms: options.algorithms ?? ["RS256", "ES256", "EdDSA"],
              clockTolerance: 5,
              maxTokenAge: "15m",
            }),
          ),
      );
    } finally {
      request.off("aborted", onAborted);
    }
    for (const [name, expected] of Object.entries(options.requiredClaims ?? {})) {
      if (!claimMatches(verified.payload[name], expected)) {
        throw new Error(`Remote authentication claim ${name} is denied`);
      }
    }
    if (!verified.payload.sub) throw new Error("Remote authentication subject is missing");
    return { actor: verified.payload.sub, claims: verified.payload };
  };
}
