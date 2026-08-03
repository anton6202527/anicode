import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeJwt, importSPKI, jwtVerify } from "jose";
import { CredentialBroker } from "../security/credentials.js";
import { GitHubAppInstallationTokenSource } from "./github-app.js";
import { NetworkProxy } from "./network-proxy.js";

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
