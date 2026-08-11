import { bearerToken } from "./auth.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("accepts exactly one bounded JWT-shaped bearer value", () => {
  const valid = new Request("https://gateway.invalid", {
    headers: { authorization: "Bearer header.payload.signature" },
  });
  assert(bearerToken(valid) === "header.payload.signature");

  for (
    const authorization of [
      "Basic header.payload.signature",
      "Bearer opaque-publishable-key",
      "Bearer header.payload.signature trailing",
      `Bearer header.${"a".repeat(17 * 1024)}.signature`,
    ]
  ) {
    assert(
      bearerToken(
        new Request("https://gateway.invalid", { headers: { authorization } }),
      ) === undefined,
    );
  }
});
