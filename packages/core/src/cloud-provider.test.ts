import { test } from "node:test";
import assert from "node:assert/strict";
import type { CloudAuthService } from "./cloud-auth.js";
import { registerAnicodeCloudProvider } from "./cloud-provider.js";
import { inspectProvider, listModelCatalog, listProviderDetails } from "./provider/registry.js";

test("AniCode Cloud: 目录只公开免费的 Flash，模型上限为 128k context", () => {
  const auth = {
    onBrokerAttached() {},
  } as unknown as CloudAuthService;
  registerAnicodeCloudProvider(auth);

  const catalog = listModelCatalog().filter((entry) => entry.providerId === "anicode-cloud");
  assert.deepEqual(
    catalog.map((entry) => ({
      model: entry.model,
      free: entry.free,
      recommended: entry.recommended,
      requiresApiKey: entry.requiresApiKey,
    })),
    [
      {
        model: "deepseek-v4-flash",
        free: true,
        recommended: true,
        requiresApiKey: false,
      },
    ],
  );

  const details = listProviderDetails().find((entry) => entry.id === "anicode-cloud");
  assert.deepEqual(
    details?.models.map((profile) => profile.pattern),
    ["deepseek-v4-flash"],
  );
  const flash = inspectProvider("anicode-cloud/deepseek-v4-flash");
  assert.equal(flash.modelInfo.limits.contextWindow, 128_000);
  assert.equal(flash.modelInfo.limits.maxOutputTokens, 8_192);
});
