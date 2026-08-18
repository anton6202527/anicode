/**
 * 离线测试：验证统一模型在多轮工具调用场景下的关键不变量。
 * （provider 内部映射函数不导出，这里测公共行为：registry 解析 + 消息构造）
 * 注册表包含 DeepSeek、通用 custom 端点与 debug/demo（零网络兜底）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bindProviderRegistry,
  configureProviderCredentialBroker,
  configureProviderNetworkProxy,
  CredentialBroker,
  credentialScopesForEnvironment,
  createProvider,
  defaultSmallModel,
  diagnoseProvider,
  discoverProviderModels,
  listModelCatalog,
  listProviderDetails,
  listProviders,
  registerOpenAICompatibleProvider,
  resolveDefaultModel,
  textMessage,
  toolCallsOf,
  type SyncSecretBackend,
  type SecretBackend,
} from "../index.js";
import { NetworkProxy } from "../runtime/network-proxy.js";
import type { ChatMessage } from "../index.js";
import { OpenAICompatProvider } from "./openai-compat.js";

class CountingProviderSecretBackend implements SyncSecretBackend {
  readonly kind = "sentinel-provider-backend";
  reads = 0;

  getSync(key: string): string | undefined {
    this.reads++;
    return key === "env:DEEPSEEK_API_KEY" ? "sentinel-deepseek-value" : undefined;
  }

  putSync(): void {}
  deleteSync(): boolean {
    return false;
  }

  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }

  async put(): Promise<void> {}
  async delete(): Promise<boolean> {
    return false;
  }
}

test("registry: 解析 provider/model 前缀", () => {
  const d = createProvider("deepseek/deepseek-chat");
  assert.equal(d.provider.name, "deepseek");
  assert.equal(d.model, "deepseek-chat");

  const dbg = createProvider("debug/demo");
  assert.equal(dbg.provider.name, "debug");

  // model id 中的斜杠完整保留
  const nested = createProvider("deepseek/vendor/nested-model");
  assert.equal(nested.providerId, "deepseek");
  assert.equal(nested.model, "vendor/nested-model");
});

test("registry: DeepSeek 官方根地址由 OpenAI SDK 正确拼成 chat/completions", async () => {
  const diagnostics = bindProviderRegistry({ environment: {} }).diagnoseProvider(
    "deepseek/deepseek-chat",
  );
  assert.equal(diagnostics.baseURL, "https://api.deepseek.com");

  let requestUrl = "";
  let requestBody: Record<string, unknown> | undefined;
  const provider = new OpenAICompatProvider({
    name: "deepseek",
    baseURL: diagnostics.baseURL,
    apiKey: "test-only-key",
    maxRetries: 0,
    thinkingMode: "disabled",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = typeof input === "string" || input instanceof URL ? String(input) : input.url;
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  });
  for await (const _event of provider.stream({ model: "deepseek-chat", messages: [] })) {
    // Drain the SDK stream so the request path and SSE response are both exercised.
  }
  assert.equal(requestUrl, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(requestBody?.["thinking"], { type: "disabled" });
});

test("registry: 裸模型名按前缀推断（唯一云端 DeepSeek）", () => {
  assert.equal(createProvider("deepseek-chat").provider.name, "deepseek");
  assert.equal(createProvider("claude-opus-4-8").provider.name, "deepseek");
});

test("registry: 内置 provider 包含 DeepSeek、custom 与 debug/demo，已删除的不再出现", () => {
  for (const id of ["deepseek", "custom", "debug", "demo"])
    assert.ok(listProviders().includes(id), `缺少 ${id}`);
  for (const gone of ["anthropic", "openai", "openrouter", "groq", "ollama", "vllm"])
    assert.ok(!listProviders().includes(gone), `${gone} 应已删除`);

  const routed = createProvider("deepseek/vendor/model-name");
  assert.equal(routed.providerId, "deepseek");
  assert.equal(routed.model, "vendor/model-name");
  assert.ok(routed.descriptor);
  assert.equal(routed.descriptor.kind, "openai-compatible");
});

test("registry: custom/<model> 使用环境变量配置 OpenAI-compatible 端点", () => {
  const oldKey = process.env["CUSTOM_OPENAI_API_KEY"];
  const oldBase = process.env["CUSTOM_OPENAI_BASE_URL"];
  process.env["CUSTOM_OPENAI_API_KEY"] = "never-appear-in-diagnostics";
  process.env["CUSTOM_OPENAI_BASE_URL"] = "http://127.0.0.1:43211/v1";
  try {
    const resolved = createProvider("custom/vendor/model-name");
    assert.equal(resolved.providerId, "custom");
    assert.equal(resolved.provider.name, "custom");
    assert.equal(resolved.model, "vendor/model-name");
    assert.equal(resolved.descriptor.kind, "openai-compatible");
    assert.equal(resolved.descriptor.local, true);
    assert.equal(resolved.descriptor.requiresApiKey, false);
    assert.equal(resolved.diagnostics.baseURL, "http://127.0.0.1:43211/v1");
    assert.equal(resolved.diagnostics.baseURLSource, "environment");
    assert.equal(resolved.diagnostics.credentialEnv, "CUSTOM_OPENAI_API_KEY");
    assert.equal(resolved.diagnostics.hasCredentials, true);
    assert.equal(
      JSON.stringify(resolved.diagnostics).includes("never-appear-in-diagnostics"),
      false,
    );
  } finally {
    if (oldKey === undefined) delete process.env["CUSTOM_OPENAI_API_KEY"];
    else process.env["CUSTOM_OPENAI_API_KEY"] = oldKey;
    if (oldBase === undefined) delete process.env["CUSTOM_OPENAI_BASE_URL"];
    else process.env["CUSTOM_OPENAI_BASE_URL"] = oldBase;
  }
});

test("registry: CLI Proxy Gemini 模型使用独立本地端点与凭证", () => {
  const oldKey = process.env["CLIPROXY_API_KEY"];
  const oldBase = process.env["CLIPROXY_BASE_URL"];
  process.env["CLIPROXY_API_KEY"] = "cliproxy-test-key";
  process.env["CLIPROXY_BASE_URL"] = "http://127.0.0.1:8317/v1";
  try {
    const resolved = createProvider("cliproxy/gemini-3-flash");
    assert.equal(resolved.providerId, "cliproxy");
    assert.equal(resolved.model, "gemini-3-flash");
    assert.equal(resolved.descriptor.local, true);
    assert.equal(resolved.descriptor.requiresApiKey, true);
    assert.equal(resolved.diagnostics.baseURL, "http://127.0.0.1:8317/v1");
    assert.equal(resolved.diagnostics.credentialEnv, "CLIPROXY_API_KEY");
    assert.equal(resolved.diagnostics.hasCredentials, true);
    assert.equal(JSON.stringify(resolved.diagnostics).includes("cliproxy-test-key"), false);

    const catalog = listModelCatalog().filter((entry) => entry.providerId === "cliproxy");
    assert.deepEqual(
      new Set(catalog.map((entry) => entry.model)),
      new Set([
        "gemini-3.6-flash-high",
        "gemini-3.1-pro-low",
        "gemini-3.5-flash-low",
        "gemini-3.5-flash-extra-low",
        "gemini-3-flash",
        "gemini-pro-agent",
        "gemini-3-flash-agent",
        "gemini-3.1-flash-lite",
        "gemini-3.1-flash-image",
        "claude-opus-4-6-thinking",
        "claude-sonnet-4-6",
        "gpt-oss-120b-medium",
      ]),
    );
  } finally {
    if (oldKey === undefined) delete process.env["CLIPROXY_API_KEY"];
    else process.env["CLIPROXY_API_KEY"] = oldKey;
    if (oldBase === undefined) delete process.env["CLIPROXY_BASE_URL"];
    else process.env["CLIPROXY_BASE_URL"] = oldBase;
  }
});

test("registry: Gemini 目录使用当前模型并移除已下线的 2.0 Flash", () => {
  const models = listModelCatalog()
    .filter((entry) => entry.providerId === "gemini")
    .map((entry) => entry.model);
  assert.deepEqual(models, [
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.5-flash",
    "gemini-3.1-pro-preview",
  ]);
  assert.ok(!models.includes("gemini-2.0-flash"));
});

test("registry: 内置模型目录含 DeepSeek 官方模型 + 零网络 debug/demo，spec 可直接解析", () => {
  const catalog = listModelCatalog();
  assert.ok(catalog.length >= 3, "目录应含 DeepSeek 两档 + debug/demo");

  // 每条都能被 createProvider 解析（spec = providerId/model），且 provider 存在。
  const providerIds = new Set(listProviderDetails().map((p) => p.id));
  for (const entry of catalog) {
    assert.equal(entry.spec, `${entry.providerId}/${entry.model}`);
    assert.ok(providerIds.has(entry.providerId), `未知 provider ${entry.providerId}`);
    assert.doesNotThrow(() => createProvider(entry.spec));
  }

  // 零网络的 debug/demo 必须在目录里、免费且可用。
  const demo = catalog.find((e) => e.spec === "debug/demo");
  assert.ok(demo, "缺少零网络 debug/demo");
  assert.equal(demo?.free, true);
  assert.equal(demo?.requiresApiKey, false);

  // DeepSeek 作为唯一云端 provider，两档官方模型都需要 key。
  const deepseek = catalog.filter((e) => e.providerId === "deepseek");
  assert.deepEqual(
    deepseek.map((e) => e.spec),
    ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"],
  );
  assert.ok(deepseek.every((e) => e.requiresApiKey));
  const flash = createProvider("deepseek/deepseek-v4-flash");
  assert.equal(flash.modelInfo.limits.contextWindow, 1_000_000);
  assert.equal(flash.modelInfo.limits.maxOutputTokens, 384_000);
  assert.deepEqual(flash.modelInfo.cost, { input: 0.44, output: 1.32, cacheRead: 0.014 });
  const pro = createProvider("deepseek/deepseek-v4-pro");
  assert.deepEqual(pro.modelInfo.cost, { input: 1.32, output: 3.96, cacheRead: 0.044 });
  assert.ok(deepseek.every((entry) => entry.note?.includes("实际随时段变化")));
});

test("registry: defaultSmallModel 为 DeepSeek 返回可解析的小模型，其他返回 undefined", () => {
  const spec = defaultSmallModel("deepseek");
  assert.ok(spec && spec.startsWith("deepseek/"));
  assert.doesNotThrow(() => createProvider(spec!));
  assert.equal(defaultSmallModel("groq"), undefined);
  assert.equal(defaultSmallModel("debug"), undefined);
  assert.equal(defaultSmallModel(undefined), undefined);
});

test("registry: 目录顺序稳定，按 provider 注册顺序聚合", () => {
  const a = listModelCatalog().map((e) => e.spec);
  const b = listModelCatalog().map((e) => e.spec);
  assert.deepEqual(a, b);
  // 同一 provider 的条目应连续出现（不交错）。
  const seen = new Set<string>();
  let previous = "";
  for (const spec of a) {
    const id = spec.slice(0, spec.indexOf("/"));
    if (id !== previous) {
      assert.equal(seen.has(id), false, `provider ${id} 的条目被打散`);
      seen.add(id);
      previous = id;
    }
  }
});

test("registry: model profile 解析 capabilities/limits，未列出的模型继承 provider 默认", () => {
  const reasoner = createProvider("deepseek/deepseek-reasoner");
  assert.equal(reasoner.modelInfo.capabilities.reasoning, true);
  assert.equal(reasoner.modelInfo.limits.contextWindow, 64_000);

  const chat = createProvider("deepseek/deepseek-chat");
  assert.equal(chat.modelInfo.capabilities.reasoning, false);

  // 未在 models 里显式列出的 DeepSeek 模型：继承 provider 默认上限，不推理。
  const unlisted = createProvider("deepseek/deepseek-unlisted");
  assert.equal(unlisted.modelInfo.capabilities.reasoning, false);
  assert.equal(unlisted.modelInfo.limits.contextWindow, 1_000_000);
});

test("registry: details/diagnostics 只暴露安全元数据，支持 HTTPS env 端点诊断", () => {
  const oldKey = process.env["DEEPSEEK_API_KEY"];
  const oldBase = process.env["DEEPSEEK_BASE_URL"];
  process.env["DEEPSEEK_API_KEY"] = "never-appear-in-details";
  process.env["DEEPSEEK_BASE_URL"] = "https://deepseek-proxy.example.test/v1";
  try {
    const details = listProviderDetails();
    const deepseek = details.find((item) => item.id === "deepseek");
    assert.ok(deepseek);
    assert.deepEqual(deepseek.apiKeyEnv, ["DEEPSEEK_API_KEY"]);
    assert.equal(JSON.stringify(details).includes("never-appear-in-details"), false);

    const diagnosis = diagnoseProvider("deepseek/deepseek-chat");
    assert.equal(diagnosis.baseURL, "https://deepseek-proxy.example.test/v1");
    assert.equal(diagnosis.baseURLSource, "environment");
    assert.equal(diagnosis.credentialEnv, "DEEPSEEK_API_KEY");
    assert.equal(diagnosis.hasCredentials, true);
    assert.equal(JSON.stringify(diagnosis).includes("never-appear-in-details"), false);
    assert.deepEqual(diagnosis.warnings, []);

    const debug = diagnoseProvider("debug/demo");
    assert.deepEqual(debug.warnings, []);
  } finally {
    if (oldKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = oldKey;
    if (oldBase === undefined) delete process.env["DEEPSEEK_BASE_URL"];
    else process.env["DEEPSEEK_BASE_URL"] = oldBase;
  }
});

test("registry: DeepSeek HTTPS policy rejects before opening a configured credential", async () => {
  const backend = new CountingProviderSecretBackend();
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "env:DEEPSEEK_API_KEY",
    backend,
    scopes: credentialScopesForEnvironment("DEEPSEEK_API_KEY"),
  });
  const registry = bindProviderRegistry({
    broker,
    environment: { DEEPSEEK_BASE_URL: "http://api.deepseek.com/v1" },
    allowEnvironmentFallback: false,
  });

  const diagnostics = registry.diagnoseProvider("deepseek/deepseek-chat");
  assert.equal(diagnostics.baseURL, "http://api.deepseek.com/v1");
  assert.equal(diagnostics.baseURLSource, "environment");
  assert.match(diagnostics.warnings.join("\n"), /HTTPS/u);
  assert.equal(backend.reads, 0);
  assert.throws(() => registry.resolveProvider("deepseek/deepseek-chat"), /HTTPS/u);
  assert.equal(backend.reads, 0);
  await assert.rejects(registry.resolveProviderAsync("deepseek/deepseek-chat"), /HTTPS/u);
  assert.equal(backend.reads, 0);
  assert.equal(await registry.discoverModels("deepseek"), undefined);
  assert.equal(backend.reads, 0);
});

test("registry: diagnostics/default model 不读取 configured reference，createProvider 才读取一次", () => {
  const backend = new CountingProviderSecretBackend();
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "env:DEEPSEEK_API_KEY",
    backend,
    scopes: credentialScopesForEnvironment("DEEPSEEK_API_KEY"),
  });
  configureProviderCredentialBroker(broker, { allowEnvironmentFallback: false });
  try {
    const diagnostics = diagnoseProvider("deepseek/deepseek-chat");
    assert.equal(diagnostics.credentialEnv, "DEEPSEEK_API_KEY");
    assert.equal(diagnostics.credentialAvailability, "configured");
    assert.equal(diagnostics.hasCredentials, true);
    assert.equal(backend.reads, 0);

    assert.equal(resolveDefaultModel(), "deepseek/deepseek-v4-flash");
    assert.equal(backend.reads, 0);

    const created = createProvider("deepseek/deepseek-chat");
    assert.equal(created.diagnostics.credentialAvailability, "available");
    assert.equal(created.diagnostics.hasCredentials, true);
    assert.equal(backend.reads, 1);
  } finally {
    configureProviderCredentialBroker(undefined);
  }
});

test("registry: async reference is hydrated once only by selected provider materialization", async () => {
  const reads: string[] = [];
  const backend: SecretBackend = {
    kind: "utility-keychain-fixture",
    get: async (key) => {
      reads.push(key);
      return key === "env:DEEPSEEK_API_KEY" ? "async-provider-secret" : undefined;
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerAsyncReference({
    id: "env:DEEPSEEK_API_KEY",
    backend,
    scopes: credentialScopesForEnvironment("DEEPSEEK_API_KEY"),
  });
  const registry = bindProviderRegistry({
    broker,
    environment: {},
    allowEnvironmentFallback: false,
  });

  assert.equal(
    registry.diagnoseProvider("deepseek/deepseek-chat").credentialAvailability,
    "configured",
  );
  assert.equal(await registry.discoverModels("deepseek"), undefined);
  assert.deepEqual(reads, []);
  const created = await registry.resolveProviderAsync("deepseek/deepseek-chat");
  assert.equal(created.diagnostics.credentialAvailability, "available");
  assert.deepEqual(reads, ["env:DEEPSEEK_API_KEY"]);
  assert.equal(registry.resolveProvider("deepseek/deepseek-chat").diagnostics.hasCredentials, true);
  assert.deepEqual(reads, ["env:DEEPSEEK_API_KEY"]);
});

test("registry: configured backend refusal is sanitized and does not probe fallback entries", () => {
  const refusal = new Error("sentinel credential access was denied: raw-provider-secret");
  let reads = 0;
  const backend: SyncSecretBackend = {
    kind: "sentinel-refusal-backend",
    getSync: () => {
      reads++;
      throw refusal;
    },
    putSync: () => undefined,
    deleteSync: () => false,
    get: async () => {
      reads++;
      throw refusal;
    },
    put: async () => undefined,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY"]) {
    broker.registerReference({
      id: `env:${name}`,
      backend,
      scopes: credentialScopesForEnvironment(name),
    });
  }
  configureProviderCredentialBroker(broker, { allowEnvironmentFallback: false });
  try {
    assert.throws(
      () => createProvider("gemini/gemini-3.6-flash"),
      (error) => {
        assert.ok(error instanceof Error);
        assert.notEqual(error, refusal);
        assert.equal(error.message, "Credential backend read failed");
        assert.equal("cause" in error, false);
        assert.doesNotMatch(String(error), /raw-provider-secret|sentinel credential access/u);
        return true;
      },
    );
    assert.equal(reads, 1);
  } finally {
    configureProviderCredentialBroker(undefined);
  }
});

test("registry: 可注册 OpenAI-compatible profile 与 alias", () => {
  registerOpenAICompatibleProvider("fixture-compatible", {
    aliases: ["fixture-alias"],
    name: "Fixture Compatible",
    baseURL: "http://127.0.0.1:9/v1",
    apiKey: "fixture-key",
    requiresApiKey: true,
    capabilities: { tools: false },
    limits: { contextWindow: 4096, maxOutputTokens: 512 },
  });
  const resolved = createProvider("fixture-alias/model-with/slash");
  assert.equal(resolved.provider.name, "fixture-compatible");
  assert.equal(resolved.providerId, "fixture-compatible");
  assert.equal(resolved.model, "model-with/slash");
  assert.equal(resolved.modelInfo.capabilities.tools, false);
  assert.equal(resolved.modelInfo.limits.maxOutputTokens, 512);
  assert.equal(resolved.diagnostics?.hasCredentials, true);
  assert.deepEqual(resolved.diagnostics?.warnings, []);
});

test("registry: host fetchFactory 同时承载 chat completions 与 /models discovery", async () => {
  const requests: Array<{ marker: string; url: string; authorization: string | null }> = [];
  let proxyRequests = 0;
  let fallbackRequests = 0;
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["host-fetch.example.test"], allowPorts: [443] },
    resolver: async () => ["93.184.216.34"],
    fetch: (async () => {
      proxyRequests++;
      throw new Error("NetworkProxy must not run when fetchFactory is registered");
    }) as typeof fetch,
  });
  const fallbackFetch = (async () => {
    fallbackRequests++;
    throw new Error("discovery fallback fetch must not run for a non-loopback factory endpoint");
  }) as typeof fetch;
  registerOpenAICompatibleProvider({
    id: "host-fetch-factory-fixture",
    baseURL: "https://host-fetch.example.test/v1",
    apiKey: "factory-static-key",
    fetchFactory: (bindings) => {
      const marker = bindings.environment?.["ANICODE_HOST_FETCH_MARKER"] ?? "";
      assert.ok(marker === "without-proxy" || marker === "with-proxy");
      if (marker === "with-proxy") assert.equal(bindings.networkProxy, proxy);
      else assert.equal(bindings.networkProxy, undefined);
      return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" || input instanceof URL ? String(input) : input.url;
        const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
        requests.push({ marker, url, authorization: headers.get("authorization") });
        if (url.endsWith("/models")) {
          return Response.json({ data: [{ id: "factory-live-model" }] });
        }
        assert.ok(url.endsWith("/chat/completions"));
        return new Response(
          `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: "factory-ok" }, finish_reason: null }],
          })}\n\ndata: ${JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch;
    },
  });
  const withoutProxy = bindProviderRegistry({
    environment: { ANICODE_HOST_FETCH_MARKER: "without-proxy" },
  });
  const withProxy = bindProviderRegistry({
    environment: { ANICODE_HOST_FETCH_MARKER: "with-proxy" },
    networkProxy: proxy,
  });

  try {
    assert.deepEqual(
      await withoutProxy.discoverModels("host-fetch-factory-fixture", 2_000, fallbackFetch),
      ["factory-live-model"],
    );
    assert.deepEqual(
      await withProxy.discoverModels("host-fetch-factory-fixture", 2_000, fallbackFetch),
      ["factory-live-model"],
    );
    const resolved = withProxy.resolveProvider("host-fetch-factory-fixture/model");
    let sawText = false;
    for await (const event of resolved.provider.stream({ model: resolved.model, messages: [] })) {
      if (event.type === "text_delta" && event.text === "factory-ok") sawText = true;
    }
    assert.equal(sawText, true);
    assert.deepEqual(requests, [
      {
        marker: "without-proxy",
        url: "https://host-fetch.example.test/v1/models",
        authorization: "Bearer factory-static-key",
      },
      {
        marker: "with-proxy",
        url: "https://host-fetch.example.test/v1/models",
        authorization: "Bearer factory-static-key",
      },
      {
        marker: "with-proxy",
        url: "https://host-fetch.example.test/v1/chat/completions",
        authorization: "Bearer factory-static-key",
      },
    ]);
    assert.equal(proxyRequests, 0);
    assert.equal(fallbackRequests, 0);
  } finally {
    await proxy.close();
  }
});

test("registry: requireHttps blocks default endpoint before credential and fetch factories", async () => {
  let credentialReads = 0;
  const readCredential = (key: string): string | undefined => {
    credentialReads++;
    return key === "env:CUSTOM_OPENAI_API_KEY" ? "insecure-endpoint-secret" : undefined;
  };
  const backend: SyncSecretBackend = {
    kind: "https-required-counting-backend",
    getSync: readCredential,
    putSync: () => undefined,
    deleteSync: () => false,
    get: async (key) => readCredential(key),
    put: async () => undefined,
    delete: async () => false,
  };
  const broker = new CredentialBroker();
  broker.registerReference({
    id: "env:CUSTOM_OPENAI_API_KEY",
    backend,
    scopes: credentialScopesForEnvironment("CUSTOM_OPENAI_API_KEY"),
  });
  let fetchFactoryCalls = 0;
  let factoryRequests = 0;
  let proxyRequests = 0;
  let fallbackRequests = 0;
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["insecure.example.test"], allowPorts: [80] },
    resolver: async () => ["93.184.216.34"],
    fetch: (async () => {
      proxyRequests++;
      throw new Error("insecure endpoint must not reach NetworkProxy");
    }) as typeof fetch,
  });
  const fallbackFetch = (async () => {
    fallbackRequests++;
    throw new Error("insecure endpoint must not reach fallback fetch");
  }) as typeof fetch;
  registerOpenAICompatibleProvider({
    id: "https-required-fixture",
    baseURL: "http://insecure.example.test/v1",
    apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
    requireHttps: true,
    fetchFactory: () => {
      fetchFactoryCalls++;
      return (async () => {
        factoryRequests++;
        throw new Error("insecure endpoint must not issue a request");
      }) as typeof fetch;
    },
  });
  const registry = bindProviderRegistry({
    broker,
    networkProxy: proxy,
    environment: {},
    allowEnvironmentFallback: false,
  });

  try {
    const diagnostics = registry.diagnoseProvider("https-required-fixture/model");
    assert.equal(diagnostics.baseURL, "http://insecure.example.test/v1");
    assert.equal(diagnostics.baseURLSource, "default");
    assert.match(diagnostics.warnings.join("\n"), /HTTPS/u);
    assert.throws(() => registry.resolveProvider("https-required-fixture/model"), /HTTPS/u);
    await assert.rejects(registry.resolveProviderAsync("https-required-fixture/model"), /HTTPS/u);
    assert.equal(
      await registry.discoverModels("https-required-fixture", 2_000, fallbackFetch),
      undefined,
    );
    assert.equal(credentialReads, 0);
    assert.equal(fetchFactoryCalls, 0);
    assert.equal(factoryRequests, 0);
    assert.equal(proxyRequests, 0);
    assert.equal(fallbackRequests, 0);
  } finally {
    await proxy.close();
  }
});

test("registry: local 标记被改到公网端点时仍强制经过统一网络策略", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["provider.example.test"], allowPorts: [443] },
    resolver: async () => ["93.184.216.34"],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), authorization: headers.get("authorization") });
      return new Response(
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
        })}\n\ndata: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  });
  configureProviderNetworkProxy(proxy);
  registerOpenAICompatibleProvider({
    id: "remote-marked-local-fixture",
    baseURL: "https://provider.example.test/v1",
    apiKey: "fixture-key",
    local: true,
    requiresApiKey: true,
  });
  try {
    const resolved = createProvider("remote-marked-local-fixture/model");
    assert.match(resolved.diagnostics.warnings.join("\n"), /不是回环地址|not loopback/);
    for await (const _event of resolved.provider.stream({
      model: resolved.model,
      messages: [],
    })) {
      // consume the complete fixture stream
    }
    assert.deepEqual(requests, [
      {
        url: "https://provider.example.test/v1/chat/completions",
        authorization: "Bearer fixture-key",
      },
    ]);
  } finally {
    configureProviderNetworkProxy(undefined);
    await proxy.close();
  }
});

test("registry: 云端 /models 通过统一网络策略鉴权探测并返回真实目录", async () => {
  const keyName = "ANICODE_DISCOVER_CLOUD_FIXTURE_KEY";
  const previousKey = process.env[keyName];
  process.env[keyName] = "cloud-fixture-key";
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const proxy = new NetworkProxy({
    policy: { allowDomains: ["models.example.test"], allowPorts: [443] },
    resolver: async () => ["93.184.216.34"],
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      assert.equal(url, "https://models.example.test/v1/models");
      // NetworkProxy normalizes an omitted fetch method to an explicit GET.
      assert.equal(init?.method, "GET");
      assert.equal(init?.body, undefined);
      requests.push({ url, authorization: headers.get("authorization") });
      return Response.json({ data: [{ id: "live-a" }, { id: "live-b" }] });
    }) as typeof fetch,
  });
  configureProviderNetworkProxy(proxy);
  registerOpenAICompatibleProvider({
    id: "discover-cloud-fixture",
    baseURL: "https://models.example.test/v1",
    apiKeyEnv: keyName,
    local: false,
    requiresApiKey: true,
  });
  try {
    assert.deepEqual(await discoverProviderModels("discover-cloud-fixture"), ["live-a", "live-b"]);
    assert.deepEqual(requests, [
      {
        url: "https://models.example.test/v1/models",
        authorization: "Bearer cloud-fixture-key",
      },
    ]);
  } finally {
    if (previousKey === undefined) delete process.env[keyName];
    else process.env[keyName] = previousKey;
    configureProviderNetworkProxy(undefined);
    await proxy.close();
  }
});

test("registry: 拒绝空或残缺 model spec", () => {
  assert.throws(() => createProvider(""), /不能为空/);
  assert.throws(() => createProvider("deepseek/"), /非法 model spec/);
  assert.throws(() => createProvider("/model"), /非法 model spec/);
});

test("registry: DeepSeek 缺 key 时不会回退并泄露 OPENAI_API_KEY", async () => {
  const openAIKey = process.env["OPENAI_API_KEY"];
  const deepSeekKey = process.env["DEEPSEEK_API_KEY"];
  process.env["OPENAI_API_KEY"] = "openai-only-placeholder";
  delete process.env["DEEPSEEK_API_KEY"];
  try {
    const resolved = createProvider("deepseek/deepseek-chat");
    // 离线解析成功、不要求密钥；首次 stream 才校验。
    assert.equal(resolved.provider.name, "deepseek");
    await assert.rejects(async () => {
      for await (const _event of resolved.provider.stream({
        model: resolved.model,
        messages: [],
      })) {
        // 显式空 DeepSeek key 应在任何网络请求前失败。
      }
    }, /Missing credentials/);
  } finally {
    if (openAIKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = openAIKey;
    if (deepSeekKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = deepSeekKey;
  }
});

test("registry: 任意兼容 provider 也不会回退 OPENAI_API_KEY", async () => {
  const openAIKey = process.env["OPENAI_API_KEY"];
  const leakKey = process.env["LEAK_TEST_KEY"];
  registerOpenAICompatibleProvider({
    id: "leak-test",
    baseURL: "http://127.0.0.1:9/v1",
    apiKeyEnv: "LEAK_TEST_KEY",
    requiresApiKey: true,
  });
  process.env["OPENAI_API_KEY"] = "must-not-leak-to-compat-provider";
  delete process.env["LEAK_TEST_KEY"];
  try {
    const resolved = createProvider("leak-test/some-model");
    await assert.rejects(async () => {
      for await (const _event of resolved.provider.stream({
        model: resolved.model,
        messages: [],
      })) {
        // 缺 provider 自己的 key 时必须在网络前失败。
      }
    }, /Missing credentials/);
  } finally {
    if (openAIKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = openAIKey;
    if (leakKey === undefined) delete process.env["LEAK_TEST_KEY"];
    else process.env["LEAK_TEST_KEY"] = leakKey;
  }
});

test("registry: 未知 provider 报错并列出可用项", () => {
  assert.throws(() => createProvider("nope/model-x"), /未知 provider/);
});

test("统一模型: 多轮工具调用的消息结构", () => {
  const history: ChatMessage[] = [textMessage("user", "现在几点？")];

  // 模型回复：文本 + 工具调用
  const assistant: ChatMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "我来查一下。" },
      { type: "tool_call", id: "call_1", name: "get_current_time", args: {} },
    ],
  };
  history.push(assistant);
  assert.equal(toolCallsOf(assistant).length, 1);

  // 工具结果回传
  history.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "call_1",
        toolName: "get_current_time",
        content: "2026-07-13T12:00:00Z",
      },
    ],
  });

  assert.equal(history.length, 3);
  assert.equal(history[1]!.role, "assistant");
  assert.equal(history[2]!.content[0]!.type, "tool_result");
});
