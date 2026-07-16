/**
 * diagnostics 工具：通过 LSP 池取某文件的语言服务器诊断，喂给 agent 自查改动。
 */
import * as path from "node:path";
import { type Tool, type ToolContext } from "./tool.js";
import { type LspPool } from "../lsp.js";
import { t } from "../i18n.js";

export function createDiagnosticsTool(pool: LspPool): Tool {
  return {
    readOnly: true,
    def: {
      name: "diagnostics",
      description: t(
        "Get language server diagnostics for a file (type/syntax errors and warnings). Useful for self-checking after editing code.",
        "获取某文件的语言服务器诊断（类型/语法错误与告警）。改完代码后自查很有用。",
      ),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: t("File path relative to cwd", "相对 cwd 的文件路径"),
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["path"] ?? ""),
    async run(input, ctx: ToolContext) {
      const rel = String(input["path"] ?? "");
      const abs = path.resolve(ctx.cwd, rel);
      const ext = path.extname(abs);
      const client = pool.clientFor(ext);
      if (!client) {
        return `没有为 ${ext || "该文件"} 配置语言服务器（在 anicode.json 的 lsp 里添加）。`;
      }
      const diags = await client.diagnose(abs);
      if (diags.length === 0) return `${rel}: 无诊断（干净）。`;
      return diags
        .map(
          (d) =>
            `${rel}:${d.line}:${d.column} [${d.severity}] ${d.message}${d.source ? ` (${d.source})` : ""}`,
        )
        .join("\n");
    },
  };
}
