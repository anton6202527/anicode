/**
 * 离线测试：验证统一模型在多轮工具调用场景下的关键不变量。
 * （provider 内部映射函数不导出，这里测公共行为：registry 解析 + 消息构造）
 * 注册表包含 DeepSeek、通用 custom 端点与 debug/demo（零网络兜底）。
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

test("registry: 裸模型名按前缀推断（唯一云端 DeepSeek）", () => {
  assert.equal(createProvider("deepseek-chat").provider.name, "deepseek");
  assert.equal(createProvider("claude-opus-4-8").provider.name, "deepseek");
});

test("registry: 内置 provider 包含 DeepSeek、custom 与 debug/demo，已删除的不再出现", () => {
  for (const id of ["deepseek", "custom", "debug", "demo"])
    assert.ok(listProviders().includes(id), `缺少 ${id}`);
  for (const gone of ["anthropic", "openai", "openrouter", "gemini", "groq", "ollama", "vllm"])
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
    assert.equal(JSON.stringify(resolved.diagnostics).includes("never-appear-in-diagnostics"), false);
  } finally {
    if (oldKey === undefined) delete process.env["CUSTOM_OPENAI_API_KEY"];
    else process.env["CUSTOM_OPENAI_API_KEY"] = oldKey;
    if (oldBase === undefined) delete process.env["CUSTOM_OPENAI_BASE_URL"];
    else process.env["CUSTOM_OPENAI_BASE_URL"] = oldBase;
  }
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

test("registry: details/diagnostics 只暴露安全元数据，支持 env 端点诊断", () => {
  const oldKey = process.env["DEEPSEEK_API_KEY"];
  const oldBase = process.env["DEEPSEEK_BASE_URL"];
  process.env["DEEPSEEK_API_KEY"] = "never-appear-in-details";
  process.env["DEEPSEEK_BASE_URL"] = "http://127.0.0.1:43210/v1";
  try {
    const details = listProviderDetails();
    const deepseek = details.find((item) => item.id === "deepseek");
    assert.ok(deepseek);
    assert.deepEqual(deepseek.apiKeyEnv, ["DEEPSEEK_API_KEY"]);
    assert.equal(JSON.stringify(details).includes("never-appear-in-details"), false);

    const diagnosis = diagnoseProvider("deepseek/deepseek-chat");
    assert.equal(diagnosis.baseURL, "http://127.0.0.1:43210/v1");
    assert.equal(diagnosis.baseURLSource, "environment");
    assert.equal(diagnosis.credentialEnv, "DEEPSEEK_API_KEY");
    assert.equal(diagnosis.hasCredentials, true);
    assert.equal(JSON.stringify(diagnosis).includes("never-appear-in-details"), false);

    const debug = diagnoseProvider("debug/demo");
    assert.deepEqual(debug.warnings, []);
  } finally {
    if (oldKey === undefined) delete process.env["DEEPSEEK_API_KEY"];
    else process.env["DEEPSEEK_API_KEY"] = oldKey;
    if (oldBase === undefined) delete process.env["DEEPSEEK_BASE_URL"];
    else process.env["DEEPSEEK_BASE_URL"] = oldBase;
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
