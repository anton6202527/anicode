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
import { t } from "./i18n.js";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerConfig } from "./mcp.js";
import type { SubagentDefinition } from "./subagent.js";
import type { LspServerConfig } from "./lsp.js";
import type { BrowserToolOptions } from "./tools/browser.js";
import type { PermissionProfile } from "./permission.js";

/** 配置里的单个 agent 定义（比 SubagentDefinition 更贴近用户书写习惯）。 */
export interface ConfigAgent {
  description: string;
  prompt?: string;
  tools?: string[];
  /** 禁用工具（支持 * glob）；在 tools/继承集确定后剔除。 */
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  /** 编排型：保留 task 工具以便再往下派子 agent（受 MAX_SUBAGENT_DEPTH 深度上限约束）。 */
  orchestrator?: boolean;
}

export interface AnicodeConfig {
  /** 默认模型 provider/model。 */
  model?: string;
  /** 小模型路由用的模型；true=启用默认小模型，字符串=指定 spec。 */
  smallModel?: string | boolean;
  /** 模型降级链：主模型重试仍失败时按序切换的 spec 列表。 */
  fallbackModels?: string[];
  /**
   * MCP 服务器：name → 启动配置。两种形态：
   *   - 本地进程（stdio）：{ command, args?, env? }
   *   - 远程（Streamable HTTP）：{ url, headers? }
   */
  mcp?: Record<
    string,
    | { command: string; args?: string[]; env?: Record<string, string>; timeoutMs?: number }
    | { url: string; headers?: Record<string, string>; timeoutMs?: number }
  >;
  /** 自定义子 agent：name → 定义。 */
  agents?: Record<string, ConfigAgent>;
  /** 语言服务器：name → 配置（命令 + 负责扩展名）。 */
  lsp?: Record<string, LspServerConfig>;
  /**
   * 内置 browser 工具（headless 前端验证：开页、抓 console 错误/异常/失败请求、截图）。
   * 默认启用——只注册工具，Chrome 懒启动，首次调用才拉起。false 或 { enabled: false } 关闭；
   * 可指定浏览器二进制路径与默认视口。
   */
  browser?:
    | boolean
    | {
        enabled?: boolean;
        executablePath?: string;
        headless?: boolean;
        viewport?: { width: number; height: number };
        launchTimeoutMs?: number;
      };
  /** 额外注入 system 的规则文件路径（相对 cwd 或绝对）。 */
  instructions?: string[];
  /**
   * 命令式 hooks：event + 可选 matcher + shell 命令（payload JSON 走 stdin，
   * exit 2=block，stdout JSON=HookResult；见 hooks-exec.ts）。
   */
  hooks?: { event: string; matcher?: string; command: string; timeoutMs?: number }[];
  /**
   * 基础权限规则（叠加在权限模式之下、档位之外，永不被切档位洗掉）：
   * allow/deny/ask，规则语法同 "Tool" / "Tool(glob)"。
   * .anicode/settings.local.json 的同名键会合并进来（allow_always 写回处）。
   */
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  /** 启动时应用的权限档位名（内置 readonly/default/workspace/full 或自定义）。 */
  permissionProfile?: string;
  /** 自定义权限档位：name → { mode?, allowRules?, denyRules?, askRules?, description? }。 */
  permissionProfiles?: Record<string, PermissionProfile>;
  /**
   * 配置档（对齐 Codex --profile）：name → 局部配置，启动时用 --profile <name>
   * 叠加到主配置之上（同 merge 语义）。档内不允许再嵌套 profiles。
   */
  profiles?: Record<string, Omit<AnicodeConfig, "profiles">>;
}

export interface LoadedConfig {
  config: AnicodeConfig;
  /** 实际读取到的文件路径（按合并顺序）。 */
  sources: string[];
  /** 解析告警（非法 JSON 等），供 CLI 决定是否提示。 */
  warnings: string[];
}

export interface LoadProjectEnvOptions {
  cwd?: string;
  /** 可注入环境对象，便于测试；默认写入当前进程环境。 */
  env?: NodeJS.ProcessEnv;
}

/**
 * 加载项目级 `.env.local` / `.env`，供 TUI、Electron 与 VSCode 共用。
 *
 * 只解析 KEY=VALUE，不执行 shell；进程已有变量优先，`.env.local` 优先于 `.env`。
 * 返回实际读取到的文件路径，文件不存在时静默跳过。
 */
export async function loadProjectEnv(opts: LoadProjectEnvOptions = {}): Promise<string[]> {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const loaded: string[] = [];
  for (const name of [".env.local", ".env"]) {
    const file = path.join(cwd, name);
    let raw: string;
    try {
      raw = await fs.readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
    for (const [key, value] of parseEnv(raw)) {
      if (env[key] === undefined) env[key] = value;
    }
    loaded.push(file);
  }
  return loaded;
}

function parseEnv(raw: string): [string, string][] {
  const entries: [string, string][] = [];
  for (const sourceLine of raw.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = normalized.indexOf("=");
    if (eq <= 0) continue;
    const key = normalized.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = normalized.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
    }
    entries.push([key, value]);
  }
  return entries;
}

const KNOWN_KEYS = new Set([
  "model",
  "smallModel",
  "fallbackModels",
  "mcp",
  "agents",
  "lsp",
  "browser",
  "hooks",
  "instructions",
  "permissions",
  "permissionProfile",
  "permissionProfiles",
  "profiles",
]);

function candidatePaths(cwd: string, home: string): string[] {
  return [
    path.join(home, ".config", "anicode", "anicode.json"),
    path.join(cwd, "anicode.json"),
    path.join(cwd, ".anicode", "anicode.json"),
    // 项目本地设置（个人授权清单等，不建议入库）；allow_always 写回这里
    path.join(cwd, ".anicode", "settings.local.json"),
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
      warnings.push(
        t(`${file}: top level must be an object; ignored`, `${file}: 顶层必须是对象，已忽略`),
      );
      return null;
    }
    for (const k of Object.keys(parsed)) {
      if (!KNOWN_KEYS.has(k))
        warnings.push(
          t(`${file}: unknown config key "${k}"; ignored`, `${file}: 未知配置项 "${k}"，已忽略`),
        );
    }
    return parsed as AnicodeConfig;
  } catch (err) {
    warnings.push(
      t(
        `${file}: JSON parse failed (${err instanceof Error ? err.message : String(err)})`,
        `${file}: JSON 解析失败（${err instanceof Error ? err.message : String(err)}）`,
      ),
    );
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
    ...(base.permissionProfiles || over.permissionProfiles
      ? { permissionProfiles: { ...base.permissionProfiles, ...over.permissionProfiles } }
      : {}),
    // 权限规则拼接去重：全局 deny + 项目 deny 都要生效，覆盖语义会静默丢安全规则。
    ...(base.permissions || over.permissions
      ? {
          permissions: {
            ...(base.permissions?.allow || over.permissions?.allow
              ? {
                  allow: [
                    ...new Set([
                      ...(base.permissions?.allow ?? []),
                      ...(over.permissions?.allow ?? []),
                    ]),
                  ],
                }
              : {}),
            ...(base.permissions?.deny || over.permissions?.deny
              ? {
                  deny: [
                    ...new Set([
                      ...(base.permissions?.deny ?? []),
                      ...(over.permissions?.deny ?? []),
                    ]),
                  ],
                }
              : {}),
            ...(base.permissions?.ask || over.permissions?.ask
              ? {
                  ask: [
                    ...new Set([
                      ...(base.permissions?.ask ?? []),
                      ...(over.permissions?.ask ?? []),
                    ]),
                  ],
                }
              : {}),
          },
        }
      : {}),
    ...(base.instructions || over.instructions
      ? { instructions: [...new Set([...(base.instructions ?? []), ...(over.instructions ?? [])])] }
      : {}),
    // hooks 全局+项目拼接（同一事件多个 hook 顺序执行，不去重——同命令可有意重复）。
    ...(base.hooks || over.hooks ? { hooks: [...(base.hooks ?? []), ...(over.hooks ?? [])] } : {}),
  };
}

export async function loadConfig(
  opts: { cwd?: string; home?: string; profile?: string } = {},
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
  // 配置档叠加（对齐 Codex --profile）：选中档的局部配置覆盖主配置。
  if (opts.profile) {
    const profile = config.profiles?.[opts.profile];
    if (profile) {
      config = merge(config, profile as AnicodeConfig);
    } else {
      warnings.push(
        t(
          `profile "${opts.profile}" not found (available: ${Object.keys(config.profiles ?? {}).join(", ") || "none"})`,
          `未找到配置档 "${opts.profile}"（可用: ${Object.keys(config.profiles ?? {}).join(", ") || "无"}）`,
        ),
      );
    }
    delete config.profiles; // 档位已消费；避免下游误用
  }
  return { config, sources, warnings };
}

/** 把配置里的 mcp 映射转成 connectMcpServers 需要的数组（注入 name）。 */
export function toMcpServerConfigs(config: AnicodeConfig): McpServerConfig[] {
  if (!config.mcp) return [];
  return Object.entries(config.mcp).map(([name, c]) => {
    if ("url" in c) {
      return {
        name,
        url: c.url,
        ...(c.headers ? { headers: c.headers } : {}),
        ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
      };
    }
    return {
      name,
      command: c.command,
      ...(c.args ? { args: c.args } : {}),
      ...(c.env ? { env: c.env } : {}),
      ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
    };
  });
}

/** 把配置里的 lsp 映射转成 LspServerConfig[]（name 只是标识，运行期按扩展名路由）。 */
export function toLspServers(config: AnicodeConfig): LspServerConfig[] {
  if (!config.lsp) return [];
  return Object.values(config.lsp);
}

/**
 * config.browser → BrowserToolOptions（默认启用）。返回 false 表示显式禁用；
 * 返回对象（可能为空）表示启用并附带可选的浏览器路径/视口等。
 */
export function browserToolOptions(config: AnicodeConfig): BrowserToolOptions | false {
  const b = config.browser;
  if (b === false) return false;
  if (b === undefined || b === true) return {};
  if (b.enabled === false) return false;
  const opts: BrowserToolOptions = {};
  if (b.executablePath) opts.executablePath = b.executablePath;
  if (b.headless !== undefined) opts.headless = b.headless;
  if (b.viewport) opts.viewport = b.viewport;
  if (b.launchTimeoutMs) opts.launchTimeoutMs = b.launchTimeoutMs;
  return opts;
}

/** 把配置里的 agents 映射转成 SubagentDefinition[]（prompt→system）。 */
export function toSubagentDefinitions(config: AnicodeConfig): SubagentDefinition[] {
  if (!config.agents) return [];
  return Object.entries(config.agents).map(([name, a]) => ({
    name,
    description: a.description,
    ...(a.prompt ? { system: a.prompt } : {}),
    ...(a.tools ? { tools: a.tools } : {}),
    ...(a.disallowedTools ? { disallowedTools: a.disallowedTools } : {}),
    ...(a.model ? { model: a.model } : {}),
    ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
    ...(a.orchestrator ? { orchestrator: true } : {}),
  }));
}
