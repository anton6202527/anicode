/**
 * 数据驱动的 Provider 注册表。
 *
 * `provider/model` 的 provider 部分只负责选择传输协议和安全的运行时配置；
 * model id 的其余斜杠会完整保留（例如 openrouter/anthropic/claude-sonnet-4）。
 * 凭证只通过 descriptor 声明的环境变量读取，绝不会回退到其他 provider 的 key。
 */

import { t } from "../i18n.js";
import type { NetworkProxy } from "../runtime/network-proxy.js";
import type { CredentialAvailability, CredentialBroker } from "../security/credentials.js";
import type { Provider } from "../types.js";
import { DebugProvider } from "./debug.js";
import { isLoopbackProviderURL, providerModelsURL } from "./local-endpoint.js";
import { OpenAICompatProvider, type MaxTokensField } from "./openai-compat.js";

export type ProviderKind = "native" | "openai-compatible" | "debug";
export type ProviderProtocol = "anthropic-messages" | "openai-chat" | "debug" | "custom";

export interface ProviderCapabilities {
  /** 是否可接收 function/tool definitions。 */
  tools: boolean;
  /** 是否支持当前 adapter 能安全映射的显式推理参数。 */
  reasoning: boolean;
  /** 是否支持图片输入；第一阶段仅作为能力元数据。 */
  images?: boolean;
}

export interface ProviderLimits {
  /** 最大上下文 token；未知时不填，调用方不得猜一个超大值。 */
  contextWindow?: number;
  /** 最大输出 token；未知时不填。 */
  maxOutputTokens?: number;
}

/**
 * 模型单价（美元 / 每百万 token）。用于会话成本估算展示（对齐 Claude Code /usage），
 * 不用于计费——各家价格会变，这里是内置目录的近似值，未知模型不填即不显示成本。
 */
export interface ModelCost {
  input: number;
  output: number;
  /** 缓存读；缺省按 0.1 × input 估算。 */
  cacheRead?: number;
  /** 缓存写；缺省按 1.25 × input 估算。 */
  cacheWrite?: number;
}

export interface ProviderModelProfile {
  /** 简单 glob：`*` 匹配任意字符，`?` 匹配单字符；按声明顺序叠加覆盖。 */
  pattern: string;
  capabilities?: Partial<ProviderCapabilities>;
  limits?: ProviderLimits;
  cost?: ModelCost;
}

/** 内置模型目录里的一条具体、可直接选用的模型。 */
export interface ProviderCatalogEntry {
  /** model id（`provider/` 之后的部分），可含斜杠。 */
  model: string;
  /** 展示名；缺省回退到 model。 */
  label?: string;
  /** 无需付费即可调用（免费额度或本地推理）。 */
  free?: boolean;
  /** 开放权重 / 开源模型。 */
  openWeight?: boolean;
  /** 推荐用于零配置快速调试。 */
  recommended?: boolean;
  /** 一句话用途说明。 */
  note?: string;
}

/** `listProviderDetails()` 返回的稳定、安全元数据（永不含 key 值）。 */
export interface ProviderDescriptor {
  id: string;
  name: string;
  kind: ProviderKind;
  protocol: ProviderProtocol;
  aliases: readonly string[];
  /** 默认端点；可由 baseURLEnv 覆盖。 */
  baseURL?: string;
  baseURLEnv?: string;
  /** 按顺序查找凭证；只公开变量名，不公开值。 */
  apiKeyEnv: readonly string[];
  requiresApiKey: boolean;
  local: boolean;
  capabilities: ProviderCapabilities;
  limits: ProviderLimits;
  models: readonly ProviderModelProfile[];
  /** 内置的具体可选模型；供 `/model` 选择器和文档展示，不影响解析逻辑。 */
  catalog: readonly ProviderCatalogEntry[];
}

export interface ProviderModelInfo {
  providerId: string;
  model: string;
  capabilities: ProviderCapabilities;
  limits: ProviderLimits;
  /** 命中内置价格表时填充；未知模型缺省。 */
  cost?: ModelCost;
}

/** 按用量与单价估算美元成本；无价格信息返回 undefined。 */
export function estimateCostUSD(
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  },
  cost: ModelCost | undefined,
): number | undefined {
  if (!cost) return undefined;
  const per = 1 / 1_000_000;
  const cacheRead = cost.cacheRead ?? cost.input * 0.1;
  const cacheWrite = cost.cacheWrite ?? cost.input * 1.25;
  return (
    usage.inputTokens * cost.input * per +
    usage.outputTokens * cost.output * per +
    usage.cacheReadTokens * cacheRead * per +
    usage.cacheWriteTokens * cacheWrite * per
  );
}

/** 打平后的目录条目：已带上 provider 归属和可直接用于 createProvider 的 spec。 */
export interface ModelCatalogEntry extends ProviderCatalogEntry {
  providerId: string;
  providerName: string;
  /** `${providerId}/${model}`，可直接传给 createProvider / --model。 */
  spec: string;
  local: boolean;
  requiresApiKey: boolean;
}

export interface ProviderDiagnostics {
  providerId: string;
  model: string;
  name: string;
  kind: ProviderKind;
  baseURL?: string;
  baseURLSource: "environment" | "default" | "none";
  apiKeyEnv: readonly string[];
  /** 命中的环境变量名；不包含凭证值。 */
  credentialEnv?: string;
  /** `configured` 表示仅存在惰性后端引用，尚未读取或验证其值。 */
  credentialAvailability: CredentialAvailability;
  /** 兼容字段：凭证已存在或已显式配置，但不表示 configured 引用已验证。 */
  hasCredentials: boolean;
  requiresApiKey: boolean;
  local: boolean;
  warnings: readonly string[];
}

export interface ResolvedModel {
  provider: Provider;
  model: string;
  /** createProvider 会填充；自定义 resolver 为兼容旧接口可省略。 */
  providerId?: string;
  descriptor?: ProviderDescriptor;
  modelInfo?: ProviderModelInfo;
  diagnostics?: ProviderDiagnostics;
}

/** createProvider 的强类型结果；与宽松的 ResolvedModel 兼容。 */
export interface CreatedModel extends ResolvedModel {
  providerId: string;
  descriptor: ProviderDescriptor;
  modelInfo: ProviderModelInfo;
  diagnostics: ProviderDiagnostics;
}

/**
 * Provider/model metadata that is safe to inspect during session lifecycle operations.
 *
 * Unlike `CreatedModel`, producing this value never constructs a provider client or reads a
 * credential backend. It is therefore suitable for create/open/resume validation.
 */
export type InspectedModel = Omit<CreatedModel, "provider">;

export interface ProviderRuntimeBindings {
  /** Per-host credential boundary. Production callers must bind this instead of using globals. */
  broker?: CredentialBroker;
  /** Per-host controlled egress. Cloud providers fail closed when it is absent. */
  networkProxy?: NetworkProxy;
  /** Environment used for non-secret endpoint configuration and compatibility credentials. */
  environment?: NodeJS.ProcessEnv;
  /** Disabled by production stacks after credentials have moved into the broker. */
  allowEnvironmentFallback?: boolean;
}

export interface BoundProviderRegistry {
  resolveProvider(spec: string): CreatedModel;
  /** Hydrate one exact lazy credential reference before constructing a synchronous SDK client. */
  resolveProviderAsync(spec: string): Promise<CreatedModel>;
  inspectProvider(spec: string): InspectedModel;
  diagnoseProvider(spec: string): ProviderDiagnostics;
  resolveDefaultModel(): string;
  discoverModels(
    providerId: string,
    timeoutMs?: number,
    fetchImpl?: typeof fetch,
  ): Promise<string[] | undefined>;
}

type Factory = (bindings?: ProviderRuntimeBindings) => Provider;

interface RegisteredProvider {
  descriptor: ProviderDescriptor;
  factory: Factory;
  /** Resolve the exact registration-time credential without exposing it through diagnostics. */
  runtime?: (bindings: ProviderRuntimeBindings) => { baseURL?: string; apiKey: string };
  /** Trusted host-owned request transport shared by chat completions and model discovery. */
  fetchFactory?: (bindings: ProviderRuntimeBindings) => typeof fetch;
  /** Reject configured endpoints that are not valid HTTPS URLs before reading credentials. */
  requireHttps?: boolean;
  /** Non-secret headers required by this provider's model-directory endpoint. */
  discoveryHeaders?: Readonly<Record<string, string>>;
  /** 程序化注册的直接凭证是否存在；仅用于诊断布尔值，绝不保存/返回 key。 */
  directCredential?: boolean;
}

export interface OpenAICompatibleProviderRegistration {
  id: string;
  name?: string;
  aliases?: readonly string[];
  baseURL?: string;
  baseURLEnv?: string;
  apiKeyEnv?: string | readonly string[];
  /** 程序化注册时可直接注入；不会出现在 descriptor/diagnostics。 */
  apiKey?: string;
  requiresApiKey?: boolean;
  local?: boolean;
  capabilities?: Partial<ProviderCapabilities>;
  limits?: ProviderLimits;
  models?: readonly ProviderModelProfile[];
  catalog?: readonly ProviderCatalogEntry[];
  /**
   * Trusted host hook for request-scoped authentication or another controlled transport. The
   * returned fetch is used by both Chat Completions and `/models`; never populate this from
   * workspace or other untrusted configuration.
   */
  fetchFactory?: (bindings: ProviderRuntimeBindings) => typeof fetch;
  /** Require the default or environment-overridden base URL to be a valid HTTPS URL. */
  requireHttps?: boolean;
  defaultHeaders?: Record<string, string>;
  streamUsage?: boolean;
  maxTokensField?: MaxTokensField;
  reasoningEffort?: boolean;
}

const providers = new Map<string, RegisteredProvider>();
const canonical = new Map<string, RegisteredProvider>();
let providerCredentialBroker: CredentialBroker | undefined;
let providerNetworkProxy: NetworkProxy | undefined;
let providerEnvironmentFallback = true;

function legacyRuntimeBindings(): ProviderRuntimeBindings {
  return {
    ...(providerCredentialBroker ? { broker: providerCredentialBroker } : {}),
    ...(providerNetworkProxy ? { networkProxy: providerNetworkProxy } : {}),
    environment: process.env,
    allowEnvironmentFallback: providerEnvironmentFallback,
  };
}

const MAX_MODEL_DISCOVERY_BODY_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 500;
const MODEL_DISCOVERY_CACHE_TTL_MS = 15_000;
const MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS = 2_000;
const MAX_MODEL_ID_BYTES = 512;
const UNSAFE_MODEL_ID = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

interface CachedModelDiscovery {
  expiresAt: number;
  models: string[] | undefined;
}

interface ModelDiscoveryCacheSlot {
  cached?: CachedModelDiscovery;
  inFlight?: Promise<string[] | undefined>;
}

interface ModelDiscoveryCache {
  entries: WeakMap<RegisteredProvider, Map<string, ModelDiscoveryCacheSlot>>;
}

let legacyModelDiscoveryCache: ModelDiscoveryCache = createModelDiscoveryCache();
const boundModelDiscoveryCaches = new WeakMap<ProviderRuntimeBindings, ModelDiscoveryCache>();

/**
 * Provider ids cross IPC/HTTP boundaries during live model discovery. Keep the accepted shape
 * deliberately smaller than an arbitrary URL/path segment and never trim attacker-controlled
 * input into a different provider identity.
 */
export function sanitizeProviderId(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    ? value
    : undefined;
}

/**
 * AniCode's provider adapter is a text/tool Chat Completions client. Do not offer endpoint-specific
 * models that require a different API or produce a non-text artifact. Vision-capable chat models
 * remain allowed; only clearly specialised model IDs are filtered here.
 */
export function isAgentCompatibleModelId(model: string): boolean {
  const id = model.toLowerCase();
  const segment = (name: string) => new RegExp(`(^|[-._/:])${name}($|[-._/:])`, "i").test(id);
  if (segment("embedding") || segment("embeddings") || segment("rerank")) return false;
  if (segment("moderation") || segment("whisper") || segment("transcribe")) return false;
  if (segment("tts") || segment("speech") || segment("audio") || segment("realtime")) return false;
  if (
    segment("image") ||
    segment("images") ||
    segment("imagen") ||
    segment("dall") ||
    segment("sora") ||
    segment("video") ||
    segment("veo") ||
    segment("lyria") ||
    segment("robotics") ||
    segment("computer-use")
  ) {
    return false;
  }
  return true;
}

function safeDiscoveredModelId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim();
  if (!id || Buffer.byteLength(id, "utf8") > MAX_MODEL_ID_BYTES || UNSAFE_MODEL_ID.test(id)) {
    return undefined;
  }
  return isAgentCompatibleModelId(id) ? id : undefined;
}

/** Revalidate provider responses at every host/transport boundary; malformed data fails closed. */
export function sanitizeDiscoveredModels(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [
    ...new Set(
      value
        .map((model) => safeDiscoveredModelId(model))
        .filter((model): model is string => model !== undefined),
    ),
  ].slice(0, MAX_DISCOVERED_MODELS);
}

async function readBoundedJsonPayload(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    return JSON.parse(
      Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total,
      ).toString("utf8"),
    );
  } catch {
    await reader.cancel().catch(() => undefined);
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

function createModelDiscoveryCache(): ModelDiscoveryCache {
  return { entries: new WeakMap() };
}

function modelDiscoveryCacheFor(
  bindings: ProviderRuntimeBindings | undefined,
): ModelDiscoveryCache {
  if (!bindings) return legacyModelDiscoveryCache;
  const existing = boundModelDiscoveryCaches.get(bindings);
  if (existing) return existing;
  const created = createModelDiscoveryCache();
  boundModelDiscoveryCaches.set(bindings, created);
  return created;
}

async function cachedModelDiscovery(
  cache: ModelDiscoveryCache,
  entry: RegisteredProvider,
  cacheKey: string,
  load: () => Promise<string[] | undefined>,
): Promise<string[] | undefined> {
  let providerSlots = cache.entries.get(entry);
  if (!providerSlots) {
    providerSlots = new Map();
    cache.entries.set(entry, providerSlots);
  }
  let slot = providerSlots.get(cacheKey);
  if (!slot) {
    // A bound registry normally has one endpoint per provider. Cap legacy env churn as defense in
    // depth rather than retaining every historical base URL until process exit.
    if (providerSlots.size >= 4) providerSlots.clear();
    slot = {};
    providerSlots.set(cacheKey, slot);
  }
  if (slot.cached && slot.cached.expiresAt > Date.now()) {
    return slot.cached.models ? [...slot.cached.models] : undefined;
  }
  if (slot.inFlight) {
    const models = await slot.inFlight;
    return models ? [...models] : undefined;
  }

  const inFlight = load()
    .catch(() => undefined)
    .then((models) => {
      const safeModels = models ? [...models] : undefined;
      slot!.cached = {
        expiresAt:
          Date.now() +
          (safeModels && safeModels.length > 0
            ? MODEL_DISCOVERY_CACHE_TTL_MS
            : MODEL_DISCOVERY_FAILURE_CACHE_TTL_MS),
        models: safeModels,
      };
      return safeModels;
    });
  slot.inFlight = inFlight;
  try {
    const models = await inFlight;
    return models ? [...models] : undefined;
  } finally {
    if (slot.inFlight === inFlight) delete slot.inFlight;
  }
}

function normalizeDiscoveryTimeout(value: number): number {
  if (!Number.isFinite(value)) return 2_000;
  return Math.max(100, Math.min(10_000, Math.floor(value)));
}

async function withHardTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  const controller = new AbortController();
  type Outcome = { type: "value"; value: T } | { type: "error" } | { type: "timeout" };
  const running: Promise<Outcome> = Promise.resolve()
    .then(() => operation(controller.signal))
    .then(
      (value) => ({ type: "value" as const, value }),
      () => ({ type: "error" as const }),
    );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ type: "timeout" }), timeoutMs);
  });
  const outcome = await Promise.race([running, expired]);
  if (timer) clearTimeout(timer);
  controller.abort();
  return outcome.type === "value" ? outcome.value : undefined;
}

function requestHeaders(entry: RegisteredProvider, apiKey: string): { headers: Headers } {
  const headers = new Headers(entry.discoveryHeaders);
  if (apiKey && apiKey !== "anicode-local") headers.set("authorization", `Bearer ${apiKey}`);
  return { headers };
}

function networkProxyFetch(proxy: NetworkProxy): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) =>
    proxy.fetch(
      typeof input === "string" || input instanceof URL ? input : input.url,
      init,
    )) as typeof fetch;
}

/** 宿主把环境/Keychain/Vault 密钥导入 Broker 后调用；provider adapter 优先从 Broker 取。 */
export function configureProviderCredentialBroker(
  broker: CredentialBroker | undefined,
  options: { allowEnvironmentFallback?: boolean } = {},
): void {
  providerCredentialBroker = broker;
  providerEnvironmentFallback = options.allowEnvironmentFallback ?? broker === undefined;
  legacyModelDiscoveryCache = createModelDiscoveryCache();
}

/** 生产宿主把 provider SDK 的 fetch 也收口到同一策略化出口。 */
export function configureProviderNetworkProxy(proxy: NetworkProxy | undefined): void {
  providerNetworkProxy = proxy;
  legacyModelDiscoveryCache = createModelDiscoveryCache();
}

const cloudDefaults: ProviderCapabilities = { tools: true, reasoning: false, images: false };

function openAI(
  id: string,
  name: string,
  baseURL: string,
  apiKeyEnv: string | readonly string[],
  options: Omit<OpenAICompatibleProviderRegistration, "id" | "name" | "baseURL" | "apiKeyEnv"> = {},
): OpenAICompatibleProviderRegistration {
  return { id, name, baseURL, apiKeyEnv, ...options };
}

const OPENAI_BUILTINS: OpenAICompatibleProviderRegistration[] = [
  openAI("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", {
    baseURLEnv: "DEEPSEEK_BASE_URL",
    requireHttps: true,
    streamUsage: true,
    maxTokensField: "max_tokens",
    reasoningEffort: false,
    capabilities: cloudDefaults,
    limits: { contextWindow: 1_000_000, maxOutputTokens: 384_000 },
    models: [
      {
        pattern: "deepseek-v4-flash",
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028 },
      },
      {
        pattern: "deepseek-v4-pro",
        cost: { input: 0.435, output: 0.87, cacheRead: 0.003625 },
      },
      {
        pattern: "deepseek-chat",
        limits: { contextWindow: 64_000, maxOutputTokens: 8_000 },
        cost: { input: 0.27, output: 1.1, cacheRead: 0.07 },
      },
      {
        pattern: "deepseek-reasoner",
        capabilities: { reasoning: true },
        limits: { contextWindow: 64_000, maxOutputTokens: 8_000 },
        cost: { input: 0.55, output: 2.19, cacheRead: 0.14 },
      },
    ],
    catalog: [
      {
        model: "deepseek-v4-flash",
        label: "DeepSeek V4 Flash",
        openWeight: true,
        recommended: true,
        note: "开放权重、官方直连；优先使用赠送余额，超出后按量计费",
      },
      {
        model: "deepseek-v4-pro",
        label: "DeepSeek V4 Pro",
        openWeight: true,
        note: "更强的官方模型，按量计费",
      },
    ],
  }),
  openAI(
    "gemini",
    "Gemini",
    "https://generativelanguage.googleapis.com/v1beta/openai/",
    ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    {
      baseURLEnv: "GEMINI_BASE_URL",
      streamUsage: false,
      maxTokensField: "max_tokens",
      reasoningEffort: false,
      capabilities: { ...cloudDefaults, images: true },
      limits: { contextWindow: 1_048_576, maxOutputTokens: 65_536 },
      models: [
        {
          pattern: "gemini-3.6-flash*",
          capabilities: { reasoning: true },
          cost: { input: 1.5, output: 7.5 },
        },
        {
          pattern: "gemini-3.5-flash-lite*",
          capabilities: { reasoning: true },
          cost: { input: 0.3, output: 2.5 },
        },
        {
          pattern: "gemini-3.5-flash*",
          capabilities: { reasoning: true },
        },
        {
          pattern: "gemini-3.1-pro*",
          capabilities: { reasoning: true },
        },
        {
          pattern: "gemini-2.5-flash*",
          limits: { maxOutputTokens: 8_192 },
          cost: { input: 0.075, output: 0.3, cacheRead: 0.0025 },
        },
        {
          pattern: "gemini-2.5-pro*",
          capabilities: { reasoning: true },
          limits: { maxOutputTokens: 65_536 },
          cost: { input: 1.25, output: 10.0, cacheRead: 0.0425 },
        },
      ],
      catalog: [
        {
          model: "gemini-3.6-flash",
          label: "Gemini 3.6 Flash",
          recommended: true,
          note: "当前 GA 主力模型，适合编码、工具调用与多模态任务",
        },
        {
          model: "gemini-3.5-flash-lite",
          label: "Gemini 3.5 Flash-Lite",
          note: "当前 GA 低延迟、低成本模型",
        },
        {
          model: "gemini-3.5-flash",
          label: "Gemini 3.5 Flash",
          note: "稳定 Flash 模型",
        },
        {
          model: "gemini-3.1-pro-preview",
          label: "Gemini 3.1 Pro Preview",
          note: "复杂推理与编码预览模型",
        },
      ],
    },
  ),
  openAI("cliproxy", "CLI Proxy API", "http://127.0.0.1:8317/v1", "CLIPROXY_API_KEY", {
    baseURLEnv: "CLIPROXY_BASE_URL",
    requiresApiKey: true,
    local: true,
    streamUsage: false,
    maxTokensField: "max_tokens",
    reasoningEffort: false,
    capabilities: { ...cloudDefaults, images: true },
    limits: { contextWindow: 1_048_576, maxOutputTokens: 8_192 },
    models: [
      {
        pattern: "gemini-*pro*",
        capabilities: { reasoning: true },
      },
      {
        pattern: "gemini-*-agent",
        capabilities: { reasoning: true },
      },
      {
        pattern: "claude-*-thinking",
        capabilities: { reasoning: true },
      },
      {
        pattern: "gpt-oss-*",
        capabilities: { reasoning: true },
      },
    ],
    catalog: [
      {
        model: "gemini-3.6-flash-high",
        label: "Gemini 3.6 Flash High",
        recommended: true,
        note: "CLI Proxy 当前高推理档",
      },
      {
        model: "gemini-3.1-pro-low",
        label: "Gemini 3.1 Pro Low",
      },
      {
        model: "gemini-3.5-flash-low",
        label: "Gemini 3.5 Flash Low",
      },
      {
        model: "gemini-3.5-flash-extra-low",
        label: "Gemini 3.5 Flash Extra Low",
      },
      {
        model: "gemini-3-flash",
        label: "Gemini 3 Flash",
      },
      {
        model: "gemini-pro-agent",
        label: "Gemini Pro Agent",
      },
      {
        model: "gemini-3-flash-agent",
        label: "Gemini 3 Flash Agent",
      },
      {
        model: "gemini-3.1-flash-lite",
        label: "Gemini 3.1 Flash Lite",
      },
      {
        model: "gemini-3.1-flash-image",
        label: "Gemini 3.1 Flash Image",
      },
      {
        model: "claude-opus-4-6-thinking",
        label: "Claude Opus 4.6 Thinking",
      },
      {
        model: "claude-sonnet-4-6",
        label: "Claude Sonnet 4.6",
      },
      {
        model: "gpt-oss-120b-medium",
        label: "GPT-OSS 120B Medium",
      },
    ],
  }),
  // 通用 OpenAI Chat Completions 兼容端点。它必须是内置项，因为 anicode.json
  // 只能选择 provider，无法在启动前调用 registerProvider；缺少此项会让文档中的
  // `model: "custom/<model>"` 在应用创建首个会话时直接报「未知 provider」。
  openAI(
    "custom",
    "Custom OpenAI-compatible",
    "http://127.0.0.1:8000/v1",
    "CUSTOM_OPENAI_API_KEY",
    {
      baseURLEnv: "CUSTOM_OPENAI_BASE_URL",
      requiresApiKey: false,
      local: true,
      streamUsage: false,
      maxTokensField: "max_tokens",
      reasoningEffort: false,
      capabilities: cloudDefaults,
    },
  ),
];

for (const builtin of OPENAI_BUILTINS) registerOpenAICompatibleProvider(builtin);

const debugDescriptor = descriptor({
  id: "debug",
  name: "AniCode Zen Debug",
  kind: "debug",
  protocol: "debug",
  aliases: ["demo"],
  apiKeyEnv: [],
  requiresApiKey: false,
  local: true,
  capabilities: { tools: true, reasoning: false, images: false },
  limits: { contextWindow: 128_000, maxOutputTokens: 16_000 },
  // 零网络、零凭证，永远可用。模型名任意，DebugProvider 会流式 echo 并支持
  // !todo/!write/!bash/!parallel 指令来驱动真实工具链路。
  catalog: [
    {
      model: "demo",
      label: "Debug Demo（零网络 · 免费）",
      free: true,
      recommended: true,
      note: "离线流式 echo + !todo/!write/!bash/!parallel 工具指令",
    },
  ],
});
install({ descriptor: debugDescriptor, factory: () => new DebugProvider() });

/** 兼容旧 API：允许上层注册完全自定义的 Provider factory。 */
export function registerProvider(prefix: string, factory: Factory): void {
  const id = validId(prefix);
  install({
    descriptor: descriptor({
      id,
      name: id,
      kind: "native",
      protocol: "custom",
      apiKeyEnv: [],
      requiresApiKey: false,
      local: false,
      capabilities: { tools: true, reasoning: false },
    }),
    factory,
  });
}

/** 注册一个配置化的 OpenAI Chat Completions 兼容端点。 */
export function registerOpenAICompatibleProvider(input: OpenAICompatibleProviderRegistration): void;
export function registerOpenAICompatibleProvider(
  id: string,
  input: Omit<OpenAICompatibleProviderRegistration, "id">,
): void;
export function registerOpenAICompatibleProvider(
  inputOrId: OpenAICompatibleProviderRegistration | string,
  options?: Omit<OpenAICompatibleProviderRegistration, "id">,
): void {
  const input: OpenAICompatibleProviderRegistration =
    typeof inputOrId === "string" ? { id: inputOrId, ...(options ?? {}) } : inputOrId;
  const id = validId(input.id);
  const d = descriptor({
    id,
    name: input.name ?? id,
    kind: "openai-compatible",
    protocol: "openai-chat",
    ...(input.aliases ? { aliases: input.aliases } : {}),
    ...(input.baseURL ? { baseURL: input.baseURL } : {}),
    ...(input.baseURLEnv ? { baseURLEnv: input.baseURLEnv } : {}),
    apiKeyEnv: envNames(input.apiKeyEnv),
    requiresApiKey: input.requiresApiKey ?? !input.local,
    local: input.local ?? false,
    capabilities: { ...cloudDefaults, ...input.capabilities },
    ...(input.limits ? { limits: input.limits } : {}),
    ...(input.models ? { models: input.models } : {}),
    ...(input.catalog ? { catalog: input.catalog } : {}),
  });
  const fetchFactory = input.fetchFactory;
  const requireHttps = input.requireHttps === true;
  const resolveRuntime = (bindings: ProviderRuntimeBindings) =>
    runtimeConfig(d, input.apiKey, bindings, requireHttps);

  install({
    descriptor: d,
    directCredential: Boolean(input.apiKey),
    runtime: resolveRuntime,
    ...(fetchFactory ? { fetchFactory } : {}),
    ...(requireHttps ? { requireHttps: true } : {}),
    ...(input.defaultHeaders ? { discoveryHeaders: { ...input.defaultHeaders } } : {}),
    factory: (bindings = legacyRuntimeBindings()) => {
      const runtime = resolveRuntime(bindings);
      const directLoopback = Boolean(
        d.local && runtime.baseURL && isLoopbackProviderURL(runtime.baseURL),
      );
      const request = fetchFactory
        ? fetchFactory(bindings)
        : !directLoopback && bindings.networkProxy
          ? networkProxyFetch(bindings.networkProxy)
          : undefined;
      return new OpenAICompatProvider({
        name: d.id,
        ...(runtime.baseURL ? { baseURL: runtime.baseURL } : {}),
        // 始终显式传入（包括空串），禁止 SDK 回退到 OPENAI_API_KEY。
        apiKey: runtime.apiKey,
        maxRetries: 0,
        ...(request ? { fetch: request } : {}),
        ...(input.defaultHeaders ? { defaultHeaders: input.defaultHeaders } : {}),
        ...(input.streamUsage !== undefined ? { streamUsage: input.streamUsage } : {}),
        ...(input.maxTokensField !== undefined ? { maxTokensField: input.maxTokensField } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
      });
    },
  });
}

/**
 * 已知 provider 的「便宜快速模型」——用于摘要 / 起标题 / 读大文件后处理等杂活，
 * 对齐 Claude Code「>50% 调用走小模型」的成本策略。返回 `provider/model` spec，
 * 未知 provider 返回 undefined（调用方回退到主模型）。
 */
const SMALL_MODELS: Record<string, string> = {
  deepseek: "deepseek/deepseek-v4-flash",
  gemini: "gemini/gemini-3.6-flash",
  cliproxy: "cliproxy/gemini-3.5-flash-extra-low",
};

/** 未显式指定模型时，按凭证就绪状态挑选云端默认模型。 */
const DEFAULT_MODEL_PREFERENCES = [
  "deepseek/deepseek-v4-flash",
  "cliproxy/gemini-3.6-flash-high",
  "gemini/gemini-3.6-flash",
] as const;

export function resolveDefaultModel(): string {
  for (const spec of DEFAULT_MODEL_PREFERENCES) {
    try {
      const diagnostics = diagnoseProvider(spec);
      if (diagnostics.requiresApiKey && diagnostics.hasCredentials) return spec;
    } catch {
      // 某个可选 provider 未注册时继续尝试下一项。
    }
  }
  return "debug/demo";
}

export function defaultSmallModel(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  return SMALL_MODELS[providerId];
}

/** 所有可用于 `provider/model` 的前缀（含 alias），保留原 API 形态。 */
export function listProviders(): string[] {
  return [...providers.keys()];
}

/** canonical provider 的安全描述；返回副本，调用方无法修改注册表。 */
export function listProviderDetails(): ProviderDescriptor[] {
  return [...canonical.values()].map((entry) => cloneDescriptor(entry.descriptor));
}

/**
 * 打平所有 canonical provider 的内置模型目录，供 `/model` 选择器与文档使用。
 * 顺序稳定：先按 provider 注册顺序，provider 内保留声明顺序。
 */
export function listModelCatalog(): ModelCatalogEntry[] {
  const entries: ModelCatalogEntry[] = [];
  for (const { descriptor: d } of canonical.values()) {
    for (const item of d.catalog) {
      entries.push({
        ...item,
        providerId: d.id,
        providerName: d.name,
        spec: `${d.id}/${item.model}`,
        local: d.local,
        requiresApiKey: d.requiresApiKey,
      });
    }
  }
  return entries;
}

/**
 * 从 OpenAI-compatible provider 的 `/models` 读取实时模型 ID。
 * 凭证只在 registry 内部组装进请求头，不会返回给调用方；失败返回 undefined，
 * 让 `/model` 严格隐藏该 provider。成功但列表为空则返回空数组。
 * 云端请求复用统一 NetworkProxy；本机回环服务才允许直连。
 */
export async function discoverProviderModels(
  providerId: string,
  timeoutMs = 2_000,
  fetchImpl: typeof fetch = fetch,
  bindings?: ProviderRuntimeBindings,
): Promise<string[] | undefined> {
  const safeProviderId = sanitizeProviderId(providerId);
  if (!safeProviderId) return undefined;
  const entry = providers.get(safeProviderId);
  if (!entry) return undefined;
  const d = entry.descriptor;
  if (d.kind === "debug") return sanitizeDiscoveredModels(d.catalog.map((model) => model.model));
  if (d.kind !== "openai-compatible") return undefined;
  const activeBindings = bindings ?? legacyRuntimeBindings();
  const configuredBaseURL =
    (d.baseURLEnv ? nonEmptyEnv(d.baseURLEnv, activeBindings.environment) : undefined) ?? d.baseURL;
  if (!configuredBaseURL) return undefined;
  if (providerBaseURLSecurityWarning(d.id, configuredBaseURL, entry.requireHttps === true)) {
    return undefined;
  }
  const modelsURL = providerModelsURL(configuredBaseURL);
  if (!modelsURL) return undefined;
  const hasRegisteredFetch = entry.fetchFactory !== undefined;
  // Reject an unusable egress route before opening a lazy credential reference.
  if (!hasRegisteredFetch && d.local && !isLoopbackProviderURL(configuredBaseURL)) return undefined;
  const directLoopback = d.local && isLoopbackProviderURL(configuredBaseURL);
  if (!hasRegisteredFetch && !directLoopback && !activeBindings.networkProxy) return undefined;

  await prepareRuntimeCredential(entry, activeBindings);
  const runtime = entry.runtime?.(activeBindings) ?? runtimeConfig(d, undefined, activeBindings);
  if (!runtime.baseURL || (d.requiresApiKey && !runtime.apiKey)) return undefined;
  const boundedTimeoutMs = normalizeDiscoveryTimeout(timeoutMs);
  const cache = modelDiscoveryCacheFor(bindings);
  const cacheKey = modelsURL.toString();

  return cachedModelDiscovery(cache, entry, cacheKey, () =>
    withHardTimeout(boundedTimeoutMs, async (signal) => {
      // A trusted registration-owned transport may replace NetworkProxy (for example to attach a
      // short-lived host credential). Without it, cloud discovery remains fail-closed and only a
      // local loopback endpoint may use the caller's direct fixture fetch.
      const request =
        entry.fetchFactory?.(activeBindings) ??
        (directLoopback ? fetchImpl : networkProxyFetch(activeBindings.networkProxy!));
      const response = await request(modelsURL, {
        signal,
        redirect: "error",
        ...requestHeaders(entry, runtime.apiKey),
      });
      if (signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const payload = (await readBoundedJsonPayload(response, MAX_MODEL_DISCOVERY_BODY_BYTES)) as
        { data?: Array<{ id?: unknown }> } | undefined;
      if (!Array.isArray(payload?.data)) return undefined;
      return sanitizeDiscoveredModels(payload.data.map((model) => model.id));
    }),
  );
}

export function createProvider(spec: string): CreatedModel {
  return createProviderWithBindings(spec, legacyRuntimeBindings());
}

function inspectProviderWithBindings(
  spec: string,
  bindings: ProviderRuntimeBindings,
): InspectedModel {
  const parsed = resolveSpec(spec);
  return {
    model: parsed.model,
    providerId: parsed.entry.descriptor.id,
    descriptor: cloneDescriptor(parsed.entry.descriptor),
    modelInfo: resolveModelInfo(parsed.entry.descriptor, parsed.model),
    diagnostics: diagnosticsFor(parsed.entry, parsed.model, bindings),
  };
}

/** Pure provider/model lookup: no client construction, network request, or secret-backend read. */
export function inspectProvider(spec: string): InspectedModel {
  return inspectProviderWithBindings(spec, legacyRuntimeBindings());
}

function createProviderWithBindings(spec: string, bindings: ProviderRuntimeBindings): CreatedModel {
  const parsed = resolveSpec(spec);
  const descriptorCopy = cloneDescriptor(parsed.entry.descriptor);
  return {
    provider: parsed.entry.factory(bindings),
    model: parsed.model,
    providerId: parsed.entry.descriptor.id,
    descriptor: descriptorCopy,
    modelInfo: resolveModelInfo(parsed.entry.descriptor, parsed.model),
    diagnostics: diagnosticsFor(parsed.entry, parsed.model, bindings),
  };
}

async function createProviderWithBindingsAsync(
  spec: string,
  bindings: ProviderRuntimeBindings,
): Promise<CreatedModel> {
  const parsed = resolveSpec(spec);
  await prepareRuntimeCredential(parsed.entry, bindings);
  return createProviderWithBindings(spec, bindings);
}

/** 启动前诊断，无网络请求，也不会实例化 SDK client。 */
export function diagnoseProvider(spec: string): ProviderDiagnostics {
  return inspectProvider(spec).diagnostics;
}

/**
 * Create an immutable per-host provider facade. No request made through this object observes a
 * later global configureProvider* call or another LocalRuntimeStack's credentials/proxy.
 */
export function bindProviderRegistry(bindings: ProviderRuntimeBindings): BoundProviderRegistry {
  const bound: ProviderRuntimeBindings = {
    ...(bindings.broker ? { broker: bindings.broker } : {}),
    ...(bindings.networkProxy ? { networkProxy: bindings.networkProxy } : {}),
    environment: { ...(bindings.environment ?? {}) },
    allowEnvironmentFallback: bindings.allowEnvironmentFallback ?? false,
  };
  const inspect = (spec: string) => inspectProviderWithBindings(spec, bound);
  const diagnose = (spec: string) => inspect(spec).diagnostics;
  return Object.freeze({
    resolveProvider(spec: string) {
      const result = createProviderWithBindings(spec, bound);
      if (result.diagnostics.requiresApiKey && !result.diagnostics.hasCredentials) {
        throw new Error(result.diagnostics.warnings.join("; "));
      }
      return result;
    },
    async resolveProviderAsync(spec: string) {
      const result = await createProviderWithBindingsAsync(spec, bound);
      if (result.diagnostics.requiresApiKey && !result.diagnostics.hasCredentials) {
        throw new Error(result.diagnostics.warnings.join("; "));
      }
      return result;
    },
    inspectProvider: inspect,
    diagnoseProvider: diagnose,
    resolveDefaultModel() {
      for (const spec of DEFAULT_MODEL_PREFERENCES) {
        try {
          const diagnostics = diagnose(spec);
          if (diagnostics.requiresApiKey && diagnostics.hasCredentials) return spec;
        } catch {
          // Optional provider unavailable in this registry.
        }
      }
      return "debug/demo";
    },
    discoverModels(providerId: string, timeoutMs = 2_000, fetchImpl: typeof fetch = fetch) {
      return discoverProviderModels(providerId, timeoutMs, fetchImpl, bound);
    },
  });
}

function install(entry: RegisteredProvider): void {
  const previous = canonical.get(entry.descriptor.id);
  if (previous) {
    for (const alias of previous.descriptor.aliases) {
      if (providers.get(alias) === previous) providers.delete(alias);
    }
  }
  canonical.set(entry.descriptor.id, entry);
  providers.set(entry.descriptor.id, entry);
  for (const alias of entry.descriptor.aliases) providers.set(validId(alias), entry);
}

function descriptor(
  input: Omit<
    ProviderDescriptor,
    "aliases" | "apiKeyEnv" | "capabilities" | "limits" | "models" | "catalog"
  > & {
    aliases?: readonly string[];
    apiKeyEnv?: readonly string[];
    capabilities?: Partial<ProviderCapabilities>;
    limits?: ProviderLimits;
    models?: readonly ProviderModelProfile[];
    catalog?: readonly ProviderCatalogEntry[];
  },
): ProviderDescriptor {
  return {
    ...input,
    aliases: [...(input.aliases ?? [])],
    apiKeyEnv: [...(input.apiKeyEnv ?? [])],
    capabilities: { tools: false, reasoning: false, ...input.capabilities },
    limits: { ...(input.limits ?? {}) },
    models: (input.models ?? []).map((m) => ({
      ...m,
      ...(m.capabilities ? { capabilities: { ...m.capabilities } } : {}),
      ...(m.limits ? { limits: { ...m.limits } } : {}),
    })),
    catalog: (input.catalog ?? []).map((c) => ({ ...c })),
  };
}

function cloneDescriptor(d: ProviderDescriptor): ProviderDescriptor {
  return descriptor(d);
}

function envNames(value: string | readonly string[] | undefined): string[] {
  if (!value) return [];
  return (typeof value === "string" ? [value] : [...value]).filter(Boolean);
}

function validId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
    throw new Error(
      t(
        `Invalid provider id: ${JSON.stringify(value)}`,
        `非法 provider id: ${JSON.stringify(value)}`,
      ),
    );
  }
  return id;
}

function runtimeConfig(
  d: ProviderDescriptor,
  directApiKey?: string,
  bindings: ProviderRuntimeBindings = legacyRuntimeBindings(),
  requireHttps = false,
): { baseURL?: string; apiKey: string } {
  const envBase = d.baseURLEnv ? nonEmptyEnv(d.baseURLEnv, bindings.environment) : undefined;
  const baseURL = envBase ?? d.baseURL;
  assertProviderBaseURLSecurity(d.id, baseURL, requireHttps);
  const credential =
    directApiKey ?? findCredential(d.apiKeyEnv, `provider:${d.id}`, baseURL, bindings)?.value;
  return {
    ...(baseURL ? { baseURL } : {}),
    // 本地匿名服务仍给 SDK 一个无敏感性的占位 key；云端缺 key 用空串尽早失败。
    apiKey: credential ?? (d.requiresApiKey ? "" : "anicode-local"),
  };
}

function providerBaseURLSecurityWarning(
  providerId: string,
  baseURL: string | undefined,
  requireHttps: boolean,
): string | undefined {
  if (!requireHttps || !baseURL) return undefined;
  try {
    if (new URL(baseURL).protocol === "https:") return undefined;
  } catch {
    // A malformed URL cannot satisfy an HTTPS-only provider policy.
  }
  return t(
    `Security policy rejected ${providerId} baseURL: a valid HTTPS URL is required`,
    `安全策略拒绝 ${providerId} baseURL：必须使用有效的 HTTPS URL`,
  );
}

function assertProviderBaseURLSecurity(
  providerId: string,
  baseURL: string | undefined,
  requireHttps: boolean,
): void {
  const warning = providerBaseURLSecurityWarning(providerId, baseURL, requireHttps);
  if (warning) throw new Error(warning);
}

function diagnosticsFor(
  entry: RegisteredProvider,
  model: string,
  bindings: ProviderRuntimeBindings = legacyRuntimeBindings(),
): ProviderDiagnostics {
  const d = entry.descriptor;
  const envBase = d.baseURLEnv ? nonEmptyEnv(d.baseURLEnv, bindings.environment) : undefined;
  const baseURL = envBase ?? d.baseURL;
  const credential = findCredentialAvailability(d.apiKeyEnv, bindings);
  const credentialAvailability: CredentialAvailability = entry.directCredential
    ? "available"
    : (credential?.availability ?? "unavailable");
  const warnings: string[] = [];
  // Third-party subscription OAuth is intentionally not accepted as production credentials.
  const hasCredentials = credentialAvailability !== "unavailable";
  if (d.requiresApiKey && !hasCredentials) {
    warnings.push(
      t(
        `Missing credentials: set ${d.apiKeyEnv.join(" or ") || "the provider's API key"}`,
        `缺少凭证：请设置 ${d.apiKeyEnv.join(" 或 ") || "provider 对应的 API key"}`,
      ),
    );
  }
  if (!baseURL && d.kind !== "debug")
    warnings.push(t("provider baseURL is not configured", "未配置 provider baseURL"));
  const baseURLSecurityWarning = providerBaseURLSecurityWarning(
    d.id,
    baseURL,
    entry.requireHttps === true,
  );
  if (baseURLSecurityWarning) warnings.push(baseURLSecurityWarning);
  if (d.local && baseURL && !isLoopbackProviderURL(baseURL)) {
    warnings.push(
      t(
        "local provider baseURL is not loopback; automatic discovery is disabled and requests must pass the network policy",
        "本地 provider 的 baseURL 不是回环地址；已禁用自动发现，请求必须经过网络策略",
      ),
    );
  }
  return {
    providerId: d.id,
    model,
    name: d.name,
    kind: d.kind,
    ...(baseURL ? { baseURL } : {}),
    baseURLSource: envBase ? "environment" : d.baseURL ? "default" : "none",
    apiKeyEnv: [...d.apiKeyEnv],
    ...(credential ? { credentialEnv: credential.name } : {}),
    credentialAvailability,
    hasCredentials,
    requiresApiKey: d.requiresApiKey,
    local: d.local,
    warnings,
  };
}

/** Pure metadata lookup: never calls trustedValue/getSync or otherwise opens a secret backend. */
function findCredentialAvailability(
  names: readonly string[],
  bindings: ProviderRuntimeBindings = legacyRuntimeBindings(),
): { name: string; availability: CredentialAvailability } | undefined {
  for (const name of names) {
    const availability = bindings.broker?.availability(`env:${name}`) ?? "unavailable";
    if (availability !== "unavailable") return { name, availability };
    if (
      (bindings.allowEnvironmentFallback ?? false) &&
      nonEmptyEnv(name, bindings.environment) !== undefined
    ) {
      return { name, availability: "available" };
    }
  }
  return undefined;
}

function findCredential(
  names: readonly string[],
  audience?: string,
  baseURL?: string,
  bindings: ProviderRuntimeBindings = legacyRuntimeBindings(),
): { name: string; value: string } | undefined {
  for (const name of names) {
    const brokerId = `env:${name}`;
    if (bindings.broker?.has(brokerId) && audience) {
      let host: string | undefined;
      try {
        host = baseURL ? new URL(baseURL).hostname : undefined;
      } catch {
        /* 非法 URL 由 provider 自身诊断；scope 保守按无 host 处理。 */
      }
      // An explicitly configured reference is authoritative. Propagate its safe typed failure
      // instead of disguising a denied/locked/timed-out Keychain read as a missing key and then
      // opening additional fallback entries.
      return {
        name,
        value: bindings.broker.trustedValue(brokerId, {
          audience,
          ...(host ? { host } : {}),
        }),
      };
    }
    if (bindings.allowEnvironmentFallback ?? false) {
      const value = nonEmptyEnv(name, bindings.environment);
      if (value !== undefined) return { name, value };
    }
  }
  return undefined;
}

/**
 * Hydrate only the credential alias the synchronous runtime factory will select. Environment and
 * direct credentials stay process-local and require no backend I/O. A configured broker reference
 * is authoritative: its safe failure is propagated and later aliases are not probed.
 */
async function prepareRuntimeCredential(
  entry: RegisteredProvider,
  bindings: ProviderRuntimeBindings,
): Promise<void> {
  if (entry.directCredential) return;
  const descriptor = entry.descriptor;
  const envBase = descriptor.baseURLEnv
    ? nonEmptyEnv(descriptor.baseURLEnv, bindings.environment)
    : undefined;
  const baseURL = envBase ?? descriptor.baseURL;
  assertProviderBaseURLSecurity(descriptor.id, baseURL, entry.requireHttps === true);
  for (const name of descriptor.apiKeyEnv) {
    const brokerId = `env:${name}`;
    if (bindings.broker?.has(brokerId)) {
      let host: string | undefined;
      try {
        host = baseURL ? new URL(baseURL).hostname : undefined;
      } catch {
        // Invalid endpoint diagnostics remain the provider adapter's responsibility. Scope checks
        // conservatively omit a host exactly as the synchronous path does.
      }
      await bindings.broker.trustedValueAsync(brokerId, {
        audience: `provider:${descriptor.id}`,
        ...(host ? { host } : {}),
      });
      return;
    }
    if (
      (bindings.allowEnvironmentFallback ?? false) &&
      nonEmptyEnv(name, bindings.environment) !== undefined
    ) {
      return;
    }
  }
}

function nonEmptyEnv(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = environment[name];
  return value && value.trim() ? value : undefined;
}

function resolveSpec(spec: string): { entry: RegisteredProvider; model: string } {
  const value = spec.trim();
  if (!value)
    throw new Error(
      t(
        "model spec cannot be empty (should be provider/model)",
        "model spec 不能为空（应为 provider/model）",
      ),
    );
  const slash = value.indexOf("/");
  let prefix: string;
  let model: string;
  if (slash >= 0) {
    prefix = value.slice(0, slash);
    model = value.slice(slash + 1);
    if (!prefix || !model)
      throw new Error(
        t(
          `Invalid model spec ${JSON.stringify(spec)} (should be provider/model)`,
          `非法 model spec ${JSON.stringify(spec)}（应为 provider/model）`,
        ),
      );
  } else {
    // 只剩 DeepSeek 一个云端 provider：裸模型名一律归到 deepseek。
    model = value;
    prefix = "deepseek";
  }
  const entry = providers.get(prefix);
  if (!entry) {
    throw new Error(
      `未知 provider "${prefix}"。可用: ${listProviders().join(", ")}（或用 registerProvider 注册）`,
    );
  }
  return { entry, model };
}

function resolveModelInfo(d: ProviderDescriptor, model: string): ProviderModelInfo {
  const capabilities = { ...d.capabilities };
  const limits = { ...d.limits };
  let cost: ModelCost | undefined;
  for (const profile of d.models) {
    if (!globModel(profile.pattern, model)) continue;
    Object.assign(capabilities, profile.capabilities ?? {});
    Object.assign(limits, profile.limits ?? {});
    if (profile.cost) cost = profile.cost;
  }
  return { providerId: d.id, model, capabilities, limits, ...(cost ? { cost } : {}) };
}

function globModel(pattern: string, model: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const source = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(model);
}
