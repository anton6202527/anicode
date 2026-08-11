import { supabaseApiKey } from "./environment.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(operation: () => unknown): string {
  try {
    operation();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected operation to reject");
}

Deno.test("prefers hosted named Supabase keys and supports local/legacy fallback", () => {
  assert(
    supabaseApiKey(
      {
        named: JSON.stringify({ default: "named-key" }),
        single: "single-key",
        legacy: "legacy",
      },
      "test",
    ) === "named-key",
  );
  assert(supabaseApiKey({ single: " single-key " }, "test") === "single-key");
  assert(supabaseApiKey({ legacy: " legacy-key " }, "test") === "legacy-key");
});

Deno.test("configuration errors never echo key material", () => {
  const malformed = "definitely-secret-but-invalid-json";
  const message = errorMessage(() =>
    supabaseApiKey({ named: malformed }, "test")
  );
  assert(!message.includes(malformed));

  const missingDefault = "another-secret";
  const missingMessage = errorMessage(() =>
    supabaseApiKey({ named: JSON.stringify({ other: missingDefault }) }, "test")
  );
  assert(!missingMessage.includes(missingDefault));
});
