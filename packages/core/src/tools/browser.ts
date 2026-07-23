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
import { Browser, type ConsoleEntry, type NavigateResult } from "../browser/cdp.js";

export interface BrowserToolOptions {
  executablePath?: string;
  headless?: boolean;
  launchTimeoutMs?: number;
  viewport?: { width: number; height: number };
}

const MAX_SHOT_BYTES = 5 * 1024 * 1024; // 截图超 5MB 不附（避免撑爆请求）。
const WAIT_MODES = ["load", "domcontentloaded", "networkidle"] as const;

/** 创建 browser 工具。宿主按 config.browser 决定是否启用及浏览器路径。 */
export function createBrowserTool(opts: BrowserToolOptions = {}): Tool {
  let browser: Browser | null = null;
  let launching: Promise<Browser> | null = null;

  const ensureBrowser = async (): Promise<Browser> => {
    if (browser) return browser;
    if (!launching) {
      // 进程退出时的收尸由 cdp 模块的全局 LIVE 集合统一处理（见 closeAllBrowsers）。
      launching = Browser.launch({
        ...(opts.executablePath ? { executablePath: opts.executablePath } : {}),
        ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
        ...(opts.launchTimeoutMs ? { launchTimeoutMs: opts.launchTimeoutMs } : {}),
      })
        .then((b) => {
          browser = b;
          return b;
        })
        .finally(() => {
          launching = null;
        });
    }
    return launching;
  };

  return {
    readOnly: true,
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
              "URL to open (http/https/file). A bare host or path is treated as http://.",
              "要打开的 URL（http/https/file）。只给主机或路径时按 http:// 处理。",
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
            description: t("Navigation timeout in ms (default 30000).", "导航超时（毫秒，默认 30000）。"),
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["url"] ?? ""),

    fork() {
      return createBrowserTool(opts);
    },

    async run(input, ctx: ToolContext) {
      const url = normalizeUrl(String(input["url"] ?? "").trim());
      if (!url) throw new ToolError(t("url is required", "url 不能为空"));
      const waitUntil = WAIT_MODES.find((m) => m === input["waitUntil"]);
      const timeoutMs = Number(input["timeoutMs"]) || 30_000;

      let b: Browser;
      try {
        b = await ensureBrowser();
      } catch (e: any) {
        throw new ToolError(
          t(
            `Could not start a browser: ${e?.message ?? e}`,
            `无法启动浏览器：${e?.message ?? e}`,
          ),
        );
      }

      const page = await b.newPage();
      try {
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
        page.close();
      }
    },
  };
}

/**
 * 只给主机/路径时补 http://；已带 scheme 的原样返回。
 * 认已知无 `//` 的 scheme（data/file/about/…）与任意 `scheme://`；否则如 `localhost:3000`
 * 视作主机:端口，补 http://。
 */
function normalizeUrl(raw: string): string {
  if (!raw) return "";
  if (/^(https?|file|data|about|chrome|view-source|ws|wss):/i.test(raw)) return raw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  return "http://" + raw;
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
      ? t("✓ Loaded with no console errors or failed requests.", "✓ 加载完成，无 console 错误、无失败请求。")
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
      t(`Script result: ${previewValue(extra.scriptValue)}`, `脚本返回：${previewValue(extra.scriptValue)}`),
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
