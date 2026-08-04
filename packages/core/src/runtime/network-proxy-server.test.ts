import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import { gzipSync } from "node:zlib";
import {
  NetworkProxy,
  NetworkProxyCredentialAuthority,
  NetworkProxyCredentialClient,
  NetworkProxyServer,
} from "./network-proxy.js";
import { CredentialBroker } from "../security/credentials.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function listenTcp(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function closeTcpServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function basicProxyAuthorization(token: string): string {
  return `Basic ${Buffer.from(`anicode:${token}`).toString("base64")}`;
}

async function openTunnel(
  endpoint: string,
  authority: string,
  token: string,
): Promise<{ socket: net.Socket; status: number }> {
  const proxy = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
    let settled = false;
    let received = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("CONNECT response timeout")), 2_000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
    };
    const finish = (error?: Error, status?: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.pause();
        resolve({ socket, status: status! });
      }
    };
    const onConnect = () => {
      socket.write(
        `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: ${basicProxyAuthorization(token)}\r\n\r\n`,
      );
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const boundary = received.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const match = /^HTTP\/1\.1 (\d{3})/.exec(received.subarray(0, boundary).toString("ascii"));
      if (!match) return finish(new Error("invalid CONNECT response"));
      const remainder = received.subarray(boundary + 4);
      socket.pause();
      if (remainder.length) socket.unshift(remainder);
      finish(undefined, Number(match[1]));
    };
    socket.once("connect", onConnect);
    socket.on("data", onData);
    // A post-handshake reset is an expected rejection signal, so keep it observed after resolve.
    socket.on("error", (error) => {
      if (!settled) finish(error);
    });
  });
}

function waitForSocketClose(socket: net.Socket, timeoutMs = 2_000): Promise<void> {
  if (socket.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error("socket close timeout")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("close", onClose);
    };
    const done = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onClose = () => done();
    socket.once("close", onClose);
  });
}

function waitForSocketText(
  socket: net.Socket,
  expected: string,
  timeoutMs = 2_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let received = "";
    const timer = setTimeout(
      () => done(new Error(`socket did not receive ${expected}`)),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    const done = (error?: Error) => {
      cleanup();
      if (error) reject(error);
      else resolve(received);
    };
    const onData = (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.includes(expected)) done();
    };
    const onClose = () => done(new Error("socket closed before expected response"));
    socket.on("data", onData);
    socket.once("close", onClose);
    socket.resume();
  });
}

function encoded16(value: number): Buffer {
  const result = Buffer.allocUnsafe(2);
  result.writeUInt16BE(value);
  return result;
}

function tlsExtension(type: number, body = Buffer.alloc(0)): Buffer {
  return Buffer.concat([encoded16(type), encoded16(body.length), body]);
}

function tlsClientHello(serverName?: string, encryptedClientHello = false): Buffer {
  const extensions: Buffer[] = [];
  if (serverName) {
    const encodedName = Buffer.from(serverName, "ascii");
    const name = Buffer.concat([Buffer.from([0]), encoded16(encodedName.length), encodedName]);
    extensions.push(tlsExtension(0, Buffer.concat([encoded16(name.length), name])));
  }
  if (encryptedClientHello) extensions.push(tlsExtension(0xfe0d));
  const encodedExtensions = Buffer.concat(extensions);
  const body = Buffer.concat([
    Buffer.from([3, 3]),
    Buffer.alloc(32, 0x5a),
    Buffer.from([0]),
    encoded16(2),
    Buffer.from([0x13, 0x01]),
    Buffer.from([1, 0]),
    ...(extensions.length ? [encoded16(encodedExtensions.length), encodedExtensions] : []),
  ]);
  const handshakeHeader = Buffer.allocUnsafe(4);
  handshakeHeader[0] = 1;
  handshakeHeader.writeUIntBE(body.length, 1, 3);
  const handshake = Buffer.concat([handshakeHeader, body]);
  return Buffer.concat([Buffer.from([22, 3, 1]), encoded16(handshake.length), handshake]);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("operation timed out")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function request(
  endpoint: string,
  target: string,
  token?: string,
  principal = "anicode",
): Promise<{ status: number; body: string }> {
  const proxy = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const outgoing = http.request({
      hostname: proxy.hostname,
      port: proxy.port,
      method: "GET",
      path: target,
      headers: token
        ? {
            "proxy-authorization": `Basic ${Buffer.from(`${principal}:${token}`).toString("base64")}`,
          }
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

test("NetworkProxy: in-process responses have a decoded body limit", async () => {
  let cancelled = false;
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["bounded.anicode.test"] },
    resolver: async () => ["8.8.8.8"],
    maxResponseBytes: 128,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(96));
            controller.enqueue(new Uint8Array(96));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });

  const response = await proxy.fetch("https://bounded.anicode.test/data");
  await assert.rejects(response.arrayBuffer(), /exceeds 128 bytes/);
  assert.equal(cancelled, true);
});

test("NetworkProxy: oversized declared response is rejected before consumption", async () => {
  let cancelled = false;
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["bounded.anicode.test"] },
    resolver: async () => ["8.8.8.8"],
    maxResponseBytes: 128,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-length": "129" } },
      ),
  });

  await assert.rejects(proxy.fetch("https://bounded.anicode.test/data"), /exceeds 128 bytes/);
  assert.equal(cancelled, true);
});

test("NetworkProxyServer: execution-scoped credentials expire, revoke, redact, and reject reuse", async () => {
  const upstream = http.createServer((_request, response) => response.end("scoped"));
  const upstreamPort = await listen(upstream);
  const proxy = new NetworkProxy({
    policy: {
      allowDomains: ["scoped.anicode.test"],
      allowPorts: [upstreamPort],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  const rootToken = "proxy-control-root-token-that-stays-in-control-plane";
  let now = Date.now();
  const authority = new NetworkProxyCredentialAuthority({ now: () => now, maxTtlMs: 60_000 });
  const server = new NetworkProxyServer({
    proxy,
    clientToken: rootToken,
    credentialAuthority: authority,
  });
  try {
    const endpoint = await server.listen();
    const endpointUrl = new URL(endpoint);
    const broker = new CredentialBroker();
    broker.register({
      id: "proxy-control",
      value: rootToken,
      scopes: [
        {
          audiences: ["network-proxy-control"],
          hosts: [endpointUrl.hostname],
          tools: ["issue", "revoke"],
          header: "authorization",
          headerPrefix: "Bearer ",
        },
      ],
    });
    const issuer = new NetworkProxyCredentialClient({
      broker,
      credentialId: "proxy-control",
    });
    const target = `http://scoped.anicode.test:${upstreamPort}/`;
    assert.equal(
      (await request(endpoint, target, rootToken)).status,
      407,
      "the long-lived control credential must never authenticate a runner request",
    );
    const lease = await issuer.issue({
      proxyUrl: endpoint,
      tenantId: "tenant-a",
      executionId: "job-a",
      ttlMs: 30_000,
    });
    const credentialUrl = new URL(lease.proxyUrl);
    assert.notEqual(credentialUrl.password, rootToken, "runner must not receive the control token");
    assert.equal((await request(endpoint, target, credentialUrl.password, "job-b")).status, 407);
    assert.deepEqual(
      await request(endpoint, target, credentialUrl.password, credentialUrl.username),
      { status: 200, body: "scoped" },
    );
    assert.equal(
      lease.redact(`HTTP_PROXY=${lease.proxyUrl}`).includes(credentialUrl.password),
      false,
    );
    await lease.revoke();
    assert.equal(
      (await request(endpoint, target, credentialUrl.password, credentialUrl.username)).status,
      407,
    );

    const expiring = authority.issue({
      tenantId: "tenant-a",
      executionId: "job-exp",
      ttlMs: 1_000,
    });
    now += 1_001;
    assert.equal((await request(endpoint, target, expiring.token, expiring.principal)).status, 407);

    const sourceBound = authority.issue({
      tenantId: "tenant-a",
      executionId: "job-source",
      ttlMs: 30_000,
    });
    assert.equal(
      authority.authenticate({
        principal: sourceBound.principal,
        token: sourceBound.token,
        sourceAddress: "10.0.0.10",
      }),
      true,
    );
    assert.equal(
      authority.authenticate({
        principal: sourceBound.principal,
        token: sourceBound.token,
        sourceAddress: "10.0.0.11",
      }),
      false,
      "a capability first used by one job address must not be reusable from another",
    );
  } finally {
    await server.close();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("NetworkProxy credential control uses a separate HTTPS origin from the runner proxy", async () => {
  const rootToken = "separate-control-plane-token-that-must-use-tls";
  const broker = new CredentialBroker();
  broker.register({
    id: "proxy-control",
    value: rootToken,
    scopes: [
      {
        audiences: ["network-proxy-control"],
        hosts: ["control.proxy.example"],
        tools: ["issue", "revoke"],
        header: "authorization",
        headerPrefix: "Bearer ",
      },
    ],
  });
  const seen: string[] = [];
  const issuer = new NetworkProxyCredentialClient({
    broker,
    credentialId: "proxy-control",
    controlUrl: "https://control.proxy.example",
    fetch: (async (input, init) => {
      seen.push(String(input));
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${rootToken}`);
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json(
        {
          id: "pc_00000000-0000-4000-8000-000000000000",
          principal: "job-test-principal",
          token: "execution-token-with-at-least-32-characters",
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        },
        { status: 201 },
      );
    }) as typeof fetch,
  });
  const lease = await issuer.issue({
    proxyUrl: "http://runner-proxy.internal:8080",
    tenantId: "tenant-a",
    executionId: "job-a",
    ttlMs: 30_000,
  });
  assert.match(lease.proxyUrl, /^http:\/\/job-test-principal:/);
  assert.equal(seen[0], "https://control.proxy.example/.well-known/anicode/proxy-credentials");
  await lease.revoke();
  assert.equal(seen.length, 2);

  const unsafe = new NetworkProxyCredentialClient({
    broker,
    credentialId: "proxy-control",
    fetch: (async () => assert.fail("plaintext control request must not be sent")) as typeof fetch,
  });
  await assert.rejects(
    () =>
      unsafe.issue({
        proxyUrl: "http://runner-proxy.internal:8080",
        tenantId: "tenant-a",
        executionId: "job-b",
        ttlMs: 30_000,
      }),
    /Non-loopback.*must use HTTPS/,
  );
});

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

test("NetworkProxyServer: CONNECT only opens upstream after a matching TLS SNI", async (t) => {
  let upstreamHits = 0;
  const upstreamSockets = new Set<net.Socket>();
  const upstream = net.createServer((socket) => {
    upstreamHits++;
    upstreamSockets.add(socket);
    socket.once("close", () => upstreamSockets.delete(socket));
    socket.once("data", () => socket.write("upstream-ok"));
  });
  const upstreamPort = await listenTcp(upstream);
  const proxy = new NetworkProxy({
    policy: {
      allowDomains: ["allowed.anicode.test"],
      allowPorts: [upstreamPort],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  const token = "connect-proxy-token-that-is-long-enough";
  const server = new NetworkProxyServer({
    proxy,
    clientToken: token,
    tlsClientHelloTimeoutMs: 250,
    maxTlsClientHelloBytes: 2_048,
  });
  try {
    const endpoint = await server.listen();
    await t.test("a fragmented matching ClientHello reaches the pinned upstream", async () => {
      const { socket, status } = await openTunnel(
        endpoint,
        `allowed.anicode.test:${upstreamPort}`,
        token,
      );
      assert.equal(status, 200);
      const hello = tlsClientHello("allowed.anicode.test");
      const response = waitForSocketText(socket, "upstream-ok");
      socket.write(hello.subarray(0, 7));
      await new Promise<void>((resolve) => setImmediate(resolve));
      socket.write(hello.subarray(7));
      assert.match(await response, /upstream-ok/);
      socket.destroy();
      await waitForSocketClose(socket);
      assert.equal(upstreamHits, 1);
    });

    const denied: Array<[string, Buffer | undefined]> = [
      ["mismatched SNI", tlsClientHello("different.anicode.test")],
      ["missing SNI", tlsClientHello()],
      ["encrypted ClientHello", tlsClientHello("allowed.anicode.test", true)],
      ["non-TLS bytes", Buffer.from("GET / HTTP/1.1\r\n\r\n")],
      ["ClientHello timeout", undefined],
    ];
    for (const [name, payload] of denied) {
      await t.test(`${name} is closed before an upstream socket exists`, async () => {
        const { socket, status } = await openTunnel(
          endpoint,
          `allowed.anicode.test:${upstreamPort}`,
          token,
        );
        assert.equal(status, 200);
        const closed = waitForSocketClose(socket);
        if (payload) socket.write(payload);
        socket.resume();
        await closed;
        assert.equal(upstreamHits, 1);
      });
    }
  } finally {
    await server.close();
    await proxy.close();
    for (const socket of upstreamSockets) socket.destroy();
    await closeTcpServer(upstream);
  }
});

test("NetworkProxyServer: strips Host and RFC hop-by-hop request/response headers", async () => {
  let receivedHeaders: http.IncomingHttpHeaders | undefined;
  const upstream = http.createServer((request, response) => {
    receivedHeaders = request.headers;
    response.writeHead(200, {
      connection: "x-upstream-hop",
      "x-upstream-hop": "must-not-leak",
      "x-end-to-end": "preserved",
    });
    response.end("clean");
  });
  const upstreamPort = await listen(upstream);
  const proxy = new NetworkProxy({
    policy: {
      allowDomains: ["headers.anicode.test"],
      allowPorts: [upstreamPort],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  const token = "headers-proxy-token-that-is-long-enough";
  const server = new NetworkProxyServer({ proxy, clientToken: token });
  try {
    const endpoint = new URL(await server.listen());
    const result = await new Promise<{
      status: number;
      body: string;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const outgoing = http.request({
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: "GET",
        path: `http://headers.anicode.test:${upstreamPort}/resource`,
        headers: {
          host: "spoofed.invalid",
          connection: "x-client-hop",
          "x-client-hop": "must-not-leak",
          "proxy-connection": "keep-alive",
          "proxy-authorization": basicProxyAuthorization(token),
          "x-end-to-end": "preserved",
        },
      });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
      });
      outgoing.end();
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, "clean");
    assert.equal(result.headers["x-upstream-hop"], undefined);
    assert.equal(result.headers["x-end-to-end"], "preserved");
    assert.equal(receivedHeaders?.host, `headers.anicode.test:${upstreamPort}`);
    assert.equal(receivedHeaders?.["x-client-hop"], undefined);
    assert.equal(receivedHeaders?.["proxy-connection"], undefined);
    assert.equal(receivedHeaders?.["proxy-authorization"], undefined);
    assert.equal(receivedHeaders?.["x-end-to-end"], "preserved");
  } finally {
    await server.close();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("NetworkProxyServer: strips stale representation headers after fetch decompression", async () => {
  const body = "decoded proxy response";
  const compressed = gzipSync(body);
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, {
      "content-encoding": "gzip",
      "content-length": String(compressed.byteLength),
      "content-type": "text/plain; charset=utf-8",
    });
    response.end(compressed);
  });
  const upstreamPort = await listen(upstream);
  const proxy = new NetworkProxy({
    policy: {
      allowDomains: ["compressed.anicode.test"],
      allowPorts: [upstreamPort],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  const token = "compressed-proxy-token-that-is-long-enough";
  const server = new NetworkProxyServer({ proxy, clientToken: token });
  try {
    const endpoint = new URL(await server.listen());
    const result = await new Promise<{
      body: string;
      headers: http.IncomingHttpHeaders;
    }>((resolve, reject) => {
      const outgoing = http.request({
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: "GET",
        path: `http://compressed.anicode.test:${upstreamPort}/resource`,
        headers: { "proxy-authorization": basicProxyAuthorization(token) },
      });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () =>
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
      });
      outgoing.end();
    });
    assert.equal(result.body, body);
    assert.equal(result.headers["content-encoding"], undefined);
    assert.equal(result.headers["content-length"], undefined);
    assert.match(String(result.headers["content-type"]), /^text\/plain/);
  } finally {
    await server.close();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("NetworkProxyServer: downstream disconnect aborts the upstream response", async () => {
  let markUpstreamClosed!: () => void;
  const upstreamClosed = new Promise<void>((resolve) => {
    markUpstreamClosed = resolve;
  });
  const upstream = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.write(Buffer.alloc(64 * 1024, 0x61));
    const interval = setInterval(() => response.write(Buffer.alloc(8 * 1024, 0x62)), 10);
    response.once("close", () => {
      clearInterval(interval);
      markUpstreamClosed();
    });
  });
  const upstreamPort = await listen(upstream);
  const proxy = new NetworkProxy({
    policy: {
      allowDomains: ["abort.anicode.test"],
      allowPorts: [upstreamPort],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  const token = "abort-proxy-token-that-is-long-enough";
  const server = new NetworkProxyServer({ proxy, clientToken: token });
  try {
    const endpoint = new URL(await server.listen());
    await new Promise<void>((resolve, reject) => {
      const outgoing = http.request({
        hostname: endpoint.hostname,
        port: endpoint.port,
        path: `http://abort.anicode.test:${upstreamPort}/stream`,
        headers: { "proxy-authorization": basicProxyAuthorization(token) },
      });
      outgoing.once("error", reject);
      outgoing.once("response", (response) => {
        response.once("data", () => {
          response.destroy();
          resolve();
        });
      });
      outgoing.end();
    });
    await withTimeout(upstreamClosed);
  } finally {
    await server.close();
    await proxy.close();
    await closeServer(upstream);
  }
});

test("NetworkProxy: DNS-pinned dispatcher cache is bounded and LRU", async () => {
  const upstream = http.createServer((_request, response) => response.end("ok"));
  const upstreamPort = await listen(upstream);
  const proxy = new NetworkProxy({
    maxPinnedAgents: 3,
    policy: {
      allowDomains: ["*.cache.anicode.test"],
      allowPorts: [upstreamPort],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  try {
    for (let index = 0; index < 12; index++) {
      const response = await proxy.fetch(
        `http://origin-${index}.cache.anicode.test:${upstreamPort}/`,
      );
      assert.equal(await response.text(), "ok");
    }
    const pinnedAgents = (proxy as unknown as { pinnedAgents: Map<string, unknown> }).pinnedAgents;
    assert.equal(pinnedAgents.size, 3);
    assert.deepEqual(
      [...pinnedAgents.keys()].map((key) => /origin-(\d+)/.exec(key)?.[1]),
      ["9", "10", "11"],
    );
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});

test("NetworkProxy: credentialed cross-origin redirects fail closed before the second server", async () => {
  let originAuthorization: string | undefined;
  let targetHits = 0;
  const target = http.createServer((_request, response) => {
    targetHits++;
    response.end("credential leaked");
  });
  const targetPort = await listen(target);
  const origin = http.createServer((request, response) => {
    originAuthorization = request.headers.authorization;
    response.writeHead(302, { location: `http://target.anicode.test:${targetPort}/secret` });
    response.end();
  });
  const originPort = await listen(origin);
  const broker = new CredentialBroker();
  broker.register({
    id: "upstream",
    value: "broker-secret",
    scopes: [
      {
        audiences: ["network-proxy"],
        hosts: ["origin.anicode.test"],
        header: "authorization",
        headerPrefix: "Bearer ",
      },
    ],
  });
  const lease = broker.lease({
    credentialId: "upstream",
    audience: "network-proxy",
    host: "origin.anicode.test",
  });
  const proxy = new NetworkProxy({
    broker,
    policy: {
      allowDomains: ["origin.anicode.test", "target.anicode.test"],
      allowPorts: [originPort, targetPort],
      allowPrivateAddresses: true,
    },
    resolver: async () => ["127.0.0.1"],
  });
  try {
    await assert.rejects(
      () =>
        proxy.fetch(`http://origin.anicode.test:${originPort}/start`, {
          credentialLease: lease,
        }),
      /Credentialed cross-origin redirect denied/,
    );
    assert.equal(originAuthorization, "Bearer broker-secret");
    assert.equal(targetHits, 0, "redirect target must not receive a credentialed request");
  } finally {
    await proxy.close();
    await closeServer(origin);
    await closeServer(target);
  }
});

test("NetworkProxy: every redirect hop is re-authorized against private-address policy", async () => {
  let targetHits = 0;
  const target = http.createServer((_request, response) => {
    targetHits++;
    response.end("should not be reached");
  });
  const targetPort = await listen(target);
  const redirector = http.createServer((_request, response) => {
    response.writeHead(302, { location: `http://127.0.0.1:${targetPort}/metadata` });
    response.end();
  });
  const redirectorPort = await listen(redirector);
  const proxy = new NetworkProxy({
    policy: {
      allowDomains: ["*"],
      allowPorts: [redirectorPort, targetPort],
    },
    resolver: async () => ["93.184.216.34"],
    fetch: async (_input, init) => fetch(`http://127.0.0.1:${redirectorPort}/redirect`, init),
  });
  try {
    await assert.rejects(
      () => proxy.fetch(`http://redirector.anicode.test:${redirectorPort}/start`),
      /private, loopback, link-local or reserved/,
    );
    assert.equal(targetHits, 0, "a redirect must not bypass SSRF authorization");
  } finally {
    await proxy.close();
    await closeServer(redirector);
    await closeServer(target);
  }
});

test("NetworkProxy: redirect method and body behavior follows HTTP semantics", async () => {
  const received: { method: string; body: string }[] = [];
  const upstream = http.createServer(async (request, response) => {
    if (request.url?.startsWith("/redirect/")) {
      const status = Number(request.url.split("/").pop());
      response.writeHead(status, { location: "/target" });
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push({
      method: request.method ?? "",
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.end("ok");
  });
  const port = await listen(upstream);
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["127.0.0.1"], allowPorts: [port], allowPrivateAddresses: true },
  });
  try {
    for (const status of [301, 302, 303]) {
      const response = await proxy.fetch(`http://127.0.0.1:${port}/redirect/${status}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: `post-${status}`,
      });
      await response.text();
    }
    const put = await proxy.fetch(`http://127.0.0.1:${port}/redirect/302`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: "put-302",
    });
    await put.text();
    const head = await proxy.fetch(`http://127.0.0.1:${port}/redirect/303`, { method: "HEAD" });
    await head.text();

    assert.deepEqual(received, [
      { method: "GET", body: "" },
      { method: "GET", body: "" },
      { method: "GET", body: "" },
      { method: "PUT", body: "put-302" },
      { method: "HEAD", body: "" },
    ]);
  } finally {
    await proxy.close();
    await closeServer(upstream);
  }
});
