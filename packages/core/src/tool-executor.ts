/**
 * ToolExecutor —— 一轮工具调用的调度与执行（架构 v2 的 R3，见 docs/architecture-v2.md §2.4）。
 *
 * 连续的只读调用组成一批并行执行（互不阻塞），副作用调用按序串行（保证写操作
 * 的可预测顺序）；每个调用走 PreToolUse hook → 权限门 → 执行（进度经 Chan
 * 实时回流）→ PostToolUse hook；产出 AgentEvent 流并回填 {results, images}。
 *
 * 不变量（对齐 codex-rs tools/{router,orchestrator,parallel} 的职责面）：
 * - results 始终按 calls 原顺序排列 —— 与模型发起顺序一致；
 * - confirm 改写入参后必须重新过 deny/ask 不可绕过层（不能借 updatedInput
 *   把安全请求换成被禁请求）；
 * - PostToolUse 对成功和失败都执行；失败工具附带的图片被丢弃；
 * - 直接调用未激活的 deferred 工具时自动激活（宽容语义）。
 */

import type { ImagePart, ToolResultPart, Usage } from "./types.js";
import type { AgentEvent } from "./agent.js";
import {
  ToolError,
  isIsolatedModuleTool,
  isManagedExternalTool,
  normalizeIsolatedToolInput,
  type Tool,
  type ToolContext,
  type ToolRegistry,
} from "./tools/tool.js";
import type { PermissionDecision, PermissionEngine } from "./permission.js";
import type { HookRunner } from "./hooks.js";
import { Chan } from "./chan.js";
import { reminder } from "./conversation.js";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";
import type { NetworkProxy } from "./runtime/network-proxy.js";
import { noTelemetry, type SpanContext, type Telemetry } from "./runtime/telemetry.js";
import type { SecurityPolicyEngine } from "./security/policy.js";
import { hasUnparsedToolArguments } from "./tool-arguments.js";
import { IsolatedToolRunner } from "./tools/isolated-tool-runner.js";

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

const DEFAULT_MAX_PROGRESS_EVENTS = 1_000;
const DEFAULT_MAX_PROGRESS_BYTES = 1 * 1024 * 1024;
const DEFAULT_MAX_ATTACHED_IMAGES = 4;
// One built-in screenshot may contain up to 5 MiB of decoded data (~6.7 MiB base64).
const DEFAULT_MAX_ATTACHED_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_ISOLATED_INPUT_BYTES = 512 * 1024;
const DEFAULT_MAX_ISOLATED_OUTPUT_BYTES = 32 * 1024;
const HARD_MAX_CONCURRENT_TOOLS = 32;

export interface ToolExecutionFenceRequest {
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  ruleKey: string;
  signal: AbortSignal;
}

export interface ToolExecutorOptions {
  tools: ToolRegistry;
  perm: PermissionEngine;
  hooks: HookRunner;
  cwd: string;
  /** OS 级命令沙箱策略（bash 工具据此包一层）。 */
  sandbox?: "none" | "read-only" | "workspace-write";
  /** 单个工具结果注入历史的字符上限（超出截中段）。 */
  maxToolResultChars: number;
  /** 同一批并行安全工具的最大并发，默认 8。 */
  maxConcurrentTools?: number;
  /** 单个工具统一执行超时（毫秒），默认 10 分钟。 */
  toolTimeoutMs?: number;
  /** Declarative isolated-module JSON input ceiling, at most 512 KiB. */
  maxIsolatedInputBytes?: number;
  /** Declarative isolated-module UTF-8 result ceiling, at most 32 KiB. */
  maxIsolatedOutputBytes?: number;
  /** 单次工具执行最多接受的 progress payload 数量，默认 1000。 */
  maxProgressEvents?: number;
  /** 单次工具执行最多接受的 progress payload JSON 字节数，默认 1 MiB。 */
  maxProgressBytes?: number;
  /** 单次工具执行最多附带的图片数量，默认 4。 */
  maxAttachedImages?: number;
  /** 单次工具执行最多保留的 base64 图片数据字节数，默认 8 MiB。 */
  maxAttachedImageBytes?: number;
  /**
   * 并发分组发生在执行前。只要 PreToolUse 或只读 ask-confirm 可能改写入参，
   * 就必须保守串行，避免按旧参数判成安全、最终却执行写操作。
   */
  parallelInputsStable: boolean;
  /** 当前 active 模型是否支持视觉（per-prompt 覆盖/降级会变，故用 getter 注入）。 */
  supportsImages: () => boolean;
  /** 工具内部产生的模型用量汇入会话记账。 */
  addUsage: (usage: Usage) => void;
  isolatedRuntime?: ExecutionRuntime;
  networkProxy?: NetworkProxy;
  securityPolicy?: SecurityPolicyEngine;
  telemetry?: Telemetry;
  traceParent?: () => SpanContext | undefined;
  /** 成功写入后通知 Verifier 收集变更路径。 */
  onFilesChanged?: (paths: string[]) => void;
  /** Durable command lease/fencing gate, awaited immediately before any side-effecting tool body. */
  beforeToolExecution?: (request: ToolExecutionFenceRequest) => void | Promise<void>;
  /** Tree-global concurrency slot; held until the actual tool Promise settles. */
  acquireToolExecutionSlot?: (signal: AbortSignal) => Promise<() => void>;
}

export class ToolExecutor {
  private readonly rawExecutions = new Set<Promise<unknown>>();
  private readonly isolatedRunner: IsolatedToolRunner;
  private readonly maxConcurrentTools: number;
  private readonly isolatedInputBytes: number;
  private readonly isolatedOutputBytes: number;
  private closed = false;
  private closeTask?: Promise<void>;
  private readonly outputQuotas: {
    progressEvents: number;
    progressBytes: number;
    attachedImages: number;
    attachedImageBytes: number;
  };

  constructor(private readonly o: ToolExecutorOptions) {
    this.maxConcurrentTools = boundedPositiveQuota(
      "maxConcurrentTools",
      o.maxConcurrentTools,
      8,
      HARD_MAX_CONCURRENT_TOOLS,
    );
    this.isolatedInputBytes = boundedPositiveQuota(
      "maxIsolatedInputBytes",
      o.maxIsolatedInputBytes,
      DEFAULT_MAX_ISOLATED_INPUT_BYTES,
      DEFAULT_MAX_ISOLATED_INPUT_BYTES,
    );
    this.isolatedOutputBytes = boundedPositiveQuota(
      "maxIsolatedOutputBytes",
      o.maxIsolatedOutputBytes,
      DEFAULT_MAX_ISOLATED_OUTPUT_BYTES,
      DEFAULT_MAX_ISOLATED_OUTPUT_BYTES,
    );
    this.isolatedRunner = new IsolatedToolRunner(o.isolatedRuntime, {
      maxConcurrent: this.maxConcurrentTools,
    });
    this.outputQuotas = {
      progressEvents: quota("maxProgressEvents", o.maxProgressEvents, DEFAULT_MAX_PROGRESS_EVENTS),
      progressBytes: quota("maxProgressBytes", o.maxProgressBytes, DEFAULT_MAX_PROGRESS_BYTES),
      attachedImages: quota("maxAttachedImages", o.maxAttachedImages, DEFAULT_MAX_ATTACHED_IMAGES),
      attachedImageBytes: quota(
        "maxAttachedImageBytes",
        o.maxAttachedImageBytes,
        DEFAULT_MAX_ATTACHED_IMAGE_BYTES,
      ),
    };
  }

  /** Keep durable command ownership until aborted/timed-out tool code has actually settled. */
  async awaitIdle(): Promise<void> {
    while (this.rawExecutions.size > 0) {
      await Promise.allSettled([...this.rawExecutions]);
    }
  }

  /** Abort killable extension processes and await their close proof. Stable and idempotent. */
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closed = true;
    this.closeTask = (async () => {
      const results = await Promise.allSettled([this.isolatedRunner.close(), this.awaitIdle()]);
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Tool executor cleanup failed");
      }
    })();
    return this.closeTask;
  }

  /**
   * 执行一轮工具调用：连续的只读调用组成一批并行执行，副作用调用按序串行。
   * results 始终按 calls 原顺序排列 —— 与模型发起顺序一致。
   */
  async *run(
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
      const concurrency = this.maxConcurrentTools;
      for (let offset = 0; offset < batch.length; offset += concurrency) {
        const chunk = batch.slice(offset, offset + concurrency);
        if (chunk.length === 1) yield* this.runToolSafe(chunk[0]!, signal, results, images);
        else yield* this.runToolBatch(chunk, signal, results, images);
      }
    }
    return { results, images };
  }

  /**
   * 并发资格按调用判定。前提：入参不会在准备阶段被改写（无 PreToolUse / 无 ask-confirm）。
   * 满足后：有 isConcurrencySafe 的以它为准（如 task 只对只读子 agent 类型返回 true，
   * 从而让多个只读调研子 agent 并行 fan-out）；否则回落到静态 readOnly 契约。
   */
  private isParallelSafe(call: ToolCall): boolean {
    // Provider 参数解析失败时会保留一个仅供内部诊断的 __unparsed 哨兵。
    // 不要让这类调用进入并发判定，因为自定义 isConcurrencySafe 也可能读取或执行入参。
    if (hasUnparsedToolArguments(call.args)) return false;
    const tool = this.o.tools.get(call.name);
    if (!tool || !this.o.parallelInputsStable) return false;
    if (tool.execution?.kind === "isolated-module") {
      if (!isIsolatedModuleTool(tool)) return false;
      try {
        normalizeIsolatedToolInput(call.args, this.isolatedInputBytes);
      } catch {
        return false;
      }
      return tool.readOnly;
    }
    if (tool.execution?.kind === "managed-external" && !isManagedExternalTool(tool)) return false;
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
    if (this.closed) {
      const msg = "工具执行器已关闭，工具未执行";
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
    // Provider 返回的 tool arguments 不是合法 JSON。原文可能含敏感信息或提示注入，
    // 因此既不回显，也不让它进入 hook、ruleKey、权限判断或工具实现。
    if (hasUnparsedToolArguments(call.args)) {
      const msg =
        "工具参数无效（INVALID_TOOL_ARGUMENTS）：参数不是合法 JSON，请严格按照该工具的参数 schema 重新发起调用。";
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }
    const tool = this.o.tools.get(call.name);
    // 宽容语义：直接调用未激活的 deferred 工具时自动激活（模型可能记得名字径直调用）。
    if (tool && this.o.tools.isDeferred(call.name)) this.o.tools.activate(call.name);
    if (!tool) {
      const msg = `未知工具: ${call.name}`;
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }
    if (tool.execution?.kind === "isolated-module" && !isIsolatedModuleTool(tool)) {
      throw new ToolError("Untrusted isolated tool registration was rejected");
    }
    if (tool.execution?.kind === "managed-external" && !isManagedExternalTool(tool)) {
      throw new ToolError("Untrusted managed tool registration was rejected");
    }
    const isolated = tool.execution?.kind === "isolated-module";

    // PreToolUse hook：可拦截 / 改写入参 / 显式放行（跳过权限门）
    // Declarative extension input is normalized before it can reach even a core-owned rule-key or
    // permission callback. This rejects accessors, cycles, special prototypes and oversized JSON.
    let args = isolated
      ? normalizeIsolatedToolInput(call.args, this.isolatedInputBytes)
      : call.args;
    let hookAllowed = false;
    let blockedReason: string | null = null;
    let preContext: string | undefined;
    if (this.o.hooks.has("PreToolUse")) {
      const h = await raceWithSignal(
        this.o.hooks.run({
          event: "PreToolUse",
          cwd: this.o.cwd,
          toolName: call.name,
          toolInput: args,
          signal,
        }),
        signal,
      );
      throwIfAborted(signal);
      if (h.mutatedWorkspace) this.o.onFilesChanged?.([this.o.cwd]);
      if (h.blocked) blockedReason = h.reason ?? "被 PreToolUse hook 拦截";
      if (h.updatedInput) {
        args = isolated
          ? normalizeIsolatedToolInput(h.updatedInput, this.isolatedInputBytes)
          : h.updatedInput;
      }
      hookAllowed = h.allowed;
      preContext = h.additionalContext;
    }

    const ruleKey = tool.ruleKey(args);
    yield { type: "tool_start", id: call.id, name: call.name, ruleKey };

    const securityDecision = this.o.securityPolicy?.authorize({
      principal: "agent",
      action: `tool:${call.name}`,
      resource: ruleKey,
      attributes: {
        readOnly: tool.readOnly,
        mutatesFiles: tool.mutatesFiles ?? false,
      },
    });
    if (securityDecision?.effect === "deny") {
      const msg = `安全策略拒绝: ${securityDecision.reason}`;
      yield { type: "tool_permission", id: call.id, name: call.name, decision: "deny" };
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    if (blockedReason) {
      const msg = `PreToolUse hook 拦截: ${blockedReason}`;
      yield { type: "tool_permission", id: call.id, name: call.name, decision: "deny" };
      results.push(errResult(call.id, call.name, msg));
      yield { type: "tool_result", id: call.id, name: call.name, content: msg, isError: true };
      return;
    }

    // hook 的 allow 也进权限门 —— 它跳过 mode/confirm，但压不过 deny/ask 规则
    let decision: PermissionDecision = await raceWithSignal(
      this.o.perm.check({
        toolName: call.name,
        input: args,
        cwd: this.o.cwd,
        readOnly: tool.readOnly,
        mutatesFiles: tool.mutatesFiles ?? false,
        network: tool.capabilities?.includes("network") || args["network"] === true,
        ruleKey,
        ...(tool.ruleParts ? { ruleParts: tool.ruleParts(args) } : {}),
        ...(tool.rulePartsComplete ? { rulePartsComplete: tool.rulePartsComplete(args) } : {}),
        ...(hookAllowed ? { hookAllowed } : {}),
        toolCallId: call.id,
        signal,
      }),
      signal,
    );
    throwIfAborted(signal);

    // confirm 可以收窄/改写参数，但确认针对的是原动作。最终动作必须重新经过
    // deny/ask 不可绕过层，不能借 updatedInput 把安全请求换成被禁请求。
    if (decision.behavior === "allow" && decision.updatedInput) {
      const updated = isolated
        ? normalizeIsolatedToolInput(decision.updatedInput, this.isolatedInputBytes)
        : decision.updatedInput;
      const updatedRuleKey = tool.ruleKey(updated);
      decision = this.o.perm.validateUpdatedInput({
        toolName: call.name,
        input: updated,
        cwd: this.o.cwd,
        readOnly: tool.readOnly,
        mutatesFiles: tool.mutatesFiles ?? false,
        network: tool.capabilities?.includes("network") || updated["network"] === true,
        ruleKey: updatedRuleKey,
        ...(tool.ruleParts ? { ruleParts: tool.ruleParts(updated) } : {}),
        ...(tool.rulePartsComplete ? { rulePartsComplete: tool.rulePartsComplete(updated) } : {}),
        toolCallId: call.id,
        signal,
      });
      if (decision.behavior === "allow") {
        const updatedSecurityDecision = this.o.securityPolicy?.authorize({
          principal: "agent",
          action: `tool:${call.name}`,
          resource: updatedRuleKey,
          attributes: {
            readOnly: tool.readOnly,
            mutatesFiles: tool.mutatesFiles ?? false,
          },
        });
        decision =
          updatedSecurityDecision?.effect === "deny"
            ? {
                behavior: "deny",
                message: `安全策略拒绝: ${updatedSecurityDecision.reason}`,
              }
            : { ...decision, updatedInput: updated };
      }
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
    const input = isolated
      ? normalizeIsolatedToolInput(decision.updatedInput ?? args, this.isolatedInputBytes)
      : (decision.updatedInput ?? args);
    const chan = new Chan<AgentEvent>();
    // 工具经 attachImage 附带的图片先收在本地；只有工具成功时才并入历史。
    const localImages: ImagePart[] = [];
    const toolSpan = (this.o.telemetry ?? noTelemetry).startSpan(
      "anicode.tool.execute",
      {
        "gen_ai.operation.name": "execute_tool",
        "gen_ai.tool.name": call.name,
        "anicode.tool.read_only": tool.readOnly,
        "anicode.tool.mutates_files": tool.mutatesFiles ?? false,
      },
      this.o.traceParent?.(),
    );
    const toolContext = toolSpan.context();
    const execution = new AbortController();
    let active = true;
    let timedOut = false;
    let progressEvents = 0;
    let progressBytes = 0;
    let attachedImageBytes = 0;
    const quotaWarnings = new Set<"progress" | "images">();
    const warnQuotaOnce = (kind: "progress" | "images"): void => {
      if (!active || quotaWarnings.has(kind)) return;
      quotaWarnings.add(kind);
      const progress = kind === "progress";
      chan.push({
        type: "tool_progress",
        id: call.id,
        name: call.name,
        event: {
          type: "warning",
          code: progress ? "TOOL_PROGRESS_QUOTA_EXCEEDED" : "TOOL_IMAGE_QUOTA_EXCEEDED",
          message: progress
            ? `工具进度输出超过配额（最多 ${this.outputQuotas.progressEvents} 条 / ${this.outputQuotas.progressBytes} 字节），后续进度已丢弃`
            : `工具附图超过配额（最多 ${this.outputQuotas.attachedImages} 张 / ${this.outputQuotas.attachedImageBytes} 字节 base64 数据），后续附图已丢弃`,
        },
      });
    };
    const timeoutMs = Math.max(1_000, this.o.toolTimeoutMs ?? 10 * 60_000);
    const timeout = setTimeout(() => {
      timedOut = true;
      execution.abort(new ToolError(`工具 ${call.name} 执行超时（${timeoutMs}ms）`));
    }, timeoutMs);
    // Keep the hard timeout referenced: an uncooperative tool may otherwise leave no active
    // handles, allowing Node 22 (and a short-lived CLI) to exit before the timeout is enforced.
    const onParentAbort = () =>
      execution.abort(signal.reason ?? new ToolError(`工具 ${call.name} 已中断`));
    if (signal.aborted) onParentAbort();
    else signal.addEventListener("abort", onParentAbort, { once: true });

    type ToolOutcome = { ok: true; content: string } | { ok: false; err: unknown };
    const raw: Promise<ToolOutcome> = Promise.resolve()
      .then(async () => {
        const releaseTreeSlot = this.o.acquireToolExecutionSlot
          ? await this.o.acquireToolExecutionSlot(execution.signal)
          : () => undefined;
        try {
          if (this.requiresExecutionFence(tool) && this.o.beforeToolExecution) {
            throwIfAborted(execution.signal);
            await raceWithSignal(
              Promise.resolve().then(() =>
                this.o.beforeToolExecution!({
                  toolCallId: call.id,
                  toolName: call.name,
                  input,
                  ruleKey: tool.ruleKey(input),
                  signal: execution.signal,
                }),
              ),
              execution.signal,
            );
            throwIfAborted(execution.signal);
          }
          if (tool.mutatesFiles || tool.capabilities?.includes("filesystem-write")) {
            this.o.onFilesChanged?.(changedPaths(input, this.o.cwd));
          }
          const context: ToolContext = {
            cwd: this.o.cwd,
            signal: execution.signal,
            ...(this.o.sandbox ? { sandbox: this.o.sandbox } : {}),
            ...(this.o.isolatedRuntime ? { isolatedRuntime: this.o.isolatedRuntime } : {}),
            ...(this.o.networkProxy ? { networkProxy: this.o.networkProxy } : {}),
            ...(toolContext ? { traceContext: toolContext } : {}),
            modelSupportsImages: this.o.supportsImages(),
            attachImage: (img) => {
              if (!active || quotaWarnings.has("images")) return;
              if (
                img?.type !== "image" ||
                typeof img.mediaType !== "string" ||
                typeof img.data !== "string" ||
                localImages.length >= this.outputQuotas.attachedImages
              ) {
                warnQuotaOnce("images");
                return;
              }
              const remaining = this.outputQuotas.attachedImageBytes - attachedImageBytes;
              const bytes = utf8BytesUpTo(img.data, remaining);
              if (bytes > remaining) {
                warnQuotaOnce("images");
                return;
              }
              attachedImageBytes += bytes;
              localImages.push(img);
            },
            emit: (progress) => {
              if (!active || quotaWarnings.has("progress")) return;
              if (progressEvents >= this.outputQuotas.progressEvents) {
                warnQuotaOnce("progress");
                return;
              }
              const remaining = this.outputQuotas.progressBytes - progressBytes;
              const bytes = progressPayloadBytes(progress, remaining);
              if (bytes > remaining) {
                warnQuotaOnce("progress");
                return;
              }
              progressEvents++;
              progressBytes += bytes;
              chan.push({ type: "tool_progress", id: call.id, name: call.name, event: progress });
            },
            addUsage: (usage) => {
              if (active) this.o.addUsage(usage);
            },
          };
          if (tool.execution?.kind === "isolated-module") {
            return await this.isolatedRunner.run(tool, input, context, {
              timeoutMs,
              maxInputBytes: this.isolatedInputBytes,
              maxOutputBytes: this.isolatedOutputBytes,
              maxProgressEvents: this.outputQuotas.progressEvents,
              maxProgressBytes: this.outputQuotas.progressBytes,
            });
          }
          return await tool.run(input, context);
        } finally {
          releaseTreeSlot();
        }
      })
      .then(
        (content) => ({ ok: true as const, content }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    this.rawExecutions.add(raw);
    void raw.then(
      () => this.rawExecutions.delete(raw),
      () => this.rawExecutions.delete(raw),
    );
    let onExecutionAbort: (() => void) | undefined;
    const aborted = new Promise<ToolOutcome>((resolve) => {
      onExecutionAbort = () =>
        resolve({
          ok: false,
          err:
            execution.signal.reason ??
            new ToolError(
              timedOut
                ? `工具 ${call.name} 执行超时（${timeoutMs}ms）`
                : `工具 ${call.name} 已中断`,
            ),
        });
      if (execution.signal.aborted) onExecutionAbort();
      else execution.signal.addEventListener("abort", onExecutionAbort, { once: true });
    });
    const closeConfirmed =
      tool.execution?.kind === "isolated-module" ||
      (tool.execution?.kind === "managed-external" &&
        tool.execution.cancellation === "close-confirmed");
    // Kill-confirmed adapters must not produce a model-visible terminal result until their child
    // process/transport has proved closed. Legacy trusted closures retain the compatibility race;
    // their raw Promise remains fenced by awaitIdle().
    const visible = closeConfirmed ? raw : Promise.race([raw, aborted]);
    const settled = visible.finally(() => {
      active = false;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onParentAbort);
      if (onExecutionAbort) execution.signal.removeEventListener("abort", onExecutionAbort);
      chan.close();
    });
    for await (const ev of chan) yield ev;
    const r = await settled;

    const isolatedTerminationProofFailed =
      !r.ok &&
      tool.execution?.kind === "isolated-module" &&
      r.err instanceof ToolError &&
      /termination proof failed/i.test(r.err.message);
    if (
      !r.ok &&
      execution.signal.aborted &&
      tool.execution?.kind === "managed-external" &&
      tool.execution.cancellation === "outcome-indeterminate"
    ) {
      r.err = new ToolError(
        timedOut
          ? `工具 ${call.name} 执行超时（${timeoutMs}ms）；远端操作结果未知`
          : `工具 ${call.name} 已中断；远端操作结果未知`,
      );
    } else if (!r.ok && timedOut && !isolatedTerminationProofFailed) {
      r.err = new ToolError(`工具 ${call.name} 执行超时（${timeoutMs}ms）`);
    }

    if (r.ok) toolSpan.setStatus({ code: "ok" });
    else toolSpan.recordException(r.err).setStatus({ code: "error" });
    toolSpan.end();

    const isError = !r.ok;
    let content = truncateToolResult(
      r.ok ? r.content : r.err instanceof ToolError ? r.err.message : errText(r.err),
      this.o.maxToolResultChars,
    );
    if (preContext) content = appendBoundedReminder(content, preContext, this.o.maxToolResultChars);
    // PostToolUse 对成功和失败都执行；反馈（含 block reason）回传给模型。
    if (this.o.hooks.has("PostToolUse")) {
      const h = await raceWithSignal(
        this.o.hooks.run({
          event: "PostToolUse",
          cwd: this.o.cwd,
          toolName: call.name,
          toolInput: input,
          toolResult: content,
          isError,
          signal,
        }),
        signal,
      );
      if (h.mutatedWorkspace) this.o.onFilesChanged?.([this.o.cwd]);
      const feedback = h.blocked ? h.reason : h.additionalContext;
      if (feedback) content = appendBoundedReminder(content, feedback, this.o.maxToolResultChars);
    }
    // Hook context is an untrusted output boundary too. Keep the persisted/model-visible payload
    // within the same hard limit even after Pre/PostToolUse additions.
    content = truncateToolResult(content, this.o.maxToolResultChars);
    const result: ToolResultPart = {
      type: "tool_result",
      toolCallId: call.id,
      toolName: call.name,
      content,
      ...(isError ? { isError: true } : {}),
    };
    results.push(result);
    // 图片附在本轮 tool_result 之后进入同一条 user 消息（由 run 汇总后排序）。
    // 工具失败时丢弃：错误结果配一堆图片只会白烧上下文。
    if (!isError && localImages.length) images.push(...localImages);
    yield { type: "tool_result", id: call.id, name: call.name, content, isError };
  }

  private requiresExecutionFence(tool: Tool): boolean {
    if (!tool.readOnly) return true;
    return Boolean(
      tool.capabilities?.some((capability) =>
        ["filesystem-write", "network", "process", "persistent-process"].includes(capability),
      ),
    );
  }
}

// ---------- 模块级辅助 ----------

function errResult(id: string, name: string, msg: string): ToolResultPart {
  return { type: "tool_result", toolCallId: id, toolName: name, content: msg, isError: true };
}

function errText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err);
}

function quota(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} 必须是非负安全整数`);
  }
  return value;
}

function boundedPositiveQuota(
  name: string,
  value: number | undefined,
  fallback: number,
  hardMaximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} 必须是正安全整数`);
  }
  return Math.min(resolved, hardMaximum);
}

/** UTF-8 byte length with an early exit, avoiding a second large buffer allocation. */
function utf8BytesUpTo(value: string, limit: number): number {
  if (limit < 0) return 0;
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return limit + 1;
  }
  return bytes;
}

/**
 * Measure the serialized progress payload without letting one giant string be copied in full.
 * The replacer provides an early lower-bound guard; the final scan supplies the exact UTF-8 size.
 * Unserializable payloads are rejected at this boundary because downstream transports could not
 * safely encode them either.
 */
function progressPayloadBytes(progress: unknown, limit: number): number {
  if (limit < 0) return 0;
  const tooLarge = Symbol("progress-too-large");
  let inspected = 0;
  try {
    const json = JSON.stringify(progress, (key, value: unknown) => {
      inspected += 4;
      inspected += utf8BytesUpTo(key, Math.max(0, limit - inspected));
      if (typeof value === "string") {
        inspected += utf8BytesUpTo(value, Math.max(0, limit - inspected));
      }
      if (inspected > limit) throw tooLarge;
      return value;
    });
    if (json === undefined) return 0;
    return utf8BytesUpTo(json, limit);
  } catch {
    return limit + 1;
  }
}

function appendBoundedReminder(content: string, context: string, max: number): string {
  // Bound the hook-controlled string before interpolation so concatenation itself stays O(max).
  const boundedContext = truncateToolResult(context, max);
  return truncateToolResult(content + reminder(boundedContext), max);
}

function changedPaths(input: Record<string, unknown>, cwd: string): string[] {
  const paths = ["path", "file", "file_path"]
    .map((key) => input[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return paths.length > 0 ? paths : [cwd];
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

/** 超长工具结果截中段（保头 80% + 尾 20%，头尾往往比中段信息密度高） */
export function truncateToolResult(content: string, max: number): string {
  if (content.length <= max) return content;
  const marker = `\n\n…（工具输出共 ${content.length} 字符，超过 ${max} 上限，中段已截断）…\n\n`;
  if (marker.length >= max) return marker.slice(0, Math.max(0, max));
  const payload = max - marker.length;
  const head = Math.floor(payload * 0.8);
  const tail = payload - head;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
}
