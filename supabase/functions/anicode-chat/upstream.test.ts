import { upstreamFailure } from "./upstream.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("propagates a bounded Retry-After for transient DeepSeek 429s", () => {
  const failure = upstreamFailure({
    status: 429,
    headers: new Headers({ "retry-after": "999999" }),
  });
  assert(failure.status === 429);
  assert(failure.code === "upstream_rate_limited");
  assert(failure.headers.get("x-anicode-retryable") === "true");
  assert(failure.headers.get("retry-after") === "3600");
});

Deno.test("makes balance exhaustion and upstream request defects non-retryable", () => {
  const balance = upstreamFailure({ status: 402, headers: new Headers() });
  assert(balance.status === 503);
  assert(balance.code === "upstream_balance_exhausted");
  assert(balance.headers.get("x-anicode-retryable") === "false");

  const invalid = upstreamFailure({ status: 422, headers: new Headers() });
  assert(invalid.status === 502);
  assert(invalid.headers.get("x-anicode-retryable") === "false");
});

Deno.test("retries timeout/early-data and upstream server failures", () => {
  for (const status of [408, 425, 500, 503]) {
    const failure = upstreamFailure({
      status,
      headers: new Headers({ "retry-after": "2" }),
    });
    assert(failure.status === 502);
    assert(failure.headers.get("x-anicode-retryable") === "true");
    assert(failure.headers.get("retry-after") === "2");
  }
});

Deno.test("does not retry a conservatively charged malformed success", () => {
  const failure = upstreamFailure({ status: 200, headers: new Headers() });
  assert(failure.status === 502);
  assert(failure.headers.get("x-anicode-retryable") === "false");
});
