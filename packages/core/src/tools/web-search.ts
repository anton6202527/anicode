/**
 * web_search —— 让 agent 能「发现」URL，而不只是抓已知 URL（webfetch）。这是对齐
 * Codex / Claude Code 的关键一步：没有搜索，模型面对"最新的 X 怎么做"只能瞎猜或空手。
 *
 * 设计成**可插拔**：core 不绑定任何一家搜索服务，只定义 `WebSearchBackend` 契约，
 * 并附带两个开箱即用的后端（Tavily / Brave，都对 agent 友好、有免费额度）。宿主可传
 * 自己的后端（企业内搜索、缓存层、mock）。响应解析抽成纯函数，离线可测；网络 fetch 可注入。
 */
import { type Tool, type ToolContext, ToolError } from "./tool.js";
import { t } from "../i18n.js";
import type { CredentialBroker } from "../security/credentials.js";
import type { NetworkProxy } from "../runtime/network-proxy.js";

export interface WebSearchResult {
  title: string;
  url: string;
  /** 结果摘要/正文片段（各后端字段名不同，统一到 snippet）。 */
  snippet?: string;
}

export interface WebSearchQuery {
  signal: AbortSignal;
  /** 期望结果条数（后端尽力而为）。 */
  count?: number;
}

/** 一次搜索后端调用：给查询词，返回结果列表。抛异常 = 搜索失败（上层包成工具错误）。 */
export type WebSearchBackend = (query: string, opts: WebSearchQuery) => Promise<WebSearchResult[]>;

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const MAX_SNIPPET = 500;

/** 把结果渲染成模型友好的文本：编号 + 标题 + URL + 摘要，并提示可用 webfetch 深读。 */
export function formatSearchResults(query: string, results: WebSearchResult[]): string {
  if (results.length === 0) {
    return t(`(web_search: no results for "${query}")`, `(web_search：未找到"${query}"的结果)`);
  }
  const body = results
    .map((r, i) => {
      const snippet = r.snippet ? `\n   ${clip(r.snippet, MAX_SNIPPET)}` : "";
      return `${i + 1}. ${r.title || r.url}\n   ${r.url}${snippet}`;
    })
    .join("\n\n");
  return `${body}\n\n${t(
    "(Use webfetch on a URL above to read the full page.)",
    "（用 webfetch 打开上面某个 URL 可读全文。）",
  )}`;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? one.slice(0, max) + "…" : one;
}

/** 用一个后端创建 web_search 工具。宿主决定用哪个后端（或不启用）。 */
export function createWebSearchTool(backend: WebSearchBackend): Tool {
  return {
    readOnly: true,
    isConcurrencySafe: () => true,
    def: {
      name: "web_search",
      description: t(
        "Search the web and return a ranked list of results (title, URL, snippet). Use it to discover current information and find URLs you don't already know; then read a result in full with webfetch.",
        "在网络上搜索，返回排序后的结果列表（标题、URL、摘要）。用于发现最新信息、找到你还不知道的 URL；随后可用 webfetch 读某条结果的全文。",
      ),
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: t("Search query", "搜索查询词") },
          count: {
            type: "number",
            description: t(
              `Number of results to return (default ${DEFAULT_COUNT}, max ${MAX_COUNT})`,
              `返回结果条数（默认 ${DEFAULT_COUNT}，最多 ${MAX_COUNT}）`,
            ),
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["query"] ?? ""),
    async run(input, ctx: ToolContext) {
      const query = String(input["query"] ?? "").trim();
      if (!query) throw new ToolError("query 不能为空");
      const count = clampCount(input["count"]);
      let results: WebSearchResult[];
      try {
        results = await backend(query, { signal: ctx.signal, count });
      } catch (e: any) {
        throw new ToolError(
          t(`web_search failed: ${e?.message ?? e}`, `web_search 失败: ${e?.message ?? e}`),
        );
      }
      return formatSearchResults(query, results.slice(0, count));
    },
  };
}

function clampCount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_COUNT;
  return Math.max(1, Math.min(MAX_COUNT, Math.floor(n)));
}

// ---------- 内置后端：Tavily ----------

/** Tavily（专为 agent 设计的搜索 API）响应 → 统一结果。纯函数，离线可测。 */
export function parseTavilyResponse(json: unknown): WebSearchResult[] {
  const results = (json as { results?: unknown })?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o["title"] ?? ""),
        url: String(o["url"] ?? ""),
        ...(o["content"] ? { snippet: String(o["content"]) } : {}),
      };
    })
    .filter((r) => r.url);
}

export function tavilyBackend(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}): WebSearchBackend {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? "https://api.tavily.com/search";
  return async (query, { signal, count }) => {
    const res = await doFetch(endpoint, {
      method: "POST",
      signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: opts.apiKey,
        query,
        max_results: count ?? DEFAULT_COUNT,
        search_depth: "basic",
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return parseTavilyResponse(await res.json());
  };
}

// ---------- 内置后端：Brave ----------

/** Brave Search API 响应 → 统一结果。纯函数，离线可测。 */
export function parseBraveResponse(json: unknown): WebSearchResult[] {
  const results = (json as { web?: { results?: unknown } })?.web?.results;
  if (!Array.isArray(results)) return [];
  return results
    .map((r) => {
      const o = r as Record<string, unknown>;
      return {
        title: String(o["title"] ?? ""),
        url: String(o["url"] ?? ""),
        ...(o["description"] ? { snippet: String(o["description"]) } : {}),
      };
    })
    .filter((r) => r.url);
}

export function braveBackend(opts: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}): WebSearchBackend {
  const doFetch = opts.fetchImpl ?? fetch;
  const endpoint = opts.endpoint ?? "https://api.search.brave.com/res/v1/web/search";
  return async (query, { signal, count }) => {
    const url = `${endpoint}?q=${encodeURIComponent(query)}&count=${count ?? DEFAULT_COUNT}`;
    const res = await doFetch(url, {
      signal,
      headers: {
        accept: "application/json",
        "x-subscription-token": opts.apiKey,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return parseBraveResponse(await res.json());
  };
}

export interface BrokerWebSearchOptions {
  provider: "tavily" | "brave";
  broker: CredentialBroker;
  proxy: NetworkProxy;
  credentialId?: string;
  endpoint?: string;
}

/** 搜索密钥只由代理按 host/audience 注入；不会进入工具输入、请求 body 或进程 env。 */
export function webSearchBackendFromBroker(opts: BrokerWebSearchOptions): WebSearchBackend {
  const endpoint =
    opts.endpoint ??
    (opts.provider === "tavily"
      ? "https://api.tavily.com/search"
      : "https://api.search.brave.com/res/v1/web/search");
  const target = new URL(endpoint);
  const credentialId =
    opts.credentialId ??
    (opts.provider === "tavily" ? "env:TAVILY_API_KEY" : "env:BRAVE_SEARCH_API_KEY");
  return async (query, { signal, count }) => {
    const lease = opts.broker.lease({
      credentialId,
      audience: "network:web-search",
      host: target.hostname,
      tool: "web_search",
      ttlMs: 30_000,
      maxUses: 1,
    });
    const url =
      opts.provider === "brave"
        ? `${endpoint}?q=${encodeURIComponent(query)}&count=${count ?? DEFAULT_COUNT}`
        : endpoint;
    const response = await opts.proxy.fetch(url, {
      method: opts.provider === "tavily" ? "POST" : "GET",
      signal,
      headers: { accept: "application/json", "content-type": "application/json" },
      credentialLease: lease,
      ...(opts.provider === "tavily"
        ? {
            body: JSON.stringify({
              query,
              max_results: count ?? DEFAULT_COUNT,
              search_depth: "basic",
            }),
          }
        : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    const payload = await response.json();
    return opts.provider === "tavily" ? parseTavilyResponse(payload) : parseBraveResponse(payload);
  };
}

// ---------- 环境变量解析 ----------

/**
 * 按环境变量挑一个可用后端：TAVILY_API_KEY 优先，其次 BRAVE_SEARCH_API_KEY。
 * 都没有则返回 undefined —— 宿主据此决定不注册 web_search（而不是给个坏工具）。
 */
export function webSearchBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WebSearchBackend | undefined {
  if (
    (env["TAVILY_API_KEY"] || env["BRAVE_SEARCH_API_KEY"]) &&
    env["ANICODE_ALLOW_LEGACY_SECRET_ENV"] !== "1"
  ) {
    throw new Error(
      "Environment-backed web search secrets are disabled; use webSearchBackendFromBroker()",
    );
  }
  if (env["TAVILY_API_KEY"]) return tavilyBackend({ apiKey: env["TAVILY_API_KEY"] });
  if (env["BRAVE_SEARCH_API_KEY"]) return braveBackend({ apiKey: env["BRAVE_SEARCH_API_KEY"] });
  return undefined;
}
