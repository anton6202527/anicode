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
import { constants as fsConstants, promises as fs, type BigIntStats } from "node:fs";
import { t } from "./i18n.js";
import * as os from "node:os";
import * as path from "node:path";
import type { McpServerConfig } from "./mcp.js";
import type { SubagentDefinition } from "./subagent.js";
import type { LspServerConfig } from "./lsp.js";
import type { BrowserToolOptions } from "./tools/browser.js";
import type { PermissionProfile } from "./permission.js";
import {
  WorkspaceTrustStore,
  revalidateWorkspaceTrust,
  type WorkspaceTrustAssessment,
} from "./workspace-trust.js";

const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECT_ENV_BYTES = 4 * 1024 * 1024;
const FILE_READ_CHUNK_BYTES = 64 * 1024;

/** 配置里的单个 agent 定义（比 SubagentDefinition 更贴近用户书写习惯）。 */
export interface ConfigAgent {
  description: string;
  prompt?: string;
  tools?: string[];
  /** 禁用工具（支持 * glob）；在 tools/继承集确定后剔除。 */
  disallowedTools?: string[];
  model?: string;
  /** 推理深度覆盖（对齐 Codex model_reasoning_effort）。 */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  /** 编排型：保留 task 工具以便再往下派子 agent（受 MAX_SUBAGENT_DEPTH 深度上限约束）。 */
  orchestrator?: boolean;
  /** 只读调研型：工具面收窄到只读工具，可并行 fan-out。 */
  readOnly?: boolean;
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
   *   - 本地进程（stdio）：{ command, args?, env?, credentialEnv?, network? }
   *   - 远程（Streamable HTTP）：{ url, headers?, credential? }
   */
  mcp?: Record<
    string,
    | {
        command: string;
        args?: string[];
        env?: Record<string, string>;
        credentialEnv?: Record<string, string>;
        network?: boolean;
        timeoutMs?: number;
      }
    | {
        url: string;
        headers?: Record<string, string>;
        credential?: { id: string; header?: string; scheme?: string };
        timeoutMs?: number;
      }
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
        commandTimeoutMs?: number;
      };
  /** TUI-only preferences. Unknown action names are ignored by the frontend. */
  tui?: { keybindings?: Record<string, string> };
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
  /** Present when the caller used the Workspace Trust boundary. */
  workspaceTrust?: WorkspaceTrustAssessment;
}

export interface LoadProjectEnvOptions {
  cwd?: string;
  /** 可注入环境对象，便于测试；默认写入当前进程环境。 */
  env?: NodeJS.ProcessEnv;
  /** Project env is applied only for a currently valid trusted-workspace assessment. */
  workspaceTrust?: WorkspaceTrustAssessment;
  /** Reports names only; values are never exposed. */
  onBlocked?: (entry: { file: string; name: string; reason: "untrusted" | "reserved" }) => void;
}

export interface LoadConfigOptions {
  cwd?: string;
  home?: string;
  profile?: string;
  /** Omission is fail-closed: execution-sensitive project fields are ignored. */
  workspaceTrust?: WorkspaceTrustAssessment;
}

export interface LoadWorkspaceConfigOptions extends Omit<LoadConfigOptions, "workspaceTrust"> {
  trustStore?: WorkspaceTrustStore;
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
  // Do not even open project environment files until a complete, previously trusted assessment
  // has been revalidated. Apart from avoiding accidental activation, this prevents an untrusted
  // repository from making the host parse or disclose names from an attacker-controlled .env.
  if (!isCompleteTrustedAssessment(opts.workspaceTrust)) return loaded;
  const initialTrust = await revalidateWorkspaceTrust(cwd, opts.workspaceTrust);
  if (!isCompleteTrustedAssessment(initialTrust)) return loaded;
  const pending: { file: string; key: string; value: string }[] = [];
  for (const name of [".env.local", ".env"]) {
    const file = path.join(cwd, name);
    const raw = await readOptionalTextFileBounded(file, MAX_PROJECT_ENV_BYTES, true);
    if (raw === undefined) continue;
    for (const [key, value] of parseEnv(raw)) {
      if (isForbiddenProjectEnvName(key)) {
        opts.onBlocked?.({ file, name: key, reason: "reserved" });
        continue;
      }
      pending.push({ file, key, value });
    }
    loaded.push(file);
  }
  // Nothing from the project reaches process.env until the exact execution surface has been
  // checked again after all reads. Applying from `pending` then uses the immutable strings we read,
  // so a subsequent file replacement cannot change what this call activates.
  const finalTrust = await revalidateWorkspaceTrust(cwd, initialTrust);
  for (const entry of pending) {
    if (!isCompleteTrustedAssessment(finalTrust)) {
      opts.onBlocked?.({ file: entry.file, name: entry.key, reason: "untrusted" });
      continue;
    }
    if (env[entry.key] === undefined) env[entry.key] = entry.value;
  }
  return loaded;
}

/** Project files may never reconfigure the host control plane or child-process loader. */
export function isForbiddenProjectEnvName(name: string): boolean {
  const key = name.toUpperCase();
  return (
    key.startsWith("ANICODE_") ||
    key.startsWith("AGENTX_") ||
    key.startsWith("LD_") ||
    key.startsWith("DYLD_") ||
    [
      "NODE_OPTIONS",
      "NODE_PATH",
      "PATH",
      "SHELL",
      "BASH_ENV",
      "ENV",
      "ZDOTDIR",
      "ELECTRON_RUN_AS_NODE",
      "PYTHONPATH",
      "PYTHONHOME",
      "RUBYOPT",
      "PERL5OPT",
    ].includes(key)
  );
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

function isCompleteTrustedAssessment(
  assessment: WorkspaceTrustAssessment | undefined,
): assessment is WorkspaceTrustAssessment & {
  trusted: true;
  reason: "trusted";
  identity: NonNullable<WorkspaceTrustAssessment["identity"]>;
  executionHash: string;
} {
  return (
    assessment?.trusted === true &&
    assessment.reason === "trusted" &&
    Boolean(assessment.identity) &&
    typeof assessment.executionHash === "string" &&
    /^[a-f0-9]{64}$/.test(assessment.executionHash)
  );
}

async function readOptionalTextFileBounded(
  file: string,
  maxBytes: number,
  noFollow: boolean,
): Promise<string | undefined> {
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NONBLOCK === "number") flags |= fsConstants.O_NONBLOCK;
  if (noFollow && typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;

  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(file, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`cannot securely open file: ${file}`, { cause: error });
  }
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`not a regular file: ${file}`);
    if (before.size > BigInt(maxBytes)) {
      throw new Error(`file exceeds ${maxBytes} byte limit: ${file}`);
    }
    if (noFollow) await assertPathMatchesOpenFile(file, before);

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const buffer = Buffer.allocUnsafe(Math.min(FILE_READ_CHUNK_BYTES, remaining));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error(`file exceeds ${maxBytes} byte limit: ${file}`);

    const after = await handle.stat({ bigint: true });
    if (!sameFileMetadata(before, after)) throw new Error(`file changed while reading: ${file}`);
    if (noFollow) await assertPathMatchesOpenFile(file, before);
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function assertPathMatchesOpenFile(file: string, opened: BigIntStats): Promise<void> {
  let current: BigIntStats;
  try {
    current = await fs.lstat(file, { bigint: true });
  } catch (error) {
    throw new Error(`cannot verify file path: ${file}`, { cause: error });
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.dev !== opened.dev ||
    current.ino !== opened.ino ||
    !sameFileMetadata(current, opened)
  ) {
    throw new Error(`file path changed or is a symlink: ${file}`);
  }
}

function sameFileMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

const KNOWN_KEYS = new Set([
  "model",
  "smallModel",
  "fallbackModels",
  "mcp",
  "agents",
  "lsp",
  "browser",
  "tui",
  "hooks",
  "instructions",
  "permissions",
  "permissionProfile",
  "permissionProfiles",
  "profiles",
]);

function candidatePaths(cwd: string, home: string): { file: string; project: boolean }[] {
  return [
    { file: path.join(home, ".config", "anicode", "anicode.json"), project: false },
    { file: path.join(cwd, "anicode.json"), project: true },
    { file: path.join(cwd, ".anicode", "anicode.json"), project: true },
    // 项目本地设置（个人授权清单等，不建议入库）；allow_always 写回这里
    { file: path.join(cwd, ".anicode", "settings.local.json"), project: true },
  ];
}

async function readOne(
  file: string,
  warnings: string[],
  project: boolean,
): Promise<AnicodeConfig | null> {
  let raw: string | undefined;
  try {
    raw = await readOptionalTextFileBounded(file, MAX_CONFIG_FILE_BYTES, project);
  } catch (error) {
    warnings.push(
      t(
        `${file}: config read failed (${error instanceof Error ? error.message : String(error)}); ignored`,
        `${file}: 配置读取失败（${error instanceof Error ? error.message : String(error)}），已忽略`,
      ),
    );
    return null;
  }
  if (raw === undefined) return null;
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
    ...(base.tui || over.tui
      ? {
          tui: {
            ...base.tui,
            ...over.tui,
            ...(base.tui?.keybindings || over.tui?.keybindings
              ? { keybindings: { ...base.tui?.keybindings, ...over.tui?.keybindings } }
              : {}),
          },
        }
      : {}),
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

export async function loadConfig(opts: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const warnings: string[] = [];
  const sources: string[] = [];
  let workspaceTrust = opts.workspaceTrust;
  if (isCompleteTrustedAssessment(workspaceTrust)) {
    workspaceTrust = await revalidateWorkspaceTrust(cwd, workspaceTrust);
  }
  const loadedFiles: { file: string; project: boolean; config: AnicodeConfig }[] = [];
  for (const { file, project } of candidatePaths(cwd, home)) {
    const one = await readOne(file, warnings, project);
    if (one) {
      loadedFiles.push({ file, project, config: one });
      sources.push(file);
    }
  }
  // Close the check/read race: only activate project execution fields when the workspace still
  // matches the grant after every project config file has been read into memory.
  if (isCompleteTrustedAssessment(workspaceTrust)) {
    workspaceTrust = await revalidateWorkspaceTrust(cwd, workspaceTrust);
  }
  const projectTrusted = isCompleteTrustedAssessment(workspaceTrust);
  let config: AnicodeConfig = {};
  for (const { file, project, config: one } of loadedFiles) {
    const applied = project && !projectTrusted ? safeUntrustedProjectConfig(one) : one;
    if (project && !projectTrusted) {
      const ignored = executionSensitiveKeys(one);
      if (ignored.length > 0) {
        warnings.push(
          t(
            `${file}: ignored execution-sensitive project settings in an untrusted workspace (${ignored.join(", ")})`,
            `${file}: 未信任工作区，已忽略可执行项目配置（${ignored.join("、")}）`,
          ),
        );
      }
    }
    config = merge(config, applied);
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
  return {
    config,
    sources,
    warnings,
    ...(workspaceTrust ? { workspaceTrust } : {}),
  };
}

/**
 * Safe high-level loader for hosts. It queries the user-level trust store and then applies only
 * configuration permitted by the resulting assessment.
 */
export async function loadConfigWithWorkspaceTrust(
  opts: LoadWorkspaceConfigOptions = {},
): Promise<LoadedConfig & { workspaceTrust: WorkspaceTrustAssessment }> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  const store = opts.trustStore ?? new WorkspaceTrustStore({ home });
  const assessment = await store.assess(cwd);
  const loaded = await loadConfig({
    cwd,
    home,
    ...(opts.profile ? { profile: opts.profile } : {}),
    workspaceTrust: assessment,
  });
  return {
    ...loaded,
    workspaceTrust: loaded.workspaceTrust ?? assessment,
  };
}

const SAFE_UNTRUSTED_PROJECT_KEYS = ["model", "smallModel", "fallbackModels", "tui"] as const;
const EXECUTION_SENSITIVE_PROJECT_KEYS = [
  "mcp",
  "agents",
  "lsp",
  "browser",
  "instructions",
  "hooks",
  "permissions",
  "permissionProfile",
  "permissionProfiles",
  "profiles",
] as const;

function safeUntrustedProjectConfig(config: AnicodeConfig): AnicodeConfig {
  const safe: AnicodeConfig = {};
  for (const key of SAFE_UNTRUSTED_PROJECT_KEYS) {
    if (Object.hasOwn(config, key)) {
      Object.assign(safe, { [key]: config[key] });
    }
  }
  return safe;
}

function executionSensitiveKeys(config: AnicodeConfig): string[] {
  return EXECUTION_SENSITIVE_PROJECT_KEYS.filter((key) => Object.hasOwn(config, key));
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
        ...(c.credential ? { credential: c.credential } : {}),
        ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}),
      };
    }
    return {
      name,
      command: c.command,
      ...(c.args ? { args: c.args } : {}),
      ...(c.env ? { env: c.env } : {}),
      ...(c.credentialEnv ? { credentialEnv: c.credentialEnv } : {}),
      ...(c.network !== undefined ? { network: c.network } : {}),
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
  if (b.commandTimeoutMs) opts.commandTimeoutMs = b.commandTimeoutMs;
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
    ...(a.effort ? { effort: a.effort } : {}),
    ...(a.maxTurns ? { maxTurns: a.maxTurns } : {}),
    ...(a.orchestrator ? { orchestrator: true } : {}),
    ...(a.readOnly ? { readOnly: true } : {}),
  }));
}
