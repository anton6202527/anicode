/**
 * web_search：可插拔搜索工具。响应解析是纯函数（离线测），网络 fetch 可注入。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWebSearchTool,
  formatSearchResults,
  parseTavilyResponse,
  parseBraveResponse,
  selectBrokerWebSearch,
  tavilyBackend,
  webSearchBackendFromEnv,
  webSearchBackendFromBroker,
  type WebSearchBackend,
} from "./web-search.js";
import { ToolError } from "./tool.js";
import { CredentialBroker, credentialScopesForEnvironment } from "../security/credentials.js";
import { NetworkProxy } from "../runtime/network-proxy.js";

const ctx = () => ({ cwd: process.cwd(), signal: new AbortController().signal });

test("parseTavilyResponse: results→统一结果，丢弃无 url 项", () => {
  const out = parseTavilyResponse({
    results: [{ title: "A", url: "https://a.test", content: "snippet a" }, { title: "no-url" }],
  });
  assert.deepEqual(out, [{ title: "A", url: "https://a.test", snippet: "snippet a" }]);
});

test("parseBraveResponse: web.results→统一结果", () => {
  const out = parseBraveResponse({
    web: { results: [{ title: "B", url: "https://b.test", description: "desc b" }] },
  });
  assert.deepEqual(out, [{ title: "B", url: "https://b.test", snippet: "desc b" }]);
});

test("parseBraveResponse: 结构缺失时返回空数组而不抛", () => {
  assert.deepEqual(parseBraveResponse({}), []);
  assert.deepEqual(parseBraveResponse(null), []);
});

test("formatSearchResults: 编号 + URL + 摘要，并提示可 webfetch", () => {
  const out = formatSearchResults("q", [
    { title: "标题", url: "https://x.test", snippet: "一段摘要" },
  ]);
  assert.match(out, /1\. 标题/);
  assert.match(out, /https:\/\/x\.test/);
  assert.match(out, /一段摘要/);
  assert.match(out, /webfetch/);
});

test("formatSearchResults: 空结果给出无结果提示", () => {
  assert.match(formatSearchResults("找不到的东西", []), /web_search/);
});

test("createWebSearchTool: 调用后端并格式化；query 为空报错", async () => {
  const backend: WebSearchBackend = async (q) => [
    { title: `for ${q}`, url: "https://r.test", snippet: "s" },
  ];
  const tool = createWebSearchTool(backend);
  assert.equal(tool.readOnly, true);
  const out = await tool.run({ query: "typescript 5.6" }, ctx());
  assert.match(out, /for typescript 5\.6/);
  await assert.rejects(() => tool.run({ query: "  " }, ctx()), ToolError);
});

test("createWebSearchTool: 后端抛错被包成 ToolError（不外溢）", async () => {
  const backend: WebSearchBackend = async () => {
    throw new Error("upstream 503");
  };
  const tool = createWebSearchTool(backend);
  await assert.rejects(() => tool.run({ query: "x" }, ctx()), /web_search/);
});

test("createWebSearchTool: count 被夹到 [1,10]", async () => {
  let received = 0;
  const backend: WebSearchBackend = async (_q, o) => {
    received = o.count ?? -1;
    return [];
  };
  const tool = createWebSearchTool(backend);
  await tool.run({ query: "x", count: 999 }, ctx());
  assert.equal(received, 10);
});

test("tavilyBackend: 注入 fetch，POST 带 api_key 与 query，解析结果", async () => {
  let sentUrl = "";
  let sentBody: any = null;
  const fakeFetch = (async (url: any, init: any) => {
    sentUrl = String(url);
    sentBody = JSON.parse(init.body);
    return new Response(
      JSON.stringify({ results: [{ title: "T", url: "https://t.test", content: "c" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  const backend = tavilyBackend({ apiKey: "k-123", fetchImpl: fakeFetch });
  const results = await backend("hello", { signal: new AbortController().signal, count: 3 });
  assert.match(sentUrl, /tavily/);
  assert.equal(sentBody.api_key, "k-123");
  assert.equal(sentBody.query, "hello");
  assert.equal(sentBody.max_results, 3);
  assert.deepEqual(results, [{ title: "T", url: "https://t.test", snippet: "c" }]);
});

test("webSearchBackendFromEnv: 默认拒绝进程密钥，仅显式 legacy 模式兼容", () => {
  assert.throws(() => webSearchBackendFromEnv({ TAVILY_API_KEY: "x" } as any), /Broker/);
  assert.ok(
    webSearchBackendFromEnv({
      BRAVE_SEARCH_API_KEY: "y",
      ANICODE_ALLOW_LEGACY_SECRET_ENV: "1",
    } as any),
  );
  assert.equal(webSearchBackendFromEnv({} as any), undefined);
});

test("selectBrokerWebSearch: 只读元数据且 Tavily 优先、Brave fallback", () => {
  let backendReads = 0;
  const lazyBackend = {
    kind: "fake-search-secrets",
    async get() {
      backendReads++;
      return "must-not-read-during-selection";
    },
    async put() {},
    async delete() {
      return true;
    },
  };
  const broker = new CredentialBroker();

  assert.equal(selectBrokerWebSearch(broker), undefined);
  broker.register({
    id: "env:BRAVE_SEARCH_API_KEY",
    value: "brave-secret",
    scopes: credentialScopesForEnvironment("BRAVE_SEARCH_API_KEY"),
  });
  assert.deepEqual(selectBrokerWebSearch(broker), {
    provider: "brave",
    credentialId: "env:BRAVE_SEARCH_API_KEY",
    credentialAvailability: "available",
  });

  broker.registerAsyncReference({
    id: "env:TAVILY_API_KEY",
    backend: lazyBackend,
    backendKey: "env:TAVILY_API_KEY",
    scopes: credentialScopesForEnvironment("TAVILY_API_KEY"),
  });
  assert.deepEqual(selectBrokerWebSearch(broker), {
    provider: "tavily",
    credentialId: "env:TAVILY_API_KEY",
    credentialAvailability: "configured",
  });
  assert.equal(backendReads, 0, "metadata selection must never hydrate the lazy credential");

  broker.revoke("env:TAVILY_API_KEY");
  assert.equal(selectBrokerWebSearch(broker)?.provider, "brave");
  assert.equal(backendReads, 0);
});

test("webSearchBackendFromBroker: secret 由 NetworkProxy 限域注入且不进 body", async () => {
  const broker = new CredentialBroker();
  broker.register({
    id: "env:TAVILY_API_KEY",
    value: "tavily-secret",
    scopes: credentialScopesForEnvironment("TAVILY_API_KEY"),
  });
  let headers = new Headers();
  let body = "";
  const proxy = new NetworkProxy({
    broker,
    policy: { allowDomains: ["api.tavily.com"] },
    resolver: async () => ["93.184.216.34"],
    fetch: (async (_url, init) => {
      headers = new Headers(init?.headers);
      body = String(init?.body ?? "");
      return Response.json({ results: [{ title: "T", url: "https://t.test" }] });
    }) as typeof fetch,
  });
  try {
    const backend = webSearchBackendFromBroker({ provider: "tavily", broker, proxy });
    assert.equal((await backend("query", { signal: new AbortController().signal })).length, 1);
    assert.equal(headers.get("authorization"), "Bearer tavily-secret");
    assert.ok(!body.includes("tavily-secret"));
  } finally {
    await proxy.close();
  }
});

test("webSearchBackendFromBroker: lazy reference is read once on first real search", async () => {
  let backendReads = 0;
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "env:TAVILY_API_KEY",
    backend: {
      kind: "fake-lazy-search",
      async get() {
        backendReads++;
        return "lazy-tavily-secret";
      },
      async put() {},
      async delete() {
        return true;
      },
    },
    backendKey: "env:TAVILY_API_KEY",
    scopes: credentialScopesForEnvironment("TAVILY_API_KEY"),
  });
  const proxy = new NetworkProxy({
    broker,
    policy: { allowDomains: ["api.tavily.com"] },
    resolver: async () => ["93.184.216.34"],
    fetch: (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer lazy-tavily-secret");
      return Response.json({ results: [] });
    }) as typeof fetch,
  });
  try {
    assert.equal(selectBrokerWebSearch(broker)?.credentialAvailability, "configured");
    assert.equal(backendReads, 0);
    const backend = webSearchBackendFromBroker({ provider: "tavily", broker, proxy });
    await backend("first", { signal: new AbortController().signal });
    await backend("second", { signal: new AbortController().signal });
    assert.equal(backendReads, 1, "the broker cache must avoid reopening the lazy backend");
  } finally {
    await proxy.close();
  }
});

test("webSearchBackendFromBroker: network policy denial happens before lazy credential read", async () => {
  let backendReads = 0;
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "env:TAVILY_API_KEY",
    backend: {
      kind: "fake-denied-search",
      async get() {
        backendReads++;
        return "must-not-be-read";
      },
      async put() {},
      async delete() {
        return true;
      },
    },
    backendKey: "env:TAVILY_API_KEY",
    scopes: credentialScopesForEnvironment("TAVILY_API_KEY"),
  });
  const proxy = new NetworkProxy({
    broker,
    policy: { allowDomains: ["example.com"] },
    resolver: async () => {
      throw new Error("resolver must not run for a denied host");
    },
    fetch: (async () => {
      throw new Error("fetch must not run for a denied host");
    }) as typeof fetch,
  });
  try {
    const backend = webSearchBackendFromBroker({ provider: "tavily", broker, proxy });
    await assert.rejects(
      () => backend("denied", { signal: new AbortController().signal }),
      /domain is not allowlisted/,
    );
    assert.equal(backendReads, 0);
  } finally {
    await proxy.close();
  }
});
