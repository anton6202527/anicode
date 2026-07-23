/**
 * 数据驱动的 Provider 注册表。
 *
 * `provider/model` 的 provider 部分只负责选择传输协议和安全的运行时配置；
 * model id 的其余斜杠会完整保留（例如 openrouter/anthropic/claude-sonnet-4）。
 * 凭证只通过 descriptor 声明的环境变量读取，绝不会回退到其他 provider 的 key。
 */

import { t } from "../i18n.js";
import type { Provider } from "../types.js";
import { AuthStore } from "../auth/store.js";
import { DebugProvider } from "./debug.js";
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

type Factory = () => Provider;

interface RegisteredProvider {
  descriptor: ProviderDescriptor;
  factory: Factory;
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
  defaultHeaders?: Record<string, string>;
  streamUsage?: boolean;
  maxTokensField?: MaxTokensField;
  reasoningEffort?: boolean;
}

const providers = new Map<string, RegisteredProvider>();
const canonical = new Map<string, RegisteredProvider>();

/** 进程内共享的凭证存储（OAuth 等）；路径可由 ANICODE_AUTH_FILE 覆盖。 */
let sharedAuthStore: AuthStore | null = null;
export function defaultAuthStore(): AuthStore {
  if (!sharedAuthStore) sharedAuthStore = new AuthStore();
  return sharedAuthStore;
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

  install({
    descriptor: d,
    directCredential: Boolean(input.apiKey),
    factory: () => {
      const runtime = runtimeConfig(d, input.apiKey);
      return new OpenAICompatProvider({
        name: d.id,
        ...(runtime.baseURL ? { baseURL: runtime.baseURL } : {}),
        // 始终显式传入（包括空串），禁止 SDK 回退到 OPENAI_API_KEY。
        apiKey: runtime.apiKey,
        maxRetries: 0,
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
};

/** 未显式指定模型时，按凭证就绪状态挑选云端默认模型。 */
const DEFAULT_MODEL_PREFERENCES = ["deepseek/deepseek-v4-flash"] as const;

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

export function createProvider(spec: string): CreatedModel {
  const parsed = resolveSpec(spec);
  const descriptorCopy = cloneDescriptor(parsed.entry.descriptor);
  return {
    provider: parsed.entry.factory(),
    model: parsed.model,
    providerId: parsed.entry.descriptor.id,
    descriptor: descriptorCopy,
    modelInfo: resolveModelInfo(parsed.entry.descriptor, parsed.model),
    diagnostics: diagnosticsFor(parsed.entry, parsed.model),
  };
}

/** 启动前诊断，无网络请求，也不会实例化 SDK client。 */
export function diagnoseProvider(spec: string): ProviderDiagnostics {
  const parsed = resolveSpec(spec);
  return diagnosticsFor(parsed.entry, parsed.model);
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
): { baseURL?: string; apiKey: string } {
  const envBase = d.baseURLEnv ? nonEmptyEnv(d.baseURLEnv) : undefined;
  const credential = directApiKey ?? findCredential(d.apiKeyEnv)?.value;
  return {
    ...((envBase ?? d.baseURL) ? { baseURL: envBase ?? d.baseURL } : {}),
    // 本地匿名服务仍给 SDK 一个无敏感性的占位 key；云端缺 key 用空串尽早失败。
    apiKey: credential ?? (d.requiresApiKey ? "" : "anicode-local"),
  };
}

function diagnosticsFor(entry: RegisteredProvider, model: string): ProviderDiagnostics {
  const d = entry.descriptor;
  const envBase = d.baseURLEnv ? nonEmptyEnv(d.baseURLEnv) : undefined;
  const credential = findCredential(d.apiKeyEnv);
  const baseURL = envBase ?? d.baseURL;
  const warnings: string[] = [];
  // OAuth 订阅登录也算有凭证（无需 API key）。
  const hasOAuth = defaultAuthStore().getSync(d.id)?.type === "oauth";
  const hasCredentials = Boolean(credential) || Boolean(entry.directCredential) || hasOAuth;
  if (d.requiresApiKey && !hasCredentials) {
    warnings.push(
      t(
        `Missing credentials: set ${d.apiKeyEnv.join(" or ") || "the provider's API key"}, or run auth login to sign in with a subscription`,
        `缺少凭证：请设置 ${d.apiKeyEnv.join(" 或 ") || "provider 对应的 API key"}，或运行 auth login 用订阅登录`,
      ),
    );
  }
  if (!baseURL && d.kind !== "debug")
    warnings.push(t("provider baseURL is not configured", "未配置 provider baseURL"));
  return {
    providerId: d.id,
    model,
    name: d.name,
    kind: d.kind,
    ...(baseURL ? { baseURL } : {}),
    baseURLSource: envBase ? "environment" : d.baseURL ? "default" : "none",
    apiKeyEnv: [...d.apiKeyEnv],
    ...(credential ? { credentialEnv: credential.name } : {}),
    hasCredentials,
    requiresApiKey: d.requiresApiKey,
    local: d.local,
    warnings,
  };
}

function findCredential(names: readonly string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = nonEmptyEnv(name);
    if (value !== undefined) return { name, value };
  }
  return undefined;
}

function nonEmptyEnv(name: string): string | undefined {
  const value = process.env[name];
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
