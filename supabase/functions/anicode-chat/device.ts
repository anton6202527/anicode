export const INSTALLATION_TOKEN_HEADER = "x-anicode-installation-token";

const INSTALLATION_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MINIMUM_PSEUDONYM_KEY_BYTES = 32;
const MAXIMUM_PSEUDONYM_KEY_BYTES = 4_096;

export function installationToken(request: Request): string | undefined {
  const value = request.headers.get(INSTALLATION_TOKEN_HEADER)?.trim();
  return value && INSTALLATION_TOKEN.test(value) ? value : undefined;
}

function base64Url(value: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(
    /=+$/u,
    "",
  );
}

async function hmac(key: CryptoKey, value: string): Promise<string> {
  return base64Url(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}

/**
 * Derive unlinkable identifiers for quota storage and DeepSeek's user_id isolation. The raw
 * installation bearer never enters PostgreSQL or the upstream request, and no email/hardware ID is
 * used. Rotating the server key intentionally starts a new device namespace and therefore requires
 * an explicit quota migration plan.
 */
export async function quotaSubjects(
  secret: string,
  token: string,
  userId: string,
): Promise<{ deviceSubject: string; upstreamUserId: string }> {
  const secretBytes = new TextEncoder().encode(secret);
  if (
    secretBytes.byteLength < MINIMUM_PSEUDONYM_KEY_BYTES ||
    secretBytes.byteLength > MAXIMUM_PSEUDONYM_KEY_BYTES
  ) {
    throw new RangeError(
      "device pseudonym key must contain 32 to 4096 UTF-8 bytes",
    );
  }
  if (!INSTALLATION_TOKEN.test(token)) {
    throw new RangeError("installation token is invalid");
  }
  if (!userId || userId.length > 256 || userId.includes("\0")) {
    throw new RangeError("user identity is invalid");
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secretBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const [device, upstream] = await Promise.all([
    hmac(key, `anicode-device-v1\0${token}`),
    hmac(key, `anicode-deepseek-user-v1\0${userId}\0${token}`),
  ]);
  return {
    deviceSubject: `d_${device}`,
    upstreamUserId: `u_${upstream}`,
  };
}
