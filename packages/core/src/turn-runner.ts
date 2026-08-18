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

import type { ChatMessage, Effort, Provider, StreamEvent, ToolDefinition, Usage } from "./types.js";
import { emptyUsage } from "./types.js";
import type { AgentEvent, AgentModelInfo, AgentResolvedModel, RetryConfig } from "./agent.js";
import { noTelemetry, type SpanContext, type Telemetry } from "./runtime/telemetry.js";

export type TurnOutcome =
  | { type: "ok"; message: ChatMessage; stopReason: string; usage: Usage }
  | { type: "error"; message: string; cause?: unknown; partial: boolean; usage?: Usage };

export interface ModelCallReservation {
  /** Undefined preserves provider-native defaults while the ledger reserves conservatively. */
  maxTokens?: number;
  commit(usage: Usage): Promise<void>;
  /** Conservatively charge the full reservation when a dispatched request has no trusted usage. */
  consume(): Promise<void>;
  cancel(): Promise<void>;
}

export type ReserveModelCall = (request: {
  estimatedInputTokens: number;
  requestedMaxTokens?: number;
  cost?: AgentModelInfo["cost"];
  model: string;
}) => ModelCallReservation | Promise<ModelCallReservation>;

/** 当前生效的模型（per-prompt 覆盖 / 降级会改；base 永不变）。 */
interface ActiveModel {
  provider: Provider;
  model: string;
  cost?: AgentModelInfo["cost"];
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
  small: { provider: Provider; model: string; cost?: AgentModelInfo["cost"] };
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
  private readonly small: { provider: Provider; model: string; cost?: AgentModelInfo["cost"] };
  private readonly telemetry: Telemetry;
  private readonly parent: (() => SpanContext | undefined) | undefined;

  constructor(opts: TurnRunnerOptions) {
    this.base = {
      provider: opts.provider,
      model: opts.model,
      ...(opts.modelInfo?.cost ? { cost: opts.modelInfo.cost } : {}),
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

  get smallModelCost(): AgentModelInfo["cost"] | undefined {
    return this.small.cost;
  }
  get activeModelCost(): AgentModelInfo["cost"] | undefined {
    return this.active.cost;
  }

  /** per-prompt 模型覆盖：本次 drive 全程用覆盖模型。解析失败抛错（调用方转 error 事件）。 */
  override(spec: string): void {
    if (!this.resolveModelFn) throw new Error("resolveModel not configured");
    const resolved = this.resolveModelFn(spec);
    this.active = {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.modelInfo?.cost ? { cost: resolved.modelInfo.cost } : {}),
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
    estimatedInputTokens?: number;
    reserveModelCall?: ReserveModelCall;
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
          ...(resolved.modelInfo?.cost ? { cost: resolved.modelInfo.cost } : {}),
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
    estimatedInputTokens?: number;
    reserveModelCall?: ReserveModelCall;
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
    let receivedTerminal = false;
    let reservation: ModelCallReservation | undefined;
    let reservationCommitted = false;
    let requestDispatched = false;
    const toolNames = new Map<string, string>(); // 流式期间 id → 工具名

    try {
      reservation = await req.reserveModelCall?.({
        estimatedInputTokens:
          req.estimatedInputTokens ??
          estimateRequestTokens(
            req.messages,
            req.system,
            this.active.supportsTools ? req.toolDefs : [],
          ),
        ...(this.maxTokens !== undefined ? { requestedMaxTokens: this.maxTokens } : {}),
        ...(this.active.cost ? { cost: this.active.cost } : {}),
        model: this.active.model,
      });
    } catch (error) {
      span
        .recordException(error)
        .setStatus({ code: "error", message: errText(error) })
        .end();
      return { type: "error", message: errText(error), cause: error, partial: false };
    }
    if (req.signal.aborted) {
      await reservation?.cancel();
      const error = abortReason(req.signal);
      span.recordException(error).setStatus({ code: "error", message: error.message }).end();
      return { type: "error", message: error.message, cause: error, partial: false };
    }

    let iterator: AsyncIterator<StreamEvent> | undefined;

    try {
      requestDispatched = true;
      iterator = this.active.provider
        .stream({
          model: this.active.model,
          system: req.system,
          messages: req.messages,
          ...(this.active.supportsTools ? { tools: req.toolDefs } : {}),
          ...(reservation?.maxTokens !== undefined
            ? { maxTokens: reservation.maxTokens }
            : this.maxTokens !== undefined
              ? { maxTokens: this.maxTokens }
              : {}),
          ...(this.effort ? { effort: this.effort } : {}),
          signal: req.signal,
        })
        [Symbol.asyncIterator]();
      while (true) {
        const next = await nextWithSignal(iterator.next(), req.signal);
        if (next.done) break;
        const ev = next.value;
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
          if (!validUsage(ev.usage)) {
            throw new Error("provider 返回了无效 usage（必须为非负安全整数）");
          }
          finalMessage = ev.message;
          stopReason = ev.stopReason;
          usage = ev.usage;
          receivedTerminal = true;
          await reservation?.commit(ev.usage);
          reservationCommitted = true;
          span
            .setAttribute("gen_ai.response.finish_reasons", [ev.stopReason])
            .setAttribute("gen_ai.usage.input_tokens", ev.usage.inputTokens)
            .setAttribute("gen_ai.usage.output_tokens", ev.usage.outputTokens)
            .setStatus({ code: "ok" });
          // `done` is the provider contract's terminal event. Do not wait for a buggy iterator
          // to return afterwards: that would let an otherwise complete turn hang past deadline.
          break;
        }
      }
    } catch (err) {
      span.recordException(err).setStatus({ code: "error", message: errText(err) });
      return {
        type: "error",
        message: errText(err),
        cause: err,
        partial,
        ...(receivedTerminal ? { usage } : {}),
      };
    } finally {
      if (!reservationCommitted) {
        if (requestDispatched) await reservation?.consume();
        else await reservation?.cancel();
      }
      if (iterator) {
        if (receivedTerminal) drainIteratorAfterTerminal(iterator);
        else closeIterator(iterator);
      }
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
    signal?: AbortSignal,
    onUsage?: (usage: Usage, cost: AgentModelInfo["cost"] | undefined) => void,
    reserveModelCall?: ReserveModelCall,
  ): AsyncIterable<{ type: string; text?: string }> {
    const maxTokens = Math.min(2000, this.maxTokens ?? 2000);
    const usingSmall =
      this.small.provider !== this.active.provider || this.small.model !== this.active.model;
    try {
      yield* streamPlainText(
        this.small.provider,
        this.small.model,
        messages,
        system,
        maxTokens,
        signal,
        (usage) => onUsage?.(usage, this.small.cost),
        reserveModelCall,
        this.small.cost,
      );
    } catch (err) {
      if (!usingSmall || signal?.aborted) throw err;
      // 小模型失败（如额度/网络）→ 用主模型重来一次，保证压缩不因杂活模型而失败。
      yield* streamPlainText(
        this.active.provider,
        this.active.model,
        messages,
        system,
        maxTokens,
        signal,
        (usage) => onUsage?.(usage, this.active.cost),
        reserveModelCall,
        this.active.cost,
      );
    }
  }
}

// ---------- 模块级辅助 ----------

function errText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err);
}

/**
 * Promise.race at the async-iterator boundary is the hard deadline. Providers are asked to honour
 * AbortSignal, but production safety cannot depend on that: an adapter may ignore it forever.
 */
function nextWithSignal<T>(
  next: Promise<IteratorResult<T>>,
  signal?: AbortSignal,
): Promise<IteratorResult<T>> {
  if (!signal) return next;
  if (signal.aborted) {
    void next.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<IteratorResult<T>>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void next.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

function closeIterator(iterator: AsyncIterator<unknown>): void {
  if (!iterator.return) return;
  // Never await return(): a non-cooperative async generator can block it behind its pending next().
  void Promise.resolve(iterator.return()).catch(() => undefined);
}

function drainIteratorAfterTerminal(iterator: AsyncIterator<unknown>): void {
  // Resume once without awaiting so provider cleanup immediately after `yield done` can run, while
  // a buggy provider that hangs after its terminal event cannot hold the Agent open.
  void iterator.next().then(
    (next) => {
      if (!next.done) closeIterator(iterator);
    },
    () => undefined,
  );
}

async function* streamPlainText(
  provider: Provider,
  model: string,
  messages: ChatMessage[],
  system: string,
  maxTokens: number,
  signal: AbortSignal | undefined,
  onUsage: (usage: Usage) => void,
  reserveModelCall: ReserveModelCall | undefined,
  cost: AgentModelInfo["cost"] | undefined,
): AsyncIterable<{ type: string; text?: string }> {
  const reservation = await reserveModelCall?.({
    estimatedInputTokens: estimateRequestTokens(messages, system, []),
    requestedMaxTokens: maxTokens,
    ...(cost ? { cost } : {}),
    model,
  });
  if (signal?.aborted) {
    await reservation?.cancel();
    throw abortReason(signal);
  }
  let requestDispatched = false;
  let iterator: AsyncIterator<StreamEvent> | undefined;
  let receivedTerminal = false;
  let reservationCommitted = false;
  try {
    requestDispatched = true;
    iterator = provider
      .stream({
        model,
        system,
        messages,
        maxTokens: reservation?.maxTokens ?? maxTokens,
        ...(signal ? { signal } : {}),
      })
      [Symbol.asyncIterator]();
    while (true) {
      const next = await nextWithSignal(iterator.next(), signal);
      if (next.done) break;
      const ev = next.value;
      if (ev.type === "text_delta") yield { type: "text", text: ev.text };
      if (ev.type === "done") {
        if (signal?.aborted) throw abortReason(signal);
        if (!validUsage(ev.usage)) {
          throw new Error("provider 返回了无效 usage（必须为非负安全整数）");
        }
        onUsage(ev.usage);
        receivedTerminal = true;
        await reservation?.commit(ev.usage);
        reservationCommitted = true;
        break;
      }
    }
  } finally {
    if (!reservationCommitted) {
      if (requestDispatched) await reservation?.consume();
      else await reservation?.cancel();
    }
    if (iterator) {
      if (receivedTerminal) drainIteratorAfterTerminal(iterator);
      else closeIterator(iterator);
    }
  }
}

function estimateRequestTokens(
  messages: ChatMessage[],
  system: string,
  tools: ToolDefinition[],
): number {
  let bytes = utf8Bytes(system) + utf8Bytes(JSON.stringify(tools));
  for (const message of messages) bytes += utf8Bytes(JSON.stringify(message));
  // UTF-8 bytes are intentionally conservative across CJK/code/tool schemas; char/4 can undercount
  // them by several times and is unsuitable for a hard pre-dispatch reservation.
  return Math.max(1, bytes);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validUsage(usage: Usage): boolean {
  return [
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheReadTokens,
    usage.cacheWriteTokens,
  ].every((value) => Number.isSafeInteger(value) && value >= 0);
}

const HARD_QUOTA_CODES = new Set([
  "gateway_disabled",
  "upstream_balance_exhausted",
  "device_daily_token_limit",
  "device_daily_request_limit",
  "user_daily_token_limit",
  "user_daily_request_limit",
  "global_daily_token_limit",
  "global_daily_request_limit",
  "user_quota_exceeded",
  "global_quota_exceeded",
  "quota_exceeded",
  // OpenAI-compatible providers commonly use this code when purchased credit is exhausted.
  "insufficient_quota",
]);

function providerErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string" && direct.trim()) return direct.trim().toLowerCase();
  const nested = (err as { error?: unknown }).error;
  if (!nested || typeof nested !== "object") return undefined;
  const nestedCode = (nested as { code?: unknown }).code;
  return typeof nestedCode === "string" && nestedCode.trim()
    ? nestedCode.trim().toLowerCase()
    : undefined;
}

function providerErrorHeader(err: unknown, name: string): string | null {
  const headers = (err as { headers?: unknown })?.headers;
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  if (typeof headers !== "object") return null;
  const expected = name.toLowerCase();
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== expected) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return null;
}

function isHardQuotaError(err: unknown): boolean {
  if (providerErrorHeader(err, "x-anicode-retryable")?.trim().toLowerCase() === "false") {
    return true;
  }
  const code = providerErrorCode(err);
  return code !== undefined && HARD_QUOTA_CODES.has(code);
}

/** 判定 provider 错误是否值得重试（限流/服务端/网络层；4xx 业务错误不重试） */
function isTransientError(err: unknown): boolean {
  if (err == null) return false;
  if (isHardQuotaError(err)) return false;
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
  const raw = providerErrorHeader(err, "retry-after");
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
