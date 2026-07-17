/**
 * Agent —— core 的中枢。把 provider（模型）+ tools（能力）+ permission（护栏）
 * + hooks（用户扩展点）编织成一个 agent loop，对外只暴露
 * 「发消息 → 消费事件流」两个动作，UI 无关。
 *
 * loop：模型流式输出 → 若请求工具则执行（连续只读工具并行、副作用工具串行，
 * 均过权限门）→ 结果回传 → 继续，直到模型不再调用工具或达到 maxTurns。
 *
 * 运行中可 queue() 追加用户输入（steering）：在 turn 边界注入历史，
 * 模型下一轮即可看到 —— 无需打断当前工作。
 *
 * Agent 只负责「一个会话的一次驱动」。多订阅者广播、跨连接接管由上层
 * SessionManager 负责 —— Agent 保持单一职责，可独立测试。
 */

import { t } from "./i18n.js";
import type { ChatMessage, ImagePart, Provider, ToolResultPart, Usage } from "./types.js";
import { emptyUsage, toolCallsOf } from "./types.js";
import {
  BUILTIN_PROFILES,
  PermissionEngine,
  type PermissionConfig,
  type PermissionDecision,
  type PermissionMode,
  type PermissionProfile,
} from "./permission.js";
import { ToolRegistry, ToolError, type Tool } from "./tools/tool.js";
import { defaultTools } from "./tools/index.js";
import { createWebSearchTool, type WebSearchBackend } from "./tools/web-search.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import { createLspNavTools } from "./tools/lsp-nav.js";
import type { LspPool } from "./lsp.js";
import { Chan } from "./chan.js";
import { HookRunner, type HookRegistration } from "./hooks.js";
import { createTaskTool, type SubagentDefinition } from "./subagent.js";
import { discoverSkills, skillListPrompt, createSkillTool } from "./skills.js";
import {
  loadProjectMemory,
  composeSystem,
  maybeCompact,
  providerSummarizer,
  type CompactionConfig,
} from "./context.js";
import { gatherEnv } from "./env.js";
import { gatherRepoMap, type RepoMapOptions } from "./repomap.js";
import { SnapshotStore } from "./snapshot.js";
import type { SessionStore, SessionMeta } from "./session.js";

// ---------- 对外事件 ----------

export type AgentEvent =
  | { type: "user_message"; text: string; queued: boolean } // 用户消息进入历史（queued=运行中注入）
  | { type: "text"; text: string } // 流式文本增量
  | { type: "thinking"; text: string } // 流式推理增量
  | { type: "tool_input_delta"; id: string; name: string; delta: string } // 工具参数流式增量（UI 可实时预览）
  | { type: "tool_start"; id: string; name: string; ruleKey: string }
  | { type: "tool_permission"; id: string; name: string; decision: "allow" | "deny" }
  | { type: "tool_progress"; id: string; name: string; event: unknown } // 工具执行中的进度（如子 agent 内部事件）
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "turn_end"; usage: Usage } // 一个模型轮结束（可能还要继续 loop）
  | { type: "turn_reset" } // 一次流式尝试失败（重试或终止）；消费者应丢弃该尝试的残留增量
  | { type: "retry"; attempt: number; delayMs: number; reason: string } // provider 瞬时错误，退避重试中
  | { type: "compacted"; beforeTokens: number; afterTokens: number } // 上下文被压缩
  | { type: "checkpoint"; id: string; tree: string; label: string } // 本轮开始前的工作区快照（供 undo）
  | { type: "done"; usage: Usage; turns: number } // 整个 loop 结束，等待下一条用户输入
  | { type: "error"; message: string };

export interface RetryConfig {
  /** 瞬时错误（429/5xx/网络）最大重试次数，默认 3 */
  maxRetries?: number;
  /** 首次退避毫秒数（指数递增 + 抖动），默认 500 */
  baseDelayMs?: number;
}

/** Agent 运行时真正需要的模型能力子集；registry 的 ProviderModelInfo 与其结构兼容。 */
export interface AgentModelInfo {
  providerId: string;
  model: string;
  capabilities: {
    tools?: boolean;
    reasoning?: boolean;
    images?: boolean;
  };
  limits: {
    contextWindow?: number;
    maxOutputTokens?: number;
  };
}

export interface AgentResolvedModel {
  provider: Provider;
  model: string;
  modelInfo?: AgentModelInfo;
}

export interface AgentOptions {
  provider: Provider;
  model: string;
  /** registry 解析出的能力/上下文限制；有值时请求形状会按模型收敛。 */
  modelInfo?: AgentModelInfo;
  /** 子 agent 跨 provider 覆盖模型时使用；通常直接传 createProvider。 */
  resolveModel?: (spec: string) => AgentResolvedModel;
  cwd: string;
  system?: string;
  tools?: ToolRegistry;
  permission?: PermissionConfig;
  /** 自定义权限档位（叠加/覆盖内置 readonly/default/workspace/full），/profile 可切。 */
  permissionProfiles?: Record<string, PermissionProfile>;
  /** loop 关键节点的用户扩展（PreToolUse/PostToolUse/UserPromptSubmit/Stop） */
  hooks?: HookRegistration[];
  /** 启用 task 工具（子 agent 委派）。true=仅内置 general 类型；数组=追加自定义类型 */
  subagents?: boolean | SubagentDefinition[];
  /**
   * 启用 skills 渐进加载：扫描 .claude/skills（项目级+用户级），
   * 清单注入 system 提示（L1），正文经 skill 工具按需加载（L2）。
   * 传对象可追加扫描目录。默认关。
   */
  skills?: boolean | { dirs?: string[] };
  maxTurns?: number;
  maxTokens?: number;
  /**
   * 便宜快速模型 spec（`provider/model`），用于压缩摘要等杂活（对齐 Claude Code
   * 「大量调用走小模型」的成本策略）。需要 resolveModel 才能实例化；解析失败静默回退主模型。
   */
  smallModel?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** 单个工具结果注入历史的字符上限（超出截中段），默认 30000 */
  maxToolResultChars?: number;
  /** provider 瞬时错误重试；false 关闭。默认开启 */
  retry?: RetryConfig | false;
  /** 是否加载 AGENTS.md/CLAUDE.md 项目记忆（默认开） */
  projectMemory?: boolean;
  /** 是否在会话开始时注入环境接地块（cwd/OS/日期/git 状态）。默认开。 */
  injectEnv?: boolean;
  /**
   * 是否在会话开始时注入 repo map（代码骨架：关键文件及其顶层符号签名），
   * 让模型少盲 grep、首次定位更准。true=默认预算；对象可调预算/限量。默认关。
   */
  repoMap?: boolean | RepoMapOptions;
  /**
   * 工作区快照/撤销：每轮用户输入前记一个 git 快照（不动 HEAD/index），供 undo 回滚
   * 本轮的文件改动。true=按 cwd 自建 SnapshotStore；也可直接传入共享的 store。默认关。
   */
  checkpoints?: boolean | SnapshotStore;
  /** OS 级命令沙箱策略（bash 工具用）；默认 none（也可由环境变量 AGENTX_BASH_SANDBOX 覆盖）。 */
  sandbox?: "none" | "read-only" | "workspace-write";
  /**
   * 启用 web_search 工具（让模型能发现 URL，而不只是抓已知 URL）。可插拔：传入一个
   * WebSearchBackend（如 tavilyBackend/braveBackend/自定义）。不传则不注册该工具。
   */
  webSearch?: WebSearchBackend;
  /**
   * 启用 LSP 工具套件：diagnostics（自查）+ definition/references/symbols（语义导航）。
   * 传入一个已就绪的 LspPool；生命周期由宿主持有（进程需在会话结束时 closeAll）。
   * 不传则不注册这些工具。
   */
  lsp?: LspPool;
  /** 上下文压缩配置。传入即启用；summarizer 缺省用当前 provider 自摘要 */
  compaction?: Partial<CompactionConfig> | boolean;
  /** 会话持久化 */
  persistence?: PersistenceConfig;
}

export interface PersistenceConfig {
  store: SessionStore;
  /** 会话 meta（含 id）。resume 时传已有会话的 meta。 */
  meta: SessionMeta;
  /** resume：预填历史（跳过再次写 meta，只在此后 append） */
  resumeMessages?: ChatMessage[];
}

/** Agent 的可序列化状态快照 —— 供晚加入的订阅者 / resume 渲染重建界面 */
export interface AgentSnapshot {
  messages: ChatMessage[];
  usage: Usage;
}

/**
 * 历史自愈：若历史以「含 tool_call 但缺配对 tool_result 的 assistant 消息」结尾
 * （进程崩溃 / 强杀留下的悬空状态），补上合成错误结果 —— 否则下一次
 * provider 回放必 400（tool_use 无配对 tool_result）。
 * 返回新数组；无需修复时原样返回（引用相等，调用方可据此判断是否发生了修复）。
 */
export function repairHistory(messages: ChatMessage[]): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  const calls = toolCallsOf(last);
  if (calls.length === 0) return messages;
  return [
    ...messages,
    {
      role: "user",
      content: calls.map((c) => ({
        type: "tool_result" as const,
        toolCallId: c.id,
        toolName: c.name,
        content: "（会话在该工具执行完成前中断，结果不可用）",
        isError: true,
      })),
    },
  ];
}

/** 默认系统提示词，按当前界面语言取词（在 Agent 构造时求值，故 /lang 后新建会话即生效）。 */
function defaultSystem(): string {
  return t(
    `You are an AI coding assistant running in the user's terminal, completing software-engineering tasks by reading/writing files and running commands.

# How you work
- Understand the relevant code before acting: use read/grep/glob to learn the structure and conventions; don't change things on a guess.
- Keep edits precise and minimal, doing only what was asked; no drive-by refactors, no unrelated changes.
- When a task involves several uncertain steps, use todo_write to lay out a checklist and update it as you go, so the user sees the plan.
- When you hit a fork you can't settle on your own (destructive, ambiguous, or several reasonable approaches), stop and ask the user rather than betting on one.

# Using tools
- Prefer grep / glob / read to search code; don't use bash cat / find / grep / ls — the dedicated tools are faster, cleaner, and can run in parallel.
- Edit files with edit / write; don't rewrite source via shell redirection (echo >> / sed -i).
- Reserve bash for build, test, git, package management, and other cases that genuinely need a shell.
- For anything long-running or that never exits on its own (dev servers, watch builds, tailing logs), use bash with run_in_background instead of blocking until timeout; then read its output with bash_output and stop it with kill_shell when done.
- Send multiple independent read-only calls (reading a few files, running a few searches) together in one turn so they run in parallel, rather than one at a time.

# Code conventions
- New code should blend into the existing style: look at nearby naming, indentation, comment density, and idioms first, then match them.
- Don't add superfluous comments or unrequested docs; don't introduce dependencies not already used in the project (confirm it's in use first).
- Don't commit or push (git commit/push) on your own unless the user explicitly asks.

# Verification and wrap-up
- After changing code, if the project has tests / type-checking / lint, try to run them to confirm you didn't break anything; if you can't, say so honestly.
- Don't misreport completion: if tests fail, say so with the output; if you skipped a step, say you skipped it. Only state it's done plainly when it truly is and you've verified it.
- Wrap up in a sentence or two about what you did — terminal-facing, concise, no long recap.

# Safety
- Operations with side effects (writing files, running commands) go through user authorization; when denied, switch approach or ask — don't work around it.
- Assist with defensive security and normal engineering work within authorization; refuse requests clearly meant to damage, attack, or evade detection.`,
    `你是运行在用户终端里的 AI 编程助手，通过读写文件、执行命令来完成软件工程任务。

# 工作方式
- 动手前先了解相关代码：用 read/grep/glob 摸清结构与约定，不要凭猜测改动。
- 修改精确、最小化，只做被要求的事；不顺手重构、不留无关改动。
- 一次任务涉及多个不确定步骤时，用 todo_write 列清单并随进度更新，让用户看到规划。
- 遇到无法自行判断的分叉（有破坏性、需求含糊、多种合理方案）时，停下来问用户，而不是赌一个。

# 工具使用
- 检索代码优先用 grep / glob / read，不要用 bash 的 cat / find / grep / ls —— 专用工具更快、结果更规整、还能并行。
- 改文件用 edit / write，不要用 shell 重定向（echo >> / sed -i）去改源码。
- bash 留给构建、测试、git、包管理等真正需要 shell 的场景。
- 长时间运行或不会自己结束的命令（dev server、watch 构建、日志跟随）用 bash 的 run_in_background，别阻塞到超时；之后用 bash_output 读输出，用完 kill_shell 停掉。
- 多个相互独立的只读调用（读几个文件、跑几处搜索）请在同一轮里一起发出，让它们并行执行，别一个个串着来。

# 代码规范
- 新代码要融入现有风格：先看邻近代码的命名、缩进、注释密度和惯用法，照着写。
- 不加多余注释，不写没被要求的文档；不引入未在项目中出现过的依赖（先确认它已被使用）。
- 不主动提交或推送（git commit/push），除非用户明确要求。

# 验证与收尾
- 改完代码后，若项目有测试 / 类型检查 / lint，尽量跑一遍确认没引入问题；跑不了就如实说明。
- 不要谎报完成：测试失败就带上输出说失败，跳过的步骤就说跳过。确实做完并验证过才平实地说做好了。
- 收尾用一两句话说明做了什么，面向终端、简洁，不要长篇复述。

# 安全
- 有副作用的操作（写文件、执行命令）会经过用户授权；被拒绝时换方式或询问，不要绕过。
- 协助授权范围内的防御性安全与正常工程工作；拒绝明显用于破坏、攻击或规避检测的请求。`,
  );
}

/** Stop hook 单次 drive 内最多强制续跑的轮数（防 hook 造成死循环） */
const MAX_STOP_CONTINUATIONS = 3;

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 500;

type ToolCall = { id: string; name: string; args: Record<string, unknown> };

type TurnOutcome =
  | { type: "ok"; message: ChatMessage; stopReason: string; usage: Usage }
  | { type: "error"; message: string; cause?: unknown; partial: boolean };

export class Agent {
  // 非 readonly：per-prompt 模型覆盖会在单次 drive 内临时换掉、结束即还原（send 不可重入保证安全）。
  private provider: Provider;
  private model: string;
  private readonly resolveModelFn?: (spec: string) => AgentResolvedModel;
  private readonly cwd: string;
  private readonly baseSystem: string;
  private readonly tools: ToolRegistry;
  private readonly perm: PermissionEngine;
  private readonly permissionProfiles: Record<string, PermissionProfile>;
  private readonly hooks: HookRunner;
  private readonly maxTurns: number;
  private readonly maxTokens: number | undefined;
  private readonly effort: AgentOptions["effort"];
  private supportsTools: boolean;
  /** 模型是否支持视觉；未知能力按 false（宁可降级为文本，也不要整轮请求被拒）。 */
  private supportsImages: boolean;
  private readonly maxToolResultChars: number;
  private readonly retry: Required<RetryConfig> | null;
  private readonly useProjectMemory: boolean;
  private readonly injectEnv: boolean;
  private readonly repoMapOpt: boolean | RepoMapOptions;
  private readonly snapshots: SnapshotStore | null;
  private readonly sandbox: AgentOptions["sandbox"];
  private readonly skillsOpt: AgentOptions["skills"];
  private readonly compaction: CompactionConfig | null;
  private readonly persist: PersistenceConfig | null;
  /** 摘要等杂活用的小模型；未配置或解析失败时等于主 provider/model。 */
  private readonly smallProvider: Provider;
  private readonly smallModelId: string;

  private system: string;
  private memoryLoaded = false;
  private history: ChatMessage[] = [];
  private cumulative: Usage = emptyUsage();
  private lastInputTokens = 0; // 上一次 provider 调用的真实输入 token，驱动压缩触发
  private persistedCount = 0; // 已 append 进会话文件的消息数；compaction 后重置
  private running = false; // 并发护栏：send 不可重入
  private acceptingQueuedInput = false; // done/error 已决定后关闭，避免收尾窗口吞消息
  private queued: string[] = []; // steering：运行中追加的用户输入，turn 边界注入
  private readonly parallelInputsStable: boolean;

  constructor(opts: AgentOptions) {
    this.provider = opts.provider;
    this.model = opts.model;
    if (opts.resolveModel) this.resolveModelFn = opts.resolveModel;
    // 小模型：解析失败（拼写/缺凭证）就静默回退主模型，绝不因杂活模型而拖垮主流程。
    let smallProvider = opts.provider;
    let smallModelId = opts.model;
    if (opts.smallModel && opts.resolveModel) {
      try {
        const r = opts.resolveModel(opts.smallModel);
        smallProvider = r.provider;
        smallModelId = r.model;
      } catch {
        /* 回退主模型 */
      }
    }
    this.smallProvider = smallProvider;
    this.smallModelId = smallModelId;
    this.cwd = opts.cwd;
    this.baseSystem = opts.system ?? defaultSystem();
    this.system = this.baseSystem;
    // Agent 拥有自己的 registry，避免启用 task/skill 时污染调用方复用的集合，
    // 也借 Tool.fork() 隔离 todo 等闭包状态。
    this.tools = opts.tools?.clone() ?? defaultTools();
    this.hooks = new HookRunner(opts.hooks ?? []);
    this.maxTurns = opts.maxTurns ?? 50;
    this.maxTokens = resolveMaxTokens(opts.maxTokens, opts.modelInfo);
    this.supportsTools = opts.modelInfo?.capabilities.tools ?? true;
    this.supportsImages = opts.modelInfo?.capabilities.images ?? false;
    this.effort = opts.modelInfo?.capabilities.reasoning === false ? undefined : opts.effort;
    const maxResult = opts.maxToolResultChars ?? 30_000;
    this.maxToolResultChars = Number.isFinite(maxResult) ? Math.max(256, maxResult) : 30_000;
    this.retry =
      opts.retry === false
        ? null
        : {
            maxRetries: Math.max(0, Math.floor(opts.retry?.maxRetries ?? DEFAULT_MAX_RETRIES)),
            baseDelayMs: Math.max(0, opts.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS),
          };
    this.useProjectMemory = opts.projectMemory ?? true;
    this.injectEnv = opts.injectEnv ?? true;
    this.repoMapOpt = opts.repoMap ?? false;
    this.snapshots =
      opts.checkpoints instanceof SnapshotStore
        ? opts.checkpoints
        : opts.checkpoints
          ? new SnapshotStore(this.cwd)
          : null;
    this.sandbox = opts.sandbox;
    this.skillsOpt = opts.skills;
    this.compaction = this.resolveCompaction(opts.compaction, opts.modelInfo);
    this.persist = opts.persistence ?? null;
    if (this.persist?.resumeMessages) {
      const resumed = [...this.persist.resumeMessages];
      // 这些已在文件里，勿重复写；自愈补上的合成结果会在下次 flush 时落盘
      this.persistedCount = resumed.length;
      this.history = repairHistory(resumed);
    }
    // web_search / diagnostics：都是只读工具，在 perm 引擎构建前注册即可自动放行；
    // 也在 task 工具之前注册，好让子 agent（含只读的 explore）一并继承 —— 调研子 agent
    // 能搜网、能自查诊断，正是它们该有的能力。
    if (opts.webSearch) this.tools.register(createWebSearchTool(opts.webSearch));
    if (opts.lsp) {
      this.tools.register(createDiagnosticsTool(opts.lsp));
      for (const navTool of createLspNavTools(opts.lsp)) this.tools.register(navTool);
    }
    // 子 agent 委派：把 task 工具注册进本 agent 的工具集
    if (opts.subagents) {
      // 子 agent 继承工具策略/审计 hooks，避免 task 成为绕过父级写入拦截的通道。
      // UserPromptSubmit 与 Stop 属于父会话生命周期，不应用到模型生成的子任务提示。
      const childHooks = (opts.hooks ?? []).filter(
        (hook) => hook.event === "PreToolUse" || hook.event === "PostToolUse",
      );
      this.tools.register(
        createTaskTool({
          makeAgent: (o) => new Agent(o),
          provider: this.provider,
          model: this.model,
          ...(opts.modelInfo ? { modelInfo: opts.modelInfo } : {}),
          ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
          cwd: this.cwd,
          tools: this.tools,
          ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
          ...(opts.permission ? { permission: opts.permission } : {}),
          ...(childHooks.length > 0 ? { hooks: childHooks } : {}),
          ...(Array.isArray(opts.subagents) ? { definitions: opts.subagents } : {}),
        }),
      );
    }
    // 只读/编辑类工具名并入权限引擎：只读自动放行，编辑类供 acceptEdits 决策
    this.perm = new PermissionEngine({
      ...opts.permission,
      readOnlyTools: [...(opts.permission?.readOnlyTools ?? []), ...this.tools.readOnlyNames()],
      editTools: [...(opts.permission?.editTools ?? []), ...this.tools.editNames()],
    });
    this.permissionProfiles = { ...BUILTIN_PROFILES, ...opts.permissionProfiles };
    // 并发分组发生在执行前。只要 PreToolUse 或只读 ask-confirm 可能改写入参，
    // 就保守串行，避免按旧参数判成安全、最终却执行写操作。
    this.parallelInputsStable =
      !this.hooks.has("PreToolUse") &&
      !(opts.permission?.confirm && (opts.permission.askRules?.length ?? 0) > 0);
  }

  // ---------- 只读访问 ----------

  get isRunning(): boolean {
    return this.running;
  }
  get totalUsage(): Usage {
    return this.cumulative;
  }
  get messages(): readonly ChatMessage[] {
    return this.history;
  }
  snapshot(): AgentSnapshot {
    return { messages: [...this.history], usage: this.cumulative };
  }
  /** 工作区快照存储（供上层实现 undo）；未启用 checkpoints 时为 null。 */
  get snapshotStore(): SnapshotStore | null {
    return this.snapshots;
  }

  /** 运行时切换权限模式（如 /plan 进入/退出计划模式）；下一轮工具授权即按新模式判定。 */
  setPermissionMode(mode: PermissionMode): void {
    this.perm.setMode(mode);
  }

  getPermissionMode(): PermissionMode {
    return this.perm.getMode();
  }

  /**
   * 运行时切换权限档位（内置 readonly/default/workspace/full + AgentOptions.permissionProfiles
   * 自定义档位）。返回切换后的生效模式；未知档位名抛错并列出可用档位。
   */
  setPermissionProfile(name: string): PermissionMode {
    const profile = this.permissionProfiles[name];
    if (!profile) {
      throw new Error(
        t(
          `Unknown permission profile "${name}". Available: ${Object.keys(this.permissionProfiles).join(", ")}`,
          `未知权限档位 "${name}"。可用: ${Object.keys(this.permissionProfiles).join(", ")}`,
        ),
      );
    }
    this.perm.applyProfile(name, profile);
    return this.perm.getMode();
  }

  getPermissionProfile(): string | null {
    return this.perm.getProfile();
  }

  /** 所有可切换的档位（内置 + 自定义），供 UI 列表展示。 */
  listPermissionProfiles(): Record<string, PermissionProfile> {
    return { ...this.permissionProfiles };
  }

  // ---------- 驱动 ----------

  /**
   * 发一条用户消息，驱动 loop，产出事件流直到本次 done。
   * 并发护栏：上一轮未结束时再次调用会抛错（运行中请改用 queue()）。
   */
  async *send(
    userText: string,
    signal?: AbortSignal,
    opts?: { model?: string },
  ): AsyncGenerator<AgentEvent> {
    if (this.running)
      throw new Error(
        t(
          "Session is busy: the previous turn has not finished (use queue to append input while running)",
          "会话正忙：上一轮尚未结束（运行中追加输入请用 queue）",
        ),
      );
    this.running = true;
    // 主输入尚在加载记忆 / 跑 UserPromptSubmit hook 时不接 steering；否则主输入
    // 被 block 时，准备期间到达的消息会跟着它的 queue 一起被清掉。
    this.acceptingQueuedInput = false;
    // per-prompt 模型覆盖：本次 drive 全程（含工具后的后续 turn）用覆盖模型，结束还原。
    // send 不可重入（running 护栏），临时换字段是安全的。
    const saved = {
      provider: this.provider,
      model: this.model,
      supportsTools: this.supportsTools,
      supportsImages: this.supportsImages,
    };
    try {
      if (opts?.model) {
        if (!this.resolveModelFn) {
          yield {
            type: "error",
            message: t(
              "Per-prompt model override requires the resolveModel option",
              "单条消息模型覆盖需要配置 resolveModel 选项",
            ),
          };
          return;
        }
        let resolved: AgentResolvedModel;
        try {
          resolved = this.resolveModelFn(opts.model);
        } catch (err) {
          yield {
            type: "error",
            message: t(
              `Cannot resolve model "${opts.model}": ${err instanceof Error ? err.message : String(err)}`,
              `无法解析模型 "${opts.model}"：${err instanceof Error ? err.message : String(err)}`,
            ),
          };
          return;
        }
        this.provider = resolved.provider;
        this.model = resolved.model;
        this.supportsTools = resolved.modelInfo?.capabilities.tools ?? true;
        this.supportsImages = resolved.modelInfo?.capabilities.images ?? false;
      }
      yield* this.drive(userText, signal ?? new AbortController().signal);
    } finally {
      this.provider = saved.provider;
      this.model = saved.model;
      this.supportsTools = saved.supportsTools;
      this.supportsImages = saved.supportsImages;
      this.acceptingQueuedInput = false;
      this.queued = [];
      this.running = false;
    }
  }

  /**
   * steering：loop 运行中追加一条用户输入，在下一个 turn 边界注入历史。
   * 返回 false 表示当前 drive 尚未开始接收或已经停止接收 steering；
   * 调用方应把消息排到下一次 send。
   */
  queue(text: string): boolean {
    if (!this.running || !this.acceptingQueuedInput) return false;
    this.queued.push(text);
    return true;
  }

  /** 中断时丢弃尚未注入历史的 steering 输入。返回被清掉的数量。 */
  clearQueue(): number {
    // 先同步关门，再清队列。interrupt 随后的 abort 可能同步触发外部回调；
    // 回调中新到的消息必须进入下一 drive，不能重新塞进即将终止的本轮。
    this.acceptingQueuedInput = false;
    const count = this.queued.length;
    this.queued = [];
    return count;
  }

  private async *drive(userText: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    await this.ensureMemory();

    // UserPromptSubmit hook：可拦截输入，或注入 UI 不展示的内部上下文。
    const prepared = await this.prepareUserInput(userText);
    if (prepared.blocked) {
      this.acceptingQueuedInput = false;
      yield { type: "error", message: `输入被 hook 拦截: ${prepared.reason}` };
      return;
    }
    yield* this.pushUser(userText, false, prepared.additionalContext);
    await this.flushPersist();
    // 主输入已经正式进入历史，从这里开始同一 drive 才可接受 steering。
    // interrupt 可能发生在异步 hook / 持久化期间；closing 不得重新回到 active。
    this.acceptingQueuedInput = !signal.aborted;

    // 工作区快照：在模型动手前记一份，供用户 undo 回滚本轮的文件改动。尽力而为，失败不影响主流程。
    if (this.snapshots) {
      const snap = await this.snapshots.take(userText.replace(/\s+/g, " ").trim().slice(0, 60));
      if (snap) yield { type: "checkpoint", id: snap.id, tree: snap.tree, label: snap.label };
    }

    let stopContinuations = 0;
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      // 压缩：每轮 provider 调用前检查历史规模
      if (this.compaction) {
        const res = await maybeCompact(this.history, this.compaction, this.lastInputTokens);
        if (res.compacted) {
          this.history = res.messages;
          await this.rewritePersist(); // 历史被改写，整文件重写
          yield { type: "compacted", beforeTokens: res.beforeTokens, afterTokens: res.afterTokens };
        }
      }

      const outcome = yield* this.runModelTurn(signal);
      if (outcome.type === "error") {
        // 已经接受的 steering 不可留到下一次 send 后乱序；先按原顺序入历史，
        // 再结束本轮。它们会在下一次显式 send 时与历史一同交给模型。
        while (this.queued.length > 0) {
          yield* this.drainQueued();
          await this.flushPersist();
        }
        this.acceptingQueuedInput = false;
        yield { type: "error", message: outcome.message };
        return;
      }
      // Provider 实现可能忽略 AbortSignal 并在退出后仍返回工具调用。此处是
      // Agent 自己的最后一道副作用闸门：被中断的响应绝不能进入 history/执行工具。
      if (signal.aborted) {
        this.acceptingQueuedInput = false;
        yield { type: "turn_reset" };
        yield { type: "error", message: "会话已中断" };
        return;
      }

      this.history.push(outcome.message);
      await this.flushPersist();
      this.accumulate(outcome.usage);
      // 真实上下文规模 = 非缓存输入 + 缓存读 + 缓存写（三者都属本轮 prompt token）。
      // 含 system+tools，是压缩触发最准的依据；比 char/4 估算靠谱。
      const realInput =
        outcome.usage.inputTokens + outcome.usage.cacheReadTokens + outcome.usage.cacheWriteTokens;
      if (realInput > 0) this.lastInputTokens = realInput;
      yield { type: "turn_end", usage: outcome.usage };

      const calls = toolCallsOf(outcome.message);
      if (outcome.stopReason !== "tool_use" || calls.length === 0) {
        // steering 队列非空 → 注入并继续 loop（模型收尾了但用户还有话说）
        if (this.queued.length > 0) {
          const added = yield* this.drainQueued();
          if (added > 0) {
            await this.flushPersist();
            continue;
          }
        }
        // Stop hook：可要求继续（配额有限，防死循环）
        if (this.hooks.has("Stop")) {
          const h = await this.hooks.run({ event: "Stop", cwd: this.cwd, stopContinuations });
          if (h.blocked && stopContinuations < MAX_STOP_CONTINUATIONS) {
            stopContinuations++;
            this.pushInternalUser(reminder(`Stop hook 要求继续: ${h.reason}`).trim());
            await this.flushPersist();
            continue;
          }
        }
        // Stop hook await 期间也可能收到 steering；必须在决定 done 前再检查一次。
        if (this.queued.length > 0) {
          const added = yield* this.drainQueued();
          if (added > 0) {
            await this.flushPersist();
            continue;
          }
        }
        this.acceptingQueuedInput = false;
        yield { type: "done", usage: this.cumulative, turns: turn };
        return;
      }

      const { results, images } = yield* this.runTools(calls, signal);
      // tool_result 必须在前（Anthropic 的硬性要求），工具附带的图片紧随其后。
      this.history.push({ role: "user", content: [...results, ...images] });
      await this.flushPersist();
      if (signal.aborted) {
        this.acceptingQueuedInput = false;
        yield { type: "error", message: "会话已中断" };
        return;
      }
      // 工具轮之后是注入 steering 的天然边界
      if (this.queued.length > 0) {
        const added = yield* this.drainQueued();
        if (added > 0) await this.flushPersist();
      }
    }

    while (this.queued.length > 0) {
      yield* this.drainQueued();
      await this.flushPersist();
    }
    this.acceptingQueuedInput = false;
    yield { type: "error", message: `达到最大轮数 ${this.maxTurns}，已停止` };
  }

  private *pushUser(
    text: string,
    queued: boolean,
    additionalContext?: string,
  ): Generator<AgentEvent> {
    this.history.push({
      role: "user",
      content: [
        { type: "text", text },
        ...(additionalContext
          ? [{ type: "text" as const, text: reminder(additionalContext).trim(), internal: true }]
          : []),
      ],
    });
    yield { type: "user_message", text, queued };
  }

  private pushInternalUser(text: string): void {
    this.history.push({ role: "user", content: [{ type: "text", text, internal: true }] });
  }

  private async prepareUserInput(
    text: string,
  ): Promise<{ blocked: false; additionalContext?: string } | { blocked: true; reason: string }> {
    if (!this.hooks.has("UserPromptSubmit")) return { blocked: false };
    const h = await this.hooks.run({ event: "UserPromptSubmit", cwd: this.cwd, prompt: text });
    if (h.blocked) return { blocked: true, reason: h.reason ?? "被 UserPromptSubmit hook 拦截" };
    return {
      blocked: false,
      ...(h.additionalContext ? { additionalContext: h.additionalContext } : {}),
    };
  }

  private async *drainQueued(): AsyncGenerator<AgentEvent, number> {
    let added = 0;
    while (this.queued.length > 0) {
      const text = this.queued.shift()!;
      const prepared = await this.prepareUserInput(text);
      if (prepared.blocked) {
        yield { type: "error", message: `排队输入被 hook 拦截: ${prepared.reason}` };
        continue;
      }
      yield* this.pushUser(text, true, prepared.additionalContext);
      added++;
    }
    return added;
  }

  // ---------- 模型轮（含瞬时错误重试） ----------

  private async *runModelTurn(signal: AbortSignal): AsyncGenerator<AgentEvent, TurnOutcome> {
    for (let attempt = 0; ; attempt++) {
      const res = yield* this.streamOnce(signal);
      if (res.type === "ok") return res;
      const retriable =
        this.retry !== null &&
        attempt < this.retry.maxRetries &&
        !signal.aborted &&
        isTransientError(res.cause);
      if (!retriable) {
        // 即使不再重试，消费者也必须清掉未进入 Agent history 的流式残影。
        if (res.partial) yield { type: "turn_reset" };
        return res;
      }
      if (res.partial) yield { type: "turn_reset" };
      const backoff = Math.round(
        this.retry!.baseDelayMs * 2 ** attempt * (1 + Math.random() * 0.25),
      );
      // 服务端给了 Retry-After 就尊重它（取与退避的较大值，封顶 60s 防呆滞）。
      const serverHint = retryAfterMs(res.cause);
      const delayMs =
        serverHint !== null ? Math.min(60_000, Math.max(backoff, serverHint)) : backoff;
      yield { type: "retry", attempt: attempt + 1, delayMs, reason: res.message };
      try {
        await sleep(delayMs, signal);
      } catch {
        return res; // 等待期间被中断
      }
    }
  }

  /** 跑一次模型补全，把流式增量转成 AgentEvent，聚合出最终消息 */
  private async *streamOnce(signal: AbortSignal): AsyncGenerator<AgentEvent, TurnOutcome> {
    let finalMessage: ChatMessage | null = null;
    let stopReason = "";
    let usage: Usage = emptyUsage();
    let partial = false;
    const toolNames = new Map<string, string>(); // 流式期间 id → 工具名

    try {
      for await (const ev of this.provider.stream({
        model: this.model,
        system: this.system,
        messages: this.history,
        ...(this.supportsTools ? { tools: this.tools.definitions() } : {}),
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        signal,
      })) {
        if (ev.type === "text_delta") {
          partial = true;
          yield { type: "text", text: ev.text };
        } else if (ev.type === "thinking_delta") {
          partial = true;
          yield { type: "thinking", text: ev.text };
        } else if (ev.type === "tool_call_start") {
          partial = true;
          toolNames.set(ev.id, ev.name);
        } else if (ev.type === "tool_call_delta") {
          partial = true;
          yield {
            type: "tool_input_delta",
            id: ev.id,
            name: toolNames.get(ev.id) ?? "",
            delta: ev.argsText,
          };
        } else if (ev.type === "done") {
          finalMessage = ev.message;
          stopReason = ev.stopReason;
          usage = ev.usage;
        }
      }
    } catch (err) {
      return { type: "error", message: errText(err), cause: err, partial };
    }
    if (!finalMessage) {
      return { type: "error", message: "provider 未产出 done 事件", partial };
    }
    return { type: "ok", message: finalMessage, stopReason, usage };
  }

  // ---------- 工具执行 ----------

  /**
   * 执行一轮工具调用：连续的只读调用组成一批并行执行（互不阻塞），
   * 副作用调用按序串行（保证写操作的可预测顺序）。
   * results 始终按 calls 原顺序排列 —— 与模型发起顺序一致。
   */
  private async *runTools(
    calls: ToolCall[],
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent, { results: ToolResultPart[]; images: ImagePart[] }> {
    const results: ToolResultPart[] = [];
    // 工具附带的图片单独收集：它们必须排在本轮全部 tool_result 之后
    // （Anthropic 要求 tool_result 块位于 user 消息开头）。
    const images: ImagePart[] = [];
    let i = 0;
    while (i < calls.length) {
      if (!this.isParallelSafe(calls[i]!)) {
        yield* this.runToolSafe(calls[i]!, signal, results, images);
        i++;
        continue;
      }
      const batch: ToolCall[] = [calls[i]!];
      while (i + batch.length < calls.length && this.isParallelSafe(calls[i + batch.length]!)) {
        batch.push(calls[i + batch.length]!);
      }
      i += batch.length;
      if (batch.length === 1) yield* this.runToolSafe(batch[0]!, signal, results, images);
      else yield* this.runToolBatch(batch, signal, results, images);
    }
    return { results, images };
  }

  /**
   * 并发资格按调用判定。前提：入参不会在准备阶段被改写（无 PreToolUse / 无 ask-confirm）。
   * 满足后：有 isConcurrencySafe 的以它为准（如 task 只对只读子 agent 类型返回 true，
   * 从而让多个只读调研子 agent 并行 fan-out）；否则回落到静态 readOnly 契约。
   */
  private isParallelSafe(call: ToolCall): boolean {
    const tool = this.tools.get(call.name);
    if (!tool || !this.parallelInputsStable) return false;
    if (tool.isConcurrencySafe) {
      try {
        return tool.isConcurrencySafe(call.args);
      } catch {
        return false;
      }
    }
    return tool.readOnly;
  }

  /** 并行批：各调用独立产生事件（经 Chan 汇成单流），结果按原调用顺序落位 */
  private async *runToolBatch(
    batch: ToolCall[],
    signal: AbortSignal,
    results: ToolResultPart[],
    images: ImagePart[],
  ): AsyncGenerator<AgentEvent> {
    const chan = new Chan<AgentEvent>();
    const slots: (ToolResultPart | null)[] = new Array(batch.length).fill(null);
    // 图片也按调用顺序落位，避免并行完成顺序带来的不确定性。
    const imageSlots: ImagePart[][] = batch.map(() => []);
    const runs = batch.map(async (call, idx) => {
      const local: ToolResultPart[] = [];
      try {
        for await (const ev of this.runToolSafe(call, signal, local, imageSlots[idx]!)) {
          chan.push(ev);
        }
      } catch (err) {
        // runToolSafe 已是兜底；这里再守一层，确保任何未来改动都不会漏配对结果。
        const msg = `工具执行异常: ${errText(err)}`;
        local.push(errResult(call.id, call.name, msg));
        chan.push({
          type: "tool_result",
          id: call.id,
          name: call.name,
          content: msg,
          isError: true,
        });
      }
      if (!local[0]) {
        const msg = "工具未返回结果";
        local.push(errResult(call.id, call.name, msg));
        chan.push({
          type: "tool_result",
          id: call.id,
          name: call.name,
          content: msg,
          isError: true,
        });
      }
      slots[idx] = local[0]!;
    });
    void Promise.allSettled(runs).then(() => chan.close());
    for await (const ev of chan) yield ev;
    for (const slot of slots) results.push(slot!);
    for (const slot of imageSlots) images.push(...slot);
  }

  /** 无论自定义 ruleKey/权限回调/工具实现怎样抛错，都合成合法的 tool_result。 */
  private async *runToolSafe(
    call: ToolCall,
    signal: AbortSignal,
    results: ToolResultPart[],
    images: ImagePart[],
  ): AsyncGenerator<AgentEvent> {
    const before = results.length;
    try {
      yield* this.runTool(call, signal, results, images);
    } catch (err) {
      if (results.length !== before) return;
      const msg = `工具执行异常: ${errText(err)}`;
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
    }
  }

  /** 单个工具：PreToolUse hook → 权限门 → 执行（进度回流）→ PostToolUse hook → 收集结果 */
  private async *runTool(
    call: ToolCall,
    signal: AbortSignal,
    results: ToolResultPart[],
    images: ImagePart[],
  ): AsyncGenerator<AgentEvent> {
    if (signal.aborted) {
      const msg = "会话已中断，工具未执行";
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }
    const tool = this.tools.get(call.name);
    if (!tool) {
      const msg = `未知工具: ${call.name}`;
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    // PreToolUse hook：可拦截 / 改写入参 / 显式放行（跳过权限门）
    let args = call.args;
    let hookAllowed = false;
    let blockedReason: string | null = null;
    let preContext: string | undefined;
    if (this.hooks.has("PreToolUse")) {
      const h = await this.hooks.run({
        event: "PreToolUse",
        cwd: this.cwd,
        toolName: call.name,
        toolInput: args,
      });
      if (h.blocked) blockedReason = h.reason ?? "被 PreToolUse hook 拦截";
      if (h.updatedInput) args = h.updatedInput;
      hookAllowed = h.allowed;
      preContext = h.additionalContext;
    }

    const ruleKey = tool.ruleKey(args);
    yield { type: "tool_start", id: call.id, name: call.name, ruleKey };

    if (blockedReason) {
      const msg = `PreToolUse hook 拦截: ${blockedReason}`;
      yield { type: "tool_permission", id: call.id, name: call.name, decision: "deny" };
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    // hook 的 allow 也进权限门 —— 它跳过 mode/confirm，但压不过 deny/ask 规则
    let decision: PermissionDecision = await this.perm.check({
      toolName: call.name,
      input: args,
      ruleKey,
      ...(tool.ruleParts ? { ruleParts: tool.ruleParts(args) } : {}),
      ...(tool.rulePartsComplete ? { rulePartsComplete: tool.rulePartsComplete(args) } : {}),
      ...(hookAllowed ? { hookAllowed } : {}),
      toolCallId: call.id,
      signal,
    });

    // confirm 可以收窄/改写参数，但确认针对的是原动作。最终动作必须重新经过
    // deny/ask 不可绕过层，不能借 updatedInput 把安全请求换成被禁请求。
    if (decision.behavior === "allow" && decision.updatedInput) {
      const updated = decision.updatedInput;
      const updatedRuleKey = tool.ruleKey(updated);
      decision = this.perm.validateUpdatedInput({
        toolName: call.name,
        input: updated,
        ruleKey: updatedRuleKey,
        ...(tool.ruleParts ? { ruleParts: tool.ruleParts(updated) } : {}),
        ...(tool.rulePartsComplete ? { rulePartsComplete: tool.rulePartsComplete(updated) } : {}),
        toolCallId: call.id,
        signal,
      });
      if (decision.behavior === "allow") decision = { ...decision, updatedInput: updated };
    }
    yield { type: "tool_permission", id: call.id, name: call.name, decision: decision.behavior };

    if (decision.behavior === "deny") {
      const msg = decision.message ?? "用户拒绝了该操作";
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    if (signal.aborted) {
      const msg = "会话已中断，工具未执行";
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    // 执行：进度经 Chan 实时回流（子 agent 事件、长任务心跳）
    const input = decision.updatedInput ?? args;
    const chan = new Chan<AgentEvent>();
    // 工具经 attachImage 附带的图片先收在本地；只有工具成功时才并入历史。
    const localImages: ImagePart[] = [];
    const settled = tool
      .run(input, {
        cwd: this.cwd,
        signal,
        ...(this.sandbox ? { sandbox: this.sandbox } : {}),
        modelSupportsImages: this.supportsImages,
        attachImage: (img) => localImages.push(img),
        emit: (progress) =>
          chan.push({ type: "tool_progress", id: call.id, name: call.name, event: progress }),
        addUsage: (usage) => this.accumulate(usage),
      })
      .then(
        (content) => ({ ok: true as const, content }),
        (err: unknown) => ({ ok: false as const, err }),
      )
      .finally(() => chan.close());
    for await (const ev of chan) yield ev;
    const r = await settled;

    const isError = !r.ok;
    let content = truncateToolResult(
      r.ok ? r.content : r.err instanceof ToolError ? r.err.message : errText(r.err),
      this.maxToolResultChars,
    );
    if (preContext) content += reminder(preContext);
    // PostToolUse 对成功和失败都执行；反馈（含 block reason）回传给模型。
    if (this.hooks.has("PostToolUse")) {
      const h = await this.hooks.run({
        event: "PostToolUse",
        cwd: this.cwd,
        toolName: call.name,
        toolInput: input,
        toolResult: content,
        isError,
      });
      const feedback = h.blocked ? h.reason : h.additionalContext;
      if (feedback) content += reminder(feedback);
    }
    const result: ToolResultPart = {
      type: "tool_result",
      toolCallId: call.id,
      toolName: call.name,
      content,
      ...(isError ? { isError: true } : {}),
    };
    results.push(result);
    // 图片附在本轮 tool_result 之后进入同一条 user 消息（由 runTools 汇总后排序）。
    // 工具失败时丢弃：错误结果配一堆图片只会白烧上下文。
    if (!isError && localImages.length) images.push(...localImages);
    yield { type: "tool_result", id: call.id, name: call.name, content, isError };
  }

  // ---------- 内部工具方法 ----------

  private resolveCompaction(
    cfg: AgentOptions["compaction"],
    modelInfo: AgentModelInfo | undefined,
  ): CompactionConfig | null {
    if (!cfg) return null;
    const defaultSummarizer = providerSummarizer((messages, system) =>
      this.streamText(messages, system),
    );
    const safeTrigger = compactionTrigger(modelInfo, this.maxTokens);
    if (cfg === true) {
      return {
        summarizer: defaultSummarizer,
        ...(safeTrigger !== undefined ? { triggerTokens: safeTrigger } : {}),
      };
    }
    const requestedTrigger = cfg.triggerTokens;
    const triggerTokens =
      safeTrigger === undefined
        ? requestedTrigger
        : requestedTrigger === undefined
          ? safeTrigger
          : Math.min(requestedTrigger, safeTrigger);
    return {
      summarizer: cfg.summarizer ?? defaultSummarizer,
      ...cfg,
      ...(triggerTokens !== undefined ? { triggerTokens } : {}),
    };
  }

  /** 供默认 summarizer 用：优先小模型跑一次纯文本流，小模型出错则回退主模型。 */
  private async *streamText(
    messages: ChatMessage[],
    system: string,
  ): AsyncIterable<{ type: string; text?: string }> {
    const maxTokens = Math.min(2000, this.maxTokens ?? 2000);
    const usingSmall = this.smallProvider !== this.provider || this.smallModelId !== this.model;
    try {
      for await (const ev of this.smallProvider.stream({
        model: this.smallModelId,
        system,
        messages,
        maxTokens,
      })) {
        if (ev.type === "text_delta") yield { type: "text", text: ev.text };
      }
    } catch (err) {
      if (!usingSmall) throw err;
      // 小模型失败（如额度/网络）→ 用主模型重来一次，保证压缩不因杂活模型而失败。
      for await (const ev of this.provider.stream({
        model: this.model,
        system,
        messages,
        maxTokens,
      })) {
        if (ev.type === "text_delta") yield { type: "text", text: ev.text };
      }
    }
  }

  /** 首次 send 前装配静态上下文（项目记忆 + skills 清单）；此后 system 不再变（缓存友好） */
  private async ensureMemory(): Promise<void> {
    if (this.memoryLoaded) return;
    this.memoryLoaded = true;
    const sections: string[] = [];
    // 环境接地：会话开始时快照一次（cwd/OS/日期/git），缓存友好，对齐 Claude Code/Codex。
    if (this.injectEnv) {
      try {
        sections.push(await gatherEnv(this.cwd));
      } catch {
        /* 采集失败不影响主流程 */
      }
    }
    if (this.useProjectMemory) {
      const memory = await loadProjectMemory(this.cwd);
      if (memory) sections.push(memory);
    }
    // Repo map：会话开始时快照一次代码骨架，帮模型少盲 grep（对齐 Aider）。
    if (this.repoMapOpt) {
      try {
        const opts = typeof this.repoMapOpt === "object" ? this.repoMapOpt : {};
        const map = await gatherRepoMap(this.cwd, opts);
        if (map) sections.push(map);
      } catch {
        /* 采集失败不影响主流程 */
      }
    }
    if (this.skillsOpt) {
      const extraDirs = typeof this.skillsOpt === "object" ? (this.skillsOpt.dirs ?? []) : [];
      const skills = await discoverSkills(this.cwd, extraDirs);
      if (skills.length > 0) {
        const skillTool = createSkillTool(skills);
        this.tools.register(skillTool);
        this.perm.addReadOnlyTools([skillTool.def.name]);
        sections.push(skillListPrompt(skills));
      }
    }
    if (sections.length > 0) {
      this.system = composeSystem(this.baseSystem, sections.join("\n\n"));
    }
  }

  private async flushPersist(): Promise<void> {
    if (!this.persist) return;
    for (let i = this.persistedCount; i < this.history.length; i++) {
      await this.persist.store.append(this.persist.meta.id, this.history[i]!);
    }
    this.persistedCount = this.history.length;
  }

  private async rewritePersist(): Promise<void> {
    if (!this.persist) return;
    await this.persist.store.rewrite(this.persist.meta, this.history);
    this.persistedCount = this.history.length;
  }

  private accumulate(u: Usage): void {
    this.cumulative = {
      inputTokens: this.cumulative.inputTokens + u.inputTokens,
      outputTokens: this.cumulative.outputTokens + u.outputTokens,
      cacheReadTokens: this.cumulative.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: this.cumulative.cacheWriteTokens + u.cacheWriteTokens,
    };
  }
}

// ---------- 模块级辅助 ----------

function errResult(id: string, name: string, msg: string): ToolResultPart {
  return { type: "tool_result", toolCallId: id, toolName: name, content: msg, isError: true };
}

function errText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err);
}

function resolveMaxTokens(
  requested: number | undefined,
  modelInfo: AgentModelInfo | undefined,
): number | undefined {
  const rawLimit = modelInfo?.limits.maxOutputTokens;
  const limit =
    rawLimit !== undefined && Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.floor(rawLimit)
      : undefined;
  if (requested !== undefined) {
    const normalized = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 16_000;
    return limit === undefined ? normalized : Math.min(normalized, limit);
  }
  // 直接构造 Agent 的旧用法保持 16k；经 registry 解析但能力未知的兼容端点则
  // 不强塞一个可能不支持的上限，让端点采用自己的模型默认值。
  if (!modelInfo) return 16_000;
  return limit === undefined ? undefined : Math.min(16_000, limit);
}

function compactionTrigger(
  modelInfo: AgentModelInfo | undefined,
  maxTokens: number | undefined,
): number | undefined {
  const rawContextWindow = modelInfo?.limits.contextWindow;
  if (
    rawContextWindow === undefined ||
    !Number.isFinite(rawContextWindow) ||
    rawContextWindow <= 0
  ) {
    // registry 已解析、但兼容端点没有模型元数据时，不能沿用 120k 的成本默认值：
    // 很多本地/代理模型只有 32k 左右。16k 是运行时保护阈值，不伪装成模型上限；
    // 调用方可通过注册 limits.contextWindow 得到更准确的阈值。
    return modelInfo ? 16_000 : undefined;
  }
  const contextWindow = Math.floor(rawContextWindow);
  // system/tools 也占上下文，而 estimateTokens 当前只统计 messages，因此留 20% 余量，
  // 再扣掉计划输出。仍沿用 120k 成本上限，大窗口模型不会无限积累历史。
  const outputReserve = maxTokens ?? Math.min(4_096, Math.floor(contextWindow * 0.1));
  return Math.min(120_000, Math.max(1_024, Math.floor(contextWindow * 0.8) - outputReserve));
}

/** 包一段注入上下文（对齐 Claude Code 的 system-reminder 惯例，模型学过这个记号） */
function reminder(text: string): string {
  return `\n\n<system-reminder>\n${text}\n</system-reminder>`;
}

/** 超长工具结果截中段（保头 80% + 尾 20%，头尾往往比中段信息密度高） */
function truncateToolResult(content: string, max: number): string {
  if (content.length <= max) return content;
  const head = Math.floor(max * 0.8);
  const tail = max - head;
  return (
    content.slice(0, head) +
    `\n\n…（工具输出共 ${content.length} 字符，超过 ${max} 上限，中段已截断）…\n\n` +
    content.slice(content.length - tail)
  );
}

/** 判定 provider 错误是否值得重试（限流/服务端/网络层；4xx 业务错误不重试） */
function isTransientError(err: unknown): boolean {
  if (err == null) return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") {
    return status === 408 || status === 429 || status >= 500;
  }
  const msg = String((err as { message?: unknown }).message ?? err);
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EPIPE|EAI_AGAIN|fetch failed|network|socket hang up|overloaded|connection error/i.test(
    msg,
  );
}

/**
 * 从 provider 错误里解析 Retry-After（秒数或 HTTP 日期），返回毫秒；无则 null。
 * SDK 错误通常带 headers（Headers 实例或普通对象）。
 */
export function retryAfterMs(err: unknown, now: number = Date.now()): number | null {
  const headers = (err as { headers?: unknown })?.headers;
  if (!headers) return null;
  let raw: string | null = null;
  if (typeof (headers as Headers).get === "function") {
    raw = (headers as Headers).get("retry-after");
  } else if (typeof headers === "object") {
    const rec = headers as Record<string, unknown>;
    const v = rec["retry-after"] ?? rec["Retry-After"];
    if (typeof v === "string") raw = v;
    else if (Array.isArray(v) && typeof v[0] === "string") raw = v[0];
  }
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs >= 0 ? Math.round(secs * 1000) : null;
  const when = Date.parse(raw);
  if (Number.isFinite(when)) return Math.max(0, when - now);
  return null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type { Tool };
