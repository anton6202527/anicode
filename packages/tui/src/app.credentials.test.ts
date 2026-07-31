import assert from "node:assert/strict";
import test from "node:test";
import {
  configureProviderCredentialBroker,
  credentialBrokerFromEnv,
  listModelCatalog,
  listProviderDetails,
} from "@anicode/core";
import type { ModelCatalogEntry, ProviderDescriptor } from "@anicode/core";
import { buildPickerRows } from "./app.js";

test("/model 通过 CredentialBroker 识别已从环境移除的 API Key", () => {
  const env: NodeJS.ProcessEnv = {
    DEEPSEEK_API_KEY: "deepseek-test-key",
    GEMINI_API_KEY: "gemini-test-key",
  };
  const broker = credentialBrokerFromEnv(env, { remove: true });
  configureProviderCredentialBroker(broker);

  try {
    assert.equal(env.DEEPSEEK_API_KEY, undefined);
    assert.equal(env.GEMINI_API_KEY, undefined);

    const rows = buildPickerRows(
      listModelCatalog().filter(
        (entry) => entry.providerId === "deepseek" || entry.providerId === "gemini",
      ),
      listProviderDetails(),
      true,
    );

    assert.ok(rows.some((row) => row.spec.startsWith("deepseek/") && row.ready === true));
    assert.ok(rows.some((row) => row.spec.startsWith("gemini/") && row.ready === true));
    assert.ok(
      rows.filter((row) => row.ready).every((row) => !/Missing|^缺(?:少| )/.test(row.readyHint)),
    );
  } finally {
    configureProviderCredentialBroker(undefined);
  }
});

test("/model 只保留 /models 实际返回的模型，探测失败 provider 不展示", () => {
  const providers: ProviderDescriptor[] = [
    {
      id: "cloud-old",
      name: "Cloud Old",
      kind: "openai-compatible",
      protocol: "openai-chat",
      aliases: [],
      apiKeyEnv: ["MISSING_CLOUD_OLD_KEY"],
      requiresApiKey: true,
      local: false,
      capabilities: { tools: true, reasoning: false },
      limits: {},
      models: [],
      catalog: [],
    },
    {
      id: "local-live",
      name: "Local Live",
      kind: "openai-compatible",
      protocol: "openai-chat",
      aliases: [],
      baseURL: "http://127.0.0.1:8317/v1",
      apiKeyEnv: [],
      requiresApiKey: false,
      local: true,
      capabilities: { tools: true, reasoning: false },
      limits: {},
      models: [],
      catalog: [],
    },
  ];
  const entry = (
    providerId: string,
    providerName: string,
    model: string,
    local: boolean,
    requiresApiKey: boolean,
  ): ModelCatalogEntry => ({
    providerId,
    providerName,
    model,
    spec: `${providerId}/${model}`,
    local,
    requiresApiKey,
  });
  const rows = buildPickerRows(
    [
      entry("cloud-old", "Cloud Old", "deprecated-cloud", false, true),
      entry("local-live", "Local Live", "stale-local", true, false),
    ],
    providers,
    true,
    {
      probed: new Set(["local-live"]),
      live: new Set(["local-live"]),
      models: new Map([["local-live", ["fresh-local"]]]),
    },
  );

  assert.equal(rows[0]?.spec, "local-live/fresh-local");
  assert.equal(rows[0]?.ready, true);
  assert.ok(!rows.some((row) => row.spec.endsWith("stale-local")));
  assert.ok(!rows.some((row) => row.spec === "cloud-old/deprecated-cloud"));
  assert.equal(rows.length, 1);
});
