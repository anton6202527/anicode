import { test } from "node:test";
import assert from "node:assert/strict";
import { NetworkProxy } from "../runtime/network-proxy.js";
import { CredentialBroker } from "./credentials.js";
import type { SecretBackend } from "./secret-backends.js";

test("CredentialBroker: async reference hydrates once before synchronous adapter consumption", async () => {
  const reads: string[] = [];
  const backend: SecretBackend = {
    kind: "utility-keychain-fixture",
    get: async (key) => {
      reads.push(key);
      return key === "env:OPENAI_API_KEY" ? "async-secret" : undefined;
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "env:OPENAI_API_KEY",
    backend,
    scopes: [
      {
        audiences: ["provider:openai"],
        hosts: ["api.openai.com"],
        header: "authorization",
        headerPrefix: "Bearer ",
      },
    ],
  });

  const request = {
    credentialId: "env:OPENAI_API_KEY",
    audience: "provider:openai",
    host: "api.openai.com",
    ttlMs: 1_000,
    maxUses: 1,
  } as const;
  const coldLease = broker.lease(request);
  assert.throws(() => broker.injectHeaders(coldLease), /Credential requires async trusted access/);
  assert.deepEqual(reads, []);

  const asyncLease = broker.lease(request);
  const asyncHeaders = await broker.injectHeadersAsync(asyncLease);
  assert.equal(asyncHeaders.get("authorization"), "Bearer async-secret");
  assert.deepEqual(reads, ["env:OPENAI_API_KEY"]);

  const cachedLease = broker.lease(request);
  assert.equal(broker.injectHeaders(cachedLease).get("authorization"), "Bearer async-secret");
  assert.deepEqual(reads, ["env:OPENAI_API_KEY"]);
});

test("NetworkProxy: async credential lease is hydrated only after egress authorization", async () => {
  const order: string[] = [];
  const backend: SecretBackend = {
    kind: "utility-keychain-fixture",
    get: async () => {
      order.push("credential");
      return "proxy-async-secret";
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "env:TAVILY_API_KEY",
    backend,
    scopes: [
      {
        audiences: ["network:web-search"],
        hosts: ["search.example.test"],
        tools: ["web_search"],
        header: "authorization",
        headerPrefix: "Bearer ",
      },
    ],
  });
  const proxy = new NetworkProxy({
    broker,
    policy: { allowDomains: ["search.example.test"] },
    resolver: async () => {
      order.push("authorize");
      return ["8.8.8.8"];
    },
    fetch: async (_url, init) => {
      order.push("fetch");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer proxy-async-secret");
      return new Response("ok");
    },
  });
  try {
    const lease = broker.lease({
      credentialId: "env:TAVILY_API_KEY",
      audience: "network:web-search",
      host: "search.example.test",
      tool: "web_search",
      maxUses: 1,
    });
    const response = await proxy.fetch("https://search.example.test/query", {
      credentialLease: lease,
    });
    assert.equal(await response.text(), "ok");
    assert.deepEqual(order, ["authorize", "credential", "fetch"]);
  } finally {
    await proxy.close();
  }
});
