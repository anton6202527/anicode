/**
 * Conversation —— 会话历史的值对象（架构 v2 的 R7 + R5 历史侧，见 docs/architecture-v2.md §2.1）。
 *
 * 拥有 ChatMessage[] 与其全部结构不变量：悬空工具调用自愈（repairHistory）、
 * 对话回滚（rewind）、压缩/改写后的整体替换（replaceAll）；并携带随历史走的
 * 持久化（增量 append flush / 整文件 rewrite）与用量、成本记账。
 *
 * Agent 是唯一持有者；除本类之外不得直接改写历史数组 —— compaction 等
 * 纯函数（context.ts）拿到 raw() 引用做只读计算，结果经 replaceAll 应用。
 */

import type { ChatMessage, ImagePart, ToolResultPart, Usage } from "./types.js";
import { emptyUsage, toolCallsOf } from "./types.js";
import type { ISessionStore, SessionMeta } from "./session.js";

export interface PersistenceConfig {
  store: ISessionStore;
  /** 会话 meta（含 id）。resume 时传已有会话的 meta。 */
  meta: SessionMeta;
  /** resume：预填历史（跳过再次写 meta，只在此后 append） */
  resumeMessages?: ChatMessage[];
  /** runtime event projection 恢复出的累计用量。 */
  resumeUsage?: Usage;
  /** runtime event projection 恢复出的最近一次真实输入 token。 */
  resumeLastInputTokens?: number;
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

/** 包一段注入上下文（对齐 Claude Code 的 system-reminder 惯例，模型学过这个记号） */
export function reminder(text: string): string {
  return `\n\n<system-reminder>\n${text}\n</system-reminder>`;
}

/** 模型单价（$/MTok）；结构与 registry 的 ModelCost 兼容。 */
export interface ConversationCost {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export class Conversation {
  private history: ChatMessage[] = [];
  private persistedCount = 0; // 已 append 进会话文件的消息数；改写历史后重置
  private cumulativeUsage: Usage = emptyUsage();
  private lastInput = 0; // 上一次 provider 调用的真实输入 token，驱动压缩触发
  private readonly persist: PersistenceConfig | null;
  /** Serialize append/rewrite even when a caller deadline stops awaiting an old store Promise. */
  private persistFence: Promise<void> = Promise.resolve();
  /**
   * Store failures remain observable by shutdown even when the initiating caller stopped waiting.
   * Keep this bounded: the first failures carry the useful causes and the overflow counter proves
   * that persistence is still unhealthy without retaining an unbounded error history.
   */
  private readonly persistFailures: Error[] = [];
  private persistFailureOverflow = 0;

  constructor(persistence?: PersistenceConfig | null, initialMessages: ChatMessage[] = []) {
    this.persist = persistence ?? null;
    if (this.persist?.resumeMessages) {
      const resumed = [...this.persist.resumeMessages];
      // 这些已在文件里，勿重复写；自愈补上的合成结果会在下次 flush 时落盘
      this.persistedCount = resumed.length;
      this.history = repairHistory(resumed);
    } else if (initialMessages.length > 0) {
      this.history = repairHistory([...initialMessages]);
    }
    if (this.persist?.resumeUsage) this.cumulativeUsage = normalizeUsage(this.persist.resumeUsage);
    if (
      Number.isFinite(this.persist?.resumeLastInputTokens) &&
      Number(this.persist?.resumeLastInputTokens) > 0
    ) {
      this.lastInput = Math.floor(Number(this.persist?.resumeLastInputTokens));
    }
  }

  // ---------- 读 ----------

  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  get length(): number {
    return this.history.length;
  }

  /**
   * 内部数组引用，供 compaction / provider 请求等只读消费方使用。
   * 调用方不得改写 —— 一切写入必须经过本类方法。
   */
  raw(): ChatMessage[] {
    return this.history;
  }

  // ---------- 写（唯一入口） ----------

  /** 追加一条用户消息；additionalContext（hook 注入）包成 internal system-reminder 块。 */
  pushUser(text: string, additionalContext?: string): void {
    this.history.push({
      role: "user",
      content: [
        { type: "text", text },
        ...(additionalContext
          ? [{ type: "text" as const, text: reminder(additionalContext).trim(), internal: true }]
          : []),
      ],
    });
  }

  /** 追加一条 internal user 消息（任务通知 / Stop hook 续跑等，UI 不冒充用户原话）。 */
  pushInternal(text: string): void {
    this.history.push({ role: "user", content: [{ type: "text", text, internal: true }] });
  }

  pushAssistant(message: ChatMessage): void {
    this.history.push(message);
  }

  /** 工具轮结果：tool_result 必须在前（Anthropic 硬性要求），工具附带的图片紧随其后。 */
  pushToolRound(results: ToolResultPart[], images: ImagePart[]): void {
    this.history.push({ role: "user", content: [...results, ...images] });
  }

  /** 历史被改写（压缩等）后整体替换并重写持久化。 */
  async replaceAll(messages: ChatMessage[], signal?: AbortSignal): Promise<void> {
    this.history = messages;
    await this.rewritePersist(signal);
  }

  /**
   * 对话回滚：截断到前 messageCount 条并重写持久化。返回删除的消息数；
   * 历史已比目标短（如被压缩）时按无操作处理。运行护栏由持有者（Agent）负责。
   */
  async rewind(messageCount: number): Promise<number> {
    const target = Math.max(0, messageCount);
    const removed = this.history.length - target;
    if (removed <= 0) return 0;
    this.history = this.history.slice(0, target);
    await this.rewritePersist();
    return removed;
  }

  // ---------- 持久化 ----------

  /** 把尚未落盘的新消息按序 append 进会话文件。 */
  async flush(signal?: AbortSignal): Promise<void> {
    if (!this.persist) return;
    // Appends never mutate existing slots, so retaining the current array plus a high-water mark is
    // a stable snapshot without copying the entire conversation on every incremental flush. A
    // rewrite/rewind swaps the array reference and remains ordered behind this operation.
    const snapshot = this.history;
    const end = snapshot.length;
    await this.enqueuePersist(async () => {
      for (let i = this.persistedCount; i < end; i++) {
        await this.persist!.store.append(this.persist!.meta.id, snapshot[i]!);
        this.persistedCount = i + 1;
      }
    }, signal);
  }

  /** 历史被改写（压缩/回滚）后整文件重写。 */
  async rewritePersist(signal?: AbortSignal): Promise<void> {
    if (!this.persist) return;
    const snapshot = [...this.history];
    await this.enqueuePersist(async () => {
      await this.persist!.store.rewrite(this.persist!.meta, snapshot);
      this.persistedCount = snapshot.length;
    }, signal);
  }

  /** Public host fence: rewrite the current meta/history through the same ordered queue as append. */
  async rewritePersistence(signal?: AbortSignal): Promise<void> {
    await this.rewritePersist(signal);
  }

  /**
   * Atomically advance persistence metadata (for example a generated title) without racing an
   * in-flight Agent append. The new metadata becomes active only after the rewrite really lands.
   */
  async updatePersistenceMeta(meta: SessionMeta, signal?: AbortSignal): Promise<void> {
    if (!this.persist) return;
    const nextMeta = { ...meta };
    const snapshot = [...this.history];
    await this.enqueuePersist(async () => {
      await this.persist!.store.rewrite(nextMeta, snapshot);
      this.persist!.meta = nextMeta;
      this.persistedCount = snapshot.length;
    }, signal);
  }

  private async enqueuePersist(
    operation: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const scheduled = this.persistFence.then(operation);
    // Cancellation only stops this caller waiting. Once a durable write is queued it continues in
    // order; otherwise a wall-clock abort between enqueue and execution can silently lose history.
    this.persistFence = scheduled.catch((error: unknown) => {
      this.rememberPersistFailure(error);
    });
    if (!signal) return scheduled;
    return raceWithSignal(scheduled, signal);
  }

  /** Dynamic fence used by shutdown/delete: wait for every already-started or newly-chained write. */
  async whenPersisted(signal?: AbortSignal): Promise<void> {
    while (true) {
      const current = this.persistFence;
      if (signal) await raceWithSignal(current, signal);
      else await current;
      if (current !== this.persistFence) continue;
      if (this.persistFailures.length > 0 || this.persistFailureOverflow > 0) {
        const failures = [...this.persistFailures];
        if (this.persistFailureOverflow > 0) {
          failures.push(
            new Error(`${this.persistFailureOverflow} additional persistence failure(s) omitted`),
          );
        }
        throw new AggregateError(failures, "Conversation persistence failed");
      }
      return;
    }
  }

  private rememberPersistFailure(error: unknown): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.persistFailures.length < 32) this.persistFailures.push(normalized);
    else this.persistFailureOverflow++;
  }

  // ---------- 记账 ----------

  accumulate(u: Usage): void {
    const next = {
      inputTokens: this.cumulativeUsage.inputTokens + u.inputTokens,
      outputTokens: this.cumulativeUsage.outputTokens + u.outputTokens,
      cacheReadTokens: this.cumulativeUsage.cacheReadTokens + u.cacheReadTokens,
      cacheWriteTokens: this.cumulativeUsage.cacheWriteTokens + u.cacheWriteTokens,
    };
    if (
      ![
        u.inputTokens,
        u.outputTokens,
        u.cacheReadTokens,
        u.cacheWriteTokens,
        next.inputTokens,
        next.outputTokens,
        next.cacheReadTokens,
        next.cacheWriteTokens,
      ].every((value) => Number.isSafeInteger(value) && value >= 0)
    ) {
      throw new Error("usage 必须可累加为四个非负安全整数字段");
    }
    this.cumulativeUsage = next;
  }

  get cumulative(): Usage {
    return this.cumulativeUsage;
  }

  /**
   * 记录一轮的真实上下文规模 = 非缓存输入 + 缓存读 + 缓存写（三者都属本轮 prompt token）。
   * 含 system+tools，是压缩触发最准的依据；比 char/4 估算靠谱。
   */
  noteRealInput(u: Usage): void {
    const real = u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    if (real > 0) this.lastInput = real;
  }

  get lastInputTokens(): number {
    return this.lastInput;
  }

  /**
   * 会话累计成本估算（美元）。基于主模型单价的近似值：per-prompt 覆盖 / 小模型 /
   * 降级链期间的用量也按主模型价折算。无价格信息时返回 undefined。
   */
  estimatedCostUSD(cost?: ConversationCost): number | undefined {
    if (!cost) return undefined;
    const per = 1 / 1_000_000;
    const cacheRead = cost.cacheRead ?? cost.input * 0.1;
    const cacheWrite = cost.cacheWrite ?? cost.input * 1.25;
    return (
      this.cumulativeUsage.inputTokens * cost.input * per +
      this.cumulativeUsage.outputTokens * cost.output * per +
      this.cumulativeUsage.cacheReadTokens * cacheRead * per +
      this.cumulativeUsage.cacheWriteTokens * cacheWrite * per
    );
  }
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Observe an already-started persistence operation so a later store rejection is never unhandled.
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function normalizeUsage(usage: Usage): Usage {
  const value = (candidate: number): number =>
    Number.isSafeInteger(Math.floor(candidate)) && candidate > 0 ? Math.floor(candidate) : 0;
  return {
    inputTokens: value(usage.inputTokens),
    outputTokens: value(usage.outputTokens),
    cacheReadTokens: value(usage.cacheReadTokens),
    cacheWriteTokens: value(usage.cacheWriteTokens),
  };
}
