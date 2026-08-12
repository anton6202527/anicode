import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt, importSPKI, jwtVerify } from "jose";
import { CredentialBroker } from "../security/credentials.js";
import { GitHubAppInstallationTokenSource } from "./github-app.js";
import { NetworkProxy } from "./network-proxy.js";

async function capturedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected promise to reject");
}

test("GitHub App token source: RS256 JWT、repository scope、cache 与强制轮换", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const broker = new CredentialBroker();
  broker.register({
    id: "github-key",
    value: privatePem,
    scopes: [
      {
        audiences: ["github-app-auth"],
        hosts: ["api.github.test"],
        tools: ["sign-installation-token"],
      },
    ],
  });
  let now = Date.parse("2026-07-30T08:00:00.000Z");
  const authorizations: string[] = [];
  const requests: Array<Record<string, unknown>> = [];
  const proxy = new NetworkProxy({
    resolver: async () => ["93.184.216.34"],
    fetch: async (_target, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        token: `ghs_${requests.length}`,
        expires_at: new Date(now + 60 * 60_000).toISOString(),
        repositories: [{ full_name: "owner/repo" }],
      });
    },
  });
  const source = new GitHubAppInstallationTokenSource({
    appId: 123,
    installationId: 456,
    owner: "owner",
    repo: "repo",
    broker,
    privateKeyCredentialId: "github-key",
    proxy,
    apiBase: "https://api.github.test",
    now: () => now,
  });
  assert.equal(await source.token(), "ghs_1");
  assert.equal(await source.token(), "ghs_1");
  assert.equal(requests.length, 1);
  assert.equal(await source.token(true), "ghs_2");
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0]?.["repositories"], ["repo"]);
  assert.equal((requests[0]?.["permissions"] as Record<string, string>)["contents"], "write");
  const jwt = authorizations[0]!.replace(/^Bearer /, "");
  assert.equal(decodeJwt(jwt).iss, "123");
  await jwtVerify(jwt, await importSPKI(publicPem, "RS256"), {
    issuer: "123",
    currentDate: new Date(now),
  });
  now += 56 * 60_000;
  assert.equal(await source.token(), "ghs_3");
});

test("GitHub App token source: non-cooperative token exchange has a hard abort deadline", async (t) => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const broker = new CredentialBroker();
  broker.register({
    id: "github-key",
    value: privatePem,
    scopes: [
      {
        audiences: ["github-app-auth"],
        hosts: ["api.github.test"],
        tools: ["sign-installation-token"],
      },
    ],
  });
  let requestSignal: AbortSignal | undefined;
  let installationJwt = "";
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const proxy = new NetworkProxy({
    resolver: async () => ["93.184.216.34"],
    fetch: async (_target, init) => {
      requestSignal = init?.signal ?? undefined;
      installationJwt = new Headers(init?.headers).get("authorization") ?? "";
      requestStarted();
      return new Promise<Response>(() => undefined);
    },
  });
  const source = new GitHubAppInstallationTokenSource({
    appId: 123,
    installationId: 456,
    owner: "owner",
    repo: "repo",
    broker,
    privateKeyCredentialId: "github-key",
    proxy,
    apiBase: "https://api.github.test",
    requestTimeoutMs: 20,
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const token = source.token();
  await started;
  assert.ok(requestSignal, "token exchange fetch must start before the deadline is advanced");
  t.mock.timers.tick(20);
  const error = await capturedError(token);
  assert.match(error.message, /timed out after 20ms/);
  assert.equal(requestSignal?.aborted, true);
  assert.ok(installationJwt.startsWith("Bearer "));
  assert.doesNotMatch(error.stack ?? error.message, new RegExp(installationJwt.slice(7)));
});

test("GitHub App token source: oversized token responses are cancelled", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const broker = new CredentialBroker();
  broker.register({
    id: "github-key",
    value: privatePem,
    scopes: [
      {
        audiences: ["github-app-auth"],
        hosts: ["api.github.test"],
        tools: ["sign-installation-token"],
      },
    ],
  });
  let cancelled = false;
  const proxy = new NetworkProxy({
    resolver: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(Buffer.from(JSON.stringify({ token: "x".repeat(256) })));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  const source = new GitHubAppInstallationTokenSource({
    appId: 123,
    installationId: 456,
    owner: "owner",
    repo: "repo",
    broker,
    privateKeyCredentialId: "github-key",
    proxy,
    apiBase: "https://api.github.test",
    maxResponseBytes: 64,
  });
  await assert.rejects(source.token(), /response exceeds 64 bytes/);
  assert.equal(cancelled, true);
});

test("GitHub App token source: one aborted waiter cannot cancel a shared mint", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const broker = new CredentialBroker();
  broker.register({
    id: "github-key",
    value: privatePem,
    scopes: [
      {
        audiences: ["github-app-auth"],
        hosts: ["api.github.test"],
        tools: ["sign-installation-token"],
      },
    ],
  });
  let resolveMint!: (response: Response) => void;
  let mintStarted!: () => void;
  const mint = new Promise<Response>((resolve) => {
    resolveMint = resolve;
  });
  const started = new Promise<void>((resolve) => {
    mintStarted = resolve;
  });
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  const proxy = new NetworkProxy({
    resolver: async () => ["93.184.216.34"],
    fetch: async (_target, init) => {
      calls++;
      requestSignal = init?.signal ?? undefined;
      mintStarted();
      return mint;
    },
  });
  const now = Date.parse("2026-07-30T08:00:00.000Z");
  const source = new GitHubAppInstallationTokenSource({
    appId: 123,
    installationId: 456,
    owner: "owner",
    repo: "repo",
    broker,
    privateKeyCredentialId: "github-key",
    proxy,
    apiBase: "https://api.github.test",
    now: () => now,
  });
  const controller = new AbortController();
  const disconnected = source.token(false, controller.signal);
  const healthy = source.token();
  await started;
  controller.abort();
  await assert.rejects(disconnected, /GitHub installation token request was cancelled/);
  assert.equal(requestSignal?.aborted, false);
  resolveMint(
    Response.json({
      token: "ghs_shared",
      expires_at: new Date(now + 60 * 60_000).toISOString(),
      repositories: [{ full_name: "owner/repo" }],
    }),
  );
  assert.equal(await healthy, "ghs_shared");
  assert.equal(await source.token(), "ghs_shared");
  assert.equal(calls, 1);
});
