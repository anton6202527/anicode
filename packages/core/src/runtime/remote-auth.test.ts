import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportJWK, SignJWT } from "jose";
import { createRemoteOidcAuthenticator } from "./remote-auth.js";

async function capturedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected promise to reject");
}

async function oidcFixture() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicJwk = await exportJWK(publicKey);
  Object.assign(publicJwk, { kid: "test-key", alg: "RS256", use: "sig" });
  const issuer = "https://issuer.example";
  const audience = "anicode-runtime";
  const token = await new SignJWT({ tenant_id: "tenant-a" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("actor-a")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { publicJwk, issuer, audience, token };
}

function incoming(token: string): IncomingMessage {
  return Object.assign(new EventEmitter(), {
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as IncomingMessage;
}

test("Remote OIDC: bounded JWKS fetch verifies a valid token", async () => {
  const fixture = await oidcFixture();
  const authenticate = createRemoteOidcAuthenticator({
    issuer: fixture.issuer,
    audience: fixture.audience,
    jwksUri: "https://issuer.example/.well-known/jwks.json",
    fetch: (async () => Response.json({ keys: [fixture.publicJwk] })) as typeof fetch,
  });
  const verified = await authenticate(incoming(fixture.token));
  assert.equal(verified.actor, "actor-a");
  assert.equal(verified.claims.tenant_id, "tenant-a");
});

test("Remote OIDC: non-cooperative JWKS fetch is hard-bounded and aborted", async () => {
  const fixture = await oidcFixture();
  let requestSignal: AbortSignal | undefined;
  const authenticate = createRemoteOidcAuthenticator({
    issuer: fixture.issuer,
    audience: fixture.audience,
    jwksUri: "https://issuer.example/.well-known/jwks.json",
    requestTimeoutMs: 20,
    fetch: (async (_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    }) as typeof fetch,
  });
  const started = Date.now();
  await assert.rejects(authenticate(incoming(fixture.token)), /timed out after 20ms|was cancelled/);
  assert.equal(requestSignal?.aborted, true);
  assert.ok(Date.now() - started < 500);
});

test("Remote OIDC: oversized JWKS and transport errors cannot expose bearer tokens", async () => {
  const fixture = await oidcFixture();
  let cancelled = false;
  const oversized = createRemoteOidcAuthenticator({
    issuer: fixture.issuer,
    audience: fixture.audience,
    jwksUri: "https://issuer.example/.well-known/jwks.json",
    maxResponseBytes: 64,
    fetch: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from(JSON.stringify({ keys: [fixture.publicJwk] })));
          },
          cancel() {
            cancelled = true;
          },
        }),
      )) as typeof fetch,
  });
  await assert.rejects(oversized(incoming(fixture.token)), /response exceeds 64 bytes/);
  assert.equal(cancelled, true);

  const leaking = createRemoteOidcAuthenticator({
    issuer: fixture.issuer,
    audience: fixture.audience,
    jwksUri: "https://issuer.example/.well-known/jwks.json",
    fetch: (async () => {
      throw new Error(`transport echoed ${fixture.token}`);
    }) as typeof fetch,
  });
  const error = await capturedError(leaking(incoming(fixture.token)));
  assert.doesNotMatch(error.stack ?? error.message, new RegExp(fixture.token));
});

test("Remote OIDC: oversized Authorization headers are rejected before JWKS I/O", async () => {
  let fetchCalls = 0;
  const authenticate = createRemoteOidcAuthenticator({
    issuer: "https://issuer.example",
    audience: "anicode-runtime",
    jwksUri: "https://issuer.example/.well-known/jwks.json",
    fetch: (async () => {
      fetchCalls++;
      return Response.json({ keys: [] });
    }) as typeof fetch,
  });
  await assert.rejects(authenticate(incoming("x".repeat(64 * 1024))), /token is too large/);
  assert.equal(fetchCalls, 0);
});
