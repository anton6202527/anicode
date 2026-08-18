export interface UpstreamFailure {
  status: number;
  message: string;
  code: string;
  headers: Headers;
}

function boundedRetryAfter(
  value: string | null,
  now: number,
): string | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return String(Math.min(3_600, Math.max(1, Math.ceil(seconds))));
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= now) return undefined;
  return String(
    Math.min(3_600, Math.max(1, Math.ceil((timestamp - now) / 1_000))),
  );
}

/** Translate DeepSeek transport failures without exposing its response body or vendor metadata. */
export function upstreamFailure(
  response: Pick<Response, "status" | "headers">,
  now: number = Date.now(),
): UpstreamFailure {
  const headers = new Headers();
  if (response.status === 429) {
    headers.set("x-anicode-retryable", "true");
    const retryAfter = boundedRetryAfter(
      response.headers.get("retry-after"),
      now,
    );
    if (retryAfter) headers.set("retry-after", retryAfter);
    return {
      status: 429,
      message: "model capacity is temporarily limited",
      code: "upstream_rate_limited",
      headers,
    };
  }

  // DeepSeek documents 402 as account balance exhaustion. This is an operator condition, not a
  // reason to make every client retry the same request or to imply the end user must pay DeepSeek.
  if (response.status === 402) {
    headers.set("x-anicode-retryable", "false");
    return {
      status: 503,
      message: "model gateway credit is temporarily unavailable",
      code: "upstream_balance_exhausted",
      headers,
    };
  }

  // A malformed 2xx is conservatively charged by the caller, so do not automatically repeat it
  // and consume another full reservation. True transport/server failures remain retryable.
  const retryable = response.status === 408 || response.status === 425 ||
    response.status >= 500;
  headers.set("x-anicode-retryable", retryable ? "true" : "false");
  if (retryable) {
    const retryAfter = boundedRetryAfter(
      response.headers.get("retry-after"),
      now,
    );
    if (retryAfter) headers.set("retry-after", retryAfter);
  }
  return {
    status: 502,
    message: "model request failed",
    code: response.status === 401
      ? "upstream_authentication_failed"
      : "upstream_failed",
    headers,
  };
}
