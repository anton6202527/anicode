/**
 * 本地 Ollama 自启动：选中/默认使用 `ollama/*` 模型时，若守护未在跑就
 * 后台拉起 `ollama serve` 并轮询到就绪，省去用户手动开服务的步骤。
 */
import { spawn } from "node:child_process";

const DEFAULT_BASE = "http://127.0.0.1:11434";

function rootOf(base: string): string {
  return base.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
}

/** 探测 Ollama 是否在跑（GET /api/tags，短超时）。 */
export async function ollamaLive(base = DEFAULT_BASE): Promise<boolean> {
  try {
    const res = await fetch(`${rootOf(base)}/api/tags`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 确保 Ollama 在跑：已在跑返回 "running"；成功拉起返回 "started"；
 * 未安装返回 "missing"；拉起后超时未就绪返回 "timeout"。
 */
export async function ensureOllama(
  base = process.env["OLLAMA_BASE_URL"] || DEFAULT_BASE,
  timeoutMs = 8000,
): Promise<"running" | "started" | "missing" | "timeout"> {
  if (await ollamaLive(base)) return "running";
  try {
    const child = spawn("ollama", ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {}); // 未安装时的 ENOENT 由下方轮询兜底
  } catch {
    return "missing";
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(300);
    if (await ollamaLive(base)) return "started";
  }
  // 轮询期间若 spawn 因 ENOENT 直接失败，端点永远起不来 → 判为未安装/超时。
  return (await ollamaLive(base)) ? "started" : "timeout";
}
