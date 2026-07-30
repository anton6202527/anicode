import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { NetworkProxy, NetworkProxyServer } from "./network-proxy.js";

function request(
  endpoint: string,
  target: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  const proxy = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: "GET",
      path: target,
      headers: token
        ? { "proxy-authorization": `Basic ${Buffer.from(`anicode:${token}`).toString("base64")}` }
        : {},
    });
    outgoing.once("error", reject);
    outgoing.once("response", (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    outgoing.end();
  });
}

test("NetworkProxyServer: client authentication and streamed response boundary", async () => {
  const upstream = http.createServer((_request, response) => response.end("proxied"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const policy = new NetworkProxy({
    policy: {
      allowDomains: ["upstream.anicode.test"],
      allowPorts: [address.port],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  const token = "proxy-test-token-that-is-long-enough";
  const server = new NetworkProxyServer({ proxy: policy, clientToken: token });
  try {
    const endpoint = await server.listen();
    const target = `http://upstream.anicode.test:${address.port}/resource`;
    assert.equal((await request(endpoint, target)).status, 407);
    assert.deepEqual(await request(endpoint, target, token), { status: 200, body: "proxied" });
    assert.equal((await request(endpoint, target, "wrong-token")).status, 407);
  } finally {
    await server.close();
    await policy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("NetworkProxyServer: 动态 Broker 凭证轮换无需重启代理", async () => {
  const upstream = http.createServer((_request, response) => response.end("rotated"));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const policy = new NetworkProxy({
    policy: {
      allowDomains: ["rotation.anicode.test"],
      allowPorts: [address.port],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  let token = "first-proxy-token-that-is-long-enough";
  const server = new NetworkProxyServer({
    proxy: policy,
    clientTokenProvider: async () => token,
  });
  try {
    const endpoint = await server.listen();
    const target = `http://rotation.anicode.test:${address.port}/`;
    assert.equal((await request(endpoint, target, token)).status, 200);
    const previous = token;
    token = "second-proxy-token-that-is-long-enough";
    assert.equal((await request(endpoint, target, previous)).status, 407);
    assert.deepEqual(await request(endpoint, target, token), { status: 200, body: "rotated" });
  } finally {
    await server.close();
    await policy.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
