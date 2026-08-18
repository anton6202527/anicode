import { quotaRejection, quotaResponseHeaders } from "./quota.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("classifies daily installation quota as a permanent 429", () => {
  const rejection = quotaRejection({
    code: "P0001",
    message: "device_daily_token_limit",
    details: "retry_after_seconds=4321",
  });
  assert(rejection?.code === "device_daily_token_limit");
  assert(rejection.retryable === false);
  const headers = quotaResponseHeaders(rejection);
  assert(headers.get("x-anicode-retryable") === "false");
  assert(headers.get("retry-after") === "4321");
});

Deno.test("keeps minute/concurrency quota retryable and bounds database metadata", () => {
  const rejection = quotaRejection({
    code: "P0001",
    message: "device_minute_rate_limit",
    details: "retry_after_seconds=999999999",
  });
  assert(rejection?.retryable === true);
  assert(rejection.retryAfterSeconds === 86_400);
  assert(quotaResponseHeaders(rejection).get("x-anicode-retryable") === "true");
});

Deno.test("maps legacy and unexpected policy messages without exposing them", () => {
  assert(
    quotaRejection({ code: "P0001", message: "gateway_disabled" })
      ?.retryable === false,
  );
  assert(
    quotaRejection({
      code: "P0001",
      message: "anicode gateway user quota exceeded",
    })?.code === "user_quota_exceeded",
  );
  assert(
    quotaRejection({ code: "P0001", message: "internal policy text" })?.code ===
      "quota_exceeded",
  );
  assert(
    quotaRejection({ code: "XX000", message: "database unavailable" }) ===
      undefined,
  );
});
