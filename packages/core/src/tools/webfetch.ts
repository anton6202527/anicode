/**
 * webfetch 工具：抓取一个 URL 并返回可读文本（HTML 转纯文本）。对齐 opencode 的 webfetch，
 * 让 agent 能查在线文档/网页。默认只读、可被权限引擎按域名裁决。
 */
import { type Tool, type ToolContext, ToolError } from "./tool.js";
import { t } from "../i18n.js";

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** 极简 HTML→文本：去脚本/样式、去标签、解实体、压缩空白。够 agent 阅读用。 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export const webFetchTool: Tool = {
  readOnly: true,
  def: {
    name: "webfetch",
    description: t(
      "Fetch an http(s) URL and return its text content (HTML is converted to readable plain text). Use for looking up online docs and reading web pages.",
      "抓取一个 http(s) URL 并返回其文本内容（HTML 会转成可读纯文本）。用于查在线文档、读网页。",
    ),
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: t("http or https URL", "http 或 https URL") },
        maxChars: {
          type: "number",
          description: t(
            "Maximum number of characters of text to return (default 20000)",
            "返回文本上限字符数（默认 20000）",
          ),
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => {
    try {
      return new URL(String(i["url"] ?? "")).host;
    } catch {
      return String(i["url"] ?? "");
    }
  },
  async run(input, ctx: ToolContext) {
    const url = String(input["url"] ?? "");
    if (!/^https?:\/\//i.test(url)) throw new ToolError("仅支持 http(s) URL");
    const maxChars = Math.max(1000, Number(input["maxChars"] ?? 20000));
    let res: Response;
    try {
      res = await fetch(url, {
        signal: ctx.signal,
        redirect: "follow",
        headers: { "user-agent": "anicode/0.1 (+https://github.com/anton6202527/anicode)" },
      });
    } catch (e: any) {
      throw new ToolError(`请求失败: ${e?.message ?? e}`);
    }
    if (!res.ok) throw new ToolError(`HTTP ${res.status} ${res.statusText}`);
    const ct = res.headers.get("content-type") ?? "";
    const body = await res.text();
    const text = /html/i.test(ct) ? htmlToText(body) : body;
    const clipped = text.length > maxChars;
    return (clipped ? text.slice(0, maxChars) + "\n…（内容已截断）" : text) || "(空响应)";
  },
};
