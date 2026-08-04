/**
 * Subagents —— task 工具：让主 agent 把一段独立工作委派给子 agent（对齐 Claude Code 的 Task/Agent tool）。
 *
 * 价值在上下文隔离：子 agent 用自己的 history 完成大范围搜索/多步子任务，
 * 主 agent 的上下文只收到最终结论文本（一条 tool_result），不被中间过程淹没。
 *
 * 设计：
 *   - 子 agent 与父共享 provider / cwd / 权限配置（confirm 路由到同一个前端），
 *     但工具集被收窄：永远排除 task 自身（禁递归），可按定义进一步收窄
 *   - 子 agent 的内部事件流经 ctx.emit 回流，父 Agent 包成 tool_progress 广播，
 *     前端可以选择渲染子进度或忽略
 *   - Agent 构造器经参数注入（makeAgent），本模块只 import type —— 无运行时循环依赖
 *   - 子 agent 内部的副作用工具各自过权限门；父级 Pre/PostToolUse hook 也会继承
 *   - task 默认按副作用工具串行执行；三种情况例外地允许并发 fan-out：
 *     只读型（无写副作用）、background=true（工具立即返回，不占轮）、
 *     isolation=worktree（写发生在独立 worktree 副本，互不冲突）
 *   - 后台/续话（background / resume / task_output / task_stop）只在根 agent 可用：
 *     嵌套编排型子 agent 结束后没人接收完成通知，故嵌套 task 工具是前台-only
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolRegistry } from "./tools/tool.js";
import { ToolError } from "./tools/tool.js";
import { t } from "./i18n.js";
import { globMatch, type PermissionConfig } from "./permission.js";
import type { HookRegistration, HookRunner } from "./hooks.js";
import type { ChatMessage, Provider, Usage } from "./types.js";
import type {
  Agent,
  AgentOptions,
  AgentEvent,
  AgentModelInfo,
  AgentResolvedModel,
  RunBudgetLedger,
} from "./agent.js";
import type { WorktreeLease, WorktreeOwnership } from "./runtime/worker.js";
import type { NetworkProxy } from "./runtime/network-proxy.js";
import {
  createIsolatedGitPlumbing,
  hardenedGitArguments,
  hardenedGitEnvironment,
  trustedGitExecutable,
  validateGitRepository,
} from "./runtime/git-control.js";

const execFileP = promisify(execFile);
const WORKTREE_ROOT = path.join(os.tmpdir(), "anicode-worktrees");

async function execGit(
  cwd: string,
  args: string[],
  options: { encoding?: BufferEncoding; signal?: AbortSignal } = {},
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  await validateGitRepository(cwd);
  const executable = await trustedGitExecutable();
  const result = await execFileP(executable, hardenedGitArguments(args, cwd), {
    cwd,
    env: hardenedGitEnvironment(extraEnv),
    encoding: options.encoding ?? "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

export interface SubagentDefinition {
  /** 类型名，模型经 subagent_type 参数选择它 */
  name: string;
  /** 给模型看的用途说明（何时该派这个子 agent） */
  description: string;
  /** 子 agent 的 system 提示；缺省用通用子 agent 提示 */
  system?: string;
  /** 允许的工具名子集；缺省继承父的全部工具（除 task） */
  tools?: string[];
  /**
   * 禁用的工具名（支持 * glob，如 "mcp__*"）；在 tools/继承集确定后剔除
   * （对齐 Claude Code 的 disallowedTools）。
   */
  disallowedTools?: string[];
  /** 覆盖模型；裸 id 沿用父 provider，provider/model 可跨 provider（需 resolver）。 */
  model?: string;
  /** 推理深度覆盖（对齐 Codex agents 的 model_reasoning_effort）；缺省继承父级默认。 */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  /**
   * 只读调研型：子 agent 工具面被收窄到只读工具（不能写文件/跑命令），因此**无副作用**，
   * 多个此类 task 调用可被父 agent 并行 fan-out（对齐 opencode 的 explore/并行子代理）。
   */
  readOnly?: boolean;
  /**
   * 编排型：破例保留 task 工具，使其能再往下派子 agent（否则一律被剥离防递归）。
   * 仅显式声明此项的类型才拥有嵌套委派能力；仍受 MAX_SUBAGENT_DEPTH 深度上限约束，
   * 到达上限后即便是编排型也不再下发 task。用于 规划者→执行者→工人 这类多层协作模板。
   */
  orchestrator?: boolean;
}

/** 嵌套委派的深度上限：根 task 工具为 0，每下派一层编排型子 agent +1。
 *  默认 2 支撑「主 → L1 编排 → L2 编排 → L3 工人」的三层链（对齐 Sisyphus/Atlas/Hephaestus）。 */
export const MAX_SUBAGENT_DEPTH = 2;

/** 内置通用类型：全工具、通用提示 —— 对齐 Claude Code 的 general-purpose */
export const GENERAL_SUBAGENT: SubagentDefinition = {
  name: "general",
  description: t(
    "General subagent: multi-step search, cross-file investigation, independent subtasks.",
    "通用子 agent：多步搜索、跨文件调研、独立子任务。",
  ),
};

/** 内置只读调研类型：只读工具、可并行 —— 适合大范围并行调研（对齐 opencode 的 explore） */
export const EXPLORE_SUBAGENT: SubagentDefinition = {
  name: "explore",
  description: t(
    "Read-only investigation subagent: broad search/code-reading to reach a conclusion, no write side effects, can run several in parallel.",
    "只读调研子 agent：大范围搜索/读代码得出结论，无写副作用，可多个并行。",
  ),
  readOnly: true,
};

/** 子 agent 系统提示词，按当前语言取词（在委派构造 Agent 时求值）。 */
function subagentSystem(): string {
  return t(
    `You are a subagent handling one independent task delegated by the main agent.
- Work autonomously; do not ask the user questions (only the main agent sees your output).
- Your final message is the result you hand back: give the conclusion/findings/artifact location directly, no pleasantries.`,
    `你是一个子 agent，负责完成主 agent 委派的一项独立任务。
- 自主完成，不要向用户提问（你的输出只有主 agent 能看到）。
- 最终一条消息就是你交回的结果：直接给出结论/发现/产物位置，不要寒暄。`,
  );
}

// ---------- 任务注册表（后台执行与续话的载体） ----------

export type TaskStatus = "running" | "done" | "error" | "stopped";

export interface TaskRecord {
  id: string;
  /** subagent 类型名（resume 时沿用，忽略新传入的 subagent_type）。 */
  type: string;
  description: string;
  status: TaskStatus;
  /** 当前这一轮运行是否为后台模式（同一任务可以前台起、后台续，反之亦然）。 */
  background: boolean;
  /** 子 agent 实例 —— 保留完整上下文，resume 靠它续话。 */
  agent?: Agent;
  /** 最近一个耐久 checkpoint 的子会话历史；进程重启后用于惰性重建 Agent。 */
  messages?: ChatMessage[];
  /** 子会话真实累计用量；即使 Agent 尚未惰性重建也可观测/恢复。 */
  usage?: Usage;
  /** 后台运行的中止把手（前台运行随父回合的 signal，不设此项）。 */
  abort?: AbortController;
  /** 最终结论（status=done 时有值）。 */
  result?: string;
  error?: string;
  /** 最近活动行（后台任务的可观测性，task_output 展示）。 */
  activity?: string;
  /** isolation=worktree 时的工作目录；任务干净结束后被清理并置 worktreeRemoved。 */
  worktree?: string;
  worktreeRemoved?: boolean;
  /** Unique lease generation; both values are required for every heartbeat/release. */
  worktreeLeaseOwner?: string;
  worktreeFencingToken?: number;
  /** Current run only: a failed per-command fence aborts the child drive before it can retry. */
  worktreeLeaseAbort?: AbortController;
}

/** 不含运行时句柄、可写入 Artifact 的任务状态。 */
export interface PersistedTaskRecord {
  id: string;
  type: string;
  description: string;
  status: TaskStatus;
  background: boolean;
  messages: ChatMessage[];
  usage?: Usage;
  result?: string;
  error?: string;
  activity?: string;
  worktree?: string;
  worktreeRemoved?: boolean;
  worktreeLeaseOwner?: string;
  worktreeFencingToken?: number;
}

export interface TaskUsageCredit {
  taskId: string;
  /** Stable deduplication key: task id + post-run cumulative usage. */
  idempotencyKey: string;
  /** Child task cumulative usage after this run. */
  cumulative: Usage;
  /** Usage newly credited to the parent Conversation by this run. */
  delta: Usage;
  background: boolean;
  signal: AbortSignal;
}

const PERSISTED_TASK_RESTART_ERROR = "宿主重启中断了后台任务；可用 task_send 从耐久上下文继续";

/** 注册表容量：超出后从最老的非 running 记录开始逐出（running 永不逐出）。 */
const TASK_REGISTRY_CAP = 32;
/** 单会话累计派生上限（对齐 Claude Code 的 spawn 总量硬顶思路）—— 防失控循环刷任务。 */
const TASK_SPAWN_CAP = 100;
/** 同时运行的后台任务上限（对齐 Codex max_concurrent_threads_per_session）。 */
const TASK_BACKGROUND_CAP = 8;

export class TaskRegistry {
  private records = new Map<string, TaskRecord>();
  private seq = 0;
  private readonly backgroundRuns = new Set<Promise<void>>();
  private readonly durabilityRuns = new Set<Promise<unknown>>();
  private readonly recoveredNormalizations: TaskRecord[] = [];

  constructor(
    initial: readonly PersistedTaskRecord[] = [],
    private readonly onChange?: (record: PersistedTaskRecord) => void,
    private readonly onEvict?: (taskId: string) => void,
  ) {
    const parsed = initial
      .map(parsePersistedTaskRecord)
      .filter((value): value is PersistedTaskRecord => Boolean(value))
      .sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const dropped = parsed.slice(0, Math.max(0, parsed.length - TASK_REGISTRY_CAP));
    const retained = parsed.slice(-TASK_REGISTRY_CAP);
    for (const value of dropped) {
      queueMicrotask(() => {
        try {
          this.onEvict?.(value.id);
        } catch {
          // An observer cannot make registry recovery fail or surface an uncaught microtask error.
        }
      });
    }
    for (const persisted of retained) {
      const numeric = /^t(\d+)$/.exec(persisted.id)?.[1];
      if (numeric) this.seq = Math.max(this.seq, Number(numeric));
      const restored: TaskRecord = {
        ...persisted,
        messages: [...persisted.messages],
        // A process cannot still own an in-memory background execution after restart. Preserve
        // its checkpoint for task_send, but expose a truthful terminal state until explicitly resumed.
        ...(persisted.status === "running"
          ? {
              status: "stopped" as const,
              error: PERSISTED_TASK_RESTART_ERROR,
            }
          : {}),
      };
      this.records.set(persisted.id, restored);
      if (persisted.status === "running") this.recoveredNormalizations.push(restored);
    }
  }

  nextId(): string {
    if (this.seq >= TASK_SPAWN_CAP)
      throw new ToolError(`本会话子 agent 派生数已达上限 ${TASK_SPAWN_CAP}`);
    return `t${++this.seq}`;
  }

  /** 运行中的后台任务数（并发上限判定用）。 */
  backgroundRunning(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.status === "running" && r.abort) n++;
    return n;
  }

  assertBackgroundSlot(): void {
    if (this.backgroundRunning() >= TASK_BACKGROUND_CAP)
      throw new ToolError(
        `后台任务并发已达上限 ${TASK_BACKGROUND_CAP}；等待通知或用 task_stop 释放`,
      );
  }

  add(record: TaskRecord): void {
    this.records.set(record.id, record);
    this.changed(record);
    if (this.records.size > TASK_REGISTRY_CAP) {
      for (const [id, r] of this.records) {
        if (r.status !== "running") {
          this.records.delete(id);
          try {
            this.onEvict?.(id);
          } catch {
            // Eviction already happened; observer failures cannot corrupt registry bookkeeping.
          }
          break;
        }
      }
    }
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  list(): TaskRecord[] {
    return [...this.records.values()];
  }

  /** 把当前 Agent 历史 checkpoint 化并通知耐久宿主。 */
  changed(record: TaskRecord): void {
    if (record.agent && Array.isArray(record.agent.messages)) {
      record.messages = [...record.agent.messages];
      record.usage = { ...record.agent.totalUsage };
    }
    this.onChange?.(serializeTaskRecord(record));
  }

  trackBackground(run: Promise<void>): void {
    this.backgroundRuns.add(run);
    void run.then(
      () => this.backgroundRuns.delete(run),
      () => this.backgroundRuns.delete(run),
    );
  }

  /** Track the raw host durability Promise even when the bounded task finalizer stops awaiting it. */
  trackDurability<T>(run: Promise<T>): Promise<T> {
    this.durabilityRuns.add(run);
    void run.then(
      () => this.durabilityRuns.delete(run),
      () => this.durabilityRuns.delete(run),
    );
    return run;
  }

  /**
   * Drain detached runners after stopAll(). An aborted waiter does not discard the underlying
   * runners: a later shutdown/delete fence can call awaitIdle again and still observe them.
   */
  async awaitIdle(signal?: AbortSignal): Promise<void> {
    if (this.backgroundRuns.size === 0 && this.durabilityRuns.size === 0) return;
    while (this.backgroundRuns.size > 0 || this.durabilityRuns.size > 0) {
      const settled = Promise.allSettled([...this.backgroundRuns, ...this.durabilityRuns]);
      if (signal) await raceWithSignal(settled, signal);
      else await settled;
    }
  }

  interruptedAfterRestart(): TaskRecord[] {
    return this.list().filter(
      (record) => record.status === "stopped" && record.error === PERSISTED_TASK_RESTART_ERROR,
    );
  }

  /** Persist running→stopped recovery once, so a second restart does not repeat the interruption. */
  async persistRecoveredNormalization(): Promise<void> {
    await Promise.resolve();
    for (const record of this.recoveredNormalizations.splice(0)) this.changed(record);
  }

  /** 停止全部后台任务（会话销毁时调用）。返回被停掉的数量。 */
  stopAll(): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.status === "running" && r.abort) {
        r.abort.abort();
        r.status = "stopped";
        this.changed(r);
        n++;
      }
    }
    return n;
  }
}

export interface TaskToolOptions {
  /** Agent 构造器注入（避免与 agent.ts 的运行时循环依赖） */
  makeAgent: (opts: AgentOptions) => Agent;
  provider: Provider;
  model: string;
  modelInfo?: AgentModelInfo;
  resolveModel?: (spec: string) => AgentResolvedModel;
  cwd: string;
  /** 父工具集（子集化的来源） */
  tools: ToolRegistry;
  /** 父权限配置 —— 子 agent 的授权请求走同一个 confirm */
  permission?: PermissionConfig;
  /** 继承父级工具策略/审计 hooks（PreToolUse / PostToolUse）。 */
  hooks?: HookRegistration[];
  /**
   * 父 agent 的 HookRunner —— 触发 SubagentStart（可 block 阻止派生）与
   * SubagentStop（观察性）。matcher 匹配的是子 agent 类型名。
   */
  parentHooks?: HookRunner;
  /** 自定义 subagent 类型；general 始终可用 */
  definitions?: SubagentDefinition[];
  defaultMaxTurns?: number;
  /** 继承父级 OS 沙箱策略，避免子 agent 的 bash 成为绕过沙箱的通道。 */
  sandbox?: AgentOptions["sandbox"];
  isolatedRuntime?: AgentOptions["isolatedRuntime"];
  securityPolicy?: AgentOptions["securityPolicy"];
  telemetry?: AgentOptions["telemetry"];
  verifier?: AgentOptions["verifier"];
  contextCompiler?: AgentOptions["contextCompiler"];
  /** Root task budget inherited by every child, including detached background work. */
  runBudget?: AgentOptions["runBudget"];
  /** Current root-send ledger. Captured before a background tool returns/detaches. */
  getRunBudgetLedger?: () => RunBudgetLedger | undefined;
  /** Add child usage to the parent conversation without charging the shared ledger twice. */
  recordUsage?: (usage: Usage) => void;
  /** Durable usage credit emitted after recordUsage, exactly once per runRecord finalization. */
  onTaskUsageCredited?: (credit: TaskUsageCredit) => void | Promise<void>;
  /** Parent durable command fence inherited by every child Agent. */
  beforeToolExecution?: AgentOptions["beforeToolExecution"];
  /** Mandatory local fence inherited through nested worktree subagents. Internal Agent plumbing. */
  internalBeforeToolExecution?: AgentOptions["internalBeforeToolExecution"];
  /** 跨 worker 的 worktree 独占租约。 */
  worktreeOwnership?: WorktreeOwnership;
  networkProxy?: NetworkProxy;
  /** 当前委派层级（根 task 工具为 0，每下派一层编排型子 agent +1）。内部用，勿手填。 */
  depth?: number;
  /** 嵌套委派深度上限；缺省 MAX_SUBAGENT_DEPTH。 */
  maxDepth?: number;
  /**
   * 任务注册表 + 完成通知回调 —— 两者都提供才启用后台/续话能力
   * （background / resume 参数与 task_output / task_stop 工具）。
   * notifyTaskDone 在后台任务收尾时被调用，文本已包好 <task-notification> 信封；
   * 接收方（父 Agent）负责按运行态选择注入方式。
   */
  registry?: TaskRegistry;
  notifyTaskDone?: (text: string) => void;
}

function serializeTaskRecord(record: TaskRecord): PersistedTaskRecord {
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    background: record.background,
    messages: [...(record.messages ?? record.agent?.messages ?? [])],
    usage: { ...(record.agent?.totalUsage ?? record.usage ?? zeroUsage()) },
    ...(record.result !== undefined ? { result: record.result } : {}),
    ...(record.error !== undefined ? { error: record.error } : {}),
    ...(record.activity !== undefined ? { activity: record.activity } : {}),
    ...(record.worktree !== undefined ? { worktree: record.worktree } : {}),
    ...(record.worktreeRemoved !== undefined ? { worktreeRemoved: record.worktreeRemoved } : {}),
    ...(record.worktreeLeaseOwner !== undefined
      ? { worktreeLeaseOwner: record.worktreeLeaseOwner }
      : {}),
    ...(record.worktreeFencingToken !== undefined
      ? { worktreeFencingToken: record.worktreeFencingToken }
      : {}),
  };
}

/**
 * Artifact / runtime recovery boundary. Corrupt or future-version task state is ignored instead of
 * crashing session resume or handing attacker-controlled shapes to a provider.
 */
export function parsePersistedTaskRecord(value: unknown): PersistedTaskRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"] : "";
  const type = typeof record["type"] === "string" ? record["type"] : "";
  const description = typeof record["description"] === "string" ? record["description"] : "";
  const status = record["status"];
  const messages = record["messages"];
  if (!/^t[1-9]\d{0,5}$/.test(id) || !type || type.length > 128) return undefined;
  if (description.length > 4_096) return undefined;
  if (!(["running", "done", "error", "stopped"] as unknown[]).includes(status)) {
    return undefined;
  }
  if (!Array.isArray(messages) || messages.length > 10_000 || !messages.every(isChatMessage)) {
    return undefined;
  }
  const usage = parseUsage(record["usage"]);
  if (record["usage"] !== undefined && !usage) return undefined;
  const worktreeLeaseOwner = optionalBoundedString(record["worktreeLeaseOwner"], 512);
  const worktreeFencingToken = record["worktreeFencingToken"];
  if (record["worktreeLeaseOwner"] !== undefined && !worktreeLeaseOwner) return undefined;
  if (
    worktreeFencingToken !== undefined &&
    (!Number.isSafeInteger(worktreeFencingToken) || Number(worktreeFencingToken) < 1)
  ) {
    return undefined;
  }
  // A partial lease identity is never safe to replay.
  if ((worktreeLeaseOwner === undefined) !== (worktreeFencingToken === undefined)) return undefined;
  const optionalString = (key: string, max: number): string | undefined => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.length <= max ? candidate : undefined;
  };
  return {
    id,
    type,
    description,
    status: status as TaskStatus,
    background: record["background"] === true,
    messages: structuredClone(messages) as ChatMessage[],
    ...(usage ? { usage } : {}),
    ...(optionalString("result", 2_000_000) !== undefined
      ? { result: optionalString("result", 2_000_000)! }
      : {}),
    ...(optionalString("error", 16_384) !== undefined
      ? { error: optionalString("error", 16_384)! }
      : {}),
    ...(optionalString("activity", 4_096) !== undefined
      ? { activity: optionalString("activity", 4_096)! }
      : {}),
    ...(optionalString("worktree", 16_384) !== undefined
      ? { worktree: optionalString("worktree", 16_384)! }
      : {}),
    ...(typeof record["worktreeRemoved"] === "boolean"
      ? { worktreeRemoved: record["worktreeRemoved"] }
      : {}),
    ...(worktreeLeaseOwner ? { worktreeLeaseOwner } : {}),
    ...(worktreeFencingToken !== undefined
      ? { worktreeFencingToken: Number(worktreeFencingToken) }
      : {}),
  };
}

function optionalBoundedString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function zeroUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function parseUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const read = (key: keyof Usage): number | undefined => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0
      ? candidate
      : undefined;
  };
  const inputTokens = read("inputTokens");
  const outputTokens = read("outputTokens");
  const cacheReadTokens = read("cacheReadTokens");
  const cacheWriteTokens = read("cacheWriteTokens");
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function isChatMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message["role"] !== "user" && message["role"] !== "assistant") return false;
  if (!Array.isArray(message["content"]) || message["content"].length > 10_000) return false;
  return message["content"].every(isContentPart);
}

function isContentPart(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const part = value as Record<string, unknown>;
  switch (part["type"]) {
    case "text":
      return (
        typeof part["text"] === "string" &&
        part["text"].length <= 2_000_000 &&
        (part["internal"] === undefined || typeof part["internal"] === "boolean")
      );
    case "thinking":
      return typeof part["text"] === "string" && part["text"].length <= 2_000_000;
    case "tool_call":
      return (
        typeof part["id"] === "string" &&
        part["id"].length <= 1_024 &&
        typeof part["name"] === "string" &&
        part["name"].length <= 1_024 &&
        Boolean(part["args"]) &&
        typeof part["args"] === "object" &&
        !Array.isArray(part["args"])
      );
    case "tool_result":
      return (
        typeof part["toolCallId"] === "string" &&
        part["toolCallId"].length <= 1_024 &&
        typeof part["toolName"] === "string" &&
        part["toolName"].length <= 1_024 &&
        typeof part["content"] === "string" &&
        part["content"].length <= 2_000_000 &&
        (part["isError"] === undefined || typeof part["isError"] === "boolean")
      );
    case "image":
      return (
        typeof part["mediaType"] === "string" &&
        part["mediaType"].length <= 256 &&
        typeof part["data"] === "string" &&
        part["data"].length <= 32_000_000
      );
    default:
      return false;
  }
}

/** createTaskTools 的返回：task 恒有；后台能力启用时附带 task_send / task_output / task_stop。 */
export interface TaskTools {
  task: Tool;
  taskSend?: Tool;
  taskOutput?: Tool;
  taskStop?: Tool;
  all: Tool[];
}

/** 兼容入口：只要 task 工具本体（既有测试/调用方使用）。 */
export function createTaskTool(opts: TaskToolOptions): Tool {
  return createTaskTools(opts).task;
}

export function createTaskTools(opts: TaskToolOptions): TaskTools {
  // A task id is only session-local (every recovered Agent starts again at t1). Lease owners must
  // instead identify this concrete tool instance and acquisition generation so an old runner can
  // never operate a newer lease merely because both happened to be called t1.
  const worktreeOwnerNamespace = randomUUID();
  const newWorktreeOwner = (taskId: string): string =>
    `subagent:${worktreeOwnerNamespace}:${taskId}:${randomUUID()}`;
  const defs = new Map<string, SubagentDefinition>();
  defs.set(GENERAL_SUBAGENT.name, GENERAL_SUBAGENT);
  defs.set(EXPLORE_SUBAGENT.name, EXPLORE_SUBAGENT);
  for (const d of opts.definitions ?? []) defs.set(d.name, d);

  const typeList = [...defs.values()].map((d) => `- ${d.name}: ${d.description}`).join("\n");
  const backgroundEnabled = Boolean(opts.registry && opts.notifyTaskDone);
  const registry = opts.registry;

  const task: Tool = {
    readOnly: false,
    def: {
      name: "task",
      description:
        t(
          "Delegate one independent subtask to a subagent and get back only its final conclusion text — the intermediate steps don't consume your context. " +
            "Good for broad search, multi-file investigation, and independent work. " +
            (backgroundEnabled
              ? "background=true runs it in the background (returns a task id immediately; you'll get a <task-notification> when it finishes; check with task_output, stop with task_stop, continue it with task_send). " +
                'isolation="worktree" runs it in a detached git worktree copy so several writing tasks can run in parallel without conflicts; a clean worktree is auto-removed, a dirty one is kept and its path reported for you to merge. '
              : "") +
            "Read-only types, background tasks, and worktree-isolated tasks may run in parallel; other tasks run sequentially. Available types:\n",
          "把一项独立子任务委派给子 agent 执行，只返回其最终结论文本 —— 中间过程不占用你的上下文。" +
            "适合大范围搜索、多文件调研和独立工作。" +
            (backgroundEnabled
              ? "background=true 后台运行（立即返回任务 id；完成时你会收到 <task-notification> 通知；可用 task_output 查看、task_stop 终止、task_send 续话）。" +
                'isolation="worktree" 让它在独立 git worktree 副本中运行，多个写任务可并行互不冲突；无改动的 worktree 自动清理，有改动则保留并报告路径由你合并。'
              : "") +
            "只读类型、后台任务与 worktree 隔离任务可并行执行；其余按序执行。可用类型：\n",
        ) + typeList,
      parameters: {
        type: "object",
        properties: {
          description: {
            type: "string",
            description: t("Short task title (3–8 words)", "任务的简短标题（3~8 字）"),
          },
          prompt: {
            type: "string",
            description: t(
              "The full task instruction for the subagent (it can't see your conversation history, so make it self-contained)",
              "给子 agent 的完整任务指令（它看不到你的对话历史，需自包含）",
            ),
          },
          subagent_type: {
            type: "string",
            description: t(
              `Subagent type (default general). Options: ${[...defs.keys()].join(", ")}`,
              `子 agent 类型（默认 general）。可选: ${[...defs.keys()].join(", ")}`,
            ),
          },
          ...(backgroundEnabled
            ? {
                background: {
                  type: "boolean",
                  description: t(
                    "Run in the background: returns immediately with a task id; a notification arrives when it finishes",
                    "后台运行：立即返回任务 id，完成时收到通知",
                  ),
                },
                isolation: {
                  type: "string",
                  enum: ["worktree"],
                  description: t(
                    "worktree: run in an isolated detached git worktree (parallel-safe writes)",
                    "worktree：在独立 git worktree 副本中运行（写操作可并行）",
                  ),
                },
              }
            : {}),
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["subagent_type"] ?? "general")}: ${String(i["description"] ?? "")}`,
    // 并发资格：只读调研型无写副作用；background 调用本身立即返回（真正的工作在轮外）；
    // worktree 隔离的写发生在独立副本。三者都可与其他调用并行 fan-out，其余保持串行。
    isConcurrencySafe: (i) => {
      if (i["background"] === true) return true;
      if (i["isolation"] === "worktree") return true;
      return Boolean(defs.get(String(i["subagent_type"] ?? "general"))?.readOnly);
    },
    async run(input, ctx: ToolContext): Promise<string> {
      const taskBudgetLedger = opts.getRunBudgetLedger?.();
      const prompt = String(input["prompt"] ?? "");
      const description = String(input["description"] ?? "");
      if (!prompt) throw new ToolError("prompt 不能为空");
      const background = backgroundEnabled && input["background"] === true;
      const type = String(input["subagent_type"] ?? "general");
      const def = defs.get(type);
      if (!def)
        throw new ToolError(`未知 subagent 类型: ${type}（可选: ${[...defs.keys()].join(", ")}）`);

      // SubagentStart：父级 hook 可否决派生（如策略禁止某类型/预算控制）。
      if (opts.parentHooks?.has("SubagentStart")) {
        const h = await raceWithSignal(
          opts.parentHooks.run({
            event: "SubagentStart",
            cwd: opts.cwd,
            toolName: type,
            subagentType: type,
            taskDescription: description,
            signal: ctx.signal,
          }),
          ctx.signal,
        );
        throwIfAborted(ctx.signal);
        if (h.blocked) throw new ToolError(`SubagentStart hook 拦截: ${h.reason}`);
      }

      if (background) registry!.assertBackgroundSlot();
      // 先取 id（spawn 上限在此判定），再创建 worktree —— 顺序反了会在超限时泄漏 worktree。
      const taskId = registry?.nextId() ?? "t0";

      // isolation=worktree：为子 agent 铺一个 detached worktree 作为 cwd。
      let worktree: string | undefined;
      let worktreeLease: WorktreeLease | undefined;
      if (input["isolation"] === "worktree") {
        if (!backgroundEnabled)
          throw new ToolError("isolation=worktree 仅根 agent 的 task 工具支持");
        worktree = await addWorktree(opts.cwd, ctx.signal);
        throwIfAborted(ctx.signal);
        const owner = newWorktreeOwner(taskId);
        const acquire = opts.worktreeOwnership?.acquire(worktree, owner, 5 * 60_000);
        try {
          if (acquire) worktreeLease = await raceWithSignal(acquire, ctx.signal);
          throwIfAborted(ctx.signal);
        } catch (error) {
          if (acquire && opts.worktreeOwnership) {
            void acquire.then(
              (lease) =>
                opts
                  .worktreeOwnership!.release(worktree!, lease.owner, lease.fencingToken)
                  .catch(() => undefined),
              () => undefined,
            );
          }
          await cleanupWorktree(opts.cwd, worktree).catch(() => undefined);
          throw error;
        }
      }

      throwIfAborted(ctx.signal);
      const record: TaskRecord = {
        id: taskId,
        type,
        description,
        status: "running",
        background,
        ...(worktree ? { worktree } : {}),
        ...(worktreeLease
          ? {
              worktreeLeaseOwner: worktreeLease.owner,
              worktreeFencingToken: worktreeLease.fencingToken,
            }
          : {}),
      };
      try {
        // Build after the record exists: the child command fence reads the record's current lease
        // generation on every side-effecting tool, including after a durable resume/reacquire.
        record.agent = buildChildAgent(def, worktree ?? opts.cwd, [], undefined, record);
        throwIfAborted(ctx.signal);
      } catch (error) {
        if (worktree) {
          await cleanupWorktree(opts.cwd, worktree).catch(() => undefined);
          if (worktreeLease && opts.worktreeOwnership) {
            await opts.worktreeOwnership
              .release(worktree, worktreeLease.owner, worktreeLease.fencingToken)
              .catch(() => undefined);
          }
        }
        throw error;
      }
      registry?.add(record);
      return runRecord(record, prompt, background, ctx, taskBudgetLedger);
    },
  };

  /** 按定义构造子 agent（工具收窄 / 模型解析 / 嵌套编排注册都在这里）。 */
  function buildChildAgent(
    def: SubagentDefinition,
    cwd: string,
    initialMessages: ChatMessage[] = [],
    initialUsage?: Usage,
    worktreeRecord?: TaskRecord,
  ): Agent {
    let resolved: AgentResolvedModel | undefined;
    const resolvedSpec = def.model?.includes("/")
      ? def.model
      : def.model && opts.resolveModel && opts.modelInfo
        ? `${opts.modelInfo.providerId}/${def.model}`
        : undefined;
    if (resolvedSpec) {
      if (!opts.resolveModel) {
        throw new ToolError(
          `subagent 模型 ${def.model} 指定了 provider，但当前 Agent 未配置 resolveModel`,
        );
      }
      try {
        resolved = opts.resolveModel(resolvedSpec);
      } catch (error) {
        throw new ToolError(
          `无法解析 subagent 模型 ${resolvedSpec}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // 工具收窄（派生权限）：
    //   - 默认排除 task 及其配套（task_output/task_stop）—— 子 agent 不能再派子 agent
    //     （防递归 / 上下文与费用失控）；例外：def.orchestrator 型在深度预算内会在下方
    //     重新获得一个 depth+1 的嵌套 task（前台-only，无后台配套）；
    //   - 从「继承全部」的默认集里排除 todo_write —— 子 agent 的清单是隔离的、不展示给用户，
    //     只会污染进度流；显式 def.tools 指定了则尊重；
    //   - readOnly 型：进一步收窄到只读工具，保证「无写副作用」这一并行前提成立。
    //   - 从默认集里排除 kill_shell —— 它为了「清理不该二次确认」而标记 readOnly，
    //     于是会混进 readOnly 型子 agent 的只读工具面，破坏「无写副作用、可并行」的前提：
    //     一个并行调研子 agent 不该能杀掉主 agent 的 dev server。子 agent 仍可用
    //     bash_output 读后台输出（那才是真只读）。显式 def.tools 指定了则尊重。
    const DERIVED_DENY = new Set([
      "task",
      "task_send",
      "task_output",
      "task_stop",
      "todo_write",
      "kill_shell",
    ]);
    let base = def.tools ?? opts.tools.names().filter((n) => !DERIVED_DENY.has(n));
    if (def.readOnly) {
      const readOnlySet = new Set(opts.tools.readOnlyNames());
      base = base.filter((n) => readOnlySet.has(n));
    }
    // disallowedTools 最后应用：无论来自显式 tools 还是继承集，命中即剔除。
    if (def.disallowedTools?.length) {
      const denied = def.disallowedTools;
      base = base.filter((n) => !denied.some((pattern) => globMatch(pattern, n)));
    }
    // task 家族无条件剥离：即便显式 def.tools 列出也不下发 —— task_send/task_output/
    // task_stop 闭包持有父注册表，泄漏给子 agent 等于让它操纵兄弟任务。
    const TASK_FAMILY = new Set(["task", "task_send", "task_output", "task_stop"]);
    const childTools = opts.tools.subset(base.filter((n) => !TASK_FAMILY.has(n)));
    // 编排型子 agent 破例保留 task：注册一个 depth+1 的嵌套委派工具，使其能再往下派，
    // 直到 maxDepth 上限后即便编排型也不再下发（防无限递归 / 上下文与费用失控）。
    // 嵌套工具从同一份父全量工具集（opts.tools）子集化，故孙 agent 的工具面与子 agent 一致。
    // 嵌套 task 不带 registry/notify —— 前台-only（编排子 agent 结束后没人接收后台通知）。
    const depth = opts.depth ?? 0;
    const maxDepth = opts.maxDepth ?? MAX_SUBAGENT_DEPTH;
    if (def.orchestrator && depth < maxDepth) {
      const { registry: _r, notifyTaskDone: _n, ...rest } = opts;
      childTools.register(createTaskTool({ ...rest, depth: depth + 1 }));
    }
    const inheritedLocalFence = opts.internalBeforeToolExecution;
    const internalBeforeToolExecution: AgentOptions["internalBeforeToolExecution"] =
      inheritedLocalFence || (worktreeRecord?.worktree && opts.worktreeOwnership)
        ? async (request) => {
            // Outer worktree guards run first. This record's exact generation check remains the
            // last awaited operation before ToolExecutor dispatches the actual side effect.
            await inheritedLocalFence?.(request);
            if (!worktreeRecord?.worktree || !opts.worktreeOwnership) return;
            const owner = worktreeRecord.worktreeLeaseOwner;
            const fencingToken = worktreeRecord.worktreeFencingToken;
            if (!owner || !Number.isSafeInteger(fencingToken) || fencingToken! < 1) {
              const error = new Error(
                `任务 ${worktreeRecord.id} 缺少可信的 worktree fencing lease`,
              );
              worktreeRecord.worktreeLeaseAbort?.abort(error);
              throw error;
            }
            try {
              await opts.worktreeOwnership.heartbeat(
                worktreeRecord.worktree,
                owner,
                5 * 60_000,
                fencingToken,
              );
            } catch (error) {
              worktreeRecord.worktreeLeaseAbort?.abort(error);
              throw error;
            }
          }
        : undefined;
    return opts.makeAgent({
      provider: resolved?.provider ?? opts.provider,
      model: resolved?.model ?? def.model ?? opts.model,
      ...(!def.model && opts.modelInfo
        ? { modelInfo: opts.modelInfo }
        : resolved?.modelInfo
          ? { modelInfo: resolved.modelInfo }
          : {}),
      ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
      cwd,
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      ...(opts.isolatedRuntime ? { isolatedRuntime: opts.isolatedRuntime } : {}),
      ...(opts.networkProxy ? { networkProxy: opts.networkProxy } : {}),
      ...(opts.securityPolicy ? { securityPolicy: opts.securityPolicy } : {}),
      ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
      ...(opts.verifier ? { verifier: opts.verifier } : {}),
      ...(opts.contextCompiler ? { contextCompiler: opts.contextCompiler } : {}),
      system: def.system ?? subagentSystem(),
      ...(def.effort ? { effort: def.effort } : {}),
      // 子 agent 不重复采集环境（每次都 spawn git，量大时拖慢）；父会话已接地。
      injectEnv: false,
      tools: childTools,
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.hooks?.length ? { hooks: opts.hooks } : {}),
      maxTurns: def.maxTurns ?? opts.defaultMaxTurns ?? 30,
      ...(opts.runBudget ? { runBudget: opts.runBudget } : {}),
      ...(opts.beforeToolExecution ? { beforeToolExecution: opts.beforeToolExecution } : {}),
      ...(internalBeforeToolExecution ? { internalBeforeToolExecution } : {}),
      ...(initialMessages.length > 0 ? { initialMessages } : {}),
      ...(initialUsage ? { initialUsage } : {}),
    });
  }

  /**
   * Validate/reacquire a retained worktree immediately before a resumed drive. Persisted owner
   * fields are only hints: a restart may outlive their TTL, so an exact heartbeat must succeed or
   * a fresh unique owner/generation is acquired before the Agent is constructed or reused.
   */
  async function ensureWorktreeLease(record: TaskRecord, signal: AbortSignal): Promise<void> {
    if (!record.worktree || !opts.worktreeOwnership) return;
    record.worktree = await raceWithSignal(
      validateRecoveredWorktree(opts.cwd, record.worktree),
      signal,
    );
    throwIfAborted(signal);

    const existingOwner = record.worktreeLeaseOwner;
    const existingToken = record.worktreeFencingToken;
    if (existingOwner && Number.isSafeInteger(existingToken) && existingToken! >= 1) {
      try {
        await raceWithSignal(
          opts.worktreeOwnership.heartbeat(
            record.worktree,
            existingOwner,
            5 * 60_000,
            existingToken,
          ),
          signal,
        );
        return;
      } catch {
        throwIfAborted(signal);
        // Never release a generation that failed its exact heartbeat: it may already belong to a
        // newer worker. Clear only our stale local claim, then compete for a fresh generation.
        delete record.worktreeLeaseOwner;
        delete record.worktreeFencingToken;
        registry?.changed(record);
      }
    } else if (existingOwner || existingToken !== undefined) {
      delete record.worktreeLeaseOwner;
      delete record.worktreeFencingToken;
      registry?.changed(record);
    }

    const owner = newWorktreeOwner(record.id);
    const acquire = opts.worktreeOwnership.acquire(record.worktree, owner, 5 * 60_000);
    try {
      const lease = await raceWithSignal(acquire, signal);
      throwIfAborted(signal);
      record.worktreeLeaseOwner = lease.owner;
      record.worktreeFencingToken = lease.fencingToken;
      registry?.changed(record);
    } catch (error) {
      // Cancellation can win the race while the durable store still grants the lease. Release the
      // exact late generation so an abandoned resume cannot block another worker for the full TTL.
      void acquire.then(
        (lease) =>
          opts
            .worktreeOwnership!.release(record.worktree!, lease.owner, lease.fencingToken)
            .catch(() => undefined),
        () => undefined,
      );
      delete record.worktreeLeaseOwner;
      delete record.worktreeFencingToken;
      throw error;
    }
  }

  /**
   * 驱动一条任务记录跑一轮（新任务与 resume 共用）。
   * 前台：随父回合 signal，事件经 ctx.emit 回流，返回最终结论。
   * 后台：独立 AbortController（父回合中断不影响它），立即返回任务 id；
   *       收尾时把结果包成 <task-notification> 经 notifyTaskDone 交回父 Agent。
   */
  function runRecord(
    record: TaskRecord,
    prompt: string,
    background: boolean,
    ctx: ToolContext,
    budgetLedger = opts.getRunBudgetLedger?.(),
  ): Promise<string> | string {
    record.status = "running";
    record.background = background;
    const child = record.agent;
    if (!child) throw new ToolError(`任务 ${record.id} 的耐久上下文无法恢复`);
    const leaseAbort = new AbortController();
    record.worktreeLeaseAbort = leaseAbort;
    registry?.changed(record);
    const usageBefore = { ...child.totalUsage };
    const verifyWorktreeLease = async (signal: AbortSignal): Promise<void> => {
      if (!record.worktree || !opts.worktreeOwnership) return;
      const owner = record.worktreeLeaseOwner;
      const fencingToken = record.worktreeFencingToken;
      if (!owner || !Number.isSafeInteger(fencingToken) || fencingToken! < 1) {
        const error = new Error(`任务 ${record.id} 缺少可信的 worktree fencing lease`);
        leaseAbort.abort(error);
        throw error;
      }
      try {
        await raceWithSignal(
          opts.worktreeOwnership.heartbeat(record.worktree, owner, 5 * 60_000, fencingToken),
          signal,
        );
      } catch (error) {
        if (!signal.aborted) leaseAbort.abort(error);
        throw error;
      }
    };
    let ownershipHeartbeatTail: Promise<void> = Promise.resolve();
    const ownershipHeartbeat =
      record.worktree && opts.worktreeOwnership
        ? setInterval(() => {
            const owner = record.worktreeLeaseOwner;
            const fencingToken = record.worktreeFencingToken;
            if (!owner || !Number.isSafeInteger(fencingToken) || fencingToken! < 1) {
              leaseAbort.abort(new Error(`任务 ${record.id} 缺少可信的 worktree fencing lease`));
              return;
            }
            ownershipHeartbeatTail = ownershipHeartbeatTail
              .then(() =>
                opts.worktreeOwnership!.heartbeat(
                  record.worktree!,
                  owner,
                  5 * 60_000,
                  fencingToken,
                ),
              )
              .catch((error: unknown) => {
                leaseAbort.abort(error);
              });
          }, 60_000)
        : undefined;
    ownershipHeartbeat?.unref?.();

    let finalization: Promise<string> | null = null;
    const finish = (
      errorMsg: string | null,
      aborted: boolean,
      finishSignal: AbortSignal,
    ): Promise<string> => {
      if (finalization) return finalization;
      const operation = (async () => {
        if (ownershipHeartbeat) clearInterval(ownershipHeartbeat);
        await ownershipHeartbeatTail;
        // task_send 续话会多轮累计，用量按本轮增量计入父会话，避免重复记账。子 Agent
        // 已直接计入共享 tree ledger，这里只更新父 Conversation，绝不二次扣预算。
        const delta = usageDelta(child.totalUsage, usageBefore);
        if (opts.recordUsage) opts.recordUsage(delta);
        else ctx.addUsage?.(delta);
        record.usage = { ...child.totalUsage };
        // 防伪：剥掉子 agent 输出里的通知信封标记，子输出不能伪装成宿主的控制信息。
        const answer = sanitizeChildText(finalAssistantText(child));
        record.status = aborted ? "stopped" : errorMsg ? "error" : "done";
        record.result = answer;
        if (errorMsg) record.error = errorMsg;
        else delete record.error;
        let creditError: unknown;
        if (opts.recordUsage && opts.onTaskUsageCredited) {
          const cumulative = { ...record.usage };
          const durability = deadlineSignal(30_000, "子 agent 用量持久化超时");
          // Defer invocation by one microtask so the raw Promise is registered before host code can
          // settle it. This fence is deliberately independent from the already-aborted run signal.
          const rawCredit = Promise.resolve().then(() =>
            opts.onTaskUsageCredited!({
              taskId: record.id,
              idempotencyKey: usageCreditKey(record.id, cumulative),
              cumulative,
              delta: { ...delta },
              background,
              signal: durability.signal,
            }),
          );
          registry?.trackDurability(rawCredit);
          try {
            await raceWithSignal(rawCredit, durability.signal);
          } catch (error) {
            creditError = error;
            record.status = aborted ? "stopped" : "error";
            record.error = `子 agent 用量持久化失败: ${error instanceof Error ? error.message : String(error)}`;
          } finally {
            durability.dispose();
          }
        }
        let worktreeNote = "";
        if (record.worktree && !record.worktreeRemoved) {
          if (!finishSignal.aborted && opts.worktreeOwnership) {
            try {
              // cleanupWorktree invokes mutating git commands. Revalidate the exact generation at
              // its final boundary just as child side-effect tools do.
              await verifyWorktreeLease(finishSignal);
            } catch (error) {
              record.status = "stopped";
              record.error = `worktree fencing lease 校验失败: ${error instanceof Error ? error.message : String(error)}`;
              throw error;
            }
          }
          const state = finishSignal.aborted
            ? ("kept" as const)
            : await raceWithSignal(
                cleanupWorktree(opts.cwd, record.worktree, finishSignal),
                finishSignal,
              ).catch(() => "kept" as const);
          if (state === "removed") record.worktreeRemoved = true;
          else
            worktreeNote = t(
              `\n[changes kept in worktree: ${record.worktree} — merge or discard them]`,
              `\n[改动保留在 worktree: ${record.worktree} —— 请合并或丢弃]`,
            );
        }
        if (
          record.worktree &&
          opts.worktreeOwnership &&
          record.worktreeLeaseOwner &&
          record.worktreeFencingToken !== undefined &&
          !finishSignal.aborted
        ) {
          try {
            await raceWithSignal(
              opts.worktreeOwnership.release(
                record.worktree,
                record.worktreeLeaseOwner,
                record.worktreeFencingToken,
              ),
              finishSignal,
            );
            delete record.worktreeLeaseOwner;
            delete record.worktreeFencingToken;
          } catch (error) {
            record.status = "stopped";
            record.error = `worktree fencing lease 释放失败: ${error instanceof Error ? error.message : String(error)}`;
            throw error;
          }
        }
        // SubagentStop：观察性，成功/失败都触发（审计/统计用）。
        if (!finishSignal.aborted && opts.parentHooks?.has("SubagentStop")) {
          await raceWithSignal(
            opts.parentHooks.run({
              event: "SubagentStop",
              cwd: opts.cwd,
              toolName: record.type,
              subagentType: record.type,
              taskDescription: record.description,
              isError: errorMsg !== null,
              toolResult: errorMsg ?? answer,
              signal: finishSignal,
            }),
            finishSignal,
          );
        }
        if (creditError && !aborted) throw new ToolError(record.error!);
        if (errorMsg && !aborted) throw new ToolError(`子 agent 失败: ${errorMsg}`);
        return (
          (answer || t("(subagent produced no text conclusion)", "（子 agent 未产出文本结论）")) +
          worktreeNote
        );
      })();
      finalization = operation.finally(() => {
        delete record.abort;
        if (record.worktreeLeaseAbort === leaseAbort) delete record.worktreeLeaseAbort;
        registry?.changed(record);
      });
      return finalization;
    };

    if (!background) {
      return (async () => {
        const runSignal = linkSignals(ctx.signal, budgetLedger?.signal, leaseAbort.signal);
        let errorMsg: string | null = null;
        try {
          if (record.worktree && opts.worktreeOwnership) {
            await verifyWorktreeLease(runSignal.signal);
          }
          for await (const ev of child.send(prompt, runSignal.signal, {
            ...(ctx.traceContext ? { parent: ctx.traceContext } : {}),
            ...(budgetLedger ? { budget: budgetLedger } : {}),
          })) {
            ctx.emit?.(ev satisfies AgentEvent);
            if (ev.type === "error") errorMsg = ev.message;
          }
          if (record.worktree && opts.worktreeOwnership) {
            await verifyWorktreeLease(runSignal.signal);
          }
        } catch (error) {
          errorMsg = error instanceof Error ? error.message : String(error);
        }
        try {
          const out = await finish(errorMsg, runSignal.signal.aborted, runSignal.signal);
          if (!backgroundEnabled) return out; // 嵌套（前台-only）task 无 task_send，不提任务 id
          return `${out}\n${t(`[task id: ${record.id} — use task_send to follow up with this subagent]`, `[任务 id: ${record.id} —— 用 task_send 可继续该子 agent]`)}`;
        } finally {
          runSignal.dispose();
        }
      })();
    }

    // ----- 后台：detach 驱动，完成时通知父 Agent -----
    const abort = new AbortController();
    record.abort = abort;
    // Hold the tree ledger before scheduling the async generator. Without this reservation the
    // root drive could release its last scope before child.send executes its first `.next()`.
    const releaseBudgetReservation = budgetLedger?.hold();
    const detachedSignal = linkSignals(abort.signal, budgetLedger?.signal, leaseAbort.signal);
    const detached = (async () => {
      let errorMsg: string | null = null;
      let out: string;
      try {
        if (record.worktree && opts.worktreeOwnership) {
          await verifyWorktreeLease(detachedSignal.signal);
        }
        for await (const ev of child.send(prompt, detachedSignal.signal, {
          ...(ctx.traceContext ? { parent: ctx.traceContext } : {}),
          ...(budgetLedger ? { budget: budgetLedger } : {}),
        })) {
          // 不再经 ctx.emit 回流（该工具调用已返回，通道已关）；留一条活动行供 task_output。
          if (ev.type === "tool_start") {
            record.activity = `${ev.name}: ${ev.ruleKey}`;
          }
          if (ev.type === "error") errorMsg = ev.message;
          // Conversation history becomes replay-safe only at completed provider/tool boundaries.
          if (ev.type === "user_message" || ev.type === "turn_end" || ev.type === "tool_result") {
            registry?.changed(record);
          }
        }
        if (record.worktree && opts.worktreeOwnership) {
          await verifyWorktreeLease(detachedSignal.signal);
        }
        out = await finish(errorMsg, detachedSignal.signal.aborted, detachedSignal.signal).catch(
          (e: unknown) => {
            errorMsg = e instanceof Error ? e.message : String(e);
            return "";
          },
        );
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
        out = await finish(errorMsg, detachedSignal.signal.aborted, detachedSignal.signal).catch(
          () => "",
        );
      }
      if (detachedSignal.signal.aborted) return; // task_stop / 会话销毁：静默收尾，不再通知
      opts.notifyTaskDone?.(taskNotification(record, errorMsg, out));
    })().finally(() => {
      detachedSignal.dispose();
      releaseBudgetReservation?.();
    });
    registry?.trackBackground(detached);

    return Promise.resolve(
      t(
        `Background task started (id: ${record.id}, type: ${record.type}). You'll get a <task-notification> when it finishes; task_output checks progress, task_stop cancels. Keep working on other things meanwhile — don't idle-wait.`,
        `后台任务已启动（id: ${record.id}，类型: ${record.type}）。完成时你会收到 <task-notification> 通知；task_output 查进度，task_stop 终止。期间请继续其他工作，不要空等。`,
      ),
    );
  }

  if (!backgroundEnabled) return { task, all: [task] };

  const taskSend: Tool = {
    // 续话会驱动子 agent 干活（可能写文件），按副作用工具对待。
    readOnly: false,
    def: {
      name: "task_send",
      description: t(
        "Send a follow-up message to a previous subagent (by task id) — it keeps its full context. Use for follow-up questions, iteration, or new instructions building on its earlier work. background=true detaches like a background task.",
        "给既有子 agent 发后续消息（按任务 id）—— 其上下文完整保留。适合追问、迭代、在其已有工作上追加指令。background=true 则像后台任务一样脱管运行。",
      ),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: t("Task id (e.g. t1)", "任务 id（如 t1）") },
          message: {
            type: "string",
            description: t("The follow-up instruction", "追加的指令"),
          },
          background: {
            type: "boolean",
            description: t(
              "Run the follow-up in the background (notification on finish)",
              "后台运行本次续话（完成时收到通知）",
            ),
          },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["id"] ?? "")}: ${String(i["message"] ?? "").slice(0, 60)}`,
    isConcurrencySafe: (i) => i["background"] === true,
    async run(input, ctx: ToolContext): Promise<string> {
      const taskBudgetLedger = opts.getRunBudgetLedger?.();
      const id = String(input["id"] ?? "");
      const message = String(input["message"] ?? "");
      if (!message) throw new ToolError("message 不能为空");
      const record = registry!.get(id);
      if (!record) {
        const ids = registry!
          .list()
          .map((r) => `${r.id}(${r.status})`)
          .join(", ");
        throw new ToolError(`任务 ${id} 不存在（可能已被逐出）。在册任务: ${ids || "无"}`);
      }
      if (record.status === "running")
        throw new ToolError(`任务 ${id} 仍在运行，用 task_output 查看进度`);
      if (record.abort)
        throw new ToolError(`任务 ${id} 正在中止/持久化收尾，请等待 task_output 状态稳定后再续话`);
      if (record.worktree && record.worktreeRemoved)
        throw new ToolError(`任务 ${id} 的 worktree 已清理，无法继续；请新起任务`);
      if (record.worktree && opts.worktreeOwnership) {
        try {
          await ensureWorktreeLease(record, ctx.signal);
        } catch (error) {
          record.status = "stopped";
          record.error = `恢复 worktree 校验失败: ${error instanceof Error ? error.message : String(error)}`;
          registry!.changed(record);
          throw new ToolError(record.error);
        }
      }
      if (!record.agent) {
        const definition = defs.get(record.type);
        if (!definition) throw new ToolError(`任务 ${id} 的 subagent 类型 ${record.type} 已不存在`);
        record.agent = buildChildAgent(
          definition,
          record.worktree ?? opts.cwd,
          record.messages ?? [],
          record.usage,
          record,
        );
      }
      const background = input["background"] === true;
      if (background) registry!.assertBackgroundSlot();
      return runRecord(record, message, background, ctx, taskBudgetLedger);
    },
  };

  const taskOutput: Tool = {
    readOnly: true,
    def: {
      name: "task_output",
      description: t(
        "Check a background subagent task: status, latest activity, and (when finished) its final conclusion.",
        "查看后台子 agent 任务：状态、最近活动，结束后可取最终结论。",
      ),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: t("Task id (e.g. t1)", "任务 id（如 t1）") },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["id"] ?? ""),
    async run(input): Promise<string> {
      const record = registry!.get(String(input["id"] ?? ""));
      if (!record) {
        const ids = registry!
          .list()
          .map((r) => `${r.id}(${r.status})`)
          .join(", ");
        throw new ToolError(`任务不存在。在册任务: ${ids || "无"}`);
      }
      const u = record.agent?.totalUsage ?? record.usage ?? zeroUsage();
      const lines = [
        `id: ${record.id}  type: ${record.type}  status: ${record.status}`,
        `description: ${record.description}`,
        `usage: in=${u.inputTokens} out=${u.outputTokens}`,
        ...(record.worktree
          ? [
              `worktree: ${record.worktree}${record.worktreeRemoved ? t(" (removed)", "（已清理）") : ""}`,
            ]
          : []),
        ...(record.status === "running" && record.activity
          ? [t(`activity: ${record.activity}`, `当前活动: ${record.activity}`)]
          : []),
        ...(record.error ? [`error: ${record.error}`] : []),
        ...(record.result ? ["", record.result] : []),
      ];
      return lines.join("\n");
    },
  };

  const taskStop: Tool = {
    // 与 kill_shell 同理：终止自己派生的后台任务属清理动作，不应二次确认。
    readOnly: true,
    def: {
      name: "task_stop",
      description: t(
        "Stop a running background subagent task.",
        "终止一个运行中的后台子 agent 任务。",
      ),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: t("Task id (e.g. t1)", "任务 id（如 t1）") },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["id"] ?? ""),
    async run(input): Promise<string> {
      const record = registry!.get(String(input["id"] ?? ""));
      if (!record) throw new ToolError("任务不存在");
      if (record.status !== "running" || !record.abort)
        return t(
          `Task ${record.id} is not running (status: ${record.status})`,
          `任务 ${record.id} 未在运行（状态: ${record.status}）`,
        );
      record.abort.abort();
      record.status = "stopped";
      registry!.changed(record);
      return t(`Task ${record.id} stopped`, `任务 ${record.id} 已终止`);
    },
  };

  return { task, taskSend, taskOutput, taskStop, all: [task, taskSend, taskOutput, taskStop] };
}

/** 剥掉子 agent 输出中的通知信封标记（防伪：子输出不能伪装成宿主控制信息）。 */
function sanitizeChildText(text: string): string {
  return text.replace(/<\/?task-notification[^>]*>/g, "");
}

/** 完成通知信封：模型据此决定消化结果 / resume 追问 / task_output 查详情。 */
function taskNotification(record: TaskRecord, errorMsg: string | null, result: string): string {
  const MAX = 12_000;
  let body = errorMsg
    ? t(`failed: ${errorMsg}`, `失败: ${errorMsg}`)
    : result || record.result || "";
  if (body.length > MAX)
    body =
      body.slice(0, MAX) +
      t("\n…(truncated; task_output for full text)", "\n…（已截断，task_output 看全文）");
  return [
    `<task-notification id="${record.id}">`,
    t(
      `Background subagent task "${record.description}" (${record.id}) ${errorMsg ? "failed" : "finished"}.`,
      `后台子 agent 任务「${record.description}」（${record.id}）${errorMsg ? "失败" : "已完成"}。`,
    ),
    body,
    t(
      `(use task_send with id "${record.id}" to follow up with this subagent)`,
      `（用 task_send 传 id "${record.id}" 可继续与该子 agent 对话）`,
    ),
    `</task-notification>`,
  ].join("\n");
}

function usageDelta(now: Usage, before: Usage): Usage {
  return {
    inputTokens: now.inputTokens - before.inputTokens,
    outputTokens: now.outputTokens - before.outputTokens,
    cacheReadTokens: now.cacheReadTokens - before.cacheReadTokens,
    cacheWriteTokens: now.cacheWriteTokens - before.cacheWriteTokens,
  };
}

function usageCreditKey(taskId: string, usage: Usage): string {
  return `${taskId}:${usage.inputTokens}:${usage.outputTokens}:${usage.cacheReadTokens}:${usage.cacheWriteTokens}`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

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

function linkSignals(...sources: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const source of sources) {
    if (!source) continue;
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

function deadlineSignal(
  timeoutMs: number,
  message: string,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  timer.unref?.();
  return { signal: controller.signal, dispose: () => clearTimeout(timer) };
}

// ---------- worktree 隔离 ----------

/** 在系统临时目录创建一个 detached worktree（当前 HEAD）。非 git 仓库时抛 ToolError。 */
async function addWorktree(cwd: string, signal?: AbortSignal): Promise<string> {
  const dir = path.join(
    WORKTREE_ROOT,
    `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(path.dirname(dir), { recursive: true });
  let plumbing: Awaited<ReturnType<typeof createIsolatedGitPlumbing>> | undefined;
  try {
    const head = (
      await execGit(cwd, ["rev-parse", "HEAD"], { ...(signal ? { signal } : {}) })
    ).stdout.trim();
    await execGit(
      cwd,
      ["worktree", "add", "--no-checkout", "--detach", dir, head],
      signal ? { signal } : {},
    );
    const repository = await validateGitRepository(dir);
    plumbing = await createIsolatedGitPlumbing(dir, path.join(repository.gitDir, "index"));
    await execGit(dir, ["read-tree", head], signal ? { signal } : {}, plumbing.environment);
    await execGit(
      dir,
      ["checkout-index", "-a", "-f"],
      signal ? { signal } : {},
      plumbing.environment,
    );
  } catch (e) {
    // Abort may race after git created metadata/path. Clean the dedicated temp target best-effort;
    // never leave a cancelled spawn that can later be resumed accidentally.
    await execGit(cwd, ["worktree", "remove", "--force", dir]).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw new ToolError(
      `无法创建 worktree（需要 git 仓库且有至少一个 commit）: ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    await plumbing?.cleanup().catch(() => undefined);
  }
  return dir;
}

async function validateRecoveredWorktree(repoCwd: string, candidate: string): Promise<string> {
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("路径不是可信的实体目录");
  }
  const [rootReal, candidateReal] = await Promise.all([
    fs.realpath(WORKTREE_ROOT),
    fs.realpath(candidate),
  ]);
  const relative = path.relative(rootReal, candidateReal);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative === "") {
    throw new Error("路径不在 anicode 专用 worktree 根目录内");
  }

  const [repoCommonRaw, candidateCommonRaw, listed] = await Promise.all([
    execGit(repoCwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execGit(candidateReal, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    execGit(repoCwd, ["worktree", "list", "--porcelain"]),
  ]);
  const [repoCommon, candidateCommon] = await Promise.all([
    fs.realpath(repoCommonRaw.stdout.trim()),
    fs.realpath(candidateCommonRaw.stdout.trim()),
  ]);
  if (repoCommon !== candidateCommon) throw new Error("worktree 不属于当前仓库");
  const registered = listed.stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  const registeredReal = await Promise.all(
    registered.map((entry) => fs.realpath(entry).catch(() => "")),
  );
  if (!registeredReal.includes(candidateReal)) throw new Error("git worktree 元数据未注册此路径");
  return candidateReal;
}

/** 任务收尾：worktree 无改动（工作区干净且 HEAD 未动）→ 移除；否则保留由父 agent 合并。 */
async function cleanupWorktree(
  repoCwd: string,
  dir: string,
  signal?: AbortSignal,
): Promise<"removed" | "kept"> {
  const options = { encoding: "utf8" as const, ...(signal ? { signal } : {}) };
  const [headRepo, headWt] = await Promise.all([
    execGit(repoCwd, ["rev-parse", "HEAD"], options),
    execGit(dir, ["rev-parse", "HEAD"], options),
  ]);
  if (headRepo.stdout.trim() !== headWt.stdout.trim()) return "kept";
  const repository = await validateGitRepository(dir);
  const plumbing = await createIsolatedGitPlumbing(dir, path.join(repository.gitDir, "index"));
  let status: { stdout: string };
  try {
    // Give the config-free control repository the real worktree HEAD. The shared index is then
    // compared without loading the parent repository's clean/process filters or fsmonitor.
    await fs.writeFile(path.join(plumbing.gitDir, "HEAD"), `${headWt.stdout.trim()}\n`, {
      mode: 0o600,
    });
    status = await execGit(dir, ["status", "--porcelain"], options, plumbing.environment);
  } finally {
    await plumbing.cleanup();
  }
  if (status.stdout.trim()) return "kept";
  await execGit(repoCwd, ["worktree", "remove", "--force", dir], options);
  return "removed";
}

/** 取子 agent 最后一条 assistant 消息的文本部分作为结论 */
function finalAssistantText(agent: Agent): string {
  const messages = agent.messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    const text = m.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return "";
}
