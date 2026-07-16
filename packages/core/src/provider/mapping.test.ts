/**
 * 离线测试：验证统一模型在多轮工具调用场景下的关键不变量。
 * （provider 内部映射函数不导出，这里测公共行为：registry 解析 + 消息构造）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createProvider,
  defaultSmallModel,
  diagnoseProvider,
  listModelCatalog,
  listProviderDetails,
  listProviders,
  registerOpenAICompatibleProvider,
  textMessage,
  toolCallsOf,
} from "../index.js";
import type { ChatMessage } from "../index.js";

test("registry: 解析 provider/model 前缀", () => {
  const a = createProvider("anthropic/claude-opus-4-8");
  assert.equal(a.provider.name, "anthropic");
  assert.equal(a.model, "claude-opus-4-8");

  const o = createProvider("openai/gpt-5.2");
  assert.equal(o.provider.name, "openai");
  assert.equal(o.model, "gpt-5.2");

  const ol = createProvider("ollama/qwen3");
  assert.equal(ol.provider.name, "ollama");
});

test("registry: 裸模型名按前缀推断", () => {
  assert.equal(createProvider("claude-opus-4-8").provider.name, "anthropic");
  assert.equal(createProvider("gpt-5.2").provider.name, "openai");
});

test("registry: 内置 provider 数据完整，模型 id 中的斜杠不丢失", () => {
  const expected = [
    "anthropic",
    "openai",
    "openrouter",
    "deepseek",
    "gemini",
    "xai",
    "groq",
    "mistral",
    "together",
    "fireworks",
    "cerebras",
    "ollama",
    "lmstudio",
    "vllm",
    "llamacpp",
    "custom",
    "debug",
    "demo",
  ];
  for (const id of expected) assert.ok(listProviders().includes(id), `缺少 ${id}`);

  const routed = createProvider("openrouter/anthropic/claude-sonnet-4");
  assert.equal(routed.providerId, "openrouter");
  assert.equal(routed.model, "anthropic/claude-sonnet-4");
  assert.ok(routed.descriptor);
  assert.equal(routed.descriptor.kind, "openai-compatible");
});

test("registry: 内置模型目录含免费/开源模型且 spec 可直接解析", () => {
  const catalog = listModelCatalog();
  assert.ok(catalog.length >= 10, "目录应有足够多的内置模型");

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

  // 存在真正免费且开放权重的调试模型（如 OpenRouter :free、Groq 免费档、本地 Ollama）。
  assert.ok(catalog.some((e) => e.free && e.openWeight && e.spec.includes(":free")));
  assert.ok(catalog.some((e) => e.local && e.free && e.openWeight));
});

test("registry: defaultSmallModel 为已知 provider 返回可解析的小模型，未知返回 undefined", () => {
  const spec = defaultSmallModel("anthropic");
  assert.ok(spec && spec.startsWith("anthropic/"));
  assert.doesNotThrow(() => createProvider(spec!));
  assert.equal(defaultSmallModel("groq")?.startsWith("groq/"), true);
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

test("registry: model profile 解析 capabilities/limits，未知兼容模型不虚构限制", () => {
  const adaptive = createProvider("anthropic/claude-opus-4-8");
  assert.equal(adaptive.modelInfo.capabilities.reasoning, true);
  assert.equal(adaptive.modelInfo.limits.contextWindow, 200_000);

  const unknownClaude = createProvider("anthropic/private-model");
  assert.equal(unknownClaude.modelInfo.capabilities.reasoning, false);

  const local = createProvider("vllm/my-private-model");
  assert.deepEqual(local.modelInfo.limits, {});
  assert.equal(local.modelInfo.capabilities.reasoning, false);
});

test("registry: details/diagnostics 只暴露安全元数据，支持 env 端点诊断", () => {
  const oldKey = process.env["OPENROUTER_API_KEY"];
  const oldBase = process.env["OPENROUTER_BASE_URL"];
  process.env["OPENROUTER_API_KEY"] = "never-appear-in-details";
  process.env["OPENROUTER_BASE_URL"] = "http://127.0.0.1:43210/v1";
  try {
    const details = listProviderDetails();
    const openrouter = details.find((item) => item.id === "openrouter");
    assert.ok(openrouter);
    assert.deepEqual(openrouter.apiKeyEnv, ["OPENROUTER_API_KEY"]);
    assert.equal(JSON.stringify(details).includes("never-appear-in-details"), false);

    const diagnosis = diagnoseProvider("openrouter/model/name");
    assert.equal(diagnosis.baseURL, "http://127.0.0.1:43210/v1");
    assert.equal(diagnosis.baseURLSource, "environment");
    assert.equal(diagnosis.credentialEnv, "OPENROUTER_API_KEY");
    assert.equal(diagnosis.hasCredentials, true);
    assert.equal(JSON.stringify(diagnosis).includes("never-appear-in-details"), false);

    const debug = diagnoseProvider("debug/demo");
    assert.deepEqual(debug.warnings, []);
  } finally {
    if (oldKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = oldKey;
    if (oldBase === undefined) delete process.env["OPENROUTER_BASE_URL"];
    else process.env["OPENROUTER_BASE_URL"] = oldBase;
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

test("registry: 拒绝空或残缺 model spec", () => {
  assert.throws(() => createProvider(""), /不能为空/);
  assert.throws(() => createProvider("openai/"), /非法 model spec/);
  assert.throws(() => createProvider("/model"), /非法 model spec/);
});

test("registry: OpenAI 离线解析不要求密钥，首次 stream 时才校验", async () => {
  const apiKey = process.env["OPENAI_API_KEY"];
  const adminKey = process.env["OPENAI_ADMIN_KEY"];
  delete process.env["OPENAI_API_KEY"];
  delete process.env["OPENAI_ADMIN_KEY"];

  try {
    const resolved = createProvider("openai/gpt-5.2");
    assert.equal(resolved.provider.name, "openai");
    assert.equal(resolved.model, "gpt-5.2");

    await assert.rejects(async () => {
      for await (const _event of resolved.provider.stream({
        model: resolved.model,
        messages: [],
      })) {
        // 无密钥时应在产生任何事件前失败。
      }
    }, /Missing credentials/);
  } finally {
    if (apiKey === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = apiKey;
    if (adminKey === undefined) delete process.env["OPENAI_ADMIN_KEY"];
    else process.env["OPENAI_ADMIN_KEY"] = adminKey;
  }
});

test("registry: DeepSeek 缺 key 时不会回退并泄露 OPENAI_API_KEY", async () => {
  const openAIKey = process.env["OPENAI_API_KEY"];
  const deepSeekKey = process.env["DEEPSEEK_API_KEY"];
  process.env["OPENAI_API_KEY"] = "openai-only-placeholder";
  delete process.env["DEEPSEEK_API_KEY"];
  try {
    const resolved = createProvider("deepseek/deepseek-chat");
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

test("registry: 其他兼容 provider 也不会回退 OPENAI_API_KEY", async () => {
  const openAIKey = process.env["OPENAI_API_KEY"];
  const openRouterKey = process.env["OPENROUTER_API_KEY"];
  process.env["OPENAI_API_KEY"] = "must-not-leak-to-openrouter";
  delete process.env["OPENROUTER_API_KEY"];
  try {
    const resolved = createProvider("openrouter/anthropic/claude-sonnet-4");
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
    if (openRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
    else process.env["OPENROUTER_API_KEY"] = openRouterKey;
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
