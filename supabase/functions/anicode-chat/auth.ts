import { isAuthRetryableFetchError } from "@supabase/supabase-js";

const MAX_BEARER_TOKEN_BYTES = 16 * 1024;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Parse only a bounded JWT-shaped bearer value; cryptographic validation remains auth.getClaims. */
export function bearerToken(request: Request): string | undefined {
  const header = request.headers.get("authorization")?.trim();
  const match = /^Bearer ([^\s]+)$/iu.exec(header ?? "");
  const token = match?.[1];
  if (
    !token ||
    new TextEncoder().encode(token).byteLength > MAX_BEARER_TOKEN_BYTES ||
    !JWT.test(token)
  ) {
    return undefined;
  }
  return token;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Distinguish an unavailable verifier from an invalid credential so callers can return 503/401. */
export function isAuthVerificationUnavailable(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return true;
  if (!record(error) || typeof error.status !== "number") return false;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

function expectedIssuer(projectUrl: string): string | undefined {
  try {
    const url = new URL(projectUrl);
    if (url.username || url.password || url.search || url.hash) {
      return undefined;
    }
    return `${url.origin}${url.pathname.replace(/\/+$/u, "")}/auth/v1`;
  } catch {
    return undefined;
  }
}

/**
 * Apply AniCode's authorization contract to claims whose signature and expiry were already
 * validated by Supabase auth.getClaims. This helper does not perform cryptographic verification.
 */
export function authenticatedUserIdFromVerifiedClaims(
  claims: unknown,
  projectUrl: string,
): string | undefined {
  if (!record(claims)) return undefined;

  const issuer = expectedIssuer(projectUrl);
  const audience = claims.aud;
  const hasAuthenticatedAudience = audience === "authenticated" ||
    (Array.isArray(audience) &&
      audience.every((value) => typeof value === "string") &&
      audience.includes("authenticated"));
  if (
    !issuer ||
    claims.iss !== issuer ||
    !hasAuthenticatedAudience ||
    claims.role !== "authenticated" ||
    typeof claims.sub !== "string" ||
    !UUID.test(claims.sub)
  ) {
    return undefined;
  }
  return claims.sub;
}
