/**
 * TurnRunner —— 一次模型轮的执行与韧性（架构 v2 的 R2，见 docs/architecture-v2.md §2.3；
 * 对应 codex-rs 的 session/turn.rs + client 层）。
 *
 * 封装四件事：
 * 1. provider 流式补全：把流式增量转成 AgentEvent，聚合出最终消息（streamOnce）；
 * 2. 瞬时错误重试：指数退避 + 抖动，尊重服务端 Retry-After（取较大值、封顶 60s）；
 * 3. 模型降级链：主模型重试仍失败时按序切换 fallback，切换后享有完整重试预算；
 * 4. active 模型状态：per-prompt 覆盖 / 降级都只改 active，restore() 还原 base ——
 *    覆盖是「本次 drive」的语义，还原时机由编排层（Agent.send 的 finally）掌握。
 *
 * 另提供 streamText：摘要等杂活的纯文本流（小模型优先，失败回退主模型）。
 */

import type { ChatMessage, Effort, Provider, ToolDefinition, Usage } from "./types.js";
import { emptyUsage } from "./types.js";
import type { AgentEvent, AgentModelInfo, AgentResolvedModel, RetryConfig } from "./agent.js";
import { noTelemetry, type SpanContext, type Telemetry } from "./runtime/telemetry.js";

export type TurnOutcome =
  | { type: "ok"; message: ChatMessage; stopReason: string; usage: Usage }
  | { type: "error"; message: string; cause?: unknown; partial: boolean };

/** 当前生效的模型（per-prompt 覆盖 / 降级会改；base 永不变）。 */
interface ActiveModel {
  provider: Provider;
  model: string;
  supportsTools: boolean;
  /** 模型是否支持视觉；未知能力按 false（宁可降级为文本，也不要整轮请求被拒）。 */
  supportsImages: boolean;
}

export interface TurnRunnerOptions {
  provider: Provider;
  model: string;
  modelInfo?: AgentModelInfo;
  /** 子 agent 跨 provider 覆盖 / fallback / per-prompt 覆盖的解析入口。 */
  resolveModel?: (spec: string) => AgentResolvedModel;
  /** 模型降级链（每次 drive 经 resetFallbacks 重置）。 */
  fallbackModels?: string[];
  retry: Required<RetryConfig> | null;
  maxTokens?: number;
  effort?: Effort;
  /** 摘要等杂活用的小模型；未配置或解析失败时等于主 provider/model。 */
  small: { provider: Provider; model: string };
  telemetry?: Telemetry;
  /** 当前 drive 的上游 trace；用 getter 读取以支持 per-send parent。 */
  parent?: () => SpanContext | undefined;
}

export class TurnRunner {
  private readonly base: ActiveModel;
  private active: ActiveModel;
  private readonly fallbackModels: string[];
  private fallbackQueue: string[] = [];
  private readonly retry: Required<RetryConfig> | null;
  private readonly resolveModelFn: ((spec: string) => AgentResolvedModel) | undefined;
  private readonly maxTokens: number | undefined;
  private readonly effort: Effort | undefined;
  private readonly small: { provider: Provider; model: string };
  private readonly telemetry: Telemetry;
  private readonly parent: (() => SpanContext | undefined) | undefined;

  constructor(opts: TurnRunnerOptions) {
    this.base = {
      provider: opts.provider,
      model: opts.model,
      supportsTools: opts.modelInfo?.capabilities.tools ?? true,
      supportsImages: opts.modelInfo?.capabilities.images ?? false,
    };
    this.active = { ...this.base };
    this.fallbackModels = opts.fallbackModels ?? [];
    this.retry = opts.retry;
    this.resolveModelFn = opts.resolveModel;
    this.maxTokens = opts.maxTokens;
    this.effort = opts.effort;
    this.small = opts.small;
    this.telemetry = opts.telemetry ?? noTelemetry;
    this.parent = opts.parent;
  }

  // ---------- active 模型状态 ----------

  get provider(): Provider {
    return this.active.provider;
  }
  get model(): string {
    return this.active.model;
  }
  get supportsTools(): boolean {
    return this.active.supportsTools;
  }
  get supportsImages(): boolean {
    return this.active.supportsImages;
  }
  get canResolve(): boolean {
    return this.resolveModelFn !== undefined;
  }

  /** per-prompt 模型覆盖：本次 drive 全程用覆盖模型。解析失败抛错（调用方转 error 事件）。 */
  override(spec: string): void {
    if (!this.resolveModelFn) throw new Error("resolveModel not configured");
    const resolved = this.resolveModelFn(spec);
    this.active = {
      provider: resolved.provider,
      model: resolved.model,
      supportsTools: resolved.modelInfo?.capabilities.tools ?? true,
      supportsImages: resolved.modelInfo?.capabilities.images ?? false,
    };
  }

  /** send 收尾：还原主模型（per-prompt 覆盖与降级都是 drive 局部的）。 */
  restore(): void {
    this.active = { ...this.base };
  }

  /** 每次 drive 重置降级链：上一轮的降级不该让本轮少一个候选。 */
  resetFallbacks(): void {
    this.fallbackQueue = [...this.fallbackModels];
  }

  // ---------- 模型轮（含瞬时错误重试 + 降级链） ----------

  async *runTurn(req: {
    system: string;
    messages: ChatMessage[];
    toolDefs: ToolDefinition[];
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent, TurnOutcome> {
    for (let attempt = 0; ; attempt++) {
      const res = yield* this.streamOnce(req);
      if (res.type === "ok") return res;
      const retriable =
        this.retry !== null &&
        attempt < this.retry.maxRetries &&
        !req.signal.aborted &&
        isTransientError(res.cause);
      if (!retriable) {
        // 即使不再重试，消费者也必须清掉未进入 Agent history 的流式残影。
        if (res.partial) yield { type: "turn_reset" };
        // 降级链：主模型确定失败（非用户中断）时切到下一个可解析的 fallback 模型，
        // 从头重试本轮。切换是 drive 局部的——send 的 finally 会还原主模型。
        const switched = req.signal.aborted ? null : this.nextFallback();
        if (switched) {
          yield {
            type: "model_fallback",
            from: switched.from,
            to: switched.to,
            reason: res.message,
          };
          attempt = -1; // for 递增后归 0：新模型享有完整的重试预算
          continue;
        }
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
        await sleep(delayMs, req.signal);
      } catch {
        return res; // 等待期间被中断
      }
    }
  }

  /** 消耗降级链：切到下一个能解析的 fallback 模型；链空/无 resolver 返回 null。 */
  private nextFallback(): { from: string; to: string } | null {
    if (!this.resolveModelFn) return null;
    while (this.fallbackQueue.length > 0) {
      const spec = this.fallbackQueue.shift()!;
      try {
        const resolved = this.resolveModelFn(spec);
        const from = this.active.model;
        this.active = {
          provider: resolved.provider,
          model: resolved.model,
          supportsTools: resolved.modelInfo?.capabilities.tools ?? true,
          supportsImages: resolved.modelInfo?.capabilities.images ?? false,
        };
        return { from, to: resolved.model };
      } catch {
        /* 该 fallback 解析失败（拼写/缺凭证），试下一个 */
      }
    }
    return null;
  }

  /** 跑一次模型补全，把流式增量转成 AgentEvent，聚合出最终消息 */
  private async *streamOnce(req: {
    system: string;
    messages: ChatMessage[];
    toolDefs: ToolDefinition[];
    signal: AbortSignal;
  }): AsyncGenerator<AgentEvent, TurnOutcome> {
    const span = this.telemetry.startSpan(
      "anicode.model.stream",
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.request.model": this.active.model,
        "gen_ai.provider.name": this.active.provider.name,
      },
      this.parent?.(),
    );
    let finalMessage: ChatMessage | null = null;
    let stopReason = "";
    let usage: Usage = emptyUsage();
    let partial = false;
    const toolNames = new Map<string, string>(); // 流式期间 id → 工具名

    try {
      for await (const ev of this.active.provider.stream({
        model: this.active.model,
        system: req.system,
        messages: req.messages,
        ...(this.active.supportsTools ? { tools: req.toolDefs } : {}),
        ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
        signal: req.signal,
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
          span
            .setAttribute("gen_ai.response.finish_reasons", [ev.stopReason])
            .setAttribute("gen_ai.usage.input_tokens", ev.usage.inputTokens)
            .setAttribute("gen_ai.usage.output_tokens", ev.usage.outputTokens)
            .setStatus({ code: "ok" });
        }
      }
    } catch (err) {
      span.recordException(err).setStatus({ code: "error", message: errText(err) });
      return { type: "error", message: errText(err), cause: err, partial };
    } finally {
      span.end();
    }
    if (!finalMessage) {
      return { type: "error", message: "provider 未产出 done 事件", partial };
    }
    return { type: "ok", message: finalMessage, stopReason, usage };
  }

  // ---------- 杂活文本流 ----------

  /** 摘要等杂活用：优先小模型跑一次纯文本流，小模型出错则回退当前 active 模型。 */
  async *streamText(
    messages: ChatMessage[],
    system: string,
  ): AsyncIterable<{ type: string; text?: string }> {
    const maxTokens = Math.min(2000, this.maxTokens ?? 2000);
    const usingSmall =
      this.small.provider !== this.active.provider || this.small.model !== this.active.model;
    try {
      for await (const ev of this.small.provider.stream({
        model: this.small.model,
        system,
        messages,
        maxTokens,
      })) {
        if (ev.type === "text_delta") yield { type: "text", text: ev.text };
      }
    } catch (err) {
      if (!usingSmall) throw err;
      // 小模型失败（如额度/网络）→ 用主模型重来一次，保证压缩不因杂活模型而失败。
      for await (const ev of this.active.provider.stream({
        model: this.active.model,
        system,
        messages,
        maxTokens,
      })) {
        if (ev.type === "text_delta") yield { type: "text", text: ev.text };
      }
    }
  }
}

// ---------- 模块级辅助 ----------

function errText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err);
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
