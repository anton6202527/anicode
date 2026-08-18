export interface GatewayRpcError {
  code?: string;
  message: string;
  details?: string;
  hint?: string;
}

export interface QuotaRejection {
  code: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

const STABLE_QUOTA_CODES = new Set([
  "gateway_disabled",
  "device_daily_token_limit",
  "device_daily_request_limit",
  "device_minute_rate_limit",
  "device_concurrency_limit",
  "user_daily_token_limit",
  "user_daily_request_limit",
  "user_minute_rate_limit",
  "user_concurrency_limit",
  "global_daily_token_limit",
  "global_daily_request_limit",
  "global_minute_rate_limit",
  "global_concurrency_limit",
  "user_quota_exceeded",
  "global_quota_exceeded",
  "quota_exceeded",
]);

const TRANSIENT_QUOTA_CODES = new Set([
  "device_minute_rate_limit",
  "device_concurrency_limit",
  "user_minute_rate_limit",
  "user_concurrency_limit",
  "global_minute_rate_limit",
  "global_concurrency_limit",
]);

function stableCode(message: string): string {
  const candidate = message.trim().toLowerCase();
  if (STABLE_QUOTA_CODES.has(candidate)) return candidate;
  if (candidate.includes("user quota exceeded")) return "user_quota_exceeded";
  if (candidate.includes("global quota exceeded")) {
    return "global_quota_exceeded";
  }
  return "quota_exceeded";
}

function retryAfterSeconds(error: GatewayRpcError): number | undefined {
  const metadata = `${error.details ?? ""} ${error.hint ?? ""}`;
  const tagged = /retry_after_seconds\s*=\s*(\d{1,9})/iu.exec(metadata)?.[1];
  const bare = /^\s*(\d{1,9})\s*$/u.exec(error.details ?? "")?.[1];
  const value = Number(tagged ?? bare);
  if (!Number.isSafeInteger(value) || value < 1) return undefined;
  return Math.min(value, 86_400);
}

/** Convert PostgreSQL policy failures into a stable, client-safe retry contract. */
export function quotaRejection(
  error: GatewayRpcError,
): QuotaRejection | undefined {
  if (error.code !== "P0001") return undefined;
  const code = stableCode(error.message);
  const retryable = TRANSIENT_QUOTA_CODES.has(code);
  const retryAfter = retryAfterSeconds(error);
  return {
    code,
    retryable,
    ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }),
  };
}

export function quotaResponseHeaders(rejection: QuotaRejection): Headers {
  const headers = new Headers({
    "x-anicode-retryable": rejection.retryable ? "true" : "false",
  });
  if (rejection.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(rejection.retryAfterSeconds));
  }
  return headers;
}
