import {
  registerOpenAICompatibleProvider,
  type ProviderRuntimeBindings,
} from "./provider/registry.js";
import type { CloudAuthService } from "./cloud-auth.js";
import type { CredentialBroker } from "./security/credentials.js";
import { ANICODE_CLOUD_CONFIG, ANICODE_CLOUD_PROVIDER_ID } from "./cloud-config.js";

const registeredAuthServices = new WeakSet<CloudAuthService>();
const authServicesByBroker = new WeakMap<CredentialBroker, Set<WeakRef<CloudAuthService>>>();

function rememberAuthService(auth: CloudAuthService): void {
  if (registeredAuthServices.has(auth)) return;
  registeredAuthServices.add(auth);
  auth.onBrokerAttached((broker) => {
    let references = authServicesByBroker.get(broker);
    if (!references) {
      references = new Set();
      authServicesByBroker.set(broker, references);
    }
    references.add(new WeakRef(auth));
  });
}

/** Resolve by the immutable per-runtime Broker binding, never by global registration order. */
function cloudFetchForBindings(bindings: ProviderRuntimeBindings): typeof fetch {
  const broker = bindings.broker;
  if (!broker) throw new Error("AniCode Cloud requires a bound credential broker");
  let match: CloudAuthService | undefined;
  const references = authServicesByBroker.get(broker);
  if (!references) throw new Error("AniCode Cloud auth is not bound to this runtime");
  for (const reference of references) {
    const candidate = reference.deref();
    if (!candidate) {
      references.delete(reference);
      continue;
    }
    if (!candidate.isAttachedToBroker(broker)) continue;
    if (match && match !== candidate) {
      throw new Error("AniCode Cloud has multiple auth services for one runtime");
    }
    match = candidate;
  }
  if (!match) throw new Error("AniCode Cloud auth is not bound to this runtime");
  return match.gatewayFetch.bind(match);
}

export function registerAnicodeCloudProvider(auth: CloudAuthService): void {
  rememberAuthService(auth);
  registerOpenAICompatibleProvider({
    id: ANICODE_CLOUD_PROVIDER_ID,
    name: "AniCode Cloud · DeepSeek",
    baseURL: ANICODE_CLOUD_CONFIG.gatewayBaseUrl,
    apiKey: "anicode-cloud-session",
    requiresApiKey: false,
    local: false,
    requireHttps: true,
    fetchFactory: cloudFetchForBindings,
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
