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
import type { ChatMessage, Provider, Usage } from "./types.js";
import { Agent, type AgentEvent, type AgentOptions, type AgentResolvedModel } from "./agent.js";
import type { ToolRegistry } from "./tools/tool.js";
import type { HookRegistration } from "./hooks.js";
import type { CompactionConfig } from "./context.js";
import type { WebSearchBackend } from "./tools/web-search.js";
import { LspPool, type LspServerConfig } from "./lsp.js";
import { newSessionId, type ISessionStore, type SessionMeta } from "./session.js";
import { defaultSmallModel } from "./provider/registry.js";
import { appendLocalAllowRules } from "./permission-store.js";
import type {
  PermissionConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionMode,
  PermissionProfile,
} from "./permission.js";

// ---------- 对外事件与快照 ----------

/** 会话级事件：包裹 AgentEvent，另加权限询问与运行态变化 */
export type SessionEvent =
  | { type: "agent"; event: AgentEvent }
  | { type: "permission_request"; permId: string; toolName: string; ruleKey: string }
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

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: ChatMessage[];
  usage: Usage;
  /** 会话累计成本估算（美元）；模型无内置价格信息时缺省。 */
  costUSD?: number;
  running: boolean;
  /** 订阅时仍待裁决的权限请求（重连场景不至于卡死） */
  pendingPermissions: { permId: string; toolName: string; ruleKey: string }[];
}

export interface SessionSummary extends SessionMeta {
  running: boolean;
}

export type SessionListener = (ev: SessionEvent) => void;

/** firehose 监听者：收到事件所属的 sessionId 与事件本体。 */
export type GlobalListener = (sessionId: string, ev: SessionEvent) => void;

export interface SessionManagerOptions {
  /** 按 model 字符串产出 provider 实例（通常包 createProvider） */
  resolveProvider: (model: string) => AgentResolvedModel;
  store: ISessionStore;
  /** 传入即为所有会话启用工具集（默认 Agent 内置默认工具） */
  tools?: () => ToolRegistry;
  /** 每会话默认开启压缩 */
  compaction?: Partial<CompactionConfig> | boolean;
  /** 会话权限策略；confirm 始终由 SessionManager 接管并广播给前端。 */
  permission?: Omit<PermissionConfig, "confirm">;
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
  /**
   * 摘要等杂活用的小模型。`true`=按会话 provider 自动推导便宜模型；字符串=显式 spec；
   * 省略/false=用主模型。解析失败会静默回退主模型（见 Agent）。
   */
  smallModel?: boolean | string;
  /** 模型降级链：主模型重试仍失败时按序切换（对齐 Claude Code fallbackModel）。 */
  fallbackModels?: string[];
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
  /** 生成会话 id 的时钟/随机源（测试可注入） */
  now?: () => number;
  rand?: () => number;
}

interface PendingPerm {
  toolName: string;
  ruleKey: string;
  resolve: (d: PermissionDecision) => void;
}

interface SendWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  steering: boolean;
}

interface PendingSend extends SendWaiter {
  text: string;
  /** per-prompt 模型覆盖：仅这一次 drive 用该模型。 */
  model?: string;
}

type ResolvedProvider = ReturnType<SessionManagerOptions["resolveProvider"]>;

// ---------- 一个受管会话 ----------

class ManagedSession {
  readonly meta: SessionMeta;
  private agent: Agent;
  private listeners = new Set<SessionListener>();
  private eventQueue: SessionEvent[] = [];
  private emitting = false;
  private pending = new Map<string, PendingPerm>();
  private abort: AbortController | null = null;
  private permSeq = 0;
  private driving = false;
  private checkpoints: Checkpoint[] = [];
  private pendingSends: PendingSend[] = [];
  private currentWaiters: SendWaiter[] = [];

  constructor(
    meta: SessionMeta,
    makeAgent: (confirm: (r: PermissionRequest) => Promise<PermissionDecision>) => Agent,
  ) {
    this.meta = meta;
    this.agent = makeAgent((r) => this.onConfirm(r));
  }

  get running(): boolean {
    return this.driving;
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
      pendingPermissions: [...this.pending.entries()].map(([permId, p]) => ({
        permId,
        toolName: p.toolName,
        ruleKey: p.ruleKey,
      })),
    };
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
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
      this.pending.set(permId, { toolName: r.toolName, ruleKey: r.ruleKey, resolve });
      this.emit({ type: "permission_request", permId, toolName: r.toolName, ruleKey: r.ruleKey });
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
  send(text: string, opts?: { model?: string }): Promise<void> {
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
          for await (const ev of this.agent.send(
            next.text,
            this.abort.signal,
            next.model ? { model: next.model } : undefined,
          )) {
            if (ev.type === "checkpoint") {
              this.checkpoints.push({
                id: ev.id,
                tree: ev.tree,
                label: ev.label,
                messageCount: ev.messageCount,
              });
            }
            this.emit({ type: "agent", event: ev });
          }
          for (const waiter of this.currentWaiters) waiter.resolve();
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
    }
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
    this.agent.setPermissionMode(mode);
  }

  getPermissionMode(): PermissionMode {
    return this.agent.getPermissionMode();
  }

  setPermissionProfile(name: string): PermissionMode {
    return this.agent.setPermissionProfile(name);
  }

  listPermissionProfiles(): Record<string, PermissionProfile> {
    return this.agent.listPermissionProfiles();
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

/** 调一次模型把首条输入总结成短标题；清洗引号/换行并截断。失败返回 null。 */
async function generateSessionTitle(
  provider: Provider,
  model: string,
  firstUserText: string,
): Promise<string | null> {
  let out = "";
  try {
    for await (const ev of provider.stream({
      model,
      system: t(
        "Summarize the user's task as a session title in at most 8 words. Output ONLY the title, no quotes, no punctuation at the end.",
        "把用户的任务概括成会话标题，不超过 12 个字。只输出标题本身，不要引号，结尾不要标点。",
      ),
      messages: [{ role: "user", content: [{ type: "text", text: firstUserText.slice(0, 2000) }] }],
      maxTokens: 60,
    })) {
      if (ev.type === "done") {
        out = ev.message.content
          .filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("");
      }
    }
  } catch {
    return null;
  }
  const title = out
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean)
    ?.replace(/^["'「『]|["'」』]$/g, "")
    .replace(/[。.!！]$/g, "")
    .trim()
    .slice(0, 40);
  return title || null;
}

// ---------- 管理器 ----------

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  /** 冷会话并发 open/send 时共享同一次磁盘加载，避免订阅到被覆盖的孤儿实例。 */
  private loading = new Map<string, Promise<ManagedSession>>();
  private opts: SessionManagerOptions;
  /** 每会话按 cwd 建的 LSP 池；进程销毁时统一关闭，避免遗留语言服务器进程。 */
  private lspPools = new Set<LspPool>();
  /** firehose 订阅者：收所有 live 会话的事件（见 subscribeAll）。 */
  private globalListeners = new Set<GlobalListener>();

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
  }

  async listSessions(): Promise<SessionSummary[]> {
    const metas = await this.opts.store.list();
    return metas
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
    // provider 解析可能因未知配置失败；必须在落盘前完成，避免留下一个永远
    // 无法 open/resume 的孤儿 JSONL。解析结果直接交给 instantiate，勿重复创建。
    const resolved = this.opts.resolveProvider(input.model);
    const id = newSessionId((this.opts.now ?? Date.now)(), this.opts.rand ?? Math.random);
    const meta = await this.opts.store.create({
      id,
      cwd: input.cwd,
      model: input.model,
      ...(input.title ? { title: input.title } : {}),
    });
    this.instantiate(meta, [], resolved);
    return { ...meta, running: false };
  }

  /** resume：从磁盘载入历史，实例化 live 会话（若已在内存则复用） */
  async resumeSession(sessionId: string): Promise<SessionSnapshot> {
    return (await this.ensureLive(sessionId)).snapshot();
  }

  /**
   * fork：把一个会话的对话历史复制成新会话（对齐 Codex `/fork` 与 Claude Code
   * --fork-session）。原会话不动；新会话从复制点独立演化。
   * upToMessage 可截断到前 N 条消息（分叉到较早的节点）；截断产生的悬空
   * tool_call 等由 Agent 载入时的历史自愈处理。
   */
  async forkSession(
    sessionId: string,
    opts?: { title?: string; upToMessage?: number },
  ): Promise<SessionSummary> {
    const source = await this.ensureLive(sessionId);
    const snap = source.snapshot();
    const messages =
      opts?.upToMessage !== undefined ? snap.messages.slice(0, opts.upToMessage) : snap.messages;
    const resolved = this.opts.resolveProvider(snap.meta.model);
    const id = newSessionId((this.opts.now ?? Date.now)(), this.opts.rand ?? Math.random);
    const title = opts?.title ?? (snap.meta.title ? `${snap.meta.title} (fork)` : undefined);
    const meta = await this.opts.store.create({
      id,
      cwd: snap.meta.cwd,
      model: snap.meta.model,
      ...(title ? { title } : {}),
    });
    // 复制的历史整体落盘（rewrite 原子替换含 meta 头的整份文件）。
    await this.opts.store.rewrite(meta, messages);
    this.instantiate(meta, messages, resolved);
    return { ...meta, running: false };
  }

  private async loadSession(sessionId: string): Promise<ManagedSession> {
    const data = await this.opts.store.load(sessionId);
    const meta: SessionMeta = {
      id: data.id,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      cwd: data.cwd,
      model: data.model,
      ...(data.title ? { title: data.title } : {}),
    };
    const resolved = this.opts.resolveProvider(meta.model);
    return this.instantiate(meta, data.messages, resolved);
  }

  /** 订阅：立即回放 snapshot，之后实时收事件。返回 unsubscribe。 */
  async open(
    sessionId: string,
    listener: SessionListener,
  ): Promise<{ snapshot: SessionSnapshot; close: () => void }> {
    const session = await this.ensureLive(sessionId);
    const close = session.subscribe(listener);
    return { snapshot: session.snapshot(), close };
  }

  async send(sessionId: string, text: string, opts?: { model?: string }): Promise<void> {
    const session = await this.ensureLive(sessionId);
    await session.send(text, opts);
    // 自动命名：首轮结束且仍无标题时用小模型总结（对齐 Codex/Claude Code）。
    // 放在 send 收尾而非并行，避免与本轮持久化竞争；失败静默。
    if (this.opts.autoTitle && !session.meta.title) await this.autoTitle(session);
  }

  /** 用小模型（未配置则用会话主模型）从首条用户输入总结一个短标题。 */
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
      const resolved = this.opts.resolveProvider(session.meta.model);
      let provider = resolved.provider;
      let model = resolved.model;
      const smallSpec = this.smallModelSpec(resolved);
      if (smallSpec) {
        try {
          const small = this.opts.resolveProvider(smallSpec);
          provider = small.provider;
          model = small.model;
        } catch {
          /* 小模型解析失败回退主模型 */
        }
      }
      const title = await generateSessionTitle(provider, model, text);
      if (!title || session.meta.title) return;
      session.meta.title = title;
      await this.opts.store.rewrite(session.meta, session.snapshot().messages);
      session.announceTitle(title);
    } catch {
      /* 起名失败静默——标题只是 UX 加分项 */
    }
  }

  async interrupt(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.interrupt();
  }

  /** 列出会话的可撤销点（最近的在末尾）。未加载/未启用快照时返回空数组。 */
  listCheckpoints(sessionId: string): Checkpoint[] {
    return this.sessions.get(sessionId)?.listCheckpoints() ?? [];
  }

  /** 手动压缩会话上下文（/compact）：立即压缩一次。 */
  async compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    const session = await this.ensureLive(sessionId);
    return session.compact();
  }

  /** 撤销会话到某快照（缺省=最近一个）。mode: files（默认）/conversation/both。 */
  async undo(
    sessionId: string,
    checkpointId?: string,
    mode: RewindMode = "files",
  ): Promise<{ restored: number; deleted: number; removedMessages: number }> {
    const session = await this.ensureLive(sessionId);
    return session.undo(checkpointId, mode);
  }

  /** 运行时切换会话的权限模式（如 /plan 进入/退出计划模式）。 */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = await this.ensureLive(sessionId);
    session.setPermissionMode(mode);
  }

  /** 运行时切换会话的权限档位；返回切换后的生效模式。 */
  async setPermissionProfile(sessionId: string, name: string): Promise<PermissionMode> {
    const session = await this.ensureLive(sessionId);
    return session.setPermissionProfile(name);
  }

  /** 会话可用的权限档位（内置 + 自定义）。 */
  async listPermissionProfiles(sessionId: string): Promise<Record<string, PermissionProfile>> {
    const session = await this.ensureLive(sessionId);
    return session.listPermissionProfiles();
  }

  /** 同步读取一个 live 会话的当前快照；未加载则返回 undefined（不触发磁盘载入）。 */
  peek(sessionId: string): SessionSnapshot | undefined {
    return this.sessions.get(sessionId)?.snapshot();
  }

  /** 删除会话：中断 live drive、移出内存、删除磁盘文件。删除不存在的会话是无操作。 */
  async deleteSession(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (live) {
      live.interrupt();
      this.sessions.delete(sessionId);
    }
    this.loading.delete(sessionId);
    await this.opts.store.delete(sessionId);
  }

  /** 重命名会话标题并持久化。应在会话空闲（无进行中回合）时调用以避免与消息落盘竞争。 */
  async setTitle(sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    const session = await this.ensureLive(sessionId);
    session.meta.title = trimmed;
    // rewrite 原子替换整份文件（含 meta 头），把新标题落盘。
    await this.opts.store.rewrite(session.meta, session.snapshot().messages);
  }

  async answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionAnswer,
  ): Promise<boolean> {
    return this.sessions.get(sessionId)?.answerPermission(permId, decision) ?? false;
  }

  /** 进程内宿主销毁时停止所有 live drive；daemon 断开客户端不会调用此方法。 */
  dispose(): void {
    for (const session of this.sessions.values()) session.interrupt();
    for (const pool of this.lspPools) pool.closeAll();
    this.lspPools.clear();
  }

  /** 为某会话 cwd 建一个 LSP 池并登记，供 dispose 统一关闭。 */
  private lspPoolFor(cwd: string): LspPool {
    const pool = new LspPool(cwd, this.opts.lsp ?? []);
    this.lspPools.add(pool);
    return pool;
  }

  // ---------- 内部 ----------

  private async ensureLive(sessionId: string): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.loading.get(sessionId);
    if (pending) return pending;

    const load = this.loadSession(sessionId);
    this.loading.set(sessionId, load);
    try {
      return await load;
    } finally {
      if (this.loading.get(sessionId) === load) this.loading.delete(sessionId);
    }
  }

  /** 解析本会话该用的小模型 spec：true→按 provider 推导，字符串→原样，否则无。 */
  private smallModelSpec(resolved: ResolvedProvider): string | undefined {
    const cfg = this.opts.smallModel;
    if (!cfg) return undefined;
    if (typeof cfg === "string") return cfg;
    return defaultSmallModel(resolved.modelInfo?.providerId);
  }

  private instantiate(
    meta: SessionMeta,
    resumeMessages: ChatMessage[],
    resolved: ResolvedProvider,
  ): ManagedSession {
    const session = new ManagedSession(meta, (confirm) => {
      const agent = new Agent({
        provider: resolved.provider,
        model: resolved.model,
        ...(resolved.modelInfo ? { modelInfo: resolved.modelInfo } : {}),
        resolveModel: this.opts.resolveProvider,
        ...(this.smallModelSpec(resolved) ? { smallModel: this.smallModelSpec(resolved)! } : {}),
        ...(this.opts.fallbackModels?.length ? { fallbackModels: this.opts.fallbackModels } : {}),
        ...(this.opts.sandbox ? { sandbox: this.opts.sandbox } : {}),
        ...(this.opts.checkpoints ? { checkpoints: true } : {}),
        ...(this.opts.repoMap !== undefined ? { repoMap: this.opts.repoMap } : {}),
        ...(this.opts.webSearch ? { webSearch: this.opts.webSearch } : {}),
        ...(this.opts.lsp?.length ? { lsp: this.lspPoolFor(meta.cwd) } : {}),
        // browser 默认开启：仅显式 false 时禁用（undefined→true）。
        ...(this.opts.browser !== false ? { browser: this.opts.browser ?? true } : {}),
        cwd: meta.cwd,
        permission: {
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
        },
        ...(this.opts.permissionProfiles
          ? { permissionProfiles: this.opts.permissionProfiles }
          : {}),
        ...(this.opts.tools ? { tools: this.opts.tools() } : {}),
        ...(this.opts.hooks ? { hooks: this.opts.hooks } : {}),
        ...(this.opts.subagents !== undefined ? { subagents: this.opts.subagents } : {}),
        ...(this.opts.skills !== undefined ? { skills: this.opts.skills } : {}),
        ...(this.opts.compaction !== undefined ? { compaction: this.opts.compaction } : {}),
        persistence: {
          store: this.opts.store,
          meta,
          ...(resumeMessages.length ? { resumeMessages } : {}),
        },
      });
      if (this.opts.permissionProfile) agent.setPermissionProfile(this.opts.permissionProfile);
      return agent;
    });
    this.sessions.set(meta.id, session);
    // 全局订阅：每个 live 会话的事件都转发给 subscribeAll 的监听者（firehose 用），
    // 与是否有人 open 该会话无关。会话生命周期内常驻，dispose/delete 时随会话释放。
    session.subscribe((ev) => this.fanoutGlobal(meta.id, ev));
    return session;
  }

  /**
   * 订阅**所有**会话的事件流（firehose）。listener 收到 (sessionId, event)。
   * 只覆盖订阅期间处于 live 的会话；冷会话被 resume/create 成 live 后自动纳入。
   */
  subscribeAll(listener: GlobalListener): () => void {
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
}
