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
import type { ChatMessage, Usage } from "./types.js";
import { Agent, type AgentEvent, type AgentOptions, type AgentResolvedModel } from "./agent.js";
import type { ToolRegistry } from "./tools/tool.js";
import type { HookRegistration } from "./hooks.js";
import type { SubagentDefinition } from "./subagent.js";
import type { CompactionConfig } from "./context.js";
import { SessionStore, newSessionId, type SessionMeta } from "./session.js";
import { defaultSmallModel } from "./provider/registry.js";
import type {
  PermissionConfig,
  PermissionDecision,
  PermissionRequest,
  PermissionMode,
} from "./permission.js";

// ---------- 对外事件与快照 ----------

/** 会话级事件：包裹 AgentEvent，另加权限询问与运行态变化 */
export type SessionEvent =
  | { type: "agent"; event: AgentEvent }
  | { type: "permission_request"; permId: string; toolName: string; ruleKey: string }
  | { type: "permission_resolved"; permId: string; decision: PermissionAnswer }
  | { type: "reverted"; checkpointId: string; restored: number; deleted: number }
  | { type: "state"; running: boolean };

/** 一个可撤销点：某轮用户输入前的工作区快照。 */
export interface Checkpoint {
  id: string;
  tree: string;
  label: string;
}

export type PermissionAnswer = "allow" | "allow_remember" | "deny";

export interface SessionSnapshot {
  meta: SessionMeta;
  messages: ChatMessage[];
  usage: Usage;
  running: boolean;
  /** 订阅时仍待裁决的权限请求（重连场景不至于卡死） */
  pendingPermissions: { permId: string; toolName: string; ruleKey: string }[];
}

export interface SessionSummary extends SessionMeta {
  running: boolean;
}

export type SessionListener = (ev: SessionEvent) => void;

export interface SessionManagerOptions {
  /** 按 model 字符串产出 provider 实例（通常包 createProvider） */
  resolveProvider: (model: string) => AgentResolvedModel;
  store: SessionStore;
  /** 传入即为所有会话启用工具集（默认 Agent 内置默认工具） */
  tools?: () => ToolRegistry;
  /** 每会话默认开启压缩 */
  compaction?: Partial<CompactionConfig> | boolean;
  /** 会话权限策略；confirm 始终由 SessionManager 接管并广播给前端。 */
  permission?: Omit<PermissionConfig, "confirm">;
  /** 所有会话共用的 hooks（PreToolUse/PostToolUse/UserPromptSubmit/Stop） */
  hooks?: HookRegistration[];
  /** 启用 task 工具（子 agent 委派）：true=内置 general；数组=追加自定义类型 */
  subagents?: boolean | SubagentDefinition[];
  /** 启用 skills 发现与渐进加载。 */
  skills?: AgentOptions["skills"];
  /**
   * 摘要等杂活用的小模型。`true`=按会话 provider 自动推导便宜模型；字符串=显式 spec；
   * 省略/false=用主模型。解析失败会静默回退主模型（见 Agent）。
   */
  smallModel?: boolean | string;
  /** OS 级 bash 沙箱策略（macOS 第一阶段）；也可由 AGENTX_BASH_SANDBOX 覆盖。 */
  sandbox?: AgentOptions["sandbox"];
  /** 每轮用户输入前记工作区 git 快照，支持 undo 回滚文件改动。默认关。 */
  checkpoints?: boolean;
  /** 会话开始时注入 repo map（代码骨架）帮助模型定位。默认关。 */
  repoMap?: AgentOptions["repoMap"];
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
    return {
      meta: { ...this.meta },
      messages: s.messages,
      usage: s.usage,
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
        : { behavior: "allow", remember: decision === "allow_remember" },
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
  send(text: string): Promise<void> {
    this.touch();
    return new Promise((resolve, reject) => {
      if (this.agent.queue(text)) {
        // steering 属于当前 drive；直到该 drive 真正收尾才向调用方报告完成。
        this.currentWaiters.push({ resolve, reject, steering: true });
        return;
      }
      // Agent 已决定 done/error 但 generator 尚在收尾时，作为下一次 drive 排队，
      // 不能塞回一个再也不会 drain 的 Agent 队列。
      this.pendingSends.push({ text, resolve, reject, steering: false });
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
          for await (const ev of this.agent.send(next.text, this.abort.signal)) {
            if (ev.type === "checkpoint") {
              this.checkpoints.push({ id: ev.id, tree: ev.tree, label: ev.label });
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

  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /**
   * 撤销：把工作区文件回滚到某个快照（缺省=最近一个）。回滚后丢弃该快照及其之后的快照，
   * 使连续 undo 逐步回退。运行中拒绝（避免与工具写入竞争）。仅回滚文件，不改对话历史。
   */
  async undo(checkpointId?: string): Promise<{ restored: number; deleted: number }> {
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
    const res = await store.restore({ tree: target.tree });
    this.checkpoints.splice(idx); // 丢弃目标及其之后的快照
    this.emit({
      type: "reverted",
      checkpointId: target.id,
      restored: res.restored,
      deleted: res.deleted,
    });
    return res;
  }

  /** 同一毫秒内的连续活动也保持严格递增，便于稳定排序与 snapshot 比较。 */
  private touch(): void {
    const previous = Date.parse(this.meta.updatedAt);
    const next = Number.isFinite(previous) ? Math.max(Date.now(), previous + 1) : Date.now();
    this.meta.updatedAt = new Date(next).toISOString();
  }
}

// ---------- 管理器 ----------

export class SessionManager {
  private sessions = new Map<string, ManagedSession>();
  /** 冷会话并发 open/send 时共享同一次磁盘加载，避免订阅到被覆盖的孤儿实例。 */
  private loading = new Map<string, Promise<ManagedSession>>();
  private opts: SessionManagerOptions;

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

  async send(sessionId: string, text: string): Promise<void> {
    const session = await this.ensureLive(sessionId);
    await session.send(text);
  }

  async interrupt(sessionId: string): Promise<void> {
    this.sessions.get(sessionId)?.interrupt();
  }

  /** 列出会话的可撤销点（最近的在末尾）。未加载/未启用快照时返回空数组。 */
  listCheckpoints(sessionId: string): Checkpoint[] {
    return this.sessions.get(sessionId)?.listCheckpoints() ?? [];
  }

  /** 撤销会话的文件改动到某快照（缺省=最近一个）。仅回滚文件，不改对话历史。 */
  async undo(
    sessionId: string,
    checkpointId?: string,
  ): Promise<{ restored: number; deleted: number }> {
    const session = await this.ensureLive(sessionId);
    return session.undo(checkpointId);
  }

  /** 运行时切换会话的权限模式（如 /plan 进入/退出计划模式）。 */
  async setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    const session = await this.ensureLive(sessionId);
    session.setPermissionMode(mode);
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
    const session = new ManagedSession(
      meta,
      (confirm) =>
        new Agent({
          provider: resolved.provider,
          model: resolved.model,
          ...(resolved.modelInfo ? { modelInfo: resolved.modelInfo } : {}),
          resolveModel: this.opts.resolveProvider,
          ...(this.smallModelSpec(resolved) ? { smallModel: this.smallModelSpec(resolved)! } : {}),
          ...(this.opts.sandbox ? { sandbox: this.opts.sandbox } : {}),
          ...(this.opts.checkpoints ? { checkpoints: true } : {}),
          ...(this.opts.repoMap !== undefined ? { repoMap: this.opts.repoMap } : {}),
          cwd: meta.cwd,
          permission: { mode: "default", ...this.opts.permission, confirm },
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
        }),
    );
    this.sessions.set(meta.id, session);
    return session;
  }
}
