/**
 * 本地 provider 存活探测。
 *
 * 本地 OpenAI 兼容服务（Ollama / LM Studio / vLLM / llama.cpp 等）「无需 API key」不等于
 * 「可用」——服务没启动、模型没拉,照样连不上。选择器只看凭证会把这些模型误标为就绪,
 * 用户选中后得到 Connection error。这里对本地端点做一次轻量 `/models` 探测,拿到真实可用性。
 */

import type { ProviderDescriptor } from "./registry.js";
import { localProviderModelsURL } from "./local-endpoint.js";

/** 探测一个 OpenAI 兼容 baseURL 是否在跑；连不上/超时返回 false。 */
export async function probeEndpoint(
  baseURL: string,
  timeoutMs = 600,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const modelsURL = localProviderModelsURL(baseURL);
  if (!modelsURL) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(modelsURL, {
        signal: controller.signal,
        // A loopback endpoint must not turn model discovery into an arbitrary redirect fetch.
        redirect: "error",
      });
      // 有任何 HTTP 响应就说明服务在跑（401/404 也算在跑,只是鉴权/路径问题）。
      return res.status > 0;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false; // 连接被拒 / 超时 / DNS 等 → 未运行
  }
}

/** 并发探测所有本地 provider,返回「确实在跑」的 provider id 集合。 */
export async function probeLocalProviders(
  descriptors: readonly ProviderDescriptor[],
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Set<string>> {
  const locals = descriptors.filter((d) => d.local && (d.baseURL || d.baseURLEnv));
  const results = await Promise.all(
    locals.map(async (d) => {
      const base = (d.baseURLEnv && env[d.baseURLEnv]) || d.baseURL;
      if (!base) return [d.id, false] as const;
      return [d.id, await probeEndpoint(base, 600, fetchImpl)] as const;
    }),
  );
  return new Set(results.filter(([, ok]) => ok).map(([id]) => id));
}
