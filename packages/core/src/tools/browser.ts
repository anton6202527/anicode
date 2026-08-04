/**
 * browser 工具 —— 写完前端后「自动开页验证」。默认只读（权限引擎自动放行，无需逐次授权），
 * 是本仓对齐 Codex 内置浏览器能力的一环：给个 URL（多为本机 dev server），headless 打开、
 * 等加载、采集 console 错误 / 未捕获异常 / 失败请求 / 标题，并回传一张截图给支持视觉的模型。
 *
 * 零依赖：驱动本机已装的 Chrome/Chromium/Edge（见 ../browser/cdp）。浏览器进程懒启动、跨调用
 * 复用（提速），进程退出时清理。fork 出的子 agent 实例各自持有独立浏览器，互不干扰。
 */
import { type Tool, type ToolContext, ToolError } from "./tool.js";
import { t } from "../i18n.js";
import {
  Browser,
  BrowserRegistry,
  type ConsoleEntry,
  type NavigateResult,
} from "../browser/cdp.js";

export interface BrowserToolOptions {
  executablePath?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
  commandTimeoutMs?: number;
  viewport?: { width: number; height: number };
  /** Chrome 的唯一 HTTP(S) 出口；生产宿主同时启用 requireProxy。 */
  proxyUrl?: string;
  requireProxy?: boolean;
  /** Production hosts require a root/system-owned, non-writable browser executable. */
  requireTrustedExecutable?: boolean;
  /** Host ownership scope; disposing it does not affect another manager's browsers. */
  registry?: BrowserRegistry;
}

const MAX_SHOT_BYTES = 5 * 1024 * 1024; // 截图超 5MB 不附（避免撑爆请求）。
const WAIT_MODES = ["load", "domcontentloaded", "networkidle"] as const;

/** 创建 browser 工具。宿主按 config.browser 决定是否启用及浏览器路径。 */
export function createBrowserTool(opts: BrowserToolOptions = {}): Tool {
  const registry = opts.registry ?? new BrowserRegistry();
  return createOwnedBrowserTool({ ...opts, registry }, registry, opts.registry === undefined);
}

function createOwnedBrowserTool(
  opts: BrowserToolOptions & { registry: BrowserRegistry },
  registry: BrowserRegistry,
  ownsRegistry: boolean,
): Tool {
  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const ensureBrowser = async (): Promise<Browser> => {
    if (closed) throw new Error("Browser tool is closed");
    if (browser) return browser;
    if (!launching) {
      if (opts.requireProxy && !opts.proxyUrl) {
        throw new Error("Browser network access requires the configured AniCode proxy");
      }
      const proxy = opts.proxyUrl ? new URL(opts.proxyUrl) : undefined;
      // 进程退出时的收尸由 cdp 模块的全局 LIVE 集合统一处理（见 closeAllBrowsers）。
      launching = registry
        .launch({
          ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
          ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
          ...(opts.launchTimeoutMs ? { launchTimeoutMs: opts.launchTimeoutMs } : {}),
          ...(opts.commandTimeoutMs ? { commandTimeoutMs: opts.commandTimeoutMs } : {}),
          ...(opts.requireTrustedExecutable ? { requireTrustedExecutable: true } : {}),
          ...(proxy
            ? {
                args: [
                  `--proxy-server=${proxy.toString()}`,
                  // Chrome 默认绕过 loopback；显式撤销，localhost 同样必须过策略出口。
                  "--proxy-bypass-list=<-loopback>",
                  `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${proxy.hostname}`,
                  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
                ],
              }
            : {}),
        })
        .then(async (b) => {
          if (closed) {
            await b.close();
            throw new Error("Browser tool is closed");
          }
          browser = b;
          return b;
        })
        .finally(() => {
          launching = null;
        });
    }
    return launching;
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closed = true;
    closePromise = (async () => {
      await launching?.catch(() => undefined);
      if (ownsRegistry) await registry.closeAll();
      else await browser?.close();
      browser = null;
    })();
    return closePromise;
  };

  return {
    readOnly: true,
    capabilities: ["network", "process", "persistent-process"],
    isConcurrencySafe: () => false, // 单浏览器进程有内部状态，串行更稳。
    def: {
      name: "browser",
      description: t(
        "Open a URL in a real headless browser and verify the page: waits for load, then reports console errors, uncaught exceptions and failed requests, the page title, and attaches a screenshot. Use it to check a frontend you just wrote actually renders and runs (e.g. a local dev server like http://localhost:3000).",
        "用真实的 headless 浏览器打开一个 URL 并验证页面：等待加载后，报告 console 错误、未捕获异常、失败请求与页面标题，并附一张截图。用于验证你刚写的前端能否真正渲染与运行（例如本机 dev server http://localhost:3000）。",
      ),
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: t(
              "HTTP(S) URL to open. A bare host is treated as http://. Local file/data/browser URLs are rejected.",
              "要打开的 HTTP(S) URL。只给主机时按 http:// 处理；拒绝本地文件、data 与浏览器内部 URL。",
            ),
          },
          waitUntil: {
            type: "string",
            enum: ["load", "domcontentloaded", "networkidle"],
            description: t(
              "When to consider navigation done (default load).",
              "何时视为导航完成（默认 load）。",
            ),
          },
          selector: {
            type: "string",
            description: t(
              "Optional CSS selector to wait for after load (verifies a key element rendered).",
              "可选：加载后等待某个 CSS 选择器出现（验证关键元素已渲染）。",
            ),
          },
          script: {
            type: "string",
            description: t(
              "Optional JS expression to evaluate in the page; its return value is included in the report.",
              "可选：在页面里执行的 JS 表达式；返回值会写进报告。",
            ),
          },
          fullPage: {
            type: "boolean",
            description: t("Capture the full page instead of the viewport.", "截整页而非仅视口。"),
          },
          timeoutMs: {
            type: "number",
            description: t(
              "Navigation timeout in ms (default 30000).",
              "导航超时（毫秒，默认 30000）。",
            ),
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["url"] ?? ""),

    fork() {
      // Forked agents get their own browser process, but remain inside the same ownership scope.
      return createOwnedBrowserTool(opts, registry, false);
    },

    close,

    async run(input, ctx: ToolContext) {
      const url = normalizeUrl(String(input["url"] ?? "").trim());
      if (!url) {
        throw new ToolError(
          t(
            "browser requires an HTTP(S) URL; local file and browser-internal schemes are blocked",
            "browser 只允许 HTTP(S) URL；已阻止本地文件和浏览器内部协议",
          ),
        );
      }
      const waitUntil = WAIT_MODES.find((m) => m === input["waitUntil"]);
      const requestedTimeout = Number(input["timeoutMs"]);
      const timeoutMs = Number.isFinite(requestedTimeout)
        ? Math.max(1_000, Math.min(5 * 60_000, Math.floor(requestedTimeout)))
        : 30_000;

      let b: Browser;
      try {
        b = await ensureBrowser();
      } catch (e: any) {
        throw new ToolError(
          t(`Could not start a browser: ${e?.message ?? e}`, `无法启动浏览器：${e?.message ?? e}`),
        );
      }

      const page = await b.newPage();
      const onAbort = () => page.close();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (ctx.signal.aborted) throw ctx.signal.reason ?? new ToolError("browser 已中断");
        const vp = opts.viewport;
        if (vp) await page.setViewport(vp.width, vp.height).catch(() => {});
        const result = await page.navigate(url, {
          ...(waitUntil ? { waitUntil } : {}),
          timeoutMs,
        });

        let selectorFound: boolean | undefined;
        const selector = String(input["selector"] ?? "").trim();
        if (selector) {
          selectorFound = await page.waitForSelector(selector, Math.min(timeoutMs, 10_000));
        }

        let scriptValue: unknown;
        let scriptError: string | undefined;
        const script = String(input["script"] ?? "").trim();
        if (script) {
          try {
            scriptValue = await page.evaluate(script);
          } catch (e: any) {
            scriptError = String(e?.message ?? e);
          }
        }

        // 截图（模型支持视觉时才采集并附上）。
        let shotNote = "";
        if (ctx.modelSupportsImages && ctx.attachImage) {
          try {
            const data = await page.screenshot({ fullPage: !!input["fullPage"] });
            const bytes = Math.ceil((data.length * 3) / 4);
            if (data && bytes <= MAX_SHOT_BYTES) {
              ctx.attachImage({ type: "image", mediaType: "image/png", data });
              shotNote = t(
                `\nScreenshot attached (PNG, ~${Math.round(bytes / 1024)} KB).`,
                `\n已附截图（PNG，约 ${Math.round(bytes / 1024)} KB）。`,
              );
            } else if (data) {
              shotNote = t(
                `\n(Screenshot ~${Math.round(bytes / 1024)} KB exceeds the attach limit; not attached.)`,
                `\n（截图约 ${Math.round(bytes / 1024)} KB 超过附图上限，未附上。）`,
              );
            }
          } catch {
            /* 截图失败不致命 */
          }
        }

        return (
          formatReport(url, result, {
            ...(selector ? { selector } : {}),
            ...(selectorFound !== undefined ? { selectorFound } : {}),
            ...(scriptValue !== undefined ? { scriptValue } : {}),
            ...(scriptError !== undefined ? { scriptError } : {}),
          }) + shotNote
        );
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        page.close();
      }
    },
  };
}

/**
 * 只给主机时补 http://；最终仅允许 HTTP(S)。禁止 file/data/about/chrome 等协议，避免
 * 把自动放行的只读浏览器变成读取宿主本地文件的旁路。
 */
function normalizeUrl(raw: string): string {
  if (!raw) return "";
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

const ERROR_LEVELS = new Set(["error", "exception"]);
const WARN_LEVELS = new Set(["warning", "warn"]);

/** 采集结果 → 模型友好的验证报告（双语）。 */
export function formatReport(
  url: string,
  r: NavigateResult,
  extra: {
    selector?: string;
    selectorFound?: boolean;
    scriptValue?: unknown;
    scriptError?: string;
  } = {},
): string {
  const errors = r.console.filter((c) => ERROR_LEVELS.has(c.level));
  const warnings = r.console.filter((c) => WARN_LEVELS.has(c.level));
  const lines: string[] = [];

  lines.push(
    t(`Opened ${url}`, `已打开 ${url}`) +
      (r.title ? ` — "${r.title}"` : "") +
      (r.finalUrl && r.finalUrl !== url
        ? t(` (redirected to ${r.finalUrl})`, `（重定向到 ${r.finalUrl}）`)
        : ""),
  );

  const ok = errors.length === 0 && r.failedRequests.length === 0;
  lines.push(
    ok
      ? t(
          "✓ Loaded with no console errors or failed requests.",
          "✓ 加载完成，无 console 错误、无失败请求。",
        )
      : t(
          `✗ ${errors.length} console error(s), ${r.failedRequests.length} failed request(s).`,
          `✗ ${errors.length} 个 console 错误，${r.failedRequests.length} 个失败请求。`,
        ),
  );

  if (errors.length) {
    lines.push(t("Console errors:", "Console 错误："));
    for (const e of errors.slice(0, 20)) lines.push("  ✖ " + fmtEntry(e));
  }
  if (warnings.length) {
    lines.push(t(`Console warnings (${warnings.length}):`, `Console 警告（${warnings.length}）：`));
    for (const w of warnings.slice(0, 10)) lines.push("  ⚠ " + fmtEntry(w));
  }
  if (r.failedRequests.length) {
    lines.push(t("Failed requests:", "失败请求："));
    for (const f of r.failedRequests.slice(0, 20)) lines.push(`  ✖ ${f.error} ${f.url}`);
  }
  if (extra.selector) {
    lines.push(
      extra.selectorFound
        ? t(`✓ Selector "${extra.selector}" found.`, `✓ 找到选择器 "${extra.selector}"。`)
        : t(
            `✗ Selector "${extra.selector}" not found within timeout.`,
            `✗ 超时仍未找到选择器 "${extra.selector}"。`,
          ),
    );
  }
  if (extra.scriptError) {
    lines.push(t(`Script error: ${extra.scriptError}`, `脚本报错：${extra.scriptError}`));
  } else if (extra.scriptValue !== undefined) {
    lines.push(
      t(
        `Script result: ${previewValue(extra.scriptValue)}`,
        `脚本返回：${previewValue(extra.scriptValue)}`,
      ),
    );
  }
  return lines.join("\n");
}

function fmtEntry(e: ConsoleEntry): string {
  return e.text + (e.location ? `  (${e.location})` : "");
}

function previewValue(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > 500 ? s.slice(0, 500) + "…" : String(s);
}
