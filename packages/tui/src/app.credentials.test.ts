import assert from "node:assert/strict";
import test from "node:test";
import {
  configureProviderCredentialBroker,
  credentialBrokerFromEnv,
  listModelCatalog,
  listProviderDetails,
} from "@anicode/core";
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
