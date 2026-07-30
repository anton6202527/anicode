/** Remote Runtime OIDC 鉴权：JWT/JWKS 校验，runner/control-plane 不持有长期用户 token。 */

import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from "jose";

export interface RemoteOidcAuthenticatorOptions {
  issuer: string;
  audience: string | string[];
  jwksUri: string;
  algorithms?: string[];
  requiredClaims?: Record<string, string | string[]>;
  fetch?: typeof fetch;
}

function claimMatches(actual: unknown, expected: string | string[]): boolean {
  const values = Array.isArray(expected) ? expected : [expected];
  if (Array.isArray(actual)) return actual.some((value) => values.includes(String(value)));
  return actual !== undefined && values.includes(String(actual));
}

export function createRemoteOidcAuthenticator(options: RemoteOidcAuthenticatorOptions) {
  const jwks = createRemoteJWKSet(new URL(options.jwksUri), {
    ...(options.fetch ? { [customFetch]: options.fetch } : {}),
  });
  const issuer = options.issuer.replace(/\/$/, "");
  return async (request: IncomingMessage): Promise<{ actor: string; claims: JWTPayload }> => {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) throw new Error("Remote authentication required");
    const token = authorization.slice(7).trim();
    if (!token) throw new Error("Remote authentication token is empty");
    const verified = await jwtVerify(token, jwks, {
      issuer,
      audience: options.audience,
      algorithms: options.algorithms ?? ["RS256", "ES256", "EdDSA"],
      clockTolerance: 5,
      maxTokenAge: "15m",
    });
    for (const [name, expected] of Object.entries(options.requiredClaims ?? {})) {
      if (!claimMatches(verified.payload[name], expected)) {
        throw new Error(`Remote authentication claim ${name} is denied`);
      }
    }
    if (!verified.payload.sub) throw new Error("Remote authentication subject is missing");
    return { actor: verified.payload.sub, claims: verified.payload };
  };
}
