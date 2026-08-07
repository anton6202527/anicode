import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLoopbackProviderURL,
  localProviderModelsURL,
  providerModelsURL,
} from "./local-endpoint.js";
import { probeEndpoint, probeLocalProviders } from "./probe.js";
import {
  discoverProviderModels,
  listProviderDetails,
  registerOpenAICompatibleProvider,
} from "./registry.js";

test("probeEndpoint: 有 HTTP 响应视为在跑，连接错误视为未运行", async () => {
  const ok = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
  assert.equal(await probeEndpoint("http://127.0.0.1:11434/v1", 600, ok), true);

  const unauthorized = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
  assert.equal(await probeEndpoint("http://localhost/v1", 600, unauthorized), true);

  const refused = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  assert.equal(await probeEndpoint("http://127.0.0.2/v1", 600, refused), false);
});

test("local provider URL: 只允许无内嵌凭证的 HTTP(S) 回环地址", () => {
  for (const value of [
    "http://localhost:8317/v1",
    "http://localhost.:8317/v1",
    "https://127.0.0.2/v1",
    "http://127.1/v1",
    "http://[::1]:11434/v1",
  ]) {
    assert.equal(isLoopbackProviderURL(value), true, value);
  }
  for (const value of [
    "http://example.com/v1",
    "http://localhost.example.com/v1",
    "http://10.0.0.1/v1",
    "http://169.254.169.254/latest/meta-data",
    "ftp://127.0.0.1/models",
    "http://user:secret@127.0.0.1/v1",
    "not a url",
  ]) {
    assert.equal(isLoopbackProviderURL(value), false, value);
    assert.equal(localProviderModelsURL(value), undefined, value);
  }
  assert.equal(
    localProviderModelsURL("http://127.0.0.1:8317/v1?token=secret#fragment")?.toString(),
    "http://127.0.0.1:8317/v1/models",
  );
  assert.equal(
    providerModelsURL("https://api.example.com/v1?token=secret#fragment")?.toString(),
    "https://api.example.com/v1/models",
  );
  assert.equal(providerModelsURL("https://user:secret@api.example.com/v1"), undefined);
});

test("probeEndpoint: 非回环地址在 fetch 前拒绝，且本地探测禁止重定向", async () => {
  let calls = 0;
  const fetchImpl = (async (_input: URL | string, init?: RequestInit) => {
    calls++;
    assert.equal(init?.redirect, "error");
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;

  assert.equal(await probeEndpoint("http://169.254.169.254/latest", 600, fetchImpl), false);
  assert.equal(calls, 0);
  assert.equal(await probeEndpoint("http://127.0.0.1:8317/v1", 600, fetchImpl), true);
  assert.equal(calls, 1);
});

test("probeLocalProviders: 只探测本地端点，返回在跑的 provider 集合", async () => {
  // 精简后的内置注册表已无本地 provider；用 fixture 本地端点验证探测逻辑。
  registerOpenAICompatibleProvider({
    id: "probe-fixture-live",
    baseURL: "http://127.0.0.1:11434/v1",
    local: true,
    requiresApiKey: false,
  });
  registerOpenAICompatibleProvider({
    id: "probe-fixture-down",
    baseURL: "http://127.0.0.1:65001/v1",
    local: true,
    requiresApiKey: false,
  });
  const details = listProviderDetails();
  // 11434 在跑、其余本地端点连不上。
  const fetchImpl = (async (input: URL | string) => {
    const url = String(input);
    if (url.includes("11434")) return new Response("{}", { status: 200 });
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;

  const live = await probeLocalProviders(details, {}, fetchImpl);
  assert.ok(live.has("probe-fixture-live"), "在跑的本地 fixture 应被标为在跑");
  assert.ok(!live.has("probe-fixture-down"), "未响应的本地 provider 不应在集合里");
  // 云端 provider（DeepSeek）不是本地，不参与探测。
  assert.ok(!live.has("deepseek"));
});

test("discoverProviderModels: 本地兼容端点返回实时模型 ID 并清理重复项", async () => {
  registerOpenAICompatibleProvider({
    id: "discover-fixture",
    baseURL: "http://127.0.0.1:18317/v1",
    local: true,
    requiresApiKey: false,
  });
  let calls = 0;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    calls++;
    assert.equal(init?.redirect, "error");
    assert.equal(String(input), "http://127.0.0.1:18317/v1/models");
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    return Response.json({
      data: [
        { id: "model-new" },
        { id: "model-old" },
        { id: "model-new" },
        { id: "gemini-3.1-flash-image" },
        { id: "dall-e-3" },
        { id: "veo-3.1-generate-preview" },
        { id: "lyria-3-pro-preview" },
        { id: "computer-use-preview" },
        { id: "text-embedding-3-small" },
        { id: "unsafe\u001b[31m" },
        { id: 42 },
      ],
    });
  }) as unknown as typeof fetch;

  assert.deepEqual(await discoverProviderModels("discover-fixture", 600, fetchImpl), [
    "model-new",
    "model-old",
  ]);
  assert.equal(calls, 1, "模型发现只能读取一次 /models，不能产生推理计费副作用");
  assert.equal(await discoverProviderModels("deepseek", 600, fetchImpl), undefined);
});

test("discoverProviderModels: 只读取 /models，并合并并发请求与缓存结果", async () => {
  registerOpenAICompatibleProvider({
    id: "discover-cache-fixture",
    baseURL: "http://127.0.0.1:18320/v1",
    local: true,
    requiresApiKey: false,
  });
  const advertised = Array.from({ length: 30 }, (_, index) => `model-${index}`);
  let directoryCalls = 0;
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    directoryCalls++;
    assert.equal(String(input), "http://127.0.0.1:18320/v1/models");
    assert.equal(init?.method, undefined);
    assert.equal(init?.body, undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return Response.json({ data: advertised.map((id) => ({ id })) });
  }) as unknown as typeof fetch;

  const [first, concurrent] = await Promise.all([
    discoverProviderModels("discover-cache-fixture", 600, fetchImpl),
    discoverProviderModels("discover-cache-fixture", 600, fetchImpl),
  ]);
  const second = await discoverProviderModels("discover-cache-fixture", 600, fetchImpl);
  assert.deepEqual(first, advertised);
  assert.deepEqual(concurrent, advertised);
  assert.deepEqual(second, first);
  assert.equal(directoryCalls, 1);
});

test("discoverProviderModels: 不合作的模型目录请求也受硬超时约束", async () => {
  registerOpenAICompatibleProvider({
    id: "discover-timeout-fixture",
    baseURL: "http://127.0.0.1:18321/v1",
    local: true,
    requiresApiKey: false,
  });
  const fetchImpl = (async () => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const started = Date.now();
  assert.equal(await discoverProviderModels("discover-timeout-fixture", 100, fetchImpl), undefined);
  assert.ok(Date.now() - started < 500);
});

test("discoverProviderModels: 拒绝超大模型目录响应", async () => {
  registerOpenAICompatibleProvider({
    id: "discover-oversized-fixture",
    baseURL: "http://127.0.0.1:18319/v1",
    local: true,
    requiresApiKey: false,
  });
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ data: [{ id: "x".repeat(1024 * 1024) }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  assert.equal(
    await discoverProviderModels("discover-oversized-fixture", 600, fetchImpl),
    undefined,
  );
});

test("discoverProviderModels: 环境变量改写到非回环地址时不会发请求或外送凭证", async () => {
  registerOpenAICompatibleProvider({
    id: "discover-untrusted-fixture",
    baseURL: "http://127.0.0.1:18318/v1",
    baseURLEnv: "ANICODE_TEST_UNTRUSTED_DISCOVERY_URL",
    apiKeyEnv: "ANICODE_TEST_UNTRUSTED_DISCOVERY_KEY",
    local: true,
    requiresApiKey: true,
  });
  const previousURL = process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_URL"];
  const previousKey = process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_KEY"];
  process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_URL"] = "http://169.254.169.254/latest/meta-data";
  process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_KEY"] = "must-not-leave-process";
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return Response.json({ data: [{ id: "unexpected" }] });
  }) as unknown as typeof fetch;
  try {
    assert.equal(
      await discoverProviderModels("discover-untrusted-fixture", 600, fetchImpl),
      undefined,
    );
    assert.equal(calls, 0);
  } finally {
    if (previousURL === undefined) delete process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_URL"];
    else process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_URL"] = previousURL;
    if (previousKey === undefined) delete process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_KEY"];
    else process.env["ANICODE_TEST_UNTRUSTED_DISCOVERY_KEY"] = previousKey;
  }
});
