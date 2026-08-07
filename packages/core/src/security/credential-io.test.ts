import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialFetch } from "./credential-io.js";

test("credential fetch: overrides caller redirect policy and accepts an unredirected response", async () => {
  let observedRedirect: RequestRedirect | undefined;
  const result = await credentialFetch(
    {
      label: "test credential request",
      input: "https://vault.example/v1/secret",
      init: { redirect: "follow", headers: { authorization: "Bearer test-only" } },
      fetch: (async (_input, init) => {
        observedRedirect = init?.redirect;
        return Response.json({ ok: true });
      }) as typeof fetch,
    },
    async (response) => (await response.json()) as { ok: boolean },
  );

  assert.equal(observedRedirect, "error");
  assert.deepEqual(result, { ok: true });
});

test("credential fetch: rejects a final response URL from another origin", async () => {
  const response = Response.json({ mustNotBeConsumed: true });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: "https://attacker.example/collect",
  });

  await assert.rejects(
    credentialFetch(
      {
        label: "test credential request",
        input: "https://vault.example/v1/secret",
        fetch: (async () => response) as typeof fetch,
      },
      async () => assert.fail("cross-origin response must not be consumed"),
    ),
    /rejected a redirected response/,
  );
  assert.equal(response.bodyUsed, true, "rejected response body must be cancelled");
});

test("credential fetch: accepts a same-origin final URL without following a redirect", async () => {
  const response = Response.json({ ok: true });
  Object.defineProperty(response, "url", {
    configurable: true,
    value: "https://vault.example/v1/secret?version=2",
  });

  const result = await credentialFetch(
    {
      label: "test credential request",
      input: new URL("https://vault.example/v1/secret"),
      fetch: (async () => response) as typeof fetch,
    },
    async (value) => (await value.json()) as { ok: boolean },
  );
  assert.deepEqual(result, { ok: true });
});
