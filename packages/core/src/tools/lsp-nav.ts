/**
 * LSP 代码导航工具：definition / references / symbols。
 *
 * 让模型从「grep 猜」升级到「语义跳转」——找一个符号的定义、所有引用、或按名字跨文件
 * 搜符号，靠语言服务器而非正则。定位方式对模型友好：给「行号 + 符号名」即可，工具在该行
 * 文本里找到符号列位置，无需模型自己数字符偏移（read 的输出本就带行号）。
 *
 * 仅在宿主提供 LspPool 时注册（与 diagnostics 一致）；未配语言服务器则这套工具不出现，
 * 不给无 LSP 的会话平添提示词负担。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { type Tool, type ToolContext, ToolError } from "./tool.js";
import { resolveInside } from "./fs.js";
import {
  canonicalLspWorkspaceFile,
  type LspPool,
  type LspClient,
  type LspLocation,
  type LspSymbol,
} from "../lsp.js";
import { t } from "../i18n.js";

/** 单次结果里最多读取多少个位置的上下文行（每个都要读一次文件，设界防炸）。 */
const MAX_LOCATIONS = 50;

interface ResolvedPos {
  abs: string;
  rel: string;
  position: { line: number; character: number };
}

/**
 * 把「path + line + symbol」解析成 LSP 的 0 起 position：在该行文本里定位符号名的列。
 * 也接受显式 character（0 起）兜底。行号 1 起（与 read 输出一致）。
 */
async function resolvePosition(cwd: string, input: Record<string, unknown>): Promise<ResolvedPos> {
  const abs = await resolveInside(cwd, input["path"]);
  const canonical = await canonicalLspWorkspaceFile(cwd, abs).catch((error: unknown) => {
    throw new ToolError(
      `LSP 文件不可访问: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  const rel = path.relative(cwd, canonical) || ".";
  const line = Math.max(1, Math.floor(Number(input["line"] ?? 0)));
  if (!Number.isFinite(line) || line < 1) throw new ToolError("需要 1 起的 line");
  let text: string;
  try {
    text = await fs.readFile(canonical, "utf8");
  } catch (e: any) {
    throw new ToolError(`读取失败: ${e?.code ?? e?.message ?? e}`);
  }
  const lineText = text.split("\n")[line - 1] ?? "";
  let character: number;
  const symbol = input["symbol"] != null ? String(input["symbol"]) : "";
  if (symbol) {
    const idx = lineText.indexOf(symbol);
    if (idx < 0) {
      throw new ToolError(
        t(
          `symbol "${symbol}" not found on line ${line}: ${lineText.trim()}`,
          `第 ${line} 行找不到符号 "${symbol}"：${lineText.trim()}`,
        ),
      );
    }
    character = idx;
  } else if (input["character"] != null) {
    character = Math.max(0, Math.floor(Number(input["character"])));
  } else {
    throw new ToolError(
      t("provide symbol or character", "需要提供 symbol 或 character 其一来定位"),
    );
  }
  return { abs: canonical, rel, position: { line: line - 1, character } };
}

/** 读取每个位置所在行的文本，渲染成 `rel:line:col: <代码行>`。位置数设上限。 */
async function formatLocations(cwd: string, locs: LspLocation[]): Promise<string> {
  const shown = locs.slice(0, MAX_LOCATIONS);
  const lineCache = new Map<string, string[]>();
  const out: string[] = [];
  for (const loc of shown) {
    let canonical: string;
    try {
      canonical = await canonicalLspWorkspaceFile(cwd, loc.path);
    } catch {
      continue;
    }
    const rel = path.relative(cwd, canonical) || canonical;
    let lines = lineCache.get(canonical);
    if (!lines) {
      try {
        lines = (await fs.readFile(canonical, "utf8")).split("\n");
      } catch {
        lines = [];
      }
      lineCache.set(canonical, lines);
    }
    const code = (lines[loc.line - 1] ?? "").trim();
    out.push(`${rel}:${loc.line}:${loc.column}${code ? `: ${code}` : ""}`);
  }
  let body = out.join("\n");
  if (locs.length > shown.length) {
    body += t(
      `\n…(${locs.length - shown.length} more, showing first ${MAX_LOCATIONS})`,
      `\n…（另有 ${locs.length - shown.length} 处，仅显示前 ${MAX_LOCATIONS} 个）`,
    );
  }
  return body;
}

async function formatSymbols(cwd: string, symbols: LspSymbol[]): Promise<string> {
  const shown = symbols.slice(0, MAX_LOCATIONS);
  const out: string[] = [];
  for (const s of shown) {
    let canonical = "";
    if (s.path) {
      try {
        canonical = await canonicalLspWorkspaceFile(cwd, s.path);
      } catch {
        continue;
      }
    }
    const rel = canonical ? path.relative(cwd, canonical) || canonical : "";
    const where = rel ? `${rel}:${s.line}:${s.column}` : `${s.line}:${s.column}`;
    const container = s.container ? ` (${s.container})` : "";
    out.push(`[${s.kind}] ${s.name}${container} — ${where}`);
  }
  let body = out.join("\n");
  if (symbols.length > shown.length) {
    body += t(
      `\n…(${symbols.length - shown.length} more)`,
      `\n…（另有 ${symbols.length - shown.length} 个）`,
    );
  }
  return body;
}

function clientForPath(pool: LspPool, abs: string): LspClient {
  const client = pool.clientFor(path.extname(abs));
  if (!client) {
    throw new ToolError(
      t(
        `no language server configured for ${path.extname(abs) || "this file"}`,
        `没有为 ${path.extname(abs) || "该文件"} 配置语言服务器（在 anicode.json 的 lsp 里添加）。`,
      ),
    );
  }
  return client;
}

const POSITION_PARAMS = {
  path: { type: "string", description: t("File path relative to cwd", "相对 cwd 的文件路径") },
  line: { type: "number", description: t("1-based line number", "行号（1 起）") },
  symbol: {
    type: "string",
    description: t(
      "Symbol name on that line to locate (the tool finds its column)",
      "该行上要定位的符号名（工具据此找到列位置）",
    ),
  },
  character: {
    type: "number",
    description: t("0-based column, alternative to symbol", "列位置（0 起），可替代 symbol"),
  },
};

/** definition：跳到符号定义处。 */
export function createDefinitionTool(pool: LspPool): Tool {
  return {
    capabilities: ["filesystem-read", "process", "persistent-process"],
    readOnly: true,
    isConcurrencySafe: () => true,
    def: {
      name: "definition",
      description: t(
        "Go to the definition of the symbol at a position (file + line + symbol name), via the language server. Returns definition locations with the code line.",
        "经语言服务器跳到某位置（文件 + 行号 + 符号名）符号的定义处，返回定义位置及代码行。",
      ),
      parameters: {
        type: "object",
        properties: POSITION_PARAMS,
        required: ["path", "line"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["path"] ?? "")}:${String(i["line"] ?? "")}`,
    async run(input, ctx: ToolContext) {
      const { abs, rel, position } = await resolvePosition(ctx.cwd, input);
      const client = clientForPath(pool, abs);
      const locs = await client.definition(abs, position);
      if (locs.length === 0)
        return t(
          `(no definition found for the symbol at ${rel}:${position.line + 1})`,
          `(在 ${rel}:${position.line + 1} 未找到该符号的定义)`,
        );
      return formatLocations(ctx.cwd, locs);
    },
  };
}

/** references：找符号的所有引用。 */
export function createReferencesTool(pool: LspPool): Tool {
  return {
    capabilities: ["filesystem-read", "process", "persistent-process"],
    readOnly: true,
    isConcurrencySafe: () => true,
    def: {
      name: "references",
      description: t(
        "Find all references to the symbol at a position (file + line + symbol name), via the language server. Returns locations with the code line — semantic, unlike grep.",
        "经语言服务器查找某位置（文件 + 行号 + 符号名）符号的所有引用，返回位置及代码行——语义级，胜过 grep。",
      ),
      parameters: {
        type: "object",
        properties: POSITION_PARAMS,
        required: ["path", "line"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["path"] ?? "")}:${String(i["line"] ?? "")}`,
    async run(input, ctx: ToolContext) {
      const { abs, rel, position } = await resolvePosition(ctx.cwd, input);
      const client = clientForPath(pool, abs);
      const locs = await client.references(abs, position);
      if (locs.length === 0)
        return t(
          `(no references found for the symbol at ${rel}:${position.line + 1})`,
          `(在 ${rel}:${position.line + 1} 未找到该符号的引用)`,
        );
      return formatLocations(ctx.cwd, locs);
    },
  };
}

/** symbols：query→工作区符号搜索；path→文件大纲。 */
export function createSymbolsTool(pool: LspPool): Tool {
  return {
    capabilities: ["filesystem-read", "process", "persistent-process"],
    readOnly: true,
    isConcurrencySafe: () => true,
    def: {
      name: "symbols",
      description: t(
        "List code symbols via the language server. Give `path` for a file outline, or `query` to search symbols by name across the workspace (find where something is defined).",
        "经语言服务器列出代码符号。给 `path` 看某文件的大纲，或给 `query` 在整个工作区按名字搜符号（定位某个东西定义在哪）。",
      ),
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: t("File path for its outline", "要看大纲的文件路径"),
          },
          query: {
            type: "string",
            description: t("Symbol name to search workspace-wide", "在工作区搜索的符号名"),
          },
        },
        additionalProperties: false,
      },
    },
    ruleKey: (i) => (i["query"] ? `query:${String(i["query"])}` : String(i["path"] ?? "")),
    async run(input, ctx: ToolContext) {
      if (input["path"]) {
        const requested = await resolveInside(ctx.cwd, input["path"]);
        const abs = await canonicalLspWorkspaceFile(ctx.cwd, requested).catch((error: unknown) => {
          throw new ToolError(
            `LSP 文件不可访问: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
        const client = clientForPath(pool, abs);
        const syms = await client.documentSymbols(abs);
        if (syms.length === 0)
          return t(
            `(no symbols in ${path.relative(ctx.cwd, abs) || "."})`,
            `(${path.relative(ctx.cwd, abs) || "."} 无符号)`,
          );
        return await formatSymbols(ctx.cwd, syms);
      }
      const query = String(input["query"] ?? "").trim();
      if (!query) throw new ToolError(t("provide path or query", "需要提供 path 或 query 其一"));
      // 工作区符号跨语言：对每个已配置服务器各查一次并合并。
      const clients = pool.ensureAllStarted();
      if (clients.length === 0)
        return t("(no language server configured)", "(未配置任何语言服务器)");
      const merged: LspSymbol[] = [];
      const seen = new Set<string>();
      for (const client of clients) {
        let syms: LspSymbol[] = [];
        try {
          syms = await client.workspaceSymbols(query);
        } catch {
          /* 单个服务器失败不影响其它 */
        }
        for (const s of syms) {
          const key = `${s.path}:${s.line}:${s.column}:${s.name}`;
          if (!seen.has(key)) {
            seen.add(key);
            merged.push(s);
          }
        }
      }
      if (merged.length === 0)
        return t(`(no symbols matching "${query}")`, `(没有匹配 "${query}" 的符号)`);
      return await formatSymbols(ctx.cwd, merged);
    },
  };
}

/** 一次性创建全部 LSP 导航工具。 */
export function createLspNavTools(pool: LspPool): Tool[] {
  return [createDefinitionTool(pool), createReferencesTool(pool), createSymbolsTool(pool)];
}
