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
import type { ChatMessage, Provider, Usage } from "./types.js";
import { toolCallsOf } from "./types.js";
import {
  BUILTIN_PROFILES,
  PermissionEngine,
  type PermissionConfig,
  type PermissionDecision,
  type PermissionRequest,
  type PermissionMode,
  type PermissionProfile,
} from "./permission.js";
import { ToolRegistry, type Tool } from "./tools/tool.js";
import { ToolExecutor, type ToolExecutionFenceRequest } from "./tool-executor.js";
import { TurnRunner, type ModelCallReservation, type ReserveModelCall } from "./turn-runner.js";
import { SteeringInbox } from "./steering.js";
import { defaultTools } from "./tools/index.js";
import { createWebSearchTool, type WebSearchBackend } from "./tools/web-search.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import { createLspNavTools } from "./tools/lsp-nav.js";
import { createToolSearchTool } from "./tools/tool-search.js";
import { createBrowserTool, type BrowserToolOptions } from "./tools/browser.js";
import type { LspPool } from "./lsp.js";
import { HookRunner, type HookRegistration } from "./hooks.js";
import {
  createTaskTools,
  TaskRegistry,
  type PersistedTaskRecord,
  type SubagentDefinition,
  type TaskRecord,
  type TaskUsageCredit,
} from "./subagent.js";
import { discoverSubagents } from "./agents-fs.js";
import {
  composeSystem,
  maybeCompact,
  compactionPending,
  providerSummarizer,
  type CompactionConfig,
} from "./context.js";
import type { RepoMapOptions } from "./repomap.js";
import {
  ContextAssembler,
  envProvider,
  projectMemoryProvider,
  repoMapProvider,
  skillsProvider,
  browserUsageProvider,
  sessionStartHookProvider,
} from "./context-assembler.js";
import { SnapshotStore } from "./snapshot.js";
import { Conversation, reminder, type PersistenceConfig } from "./conversation.js";
import type { SessionMeta } from "./session.js";
import type { WorktreeOwnership } from "./runtime/worker.js";
import type { NetworkProxy } from "./runtime/network-proxy.js";
import { ContextCompiler, type ContextSource } from "./runtime/context-compiler.js";
import { Verifier, renderVerificationReport, type VerificationReport } from "./runtime/verifier.js";
import { noTelemetry, type SpanContext, type Telemetry } from "./runtime/telemetry.js";
import type { SecurityPolicyEngine } from "./security/policy.js";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";

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
  // 主模型持续失败，已切换到降级链中的下一个模型（本次 drive 内生效）
  | { type: "model_fallback"; from: string; to: string; reason: string }
  | { type: "turn_reset" } // 一次流式尝试失败（重试或终止）；消费者应丢弃该尝试的残留增量
  | { type: "retry"; attempt: number; delayMs: number; reason: string } // provider 瞬时错误，退避重试中
  | { type: "compacted"; beforeTokens: number; afterTokens: number } // 上下文被压缩
  // 本轮开始前的工作区快照（供 undo/rewind）；messageCount = 本轮用户输入进入历史前的消息数
  | { type: "checkpoint"; id: string; tree: string; label: string; messageCount: number }
  | { type: "verification"; report: VerificationReport }
  // 后台子 agent 任务完成通知已注入历史（模型将在下一轮看到并处理）
  | { type: "task_notice"; text: string }
  // 整个 loop 结束，等待下一条用户输入；costUSD 为会话累计成本估算（模型无价格信息时缺省）
  | { type: "done"; usage: Usage; turns: number; costUSD?: number }
  | { type: "error"; message: string };

export interface RetryConfig {
  /** 瞬时错误（429/5xx/网络）最大重试次数，默认 3 */
  maxRetries?: number;
  /** 首次退避毫秒数（指数递增 + 抖动），默认 500 */
  baseDelayMs?: number;
}

/**
 * 一次 send/drive 的硬执行预算。所有值都是单次用户任务维度，不会把历史会话已经
 * 消耗的额度重复计算。预算同时约束模型轮、子 agent 汇入的用量和工具执行。
 */
export interface RunBudgetConfig {
  /** 单次任务最大墙钟时间，默认 30 分钟。 */
  maxWallTimeMs?: number;
  /** 单次任务输入+输出+缓存 token 总量，默认 1,000,000。 */
  maxTotalTokens?: number;
  /** 已知模型价格时的单次任务成本上限（美元），默认 25。 */
  maxCostUSD?: number;
  /** 单次任务最多执行的工具调用数，默认 500。 */
  maxToolCalls?: number;
  /** 同一批只读工具的最大并发，默认 8。 */
  maxConcurrentTools?: number;
  /** 单个工具的统一执行超时，默认 10 分钟。 */
  toolTimeoutMs?: number;
}

/** Durable, monotonic checkpoint for one logical root command across process recovery. */
export interface RunBudgetSnapshot {
  version: 1;
  revision: number;
  startedAt: number;
  chargedUsage: Usage;
  chargedCostUSD: number;
  reservedTokens: number;
  reservedCostUSD: number;
  toolCalls: number;
  /** Persisted hard-stop cause; recovery must never reopen a terminal logical command. */
  terminalReason?: string;
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
  /** 单价（$/MTok，registry 内置价格表命中时填充）；用于会话成本估算展示。 */
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
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
  /**
   * 启用 task 工具（子 agent 委派）。true=仅内置 general 类型；数组=追加自定义类型；
   * 对象形态可再开 discover：首次 send 时扫描 .claude/agents/*.md（用户级+项目级
   * + .anicode/agents，对齐 Claude Code 的文件系统 agents），文件定义排在
   * definitions 之前（程序化定义同名覆盖文件定义）。
   */
  subagents?:
    | boolean
    | SubagentDefinition[]
    | {
        definitions?: SubagentDefinition[];
        discover?: boolean;
        dirs?: string[];
        /** Defaults to true. Set false until Workspace Trust has been granted. */
        includeProject?: boolean;
      };
  /**
   * 启用 skills 渐进加载：扫描 .claude/skills（项目级+用户级）与全局技能根，
   * 清单注入 system 提示（L1），正文经 skill 工具按需加载（L2）。
   * 传对象可追加扫描目录（dirs）或按名排除技能（disabled，供 UI 开关）。默认关。
   */
  skills?: boolean | { dirs?: string[]; disabled?: string[]; includeProject?: boolean };
  /**
   * 后台子 agent 任务在 Agent 空闲时完成的通知出口：宿主（如 SessionManager）
   * 用它自动发起一次 drive 把通知交给模型处理。不设时通知积压在 Agent 内部，
   * 下一次 send 开始时注入。运行中完成的通知不走此回调（直接在 turn 边界注入）。
   */
  onTaskNotice?: (text: string) => void;
  /** Child-agent transcript used only when explicitly resuming a durable subagent. */
  initialMessages?: ChatMessage[];
  /** Child-agent cumulative usage restored with initialMessages. Internal subagent resume input. */
  initialUsage?: Usage;
  /** Durable background-task checkpoints recovered by SessionManager. */
  recoveredTasks?: PersistedTaskRecord[];
  /** Called whenever a task reaches a new durable checkpoint. */
  onTaskState?: (record: PersistedTaskRecord) => void;
  /** Called once when the in-memory task cap evicts a terminal task; host removes its artifacts. */
  onTaskEvicted?: (taskId: string) => void;
  /** Durable root-usage credit emitted exactly once after each subagent run is accumulated. */
  onTaskUsageCredited?: (credit: TaskUsageCredit) => void | Promise<void>;
  /** Durable command ownership gate checked at the final boundary before side-effecting tools. */
  beforeToolExecution?: (request: ToolExecutionFenceRequest) => void | Promise<void>;
  /**
   * Internal mandatory fence layered after the command-bound/fallback fence. Worktree subagents
   * use it for their exact lease generation; hosts should use beforeToolExecution instead.
   */
  internalBeforeToolExecution?: (request: ToolExecutionFenceRequest) => void | Promise<void>;
  maxTurns?: number;
  maxTokens?: number;
  /** 单次用户任务的统一墙钟/token/成本/工具预算。 */
  runBudget?: RunBudgetConfig;
  /** Persist each budget mutation before its associated provider/tool side effect proceeds. */
  onRunBudgetCheckpoint?: (snapshot: RunBudgetSnapshot) => void | Promise<void>;
  /**
   * 便宜快速模型 spec（`provider/model`），用于压缩摘要等杂活（对齐 Claude Code
   * 「大量调用走小模型」的成本策略）。需要 resolveModel 才能实例化；解析失败静默回退主模型。
   */
  smallModel?: string;
  /**
   * 模型降级链（对齐 Claude Code fallbackModel）：主模型在重试仍失败（限流/过载/
   * 服务故障）时按序切换到这些模型继续本次 drive；下一次 drive 仍从主模型开始。
   * 需要 resolveModel。每个 spec 为 `provider/model` 或裸 model id（沿用当前 provider 解析）。
   */
  fallbackModels?: string[];
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
  /** 子 agent worktree 的跨 worker 独占租约。 */
  worktreeOwnership?: WorktreeOwnership;
  networkProxy?: NetworkProxy;
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
  /**
   * 启用 browser 工具：headless 打开 URL 做前端验证（console 错误/异常/失败请求/截图）。
   * 传入 BrowserToolOptions（可指定浏览器路径/视口）即注册；true 表示用默认自动探测。
   * 不传则不注册该工具。只读，注册后自动放行、无需逐次授权。
   */
  browser?: BrowserToolOptions | boolean;
  /** 上下文压缩配置。传入即启用；summarizer 缺省用当前 provider 自摘要 */
  compaction?: Partial<CompactionConfig> | boolean;
  /** 会话持久化 */
  persistence?: PersistenceConfig;
  /** 有预算、可追溯的上下文装配器；默认 12k token 静态上下文预算。 */
  contextCompiler?: ContextCompiler;
  /** 代码改动后、宣告完成前运行确定性检查；失败结果回灌模型继续修复。 */
  verifier?: Verifier;
  /** 单次 drive 最多自动验证/返修次数，默认 2。 */
  verificationMaxAttempts?: number;
  /** 权限确认之上的确定性硬策略；deny 不能被 hook/bypass/用户确认覆盖。 */
  securityPolicy?: SecurityPolicyEngine;
  /** 可注入真实 OpenTelemetry tracer 的窄接口。 */
  telemetry?: Telemetry;
  isolatedRuntime?: ExecutionRuntime;
}

// 历史值对象及其伴生类型迁至 conversation.ts（架构 v2）；此处 re-export 保持既有 import 路径。
export { repairHistory, type PersistenceConfig } from "./conversation.js";

/** Agent 的可序列化状态快照 —— 供晚加入的订阅者 / resume 渲染重建界面 */
export interface AgentSnapshot {
  messages: ChatMessage[];
  usage: Usage;
}

/** 默认系统提示词，按当前界面语言取词（在 Agent 构造时求值，故 /lang 后新建会话即生效）。 */
export function defaultSystem(): string {
  return t(
    `You are AniCode, a general-purpose AI agent running in the user's terminal. Help with research, analysis, writing, planning, data work, everyday knowledge tasks, operations, and software engineering. Programming and repository work are core strengths, but never assume a task is about code unless the user's goal or context calls for it.

# How you work
- Identify the user's actual outcome before choosing a workflow. Match their language, requested depth, format, and constraints.
- Start with substantive help. Do not introduce answers with an identity label, a capability disclaimer, or an "as a ..." preamble unless the user explicitly asks about identity or limitations.
- Treat non-code work as first-class. Do not inspect or modify a repository merely because a working directory exists; use workspace tools only when they materially help the requested task.
- For research or time-sensitive factual work, use web_search/webfetch when available, cross-check important claims, distinguish evidence from inference, and include useful source links.
- For writing, planning, summarization, and analysis, optimize for the requested audience and deliverable instead of forcing an engineering workflow.
- When a task involves several uncertain steps, use todo_write to lay out a checklist and update it as you go, so the user sees the plan.
- For broad search across many files, cross-file investigation, or several independent subtasks, delegate them with the task tool instead of doing it all yourself — the subagent's intermediate steps don't consume your context; you get back only its conclusion.
- Pure read-only investigations (the explore type) are side-effect-free and parallelizable: dispatch several in one turn to fan out, then synthesize. Use explore for search/read-to-conclusion, general for subtasks that must edit files or run commands.
- When you hit a fork you can't settle on your own (destructive, ambiguous, or several reasonable approaches), stop and ask the user rather than betting on one.

# Using tools
- Choose tools from the task, not from a fixed coding routine. Prefer purpose-built search, document, browser, data, or workspace tools when available.
- For workspace search, prefer grep / glob / read. Edit files with edit / write; don't rewrite source via shell redirection (echo >> / sed -i).
- Reserve bash for commands that genuinely need a shell, such as builds, tests, git, package management, and system inspection.
- For anything long-running or that never exits on its own (dev servers, watch builds, tailing logs), use bash with run_in_background instead of blocking until timeout; then read its output with bash_output and stop it with kill_shell when done.
- Send multiple independent read-only calls (reading a few files, running a few searches) together in one turn so they run in parallel, rather than one at a time.

# Software-engineering strength
- Before changing code, inspect the relevant implementation, tests, architecture, and local conventions; don't edit on a guess.
- Keep changes precise and scoped; avoid unrelated refactors. Match nearby naming, style, and idioms, and don't add dependencies without checking the project first.
- Preserve user changes in a dirty worktree. Don't commit or push (git commit/push) unless the user explicitly asks.

# Verification and wrap-up
- After changing code, if the project has tests / type-checking / lint, try to run them to confirm you didn't break anything; if you can't, say so honestly.
- Don't misreport completion: if tests fail, say so with the output; if you skipped a step, say you skipped it. Only state it's done plainly when it truly is and you've verified it.
- Wrap up in a sentence or two about what you did — terminal-facing, concise, no long recap.

# Safety
- Operations with side effects (writing files, running commands) go through user authorization; when denied, switch approach or ask — don't work around it.
- Assist with defensive security and normal engineering work within authorization; refuse requests clearly meant to damage, attack, or evade detection.`,
    `你是 AniCode，一个运行在用户终端中的通用型 AI Agent。你可以处理调研、分析、写作、规划、数据处理、日常知识工作、运维和软件工程。编程与仓库工程是核心强项，但只有在用户目标或上下文确实涉及时，才把任务按代码工作处理。

# 工作方式
- 先确认用户真正要的结果，再选择工作流；跟随用户的语言、深度、格式和约束。
- 直接进入实质内容。除非用户明确询问身份或限制，不要用身份标签、能力声明或“作为……”式前言开场。
- 把非代码任务当作一等任务。不要仅因存在工作目录就检查或修改仓库；只在对当前目标有实质帮助或用户明确要求时使用工作区工具。
- 处理调研或时效性事实时，若 web_search/webfetch 可用就用它们查证；交叉核对重要结论，区分证据与推断，并给出有用的来源链接。
- 处理写作、规划、摘要和分析时，围绕受众和交付物组织结果，不要强行套用工程流程。
- 一次任务涉及多个不确定步骤时，用 todo_write 列清单并随进度更新，让用户看到规划。
- 遇到大范围检索、跨多文件调研、或多个互相独立的子任务时，用 task 工具委派给子 agent，别全都自己串着做 —— 子 agent 的中间步骤不占你的上下文，只回传结论。
- 纯只读的调研（explore 类型）无副作用、可并行：在同一轮里一次派出多个 fan-out，再汇总。搜索/读代码得结论用 explore，需要改文件或跑命令的子任务用 general。
- 遇到无法自行判断的分叉（有破坏性、需求含糊、多种合理方案）时，停下来问用户，而不是赌一个。

# 工具使用
- 从任务出发选工具，不要固定套用代码流程；有专用的搜索、文档、浏览器、数据或工作区工具时优先使用。
- 搜索工作区时优先用 grep / glob / read；修改文件用 edit / write，避免用 shell 重定向改源码。
- bash 留给真正需要 shell 的命令，如构建、测试、git、包管理和系统检查。
- 长时间运行或不会自己结束的命令（dev server、watch 构建、日志跟随）用 bash 的 run_in_background，别阻塞到超时；之后用 bash_output 读输出，用完 kill_shell 停掉。
- 多个相互独立的只读调用（读几个文件、跑几处搜索）请在同一轮里一起发出，让它们并行执行，别一个个串着来。

# 软件工程强项
- 修改代码前先了解相关实现、测试、架构和本地约定，不要凭猜测改动。
- 改动保持精确、聚焦，避免无关重构；匹配附近代码的命名、风格与惯用法，引入依赖前先检查项目现状。
- 在脏工作区中保留用户的改动。除非用户明确要求，不要提交或推送。

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
const DEFAULT_RUN_BUDGET: Required<RunBudgetConfig> = {
  maxWallTimeMs: 30 * 60_000,
  maxTotalTokens: 1_000_000,
  maxCostUSD: 25,
  maxToolCalls: 500,
  maxConcurrentTools: 8,
  toolTimeoutMs: 10 * 60_000,
};

export class Agent {
  /** 模型轮执行（架构 v2：provider 流 + 重试 + 降级链 + active 模型状态）。 */
  private readonly runner: TurnRunner;
  private readonly resolveModelFn?: (spec: string) => AgentResolvedModel;
  private readonly cwd: string;
  private readonly baseSystem: string;
  private readonly tools: ToolRegistry;
  private readonly perm: PermissionEngine;
  private readonly permissionProfiles: Record<string, PermissionProfile>;
  private readonly hooks: HookRunner;
  private readonly maxTurns: number;
  private readonly maxTokens: number | undefined;
  private readonly runBudget: Required<RunBudgetConfig>;
  private readonly requireKnownModelCost: boolean;
  private readonly worktreeOwnership?: WorktreeOwnership;
  private readonly networkProxy?: NetworkProxy;
  private readonly snapshots: SnapshotStore | null;
  private readonly sandbox: AgentOptions["sandbox"];
  /** 静态上下文装配管线（架构 v2）：env / 项目记忆 / repo map / skills / browser 指引。 */
  private readonly assembler: ContextAssembler;
  /** SessionStart hook 段 —— 装配的最后一步（在 subagent 发现之后跑）。 */
  private readonly postAssembler: ContextAssembler;
  /** 归一化后的 subagents 选项；discover=true 时 task 工具推迟到首次 send 注册。 */
  private subagentsOpt: {
    definitions: SubagentDefinition[];
    discover: boolean;
    dirs: string[];
    includeProject: boolean;
  } | null = null;
  private readonly modelInfoOpt: AgentModelInfo | undefined;
  private readonly permissionOpt: PermissionConfig | undefined;
  private readonly hooksOpt: HookRegistration[];
  private readonly compaction: CompactionConfig | null;
  private readonly contextCompiler: ContextCompiler;
  private readonly verifier: Verifier | null;
  private readonly verificationMaxAttempts: number;
  private readonly securityPolicy?: SecurityPolicyEngine;
  private readonly telemetry: Telemetry;
  private readonly isolatedRuntime?: ExecutionRuntime;
  /** 当前 drive 的父上下文；工具/MCP/Remote/子 agent 从此继续同一 trace。 */
  private traceParent: SpanContext | undefined;

  private system: string;
  private memoryLoaded = false;
  /** 会话历史 + 持久化 + 记账（架构 v2：唯一能改写历史的对象）。 */
  private readonly conv: Conversation;
  private running = false; // 并发护栏：send 不可重入
  /** steering 输入 + 任务通知的接收窗口与队列（架构 v2：显式状态机）。 */
  private readonly inbox: SteeringInbox;
  /** 工具执行调度（架构 v2：并行批 + 权限门 + Pre/PostToolUse hook）。 */
  private readonly executor: ToolExecutor;
  /** 当前 drive 在整棵 agent tree 的共享预算 scope；工具内部模型用量也经此计入。 */
  private activeBudget: DriveBudget | null = null;
  /** 后台子 agent 任务注册表（启用 subagents 后由 registerTaskTool 填充）。 */
  private taskRegistry: TaskRegistry | null = null;
  private readonly onTaskUsageCredited?: (credit: TaskUsageCredit) => void | Promise<void>;
  private readonly beforeToolExecution?: (
    request: ToolExecutionFenceRequest,
  ) => void | Promise<void>;
  private readonly internalBeforeToolExecution?: (
    request: ToolExecutionFenceRequest,
  ) => void | Promise<void>;
  private readonly onRunBudgetCheckpoint?: (snapshot: RunBudgetSnapshot) => void | Promise<void>;
  private changedSinceVerification = false;
  private readonly changedFiles = new Set<string>();

  constructor(opts: AgentOptions) {
    if (opts.resolveModel) this.resolveModelFn = opts.resolveModel;
    // 小模型：解析失败（拼写/缺凭证）就静默回退主模型，绝不因杂活模型而拖垮主流程。
    let smallProvider = opts.provider;
    let smallModelId = opts.model;
    let smallModelCost = opts.modelInfo?.cost;
    if (opts.smallModel && opts.resolveModel) {
      try {
        const r = opts.resolveModel(opts.smallModel);
        smallProvider = r.provider;
        smallModelId = r.model;
        smallModelCost = r.modelInfo?.cost;
      } catch {
        /* 回退主模型 */
      }
    }
    this.cwd = opts.cwd;
    this.baseSystem = opts.system ?? defaultSystem();
    this.system = this.baseSystem;
    // Agent 拥有自己的 registry，避免启用 task/skill 时污染调用方复用的集合，
    // 也借 Tool.fork() 隔离 todo 等闭包状态。
    this.tools = opts.tools?.clone() ?? defaultTools();
    this.hooks = new HookRunner(opts.hooks ?? [], () => this.markWorkspaceDirty());
    this.maxTurns = opts.maxTurns ?? 50;
    this.maxTokens = resolveMaxTokens(opts.maxTokens, opts.modelInfo);
    this.runBudget = normalizeRunBudget(opts.runBudget);
    this.requireKnownModelCost = opts.runBudget?.maxCostUSD !== undefined;
    const effort = opts.modelInfo?.capabilities.reasoning === false ? undefined : opts.effort;
    const maxResult = opts.maxToolResultChars ?? 30_000;
    const maxToolResultChars = Number.isFinite(maxResult) ? Math.max(256, maxResult) : 30_000;
    const retry =
      opts.retry === false
        ? null
        : {
            maxRetries: Math.max(0, Math.floor(opts.retry?.maxRetries ?? DEFAULT_MAX_RETRIES)),
            baseDelayMs: Math.max(0, opts.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS),
          };
    this.telemetry = opts.telemetry ?? noTelemetry;
    // 模型轮执行器（架构 v2）：provider 流 + 重试 + 降级链 + active 模型状态。
    this.runner = new TurnRunner({
      provider: opts.provider,
      model: opts.model,
      ...(opts.modelInfo ? { modelInfo: opts.modelInfo } : {}),
      ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
      ...(opts.fallbackModels?.length ? { fallbackModels: opts.fallbackModels } : {}),
      retry,
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...(effort ? { effort } : {}),
      small: {
        provider: smallProvider,
        model: smallModelId,
        ...(smallModelCost ? { cost: smallModelCost } : {}),
      },
      telemetry: this.telemetry,
      parent: () => this.traceParent,
    });
    const repoMap = opts.repoMap ?? false;
    const repoMapOpt =
      repoMap && opts.lsp
        ? { ...(typeof repoMap === "object" ? repoMap : {}), lspPool: opts.lsp }
        : repoMap;
    // 静态上下文装配（架构 v2）：provider 顺序 = v1 的 sections.push 顺序（字节稳定）。
    this.assembler = new ContextAssembler([
      ...((opts.injectEnv ?? true) ? [envProvider()] : []),
      ...((opts.projectMemory ?? true) ? [projectMemoryProvider()] : []),
      ...(repoMapOpt ? [repoMapProvider(repoMapOpt)] : []),
      ...(opts.skills ? [skillsProvider(opts.skills)] : []),
      browserUsageProvider(),
    ]);
    this.postAssembler = new ContextAssembler([sessionStartHookProvider(this.hooks)]);
    if (opts.worktreeOwnership) this.worktreeOwnership = opts.worktreeOwnership;
    if (opts.networkProxy) this.networkProxy = opts.networkProxy;
    this.snapshots =
      opts.checkpoints instanceof SnapshotStore
        ? opts.checkpoints
        : opts.checkpoints
          ? new SnapshotStore(this.cwd)
          : null;
    this.sandbox = opts.sandbox;
    this.modelInfoOpt = opts.modelInfo;
    this.permissionOpt = opts.permission;
    this.hooksOpt = opts.hooks ?? [];
    this.inbox = new SteeringInbox(opts.onTaskNotice);
    if (opts.onTaskUsageCredited) this.onTaskUsageCredited = opts.onTaskUsageCredited;
    if (opts.beforeToolExecution) this.beforeToolExecution = opts.beforeToolExecution;
    if (opts.internalBeforeToolExecution) {
      this.internalBeforeToolExecution = opts.internalBeforeToolExecution;
    }
    if (opts.onRunBudgetCheckpoint) this.onRunBudgetCheckpoint = opts.onRunBudgetCheckpoint;
    this.compaction = this.resolveCompaction(opts.compaction, opts.modelInfo);
    this.conv = new Conversation(opts.persistence, opts.initialMessages ?? []);
    if (opts.initialUsage) this.conv.accumulate(normalizeUsage(opts.initialUsage));
    this.contextCompiler = opts.contextCompiler ?? new ContextCompiler();
    this.verifier = opts.verifier ?? null;
    this.verificationMaxAttempts = Math.max(1, Math.floor(opts.verificationMaxAttempts ?? 2));
    if (opts.securityPolicy) this.securityPolicy = opts.securityPolicy;
    if (opts.isolatedRuntime) this.isolatedRuntime = opts.isolatedRuntime;
    // web_search / diagnostics：都是只读工具，在 perm 引擎构建前注册即可自动放行；
    // 也在 task 工具之前注册，好让子 agent（含只读的 explore）一并继承 —— 调研子 agent
    // 能搜网、能自查诊断，正是它们该有的能力。
    if (opts.webSearch) this.tools.register(createWebSearchTool(opts.webSearch));
    if (opts.lsp) {
      this.tools.register(createDiagnosticsTool(opts.lsp));
      for (const navTool of createLspNavTools(opts.lsp)) this.tools.register(navTool);
    }
    // browser：只读的前端验证工具，同样在 perm 引擎构建前注册即自动放行；
    // 子 agent 一并继承（写完代码的验证子 agent 正需要它）。
    if (opts.browser) {
      this.tools.register(createBrowserTool(opts.browser === true ? {} : opts.browser));
    }
    // 有 deferred 工具（大量 MCP 场景）时自动挂上 tool_search 检索入口；
    // 只读，在 perm 引擎构建前注册即自动放行。
    if (this.tools.hasDeferred()) this.tools.register(createToolSearchTool(this.tools));
    // 子 agent 委派：把 task 工具注册进本 agent 的工具集。
    // discover 形态下推迟到首次 send（ensureMemory）：文件系统发现是异步的。
    if (opts.subagents) {
      const sub = opts.subagents;
      const definitions = Array.isArray(sub)
        ? sub
        : typeof sub === "object"
          ? (sub.definitions ?? [])
          : [];
      this.subagentsOpt = {
        definitions,
        discover: typeof sub === "object" && !Array.isArray(sub) && sub.discover === true,
        dirs: (typeof sub === "object" && !Array.isArray(sub) && sub.dirs) || [],
        includeProject:
          typeof sub !== "object" || Array.isArray(sub) || sub.includeProject !== false,
      };
      this.taskRegistry = new TaskRegistry(
        opts.recoveredTasks ?? [],
        opts.onTaskState,
        opts.onTaskEvicted,
      );
      void this.taskRegistry.persistRecoveredNormalization().catch(() => undefined);
      for (const interrupted of this.taskRegistry.interruptedAfterRestart()) {
        this.inbox.holdNotice(
          `<task-notification id="${interrupted.id}">\n后台子 agent 因宿主重启而停止；其耐久上下文已恢复，可用 task_send 继续。\n</task-notification>`,
        );
      }
      if (!this.subagentsOpt.discover) this.registerTaskTool(definitions);
    }
    // PermissionRequest hook：权限门确定要询问用户时先过 hook —— allow 自动批准、
    // block 自动拒绝、无表态则照常弹确认。deny/ask 规则在引擎内更早判定，hook 压不过。
    const baseConfirm = opts.permission?.confirm;
    const confirm =
      baseConfirm &&
      (async (req: PermissionRequest): Promise<PermissionDecision> => {
        if (this.hooks.has("PermissionRequest")) {
          const hook = this.hooks.run({
            event: "PermissionRequest",
            cwd: this.cwd,
            toolName: req.toolName,
            toolInput: req.input,
            ruleKey: req.ruleKey,
            ...(req.signal ? { signal: req.signal } : {}),
          });
          const h = req.signal ? await raceWithSignal(hook, req.signal) : await hook;
          if (req.signal?.aborted) return { behavior: "deny", message: "授权请求已取消" };
          if (h.blocked) {
            return { behavior: "deny", message: h.reason ?? "被 PermissionRequest hook 拒绝" };
          }
          if (h.allowed) return { behavior: "allow" };
        }
        // Notification（观察性）：即将弹授权确认，用户可能不在屏幕前 —— 外接提醒的时机。
        if (this.hooks.has("Notification")) {
          const notification = this.hooks.run({
            event: "Notification",
            cwd: this.cwd,
            notificationType: "permission_request",
            toolName: req.toolName,
            ruleKey: req.ruleKey,
            message: req.ruleKey,
            ...(req.signal ? { signal: req.signal } : {}),
          });
          if (req.signal) await raceWithSignal(notification, req.signal);
          else await notification;
        }
        if (req.signal?.aborted) return { behavior: "deny", message: "授权请求已取消" };
        const decision = Promise.resolve(baseConfirm(req));
        return req.signal ? raceWithSignal(decision, req.signal) : decision;
      });
    // 只读/编辑类工具名并入权限引擎：只读自动放行，编辑类供 acceptEdits 决策
    this.perm = new PermissionEngine({
      ...opts.permission,
      ...(confirm ? { confirm } : {}),
      readOnlyTools: [
        ...(opts.permission?.readOnlyTools ?? []),
        ...this.tools.permissionReadOnlyNames(),
      ],
      editTools: [...(opts.permission?.editTools ?? []), ...this.tools.editNames()],
    });
    this.permissionProfiles = { ...BUILTIN_PROFILES, ...opts.permissionProfiles };
    // 工具执行调度（架构 v2）。并发分组发生在执行前：只要 PreToolUse 或只读
    // ask-confirm 可能改写入参，就保守串行，避免按旧参数判成安全、最终却执行写操作。
    this.executor = new ToolExecutor({
      tools: this.tools,
      perm: this.perm,
      hooks: this.hooks,
      cwd: this.cwd,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
      maxToolResultChars,
      parallelInputsStable:
        !this.hooks.has("PreToolUse") &&
        !(opts.permission?.confirm && (opts.permission.askRules?.length ?? 0) > 0),
      supportsImages: () => this.runner.supportsImages,
      addUsage: (usage) => {
        // Tool implementations are an untrusted accounting boundary. Charge the hard ledger first
        // so malformed/overflowing usage aborts the drive without poisoning Conversation totals.
        this.activeBudget?.addUsage(usage, this.runner.activeModelCost);
        this.conv.accumulate(usage);
      },
      maxConcurrentTools: this.runBudget.maxConcurrentTools,
      toolTimeoutMs: this.runBudget.toolTimeoutMs,
      ...(this.isolatedRuntime ? { isolatedRuntime: this.isolatedRuntime } : {}),
      ...(this.networkProxy ? { networkProxy: this.networkProxy } : {}),
      ...(this.securityPolicy ? { securityPolicy: this.securityPolicy } : {}),
      telemetry: this.telemetry,
      traceParent: () => this.traceParent,
      onFilesChanged: (paths) => {
        for (const changedPath of paths) this.markWorkspaceDirty(changedPath);
      },
      beforeToolExecution: async (request) => {
        // A per-send command lease is captured by the shared tree ledger and replaces the
        // constructor-level host fallback. Mandatory local guards (notably worktree fencing) are
        // always layered last so neither form can bypass them.
        const commandBound = await this.activeBudget?.beforeToolExecution(request);
        if (!commandBound) await this.beforeToolExecution?.(request);
        await this.internalBeforeToolExecution?.(request);
      },
      acquireToolExecutionSlot: (signal) =>
        this.activeBudget?.acquireToolSlot(signal) ?? Promise.resolve(() => undefined),
    });
  }

  /** 把 task 工具注册进本 agent 的工具集（构造期或首次 send 前调用）。 */
  private registerTaskTool(definitions: SubagentDefinition[]): void {
    // 子 agent 继承工具策略/审计 hooks，避免 task 成为绕过父级写入拦截的通道。
    // UserPromptSubmit 与 Stop 属于父会话生命周期，不应用到模型生成的子任务提示。
    const childHooks = this.hooksOpt.filter(
      (hook) => hook.event === "PreToolUse" || hook.event === "PostToolUse",
    );
    const registry = this.taskRegistry ?? new TaskRegistry();
    this.taskRegistry = registry;
    const taskTools = createTaskTools({
      makeAgent: (o) => new Agent(o),
      provider: this.runner.provider,
      model: this.runner.model,
      ...(this.modelInfoOpt ? { modelInfo: this.modelInfoOpt } : {}),
      ...(this.resolveModelFn ? { resolveModel: this.resolveModelFn } : {}),
      cwd: this.cwd,
      tools: this.tools,
      ...(this.sandbox ? { sandbox: this.sandbox } : {}),
      ...(this.isolatedRuntime ? { isolatedRuntime: this.isolatedRuntime } : {}),
      ...(this.securityPolicy ? { securityPolicy: this.securityPolicy } : {}),
      telemetry: this.telemetry,
      ...(this.verifier ? { verifier: this.verifier } : {}),
      contextCompiler: this.contextCompiler,
      runBudget: this.runBudget,
      getRunBudgetLedger: () => this.activeBudget?.ledger,
      recordUsage: (usage) => this.conv.accumulate(usage),
      ...(this.onTaskUsageCredited ? { onTaskUsageCredited: this.onTaskUsageCredited } : {}),
      ...(this.beforeToolExecution ? { beforeToolExecution: this.beforeToolExecution } : {}),
      ...(this.internalBeforeToolExecution
        ? { internalBeforeToolExecution: this.internalBeforeToolExecution }
        : {}),
      ...(this.worktreeOwnership ? { worktreeOwnership: this.worktreeOwnership } : {}),
      ...(this.networkProxy ? { networkProxy: this.networkProxy } : {}),
      ...(this.permissionOpt ? { permission: this.permissionOpt } : {}),
      ...(childHooks.length > 0 ? { hooks: childHooks } : {}),
      // SubagentStart/Stop 属父级生命周期事件，经父 HookRunner 触发（不下发给子 agent）。
      parentHooks: this.hooks,
      ...(definitions.length > 0 ? { definitions } : {}),
      registry,
      notifyTaskDone: (text) => this.deliverTaskNotice(text),
    });
    for (const tool of taskTools.all) this.tools.register(tool);
  }

  /** 后台任务完成通知的三级投递（策略见 SteeringInbox.deliverNotice）。 */
  private deliverTaskNotice(text: string): void {
    this.inbox.deliverNotice(text, this.running);
  }

  private markWorkspaceDirty(path = this.cwd): void {
    this.changedSinceVerification = true;
    this.changedFiles.add(path);
  }

  /** 后台子 agent 任务一览（UI/宿主观测用）。 */
  get backgroundTasks(): readonly TaskRecord[] {
    return this.taskRegistry?.list() ?? [];
  }

  /** 停止全部运行中的后台子 agent 任务（会话销毁/删除时调用）。返回停掉的数量。 */
  stopBackgroundTasks(): number {
    return this.taskRegistry?.stopAll() ?? 0;
  }

  /** 等待后台 runner 完成 finally / usage / durable state checkpoint。 */
  async awaitBackgroundTasksIdle(signal?: AbortSignal): Promise<void> {
    await this.taskRegistry?.awaitIdle(signal);
    await this.conv.whenPersisted(signal);
  }

  /** Wait for all ordered conversation append/rewrite operations. */
  async awaitPersistenceIdle(signal?: AbortSignal): Promise<void> {
    await this.conv.whenPersisted(signal);
  }

  /** Wait for raw tool bodies which may have outlived their timeout/abort result. */
  async awaitToolExecutionsIdle(): Promise<void> {
    await this.executor.awaitIdle();
  }

  /** Close resources owned by this Agent's tool instances after all executions are drained. */
  async closeToolResources(): Promise<void> {
    await this.executor.awaitIdle();
    await this.tools.closeAll();
  }

  /** Serialize a host-requested full rewrite with every Agent append/compaction rewrite. */
  async rewritePersistence(signal?: AbortSignal): Promise<void> {
    await this.conv.rewritePersistence(signal);
  }

  /** Serialize metadata updates (notably auto-title) with the Conversation persistence queue. */
  async updatePersistenceMeta(meta: SessionMeta, signal?: AbortSignal): Promise<void> {
    await this.conv.updatePersistenceMeta(meta, signal);
  }

  // ---------- 只读访问 ----------

  get isRunning(): boolean {
    return this.running;
  }
  get totalUsage(): Usage {
    return this.conv.cumulative;
  }
  /**
   * 会话累计成本估算（美元）。基于主模型单价的近似值：per-prompt 覆盖 / 小模型 /
   * 降级链期间的用量也按主模型价折算。主模型无价格信息时返回 undefined。
   */
  get estimatedCostUSD(): number | undefined {
    return this.conv.estimatedCostUSD(this.modelInfoOpt?.cost);
  }
  get messages(): readonly ChatMessage[] {
    return this.conv.messages;
  }
  /**
   * 当前上下文占用：最近一次 provider 调用的真实输入 token（含 system+tools+缓存），
   * 以及模型上下文窗口（有 modelInfo 时）。未跑过任何轮次时为 null。
   */
  get contextUsage(): { tokens: number; window?: number } | null {
    if (!this.conv.lastInputTokens) return null;
    const window = this.modelInfoOpt?.limits.contextWindow;
    return { tokens: this.conv.lastInputTokens, ...(window ? { window } : {}) };
  }
  snapshot(): AgentSnapshot {
    return { messages: [...this.conv.messages], usage: this.conv.cumulative };
  }
  /** 工作区快照存储（供上层实现 undo）；未启用 checkpoints 时为 null。 */
  get snapshotStore(): SnapshotStore | null {
    return this.snapshots;
  }

  /**
   * 手动压缩（对齐 Claude Code / Codex 的 /compact）：跳过触发线立即压缩一次。
   * 未启用 compaction 或运行中抛错。返回压缩前后 token 规模与是否有实际收缩。
   */
  async compactNow(): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    if (this.running)
      throw new Error(
        t("Session is running; interrupt it before compacting", "会话运行中，请先中断再压缩"),
      );
    if (!this.compaction)
      throw new Error(t("Compaction is not enabled for this session", "该会话未启用上下文压缩"));
    const budget = new RunBudgetLedger(this.runBudget, this.requireKnownModelCost).retain();
    const linked = linkedRunSignal(undefined, budget.signal);
    this.activeBudget = budget;
    try {
      if (this.hooks.has("PreCompact")) {
        await raceWithSignal(
          this.hooks.run({
            event: "PreCompact",
            cwd: this.cwd,
            tokens: this.conv.lastInputTokens,
            signal: linked.signal,
          }),
          linked.signal,
        );
      }
      const res = await raceWithSignal(
        maybeCompact(this.conv.raw(), this.compaction, this.conv.lastInputTokens, {
          force: true,
          signal: linked.signal,
        }),
        linked.signal,
      );
      throwIfAborted(linked.signal);
      if (res.compacted) {
        await this.conv.replaceAll(res.messages, linked.signal);
        if (this.hooks.has("PostCompact")) {
          await raceWithSignal(
            this.hooks.run({
              event: "PostCompact",
              cwd: this.cwd,
              beforeTokens: res.beforeTokens,
              afterTokens: res.afterTokens,
              signal: linked.signal,
            }),
            linked.signal,
          );
        }
      }
      return {
        compacted: res.compacted,
        beforeTokens: res.beforeTokens,
        afterTokens: res.afterTokens,
      };
    } finally {
      this.activeBudget = null;
      linked.dispose();
      // Tool-internal usage checkpoints may have been scheduled from a synchronous callback.
      // Drain them before releasing this drive; a failure has already aborted the ledger.
      await budget.whenCheckpointed(budget.signal).catch(() => undefined);
      budget.dispose();
    }
  }

  /**
   * 对话回滚：把历史截断到前 messageCount 条并重写持久化（对齐 Claude Code /rewind
   * 的「恢复对话」维度；文件恢复由上层用 snapshotStore 完成）。
   * 返回删除的消息数。历史已被压缩到更短时（messageCount 过大）按无操作处理。
   * 运行中调用抛错——不能截断正在被 drive 追加的历史。
   */
  async rewindConversation(messageCount: number): Promise<number> {
    if (this.running)
      throw new Error(
        t("Session is running; interrupt it before rewinding", "会话运行中，请先中断再回滚"),
      );
    return this.conv.rewind(messageCount);
  }

  /** 运行时切换权限模式；下一轮工具授权即按新模式判定。 */
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
    opts?: {
      model?: string;
      resume?: boolean;
      parent?: SpanContext;
      /** Internal: subagents share the root task's bounded tree ledger. */
      budget?: RunBudgetLedger;
      /** Durable state for this exact root command when resuming after a process crash. */
      runBudgetSnapshot?: RunBudgetSnapshot;
      /** Exact durable-command fence captured by this drive and all of its detached children. */
      beforeToolExecution?: (request: ToolExecutionFenceRequest) => void | Promise<void>;
      /** Exact durable-command budget sink captured by this drive and all detached children. */
      onRunBudgetCheckpoint?: (snapshot: RunBudgetSnapshot) => void | Promise<void>;
    },
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
    this.inbox.close();
    const savedTraceParent = this.traceParent;
    this.traceParent = opts?.parent;
    // 降级链每次 drive 重置：上一轮的降级不该让本轮少一个候选。
    this.runner.resetFallbacks();
    const ledger =
      opts?.budget ??
      new RunBudgetLedger(
        this.runBudget,
        this.requireKnownModelCost,
        opts?.runBudgetSnapshot,
        opts?.onRunBudgetCheckpoint ?? this.onRunBudgetCheckpoint,
        opts?.beforeToolExecution,
      );
    const budget = ledger.retain();
    const linked = linkedRunSignal(signal, budget.signal);
    this.activeBudget = budget;
    try {
      // per-prompt 模型覆盖：本次 drive 全程（含工具后的后续 turn）用覆盖模型，
      // 结束由 finally 的 restore() 还原。send 不可重入（running 护栏），是安全的。
      if (opts?.model) {
        if (!this.runner.canResolve) {
          yield {
            type: "error",
            message: t(
              "Per-prompt model override requires the resolveModel option",
              "单条消息模型覆盖需要配置 resolveModel 选项",
            ),
          };
          return;
        }
        try {
          this.runner.override(opts.model);
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
      }
      try {
        yield* this.drive(userText, linked.signal, opts?.resume ?? false, budget);
      } catch (error) {
        if (!linked.signal.aborted) throw error;
        this.inbox.close();
        yield {
          type: "error",
          message: budget.violation() ?? errorText(error) ?? "会话已中断",
        };
      }
    } finally {
      // A non-cooperative in-process Tool can outlive the model-visible timeout result. Retain the
      // run budget and command fence until its raw Promise has settled, so no late side effect can
      // happen after the durable command is acknowledged terminal.
      await this.executor.awaitIdle();
      // per-prompt 覆盖与降级都是 drive 局部的：结束还原主模型。
      this.runner.restore();
      this.inbox.clear();
      this.traceParent = savedTraceParent;
      this.activeBudget = null;
      linked.dispose();
      budget.dispose();
      this.running = false;
      // drive 收尾窗口到达、没赶上 turn 边界的任务通知：改走空闲投递（回调或积压）。
      this.inbox.flushLeftover();
    }
  }

  /**
   * steering：loop 运行中追加一条用户输入，在下一个 turn 边界注入历史。
   * 返回 false 表示当前 drive 尚未开始接收或已经停止接收 steering；
   * 调用方应把消息排到下一次 send。
   */
  queue(text: string): boolean {
    if (!this.running) return false;
    return this.inbox.enqueue(text);
  }

  /** 中断时丢弃尚未注入历史的 steering 输入。返回被清掉的数量。 */
  clearQueue(): number {
    // 「先同步关窗、再清队列」的时序不变量在 SteeringInbox.clear 内部保证。
    return this.inbox.clear();
  }

  private async *drive(
    userText: string,
    signal: AbortSignal,
    recovering = false,
    budget?: DriveBudget,
  ): AsyncGenerator<AgentEvent> {
    await this.ensureMemory(userText, signal);

    // rewind 需要「本轮开始前」的消息数；必须在 pushUser 之前取。
    const preTurnCount = this.conv.length;

    if (recovering) {
      // command inbox 表明原始用户输入已经进入历史，但进程在终态前退出。
      // 只注入一条不可冒充用户原话的内部恢复指令，避免重复原始 prompt/副作用。
      this.pushInternalUser(userText);
    } else {
      // UserPromptSubmit hook：可拦截输入，或注入 UI 不展示的内部上下文。
      const prepared = await this.prepareUserInput(userText, signal);
      if (prepared.blocked) {
        this.inbox.close();
        yield { type: "error", message: `输入被 hook 拦截: ${prepared.reason}` };
        return;
      }
      yield* this.pushUser(userText, false, prepared.additionalContext);
    }
    // 上一轮空闲期积压的后台任务完成通知：随本轮主输入一并交给模型。
    if (this.inbox.promotePending()) {
      yield* this.drainNotices();
    }
    await this.conv.flush(signal);
    // 主输入已经正式进入历史，从这里开始同一 drive 才可接受 steering。
    // interrupt 可能发生在异步 hook / 持久化期间；closing 不得重新回到 active。
    this.inbox.open(!signal.aborted);

    // 工作区快照：在模型动手前记一份，供用户 undo 回滚本轮的文件改动。尽力而为，失败不影响主流程。
    if (this.snapshots && !recovering) {
      const snap = await raceWithSignal(
        this.snapshots.take(userText.replace(/\s+/g, " ").trim().slice(0, 60)),
        signal,
      );
      if (snap) {
        yield {
          type: "checkpoint",
          id: snap.id,
          tree: snap.tree,
          label: snap.label,
          messageCount: preTurnCount,
        };
      }
    }

    let stopContinuations = 0;
    let verificationAttempts = 0;
    for (let turn = 1; turn <= this.maxTurns; turn++) {
      const preTurnBudgetError = budget?.violation();
      if (preTurnBudgetError) {
        this.inbox.close();
        yield { type: "error", message: preTurnBudgetError };
        return;
      }
      // 压缩：每轮 provider 调用前检查历史规模
      if (this.compaction) {
        // PreCompact：达到触发线才响（与 maybeCompact 同一判定），观察性 hook。
        if (
          this.hooks.has("PreCompact") &&
          compactionPending(this.conv.raw(), this.compaction, this.conv.lastInputTokens)
        ) {
          await raceWithSignal(
            this.hooks.run({
              event: "PreCompact",
              cwd: this.cwd,
              tokens: this.conv.lastInputTokens,
              signal,
            }),
            signal,
          );
        }
        const res = await raceWithSignal(
          maybeCompact(this.conv.raw(), this.compaction, this.conv.lastInputTokens, { signal }),
          signal,
        );
        throwIfAborted(signal);
        if (res.compacted) {
          await this.conv.replaceAll(res.messages, signal); // 历史被改写，整文件重写
          yield { type: "compacted", beforeTokens: res.beforeTokens, afterTokens: res.afterTokens };
          if (this.hooks.has("PostCompact")) {
            await raceWithSignal(
              this.hooks.run({
                event: "PostCompact",
                cwd: this.cwd,
                beforeTokens: res.beforeTokens,
                afterTokens: res.afterTokens,
                signal,
              }),
              signal,
            );
          }
        }
      }

      const outcome = yield* this.runner.runTurn({
        system: this.system,
        messages: this.conv.raw(),
        toolDefs: this.tools.definitions(),
        signal,
        reserveModelCall: (request) => budget!.reserveModelCall(request),
      });
      if (outcome.type === "error") {
        if (outcome.usage) {
          this.conv.accumulate(outcome.usage);
          this.conv.noteRealInput(outcome.usage);
          yield { type: "turn_end", usage: outcome.usage };
        }
        // 已经接受的 steering 不可留到下一次 send 后乱序；先按原顺序入历史，
        // 再结束本轮。它们会在下一次显式 send 时与历史一同交给模型。
        while (this.inbox.hasQueued()) {
          yield* this.drainQueued(signal);
          await this.conv.flush(signal);
        }
        this.inbox.close();
        yield { type: "error", message: budget?.violation() ?? outcome.message };
        return;
      }
      // Provider 实现可能忽略 AbortSignal 并在退出后仍返回工具调用。此处是
      // Agent 自己的最后一道副作用闸门：被中断的响应绝不能进入 history/执行工具。
      if (signal.aborted) {
        // A terminal provider response can cross the budget exactly while commit() aborts the
        // drive. It must not enter replay history, but the billed usage is still real and must be
        // retained for parent/task durability and accounting.
        this.conv.accumulate(outcome.usage);
        this.conv.noteRealInput(outcome.usage);
        yield { type: "turn_end", usage: outcome.usage };
        this.inbox.close();
        yield { type: "turn_reset" };
        yield { type: "error", message: budget?.violation() ?? "会话已中断" };
        return;
      }

      this.conv.pushAssistant(outcome.message);
      await this.conv.flush(signal);
      this.conv.accumulate(outcome.usage);
      // 真实上下文规模（压缩触发依据）的口径见 Conversation.noteRealInput。
      this.conv.noteRealInput(outcome.usage);
      yield { type: "turn_end", usage: outcome.usage };

      const calls = toolCallsOf(outcome.message);
      const postTurnBudgetError = budget?.violation();
      if (postTurnBudgetError && (outcome.stopReason !== "tool_use" || calls.length === 0)) {
        this.inbox.close();
        yield { type: "error", message: postTurnBudgetError };
        return;
      }
      if (outcome.stopReason !== "tool_use" || calls.length === 0) {
        // 后台任务在模型收尾前完成 → 通知注入并继续 loop（模型当轮消化结果）
        if (this.inbox.hasNotices()) {
          const n = yield* this.drainNotices();
          if (n > 0) {
            await this.conv.flush(signal);
            continue;
          }
        }
        // steering 队列非空 → 注入并继续 loop（模型收尾了但用户还有话说）
        if (this.inbox.hasQueued()) {
          const added = yield* this.drainQueued(signal);
          if (added > 0) {
            await this.conv.flush(signal);
            continue;
          }
        }
        // Mutation-capable lifecycle hooks must run before deterministic verification. A command
        // Stop/Notification hook can write the workspace even when it returns no structured result.
        if (this.hooks.has("Stop")) {
          const h = await raceWithSignal(
            this.hooks.run({ event: "Stop", cwd: this.cwd, stopContinuations, signal }),
            signal,
          );
          if (h.blocked && stopContinuations < MAX_STOP_CONTINUATIONS) {
            stopContinuations++;
            this.pushInternalUser(reminder(`Stop hook 要求继续: ${h.reason}`).trim());
            await this.conv.flush(signal);
            continue;
          }
        }
        // Stop hook await 期间也可能收到 steering；必须在决定 done 前再检查一次。
        if (this.inbox.hasQueued()) {
          const added = yield* this.drainQueued(signal);
          if (added > 0) {
            await this.conv.flush(signal);
            continue;
          }
        }
        if (this.hooks.has("Notification")) {
          await raceWithSignal(
            this.hooks.run({
              event: "Notification",
              cwd: this.cwd,
              notificationType: "turn_done",
              message: lastAssistantHead(this.conv.raw()),
              signal,
            }),
            signal,
          );
        }
        // Verifier 是完成条件的一部分：发生文件编辑后，必须由确定性检查给出证据。
        // 失败会作为内部上下文回灌，让模型继续修复；达到返修上限则明确失败而非假装 done。
        if (this.verifier && this.changedSinceVerification) {
          verificationAttempts++;
          const verificationSpan = this.telemetry.startSpan(
            "anicode.verification.run",
            {
              "anicode.verification.attempt": verificationAttempts,
              "anicode.changed_files.count": this.changedFiles.size,
            },
            this.traceParent,
          );
          let report: VerificationReport;
          try {
            report = await raceWithSignal(
              this.verifier.verify({
                cwd: this.cwd,
                changedFiles: [...this.changedFiles],
                signal,
              }),
              signal,
            );
            verificationSpan
              .setAttribute("anicode.verification.status", report.status)
              .setAttribute("anicode.verification.checks", report.checks.length)
              .setStatus({ code: report.status === "failed" ? "error" : "ok" });
          } catch (error) {
            verificationSpan.recordException(error).setStatus({ code: "error" }).end();
            throw error;
          }
          verificationSpan.end();
          yield { type: "verification", report };
          if (report.status !== "passed") {
            // 保持 dirty：模型若未作任何修复就再次宣告完成，仍会重跑并最终失败，
            // 不能因“一次验证过”而把失败误当成已验证。
            this.changedSinceVerification = true;
            if (report.status === "cancelled") {
              this.inbox.close();
              yield { type: "error", message: "验证已取消" };
              return;
            }
            if (verificationAttempts < this.verificationMaxAttempts) {
              this.pushInternalUser(
                reminder(
                  `Deterministic verification failed. Fix the failures before finishing.\n${renderVerificationReport(report)}`,
                ).trim(),
              );
              await this.conv.flush(signal);
              continue;
            }
            this.inbox.close();
            yield {
              type: "error",
              message: `验证失败，已达到自动返修上限 ${this.verificationMaxAttempts}\n${renderVerificationReport(report)}`,
            };
            return;
          }
          this.changedSinceVerification = false;
          this.changedFiles.clear();
        }
        this.inbox.close();
        {
          const costUSD = this.estimatedCostUSD;
          yield {
            type: "done",
            usage: this.conv.cumulative,
            turns: turn,
            ...(costUSD !== undefined ? { costUSD } : {}),
          };
        }
        return;
      }

      const toolBudgetError = await budget?.reserveToolCalls(calls.length);
      if (toolBudgetError) {
        const results = calls.map((call) => ({
          type: "tool_result" as const,
          toolCallId: call.id,
          toolName: call.name,
          content: toolBudgetError,
          isError: true,
        }));
        for (const call of calls) {
          yield {
            type: "tool_result",
            id: call.id,
            name: call.name,
            content: toolBudgetError,
            isError: true,
          };
        }
        this.conv.pushToolRound(results, []);
        await this.conv.flush(signal);
        this.inbox.close();
        yield { type: "error", message: toolBudgetError };
        return;
      }

      const { results, images } = yield* this.executor.run(calls, signal);
      // tool_result 必须在前（Anthropic 的硬性要求），工具附带的图片紧随其后。
      this.conv.pushToolRound(results, images);
      await this.conv.flush(signal);
      if (signal.aborted) {
        this.inbox.close();
        yield { type: "error", message: budget?.violation() ?? "会话已中断" };
        return;
      }
      const postToolBudgetError = budget?.violation();
      if (postToolBudgetError) {
        this.inbox.close();
        yield { type: "error", message: postToolBudgetError };
        return;
      }
      // 工具轮之后是注入 steering / 任务通知的天然边界
      if (this.inbox.hasNotices()) {
        const n = yield* this.drainNotices();
        if (n > 0) await this.conv.flush(signal);
      }
      if (this.inbox.hasQueued()) {
        const added = yield* this.drainQueued(signal);
        if (added > 0) await this.conv.flush(signal);
      }
    }

    while (this.inbox.hasQueued()) {
      yield* this.drainQueued(signal);
      await this.conv.flush(signal);
    }
    this.inbox.close();
    yield { type: "error", message: `达到最大轮数 ${this.maxTurns}，已停止` };
  }

  private *pushUser(
    text: string,
    queued: boolean,
    additionalContext?: string,
  ): Generator<AgentEvent> {
    this.conv.pushUser(text, additionalContext);
    yield { type: "user_message", text, queued };
  }

  private pushInternalUser(text: string): void {
    this.conv.pushInternal(text);
  }

  private async prepareUserInput(
    text: string,
    signal: AbortSignal,
  ): Promise<{ blocked: false; additionalContext?: string } | { blocked: true; reason: string }> {
    if (!this.hooks.has("UserPromptSubmit")) return { blocked: false };
    const h = await raceWithSignal(
      this.hooks.run({ event: "UserPromptSubmit", cwd: this.cwd, prompt: text, signal }),
      signal,
    );
    if (h.blocked) return { blocked: true, reason: h.reason ?? "被 UserPromptSubmit hook 拦截" };
    return {
      blocked: false,
      ...(h.additionalContext ? { additionalContext: h.additionalContext } : {}),
    };
  }

  /** 把积压的后台任务完成通知注入历史（internal user，不过 UserPromptSubmit hook）。 */
  private *drainNotices(): Generator<AgentEvent, number> {
    let added = 0;
    while (this.inbox.hasNotices()) {
      const text = this.inbox.shiftNotice()!;
      this.pushInternalUser(text);
      yield { type: "task_notice", text };
      added++;
    }
    return added;
  }

  private async *drainQueued(signal: AbortSignal): AsyncGenerator<AgentEvent, number> {
    let added = 0;
    while (this.inbox.hasQueued()) {
      const text = this.inbox.shiftQueued()!;
      const prepared = await this.prepareUserInput(text, signal);
      if (prepared.blocked) {
        yield { type: "error", message: `排队输入被 hook 拦截: ${prepared.reason}` };
        continue;
      }
      yield* this.pushUser(text, true, prepared.additionalContext);
      added++;
    }
    return added;
  }

  // 模型轮执行已迁至 TurnRunner（turn-runner.ts）；工具执行调度已迁至
  // ToolExecutor（tool-executor.ts）。（架构 v2）

  // ---------- 内部工具方法 ----------

  private resolveCompaction(
    cfg: AgentOptions["compaction"],
    modelInfo: AgentModelInfo | undefined,
  ): CompactionConfig | null {
    if (!cfg) return null;
    const defaultSummarizer = providerSummarizer((messages, system, signal) =>
      this.runner.streamText(
        messages,
        system,
        signal,
        (usage) => this.conv.accumulate(usage),
        this.activeBudget ? (request) => this.activeBudget!.reserveModelCall(request) : undefined,
      ),
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

  /**
   * 首次 send 前装配静态上下文；此后 system 不再变（缓存友好）。
   * 段落顺序由 assembler 的 provider 顺序决定（env → 记忆 → repo map → skills →
   * browser 指引），subagent 发现夹在中间（不贡献段落），SessionStart hook 收尾。
   */
  private async ensureMemory(query: string, signal: AbortSignal): Promise<void> {
    if (this.memoryLoaded) return;
    const span = this.telemetry.startSpan("anicode.context.compile", undefined, this.traceParent);
    const ctx = {
      cwd: this.cwd,
      tools: this.tools,
      query,
      markReadOnly: (names: string[]) => this.perm.addReadOnlyTools(names),
    };
    try {
      const contributions = await raceWithSignal(this.assembler.collectContributions(ctx), signal);
      // 文件系统 agents：发现是异步的，task 工具在此（首次 send 前）注册。
      // 文件定义排在程序化定义之前 —— createTaskTool 按序覆盖，程序化同名优先。
      if (this.subagentsOpt?.discover) {
        let discovered: SubagentDefinition[] = [];
        try {
          discovered = await raceWithSignal(
            discoverSubagents(this.cwd, this.subagentsOpt.dirs, {
              includeProject: this.subagentsOpt.includeProject,
            }),
            signal,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          /* 发现失败不影响主流程；仍注册内置类型 */
        }
        throwIfAborted(signal);
        this.registerTaskTool([...discovered, ...this.subagentsOpt.definitions]);
      }
      // SessionStart hook：会话装配的最后一步，additionalContext 注入 system。
      contributions.push(
        ...(await raceWithSignal(this.postAssembler.collectContributions(ctx), signal)),
      );
      const presets: Record<string, Pick<ContextSource, "kind" | "priority" | "required">> = {
        env: { kind: "environment", priority: 90, required: true },
        "project-memory": { kind: "memory", priority: 100, required: true },
        "repo-map": { kind: "repository", priority: 65 },
        skills: { kind: "skill", priority: 75 },
        "browser-usage": { kind: "instruction", priority: 60 },
        "session-start-hook": { kind: "runtime", priority: 95, required: true },
      };
      const sources: ContextSource[] = contributions.map(({ id, content }) => ({
        id,
        content,
        ...(presets[id] ?? { kind: "runtime", priority: 50 }),
      }));
      if (sources.length > 0) {
        const compiled = this.contextCompiler.compile({ query, sources });
        throwIfAborted(signal);
        this.system = composeSystem(this.baseSystem, compiled.text);
        span
          .setAttribute("anicode.context.sources", compiled.selected.length)
          .setAttribute("anicode.context.dropped", compiled.dropped.length)
          .setAttribute("anicode.context.tokens", compiled.estimatedTokens)
          .setAttribute("anicode.context.digest", compiled.digest);
      }
      this.memoryLoaded = true;
      span.setStatus({ code: "ok" });
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" });
      throw error;
    } finally {
      span.end();
    }
  }
}

function normalizeUsage(usage: Usage): Usage {
  const field = (value: number): number =>
    Number.isSafeInteger(Math.floor(value)) && value >= 0 ? Math.floor(value) : 0;
  return {
    inputTokens: field(usage.inputTokens),
    outputTokens: field(usage.outputTokens),
    cacheReadTokens: field(usage.cacheReadTokens),
    cacheWriteTokens: field(usage.cacheWriteTokens),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/** Hard stop for lifecycle hooks, context work and verifiers that ignore AbortSignal. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function normalizeRunBudget(input: RunBudgetConfig | undefined): Required<RunBudgetConfig> {
  return {
    maxWallTimeMs: runBudgetNumber(
      "maxWallTimeMs",
      input?.maxWallTimeMs,
      DEFAULT_RUN_BUDGET.maxWallTimeMs,
      10,
    ),
    maxTotalTokens: runBudgetNumber(
      "maxTotalTokens",
      input?.maxTotalTokens,
      DEFAULT_RUN_BUDGET.maxTotalTokens,
      1,
      true,
    ),
    maxCostUSD: runBudgetNumber(
      "maxCostUSD",
      input?.maxCostUSD,
      DEFAULT_RUN_BUDGET.maxCostUSD,
      0.000001,
    ),
    maxToolCalls: runBudgetNumber(
      "maxToolCalls",
      input?.maxToolCalls,
      DEFAULT_RUN_BUDGET.maxToolCalls,
      1,
      true,
    ),
    maxConcurrentTools: runBudgetNumber(
      "maxConcurrentTools",
      input?.maxConcurrentTools,
      DEFAULT_RUN_BUDGET.maxConcurrentTools,
      1,
      true,
    ),
    toolTimeoutMs: runBudgetNumber(
      "toolTimeoutMs",
      input?.toolTimeoutMs,
      DEFAULT_RUN_BUDGET.toolTimeoutMs,
      1_000,
    ),
  };
}

function runBudgetNumber(
  name: keyof RunBudgetConfig,
  value: number | undefined,
  fallback: number,
  minimum: number,
  integer = false,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > Number.MAX_SAFE_INTEGER ||
    (integer && !Number.isSafeInteger(value))
  ) {
    throw new Error(`runBudget.${name} 必须是 ${minimum} 以上的${integer ? "安全整数" : "有限数"}`);
  }
  return value;
}

/** Shared by every foreground and detached child that belongs to one root send. */
export class RunBudgetLedger {
  private readonly startedAt: number;
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private usage: Usage;
  private toolCalls: number;
  private estimatedCostUSD: number;
  private reservedTokens: number;
  private reservedCostUSD: number;
  private revision: number;
  private reason: string | null = null;
  private references = 0;
  private closed = false;
  private checkpointTail: Promise<void> = Promise.resolve();
  private activeTools = 0;
  private readonly toolWaiters: Array<{
    signal: AbortSignal;
    resolve: (release: () => void) => void;
    reject: (error: unknown) => void;
    cleanup: () => void;
  }> = [];

  constructor(
    private readonly limits: Required<RunBudgetConfig>,
    private readonly requireKnownCost = false,
    resume?: RunBudgetSnapshot,
    private readonly onCheckpoint?: (snapshot: RunBudgetSnapshot) => void | Promise<void>,
    private readonly commandToolFence?: (
      request: ToolExecutionFenceRequest,
    ) => void | Promise<void>,
  ) {
    const restored = resume ? validateRunBudgetSnapshot(resume) : undefined;
    this.startedAt = restored?.startedAt ?? Date.now();
    this.usage = restored ? { ...restored.chargedUsage } : emptyRunUsage();
    this.toolCalls = restored?.toolCalls ?? 0;
    this.estimatedCostUSD = restored?.chargedCostUSD ?? 0;
    this.reservedTokens = restored?.reservedTokens ?? 0;
    this.reservedCostUSD = restored?.reservedCostUSD ?? 0;
    this.revision = restored?.revision ?? 0;
    this.reason = restored?.terminalReason ?? null;
    const elapsed = Math.max(0, Date.now() - this.startedAt);
    const remaining = Math.max(0, this.limits.maxWallTimeMs - elapsed);
    this.timer = setTimeout(() => {
      this.fail(`任务达到最大执行时间 ${this.limits.maxWallTimeMs}ms，已停止`);
    }, remaining);
    this.timer.unref?.();
    if (this.reason) {
      clearTimeout(this.timer);
      this.controller.abort(new Error(this.reason));
    } else {
      void this.violation();
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  retain(): DriveBudget {
    this.acquireReference();
    return new DriveBudget(this);
  }

  /** Reserve the tree deadline before scheduling a detached async generator. */
  hold(): () => void {
    this.acquireReference();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private acquireReference(): void {
    if (this.closed) throw new Error("任务预算作用域已结束，不能重新派生后台工作");
    this.references++;
  }

  addUsage(usage: Usage, cost: AgentModelInfo["cost"] | undefined): void {
    try {
      this.applyUsage(usage, cost);
      this.revision++;
      void this.checkpoint().catch((error: unknown) => {
        this.fail(`预算 checkpoint 失败: ${errorText(error)}`);
      });
      void this.violation();
    } catch (error) {
      throw new Error(this.fail(errorText(error)), { cause: error });
    }
  }

  private applyUsage(usage: Usage, cost: AgentModelInfo["cost"] | undefined): void {
    if (!validUsage(usage)) throw new Error("usage 必须由四个非负安全整数字段组成");
    if (cost && !validModelCost(cost)) throw new Error("模型价格配置无效，成本门禁已 fail-closed");
    if (this.requireKnownCost && !cost) {
      throw new Error("模型没有可信价格信息，无法执行显式成本硬上限");
    }
    const nextUsage = {
      inputTokens: this.usage.inputTokens + usage.inputTokens,
      outputTokens: this.usage.outputTokens + usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens + usage.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens + usage.cacheWriteTokens,
    };
    if (!validUsage(nextUsage)) throw new Error("累计 usage 超出安全整数范围");
    const additionalCost = estimateUsageCost(usage, cost) ?? 0;
    const nextCost = this.estimatedCostUSD + additionalCost;
    if (!finiteNonNegative(additionalCost) || !finiteNonNegative(nextCost)) {
      throw new Error("累计模型成本不是有限非负数");
    }
    this.usage = nextUsage;
    this.estimatedCostUSD = nextCost;
  }

  async reserveModelCall(request: Parameters<ReserveModelCall>[0]): Promise<ModelCallReservation> {
    const existing = this.violation();
    if (existing) throw new Error(existing);
    if (request.cost && !validModelCost(request.cost)) {
      throw new Error(this.fail(`模型 ${request.model} 的价格配置无效，成本门禁已 fail-closed`));
    }
    const cost = request.cost && validModelCost(request.cost) ? request.cost : undefined;
    if (this.requireKnownCost && !cost) {
      throw new Error(
        this.fail(
          `模型 ${request.model} 没有可信价格信息，无法执行显式成本硬上限；请配置模型价格或移除 maxCostUSD`,
        ),
      );
    }

    if (!finiteSafePositive(request.estimatedInputTokens)) {
      throw new Error(this.fail("模型请求的 input token 估算无效，预算门禁已 fail-closed"));
    }
    if (
      request.requestedMaxTokens !== undefined &&
      !finiteSafePositive(request.requestedMaxTokens)
    ) {
      throw new Error(this.fail("模型请求的 maxTokens 无效，预算门禁已 fail-closed"));
    }
    const estimatedInputTokens = Math.max(1, Math.ceil(request.estimatedInputTokens));
    const committedTokens = totalUsageTokens(this.usage);
    const availableTokens = this.limits.maxTotalTokens - committedTokens - this.reservedTokens;
    if (availableTokens <= estimatedInputTokens) {
      throw new Error(
        this.fail(
          `任务达到 Token 上限 ${this.limits.maxTotalTokens}：剩余 ${Math.max(0, availableTokens)}，不足以发送预计 ${estimatedInputTokens} Token 的请求`,
        ),
      );
    }

    const providerMaxTokens =
      request.requestedMaxTokens === undefined
        ? undefined
        : Math.min(
            Math.max(1, Math.floor(request.requestedMaxTokens)),
            availableTokens - estimatedInputTokens,
          );
    // A provider-native/unbounded output cannot be estimated into a hard cap. Reserve every
    // remaining token, but preserve `maxTokens: undefined` so unknown endpoints keep their native
    // request shape. Any dispatched failure consequently consumes the whole remaining allowance.
    let reservedOutputTokens = providerMaxTokens ?? availableTokens - estimatedInputTokens;
    let reservedCost = 0;
    if (cost) {
      const remainingCost = this.limits.maxCostUSD - this.estimatedCostUSD - this.reservedCostUSD;
      const worstInputRate = Math.max(
        cost.input,
        cost.cacheRead ?? cost.input * 0.1,
        cost.cacheWrite ?? cost.input * 1.25,
      );
      const inputCost = (estimatedInputTokens * worstInputRate) / 1_000_000;
      if (inputCost >= remainingCost) {
        throw new Error(
          this.fail(
            `任务剩余成本预算 $${Math.max(0, remainingCost).toFixed(4)} 不足以发送模型请求`,
          ),
        );
      }
      if (this.requireKnownCost && providerMaxTokens === undefined && cost.output > 0) {
        throw new Error(
          this.fail(
            `模型 ${request.model} 没有可信输出上限，无法执行成本硬上限；请配置 maxOutputTokens`,
          ),
        );
      }
      // Only a provider-enforced output bound can turn the pre-dispatch estimate into a hard
      // cost reservation. The built-in default budget remains compatible with priced proxy/local
      // endpoints whose metadata omits maxOutputTokens: reserve their known input cost here and
      // charge the provider's actual usage on commit. An explicitly configured maxCostUSD takes
      // the fail-closed branch above instead.
      if (cost.output > 0 && providerMaxTokens !== undefined) {
        const costBound = Math.floor(((remainingCost - inputCost) * 1_000_000) / cost.output);
        reservedOutputTokens = Math.min(reservedOutputTokens, costBound);
      }
      if (reservedOutputTokens < 1) {
        throw new Error(this.fail(`任务成本预算不足以保留 1 个输出 Token`));
      }
      reservedCost =
        inputCost +
        (providerMaxTokens === undefined ? 0 : (reservedOutputTokens * cost.output) / 1_000_000);
    }

    if (reservedOutputTokens < 1) {
      throw new Error(this.fail(`任务 Token 预算不足以保留 1 个输出 Token`));
    }
    const tokenReservation = estimatedInputTokens + reservedOutputTokens;
    this.reservedTokens += tokenReservation;
    this.reservedCostUSD += reservedCost;
    this.revision++;
    await this.checkpointOrFail();
    let settled = false;
    const release = (): boolean => {
      if (settled) return false;
      settled = true;
      this.reservedTokens -= tokenReservation;
      this.reservedCostUSD -= reservedCost;
      return true;
    };
    return {
      ...(providerMaxTokens !== undefined ? { maxTokens: reservedOutputTokens } : {}),
      commit: async (usage) => {
        if (!release()) return;
        if (!validUsage(usage)) {
          this.usage = {
            ...this.usage,
            inputTokens: this.usage.inputTokens + estimatedInputTokens,
            outputTokens: this.usage.outputTokens + reservedOutputTokens,
          };
          this.estimatedCostUSD += reservedCost;
          this.revision++;
          await this.checkpointOrFail();
          throw new Error(this.fail("provider 返回了无效 usage，已按完整 reservation 扣账并停止"));
        }
        try {
          this.applyUsage(usage, cost);
        } catch (error) {
          throw new Error(this.fail(errorText(error)), { cause: error });
        }
        const reportedTokens = totalUsageTokens(usage);
        this.revision++;
        await this.checkpointOrFail();
        if (reportedTokens > tokenReservation) {
          throw new Error(
            this.fail(
              `provider 报告 usage ${reportedTokens} 超过预留 ${tokenReservation}，预算门禁已停止`,
            ),
          );
        }
        const violation = this.violation();
        if (violation) throw new Error(violation);
      },
      consume: async () => {
        if (!release()) return;
        this.usage = {
          ...this.usage,
          inputTokens: this.usage.inputTokens + estimatedInputTokens,
          outputTokens: this.usage.outputTokens + reservedOutputTokens,
        };
        this.estimatedCostUSD += reservedCost;
        this.revision++;
        await this.checkpointOrFail();
        void this.violation();
      },
      cancel: async () => {
        if (!release()) return;
        this.revision++;
        await this.checkpointOrFail();
      },
    };
  }

  async reserveToolCalls(count: number): Promise<string | undefined> {
    if (!finiteSafePositive(count)) return this.fail("工具调用计数无效，预算门禁已停止");
    if (this.toolCalls + count > this.limits.maxToolCalls) {
      return this.fail(`任务达到工具调用上限 ${this.limits.maxToolCalls}，未执行本批工具`);
    }
    this.toolCalls += count;
    this.revision++;
    await this.checkpointOrFail();
    return this.violation();
  }

  /** Tree-global FIFO semaphore shared by root, child and detached child ToolExecutors. */
  async acquireToolSlot(signal: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    const violation = this.violation();
    if (violation) throw new Error(violation);
    if (this.activeTools < this.limits.maxConcurrentTools) {
      this.activeTools++;
      return this.toolSlotRelease();
    }
    return new Promise<() => void>((resolve, reject) => {
      let waiter: (typeof this.toolWaiters)[number];
      const rejectWaiter = () => {
        const index = this.toolWaiters.indexOf(waiter);
        if (index >= 0) this.toolWaiters.splice(index, 1);
        waiter.cleanup();
        reject(signal.aborted ? signal.reason : this.controller.signal.reason);
      };
      const cleanup = () => {
        signal.removeEventListener("abort", rejectWaiter);
        this.controller.signal.removeEventListener("abort", rejectWaiter);
      };
      waiter = { signal, resolve, reject, cleanup };
      this.toolWaiters.push(waiter);
      signal.addEventListener("abort", rejectWaiter, { once: true });
      this.controller.signal.addEventListener("abort", rejectWaiter, { once: true });
    });
  }

  /** Run the exact root-command guard captured when this shared tree ledger was constructed. */
  async beforeToolExecution(request: ToolExecutionFenceRequest): Promise<boolean> {
    if (!this.commandToolFence) return false;
    await this.commandToolFence(request);
    return true;
  }

  private toolSlotRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeTools = Math.max(0, this.activeTools - 1);
      while (this.toolWaiters.length > 0 && !this.controller.signal.aborted) {
        const waiter = this.toolWaiters.shift()!;
        waiter.cleanup();
        if (waiter.signal.aborted) {
          waiter.reject(waiter.signal.reason);
          continue;
        }
        this.activeTools++;
        waiter.resolve(this.toolSlotRelease());
        break;
      }
    };
  }

  snapshot(): RunBudgetSnapshot {
    return {
      version: 1,
      revision: this.revision,
      startedAt: this.startedAt,
      chargedUsage: { ...this.usage },
      chargedCostUSD: this.estimatedCostUSD,
      reservedTokens: this.reservedTokens,
      reservedCostUSD: this.reservedCostUSD,
      toolCalls: this.toolCalls,
      ...(this.reason ? { terminalReason: this.reason } : {}),
    };
  }

  async whenCheckpointed(signal?: AbortSignal): Promise<void> {
    if (signal) await raceWithSignal(this.checkpointTail, signal);
    else await this.checkpointTail;
  }

  private async checkpoint(): Promise<void> {
    const pending = this.enqueueCheckpoint(this.snapshot());
    await raceWithSignal(pending, this.controller.signal);
  }

  private enqueueCheckpoint(snapshot: RunBudgetSnapshot): Promise<void> {
    if (!this.onCheckpoint) return Promise.resolve();
    const pending = this.checkpointTail.then(() => this.onCheckpoint!(snapshot));
    this.checkpointTail = pending;
    return pending;
  }

  private async checkpointOrFail(): Promise<void> {
    try {
      await this.checkpoint();
    } catch (error) {
      throw new Error(this.fail(`预算 checkpoint 失败: ${errorText(error)}`), { cause: error });
    }
  }

  violation(): string | undefined {
    if (this.reason) return this.reason;
    if (Date.now() - this.startedAt >= this.limits.maxWallTimeMs) {
      return this.fail(`任务达到最大执行时间 ${this.limits.maxWallTimeMs}ms，已停止`);
    }
    const totalTokens = totalUsageTokens(this.usage) + this.reservedTokens;
    if (totalTokens > this.limits.maxTotalTokens) {
      return this.fail(`任务达到 Token 上限 ${this.limits.maxTotalTokens}，已停止`);
    }
    if (this.estimatedCostUSD + this.reservedCostUSD > this.limits.maxCostUSD) {
      return this.fail(`任务达到成本上限 $${this.limits.maxCostUSD.toFixed(4)}，已停止`);
    }
    return undefined;
  }

  private fail(message: string): string {
    if (!this.reason) {
      this.reason = (message.trim() || "预算门禁已停止").slice(0, 4_096);
      // Terminal protocol/config/tool-count failures are not always inferable from charged totals.
      // Persist the stop itself so a crash between rejection and command ACK cannot reopen budget.
      this.revision++;
      void this.enqueueCheckpoint(this.snapshot()).catch(() => undefined);
      this.controller.abort(new Error(message));
    }
    return this.reason;
  }

  release(): void {
    if (this.references <= 0) return;
    this.references--;
    if (this.references === 0) {
      this.closed = true;
      clearTimeout(this.timer);
      if (!this.controller.signal.aborted) {
        this.controller.abort(new Error("任务预算作用域已结束"));
      }
    }
  }
}

class DriveBudget {
  private released = false;

  constructor(readonly ledger: RunBudgetLedger) {}

  get signal(): AbortSignal {
    return this.ledger.signal;
  }

  addUsage(usage: Usage, cost: AgentModelInfo["cost"] | undefined): void {
    this.ledger.addUsage(usage, cost);
  }

  reserveModelCall(request: Parameters<ReserveModelCall>[0]): Promise<ModelCallReservation> {
    return this.ledger.reserveModelCall(request);
  }

  reserveToolCalls(count: number): Promise<string | undefined> {
    return this.ledger.reserveToolCalls(count);
  }

  acquireToolSlot(signal: AbortSignal): Promise<() => void> {
    return this.ledger.acquireToolSlot(signal);
  }

  beforeToolExecution(request: ToolExecutionFenceRequest): Promise<boolean> {
    return this.ledger.beforeToolExecution(request);
  }

  whenCheckpointed(signal?: AbortSignal): Promise<void> {
    return this.ledger.whenCheckpointed(signal);
  }

  violation(): string | undefined {
    return this.ledger.violation();
  }

  dispose(): void {
    if (this.released) return;
    this.released = true;
    this.ledger.release();
  }
}

function estimateUsageCost(
  usage: Usage,
  cost: AgentModelInfo["cost"] | undefined,
): number | undefined {
  if (!cost || !validModelCost(cost)) return undefined;
  const per = 1 / 1_000_000;
  return (
    usage.inputTokens * cost.input * per +
    usage.outputTokens * cost.output * per +
    usage.cacheReadTokens * (cost.cacheRead ?? cost.input * 0.1) * per +
    usage.cacheWriteTokens * (cost.cacheWrite ?? cost.input * 1.25) * per
  );
}

function validModelCost(cost: NonNullable<AgentModelInfo["cost"]>): boolean {
  return (
    finiteNonNegative(cost.input) &&
    finiteNonNegative(cost.output) &&
    (cost.cacheRead === undefined || finiteNonNegative(cost.cacheRead)) &&
    (cost.cacheWrite === undefined || finiteNonNegative(cost.cacheWrite))
  );
}

function finiteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function finiteSafePositive(value: number): boolean {
  return Number.isSafeInteger(Math.ceil(value)) && value > 0;
}

function validUsage(usage: Usage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}

function emptyRunUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function validateRunBudgetSnapshot(snapshot: RunBudgetSnapshot): RunBudgetSnapshot {
  if (
    snapshot.version !== 1 ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    !Number.isSafeInteger(snapshot.startedAt) ||
    snapshot.startedAt < 0 ||
    snapshot.startedAt > Date.now() + 60_000 ||
    !validUsage(snapshot.chargedUsage) ||
    !finiteNonNegative(snapshot.chargedCostUSD) ||
    !Number.isSafeInteger(snapshot.reservedTokens) ||
    snapshot.reservedTokens < 0 ||
    !finiteNonNegative(snapshot.reservedCostUSD) ||
    !Number.isSafeInteger(snapshot.toolCalls) ||
    snapshot.toolCalls < 0 ||
    (snapshot.terminalReason !== undefined &&
      (typeof snapshot.terminalReason !== "string" ||
        snapshot.terminalReason.length < 1 ||
        snapshot.terminalReason.length > 4_096))
  ) {
    throw new Error("无效的 durable run budget snapshot，已 fail-closed");
  }
  return {
    ...snapshot,
    chargedUsage: { ...snapshot.chargedUsage },
  };
}

function totalUsageTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

function linkedRunSignal(
  parent: AbortSignal | undefined,
  budget: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const sources = [parent, budget].filter((value): value is AbortSignal => Boolean(value));
  const listeners = new Map<AbortSignal, () => void>();
  for (const source of sources) {
    const abort = () => controller.abort(source.reason ?? new Error("aborted"));
    if (source.aborted) abort();
    else {
      source.addEventListener("abort", abort, { once: true });
      listeners.set(source, abort);
    }
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
    },
  };
}

// ---------- 模块级辅助 ----------

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

/** 最后一条 assistant 文本的首行（Notification hook 的 message，截 120 字符）。 */
function lastAssistantHead(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    for (const p of m.content) {
      if (p.type === "text" && p.text.trim()) {
        return p.text.trim().split("\n")[0]!.slice(0, 120);
      }
    }
  }
  return "";
}

// Retry-After 解析随模型轮执行迁至 turn-runner.ts；re-export 保持既有 import 路径。
export { retryAfterMs } from "./turn-runner.js";

export type { Tool };
