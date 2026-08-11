import { registerOpenAICompatibleProvider } from "@anicode/core";
import type { CloudAuthService } from "./cloud-auth.js";
import { ANICODE_CLOUD_CONFIG, ANICODE_CLOUD_PROVIDER_ID } from "./cloud-config.js";

export function registerAnicodeCloudProvider(auth: CloudAuthService): void {
  registerOpenAICompatibleProvider({
    id: ANICODE_CLOUD_PROVIDER_ID,
    name: "AniCode Cloud · DeepSeek",
    baseURL: ANICODE_CLOUD_CONFIG.gatewayBaseUrl,
    apiKey: "anicode-cloud-session",
    requiresApiKey: false,
    local: false,
    requireHttps: true,
    fetchFactory: () => auth.gatewayFetch.bind(auth),
    streamUsage: true,
    maxTokensField: "max_tokens",
    reasoningEffort: false,
    capabilities: { tools: true, reasoning: false, images: false },
    limits: { contextWindow: 1_000_000, maxOutputTokens: 8_192 },
    models: [{ pattern: "deepseek-v4-flash" }, { pattern: "deepseek-v4-pro" }],
    catalog: [
      {
        model: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash · AniCode Cloud",
        recommended: true,
        note: "登录后使用 AniCode 托管额度；共享 Key 不下发到客户端",
      },
      {
        model: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro · AniCode Cloud",
        note: "登录后使用 AniCode 托管额度；受每日配额限制",
      },
    ],
  });
}
