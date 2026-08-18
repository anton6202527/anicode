import { installationToken, quotaSubjects } from "./device.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

const TOKEN_A = "a".repeat(43);
const TOKEN_B = "b".repeat(43);
const SECRET = "server-owned-device-pseudonym-key";

Deno.test("accepts only one canonical installation bearer", () => {
  assert(
    installationToken(
      new Request("https://gateway.invalid", {
        headers: { "x-anicode-installation-token": TOKEN_A },
      }),
    ) === TOKEN_A,
  );
  for (const value of ["", "short", `${TOKEN_A}, ${TOKEN_B}`, "!".repeat(43)]) {
    assert(
      installationToken(
        new Request("https://gateway.invalid", {
          headers: { "x-anicode-installation-token": value },
        }),
      ) === undefined,
    );
  }
});

Deno.test("derives stable, scoped, privacy-preserving quota subjects", async () => {
  const first = await quotaSubjects(SECRET, TOKEN_A, "user-one");
  const repeated = await quotaSubjects(SECRET, TOKEN_A, "user-one");
  const otherUser = await quotaSubjects(SECRET, TOKEN_A, "user-two");
  const otherDevice = await quotaSubjects(SECRET, TOKEN_B, "user-one");

  assert(JSON.stringify(first) === JSON.stringify(repeated));
  assert(/^d_[A-Za-z0-9_-]{43}$/u.test(first.deviceSubject));
  assert(/^u_[A-Za-z0-9_-]{43}$/u.test(first.upstreamUserId));
  assert(otherUser.deviceSubject === first.deviceSubject);
  assert(otherUser.upstreamUserId !== first.upstreamUserId);
  assert(otherDevice.deviceSubject !== first.deviceSubject);
  assert(otherDevice.upstreamUserId !== first.upstreamUserId);
  assert(!JSON.stringify(first).includes(TOKEN_A));
});

Deno.test("rejects weak pseudonym keys and malformed subjects", async () => {
  let rejected = 0;
  for (
    const input of [
      () => quotaSubjects("weak", TOKEN_A, "user"),
      () => quotaSubjects(SECRET, "not-a-token", "user"),
      () => quotaSubjects(SECRET, TOKEN_A, ""),
    ]
  ) {
    try {
      await input();
    } catch {
      rejected++;
    }
  }
  assert(rejected === 3);
});
