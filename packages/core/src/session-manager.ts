/**
 * SessionManager —— 带 pub/sub 的会话总线。core 的多路复用层。
 *
 * 解决旧 daemon 的根本缺陷：事件曾只流向发起 send 的那个连接。这里每个会话是
 * 一个广播源，任意数量的订阅者都能实时收到同一批事件 —— 这才让「CLI 与 App
 * 共享同一会话、互相接管」成立。
 *
 * 职责：
 *   - 持有 live 会话（Agent 实例），按需 create / resume
 *   - send 时驱动 Agent，把每个事件广播给所有订阅者
 *   - 权限请求作为会话事件广播；answerPermission 由任一订阅者裁决（先到先得）
 *   - subscribe 立即回放一份 snapshot（transcript + running），供晚加入者对齐
 *
 * 传输无关：进程内前端直接用它；daemon 只是它之上的一层 socket 转发。
 */

import { t } from "./i18n.js";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { ChatMessage, Usage } from "./types.js";
import {
  Agent,
  validateRunBudgetSnapshot,
  type AgentEvent,
  type AgentOptions,
  type AgentResolvedModel,
  type RunBudgetSnapshot,
} from "./agent.js";
import type { ToolRegistry } from "./tools/tool.js";
import {
  defaultTools,
  RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES,
  restrictedWorkspaceDevelopmentTools,
} from "./tools/index.js";
import type { HookRegistration } from "./hooks.js";
import type { CompactionConfig } from "./context.js";
import type { WebSearchBackend } from "./tools/web-search.js";
import { LspPool, type LspServerConfig } from "./lsp.js";
import { newSessionId, type ISessionStore, type SessionMeta } from "./session.js";
import { defaultSmallModel } from "./provider/registry.js";
import type { BrowserRegistry } from "./browser/cdp.js";
import { appendLocalAllowRules } from "./permission-store.js";
import type {
  PermissionConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionMode,
  PermissionProfile,
} from "./permission.js";
import {
  MemoryArtifactStore,
  type Artifact,
  type ArtifactInput,
  type ArtifactRecord,
  type ArtifactStreamRecord,
  type ArtifactStore,
} from "./runtime/artifacts.js";
import {
  DurableRuntime,
  MemoryRuntimeEventStore,
  type RecoveredRuntimeState,
  type RuntimeEvent,
} from "./runtime/durable.js";
import {
  SessionLifecycleLeaseLostError,
  SessionLifecycleUnavailableError,
  type SessionDeletionClaim,
  type SessionLifecycleStore,
  type SessionOperationLease,
} from "./runtime/session-lifecycle.js";
import {
  CommandInbox,
  DurableOutbox,
  MemoryCommandInboxStore,
  MemoryOutboxStore,
  type DurableCommand,
} from "./runtime/commands.js";
import type { ContextCompiler } from "./runtime/context-compiler.js";
import type { Verifier } from "./runtime/verifier.js";
import type { SpanContext, Telemetry } from "./runtime/telemetry.js";
import { noTelemetry, parseTraceparent, traceparent } from "./runtime/telemetry.js";
import type { SecurityPolicyEngine } from "./security/policy.js";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";
import type { WorktreeOwnership } from "./runtime/worker.js";
import type { NetworkProxy } from "./runtime/network-proxy.js";
import {
  parsePersistedTaskRecord,
  type PersistedTaskRecord,
  type TaskUsageCredit,
} from "./subagent.js";
import { revalidateWorkspaceTrust, type WorkspaceTrustAssessment } from "./workspace-trust.js";
import {
  PatchSetService,
  type PatchSet,
  type PatchSetApproval,
  type PatchSetChangeInput,
  type PatchSetRebaseResult,
  type PatchSetServiceOptions,
} from "./runtime/patchset.js";

// ---------- 对外事件与快照 ----------

/** 会话级事件：包裹 AgentEvent，另加权限询问与运行态变化 */
export interface PendingPermission {
  permId: string;
  toolName: string;
  ruleKey: string;
  input?: Record<string, unknown>;
  cwd?: string;
  ruleParts?: string[];
  rulePartsComplete?: boolean;
  readOnly?: boolean;
  mutatesFiles?: boolean;
  network?: boolean;
  risk?: "low" | "medium" | "high";
}

export type SessionEvent =
  | { type: "agent"; event: AgentEvent }
  | ({ type: "permission_request" } & PendingPermission)
  | { type: "permission_resolved"; permId: string; decision: PermissionAnswer }
  /** 会话标题变化（自动命名或显式改名），供所有订阅端更新 UI。 */
  | { type: "title"; title: string }
  | {
      type: "reverted";
      checkpointId: string;
      restored: number;
      deleted: number;
      /** 本次恢复的维度与截掉的对话消息数（mode 含 conversation 时才非 0）。 */
      mode?: RewindMode;
      removedMessages?: number;
    }
  | { type: "workspace_trust"; assessment: WorkspaceTrustAssessment }
  | { type: "state"; running: boolean };

/** 一个可撤销点：某轮用户输入前的工作区快照。 */
export interface Checkpoint {
  id: string;
  tree: string;
  label: string;
  /** 该轮用户输入进入历史前的消息数（对话回滚的截断点）。 */
  messageCount: number;
}

/** undo/rewind 的恢复维度：仅文件（默认，向后兼容）、仅对话、或两者。 */
export type RewindMode = "files" | "conversation" | "both";

/** allow_remember=本会话记住；allow_always=写入项目本地设置，跨会话生效。 */
export type PermissionAnswer = "allow" | "allow_remember" | "allow_always" | "deny";

/** 后台子 agent 任务的可序列化摘要（晚订阅者/daemon 客户端观测用）。 */
export interface BackgroundTaskSummary {
  id: string;
  type: string;
  description: string;
  status: "running" | "done" | "error" | "stopped";
  background: boolean;
  worktree?: string;
}

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: ChatMessage[];
  usage: Usage;
  /** 会话累计成本估算（美元）；模型无内置价格信息时缺省。 */
  costUSD?: number;
  running: boolean;
  /** 当前 Agent 的权限模式；可选以兼容旧版快照生产者。 */
  permissionMode?: PermissionMode;
  /** 订阅时仍待裁决的权限请求（重连场景不至于卡死） */
  pendingPermissions: PendingPermission[];
  /** 后台子 agent 任务一览（无 task 工具或无任务时为空数组/缺省）。 */
  backgroundTasks?: BackgroundTaskSummary[];
  /** 当前上下文占用（最近一轮真实输入 token / 模型窗口）；未跑过轮次时缺省。 */
  contextUsage?: { tokens: number; window?: number };
  /** Present when the host configured per-workspace trust enforcement. */
  workspaceTrust?: WorkspaceTrustAssessment;
}

export interface SessionSummary extends SessionMeta {
  running: boolean;
}

export type SessionListener = (ev: SessionEvent) => void;

/** firehose 监听者：收到事件所属的 sessionId 与事件本体。 */
export type GlobalListener = (sessionId: string, ev: SessionEvent) => void;

export interface WorkspaceTrustResolver {
  assess(cwd: string): Promise<WorkspaceTrustAssessment>;
}

export type WorkspaceTrustSource =
  WorkspaceTrustResolver | ((cwd: string) => Promise<WorkspaceTrustAssessment>);

interface ScopedWorkspaceIdentity {
  canonicalPath: string;
  device?: string;
  inode?: string;
}

export interface SessionManagerOptions {
  /** 按 model 字符串产出 provider 实例（通常包 createProvider） */
  resolveProvider: (model: string) => AgentResolvedModel;
  store: ISessionStore;
  /** 传入即为所有会话启用工具集（默认 Agent 内置默认工具） */
  tools?: () => ToolRegistry;
  /**
   * Host-capability override for the interactive workspace-trust restricted tool surface.
   * Production composition uses this when the OS cannot enforce native process isolation; project
   * trust and permission answers must not be able to re-introduce process tools.
   */
  restrictedDevelopmentTools?: () => ToolRegistry;
  /** 每会话默认开启压缩 */
  compaction?: Partial<CompactionConfig> | boolean;
  /** 会话权限策略；confirm 始终由 SessionManager 接管并广播给前端。 */
  permission?: Omit<PermissionConfig, "confirm">;
  /**
   * Host intent for an interactive permission UI in an otherwise untrusted workspace.
   *
   * When true, a verifiably untrusted workspace receives the audited restricted development
   * registry in `default` mode so every side effect can be confirmed by the host. This never
   * applies to `inspection-failed`, which remains strict read-only. When omitted, the historical
   * behaviour is preserved: only a requested `default` permission mode opts into this surface.
   */
  allowRestrictedWorkspaceDevelopment?: boolean;
  /** 自定义权限档位（叠加内置 readonly/default/workspace/full），/profile 运行时可切。 */
  permissionProfiles?: AgentOptions["permissionProfiles"];
  /** 新会话启动时应用的档位名（如配置 permissionProfile: "workspace"）。 */
  permissionProfile?: string;
  /**
   * allow_always 授权答复写回 <会话 cwd>/.anicode/settings.local.json，
   * 下次会话经 loadConfig 自动生效（对齐 Claude Code settings.local.json）。默认关。
   */
  persistPermissions?: boolean;
  /** 所有会话共用的 hooks（PreToolUse/PostToolUse/UserPromptSubmit/Stop） */
  hooks?: HookRegistration[];
  /**
   * 启用 task 工具（子 agent 委派）：true=内置 general；数组=追加自定义类型；
   * 对象形态可开 discover（扫描 .claude/agents/*.md 文件系统 agents）。
   */
  subagents?: AgentOptions["subagents"];
  /** 启用 skills 发现与渐进加载。 */
  skills?: AgentOptions["skills"];
  /** 是否注入 cwd 的 AGENTS.md/CLAUDE.md；默认 true。未信任工作区应传 false。 */
  projectMemory?: boolean;
  /**
   * Per-cwd Workspace Trust boundary. A WorkspaceTrustStore is accepted directly; daemon/HTTP
   * hosts may provide an async resolver. Omission preserves the legacy trusted-host behaviour.
   */
  workspaceTrust?: WorkspaceTrustSource;
  /**
   * Reconcile process-level capabilities (for example MCP/plugin sidecars) before a replacement
   * Agent for the new trust boundary can be exposed. Throwing keeps the session fenced closed.
   */
  onWorkspaceTrustChange?: (change: {
    sessionId: string;
    cwd: string;
    previous?: WorkspaceTrustAssessment;
    current: WorkspaceTrustAssessment;
  }) => void | Promise<void>;
  /**
   * Bind this manager to exactly one canonical workspace directory. Session metadata is shared
   * across local hosts, so an App/CLI instance must not be able to discover or open another
   * workspace's sessions merely by knowing an id. Both this path and every session cwd are
   * resolved through realpath; missing/inaccessible paths fail closed. Symlink aliases which
   * resolve to the same directory remain valid.
   *
   * Daemons which intentionally serve multiple workspaces may omit this option and enforce their
   * own authenticated tenancy boundary instead.
   */
  workspaceScope?: string;
  /**
   * 摘要等杂活用的小模型。`true`=按会话 provider 自动推导便宜模型；字符串=显式 spec；
   * 省略/false=用主模型。解析失败会静默回退主模型（见 Agent）。
   */
  smallModel?: boolean | string;
  /** 模型降级链：主模型重试仍失败时按序切换（对齐 Claude Code fallbackModel）。 */
  fallbackModels?: string[];
  /** 单次用户任务的墙钟/token/成本/工具统一硬预算。 */
  runBudget?: AgentOptions["runBudget"];
  /**
   * 首轮结束后自动为无标题会话起名（小模型总结首条输入，对齐 Codex/Claude Code
   * 的会话自动命名）。失败静默。默认关。
   */
  autoTitle?: boolean;
  /** OS 级 bash 沙箱策略（macOS 第一阶段）；也可由 AGENTX_BASH_SANDBOX 覆盖。 */
  sandbox?: AgentOptions["sandbox"];
  /** 每轮用户输入前记工作区 git 快照，支持 undo 回滚文件改动。默认关。 */
  checkpoints?: boolean;
  /** 会话开始时注入 repo map（代码骨架）帮助模型定位。默认关。 */
  repoMap?: AgentOptions["repoMap"];
  /**
   * 启用 web_search 工具（可插拔）。传入一个 WebSearchBackend（tavilyBackend/braveBackend/
   * 自定义，或 webSearchBackendFromEnv() 的返回值）。省略则不启用。
   */
  webSearch?: WebSearchBackend;
  /**
   * 启用 diagnostics 工具：给出语言服务器配置，SessionManager 会为每个会话按其 cwd 惰性
   * 建一个 LspPool 并在 dispose 时统一关闭。空数组/省略则不启用。
   */
  lsp?: LspServerConfig[];
  /**
   * 内置 browser 工具（前端验证）。默认启用（undefined 视为开启，只读、自动放行）；
   * 传 false 关闭，传 BrowserToolOptions 自定义浏览器路径/视口。见 browserToolOptions()。
   */
  browser?: AgentOptions["browser"];
  /** Instance-bound browser ownership scope; shutdown closes only this manager's browsers. */
  browserRegistry?: BrowserRegistry;
  /** 生成会话 id 的时钟/随机源（测试可注入） */
  now?: () => number;
  rand?: () => number;
  /** Durable Runtime 事件事实源；缺省用内存实现，生产宿主应传 FileRuntimeEventStore。 */
  runtime?: DurableRuntime;
  /** Artifact 资源存储；缺省内存，生产宿主应传 FileArtifactStore。 */
  artifacts?: ArtifactStore;
  contextCompiler?: ContextCompiler;
  verifier?: Verifier;
  verificationMaxAttempts?: number;
  securityPolicy?: SecurityPolicyEngine;
  telemetry?: Telemetry;
  isolatedRuntime?: ExecutionRuntime;
  worktreeOwnership?: WorktreeOwnership;
  networkProxy?: NetworkProxy;
  /** prompt 正文与状态的耐久 inbox；缺省内存，生产宿主应传文件实现。 */
  commandInbox?: CommandInbox;
  /** Runtime Event 的 transactional outbox；缺省内存实现。 */
  outbox?: DurableOutbox;
  /** 冷会话载入时自动恢复未完成 command。默认 true。 */
  recoverCommands?: boolean;
  /** Durable producer/delete lease TTL. Production default 30s; primarily configurable for tests. */
  sessionLifecycleLeaseMs?: number;
  /** Durable deletion drain poll interval. Production default 25ms. */
  sessionLifecyclePollMs?: number;
  /**
   * Absolute host-shutdown deadline. Once exceeded the manager permanently fences late
   * projections and rejects shutdown so the process supervisor can escalate to resource/process
   * termination instead of hanging forever on an uncooperative backend. Default 30 seconds.
   */
  shutdownTimeoutMs?: number;
}

interface PendingPerm {
  toolName: string;
  ruleKey: string;
  input?: Record<string, unknown>;
  cwd?: string;
  ruleParts?: string[];
  rulePartsComplete?: boolean;
  readOnly?: boolean;
  mutatesFiles?: boolean;
  network?: boolean;
  risk: NonNullable<PendingPermission["risk"]>;
  resolve: (d: PermissionDecision) => void;
}

function permissionRisk(r: PermissionRequest): NonNullable<PendingPermission["risk"]> {
  const destructive =
    /(?:^|[;&|]\s*)(?:rm\s+-[^\n]*r|sudo\b|mkfs\b|dd\s+if=|git\s+(?:reset\s+--hard|clean\s+-[^\n]*f)|chmod\s+-R\b|chown\s+-R\b)/i.test(
      r.ruleKey,
    );
  if (r.network || r.rulePartsComplete === false || destructive) return "high";
  if (r.mutatesFiles || r.readOnly === false) return "medium";
  return "low";
}

interface SendWaiter {
  resolve: (outcome: SendOutcome) => void;
  reject: (err: Error) => void;
  steering: boolean;
}

interface SendOutcome {
  /** AgentEvent.error 属于正常可观察终态，不改变既有 send Promise 的兼容语义。 */
  error?: Error;
}

interface CommandLeaseHeartbeat {
  assertOwned(): Promise<void>;
  stop(): Promise<void>;
}

interface RecoveredSessionProjection {
  checkpoints: Checkpoint[];
  usage?: Usage;
  lastInputTokens?: number;
  tasks?: PersistedTaskRecord[];
}

interface PendingSend extends SendWaiter {
  text: string;
  /** per-prompt 模型覆盖：仅这一次 drive 用该模型。 */
  model?: string;
  /** 崩溃恢复：输入是内部续跑指令，不重复原始用户 prompt。 */
  resume?: boolean;
  traceParent?: SpanContext;
  /** Durable ledger state for exactly this root command; steering shares the current ledger. */
  runBudgetSnapshot?: RunBudgetSnapshot;
  beforeToolExecution?: AgentOptions["beforeToolExecution"];
  onRunBudgetCheckpoint?: AgentOptions["onRunBudgetCheckpoint"];
}

type ResolvedProvider = ReturnType<SessionManagerOptions["resolveProvider"]>;

const SESSION_OPERATION_LEASE_MS = 30_000;
const SESSION_LIFECYCLE_POLL_MS = 25;
const SESSION_MANAGER_SHUTDOWN_TIMEOUT_MS = 30_000;
const DELETED_SESSION_RECONCILIATION_INTERVAL_MS = 60_000;
const DELETED_SESSION_RECONCILIATION_BATCH = 100;
const MAX_SUBAGENT_STATE_BYTES = 32_000_000;
const MAX_SUBAGENT_STATE_SESSION_BYTES = 128_000_000;
const SUBAGENT_STATE_MEDIA_TYPE = "application/vnd.anicode.subagent-state+json";
const SUBAGENT_CHECKPOINTS_PER_TASK = 2;
const MAX_RUNTIME_FAILURES_PER_SESSION = 128;
const MAX_DURABILITY_FAILURE_DETAILS = 64;

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined;
}

function usageValue(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(input["inputTokens"]);
  const outputTokens = nonNegativeInteger(input["outputTokens"]);
  const cacheReadTokens = nonNegativeInteger(input["cacheReadTokens"]);
  const cacheWriteTokens = nonNegativeInteger(input["cacheWriteTokens"]);
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

function addUsage(current: Usage | undefined, delta: Usage): Usage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + delta.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + delta.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + delta.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + delta.cacheWriteTokens,
  };
}

function checkpointValue(data: Record<string, unknown>): Checkpoint | undefined {
  const id = data["id"];
  const tree = data["tree"];
  const label = data["label"];
  const messageCount = nonNegativeInteger(data["messageCount"]);
  if (
    typeof id !== "string" ||
    !id ||
    typeof tree !== "string" ||
    !tree ||
    typeof label !== "string" ||
    messageCount === undefined
  ) {
    return undefined;
  }
  return { id, tree, label, messageCount };
}

function isInternalArtifact(artifact: Artifact): boolean {
  return artifact.mediaType === SUBAGENT_STATE_MEDIA_TYPE;
}

// ---------- 一个受管会话 ----------

class ManagedSession {
  readonly meta: SessionMeta;
  private agent: Agent;
  private eventQueue: SessionEvent[] = [];
  private emitting = false;
  private pending = new Map<string, PendingPerm>();
  private abort: AbortController | null = null;
  private permSeq = 0;
  private driving = false;
  private checkpoints: Checkpoint[];
  private pendingSends: PendingSend[] = [];
  private currentWaiters: SendWaiter[] = [];
  private idleWaiters = new Set<() => void>();
  private closed = false;

  constructor(
    meta: SessionMeta,
    makeAgent: (confirm: (r: PermissionRequest) => Promise<PermissionDecision>) => Agent,
    private readonly onEvent?: (event: SessionEvent) => void,
    private readonly workspaceTrust?: WorkspaceTrustAssessment,
    private readonly restrictedWorkspaceDevelopment = false,
    initialCheckpoints: readonly Checkpoint[] = [],
    private readonly listeners: Set<SessionListener> = new Set<SessionListener>(),
  ) {
    this.meta = meta;
    this.checkpoints = initialCheckpoints.map((checkpoint) => ({ ...checkpoint }));
    this.agent = makeAgent((r) => this.onConfirm(r));
  }

  get running(): boolean {
    return this.driving;
  }

  /** deleteSession uses this barrier after aborting a drive, before purging durable state. */
  whenIdle(): Promise<void> {
    if (!this.driving) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  snapshot(): SessionSnapshot {
    const s = this.agent.snapshot();
    const costUSD = this.agent.estimatedCostUSD;
    return {
      meta: { ...this.meta },
      messages: s.messages,
      usage: s.usage,
      ...(costUSD !== undefined ? { costUSD } : {}),
      running: this.running,
      permissionMode: this.agent.getPermissionMode(),
      pendingPermissions: [...this.pending.entries()].map(([permId, p]) => ({
        permId,
        toolName: p.toolName,
        ruleKey: p.ruleKey,
        ...(p.input ? { input: p.input } : {}),
        ...(p.cwd ? { cwd: p.cwd } : {}),
        ...(p.ruleParts ? { ruleParts: p.ruleParts } : {}),
        ...(p.rulePartsComplete !== undefined ? { rulePartsComplete: p.rulePartsComplete } : {}),
        ...(p.readOnly !== undefined ? { readOnly: p.readOnly } : {}),
        ...(p.mutatesFiles !== undefined ? { mutatesFiles: p.mutatesFiles } : {}),
        ...(p.network !== undefined ? { network: p.network } : {}),
        risk: p.risk,
      })),
      ...(this.agent.contextUsage ? { contextUsage: this.agent.contextUsage } : {}),
      ...(this.workspaceTrust ? { workspaceTrust: this.workspaceTrust } : {}),
      ...(this.agent.backgroundTasks.length > 0
        ? {
            backgroundTasks: this.agent.backgroundTasks.map((r) => ({
              id: r.id,
              type: r.type,
              description: r.description,
              status: r.status,
              background: r.background,
              ...(r.worktree && !r.worktreeRemoved ? { worktree: r.worktree } : {}),
            })),
          }
        : {}),
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Preserve existing client subscriptions when a trust-boundary refresh replaces the Agent. */
  subscriberSet(): Set<SessionListener> {
    return this.listeners;
  }

  get trustAssessment(): WorkspaceTrustAssessment | undefined {
    return this.workspaceTrust;
  }

  announceWorkspaceTrust(assessment: WorkspaceTrustAssessment): void {
    this.emit({ type: "workspace_trust", assessment });
  }

  private emit(ev: SessionEvent): void {
    this.eventQueue.push(ev);
    if (this.emitting) return;
    this.emitting = true;
    try {
      // listener 可同步 answerPermission；嵌套事件排在当前广播之后，确保每个
      // 观察者都先看到 request、再看到 resolved，不会因重入留下陈旧 prompt。
      while (this.eventQueue.length > 0) {
        const next = this.eventQueue.shift()!;
        this.onEvent?.(next);
        for (const l of this.listeners) {
          try {
            l(next);
          } catch {
            /* 单个订阅者异常不影响其他订阅者 */
          }
        }
      }
    } finally {
      this.emitting = false;
    }
  }

  /** Agent 请求授权 → 广播 permission_request，挂起直到 answer */
  private onConfirm(r: PermissionRequest): Promise<PermissionDecision> {
    const base = r.toolCallId || "perm";
    const permId = this.pending.has(base) ? `${base}_${++this.permSeq}` : base;
    return new Promise((resolve) => {
      const prompt: PendingPermission & { risk: NonNullable<PendingPermission["risk"]> } = {
        permId,
        toolName: r.toolName,
        ruleKey: r.ruleKey,
        input: r.input,
        ...(r.cwd ? { cwd: r.cwd } : {}),
        ...(r.ruleParts ? { ruleParts: r.ruleParts } : {}),
        ...(r.rulePartsComplete !== undefined ? { rulePartsComplete: r.rulePartsComplete } : {}),
        ...(r.readOnly !== undefined ? { readOnly: r.readOnly } : {}),
        ...(r.mutatesFiles !== undefined ? { mutatesFiles: r.mutatesFiles } : {}),
        ...(r.network !== undefined ? { network: r.network } : {}),
        risk: permissionRisk(r),
      };
      this.pending.set(permId, { ...prompt, resolve });
      this.emit({ type: "permission_request", ...prompt });
    });
  }

  answerPermission(permId: string, decision: PermissionAnswer): boolean {
    const p = this.pending.get(permId);
    if (!p) return false;
    this.pending.delete(permId);
    p.resolve(
      decision === "deny"
        ? { behavior: "deny", message: "已拒绝该操作" }
        : {
            behavior: "allow",
            remember:
              decision === "allow_always"
                ? "always"
                : decision === "allow_remember"
                  ? "session"
                  : false,
          },
    );
    // 所有观察者都必须清掉同一个授权提示；仅给请求发起者返回 boolean
    // 无法处理多 TUI/重连观察者的陈旧 UI。
    this.emit({ type: "permission_resolved", permId, decision });
    return true;
  }

  /**
   * 驱动一次 loop，广播事件给所有订阅者。
   * 运行中再次 send = steering：注入 Agent 的输入队列（turn 边界生效），
   * 对应的 user_message(queued) 事件由 Agent 在注入时广播；Promise 在该 drive
   * 真正收尾后才 resolve，避免持久化尚未完成就向调用方报告成功。
   */
  send(
    text: string,
    opts?: {
      model?: string;
      resume?: boolean;
      traceParent?: SpanContext;
      runBudgetSnapshot?: RunBudgetSnapshot;
      beforeToolExecution?: AgentOptions["beforeToolExecution"];
      onRunBudgetCheckpoint?: AgentOptions["onRunBudgetCheckpoint"];
    },
  ): Promise<SendOutcome> {
    if (this.closed) {
      return Promise.reject(new Error(t("Session is being deleted", "会话正在删除")));
    }
    this.touch();
    return new Promise((resolve, reject) => {
      if (this.agent.queue(text)) {
        // steering 属于当前 drive；直到该 drive 真正收尾才向调用方报告完成。
        // 注：steering 注入进行中的 drive，per-prompt 模型覆盖不适用（静默忽略）。
        this.currentWaiters.push({ resolve, reject, steering: true });
        return;
      }
      // Agent 已决定 done/error 但 generator 尚在收尾时，作为下一次 drive 排队，
      // 不能塞回一个再也不会 drain 的 Agent 队列。
      this.pendingSends.push({
        text,
        resolve,
        reject,
        steering: false,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.resume ? { resume: true } : {}),
        ...(opts?.traceParent ? { traceParent: opts.traceParent } : {}),
        ...(opts?.runBudgetSnapshot ? { runBudgetSnapshot: opts.runBudgetSnapshot } : {}),
        ...(opts?.beforeToolExecution ? { beforeToolExecution: opts.beforeToolExecution } : {}),
        ...(opts?.onRunBudgetCheckpoint
          ? { onRunBudgetCheckpoint: opts.onRunBudgetCheckpoint }
          : {}),
      });
      if (!this.driving) void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.driving) return;
    this.driving = true;
    this.emit({ type: "state", running: true });
    try {
      while (this.pendingSends.length > 0) {
        const next = this.pendingSends.shift()!;
        this.currentWaiters = [next];
        this.abort = new AbortController();
        try {
          let agentError: Error | undefined;
          for await (const ev of this.agent.send(
            next.text,
            this.abort.signal,
            next.model ||
              next.resume ||
              next.traceParent ||
              next.runBudgetSnapshot ||
              next.beforeToolExecution ||
              next.onRunBudgetCheckpoint
              ? {
                  ...(next.model ? { model: next.model } : {}),
                  ...(next.resume ? { resume: true } : {}),
                  ...(next.traceParent ? { parent: next.traceParent } : {}),
                  ...(next.runBudgetSnapshot ? { runBudgetSnapshot: next.runBudgetSnapshot } : {}),
                  ...(next.beforeToolExecution
                    ? { beforeToolExecution: next.beforeToolExecution }
                    : {}),
                  ...(next.onRunBudgetCheckpoint
                    ? { onRunBudgetCheckpoint: next.onRunBudgetCheckpoint }
                    : {}),
                }
              : undefined,
          )) {
            if (ev.type === "checkpoint") {
              this.checkpoints.push({
                id: ev.id,
                tree: ev.tree,
                label: ev.label,
                messageCount: ev.messageCount,
              });
            }
            if (ev.type === "error") agentError = new Error(ev.message);
            this.emit({ type: "agent", event: ev });
          }
          const outcome: SendOutcome = agentError ? { error: agentError } : {};
          for (const waiter of this.currentWaiters) waiter.resolve(outcome);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          for (const waiter of this.currentWaiters) waiter.reject(error);
        } finally {
          this.currentWaiters = [];
          this.abort = null;
          // 一次 drive 结束时，未答复权限视为拒绝，避免遗留悬挂 Promise。
          for (const [permId] of this.pending) this.answerPermission(permId, "deny");
        }
      }
    } finally {
      this.driving = false;
      // Agent 的最后一次 append/rewrite 已完成；把 live meta 推进到持久化之后，
      // 使当前进程 snapshot 与基于文件 mtime 的 list/load 视图保持一致。
      this.touch();
      this.emit({ type: "state", running: false });
      for (const resolve of this.idleWaiters) resolve();
      this.idleWaiters.clear();
    }
  }

  /** 停止本会话全部后台子 agent 任务（删除/宿主销毁时用；普通 interrupt 不动它们）。 */
  stopBackgroundTasks(): number {
    return this.agent.stopBackgroundTasks();
  }

  /** Wait until detached runners have finished cleanup and emitted their final durable checkpoint. */
  whenBackgroundTasksIdle(): Promise<void> {
    return this.agent.awaitBackgroundTasksIdle();
  }

  runningBackgroundTaskIds(): string[] {
    return this.agent.backgroundTasks
      .filter((task) => task.background && task.status === "running")
      .map((task) => task.id);
  }

  backgroundTaskFailure(taskIds: readonly string[]): Error | undefined {
    const selected = new Set(taskIds);
    const failures = this.agent.backgroundTasks.filter(
      (task) => selected.has(task.id) && (task.status === "error" || task.status === "stopped"),
    );
    if (failures.length === 0) return undefined;
    return new Error(
      failures
        .map((task) => `${task.id} ${task.status}${task.error ? `: ${task.error}` : ""}`)
        .join("; "),
    );
  }

  /** Ordered Conversation append/rewrite fence, including writes whose caller already aborted. */
  whenPersistenceIdle(): Promise<void> {
    return this.agent.awaitPersistenceIdle();
  }

  /** Late-side-effect fence for in-process tools that ignored timeout/abort. */
  whenToolExecutionsIdle(): Promise<void> {
    return this.agent.awaitToolExecutionsIdle();
  }

  closeToolResources(): Promise<void> {
    return this.agent.closeToolResources();
  }

  /** Permanently fence new drives, then abort and drain the current one. */
  close(): void {
    this.closed = true;
    this.interrupt();
  }

  interrupt(): void {
    // 必须先同步关闭 Agent 的 steering 门，再广播 abort。AbortSignal listener
    // 可能同步重入 send；该消息应排入下一 drive，而非注入即将终止的本轮。
    this.agent.clearQueue();
    this.abort?.abort();
    const interrupted = new Error(t("Session interrupted", "会话已中断"));
    for (const waiter of this.currentWaiters.filter((w) => w.steering)) waiter.reject(interrupted);
    this.currentWaiters = this.currentWaiters.filter((w) => !w.steering);
    for (const pending of this.pendingSends.splice(0)) pending.reject(interrupted);
    // 中断时，把待决权限拒掉让 loop 尽快收束
    for (const [permId] of this.pending) this.answerPermission(permId, "deny");
  }

  setPermissionMode(mode: PermissionMode): void {
    if (this.workspaceTrust?.trusted === false) {
      const allowed = this.restrictedWorkspaceDevelopment
        ? mode === "default" || mode === "plan"
        : mode === "plan";
      if (!allowed) {
        throw new Error(
          this.restrictedWorkspaceDevelopment
            ? t(
                "Untrusted workspaces only support default and plan permission modes",
                "未信任工作区仅支持普通与计划权限模式",
              )
            : t(
                "This untrusted workspace is locked to plan mode because it was opened with a non-default permission mode",
                "该未信任工作区以非普通权限模式打开，已锁定为计划模式",
              ),
        );
      }
    }
    this.agent.setPermissionMode(mode);
  }

  getPermissionMode(): PermissionMode {
    return this.agent.getPermissionMode();
  }

  setPermissionProfile(name: string): PermissionMode {
    if (this.workspaceTrust?.trusted === false) {
      throw new Error(
        t(
          `Cannot apply permission profile "${name}" in an untrusted workspace`,
          `未信任工作区不能应用权限档位“${name}”`,
        ),
      );
    }
    return this.agent.setPermissionProfile(name);
  }

  listPermissionProfiles(): Record<string, PermissionProfile> {
    if (this.workspaceTrust?.trusted === false) return {};
    return this.agent.listPermissionProfiles();
  }

  get workspaceRestricted(): boolean {
    return this.workspaceTrust?.trusted === false;
  }

  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /**
   * 撤销/回滚：恢复到某个快照（缺省=最近一个）。回滚后丢弃该快照及其之后的快照，
   * 使连续 undo 逐步回退。运行中拒绝（避免与工具写入竞争）。
   * mode（对齐 Claude Code /rewind 的三个选项）：
   *   files（默认，向后兼容）仅回滚工作区文件；
   *   conversation 仅截断对话历史到该轮之前；
   *   both 两者一起恢复。
   */
  async undo(
    checkpointId?: string,
    mode: RewindMode = "files",
  ): Promise<{ restored: number; deleted: number; removedMessages: number }> {
    if (this.driving)
      throw new Error(
        t("Session is running; interrupt it before undoing", "会话运行中，请先中断再撤销"),
      );
    const store = this.agent.snapshotStore;
    if (!store)
      throw new Error(
        t("This session has no workspace snapshots enabled", "该会话未启用工作区快照"),
      );
    if (this.checkpoints.length === 0)
      throw new Error(t("No snapshot available to undo", "没有可撤销的快照"));
    const idx = checkpointId
      ? this.checkpoints.findIndex((c) => c.id === checkpointId)
      : this.checkpoints.length - 1;
    if (idx < 0)
      throw new Error(t(`Snapshot ${checkpointId} not found`, `未找到快照 ${checkpointId}`));
    const target = this.checkpoints[idx]!;
    const res =
      mode === "conversation"
        ? { restored: 0, deleted: 0 }
        : await store.restore({ tree: target.tree });
    const removedMessages =
      mode === "files" ? 0 : await this.agent.rewindConversation(target.messageCount);
    this.checkpoints.splice(idx); // 丢弃目标及其之后的快照
    this.emit({
      type: "reverted",
      checkpointId: target.id,
      restored: res.restored,
      deleted: res.deleted,
      mode,
      removedMessages,
    });
    return { ...res, removedMessages };
  }

  /** 标题变化广播（自动命名/改名后调用）。 */
  announceTitle(title: string): void {
    this.emit({ type: "title", title });
  }

  /** Serialize metadata rewrite with every Conversation append/rewrite; publish only after commit. */
  async updateTitle(title: string): Promise<void> {
    const next = { ...this.meta, title };
    await this.agent.updatePersistenceMeta(next);
    this.meta.title = title;
    this.announceTitle(title);
  }

  /** 手动压缩上下文（/compact）：立即压缩一次并广播 compacted 事件。运行中拒绝。 */
  async compact(): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    if (this.driving)
      throw new Error(
        t("Session is running; interrupt it before compacting", "会话运行中，请先中断再压缩"),
      );
    const res = await this.agent.compactNow();
    if (res.compacted) {
      this.emit({
        type: "agent",
        event: {
          type: "compacted",
          beforeTokens: res.beforeTokens,
          afterTokens: res.afterTokens,
        },
      });
    }
    this.touch();
    return res;
  }

  /** 同一毫秒内的连续活动也保持严格递增，便于稳定排序与 snapshot 比较。 */
  private touch(): void {
    const previous = Date.parse(this.meta.updatedAt);
    const next = Number.isFinite(previous) ? Math.max(Date.now(), previous + 1) : Date.now();
    this.meta.updatedAt = new Date(next).toISOString();
  }
}

/**
 * Billing-free, deterministic title derivation. Auto-title runs after the root budget is closed;
 * starting another provider stream there would bypass the task ledger and can hang command ACKs.
 */
function localSessionTitle(firstUserText: string): string | null {
  const normalized = firstUserText.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const firstClause = normalized
    .split(/[\n。！？!?，,；;]/u)
    .find((part) => part.trim())
    ?.trim();
  const title = [...(firstClause || normalized)]
    .slice(0, 40)
    .join("")
    .replace(/^["'「『]|["'」』]$/gu, "")
    .trim();
  return title || null;
}

function sameWorkspaceTrustBoundary(
  left: WorkspaceTrustAssessment | undefined,
  right: WorkspaceTrustAssessment | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.trusted === right.trusted &&
    left.reason === right.reason &&
    left.identity?.key === right.identity?.key &&
    left.executionHash === right.executionHash
  );
}

interface ActiveArtifactReader {
  abort(reason: Error): void;
}

function waitForArtifactPromise<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

// ---------- 管理器 ----------

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  /** 冷会话并发 open/send 时共享同一次磁盘加载，避免订阅到被覆盖的孤儿实例。 */
  private loading = new Map<string, Promise<ManagedSession>>();
  private opts: SessionManagerOptions;
  /** 每会话按 cwd 建的 LSP 池；进程销毁时统一关闭，避免遗留语言服务器进程。 */
  private lspPools = new Set<LspPool>();
  private sessionLspPools = new Map<string, LspPool>();
  private readonly lspTerminationTasks = new Map<string, Set<Promise<void>>>();
  private readonly lspTerminationFailures = new Map<string, unknown[]>();
  /** firehose 订阅者：收所有 live 会话的事件（见 subscribeAll）。 */
  private globalListeners = new Set<GlobalListener>();
  readonly runtime: DurableRuntime;
  readonly artifacts: ArtifactStore;
  readonly commandInbox: CommandInbox;
  readonly outbox: DurableOutbox;
  private readonly lifecycle: SessionLifecycleStore;
  private readonly sessionLifecycleLeaseMs: number;
  private readonly sessionLifecyclePollMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly telemetry: Telemetry;
  private readonly workerId = `runtime_${process.pid}_${randomUUID().slice(0, 8)}`;
  private readonly activeCommands = new Map<string, Map<string, DurableCommand>>();
  /**
   * Commands deliberately fenced by a user interrupt. Losing their durable command lease is the
   * expected cancellation path, not evidence that this worker became stale. Keep that distinction
   * explicit so the old drive cannot retire/close the live session that already owns the next
   * interrupt generation.
   */
  private readonly interruptedCommands = new Map<string, Set<string>>();
  /** Synchronous ordering fence: sends invoked before an interrupt cannot arrive after its awaits. */
  private readonly interruptEpochs = new Map<string, number>();
  /** Durable cancellation barrier joined by the next interrupt generation and the aborted drive. */
  private readonly interruptTasks = new Map<string, Promise<void>>();
  private readonly recoveringCommands = new Map<string, Promise<number>>();
  /** 同一工作区、同一会话的并发 resume 只执行一次 PatchSet journal 恢复。 */
  private readonly recoveringPatchSets = new Map<string, Promise<PatchSet[]>>();
  /** UI→runtime 的投影按会话隔离；一个卡住的 stream 不能阻塞其他会话或其删除。 */
  private readonly runtimeWrites = new Map<string, Map<number, Promise<unknown>>>();
  private readonly runtimeWriteSequences = new Map<string, number>();
  /** Rejections stay observable until a producer/shutdown barrier consumes them. */
  private readonly runtimeWriteFailures = new Map<string, Map<number, unknown>>();
  private readonly runtimeWriteFailureOverflow = new Map<
    string,
    { firstSequence: number; count: number }
  >();
  /** A durability failure remains part of shutdown health even after an individual send observed it. */
  private readonly durabilityFailures: unknown[] = [];
  private durabilityFailureCount = 0;
  /**
   * All task checkpoints in one session share a queue: retention/quota accounting and the
   * Artifact→outbox commit sequence must be serializable across different task ids as well.
   */
  private readonly subagentStateWrites = new Map<string, Promise<void>>();
  /** Preserve the public Agent event order across async preflight/lease acquisition. */
  private readonly sessionProjectionTails = new Map<string, Promise<void>>();
  /** Best-effort local title persistence is detached from command acknowledgement but drained. */
  private readonly autoTitleTasks = new Map<string, Promise<void>>();
  /** Old Agent generations retiring after an authoritative command lease loss. */
  private readonly retiringSessions = new Map<string, Promise<void>>();
  /** Root commands whose detached task tree still owns budget/lease callbacks after UI completion. */
  private readonly backgroundCommandFinalizations = new Map<string, Promise<void>>();
  /**
   * A deletion mark is installed synchronously and retained for this manager's lifetime. It is a
   * lifecycle fence: no new load/send/persistence operation may race behind the final purge.
   */
  private readonly deletingSessions = new Set<string>();
  private readonly deletedSessions = new Set<string>();
  private readonly deletionTasks = new Map<string, Promise<void>>();
  /** Deletion retries retain the authoritative cwd even after other stores were partially purged. */
  private readonly deletionWorkspaces = new Map<string, ScopedWorkspaceIdentity>();
  /** Sends and other session-scoped mutations which must drain before content is purged. */
  private readonly activeSessionOperations = new Map<string, Set<Promise<unknown>>>();
  /** Manager-wide reads/recovery scans which are not tied to an already-known session id. */
  private readonly activeManagerOperations = new Set<Promise<unknown>>();
  /** Open payload readers are synchronously revoked when a session enters the deletion fence. */
  private readonly activeArtifactReaders = new Map<string, Set<ActiveArtifactReader>>();
  /** Absolute spelling captured at construction; canonicalization is async and shared. */
  private readonly workspaceScopePath: string | undefined;
  private canonicalWorkspaceScope: Promise<ScopedWorkspaceIdentity> | undefined;
  /** Permanent tombstones are periodically swept to remove late non-transactional backend writes. */
  private deletedReconciliationCursor: string | undefined;
  private deletedReconciliationTask: Promise<void> | undefined;
  private deletedReconciliationTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  /** Set only after the absolute shutdown deadline; late callbacks must become side-effect free. */
  private shutdownTimedOut = false;
  private shutdownTask: Promise<void> | undefined;
  private startupRecoveryTask: Promise<number> | undefined;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    if (
      opts.workspaceScope !== undefined &&
      (typeof opts.workspaceScope !== "string" || opts.workspaceScope.trim().length === 0)
    ) {
      throw new TypeError(
        t("workspaceScope must be a non-empty path", "workspaceScope 必须是非空路径"),
      );
    }
    this.workspaceScopePath =
      opts.workspaceScope !== undefined ? path.resolve(opts.workspaceScope) : undefined;
    this.runtime = opts.runtime ?? new DurableRuntime(new MemoryRuntimeEventStore());
    this.lifecycle = this.runtime.lifecycle;
    this.sessionLifecycleLeaseMs = opts.sessionLifecycleLeaseMs ?? SESSION_OPERATION_LEASE_MS;
    this.sessionLifecyclePollMs = opts.sessionLifecyclePollMs ?? SESSION_LIFECYCLE_POLL_MS;
    this.shutdownTimeoutMs = opts.shutdownTimeoutMs ?? SESSION_MANAGER_SHUTDOWN_TIMEOUT_MS;
    if (
      !Number.isInteger(this.sessionLifecycleLeaseMs) ||
      this.sessionLifecycleLeaseMs < 100 ||
      this.sessionLifecycleLeaseMs > 24 * 60 * 60 * 1_000
    ) {
      throw new TypeError("sessionLifecycleLeaseMs must be an integer from 100 to 86400000");
    }
    if (
      !Number.isInteger(this.sessionLifecyclePollMs) ||
      this.sessionLifecyclePollMs < 1 ||
      this.sessionLifecyclePollMs > 1_000
    ) {
      throw new TypeError("sessionLifecyclePollMs must be an integer from 1 to 1000");
    }
    if (
      !Number.isInteger(this.shutdownTimeoutMs) ||
      this.shutdownTimeoutMs < 10 ||
      this.shutdownTimeoutMs > 5 * 60 * 1_000
    ) {
      throw new TypeError("shutdownTimeoutMs must be an integer from 10 to 300000");
    }
    this.artifacts = opts.artifacts ?? new MemoryArtifactStore();
    this.commandInbox = opts.commandInbox ?? new CommandInbox(new MemoryCommandInboxStore());
    this.outbox = opts.outbox ?? new DurableOutbox(new MemoryOutboxStore(), this.runtime);
    this.telemetry = opts.telemetry ?? noTelemetry;
    // The immediate pass repairs a producer which committed to S3/a remote backend and crashed
    // after its lease expired. Recurring bounded passes cover arbitrarily late backend commits.
    queueMicrotask(() => this.scheduleDeletedSessionReconciliation());
    this.deletedReconciliationTimer = setInterval(
      () => this.scheduleDeletedSessionReconciliation(),
      DELETED_SESSION_RECONCILIATION_INTERVAL_MS,
    );
    this.deletedReconciliationTimer.unref?.();
    if (opts.recoverCommands !== false) {
      // 宿主启动即扫描 inbox，不依赖用户先打开旧会话才恢复。
      queueMicrotask(() => {
        if (this.disposed) return;
        const recovery = this.recoverAllCommands();
        this.startupRecoveryTask = recovery;
        void recovery
          .finally(() => {
            if (this.startupRecoveryTask === recovery) this.startupRecoveryTask = undefined;
          })
          .catch(() => undefined);
      });
    }
  }

  listSessions(): Promise<SessionSummary[]> {
    try {
      this.assertManagerActive();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.trackManagerOperation(this.listSessionsInternal());
  }

  private async listSessionsInternal(): Promise<SessionSummary[]> {
    // Resolve the configured root even for an empty store. A misspelled/inaccessible scope must
    // be observable as a host configuration error, never look like a valid empty workspace.
    if (this.workspaceScopePath) await this.resolveCanonicalWorkspaceScope();
    const metas = await this.opts.store.list();
    const visible: SessionMeta[] = [];
    for (const stored of metas) {
      if (this.deletingSessions.has(stored.id)) continue;
      if (this.workspaceScopePath) {
        try {
          await this.assertWorkspaceInScope(stored.cwd, stored.workspaceIdentity, true);
        } catch {
          // Listing is an information boundary: foreign, missing, and uninspectable workspaces are
          // indistinguishable to a scoped host and therefore omitted rather than disclosed.
          continue;
        }
      }
      const lifecycle = await this.lifecycle.get(stored.id);
      if (lifecycle?.state === "deleting" || lifecycle?.state === "deleted") continue;
      visible.push(stored);
    }
    return visible
      .map((stored) => {
        const live = this.sessions.get(stored.id);
        const liveMeta = live?.meta;
        const meta =
          liveMeta && Date.parse(liveMeta.updatedAt) > Date.parse(stored.updatedAt)
            ? liveMeta
            : stored;
        return { ...meta, running: live?.running ?? false };
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async createSession(input: {
    cwd: string;
    model: string;
    title?: string;
  }): Promise<SessionSummary> {
    this.assertManagerActive();
    // Scope validation is deliberately the first async operation. In particular, provider
    // construction, persistence and runtime events must not run for a foreign cwd. A brand-new
    // session never recovers workspace-wide journals: only an existing owning session may do so.
    const workspace = await this.assertWorkspaceInScope(input.cwd);
    const cwd = workspace.canonicalPath;
    // provider 解析可能因未知配置失败；必须在落盘前完成，避免留下一个永远
    // 无法 open/resume 的孤儿 JSONL。解析结果直接交给 instantiate，勿重复创建。
    const resolved = this.opts.resolveProvider(input.model);
    const workspaceTrust = await this.assessWorkspaceTrust(cwd);
    const id = newSessionId((this.opts.now ?? Date.now)(), this.opts.rand ?? Math.random);
    return this.runNewSessionOperation(id, workspace, async () => {
      const meta = await this.opts.store.create({
        id,
        cwd,
        ...(workspace.device !== undefined && workspace.inode !== undefined
          ? { workspaceIdentity: { device: workspace.device, inode: workspace.inode } }
          : {}),
        model: input.model,
        ...(input.title ? { title: input.title } : {}),
      });
      this.instantiate(meta, [], resolved, workspaceTrust);
      await this.runtime.record({
        streamId: meta.id,
        type: "session.created",
        data: { cwd: meta.cwd, model: meta.model },
        idempotencyKey: `session.created:${meta.id}`,
      });
      return { ...meta, running: false };
    });
  }

  /** resume：从磁盘载入历史，实例化 live 会话（若已在内存则复用） */
  async resumeSession(sessionId: string): Promise<SessionSnapshot> {
    return this.runSessionOperation(sessionId, async () =>
      (await this.ensureLive(sessionId)).snapshot(),
    );
  }

  /**
   * fork：把一个会话的对话历史复制成新会话（对齐 Codex `/fork` 与 Claude Code
   * --fork-session）。原会话不动；新会话从复制点独立演化。
   * upToMessage 可截断到前 N 条消息（分叉到较早的节点）；截断产生的悬空
   * tool_call 等由 Agent 载入时的历史自愈处理。
   */
  async forkSession(
    sessionId: string,
    opts?: { title?: string; upToMessage?: number; model?: string },
  ): Promise<SessionSummary> {
    return this.runSessionOperation(sessionId, async () => {
      const source = await this.ensureLive(sessionId);
      const snap = source.snapshot();
      const messages =
        opts?.upToMessage !== undefined ? snap.messages.slice(0, opts.upToMessage) : snap.messages;
      const model = opts?.model ?? snap.meta.model;
      // Revalidate before model construction or the first write. A previously valid workspace may
      // have disappeared since the source was loaded.
      const workspace = await this.assertWorkspaceInScope(
        snap.meta.cwd,
        snap.meta.workspaceIdentity,
        true,
      );
      const cwd = workspace.canonicalPath;
      // Resolve before writing anything so an invalid model cannot leave an unusable fork behind.
      const resolved = this.opts.resolveProvider(model);
      const workspaceTrust = await this.assessWorkspaceTrust(cwd);
      const id = newSessionId((this.opts.now ?? Date.now)(), this.opts.rand ?? Math.random);
      const title = opts?.title ?? (snap.meta.title ? `${snap.meta.title} (fork)` : undefined);
      return this.runNewSessionOperation(id, workspace, async () => {
        const meta = await this.opts.store.create({
          id,
          cwd,
          ...(workspace.device !== undefined && workspace.inode !== undefined
            ? { workspaceIdentity: { device: workspace.device, inode: workspace.inode } }
            : {}),
          model,
          ...(title ? { title } : {}),
        });
        // 复制的历史整体落盘（rewrite 原子替换含 meta 头的整份文件）。
        await this.opts.store.rewrite(meta, messages);
        this.instantiate(meta, messages, resolved, workspaceTrust);
        return { ...meta, running: false };
      });
    });
  }

  private async loadSession(
    sessionId: string,
    assessedWorkspaceTrust?: WorkspaceTrustAssessment,
    listeners?: Set<SessionListener>,
  ): Promise<ManagedSession> {
    const preflightCwd = await this.preflightSessionWorkspace(sessionId);
    this.assertSessionAvailable(sessionId);
    const data = await this.opts.store.load(sessionId);
    this.assertSessionAvailable(sessionId);
    // The store read is needed to discover the authoritative cwd. Perform no recovery, provider
    // construction, runtime write, or live-session registration before this boundary check.
    const workspace = await this.assertWorkspaceInScope(data.cwd, data.workspaceIdentity, true);
    const cwd = workspace.canonicalPath;
    if (preflightCwd && !this.sameCanonicalWorkspace(preflightCwd, workspace)) {
      // The metadata changed between list() and load(). Do not instantiate from a session that
      // crossed the tenancy boundary during the read.
      throw this.workspaceScopeViolation();
    }
    this.assertSessionAvailable(sessionId);
    const meta: SessionMeta = {
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      cwd,
      ...(data.workspaceIdentity ? { workspaceIdentity: data.workspaceIdentity } : {}),
      model: data.model,
      ...(data.title ? { title: data.title } : {}),
    };
    const workspaceTrust = assessedWorkspaceTrust ?? (await this.assessWorkspaceTrust(meta.cwd));
    this.assertSessionAvailable(sessionId);
    const recoveredPatchSets =
      workspaceTrust?.trusted === false
        ? []
        : await this.recoverWorkspacePatchSets(meta.cwd, meta.id);
    for (const patchset of recoveredPatchSets) {
      await this.runtime.record({
        streamId: meta.id,
        type: "patchset.recovered",
        data: { id: patchset.id, status: patchset.status, error: patchset.error ?? "" },
        idempotencyKey: `patchset.recovered:${patchset.id}`,
      });
    }
    this.assertSessionAvailable(sessionId);
    const resolved = this.opts.resolveProvider(meta.model);
    const recovered = await this.recoverSessionProjection(meta.id);
    this.assertSessionAvailable(sessionId);
    const session = this.instantiate(
      meta,
      data.messages,
      resolved,
      workspaceTrust,
      listeners,
      recovered,
    );
    return session;
  }

  /** 订阅：立即回放 snapshot，之后实时收事件。返回 unsubscribe。 */
  async open(
    sessionId: string,
    listener: SessionListener,
  ): Promise<{ snapshot: SessionSnapshot; close: () => void }> {
    return this.runSessionOperation(sessionId, async () => {
      const session = await this.ensureLive(sessionId);
      const close = session.subscribe(listener);
      return { snapshot: session.snapshot(), close };
    });
  }

  async send(
    sessionId: string,
    text: string,
    opts?: { model?: string; idempotencyKey?: string; traceparent?: string },
  ): Promise<void> {
    const interruptEpoch = this.interruptEpochs.get(sessionId) ?? 0;
    return this.runSessionOperation(sessionId, () =>
      this.sendInternal(sessionId, text, opts, interruptEpoch),
    );
  }

  private async sendInternal(
    sessionId: string,
    text: string,
    opts?: { model?: string; idempotencyKey?: string; traceparent?: string },
    interruptEpoch = this.interruptEpochs.get(sessionId) ?? 0,
  ): Promise<void> {
    this.assertSendGeneration(sessionId, interruptEpoch);
    const interruptTask = this.interruptTasks.get(sessionId);
    if (interruptTask) await interruptTask;
    this.assertSendGeneration(sessionId, interruptEpoch);
    const backgroundFinalization = this.backgroundCommandFinalizations.get(sessionId);
    if (backgroundFinalization) await backgroundFinalization;
    this.assertSendGeneration(sessionId, interruptEpoch);
    // Steering and a new drive share the same authoritative trust refresh. A running Agent may
    // still own shell/MCP capabilities from the previous assessment, so bypassing ensureLive here
    // would let a trust revocation keep those capabilities until the drive happened to finish.
    const session = await this.ensureLive(sessionId);
    this.assertSendGeneration(sessionId, interruptEpoch);
    this.assertSessionAvailable(sessionId);
    const span = this.telemetry.startSpan(
      "anicode.session.prompt",
      {
        "anicode.session.id": sessionId,
        "gen_ai.request.model": opts?.model ?? session.meta.model,
        "anicode.prompt.chars": text.length,
      },
      parseTraceparent(opts?.traceparent),
    );
    const context = span.context();
    const sendOptions = {
      ...(opts?.model ? { model: opts.model } : {}),
      ...(context ? { traceParent: context } : {}),
    };
    let command: DurableCommand;
    let claimed: DurableCommand;
    try {
      command = await this.commandInbox.accept({
        sessionId,
        text,
        ...(opts?.model ? { model: opts.model } : {}),
        ...(context ? { traceparent: traceparent(context) } : {}),
        ...(opts?.idempotencyKey ? { idempotencyKey: opts.idempotencyKey } : {}),
        messageCountBefore: session.snapshot().messages.length,
      });
      if (command.status === "completed") {
        await this.publishCommandTerminalEvent(command);
        span.setStatus({ code: "ok" }).end();
        return;
      }
      if (command.status === "failed" || command.status === "cancelled") {
        await this.publishCommandTerminalEvent(command);
        await this.waitForCommandTerminal(command, interruptEpoch);
        return; // waitForCommandTerminal throws for non-success terminal states.
      }
      try {
        claimed = await this.commandInbox.claim(sessionId, command.id, this.workerId);
      } catch (claimError) {
        // Two HTTP/TUI retries can accept the same immutable payload concurrently. Exactly one
        // claimant executes it; the loser joins the durable terminal result instead of surfacing a
        // spurious lease error or (worse) starting a second provider/tool drive.
        const latest = await this.commandInbox.get(sessionId, command.id);
        if (latest && latest.status !== "accepted") {
          if (
            latest.status === "completed" ||
            latest.status === "failed" ||
            latest.status === "cancelled"
          ) {
            await this.publishCommandTerminalEvent(latest);
          }
          await this.waitForCommandTerminal(latest, interruptEpoch);
          span.setStatus({ code: "ok" }).end();
          return;
        }
        throw claimError;
      }
    } catch (error) {
      span.recordException(error).setStatus({
        code: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      span.end();
      throw error;
    }
    this.activateCommand(claimed);
    const heartbeat = this.startCommandHeartbeat(claimed);
    let commandCompleted = false;
    let ownershipTransferred = false;
    try {
      await this.outbox.publish({
        streamId: sessionId,
        type: "prompt.accepted",
        data: {
          commandId: command.id,
          chars: text.length,
          model: opts?.model ?? session.meta.model,
        },
        idempotencyKey: `command:${command.id}:accepted`,
        ...(context ? { traceId: context.traceId, spanId: context.spanId } : {}),
      });
      // No prompt enters the model-visible steering queue before accept+claim+outbox are durable.
      // Re-check interrupt generation after those awaits; a cancelled generation is finalized as
      // a durable cancelled command rather than becoming an unaudited side effect.
      this.assertSendGeneration(sessionId, interruptEpoch);
      this.assertSessionAvailable(sessionId);
      await heartbeat.assertOwned();
      const runBudgetSnapshot = session.running
        ? undefined
        : await this.recoverRunBudgetSnapshot(sessionId, claimed);
      const effectiveSendOptions = {
        ...sendOptions,
        ...(runBudgetSnapshot ? { runBudgetSnapshot } : {}),
        beforeToolExecution: () => this.assertCommandOwnership(claimed),
        onRunBudgetCheckpoint: (snapshot: RunBudgetSnapshot) =>
          this.persistRunBudgetCheckpoint(claimed, snapshot),
      };
      const steering = session.running ? session.send(text, effectiveSendOptions) : undefined;
      const outcome = await (steering ?? session.send(text, effectiveSendOptions));
      await this.flushRuntimeWrites(sessionId);
      // A normal foreground drive resolves its ManagedSession waiter after abort cleanup. The
      // interrupt operation may already have durably cancelled the command and released its lease
      // by then. Treat that known user-cancellation as the successful completion of interrupt
      // cleanup; asking the heartbeat to prove ownership would misclassify it as lease loss and
      // close the session underneath a same-tick send for the next generation.
      if (this.interruptedCommands.get(sessionId)?.has(command.id)) {
        await this.interruptTasks.get(sessionId);
      }
      const interruptedTerminal = this.interruptedCommands.get(sessionId)?.has(command.id)
        ? await this.commandInbox.get(sessionId, command.id)
        : undefined;
      if (interruptedTerminal?.status === "cancelled") {
        await this.publishCommandTerminalEvent(interruptedTerminal);
        span.setStatus({
          code: "error",
          message: interruptedTerminal.error ?? "cancelled",
        });
        return;
      }
      await heartbeat.assertOwned();
      const latest = await this.commandInbox.get(sessionId, command.id);
      if (latest?.status === "cancelled") {
        await this.publishCommandTerminalEvent(latest);
        span.setStatus({ code: "error", message: latest.error ?? "cancelled" });
      } else if (outcome.error) {
        await this.commandInbox.finish(sessionId, command.id, "failed", outcome.error.message, {
          owner: this.workerId,
          fencingToken: claimed.fencingToken ?? 0,
        });
        await this.publishCommandTerminalEvent({
          ...command,
          status: "failed",
          error: outcome.error.message,
        });
        span.recordException(outcome.error).setStatus({ code: "error" });
      } else {
        const backgroundTaskIds = steering ? [] : session.runningBackgroundTaskIds();
        if (backgroundTaskIds.length > 0) {
          this.finalizeCommandAfterBackgroundTasks(session, claimed, heartbeat, backgroundTaskIds);
          ownershipTransferred = true;
        } else {
          await this.commandInbox.finish(sessionId, command.id, "completed", undefined, {
            owner: this.workerId,
            fencingToken: claimed.fencingToken ?? 0,
          });
          await this.publishCommandTerminalEvent({ ...command, status: "completed" });
          commandCompleted = true;
        }
        span.setStatus({ code: "ok" });
      }
    } catch (error) {
      const terminal = await this.commandInbox.get(sessionId, command.id);
      if (
        terminal &&
        (terminal.status === "completed" ||
          terminal.status === "failed" ||
          terminal.status === "cancelled")
      ) {
        // Do not overwrite a committed terminal state if only its outbox enqueue failed. A retry
        // repairs the missing event using the same deterministic idempotency key.
        await this.publishCommandTerminalEvent(terminal);
        span.recordException(error).setStatus({ code: "error" });
        throw error;
      }
      const cancelled = error instanceof Error && /interrupt|中断/i.test(error.message);
      const terminalError = error instanceof Error ? error.message : String(error);
      await this.commandInbox.finish(
        sessionId,
        command.id,
        cancelled ? "cancelled" : "failed",
        terminalError,
        { owner: this.workerId, fencingToken: claimed.fencingToken ?? 0 },
      );
      await this.publishCommandTerminalEvent({
        ...command,
        status: cancelled ? "cancelled" : "failed",
        error: terminalError,
      });
      span.recordException(error).setStatus({ code: "error" });
      throw error;
    } finally {
      if (!ownershipTransferred) {
        await heartbeat.stop();
        this.deactivateCommand(sessionId, command.id);
      }
      span.end();
    }
    // 自动命名是账单外的本地派生，不再启动第二个 provider stream。它与 command ACK
    // 解耦，但由 shutdown barrier 跟踪，避免一个 UX 增强卡住用户请求。
    if (commandCompleted && this.opts.autoTitle && !session.meta.title)
      this.scheduleAutoTitle(session);
  }

  private scheduleAutoTitle(session: ManagedSession): void {
    if (this.autoTitleTasks.has(session.meta.id) || this.shutdownTimedOut) return;
    const task = this.autoTitle(session).finally(() => {
      if (this.autoTitleTasks.get(session.meta.id) === task) {
        this.autoTitleTasks.delete(session.meta.id);
      }
    });
    this.autoTitleTasks.set(session.meta.id, task);
    void task.catch(() => undefined);
  }

  /**
   * Detached subagents keep the exact root ledger alive after the foreground generator returns.
   * Keep its durable command lease/fencing token active until every descendant has checkpointed
   * and stopped; a later root send waits this barrier so two independent ledgers never overlap on
   * one mutable session.
   */
  private finalizeCommandAfterBackgroundTasks(
    session: ManagedSession,
    command: DurableCommand,
    heartbeat: CommandLeaseHeartbeat,
    taskIds: readonly string[],
  ): void {
    const sessionId = command.sessionId;
    if (this.backgroundCommandFinalizations.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a detached command tree`);
    }
    const finalization = (async () => {
      try {
        await session.whenBackgroundTasksIdle();
        await session.whenPersistenceIdle();
        await this.flushRuntimeWrites(sessionId);
        await heartbeat.assertOwned();
        const current = await this.commandInbox.get(sessionId, command.id);
        if (current?.status === "cancelled") {
          await this.publishCommandTerminalEvent(current);
          return;
        }
        const taskFailure = session.backgroundTaskFailure(taskIds);
        if (taskFailure) {
          await this.commandInbox.finish(sessionId, command.id, "failed", taskFailure.message, {
            owner: this.workerId,
            fencingToken: command.fencingToken ?? 0,
          });
          await this.publishCommandTerminalEvent({
            ...command,
            status: "failed",
            error: taskFailure.message,
          });
          return;
        }
        await this.commandInbox.finish(sessionId, command.id, "completed", undefined, {
          owner: this.workerId,
          fencingToken: command.fencingToken ?? 0,
        });
        await this.publishCommandTerminalEvent({ ...command, status: "completed" });
        if (this.opts.autoTitle && !session.meta.title) this.scheduleAutoTitle(session);
      } catch (error) {
        const terminal = await this.commandInbox.get(sessionId, command.id).catch(() => undefined);
        if (
          terminal &&
          (terminal.status === "completed" ||
            terminal.status === "failed" ||
            terminal.status === "cancelled")
        ) {
          await this.publishCommandTerminalEvent(terminal);
        } else {
          this.retireSessionAfterCommandLeaseLoss(sessionId);
        }
        throw error;
      } finally {
        await heartbeat.stop();
        this.deactivateCommand(sessionId, command.id);
      }
    })();
    this.backgroundCommandFinalizations.set(sessionId, finalization);
    void finalization
      .finally(() => {
        if (this.backgroundCommandFinalizations.get(sessionId) === finalization) {
          this.backgroundCommandFinalizations.delete(sessionId);
        }
      })
      .catch((error) => {
        this.durabilityFailureCount++;
        if (this.durabilityFailures.length < MAX_DURABILITY_FAILURE_DETAILS) {
          this.durabilityFailures.push(error);
        }
      });
  }

  /** Derive a bounded local title; no post-budget provider call or unaccounted model usage. */
  private async autoTitle(session: ManagedSession): Promise<void> {
    try {
      const snap = session.snapshot();
      const firstUser = snap.messages.find((m) => m.role === "user");
      const text = (firstUser?.content ?? [])
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map((p) => p.text)
        .join(" ")
        .trim();
      if (!text) return;
      const title = localSessionTitle(text);
      if (!title || session.meta.title || this.shutdownTimedOut) return;
      await this.runSessionProjection(session.meta.id, async () => {
        if (this.shutdownTimedOut || this.deletingSessions.has(session.meta.id)) return;
        await session.updateTitle(title);
        if (this.shutdownTimedOut || this.deletingSessions.has(session.meta.id)) return;
      });
    } catch {
      /* 起名失败静默——标题只是 UX 加分项 */
    }
  }

  interrupt(sessionId: string): Promise<void> {
    try {
      this.assertManagerActive();
    } catch (error) {
      return Promise.reject(error);
    }
    this.interruptEpochs.set(sessionId, (this.interruptEpochs.get(sessionId) ?? 0) + 1);
    // Establish the steering boundary synchronously. Durable preflight/lease acquisition below may
    // await, but a send invoked in the next statement must already target the next generation.
    const liveSession = this.sessions.get(sessionId);
    const commands = [...(this.activeCommands.get(sessionId)?.values() ?? [])];
    if (commands.length > 0) {
      const interrupted = this.interruptedCommands.get(sessionId) ?? new Set<string>();
      for (const command of commands) interrupted.add(command.id);
      this.interruptedCommands.set(sessionId, interrupted);
    }
    if (this.backgroundCommandFinalizations.has(sessionId)) liveSession?.stopBackgroundTasks();
    liveSession?.interrupt();
    const interruption = this.runSessionOperation(sessionId, async () => {
      for (const command of commands) {
        const current = this.activeCommands.get(sessionId);
        if (current?.get(command.id) === command) {
          current.delete(command.id);
          if (current.size === 0) this.activeCommands.delete(sessionId);
        }
        await this.commandInbox.finish(sessionId, command.id, "cancelled", "user interrupted", {
          owner: this.workerId,
          fencingToken: command.fencingToken ?? 0,
        });
        await this.publishCommandTerminalEvent({
          ...command,
          status: "cancelled",
          error: "user interrupted",
        });
      }
    });
    this.interruptTasks.set(sessionId, interruption);
    const cleanup = () => {
      if (this.interruptTasks.get(sessionId) === interruption) {
        this.interruptTasks.delete(sessionId);
      }
    };
    void interruption.then(cleanup, cleanup);
    return interruption;
  }

  /** 显式触发未完成 command 的恢复；同一会话并发调用共享一次恢复。 */
  recoverCommands(sessionId: string): Promise<number> {
    try {
      this.assertSessionAvailable(sessionId);
    } catch (error) {
      return Promise.reject(error);
    }
    const current = this.recoveringCommands.get(sessionId);
    if (current) return current;
    const work = this.runSessionOperation(sessionId, async () => {
      const session = await this.ensureLive(sessionId);
      return this.recoverSessionCommands(session);
    });
    this.recoveringCommands.set(sessionId, work);
    const cleanup = () => {
      if (this.recoveringCommands.get(sessionId) === work)
        this.recoveringCommands.delete(sessionId);
    };
    void work.then(cleanup, cleanup);
    return work;
  }

  /** 启动恢复扫描：让无客户端连接的守护进程也能继续崩溃前已接收的命令。 */
  recoverAllCommands(): Promise<number> {
    try {
      this.assertManagerActive();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.trackManagerOperation(
      (async () => {
        const sessionIds = await this.commandInbox.store.listSessions();
        const results = await Promise.allSettled(
          sessionIds.map((sessionId) => this.recoverCommands(sessionId)),
        );
        return results.reduce(
          (total, result) => total + (result.status === "fulfilled" ? result.value : 0),
          0,
        );
      })(),
    );
  }

  /** 列出会话的可撤销点（最近的在末尾）。未加载/未启用快照时返回空数组。 */
  listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    return this.runSessionOperation(
      sessionId,
      async () => this.sessions.get(sessionId)?.listCheckpoints() ?? [],
    );
  }

  /** 手动压缩会话上下文（/compact）：立即压缩一次。 */
  compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    return this.runSessionOperation(sessionId, async () => {
      const session = await this.ensureLive(sessionId);
      return session.compact();
    });
  }

  /** 撤销会话到某快照（缺省=最近一个）。mode: files（默认）/conversation/both。 */
  undo(
    sessionId: string,
    checkpointId?: string,
    mode: RewindMode = "files",
  ): Promise<{ restored: number; deleted: number; removedMessages: number }> {
    return this.runSessionOperation(sessionId, async () => {
      const session = await this.ensureLive(sessionId);
      return session.undo(checkpointId, mode);
    });
  }

  /** 运行时切换会话的权限模式。 */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    return this.runSessionOperation(sessionId, async () => {
      const session = await this.ensureLive(sessionId);
      session.setPermissionMode(mode);
    });
  }

  /** 运行时切换会话的权限档位；返回切换后的生效模式。 */
  async setPermissionProfile(sessionId: string, name: string): Promise<PermissionMode> {
    return this.runSessionOperation(sessionId, async () => {
      const session = await this.ensureLive(sessionId);
      return session.setPermissionProfile(name);
    });
  }

  /** 会话可用的权限档位（内置 + 自定义）。 */
  async listPermissionProfiles(sessionId: string): Promise<Record<string, PermissionProfile>> {
    return this.runSessionOperation(sessionId, async () => {
      const session = await this.ensureLive(sessionId);
      return session.listPermissionProfiles();
    });
  }

  /** 同步读取一个 live 会话的当前快照；未加载则返回 undefined（不触发磁盘载入）。 */
  peek(sessionId: string): SessionSnapshot | undefined {
    this.assertManagerActive();
    return this.sessions.get(sessionId)?.snapshot();
  }

  /**
   * 删除会话并清除承载用户内容的关联状态。仅保留一个不含 prompt/response 的 tombstone，
   * 让同步客户端能观察删除，同时避免 SQLite/PostgreSQL/S3 中残留原始内容。
   */
  deleteSession(sessionId: string): Promise<void> {
    try {
      this.assertManagerActive();
    } catch (error) {
      return Promise.reject(error);
    }
    const existing = this.deletionTasks.get(sessionId);
    if (existing) return existing;
    if (this.deletedSessions.has(sessionId)) return Promise.resolve();

    // Install the process-local fence before the first durable await. A cold load that started in
    // the previous tick may finish while claimDeletion is doing I/O; it must observe this marker
    // and reject rather than briefly resurrecting a live Agent.
    this.deletingSessions.add(sessionId);
    this.fenceLocalSessionForDeletion(sessionId);

    // Durable state, rather than this process-local cache, owns retry/resume semantics. A second
    // manager sharing SQLite/PostgreSQL observes the same fence and can finish a partial purge.
    const deletion = this.deleteSessionDurably(sessionId).then(() => {
      this.deletedSessions.add(sessionId);
    });
    this.deletionTasks.set(sessionId, deletion);
    const cleanup = () => {
      if (this.deletionTasks.get(sessionId) === deletion) this.deletionTasks.delete(sessionId);
    };
    void deletion.then(cleanup, cleanup);
    return deletion;
  }

  async putArtifact(input: ArtifactInput): Promise<Artifact> {
    if (input.mediaType === SUBAGENT_STATE_MEDIA_TYPE) {
      throw new Error("Reserved internal artifact media type");
    }
    return this.runSessionOperation(input.sessionId, () => this.artifacts.put(input));
  }

  listArtifacts(sessionId: string): Promise<Artifact[]> {
    return this.runSessionOperation(sessionId, async () =>
      (await this.artifacts.list(sessionId)).filter((artifact) => !isInternalArtifact(artifact)),
    );
  }

  getArtifact(sessionId: string, artifactId: string): Promise<ArtifactRecord | undefined> {
    return this.runSessionOperation(sessionId, async () => {
      const record = await this.artifacts.get(sessionId, artifactId);
      return record && !isInternalArtifact(record.artifact) ? record : undefined;
    });
  }

  async openArtifact(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactStreamRecord | undefined> {
    const controller = new AbortController();
    let source: AsyncIterator<Uint8Array> | undefined;
    let finishLease: () => void = () => undefined;
    let unregister: () => void = () => undefined;
    const reader: ActiveArtifactReader = {
      abort: (reason) => {
        if (!controller.signal.aborted) controller.abort(reason);
        // A consumer may be paused at `yield` and never request another chunk. Release its durable
        // lease synchronously so DELETE can finish, while the aborted wrapper prevents later bytes.
        finishLease();
        void source?.return?.().catch(() => undefined);
        unregister();
      },
    };
    unregister = this.registerArtifactReader(sessionId, reader);

    try {
      const opened = await this.runSessionOperation(sessionId, async () => {
        const pending = this.artifacts.open
          ? this.artifacts.open(sessionId, artifactId, controller.signal)
          : this.artifacts.get(sessionId, artifactId).then((record) =>
              record
                ? {
                    artifact: record.artifact,
                    data: (async function* () {
                      yield record.data;
                    })(),
                  }
                : undefined,
            );
        const record = await waitForArtifactPromise(pending, controller.signal);
        if (!record) return undefined;
        if (isInternalArtifact(record.artifact)) {
          if (!controller.signal.aborted) {
            controller.abort(new Error("Internal artifact is not publicly accessible"));
          }
          const hidden = record.data[Symbol.asyncIterator]();
          // A hostile/remote store may never settle iterator.return(). The public lookup is already
          // decided, so revoke the source and release our lease without letting it hold the caller.
          void hidden.return?.().catch(() => undefined);
          return undefined;
        }
        if (controller.signal.aborted) throw controller.signal.reason;
        source = record.data[Symbol.asyncIterator]();
        return record;
      });
      if (!opened) {
        unregister();
        return undefined;
      }
      if (controller.signal.aborted || !source) throw controller.signal.reason;
      return {
        artifact: opened.artifact,
        data: this.leasedArtifactIterable(sessionId, source, controller, reader, (finish) => {
          finishLease = finish;
          if (controller.signal.aborted) finish();
        }),
      };
    } catch (error) {
      reader.abort(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  private leasedArtifactIterable(
    sessionId: string,
    source: AsyncIterator<Uint8Array>,
    controller: AbortController,
    reader: ActiveArtifactReader,
    setFinishLease: (finish: () => void) => void,
  ): AsyncIterable<Uint8Array> {
    const runOperation = (run: () => Promise<void>) => this.runSessionOperation(sessionId, run);
    let consumed = false;
    return {
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        if (consumed) throw new Error("Artifact stream can only be consumed once");
        consumed = true;
        return (async function* () {
          let readySettled = false;
          let resolveReady!: () => void;
          let rejectReady!: (error: unknown) => void;
          const ready = new Promise<void>((resolve, reject) => {
            resolveReady = resolve;
            rejectReady = reject;
          });
          let finished = false;
          let resolveFinished!: () => void;
          const finishedPromise = new Promise<void>((resolve) => {
            resolveFinished = resolve;
          });
          const finish = () => {
            if (finished) return;
            finished = true;
            resolveFinished();
          };
          setFinishLease(finish);

          const operation = runOperation(async () => {
            if (controller.signal.aborted) throw controller.signal.reason;
            readySettled = true;
            resolveReady();
            await finishedPromise;
          });
          void operation.catch((error) => {
            if (!readySettled) {
              readySettled = true;
              rejectReady(error);
            }
            reader.abort(error instanceof Error ? error : new Error(String(error)));
          });

          let failure: unknown;
          let failed = false;
          try {
            await waitForArtifactPromise(ready, controller.signal);
            for (;;) {
              if (controller.signal.aborted) throw controller.signal.reason;
              const next = await waitForArtifactPromise(
                Promise.resolve(source.next()),
                controller.signal,
              );
              if (controller.signal.aborted) throw controller.signal.reason;
              if (next.done) break;
              yield next.value;
            }
          } catch (error) {
            failed = true;
            failure = error;
          } finally {
            finish();
            reader.abort(failure instanceof Error ? failure : new Error("Artifact stream closed"));
            try {
              await operation;
            } catch (error) {
              if (!failed) {
                failed = true;
                failure = error;
              }
            }
          }
          if (failed) throw failure;
        })();
      },
    };
  }

  async deleteArtifact(sessionId: string, artifactId: string): Promise<boolean> {
    return this.runSessionOperation(sessionId, async () => {
      const record = await this.artifacts.get(sessionId, artifactId);
      if (!record || isInternalArtifact(record.artifact)) return false;
      return this.artifacts.delete(sessionId, artifactId);
    });
  }

  /** 准备一个可预览/审批的事务，不在此步写工作区。 */
  preparePatchSet(
    sessionId: string,
    changes: PatchSetChangeInput[],
    options: Pick<PatchSetServiceOptions, "requiredApprovals" | "requiredRoles"> = {},
  ): Promise<{ patchset: PatchSet; preview: string; artifact: Artifact }> {
    return this.runSessionOperation(sessionId, async () => {
      const { service } = await this.patchSetContext(sessionId, true, options);
      const patchset = await service.prepare(changes);
      const preview = service.preview(patchset);
      const artifact = await this.persistPatchSetArtifact(sessionId, patchset, preview);
      await this.outbox.publish({
        streamId: sessionId,
        type: "patchset.prepared",
        data: { id: patchset.id, status: patchset.status, artifactId: artifact.id },
        idempotencyKey: `patchset:${patchset.id}:prepared`,
      });
      return { patchset, preview, artifact };
    });
  }

  async getPatchSet(
    sessionId: string,
    patchsetId: string,
  ): Promise<{ patchset: PatchSet; preview: string } | undefined> {
    return this.runSessionOperation(sessionId, async () => {
      const { service } = await this.patchSetContext(sessionId, false);
      const patchset = await service.load(patchsetId);
      return patchset ? { patchset, preview: service.preview(patchset) } : undefined;
    });
  }

  approvePatchSet(
    sessionId: string,
    patchsetId: string,
    approval: Omit<PatchSetApproval, "timestamp">,
  ): Promise<PatchSet> {
    return this.runSessionOperation(sessionId, async () => {
      const { service } = await this.patchSetContext(sessionId, false);
      const patchset = await service.approve(patchsetId, approval);
      await this.outbox.publish({
        streamId: sessionId,
        type: "patchset.approval",
        data: {
          id: patchset.id,
          actor: approval.actor,
          role: approval.role,
          decision: approval.decision,
          status: patchset.status,
        },
      });
      return patchset;
    });
  }

  applyPatchSet(sessionId: string, patchsetId: string): Promise<PatchSet> {
    return this.runSessionOperation(sessionId, async () => {
      const { service } = await this.patchSetContext(sessionId, true);
      const current = await service.load(patchsetId);
      if (!current) throw new Error(`Unknown PatchSet: ${patchsetId}`);
      const patchset = await service.apply(current);
      await this.outbox.publish({
        streamId: sessionId,
        type: "patchset.applied",
        data: { id: patchset.id, changes: patchset.changes.length },
        idempotencyKey: `patchset:${patchset.id}:applied`,
      });
      return patchset;
    });
  }

  rollbackPatchSet(sessionId: string, patchsetId: string, force = false): Promise<PatchSet> {
    return this.runSessionOperation(sessionId, async () => {
      const { service } = await this.patchSetContext(sessionId, true);
      const patchset = await service.rollback(patchsetId, force);
      await this.outbox.publish({
        streamId: sessionId,
        type: "patchset.rolled_back",
        data: { id: patchset.id, force },
        idempotencyKey: `patchset:${patchset.id}:rolled_back`,
      });
      return patchset;
    });
  }

  rebasePatchSet(sessionId: string, patchsetId: string): Promise<PatchSetRebaseResult> {
    return this.runSessionOperation(sessionId, async () => {
      const { service } = await this.patchSetContext(sessionId, true);
      const result = await service.rebase(patchsetId);
      const preview = service.preview(result.patchset);
      const artifact = await this.persistPatchSetArtifact(sessionId, result.patchset, preview);
      await this.outbox.publish({
        streamId: sessionId,
        type: "patchset.rebased",
        data: {
          sourceId: patchsetId,
          id: result.patchset.id,
          conflictedPaths: result.conflictedPaths,
          artifactId: artifact.id,
        },
        idempotencyKey: `patchset:${patchsetId}:rebased:${result.patchset.id}`,
      });
      return result;
    });
  }

  runtimeEvents(sessionId: string, afterSequence = 0): Promise<RuntimeEvent[]> {
    return this.runSessionOperation(sessionId, async () =>
      (await this.runtime.events(sessionId, afterSequence)).filter(
        (event) => event.type !== "subagent.state",
      ),
    );
  }

  recoverRuntime(sessionId: string): Promise<RecoveredRuntimeState> {
    return this.runSessionOperation(sessionId, () => this.runtime.recover(sessionId));
  }

  /** 重命名会话标题；与 Conversation append/rewrite 共用一条持久化序列。 */
  async setTitle(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return Promise.resolve();
    return this.runSessionOperation(sessionId, () => this.setTitleInternal(sessionId, trimmed));
  }

  private async setTitleInternal(sessionId: string, title: string): Promise<void> {
    const session = await this.ensureLive(sessionId);
    this.assertSessionAvailable(sessionId);
    await session.updateTitle(title);
  }

  async answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionAnswer,
  ): Promise<boolean> {
    return this.runSessionOperation(
      sessionId,
      async () => this.sessions.get(sessionId)?.answerPermission(permId, decision) ?? false,
    );
  }

  /** 进程内宿主销毁时停止所有 live drive；daemon 断开客户端不会调用此方法。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.deletedReconciliationTimer) clearInterval(this.deletedReconciliationTimer);
    this.deletedReconciliationTimer = undefined;
    const disposed = new Error("SessionManager disposed");
    for (const sessionId of this.activeArtifactReaders.keys()) {
      this.abortArtifactReaders(sessionId, disposed);
    }
    for (const session of this.sessions.values()) {
      session.stopBackgroundTasks();
      session.close();
      // Keep the legacy synchronous dispose contract while still starting instance-bound cleanup.
      // shutdown() awaits the same idempotent promises and reports any failure.
      void session.closeToolResources().catch(() => undefined);
    }
    void this.opts.browserRegistry?.closeAll().catch(() => undefined);
    for (const sessionId of [...this.sessionLspPools.keys()]) {
      void this.closeSessionLspPool(sessionId);
    }
    // dispose 保持同步契约；生产宿主还会在真正退出前显式 await，同步调用方则至少触发发送。
    void Promise.resolve(this.telemetry.forceFlush?.()).catch(() => undefined);
  }

  /**
   * 生产宿主退出门：同步 fence 新工作后，等待 drive、runtime/outbox 与 telemetry 真正落稳。
   * `dispose()` 保留旧同步接口；拥有进程生命周期的宿主必须 await 本方法。
   */
  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.dispose();
    const drain = (async () => {
      const failures: unknown[] = [];
      const settle = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          failures.push(error);
        }
      };
      await this.waitForManagerQuiescence();
      const sessionIds = new Set<string>([
        ...this.sessions.keys(),
        ...this.runtimeWrites.keys(),
        ...this.runtimeWriteFailures.keys(),
        ...this.lspTerminationFailures.keys(),
        ...this.backgroundCommandFinalizations.keys(),
      ]);
      for (const sessionId of sessionIds) {
        await settle(() => this.waitForLspTermination(sessionId));
        await settle(() =>
          this.flushRuntimeWrites(sessionId, { discardFailures: true, dynamic: true }),
        );
      }
      for (const session of this.sessions.values()) {
        await settle(() => session.closeToolResources());
      }
      if (this.opts.browserRegistry) await settle(() => this.opts.browserRegistry!.closeAll());
      failures.push(...this.durabilityFailures);
      if (this.durabilityFailureCount > this.durabilityFailures.length) {
        failures.push(
          new Error(
            `${this.durabilityFailureCount - this.durabilityFailures.length} additional durability failures were suppressed`,
          ),
        );
      }
      await settle(() => this.outbox.flush());
      await settle(() => this.telemetry.forceFlush?.() ?? Promise.resolve());
      if (failures.length) throw new AggregateError(failures, "SessionManager shutdown failed");
    })();
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(() => {
        this.shutdownTimedOut = true;
        reject(
          new Error(
            `SessionManager shutdown exceeded the ${this.shutdownTimeoutMs}ms hard deadline`,
          ),
        );
      }, this.shutdownTimeoutMs);
    });
    this.shutdownTask = Promise.race([drain, deadline]).finally(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
    });
    return this.shutdownTask;
  }

  /** Dynamic barrier: work can have been registered just before dispose installed the fence. */
  private async waitForManagerQuiescence(): Promise<void> {
    for (;;) {
      const sessions = [...this.sessions.values()];
      for (const session of sessions) {
        session.stopBackgroundTasks();
        session.close();
      }
      const pending = new Set<Promise<unknown>>();
      for (const operation of this.activeManagerOperations) pending.add(operation);
      for (const operations of this.activeSessionOperations.values()) {
        for (const operation of operations) pending.add(operation);
      }
      for (const operation of this.loading.values()) pending.add(operation);
      for (const operation of this.recoveringCommands.values()) pending.add(operation);
      for (const operation of this.recoveringPatchSets.values()) pending.add(operation);
      for (const operation of this.deletionTasks.values()) pending.add(operation);
      for (const operations of this.runtimeWrites.values()) {
        for (const operation of operations.values()) pending.add(operation);
      }
      for (const operation of this.subagentStateWrites.values()) pending.add(operation);
      for (const operation of this.sessionProjectionTails.values()) pending.add(operation);
      for (const operation of this.autoTitleTasks.values()) pending.add(operation);
      for (const operation of this.retiringSessions.values()) pending.add(operation);
      for (const operation of this.backgroundCommandFinalizations.values()) pending.add(operation);
      for (const operations of this.lspTerminationTasks.values()) {
        for (const operation of operations) pending.add(operation);
      }
      if (this.startupRecoveryTask) pending.add(this.startupRecoveryTask);
      if (this.deletedReconciliationTask) pending.add(this.deletedReconciliationTask);
      for (const session of sessions) {
        pending.add(session.whenIdle());
        pending.add(session.whenBackgroundTasksIdle());
        pending.add(session.whenPersistenceIdle());
        pending.add(session.whenToolExecutionsIdle());
      }
      if (pending.size === 0) return;
      await Promise.allSettled(pending);
      const stillRunning = [...this.sessions.values()].some((session) => session.running);
      if (
        !stillRunning &&
        this.activeManagerOperations.size === 0 &&
        this.activeSessionOperations.size === 0 &&
        this.loading.size === 0 &&
        this.recoveringCommands.size === 0 &&
        this.recoveringPatchSets.size === 0 &&
        this.deletionTasks.size === 0 &&
        this.runtimeWrites.size === 0 &&
        this.subagentStateWrites.size === 0 &&
        this.sessionProjectionTails.size === 0 &&
        this.autoTitleTasks.size === 0 &&
        this.retiringSessions.size === 0 &&
        this.backgroundCommandFinalizations.size === 0 &&
        this.lspTerminationTasks.size === 0 &&
        !this.startupRecoveryTask &&
        !this.deletedReconciliationTask
      ) {
        return;
      }
    }
  }

  /** 为某会话 cwd 建一个 LSP 池并登记，供 dispose 统一关闭。 */
  private lspPoolFor(sessionId: string, cwd: string): LspPool {
    const pool = new LspPool(cwd, this.opts.lsp ?? [], this.opts.isolatedRuntime);
    this.lspPools.add(pool);
    this.sessionLspPools.set(sessionId, pool);
    return pool;
  }

  private closeSessionLspPool(sessionId: string): Promise<void> {
    const pool = this.sessionLspPools.get(sessionId);
    if (!pool) return Promise.resolve();
    this.sessionLspPools.delete(sessionId);
    this.lspPools.delete(pool);
    const task = pool.closeAll();
    const tasks = this.lspTerminationTasks.get(sessionId) ?? new Set<Promise<void>>();
    tasks.add(task);
    this.lspTerminationTasks.set(sessionId, tasks);
    const cleanup = () => {
      const current = this.lspTerminationTasks.get(sessionId);
      current?.delete(task);
      if (current?.size === 0) this.lspTerminationTasks.delete(sessionId);
    };
    void task.then(cleanup, (error) => {
      const failures = this.lspTerminationFailures.get(sessionId) ?? [];
      if (failures.length < MAX_DURABILITY_FAILURE_DETAILS) failures.push(error);
      this.lspTerminationFailures.set(sessionId, failures);
      cleanup();
    });
    return task;
  }

  private async waitForLspTermination(sessionId: string): Promise<void> {
    for (;;) {
      const current = [...(this.lspTerminationTasks.get(sessionId) ?? [])];
      if (current.length === 0) break;
      await Promise.allSettled(current);
    }
    const failures = this.lspTerminationFailures.get(sessionId) ?? [];
    this.lspTerminationFailures.delete(sessionId);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to terminate LSP processes for ${sessionId}`);
    }
  }

  // ---------- 内部 ----------

  private async resolveCanonicalWorkspaceScope(): Promise<ScopedWorkspaceIdentity> {
    if (!this.workspaceScopePath) {
      throw new Error("SessionManager has no configured workspace scope");
    }
    let bound = this.canonicalWorkspaceScope;
    if (!bound) {
      bound = this.canonicalizeWorkspace(
        this.workspaceScopePath,
        t("configured workspace scope", "已配置的工作区范围"),
      );
      this.canonicalWorkspaceScope = bound;
      return bound;
    }
    const [identity, current] = await Promise.all([
      bound,
      this.canonicalizeWorkspace(
        this.workspaceScopePath,
        t("configured workspace scope", "已配置的工作区范围"),
      ),
    ]);
    if (!this.sameCanonicalWorkspace(identity, current)) throw this.workspaceScopeViolation();
    return identity;
  }

  private async canonicalizeWorkspace(
    cwd: string,
    label: string,
  ): Promise<ScopedWorkspaceIdentity> {
    const absolute = path.resolve(cwd);
    try {
      const canonical = await fs.realpath(absolute);
      const stat = await fs.lstat(canonical, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error("path is not a real directory");
      }
      return {
        canonicalPath: canonical,
        device: String(stat.dev),
        inode: String(stat.ino),
      };
    } catch (cause) {
      throw new Error(t(`Cannot securely inspect ${label}`, `无法安全检查${label}`), { cause });
    }
  }

  private sameCanonicalWorkspace(
    left: ScopedWorkspaceIdentity,
    right: ScopedWorkspaceIdentity,
  ): boolean {
    // realpath normalizes case on the common case-insensitive filesystems. Preserve the explicit
    // Windows rule as drive-letter casing is not guaranteed to be stable across providers.
    const samePath =
      process.platform === "win32"
        ? left.canonicalPath.toLocaleLowerCase("en-US") ===
          right.canonicalPath.toLocaleLowerCase("en-US")
        : left.canonicalPath === right.canonicalPath;
    return samePath && left.device === right.device && left.inode === right.inode;
  }

  private workspaceScopeViolation(): Error {
    return new Error(
      t(
        "Workspace is outside this SessionManager's configured scope",
        "工作区超出此 SessionManager 的配置范围",
      ),
    );
  }

  /**
   * Resolve only the metadata header before reading a transcript. This keeps a scoped manager from
   * even loading a known foreign session's prompt/response body into memory. The authoritative
   * loaded metadata is checked again afterward to detect replacements between the two reads.
   */
  private async preflightSessionWorkspace(
    sessionId: string,
  ): Promise<ScopedWorkspaceIdentity | undefined> {
    if (!this.workspaceScopePath) return undefined;
    await this.resolveCanonicalWorkspaceScope();
    const meta = (await this.opts.store.list()).find((candidate) => candidate.id === sessionId);
    if (!meta) throw this.workspaceScopeViolation();
    return this.assertWorkspaceInScope(meta.cwd, meta.workspaceIdentity, true);
  }

  /** Return a canonical cwd for scoped hosts; preserve legacy cwd spelling when unscoped. */
  private async assertWorkspaceInScope(
    cwd: string,
    persistedIdentity?: SessionMeta["workspaceIdentity"],
    requirePersistedIdentity = false,
  ): Promise<ScopedWorkspaceIdentity> {
    if (!this.workspaceScopePath) return { canonicalPath: cwd };
    const [scope, candidate] = await Promise.all([
      this.resolveCanonicalWorkspaceScope(),
      this.canonicalizeWorkspace(cwd, t("session workspace", "会话工作区")),
    ]);
    if (!this.sameCanonicalWorkspace(scope, candidate)) {
      throw this.workspaceScopeViolation();
    }
    if (
      (requirePersistedIdentity && !persistedIdentity) ||
      (persistedIdentity &&
        (persistedIdentity.device !== candidate.device ||
          persistedIdentity.inode !== candidate.inode))
    ) {
      throw this.workspaceScopeViolation();
    }
    return candidate;
  }

  private assertManagerActive(): void {
    if (this.disposed) throw new Error("SessionManager is shutting down or disposed");
  }

  private assertSessionAvailable(sessionId: string, allowDisposed = false): void {
    if (this.shutdownTimedOut) {
      throw new Error("SessionManager shutdown deadline exceeded");
    }
    if (!allowDisposed) this.assertManagerActive();
    if (this.deletingSessions.has(sessionId)) {
      throw new Error(
        t(
          `Session ${sessionId} is being or has been deleted`,
          `会话 ${sessionId} 正在删除或已删除`,
        ),
      );
    }
  }

  private assertSendGeneration(sessionId: string, expectedEpoch: number): void {
    if ((this.interruptEpochs.get(sessionId) ?? 0) !== expectedEpoch) {
      throw new Error(t("Session interrupted", "会话已中断"));
    }
  }

  private trackManagerOperation<T>(operation: Promise<T>): Promise<T> {
    this.activeManagerOperations.add(operation);
    const cleanup = () => this.activeManagerOperations.delete(operation);
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private trackSessionOperation<T>(sessionId: string, operation: Promise<T>): Promise<T> {
    const active = this.activeSessionOperations.get(sessionId) ?? new Set<Promise<unknown>>();
    active.add(operation);
    this.activeSessionOperations.set(sessionId, active);
    const cleanup = () => {
      const current = this.activeSessionOperations.get(sessionId);
      current?.delete(operation);
      if (current?.size === 0) this.activeSessionOperations.delete(sessionId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  private registerArtifactReader(sessionId: string, reader: ActiveArtifactReader): () => void {
    const readers = this.activeArtifactReaders.get(sessionId) ?? new Set<ActiveArtifactReader>();
    readers.add(reader);
    this.activeArtifactReaders.set(sessionId, readers);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      const current = this.activeArtifactReaders.get(sessionId);
      current?.delete(reader);
      if (current?.size === 0) this.activeArtifactReaders.delete(sessionId);
    };
  }

  private abortArtifactReaders(sessionId: string, reason: Error): void {
    for (const reader of [...(this.activeArtifactReaders.get(sessionId) ?? [])]) {
      reader.abort(reason);
    }
  }

  private runSessionOperation<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    return this.startSessionOperation(sessionId, run, true, false);
  }

  /** Event projections are themselves tracked writes, so they must not drain the set containing self. */
  private runSessionProjection<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    return this.startSessionOperation(sessionId, run, false, true);
  }

  private startSessionOperation<T>(
    sessionId: string,
    run: () => Promise<T>,
    drainRuntimeWrites: boolean,
    allowDisposed: boolean,
  ): Promise<T> {
    const operation = (async () => {
      this.assertSessionAvailable(sessionId, allowDisposed);
      // Metadata-only tenancy validation must precede provider construction and every durable,
      // artifact, runtime, recovery, or live-session side effect owned by the callback.
      let workspace = await this.preflightSessionWorkspace(sessionId);
      if (!workspace) {
        const liveMeta = this.sessions.get(sessionId)?.meta;
        const durable = liveMeta ? undefined : await this.lifecycle.get(sessionId);
        const lifecyclePath = liveMeta?.cwd ?? durable?.workspace;
        const lifecycleIdentity = liveMeta?.workspaceIdentity ?? durable?.workspaceIdentity;
        if (lifecyclePath) {
          workspace = {
            canonicalPath: lifecyclePath,
            ...(lifecycleIdentity
              ? { device: lifecycleIdentity.device, inode: lifecycleIdentity.inode }
              : {}),
          };
        }
      }
      this.assertSessionAvailable(sessionId, allowDisposed);
      return this.withSessionOperationLease(
        sessionId,
        workspace,
        run,
        drainRuntimeWrites,
        allowDisposed,
      );
    })();
    return this.trackSessionOperation(sessionId, operation);
  }

  /** New ids have no metadata to preflight; the lifecycle insert is their first durable fact. */
  private runNewSessionOperation<T>(
    sessionId: string,
    workspace: ScopedWorkspaceIdentity,
    run: () => Promise<T>,
  ): Promise<T> {
    this.assertManagerActive();
    const operation = this.withSessionOperationLease(sessionId, workspace, run);
    return this.trackSessionOperation(sessionId, operation);
  }

  private async withSessionOperationLease<T>(
    sessionId: string,
    workspace: ScopedWorkspaceIdentity | undefined,
    run: () => Promise<T>,
    drainRuntimeWrites = true,
    allowDisposed = false,
  ): Promise<T> {
    const lease = await this.lifecycle.acquireOperation({
      sessionId,
      owner: this.workerId,
      ttlMs: this.sessionLifecycleLeaseMs,
      ...(workspace ? { workspace: workspace.canonicalPath } : {}),
      ...(workspace?.device !== undefined && workspace.inode !== undefined
        ? { workspaceIdentity: { device: workspace.device, inode: workspace.inode } }
        : {}),
    });
    this.assertSessionAvailable(sessionId, allowDisposed);
    const heartbeat = this.startSessionOperationHeartbeat(lease);
    let result!: T;
    let failure: unknown;
    let failed = false;
    try {
      result = await run();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      // Event projection is part of the producer transaction boundary. A title/permission/tool
      // event queued just before callback return must not outlive the durable operation lease.
      if (drainRuntimeWrites) await this.flushRuntimeWrites(sessionId);
    } catch (error) {
      if (!failed) {
        failed = true;
        failure = error;
      }
    } finally {
      await heartbeat.stop();
    }
    // A suspended event loop can miss every timer tick. The final conditional renewal detects an
    // already-expired lease before reporting success, even when the heartbeat callback never ran.
    let leaseRetained = !heartbeat.lost();
    if (leaseRetained) {
      leaseRetained = await this.lifecycle
        .renewOperation(lease, this.sessionLifecycleLeaseMs)
        .catch(() => false);
    }
    await this.lifecycle.releaseOperation(lease).catch(() => undefined);
    if (!leaseRetained) {
      try {
        await this.compensateLateSessionOperation(sessionId, workspace);
      } catch (compensationError) {
        throw new AggregateError(
          [new SessionLifecycleLeaseLostError(sessionId), compensationError],
          `Late session operation compensation failed for ${sessionId}`,
          { cause: compensationError },
        );
      }
      throw new SessionLifecycleLeaseLostError(sessionId);
    }
    if (failed) throw failure;
    return result;
  }

  /**
   * If a producer outlives its lease, deletion may legally finish before its backend request does.
   * Once that request settles, this compensating sweep removes everything it could have recreated.
   * The permanent lifecycle tombstone prevents a legitimate newer generation from being harmed.
   */
  private async compensateLateSessionOperation(
    sessionId: string,
    operationWorkspace: ScopedWorkspaceIdentity | undefined,
  ): Promise<void> {
    const lifecycle = await this.lifecycle.get(sessionId);
    if (!lifecycle || lifecycle.state === "active") return;
    this.deletingSessions.add(sessionId);
    this.fenceLocalSessionForDeletion(sessionId);
    this.sessions.delete(sessionId);
    this.loading.delete(sessionId);
    const durableWorkspace = await this.lifecycleWorkspace(lifecycle);
    const workspace = durableWorkspace ?? operationWorkspace;
    if (workspace) this.deletionWorkspaces.set(sessionId, workspace);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await this.purgeSessionContent(sessionId, workspace);
        if (lifecycle.state === "deleted") await this.recordDeletionTombstone(sessionId);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 25));
        }
      }
    }
    throw lastError;
  }

  private startSessionOperationHeartbeat(lease: SessionOperationLease): {
    lost: () => boolean;
    stop: () => Promise<void>;
  } {
    let stopped = false;
    let lost = false;
    let tail: Promise<void> = Promise.resolve();
    const loseLease = () => {
      lost = true;
      this.abortArtifactReaders(
        lease.sessionId,
        new SessionLifecycleLeaseLostError(lease.sessionId),
      );
      const session = this.sessions.get(lease.sessionId);
      session?.stopBackgroundTasks();
      session?.close();
      void this.closeSessionLspPool(lease.sessionId);
    };
    const timer = setInterval(
      () => {
        tail = tail
          .then(async () => {
            if (stopped || lost) return;
            if (!(await this.lifecycle.renewOperation(lease, this.sessionLifecycleLeaseMs)))
              loseLease();
          })
          .catch(loseLease);
      },
      Math.max(25, Math.floor(this.sessionLifecycleLeaseMs / 3)),
    );
    timer.unref?.();
    return {
      lost: () => lost,
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await tail;
      },
    };
  }

  private async waitForSessionOperations(sessionId: string): Promise<void> {
    // A settling operation can synchronously enqueue its final persistence promise. Loop until the
    // set is actually empty rather than observing one snapshot only.
    for (;;) {
      const active = [...(this.activeSessionOperations.get(sessionId) ?? [])];
      if (active.length === 0) return;
      await Promise.allSettled(active);
    }
  }

  private scheduleDeletedSessionReconciliation(): void {
    if (this.disposed || this.deletedReconciliationTask) return;
    const task = this.reconcileDeletedSessionTombstones()
      .catch(() => undefined)
      .finally(() => {
        if (this.deletedReconciliationTask === task) this.deletedReconciliationTask = undefined;
      });
    this.deletedReconciliationTask = task;
  }

  /**
   * A lifecycle tombstone makes any orphaned content unreachable through SessionManager reads,
   * while this bounded collector eventually removes the underlying bytes. It intentionally runs
   * forever: a timed-out HTTP/S3 request has no finite upper bound on when its backend may commit.
   */
  private async reconcileDeletedSessionTombstones(): Promise<void> {
    if (this.disposed) return;
    const span = this.telemetry.startSpan("anicode.session.deleted_reconciliation");
    let failures = 0;
    try {
      const scope = this.workspaceScopePath
        ? await this.resolveCanonicalWorkspaceScope()
        : undefined;
      const records = await this.lifecycle.listDeleted({
        limit: DELETED_SESSION_RECONCILIATION_BATCH,
        ...(this.deletedReconciliationCursor
          ? { afterSessionId: this.deletedReconciliationCursor }
          : {}),
        ...(scope ? { workspace: scope.canonicalPath } : {}),
      });
      this.deletedReconciliationCursor =
        records.length === DELETED_SESSION_RECONCILIATION_BATCH
          ? records[records.length - 1]?.sessionId
          : undefined;
      for (const record of records) {
        if (this.disposed) return;
        this.deletingSessions.add(record.sessionId);
        try {
          // `listDeleted(workspace=...)` already applies the scoped path boundary. Preserve the
          // tombstone's original identity here and let purgeSessionContent revalidate it. Even when
          // that directory was replaced (and PatchSet cleanup must fail closed), the safe
          // non-workspace/S3 purge still has to run for crash-late objects.
          const workspace = record.workspace
            ? {
                canonicalPath: record.workspace,
                ...(record.workspaceIdentity
                  ? {
                      device: record.workspaceIdentity.device,
                      inode: record.workspaceIdentity.inode,
                    }
                  : {}),
              }
            : undefined;
          if (scope && !workspace) throw this.workspaceScopeViolation();
          if (workspace) this.deletionWorkspaces.set(record.sessionId, workspace);
          this.fenceLocalSessionForDeletion(record.sessionId);
          this.sessions.delete(record.sessionId);
          this.loading.delete(record.sessionId);
          await this.purgeSessionContent(record.sessionId, workspace);
          await this.recordDeletionTombstone(record.sessionId);
          this.deletedSessions.add(record.sessionId);
        } catch (error) {
          failures++;
          span.recordException(error);
        }
      }
      span
        .setAttribute("anicode.session.reconciliation.scanned", records.length)
        .setAttribute("anicode.session.reconciliation.failures", failures)
        .setStatus(failures === 0 ? { code: "ok" } : { code: "error" });
    } catch (error) {
      span.recordException(error).setStatus({ code: "error" });
      throw error;
    } finally {
      span.end();
    }
  }

  private async deleteSessionDurably(sessionId: string): Promise<void> {
    const observed = await this.lifecycle.get(sessionId);
    if (observed?.state === "deleted") {
      this.deletingSessions.add(sessionId);
      const workspace = await this.lifecycleWorkspace(observed);
      if (workspace) this.deletionWorkspaces.set(sessionId, workspace);
      // A prior process may have crashed after marking deleted while a timed-out producer was
      // still committing. Repeated delete is therefore a repair pass, not a metadata-only no-op.
      await this.purgeSessionContent(sessionId, workspace);
      await this.recordDeletionTombstone(sessionId);
      this.deletedSessions.add(sessionId);
      return;
    }

    let workspace: ScopedWorkspaceIdentity | undefined;
    if (observed?.state === "deleting") {
      workspace = await this.lifecycleWorkspace(observed);
      // A scoped host may resume a partial purge only when the durable deleting row proves that it
      // belongs to its exact canonical workspace. Missing proof fails closed after metadata purge.
      if (this.workspaceScopePath) {
        if (!workspace) throw this.workspaceScopeViolation();
        workspace = await this.assertWorkspaceInScope(
          workspace.canonicalPath,
          workspace.device !== undefined && workspace.inode !== undefined
            ? { device: workspace.device, inode: workspace.inode }
            : undefined,
          true,
        );
      }
    } else {
      const scopedWorkspace = await this.preflightSessionWorkspace(sessionId);
      workspace = observed?.workspace
        ? {
            canonicalPath: observed.workspace,
            ...(observed.workspaceIdentity
              ? {
                  device: observed.workspaceIdentity.device,
                  inode: observed.workspaceIdentity.inode,
                }
              : {}),
          }
        : scopedWorkspace;
      if (!workspace) {
        const meta =
          this.sessions.get(sessionId)?.meta ??
          (await this.opts.store.list()).find((candidate) => candidate.id === sessionId);
        if (meta) {
          workspace = {
            canonicalPath: meta.cwd,
            ...(meta.workspaceIdentity
              ? { device: meta.workspaceIdentity.device, inode: meta.workspaceIdentity.inode }
              : {}),
          };
        }
      }
    }
    if (workspace) this.deletionWorkspaces.set(sessionId, workspace);

    for (;;) {
      let claim = await this.lifecycle.claimDeletion({
        sessionId,
        owner: this.workerId,
        ttlMs: this.sessionLifecycleLeaseMs,
        ...(workspace ? { workspace: workspace.canonicalPath } : {}),
        ...(workspace?.device !== undefined && workspace.inode !== undefined
          ? { workspaceIdentity: { device: workspace.device, inode: workspace.inode } }
          : {}),
      });
      this.deletingSessions.add(sessionId);
      this.fenceLocalSessionForDeletion(sessionId);
      if (claim.workspace) {
        workspace = await this.lifecycleWorkspace(claim);
        if (workspace) this.deletionWorkspaces.set(sessionId, workspace);
        if (
          claim.claimed &&
          !claim.workspaceIdentity &&
          workspace?.device !== undefined &&
          workspace.inode !== undefined
        ) {
          // Bind the identity discovered after the atomic path fence to the same re-entrant delete
          // claim before any PatchSet cleanup can run.
          claim = await this.lifecycle.claimDeletion({
            sessionId,
            owner: this.workerId,
            ttlMs: this.sessionLifecycleLeaseMs,
            workspace: workspace.canonicalPath,
            workspaceIdentity: { device: workspace.device, inode: workspace.inode },
          });
        }
      }
      if (claim.state === "deleted") {
        this.deletedSessions.add(sessionId);
        return;
      }
      if (!claim.claimed) {
        await new Promise((resolve) => setTimeout(resolve, this.sessionLifecyclePollMs));
        continue;
      }

      const heartbeat = this.startSessionDeletionHeartbeat(claim);
      try {
        await this.performSessionDeletion(sessionId, claim);
        if (heartbeat.lost()) throw new SessionLifecycleLeaseLostError(sessionId);
        if (!(await this.lifecycle.completeDeletion(claim))) {
          throw new SessionLifecycleLeaseLostError(sessionId);
        }
        this.deletedSessions.add(sessionId);
        return;
      } finally {
        await heartbeat.stop();
      }
    }
  }

  private async lifecycleWorkspace(record: {
    workspace?: string;
    workspaceIdentity?: { device: string; inode: string };
  }): Promise<ScopedWorkspaceIdentity | undefined> {
    if (!record.workspace) return undefined;
    const expected: ScopedWorkspaceIdentity = {
      canonicalPath: record.workspace,
      ...(record.workspaceIdentity
        ? { device: record.workspaceIdentity.device, inode: record.workspaceIdentity.inode }
        : {}),
    };
    let current: ScopedWorkspaceIdentity;
    try {
      current = await this.canonicalizeWorkspace(
        expected.canonicalPath,
        t("session workspace", "会话工作区"),
      );
    } catch (error) {
      if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === "ENOENT") return expected;
      throw error;
    }
    if (
      expected.device !== undefined &&
      expected.inode !== undefined &&
      (expected.device !== current.device || expected.inode !== current.inode)
    ) {
      throw new Error(
        t("Session workspace identity changed during deletion", "删除期间会话工作区身份已变化"),
      );
    }
    return { ...current, canonicalPath: expected.canonicalPath };
  }

  private fenceLocalSessionForDeletion(sessionId: string): void {
    this.abortArtifactReaders(
      sessionId,
      new SessionLifecycleUnavailableError(sessionId, "deleting"),
    );
    const live = this.sessions.get(sessionId);
    live?.stopBackgroundTasks();
    live?.close();
    void this.closeSessionLspPool(sessionId);
  }

  private startSessionDeletionHeartbeat(claim: SessionDeletionClaim): {
    lost: () => boolean;
    stop: () => Promise<void>;
  } {
    let stopped = false;
    let lost = false;
    let tail: Promise<void> = Promise.resolve();
    const timer = setInterval(
      () => {
        tail = tail
          .then(async () => {
            if (stopped || lost) return;
            if (!(await this.lifecycle.renewDeletion(claim, this.sessionLifecycleLeaseMs)))
              lost = true;
          })
          .catch(() => {
            lost = true;
          });
      },
      Math.max(25, Math.floor(this.sessionLifecycleLeaseMs / 3)),
    );
    timer.unref?.();
    return {
      lost: () => lost,
      stop: async () => {
        stopped = true;
        clearInterval(timer);
        await tail;
      },
    };
  }

  private async waitForDurableSessionOperations(
    sessionId: string,
    claim: SessionDeletionClaim,
  ): Promise<void> {
    for (;;) {
      const lifecycle = await this.lifecycle.get(sessionId);
      if (
        !lifecycle ||
        lifecycle.state !== "deleting" ||
        lifecycle.deleteOwner !== claim.deleteOwner ||
        lifecycle.deleteToken !== claim.deleteToken
      ) {
        throw new SessionLifecycleLeaseLostError(sessionId);
      }
      if (lifecycle.activeLeases === 0) return;
      await new Promise((resolve) => setTimeout(resolve, this.sessionLifecyclePollMs));
    }
  }

  private async performSessionDeletion(
    sessionId: string,
    claim: SessionDeletionClaim,
  ): Promise<void> {
    // A cold load that won the race before the deletion fence may still instantiate a live Agent.
    // Wait for it, then close that instance permanently before waiting on send/recovery barriers.
    const loading = this.loading.get(sessionId);
    if (loading) await Promise.allSettled([loading]);

    const live = this.sessions.get(sessionId);
    if (live) {
      live.stopBackgroundTasks();
      live.close();
    }
    await this.closeSessionLspPool(sessionId).catch(() => undefined);
    await this.waitForLspTermination(sessionId);

    // Both explicit sends and crash recovery can own a drive. close() aborts them; awaiting their
    // outer operations lets command finalization/outbox writes settle before the destructive pass.
    const recovery = this.recoveringCommands.get(sessionId);
    await Promise.allSettled([
      this.waitForSessionOperations(sessionId),
      ...(recovery ? [recovery] : []),
      ...(live ? [live.whenIdle()] : []),
      ...(live ? [live.whenBackgroundTasksIdle()] : []),
      ...(live ? [live.whenPersistenceIdle()] : []),
      ...(live ? [live.whenToolExecutionsIdle()] : []),
    ]);
    // A pre-fence recovery may have registered its drive while the first barrier was settling.
    await this.waitForSessionOperations(sessionId);
    if (live?.running) {
      live.close();
      await live.whenIdle();
    }
    if (live) await live.whenBackgroundTasksIdle();
    if (live) await live.whenPersistenceIdle();
    if (live) await live.closeToolResources();

    this.sessions.delete(sessionId);
    this.loading.delete(sessionId);
    this.activeCommands.delete(sessionId);
    this.recoveringCommands.delete(sessionId);

    // recordSessionEvent is fenced while deleting; after all producers are drained, this flush is
    // a stable boundary. Everything below it is the final content purge.
    await this.flushRuntimeWrites(sessionId, { discardFailures: true, dynamic: true });
    // Other processes may still own a producer lease. The atomic `deleting` transition has already
    // stopped new leases; wait for every prior lease to release or expire before crossing into any
    // separately persisted backend (including S3).
    await this.waitForDurableSessionOperations(sessionId, claim);
    if (!(await this.lifecycle.renewDeletion(claim, this.sessionLifecycleLeaseMs))) {
      throw new SessionLifecycleLeaseLostError(sessionId);
    }
    await this.purgeSessionContent(sessionId, this.deletionWorkspaces.get(sessionId));
    await this.recordDeletionTombstone(sessionId);
  }

  private async purgeSessionContent(
    sessionId: string,
    workspace: ScopedWorkspaceIdentity | undefined,
  ): Promise<void> {
    let workspaceCleanupError: unknown;
    if (workspace) {
      try {
        const revalidated = await this.lifecycleWorkspace({
          workspace: workspace.canonicalPath,
          ...(workspace.device !== undefined && workspace.inode !== undefined
            ? { workspaceIdentity: { device: workspace.device, inode: workspace.inode } }
            : {}),
        });
        if (!revalidated || revalidated.device === undefined || revalidated.inode === undefined) {
          try {
            await fs.lstat(workspace.canonicalPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              // A missing directory cannot contain a reachable PatchSet journal. Continue with
              // non-workspace stores below instead of returning through a second purge path.
              throw error;
            }
            throw error;
          }
          throw new Error(
            t(
              "Cannot verify session workspace identity before PatchSet cleanup",
              "清理 PatchSet 前无法验证会话工作区身份",
            ),
          );
        }
        const currentRoot = await fs.lstat(revalidated.canonicalPath, { bigint: true });
        if (
          !currentRoot.isDirectory() ||
          currentRoot.isSymbolicLink() ||
          String(currentRoot.dev) !== revalidated.device ||
          String(currentRoot.ino) !== revalidated.inode
        ) {
          throw new Error(
            t(
              "Session workspace identity changed before PatchSet cleanup",
              "清理 PatchSet 前会话工作区身份已变化",
            ),
          );
        }
        const patchsets = new PatchSetService(revalidated.canonicalPath, {
          directCommit: "trusted-local",
          sessionId,
        });
        // deleteSession owns the workspace lock and has a deletion-only recovery path for applying
        // journals. Do not call the normal recoverIncomplete path after fencing the session: a
        // retry may already have a journal tombstone and must remain idempotent.
        await patchsets.deleteSession(sessionId);
      } catch (error) {
        // Never follow a replacement workspace merely to finish erasure. Non-workspace stores are
        // nevertheless safe to purge and must not retain late S3 objects because PatchSet cleanup
        // is retryable or the original directory disappeared.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") workspaceCleanupError = error;
      }
    }
    let contentCleanupError: unknown;
    try {
      await this.commandInbox.deleteSession(sessionId);
      await this.outbox.deleteStream(sessionId);
      await this.artifacts.deleteSession(sessionId);
      await this.runtime.deleteStream(sessionId);
      await this.opts.store.delete(sessionId);
    } catch (error) {
      contentCleanupError = error;
    }
    if (workspaceCleanupError && contentCleanupError) {
      throw new AggregateError(
        [workspaceCleanupError, contentCleanupError],
        `Session ${sessionId} cleanup failed in workspace and durable stores`,
      );
    }
    if (workspaceCleanupError) throw workspaceCleanupError;
    if (contentCleanupError) throw contentCleanupError;
  }

  private async recordDeletionTombstone(sessionId: string): Promise<void> {
    await this.runtime.record({
      streamId: sessionId,
      type: "session.deleted",
      data: {},
      idempotencyKey: `session.deleted:${sessionId}`,
    });
  }

  private async ensureLive(sessionId: string): Promise<ManagedSession> {
    this.assertSessionAvailable(sessionId);
    const retiring = this.retiringSessions.get(sessionId);
    if (retiring) {
      await retiring;
      this.assertSessionAvailable(sessionId);
    }
    const pending = this.loading.get(sessionId);
    if (pending) {
      const session = await pending;
      this.assertSessionAvailable(sessionId);
      return session;
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      await this.assertWorkspaceInScope(existing.meta.cwd, existing.meta.workspaceIdentity, true);
      this.assertSessionAvailable(sessionId);
      if (!this.opts.workspaceTrust) return existing;
      const refresh = this.refreshLiveWorkspaceTrust(sessionId, existing);
      this.loading.set(sessionId, refresh);
      try {
        const session = await refresh;
        this.assertSessionAvailable(sessionId);
        return session;
      } finally {
        if (this.loading.get(sessionId) === refresh) this.loading.delete(sessionId);
      }
    }

    const load = this.loadSession(sessionId);
    this.loading.set(sessionId, load);
    try {
      const session = await load;
      this.assertSessionAvailable(sessionId);
      return session;
    } finally {
      if (this.loading.get(sessionId) === load) this.loading.delete(sessionId);
    }
  }

  private async refreshLiveWorkspaceTrust(
    sessionId: string,
    existing: ManagedSession,
  ): Promise<ManagedSession> {
    const assessment = await this.assessWorkspaceTrust(existing.meta.cwd);
    this.assertSessionAvailable(sessionId);
    if (sameWorkspaceTrustBoundary(existing.trustAssessment, assessment)) return existing;

    // Trust is part of the Agent's capability construction, not a mutable UI flag. Fence the old
    // Agent, drain its current drive, then reload persisted history into a newly constrained Agent.
    existing.stopBackgroundTasks();
    existing.close();
    await this.closeSessionLspPool(sessionId).catch(() => undefined);
    await this.waitForLspTermination(sessionId);
    await this.opts.onWorkspaceTrustChange?.({
      sessionId,
      cwd: existing.meta.cwd,
      ...(existing.trustAssessment ? { previous: existing.trustAssessment } : {}),
      current: assessment!,
    });
    await existing.whenIdle();
    await existing.whenBackgroundTasksIdle();
    await existing.whenToolExecutionsIdle();
    await existing.closeToolResources();
    this.assertSessionAvailable(sessionId);
    if (this.sessions.get(sessionId) === existing) this.sessions.delete(sessionId);
    const replacement = await this.loadSession(sessionId, assessment, existing.subscriberSet());
    replacement.announceWorkspaceTrust(assessment!);
    return replacement;
  }

  private recoverWorkspacePatchSets(cwd: string, sessionId: string): Promise<PatchSet[]> {
    const root = path.resolve(cwd);
    const recoveryKey = `${root}\0${sessionId}`;
    const active = this.recoveringPatchSets.get(recoveryKey);
    if (active) return active;
    const recovery = new PatchSetService(root, {
      directCommit: "trusted-local",
      sessionId,
    }).recoverIncomplete();
    this.recoveringPatchSets.set(recoveryKey, recovery);
    void recovery
      .finally(() => {
        if (this.recoveringPatchSets.get(recoveryKey) === recovery)
          this.recoveringPatchSets.delete(recoveryKey);
      })
      .catch(() => undefined);
    return recovery;
  }

  private async patchSetContext(
    sessionId: string,
    requireIdle: boolean,
    options: Pick<PatchSetServiceOptions, "requiredApprovals" | "requiredRoles"> = {},
  ): Promise<{ service: PatchSetService; session: ManagedSession }> {
    const session = await this.ensureLive(sessionId);
    if (session.workspaceRestricted) {
      throw new Error(
        t(
          "PatchSet operations are disabled in an untrusted workspace",
          "未信任工作区已禁用 PatchSet 操作",
        ),
      );
    }
    if (requireIdle && session.running) {
      throw new Error(
        `Session ${sessionId} is running; PatchSet transaction requires an idle session`,
      );
    }
    return {
      service: new PatchSetService(session.meta.cwd, {
        ...options,
        directCommit: "trusted-local",
        sessionId,
      }),
      session,
    };
  }

  private persistPatchSetArtifact(
    sessionId: string,
    patchset: PatchSet,
    preview: string,
  ): Promise<Artifact> {
    return this.putArtifact({
      sessionId,
      kind: "patch",
      name: `${patchset.id}.json`,
      mediaType: "application/vnd.anicode.patchset+json",
      data: JSON.stringify({ patchset, preview }, null, 2),
      metadata: { patchsetId: patchset.id, status: patchset.status },
    });
  }

  /** 解析本会话该用的小模型 spec：true→按 provider 推导，字符串→原样，否则无。 */
  private smallModelSpec(resolved: ResolvedProvider): string | undefined {
    const cfg = this.opts.smallModel;
    if (!cfg) return undefined;
    if (typeof cfg === "string") return cfg;
    return defaultSmallModel(resolved.modelInfo?.providerId);
  }

  private async assessWorkspaceTrust(cwd: string): Promise<WorkspaceTrustAssessment | undefined> {
    const source = this.opts.workspaceTrust;
    if (!source) return undefined;
    try {
      const assessment =
        typeof source === "function" ? await source(cwd) : await source.assess(cwd);
      if (
        !assessment ||
        typeof assessment.trusted !== "boolean" ||
        typeof assessment.reason !== "string" ||
        (assessment.trusted &&
          (assessment.reason !== "trusted" || !assessment.identity || !assessment.executionHash))
      ) {
        throw new Error("Workspace Trust resolver returned an invalid assessment");
      }
      return assessment.trusted ? await revalidateWorkspaceTrust(cwd, assessment) : assessment;
    } catch (error) {
      return {
        trusted: false,
        reason: "inspection-failed",
        executionSources: [],
        storeFile: "<workspace-trust-resolver>",
        assessedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private instantiate(
    meta: SessionMeta,
    resumeMessages: ChatMessage[],
    resolved: ResolvedProvider,
    workspaceTrust?: WorkspaceTrustAssessment,
    listeners?: Set<SessionListener>,
    recovered: RecoveredSessionProjection = { checkpoints: [] },
  ): ManagedSession {
    const restricted = workspaceTrust?.trusted === false;
    const requestedDefault = (this.opts.permission?.mode ?? "default") === "default";
    // Entry-point intent is independent of the requested trusted-workspace permission mode. A
    // local interactive host can therefore start trusted sessions in auto/bypass while still
    // degrading to the audited default+confirm surface after trust is revoked. Older embedders
    // retain the mode===default inference until they opt into the explicit capability.
    const restrictedDevelopmentRequested =
      this.opts.allowRestrictedWorkspaceDevelopment ?? requestedDefault;
    const restrictedDevelopment =
      restricted &&
      workspaceTrust?.reason !== "inspection-failed" &&
      restrictedDevelopmentRequested;
    const session = new ManagedSession(
      meta,
      (confirm) => {
        const permission: PermissionConfig = restricted
          ? {
              ...(this.opts.permission?.denyRules?.length
                ? { denyRules: this.opts.permission.denyRules }
                : {}),
              ...(restrictedDevelopment && this.opts.permission?.allowRules?.length
                ? { allowRules: this.opts.permission.allowRules }
                : {}),
              ...(restrictedDevelopment && this.opts.permission?.askRules?.length
                ? { askRules: this.opts.permission.askRules }
                : {}),
              // Never inherit readOnlyTools/editTools or a privileged mode into an untrusted Agent.
              mode: restrictedDevelopment ? "default" : "plan",
              // Headless/non-default entry points have no authorization UI. Omitting confirm is a
              // second fail-safe against future rule/tool metadata accidentally creating a wait.
              ...(restrictedDevelopment ? { confirm } : {}),
            }
          : {
              mode: "default",
              ...this.opts.permission,
              confirm,
              // allow_always 写回会话 cwd 的项目本地设置（.anicode/settings.local.json）
              ...(this.opts.persistPermissions
                ? {
                    persistAllowRule: async (rule: string) => {
                      await appendLocalAllowRules(meta.cwd, [rule]);
                    },
                  }
                : {}),
            };
        const agent = new Agent({
          provider: resolved.provider,
          model: resolved.model,
          // 后台子 agent 在会话空闲时完成 → 自动发起一次 drive 让模型消化通知
          // （运行中完成的通知由 Agent 在 turn 边界注入，不经此回调）。
          onTaskNotice: (text) => {
            void this.send(meta.id, text).catch(() => {});
          },
          ...(resolved.modelInfo ? { modelInfo: resolved.modelInfo } : {}),
          resolveModel: this.opts.resolveProvider,
          ...(this.smallModelSpec(resolved) ? { smallModel: this.smallModelSpec(resolved)! } : {}),
          ...(this.opts.fallbackModels?.length ? { fallbackModels: this.opts.fallbackModels } : {}),
          ...(this.opts.runBudget ? { runBudget: this.opts.runBudget } : {}),
          ...(restrictedDevelopment
            ? { sandbox: "workspace-write" as const }
            : !restricted && this.opts.sandbox
              ? { sandbox: this.opts.sandbox }
              : {}),
          ...(!restricted && this.opts.checkpoints ? { checkpoints: true } : {}),
          ...(!restricted && this.opts.repoMap !== undefined ? { repoMap: this.opts.repoMap } : {}),
          ...(!restricted && this.opts.worktreeOwnership
            ? { worktreeOwnership: this.opts.worktreeOwnership }
            : {}),
          ...(!restricted && this.opts.networkProxy
            ? { networkProxy: this.opts.networkProxy }
            : {}),
          ...(!restricted && this.opts.webSearch ? { webSearch: this.opts.webSearch } : {}),
          ...(!restricted && this.opts.lsp?.length
            ? { lsp: this.lspPoolFor(meta.id, meta.cwd) }
            : {}),
          // browser 默认开启：仅显式 false 时禁用（undefined→true）。
          ...(!restricted && this.opts.browser !== false
            ? { browser: this.opts.browser ?? true }
            : {}),
          cwd: meta.cwd,
          permission,
          ...(!restricted && this.opts.permissionProfiles
            ? { permissionProfiles: this.opts.permissionProfiles }
            : {}),
          ...(restricted
            ? {
                tools: restrictedDevelopment
                  ? (this.opts.restrictedDevelopmentTools?.() ??
                    restrictedWorkspaceDevelopmentTools())
                  : defaultTools().subset([...RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES]),
              }
            : this.opts.tools
              ? { tools: this.opts.tools() }
              : {}),
          ...(!restricted && this.opts.hooks ? { hooks: this.opts.hooks } : {}),
          ...(!restricted && this.opts.subagents !== undefined
            ? {
                subagents: this.opts.subagents,
                ...(recovered.tasks?.length ? { recoveredTasks: recovered.tasks } : {}),
                onTaskState: (record: PersistedTaskRecord) => {
                  this.persistSubagentState(meta.id, record);
                },
                onTaskUsageCredited: (credit: TaskUsageCredit) =>
                  this.persistTaskUsageCredit(meta.id, credit),
                onTaskEvicted: (taskId: string) => {
                  this.evictSubagentState(meta.id, taskId);
                },
              }
            : {}),
          ...(!restricted && this.opts.skills !== undefined ? { skills: this.opts.skills } : {}),
          ...(restricted
            ? { projectMemory: false, injectEnv: false }
            : this.opts.projectMemory !== undefined
              ? { projectMemory: this.opts.projectMemory }
              : {}),
          ...(this.opts.compaction !== undefined ? { compaction: this.opts.compaction } : {}),
          ...(this.opts.contextCompiler ? { contextCompiler: this.opts.contextCompiler } : {}),
          ...(!restricted && this.opts.verifier ? { verifier: this.opts.verifier } : {}),
          ...(this.opts.verificationMaxAttempts !== undefined
            ? { verificationMaxAttempts: this.opts.verificationMaxAttempts }
            : {}),
          ...(this.opts.securityPolicy ? { securityPolicy: this.opts.securityPolicy } : {}),
          ...(this.opts.telemetry ? { telemetry: this.opts.telemetry } : {}),
          ...(this.opts.isolatedRuntime ? { isolatedRuntime: this.opts.isolatedRuntime } : {}),
          persistence: {
            store: this.opts.store,
            meta,
            ...(resumeMessages.length ? { resumeMessages } : {}),
            ...(recovered.usage ? { resumeUsage: recovered.usage } : {}),
            ...(recovered.lastInputTokens
              ? { resumeLastInputTokens: recovered.lastInputTokens }
              : {}),
          },
        });
        if (!restricted && this.opts.permissionProfile) {
          agent.setPermissionProfile(this.opts.permissionProfile);
        }
        return agent;
      },
      (event) => {
        this.recordSessionEvent(meta.id, event);
        this.fanoutGlobal(meta.id, event);
      },
      workspaceTrust,
      restrictedDevelopment,
      recovered.checkpoints,
      listeners,
    );
    this.sessions.set(meta.id, session);
    return session;
  }

  /**
   * 订阅**所有**会话的事件流（firehose）。listener 收到 (sessionId, event)。
   * 只覆盖订阅期间处于 live 的会话；冷会话被 resume/create 成 live 后自动纳入。
   */
  subscribeAll(listener: GlobalListener): () => void {
    this.assertManagerActive();
    this.globalListeners.add(listener);
    return () => this.globalListeners.delete(listener);
  }

  private fanoutGlobal(sessionId: string, ev: SessionEvent): void {
    for (const l of this.globalListeners) {
      try {
        l(sessionId, ev);
      } catch {
        /* 单个 firehose 订阅者异常不影响其他订阅者 */
      }
    }
  }

  /** 把 UI 事件投影成不含正文/密钥的持久运行时事实，并把验证报告落为 Artifact。 */
  private recordSessionEvent(sessionId: string, event: SessionEvent): void {
    // Deletion is a lifecycle fence. Pre-fence writes are drained before purge; post-fence events
    // must never recreate a runtime stream or artifact after that purge.
    if (this.shutdownTimedOut || this.deletingSessions.has(sessionId)) return;
    let type: string;
    let data: Record<string, unknown>;
    let artifactInput: ArtifactInput | undefined;
    if (event.type === "state") {
      type = "session.state";
      data = { running: event.running };
    } else if (event.type === "permission_request") {
      type = "permission.requested";
      data = { permId: event.permId, toolName: event.toolName };
    } else if (event.type === "permission_resolved") {
      type = "permission.resolved";
      data = { permId: event.permId, decision: event.decision };
    } else if (event.type === "title") {
      type = "session.title_changed";
      data = { title: event.title };
    } else if (event.type === "reverted") {
      type = "session.reverted";
      data = {
        checkpointId: event.checkpointId,
        restored: event.restored,
        deleted: event.deleted,
        mode: event.mode ?? "files",
      };
    } else if (event.type === "workspace_trust") {
      type = "workspace.trust_changed";
      data = {
        trusted: event.assessment.trusted,
        reason: event.assessment.reason,
      };
    } else {
      const agent = event.event;
      if (agent.type === "tool_start") {
        type = "tool.started";
        data = { id: agent.id, name: agent.name };
      } else if (agent.type === "tool_result") {
        type = "tool.completed";
        data = { id: agent.id, name: agent.name, isError: agent.isError };
      } else if (agent.type === "verification") {
        type = "verification.completed";
        data = { id: agent.report.id, status: agent.report.status, summary: agent.report.summary };
        artifactInput = {
          sessionId,
          kind: "verification",
          name: `${agent.report.id}.json`,
          mediaType: "application/json",
          data: JSON.stringify(agent.report, null, 2),
          metadata: { status: agent.report.status },
        };
      } else if (agent.type === "done") {
        type = "agent.completed";
        data = { turns: agent.turns, usage: agent.usage, costUSD: agent.costUSD };
      } else if (agent.type === "turn_end") {
        type = "agent.turn_completed";
        data = {
          usage: agent.usage,
          realInputTokens:
            agent.usage.inputTokens + agent.usage.cacheReadTokens + agent.usage.cacheWriteTokens,
        };
      } else if (agent.type === "error") {
        type = "agent.failed";
        data = { error: agent.message };
      } else if (agent.type === "checkpoint") {
        type = "checkpoint.created";
        data = {
          id: agent.id,
          tree: agent.tree,
          label: agent.label,
          messageCount: agent.messageCount,
        };
      } else {
        return;
      }
    }
    this.enqueueRuntimeProjection(sessionId, async () => {
      if (artifactInput) await this.artifacts.put(artifactInput);
      await this.outbox.publish({ streamId: sessionId, type, data });
    });
  }

  /**
   * Persist child transcripts as private Artifacts and publish only the content address in the
   * runtime stream. This keeps prompts out of observability facts while making crash recovery
   * deletion-fenced and independently auditable.
   */
  private enqueueRuntimeProjection(sessionId: string, run: () => Promise<void>): Promise<void> {
    if (this.shutdownTimedOut) return Promise.resolve();
    const previous = this.sessionProjectionTails.get(sessionId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.shutdownTimedOut || this.deletingSessions.has(sessionId)) return;
        await this.runSessionProjection(sessionId, run);
      });
    this.sessionProjectionTails.set(sessionId, write);
    void write
      .finally(() => {
        if (this.sessionProjectionTails.get(sessionId) === write) {
          this.sessionProjectionTails.delete(sessionId);
        }
      })
      .catch(() => undefined);
    this.trackRuntimeWrite(sessionId, write);
    return write;
  }

  /**
   * A detached child can finish after the parent emitted agent.completed. Persist its exact delta
   * under a cumulative idempotency key so restart accounting neither loses nor duplicates billing.
   */
  private persistTaskUsageCredit(sessionId: string, credit: TaskUsageCredit): Promise<void> {
    if (this.shutdownTimedOut || this.deletingSessions.has(sessionId)) {
      return Promise.reject(new Error("Session is no longer accepting task usage credits"));
    }
    return this.enqueueRuntimeProjection(sessionId, () =>
      this.outbox
        .publish({
          streamId: sessionId,
          type: "subagent.usage_credited",
          data: {
            taskId: credit.taskId,
            cumulative: credit.cumulative,
            delta: credit.delta,
            background: credit.background,
          },
          idempotencyKey: `subagent.usage:${credit.idempotencyKey}`,
        })
        .then(() => undefined),
    );
  }

  /** Durable eviction tombstone plus private-artifact GC, serialized with task checkpoints. */
  private evictSubagentState(sessionId: string, taskId: string): void {
    if (this.shutdownTimedOut || this.deletingSessions.has(sessionId)) return;
    const previous = this.subagentStateWrites.get(sessionId) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        if (this.shutdownTimedOut || this.deletingSessions.has(sessionId)) return;
        await this.runSessionProjection(sessionId, async () => {
          await this.outbox.publish({
            streamId: sessionId,
            type: "subagent.evicted",
            data: { taskId },
            idempotencyKey: `subagent.evicted:${taskId}`,
          });
          const artifacts = await this.artifacts.list(sessionId);
          for (const artifact of artifacts) {
            if (isInternalArtifact(artifact) && artifact.metadata?.["taskId"] === taskId) {
              await this.artifacts.delete(sessionId, artifact.id);
            }
          }
        });
      });
    this.subagentStateWrites.set(sessionId, write);
    void write
      .finally(() => {
        if (this.subagentStateWrites.get(sessionId) === write) {
          this.subagentStateWrites.delete(sessionId);
        }
      })
      .catch(() => undefined);
    this.trackRuntimeWrite(sessionId, write);
  }

  private persistSubagentState(sessionId: string, record: PersistedTaskRecord): void {
    if (this.shutdownTimedOut || this.deletingSessions.has(sessionId)) return;
    const payload = JSON.stringify({ version: 1, task: record });
    const key = sessionId;
    const previous = this.subagentStateWrites.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(async () => {
        // Deletion intentionally discards queued checkpoints; the final purge is authoritative.
        if (this.shutdownTimedOut || this.deletingSessions.has(sessionId)) return;
        const sizeBytes = Buffer.byteLength(payload, "utf8");
        if (sizeBytes > MAX_SUBAGENT_STATE_BYTES) {
          throw new Error(
            `Subagent ${record.id} state is ${sizeBytes} bytes; maximum is ${MAX_SUBAGENT_STATE_BYTES}`,
          );
        }
        await this.runSessionProjection(sessionId, async () => {
          let existing = (await this.artifacts.list(sessionId)).filter(isInternalArtifact);
          const payloadSha256 = createHash("sha256").update(payload).digest("hex");
          let identical = existing.find((artifact) => artifact.sha256 === payloadSha256);
          let projectedBytes =
            existing.reduce((total, artifact) => total + artifact.sizeBytes, 0) +
            (identical ? 0 : sizeBytes);
          if (projectedBytes > MAX_SUBAGENT_STATE_SESSION_BYTES) {
            // Successful checkpoints leave two generations per task. Under quota pressure retain
            // the latest known-good generation for this task, then retry the exact accounting.
            const sameTask = existing
              .filter((candidate) => candidate.metadata?.["taskId"] === record.id)
              .sort(
                (left, right) =>
                  right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
              );
            const staleIds = new Set(sameTask.slice(1).map((candidate) => candidate.id));
            for (const staleId of staleIds) await this.artifacts.delete(sessionId, staleId);
            existing = existing.filter((candidate) => !staleIds.has(candidate.id));
            identical = existing.find((artifact) => artifact.sha256 === payloadSha256);
            projectedBytes =
              existing.reduce((total, artifact) => total + artifact.sizeBytes, 0) +
              (identical ? 0 : sizeBytes);
          }
          if (projectedBytes > MAX_SUBAGENT_STATE_SESSION_BYTES) {
            throw new Error(
              `Subagent state quota would reach ${projectedBytes} bytes; session maximum is ${MAX_SUBAGENT_STATE_SESSION_BYTES}`,
            );
          }
          const artifact =
            identical ??
            (await this.artifacts.put({
              sessionId,
              kind: "other",
              name: `subagent-${record.id}.json`,
              mediaType: SUBAGENT_STATE_MEDIA_TYPE,
              data: payload,
              metadata: { taskId: record.id, status: record.status },
            }));
          const created = !identical;
          try {
            await this.outbox.publish({
              streamId: sessionId,
              type: "subagent.state",
              data: { taskId: record.id, status: record.status, artifactId: artifact.id },
              idempotencyKey: `subagent.state:${record.id}:${artifact.id}`,
            });
          } catch (error) {
            if (created) {
              try {
                await this.artifacts.delete(sessionId, artifact.id);
              } catch (cleanupError) {
                throw new AggregateError(
                  [error, cleanupError],
                  `Failed to publish and roll back subagent state ${record.id}`,
                  { cause: cleanupError },
                );
              }
            }
            throw error;
          }
          const sameTask = [
            ...existing.filter((candidate) => candidate.id !== artifact.id),
            artifact,
          ]
            .filter(
              (candidate) =>
                isInternalArtifact(candidate) && candidate.metadata?.["taskId"] === record.id,
            )
            .sort(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
            );
          const keep = new Set<string>([artifact.id]);
          for (const candidate of sameTask) {
            if (keep.size >= SUBAGENT_CHECKPOINTS_PER_TASK) break;
            keep.add(candidate.id);
          }
          for (const stale of sameTask.filter((candidate) => !keep.has(candidate.id))) {
            await this.artifacts.delete(sessionId, stale.id);
          }
        });
      });
    this.subagentStateWrites.set(key, write);
    void write
      .finally(() => {
        if (this.subagentStateWrites.get(key) === write) this.subagentStateWrites.delete(key);
      })
      .catch(() => undefined);
    this.trackRuntimeWrite(sessionId, write);
  }

  /** 从 append-only runtime facts 恢复不属于 transcript 的会话状态。 */
  private async recoverSessionProjection(sessionId: string): Promise<RecoveredSessionProjection> {
    const events = await this.runtime.events(sessionId);
    const checkpoints: Checkpoint[] = [];
    let usage: Usage | undefined;
    let usageSequence = 0;
    let lastInputTokens: number | undefined;
    const taskArtifacts = new Map<string, string[]>();
    const evictedTaskIds = new Set<string>();
    for (const event of events) {
      const data = event.data as Record<string, unknown>;
      if (event.type === "checkpoint.created") {
        const checkpoint = checkpointValue(data);
        if (checkpoint) checkpoints.push(checkpoint);
      } else if (event.type === "session.reverted") {
        const id = typeof data["checkpointId"] === "string" ? data["checkpointId"] : "";
        const index = checkpoints.findIndex((checkpoint) => checkpoint.id === id);
        if (index >= 0) checkpoints.splice(index);
      } else if (event.type === "agent.completed") {
        const restored = usageValue(data["usage"]);
        if (restored) {
          usage = restored;
          usageSequence = event.sequence;
        }
      } else if (event.type === "agent.turn_completed") {
        const realInput = Number(data["realInputTokens"]);
        if (Number.isFinite(realInput) && realInput > 0) lastInputTokens = Math.floor(realInput);
        if (event.sequence > usageSequence) {
          const delta = usageValue(data["usage"]);
          if (delta) usage = addUsage(usage, delta);
        }
      } else if (event.type === "subagent.usage_credited") {
        if (event.sequence > usageSequence) {
          const delta = usageValue(data["delta"]);
          if (delta) usage = addUsage(usage, delta);
        }
      } else if (event.type === "subagent.evicted") {
        const taskId = typeof data["taskId"] === "string" ? data["taskId"] : "";
        if (/^t[1-9]\d{0,5}$/.test(taskId)) {
          evictedTaskIds.add(taskId);
          taskArtifacts.delete(taskId);
        }
      } else if (event.type === "subagent.state") {
        const taskId = typeof data["taskId"] === "string" ? data["taskId"] : "";
        const artifactId = typeof data["artifactId"] === "string" ? data["artifactId"] : "";
        if (/^t[1-9]\d{0,5}$/.test(taskId) && artifactId && !evictedTaskIds.has(taskId)) {
          const candidates = taskArtifacts.get(taskId) ?? [];
          candidates.unshift(artifactId);
          if (candidates.length > 8) candidates.length = 8;
          taskArtifacts.delete(taskId);
          taskArtifacts.set(taskId, candidates);
          while (taskArtifacts.size > 32) taskArtifacts.delete(taskArtifacts.keys().next().value!);
        }
      }
    }
    if (evictedTaskIds.size > 0) {
      for (const artifact of await this.artifacts.list(sessionId)) {
        const taskId = artifact.metadata?.["taskId"];
        if (
          isInternalArtifact(artifact) &&
          typeof taskId === "string" &&
          evictedTaskIds.has(taskId)
        ) {
          await this.artifacts.delete(sessionId, artifact.id);
        }
      }
    }
    const tasks: PersistedTaskRecord[] = [];
    for (const [expectedTaskId, artifactIds] of taskArtifacts) {
      for (const artifactId of artifactIds) {
        try {
          const artifact = await this.artifacts.get(sessionId, artifactId);
          if (
            !artifact ||
            artifact.artifact.mediaType !== SUBAGENT_STATE_MEDIA_TYPE ||
            artifact.artifact.metadata?.["taskId"] !== expectedTaskId ||
            artifact.artifact.sizeBytes > MAX_SUBAGENT_STATE_BYTES
          ) {
            continue;
          }
          const document = JSON.parse(new TextDecoder().decode(artifact.data)) as unknown;
          const envelope =
            document && typeof document === "object" && !Array.isArray(document)
              ? (document as Record<string, unknown>)
              : undefined;
          if (envelope?.["version"] !== 1) continue;
          const task = parsePersistedTaskRecord(envelope["task"]);
          if (task?.id === expectedTaskId) {
            tasks.push(task);
            break;
          }
        } catch {
          // Try the previous last-known-good checkpoint before dropping this task entirely.
        }
      }
    }
    return {
      checkpoints,
      ...(usage ? { usage } : {}),
      ...(lastInputTokens ? { lastInputTokens } : {}),
      ...(tasks.length ? { tasks } : {}),
    };
  }

  /** Final exact lease/fencing gate shared by this root drive and every detached descendant. */
  private async assertCommandOwnership(command: DurableCommand): Promise<void> {
    const sessionId = command.sessionId;
    try {
      if (this.activeCommands.get(sessionId)?.get(command.id) !== command) {
        throw new Error(`Durable command ${command.id} no longer owns this execution tree`);
      }
      await this.commandInbox.heartbeat(
        sessionId,
        command.id,
        this.workerId,
        60_000,
        command.fencingToken,
      );
      if (this.activeCommands.get(sessionId)?.get(command.id) !== command) {
        throw new Error(`Durable command ${command.id} changed during the execution fence`);
      }
    } catch (error) {
      if (this.interruptedCommands.get(sessionId)?.has(command.id)) {
        throw new Error(t("Session interrupted", "会话已中断"), { cause: error });
      }
      // Abort the stale drive synchronously; ensureLive waits this common retirement fence before
      // constructing a replacement Agent.
      this.retireSessionAfterCommandLeaseLoss(sessionId);
      throw error;
    }
  }

  /** Persist every monotonic budget mutation before the provider/tool side effect it authorizes. */
  private async persistRunBudgetCheckpoint(
    command: DurableCommand,
    input: RunBudgetSnapshot,
  ): Promise<void> {
    const sessionId = command.sessionId;
    this.assertSessionAvailable(sessionId);
    const snapshot = validateRunBudgetSnapshot(input);
    await this.assertCommandOwnership(command);
    await this.outbox.publish({
      streamId: sessionId,
      type: "command.budget_checkpoint",
      data: { commandId: command.id, snapshot },
      idempotencyKey: `command:${command.id}:budget:${snapshot.revision}`,
    });
    await this.assertCommandOwnership(command);
  }

  private initialRunBudgetSnapshot(command: DurableCommand): RunBudgetSnapshot {
    const startedAt = Date.parse(command.createdAt);
    if (!Number.isSafeInteger(startedAt) || startedAt < 0 || startedAt > Date.now() + 60_000) {
      throw new Error(`Durable command ${command.id} has an invalid creation timestamp`);
    }
    return {
      version: 1,
      revision: 0,
      startedAt,
      chargedUsage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      chargedCostUSD: 0,
      reservedTokens: 0,
      reservedCostUSD: 0,
      toolCalls: 0,
    };
  }

  /** Replay the highest valid checkpoint for one command; malformed/conflicting facts fail closed. */
  private async recoverRunBudgetSnapshot(
    sessionId: string,
    command: DurableCommand,
  ): Promise<RunBudgetSnapshot> {
    let latest: RunBudgetSnapshot | undefined;
    for (const event of await this.runtime.events(sessionId)) {
      if (event.type !== "command.budget_checkpoint") continue;
      const data = event.data as Record<string, unknown>;
      if (data["commandId"] !== command.id) continue;
      let candidate: RunBudgetSnapshot;
      try {
        candidate = validateRunBudgetSnapshot(data["snapshot"] as RunBudgetSnapshot);
      } catch (error) {
        throw new Error(`Invalid durable budget checkpoint for command ${command.id}`, {
          cause: error,
        });
      }
      if (candidate.startedAt !== Date.parse(command.createdAt)) {
        throw new Error(`Durable budget checkpoint changed start time for command ${command.id}`);
      }
      if (latest && candidate.revision <= latest.revision) {
        if (
          candidate.revision !== latest.revision ||
          JSON.stringify(candidate) !== JSON.stringify(latest)
        ) {
          throw new Error(`Non-monotonic durable budget checkpoint for command ${command.id}`);
        }
        continue;
      }
      latest = candidate;
    }
    return latest ?? this.initialRunBudgetSnapshot(command);
  }

  private trackRuntimeWrite<T>(sessionId: string, promise: Promise<T>): void {
    const sequence = (this.runtimeWriteSequences.get(sessionId) ?? 0) + 1;
    this.runtimeWriteSequences.set(sessionId, sequence);
    const writes = this.runtimeWrites.get(sessionId) ?? new Map<number, Promise<unknown>>();
    writes.set(sequence, promise);
    this.runtimeWrites.set(sessionId, writes);
    const cleanup = () => {
      const current = this.runtimeWrites.get(sessionId);
      current?.delete(sequence);
      if (current?.size === 0) this.runtimeWrites.delete(sessionId);
    };
    void promise.then(cleanup, (error) => {
      const failures = this.runtimeWriteFailures.get(sessionId) ?? new Map<number, unknown>();
      if (failures.size < MAX_RUNTIME_FAILURES_PER_SESSION) failures.set(sequence, error);
      else {
        const overflow = this.runtimeWriteFailureOverflow.get(sessionId);
        this.runtimeWriteFailureOverflow.set(sessionId, {
          firstSequence: Math.min(overflow?.firstSequence ?? sequence, sequence),
          count: (overflow?.count ?? 0) + 1,
        });
      }
      this.runtimeWriteFailures.set(sessionId, failures);
      this.durabilityFailureCount++;
      if (this.durabilityFailures.length < MAX_DURABILITY_FAILURE_DETAILS) {
        this.durabilityFailures.push(error);
      }
      cleanup();
    });
  }

  private async flushRuntimeWrites(
    sessionId: string,
    options: { discardFailures?: boolean; dynamic?: boolean } = {},
  ): Promise<void> {
    // Ordinary operations wait only through the causal watermark observed at callback completion.
    // Delete/shutdown use dynamic=true to drain detached producers until the set is truly empty.
    const watermark = options.dynamic
      ? Number.POSITIVE_INFINITY
      : (this.runtimeWriteSequences.get(sessionId) ?? 0);
    for (;;) {
      const writes = [...(this.runtimeWrites.get(sessionId)?.entries() ?? [])]
        .filter(([sequence]) => sequence <= watermark)
        .map(([, promise]) => promise);
      if (writes.length === 0) break;
      await Promise.allSettled(writes);
      if (!options.dynamic) break;
    }
    const failures = this.runtimeWriteFailures.get(sessionId);
    const observed: unknown[] = [];
    if (failures) {
      for (const [sequence, error] of failures) {
        if (sequence <= watermark) {
          observed.push(error);
          failures.delete(sequence);
        }
      }
      if (failures.size === 0) this.runtimeWriteFailures.delete(sessionId);
    }
    const overflow = this.runtimeWriteFailureOverflow.get(sessionId);
    if (overflow && overflow.firstSequence <= watermark) {
      this.runtimeWriteFailureOverflow.delete(sessionId);
      observed.push(
        new Error(`${overflow.count} additional runtime projection failures were suppressed`),
      );
    }
    if (!options.discardFailures && observed.length > 0) {
      throw new AggregateError(observed, `Runtime projection failed for session ${sessionId}`);
    }
  }

  private async recoverSessionCommands(session: ManagedSession): Promise<number> {
    const sessionId = session.meta.id;
    // A process can die after the inbox terminal update commits but before the separate outbox
    // enqueue. Rebuild the canonical event first; outbox/runtime idempotency makes every startup
    // and explicit retry safe, including a second crash during this reconciliation itself.
    await this.reconcileCommandTerminalEvents(sessionId);
    await this.outbox.flush();
    await this.runtime.reconcileInterrupted(sessionId);
    const commands = await this.commandInbox.recoverable(sessionId);
    let recovered = 0;
    for (const command of commands) {
      if (this.disposed || session.running || this.deletingSessions.has(sessionId)) break;
      let claimed: DurableCommand;
      try {
        claimed = await this.commandInbox.claim(sessionId, command.id, this.workerId);
      } catch {
        continue;
      }
      if (this.disposed) {
        await this.commandInbox.finish(sessionId, claimed.id, "cancelled", "host shutting down", {
          owner: this.workerId,
          fencingToken: claimed.fencingToken ?? 0,
        });
        await this.publishCommandTerminalEvent({
          ...claimed,
          status: "cancelled",
          error: "host shutting down",
        });
        break;
      }
      this.activateCommand(claimed);
      const heartbeat = this.startCommandHeartbeat(claimed);
      const historyAdvanced = session.snapshot().messages.length > command.messageCountBefore;
      await this.outbox.publish({
        streamId: sessionId,
        type: "prompt.recovered",
        data: { commandId: command.id, attempt: claimed.attempts, historyAdvanced },
        idempotencyKey: `command:${command.id}:recovered:${claimed.attempts}`,
      });
      try {
        await heartbeat.assertOwned();
        const recoveredTraceParent = parseTraceparent(command.traceparent);
        const runBudgetSnapshot = await this.recoverRunBudgetSnapshot(sessionId, claimed);
        const outcome = await session.send(
          historyAdvanced
            ? t(
                "Continue the interrupted command from the durable history. Inspect prior tool results, do not repeat completed side effects, finish the remaining work, and verify it.",
                "从耐久历史继续刚才中断的命令。检查已有工具结果，不要重复已完成的副作用，完成剩余工作并验证。",
              )
            : command.text,
          {
            ...(command.model ? { model: command.model } : {}),
            ...(historyAdvanced ? { resume: true } : {}),
            ...(recoveredTraceParent ? { traceParent: recoveredTraceParent } : {}),
            runBudgetSnapshot,
            beforeToolExecution: () => this.assertCommandOwnership(claimed),
            onRunBudgetCheckpoint: (snapshot) => this.persistRunBudgetCheckpoint(claimed, snapshot),
          },
        );
        await this.flushRuntimeWrites(sessionId);
        await heartbeat.assertOwned();
        if (outcome.error) {
          await this.commandInbox.finish(sessionId, command.id, "failed", outcome.error.message, {
            owner: this.workerId,
            fencingToken: claimed.fencingToken ?? 0,
          });
          await this.publishCommandTerminalEvent({
            ...command,
            status: "failed",
            error: outcome.error.message,
          });
        } else {
          await this.commandInbox.finish(sessionId, command.id, "completed", undefined, {
            owner: this.workerId,
            fencingToken: claimed.fencingToken ?? 0,
          });
          await this.publishCommandTerminalEvent({ ...command, status: "completed" });
          recovered++;
        }
      } catch (error) {
        const terminal = await this.commandInbox.get(sessionId, command.id);
        if (
          terminal &&
          (terminal.status === "completed" ||
            terminal.status === "failed" ||
            terminal.status === "cancelled")
        ) {
          await this.publishCommandTerminalEvent(terminal);
          continue;
        }
        const terminalError = error instanceof Error ? error.message : String(error);
        await this.commandInbox.finish(sessionId, command.id, "failed", terminalError, {
          owner: this.workerId,
          fencingToken: claimed.fencingToken ?? 0,
        });
        await this.publishCommandTerminalEvent({
          ...command,
          status: "failed",
          error: terminalError,
        });
      } finally {
        await heartbeat.stop();
        this.deactivateCommand(sessionId, command.id);
      }
    }
    return recovered;
  }

  private async reconcileCommandTerminalEvents(sessionId: string): Promise<void> {
    const events = await this.runtime.events(sessionId);
    const terminalEvents = new Map(
      events
        .filter((event) => event.idempotencyKey?.startsWith("command:"))
        .map((event) => [event.idempotencyKey!, event] as const),
    );
    const commands = await this.commandInbox.store.read(sessionId);
    for (const command of commands) {
      if (
        command.status === "completed" ||
        command.status === "failed" ||
        command.status === "cancelled"
      ) {
        const key = `command:${command.id}:${command.status}`;
        const existing = terminalEvents.get(key);
        if (existing) {
          const data = existing.data as { commandId?: unknown };
          if (existing.type !== `prompt.${command.status}` || data.commandId !== command.id) {
            throw new Error(`Conflicting terminal event for durable command ${command.id}`);
          }
          continue;
        }
        await this.publishCommandTerminalEvent(command);
      }
    }
  }

  /** Publish one canonical terminal event whose key and payload depend only on inbox state. */
  private async publishCommandTerminalEvent(command: DurableCommand): Promise<void> {
    if (
      command.status !== "completed" &&
      command.status !== "failed" &&
      command.status !== "cancelled"
    ) {
      throw new Error(`Cannot publish non-terminal durable command ${command.id}`);
    }
    const error =
      command.status === "completed"
        ? undefined
        : (command.error ?? `Durable command ${command.id} ${command.status}`);
    await this.outbox.publish({
      streamId: command.sessionId,
      type: `prompt.${command.status}`,
      data: { commandId: command.id, ...(error ? { error } : {}) },
      idempotencyKey: `command:${command.id}:${command.status}`,
    });
  }

  private startCommandHeartbeat(command: DurableCommand): {
    assertOwned(): Promise<void>;
    stop(): Promise<void>;
  } {
    let stopped = false;
    let lost: Error | undefined;
    let tail: Promise<void> = Promise.resolve();
    const lose = (error: unknown) => {
      if (lost) return;
      lost = this.interruptedCommands.get(command.sessionId)?.has(command.id)
        ? new Error(t("Session interrupted", "会话已中断"), { cause: error })
        : error instanceof Error
          ? error
          : new Error(String(error));
      if (this.interruptedCommands.get(command.sessionId)?.has(command.id)) return;
      this.retireSessionAfterCommandLeaseLoss(command.sessionId);
    };
    const renew = (): Promise<void> => {
      if (stopped) return tail;
      tail = tail
        .catch(() => undefined)
        .then(() =>
          this.commandInbox.heartbeat(
            command.sessionId,
            command.id,
            this.workerId,
            60_000,
            command.fencingToken,
          ),
        )
        .catch((error) => {
          lose(error);
        });
      return tail;
    };
    const timer = setInterval(() => void renew(), 20_000);
    timer.unref?.();
    return {
      async assertOwned() {
        if (lost) throw lost;
        await renew();
        if (lost) throw lost;
      },
      async stop() {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
        await tail;
      },
    };
  }

  /** One authoritative retirement path for timer, checkpoint and final tool-dispatch lease loss. */
  private retireSessionAfterCommandLeaseLoss(sessionId: string): void {
    if (this.retiringSessions.has(sessionId)) return;
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.stopBackgroundTasks();
    session.close();
    const retirement = (async () => {
      const drained = await Promise.allSettled([
        session.whenIdle(),
        session.whenBackgroundTasksIdle(),
        session.whenPersistenceIdle(),
      ]);
      const failures = drained.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to retire session ${sessionId}`);
      }
      if (this.sessions.get(sessionId) === session && !this.deletingSessions.has(sessionId)) {
        this.sessions.delete(sessionId);
        await this.closeSessionLspPool(sessionId).catch(() => undefined);
        await this.waitForLspTermination(sessionId);
      }
    })();
    this.retiringSessions.set(sessionId, retirement);
    void retirement
      .finally(() => {
        if (this.retiringSessions.get(sessionId) === retirement) {
          this.retiringSessions.delete(sessionId);
        }
      })
      .catch((error) => {
        this.durabilityFailureCount++;
        if (this.durabilityFailures.length < MAX_DURABILITY_FAILURE_DETAILS) {
          this.durabilityFailures.push(error);
        }
      });
  }

  /** Join an already-running idempotent retry without ever taking over its live lease. */
  private async waitForCommandTerminal(
    command: DurableCommand,
    interruptEpoch: number,
  ): Promise<void> {
    const configuredWallTime = this.opts.runBudget?.maxWallTimeMs ?? 30 * 60_000;
    const createdAt = Date.parse(command.createdAt);
    // One lease interval accounts for durable ACK/projection after the model wall-time budget.
    const deadline = Math.max(
      Date.now() + 1_000,
      (Number.isFinite(createdAt) ? createdAt : Date.now()) + configuredWallTime + 60_000,
    );
    for (;;) {
      this.assertSendGeneration(command.sessionId, interruptEpoch);
      this.assertSessionAvailable(command.sessionId);
      const current = await this.commandInbox.get(command.sessionId, command.id);
      if (!current) throw new Error(`Durable command ${command.id} disappeared while joining`);
      if (current.status === "completed") {
        await this.publishCommandTerminalEvent(current);
        return;
      }
      if (current.status === "failed" || current.status === "cancelled") {
        await this.publishCommandTerminalEvent(current);
        throw new Error(current.error ?? `Durable command ${command.id} ${current.status}`);
      }
      if (
        current.status === "running" &&
        current.leaseExpiresAt !== undefined &&
        Date.parse(current.leaseExpiresAt) <= Date.now()
      ) {
        throw new Error(
          `Durable command ${command.id} lease expired before completion; recovery is required`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for idempotent command ${command.id}`);
      }
      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(100, this.sessionLifecyclePollMs)),
      );
    }
  }

  private activateCommand(command: DurableCommand): void {
    const active = this.activeCommands.get(command.sessionId) ?? new Map<string, DurableCommand>();
    active.set(command.id, command);
    this.activeCommands.set(command.sessionId, active);
  }

  private deactivateCommand(sessionId: string, commandId: string): void {
    const interrupted = this.interruptedCommands.get(sessionId);
    interrupted?.delete(commandId);
    if (interrupted?.size === 0) this.interruptedCommands.delete(sessionId);
    const active = this.activeCommands.get(sessionId);
    if (!active) return;
    active.delete(commandId);
    if (active.size === 0) this.activeCommands.delete(sessionId);
  }
}
