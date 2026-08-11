const MAX_BEARER_TOKEN_BYTES = 16 * 1024;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

/** Parse only a bounded JWT-shaped bearer value; cryptographic validation remains auth.getUser. */
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
