import { AuthRetryableFetchError } from "@supabase/supabase-js";
import {
  authenticatedUserIdFromVerifiedClaims,
  bearerToken,
  isAuthVerificationUnavailable,
} from "./auth.ts";

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

const PROJECT_URL = "https://project-id.supabase.co";
const USER_ID = "4f9d5ec4-6f5b-4eb9-ae3e-15bb6c62fb45";
const VALID_CLAIMS = {
  sub: USER_ID,
  iss: `${PROJECT_URL}/auth/v1`,
  aud: "authenticated",
  role: "authenticated",
};

Deno.test("accepts only the authenticated project audience from verified claims", () => {
  for (const aud of ["authenticated", ["other", "authenticated"]]) {
    assert(
      authenticatedUserIdFromVerifiedClaims(
        { ...VALID_CLAIMS, aud },
        `${PROJECT_URL}/`,
      ) === USER_ID,
    );
  }
});

Deno.test("rejects verified claims outside the AniCode user contract", () => {
  const rejected: unknown[] = [
    undefined,
    [],
    { ...VALID_CLAIMS, sub: "not-a-uuid" },
    { ...VALID_CLAIMS, iss: "https://other-project.supabase.co/auth/v1" },
    { ...VALID_CLAIMS, aud: "anon" },
    { ...VALID_CLAIMS, aud: ["authenticated", 1] },
    { ...VALID_CLAIMS, role: "service_role" },
  ];
  for (const claims of rejected) {
    assert(
      authenticatedUserIdFromVerifiedClaims(claims, PROJECT_URL) ===
        undefined,
    );
  }
  assert(
    authenticatedUserIdFromVerifiedClaims(VALID_CLAIMS, "not-a-url") ===
      undefined,
  );
});

Deno.test("separates verifier outages from invalid credentials", () => {
  assert(
    isAuthVerificationUnavailable(
      new AuthRetryableFetchError("temporary fetch failure", 0),
    ),
  );
  for (const status of [408, 429, 500, 503]) {
    assert(isAuthVerificationUnavailable({ status }));
  }
  for (
    const error of [
      undefined,
      { status: 400 },
      { status: 401 },
      { status: 403 },
    ]
  ) {
    assert(!isAuthVerificationUnavailable(error));
  }
});
