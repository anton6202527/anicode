/**
 * anicode.json 配置体系：把此前散落在 env/命令行里的「默认模型 / 小模型 / MCP /
 * 自定义 agents / 附加规则」收敛到一处，并支持「全局 + 项目」两层合并（项目覆盖全局）。
 *
 * 查找顺序（后者覆盖前者）：
 *   1) <home>/.config/anicode/anicode.json     全局
 *   2) <cwd>/anicode.json                       项目根
 *   3) <cwd>/.anicode/anicode.json              项目内隐藏目录
 *
 * 解析容错：文件缺失跳过；JSON 非法只记 warning，不抛（避免一处手误锁死整个 CLI）。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerConfig } from "./mcp.js";
import type { SubagentDefinition } from "./subagent.js";
import type { LspServerConfig } from "./lsp.js";

/** 配置里的单个 agent 定义（比 SubagentDefinition 更贴近用户书写习惯）。 */
export interface ConfigAgent {
  description: string;
  prompt?: string;
  tools?: string[];
  model?: string;
  maxTurns?: number;
}

export interface AnicodeConfig {
  /** 默认模型 provider/model。 */
  model?: string;
  /** 小模型路由用的模型；true=启用默认小模型，字符串=指定 spec。 */
  smallModel?: string | boolean;
  /** MCP 服务器：name → 启动配置。 */
  mcp?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** 自定义子 agent：name → 定义。 */
  agents?: Record<string, ConfigAgent>;
  /** 语言服务器：name → 配置（命令 + 负责扩展名）。 */
  lsp?: Record<string, LspServerConfig>;
  /** 额外注入 system 的规则文件路径（相对 cwd 或绝对）。 */
  instructions?: string[];
}

export interface LoadedConfig {
  config: AnicodeConfig;
  /** 实际读取到的文件路径（按合并顺序）。 */
  sources: string[];
  /** 解析告警（非法 JSON 等），供 CLI 决定是否提示。 */
  warnings: string[];
}

const KNOWN_KEYS = new Set(["model", "smallModel", "mcp", "agents", "lsp", "instructions"]);

function candidatePaths(cwd: string, home: string): string[] {
  return [
    path.join(home, ".config", "anicode", "anicode.json"),
    path.join(cwd, "anicode.json"),
    path.join(cwd, ".anicode", "anicode.json"),
  ];
}

async function readOne(file: string, warnings: string[]): Promise<AnicodeConfig | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return null; // 缺失即跳过
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      warnings.push(`${file}: 顶层必须是对象，已忽略`);
      return null;
    }
    for (const k of Object.keys(parsed)) {
      if (!KNOWN_KEYS.has(k)) warnings.push(`${file}: 未知配置项 "${k}"，已忽略`);
    }
    return parsed as AnicodeConfig;
  } catch (err) {
    warnings.push(`${file}: JSON 解析失败（${err instanceof Error ? err.message : String(err)}）`);
    return null;
  }
}

/** 浅合并：后者覆盖前者；对象型字段（mcp/agents）做一层深合并；数组字段拼接去重。 */
function merge(base: AnicodeConfig, over: AnicodeConfig): AnicodeConfig {
  return {
    ...base,
    ...over,
    ...(base.mcp || over.mcp ? { mcp: { ...base.mcp, ...over.mcp } } : {}),
    ...(base.agents || over.agents ? { agents: { ...base.agents, ...over.agents } } : {}),
    ...(base.lsp || over.lsp ? { lsp: { ...base.lsp, ...over.lsp } } : {}),
    ...(base.instructions || over.instructions
      ? { instructions: [...new Set([...(base.instructions ?? []), ...(over.instructions ?? [])])] }
      : {}),
  };
}

export async function loadConfig(
  opts: { cwd?: string; home?: string } = {},
): Promise<LoadedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const warnings: string[] = [];
  const sources: string[] = [];
  let config: AnicodeConfig = {};
  for (const file of candidatePaths(cwd, home)) {
    const one = await readOne(file, warnings);
    if (one) {
      config = merge(config, one);
      sources.push(file);
    }
  }
  return { config, sources, warnings };
}

/** 把配置里的 mcp 映射转成 connectMcpServers 需要的数组（注入 name）。 */
export function toMcpServerConfigs(config: AnicodeConfig): McpServerConfig[] {
  if (!config.mcp) return [];
  return Object.entries(config.mcp).map(([name, c]) => ({
    name,
    command: c.command,
    ...(c.args ? { args: c.args } : {}),
    ...(c.env ? { env: c.env } : {}),
  }));
}

/** 把配置里的 lsp 映射转成 LspServerConfig[]（name 只是标识，运行期按扩展名路由）。 */
export function toLspServers(config: AnicodeConfig): LspServerConfig[] {
  if (!config.lsp) return [];
  return Object.values(config.lsp);
}

/** 把配置里的 agents 映射转成 SubagentDefinition[]（prompt→system）。 */
export function toSubagentDefinitions(config: AnicodeConfig): SubagentDefinition[] {
  if (!config.agents) return [];
  return Object.entries(config.agents).map(([name, a]) => ({
    name,
    description: a.description,
    ...(a.prompt ? { system: a.prompt } : {}),
    ...(a.tools ? { tools: a.tools } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
  }));
}
