/**
 * i18n —— 轻量内联双语取词。
 *
 * 设计取舍：不做集中式 key 目录，而是在调用点内联给出 `t(en, zh)` 两段文案。
 * 好处：两种语言就在改动处、便于评审；无中心目录文件，多处并行改动零冲突。
 * 仅覆盖「人机界面文案」（CLI/TUI/桌面/VSCode + 错误/提示）；发给大模型的系统提示词、
 * 工具描述等保持原样（按 locale 切换会动摇已调好的智能体表现）。
 *
 * 语言解析：ANICODE_LANG 显式覆盖 → 否则按系统 LANG/LC_ALL 自动判定 → 默认英文。
 * 在没有 process 的环境（如 VSCode webview 打包产物）里安全降级为默认英文，
 * 宿主可通过 setLang 主动注入 locale。
 */

export type Lang = "en" | "zh";

/** 运行时覆盖（/lang 命令或宿主注入）；为 null 时回落到环境自动判定。 */
let override: Lang | null = null;

/** 语言切换订阅者（UI 据此整屏重渲染，让 t() 就地重取）。 */
const listeners = new Set<() => void>();

/** 订阅语言切换；返回退订函数。 */
export function onLangChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function env(name: string): string {
  try {
    if (typeof process !== "undefined" && process.env) return process.env[name] ?? "";
  } catch {
    /* 无 process 环境：忽略 */
  }
  return "";
}

/** 环境自动判定：ANICODE_LANG 优先，其次系统 locale；无从判定则英文。 */
export function detectLang(): Lang {
  const explicit = env("ANICODE_LANG").trim().toLowerCase();
  if (explicit) return explicit.startsWith("zh") ? "zh" : "en";
  const loc = (env("LC_ALL") || env("LC_MESSAGES") || env("LANG")).toLowerCase();
  return loc.startsWith("zh") ? "zh" : "en";
}

/** 当前生效语言：运行时覆盖优先，否则每次按环境判定（便于测试改 env 即时生效）。 */
export function getLang(): Lang {
  return override ?? detectLang();
}

/** 主动切换语言（/lang 命令、宿主注入 locale），并通知订阅者刷新。 */
export function setLang(lang: Lang): void {
  if (override === lang) return;
  override = lang;
  for (const cb of listeners) cb();
}

/** 清除运行时覆盖，回到环境自动判定（主要供测试复位）。 */
export function clearLangOverride(): void {
  override = null;
}

/** 内联双语取词：当前中文返回 zh，否则返回 en。 */
export function t(en: string, zh: string): string {
  return getLang() === "zh" ? zh : en;
}
