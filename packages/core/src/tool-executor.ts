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
import { ToolError, type ToolRegistry } from "./tools/tool.js";
import type { PermissionDecision, PermissionEngine } from "./permission.js";
import type { HookRunner } from "./hooks.js";
import { Chan } from "./chan.js";
import { reminder } from "./conversation.js";
import type { ExecutionRuntime } from "./runtime/isolated-runtime.js";
import type { NetworkProxy } from "./runtime/network-proxy.js";
import { noTelemetry, type SpanContext, type Telemetry } from "./runtime/telemetry.js";
import type { SecurityPolicyEngine } from "./security/policy.js";

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export interface ToolExecutorOptions {
  tools: ToolRegistry;
  perm: PermissionEngine;
  hooks: HookRunner;
  cwd: string;
  /** OS 级命令沙箱策略（bash 工具据此包一层）。 */
  sandbox?: "none" | "read-only" | "workspace-write";
  /** 单个工具结果注入历史的字符上限（超出截中段）。 */
  maxToolResultChars: number;
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
}

export class ToolExecutor {
  constructor(private readonly o: ToolExecutorOptions) {}

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
    const tool = this.o.tools.get(call.name);
    if (!tool || !this.o.parallelInputsStable) return false;
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
    const tool = this.o.tools.get(call.name);
    // 宽容语义：直接调用未激活的 deferred 工具时自动激活（模型可能记得名字径直调用）。
    if (tool && this.o.tools.isDeferred(call.name)) this.o.tools.activate(call.name);
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
    if (this.o.hooks.has("PreToolUse")) {
      const h = await this.o.hooks.run({
        event: "PreToolUse",
        cwd: this.o.cwd,
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
    let decision: PermissionDecision = await this.o.perm.check({
      toolName: call.name,
      input: args,
      cwd: this.o.cwd,
      readOnly: tool.readOnly,
      mutatesFiles: tool.mutatesFiles ?? false,
      network: args["network"] === true,
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
      decision = this.o.perm.validateUpdatedInput({
        toolName: call.name,
        input: updated,
        cwd: this.o.cwd,
        readOnly: tool.readOnly,
        mutatesFiles: tool.mutatesFiles ?? false,
        network: updated["network"] === true,
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
    const input = decision.updatedInput ?? args;
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
    const settled = tool
      .run(input, {
        cwd: this.o.cwd,
        signal,
        ...(this.o.sandbox ? { sandbox: this.o.sandbox } : {}),
        ...(this.o.isolatedRuntime ? { isolatedRuntime: this.o.isolatedRuntime } : {}),
        ...(this.o.networkProxy ? { networkProxy: this.o.networkProxy } : {}),
        ...(toolContext ? { traceContext: toolContext } : {}),
        modelSupportsImages: this.o.supportsImages(),
        attachImage: (img) => localImages.push(img),
        emit: (progress) =>
          chan.push({ type: "tool_progress", id: call.id, name: call.name, event: progress }),
        addUsage: (usage) => this.o.addUsage(usage),
      })
      .then(
        (content) => {
          toolSpan.setStatus({ code: "ok" });
          return { ok: true as const, content };
        },
        (err: unknown) => {
          toolSpan.recordException(err).setStatus({ code: "error" });
          return { ok: false as const, err };
        },
      )
      .finally(() => {
        toolSpan.end();
        chan.close();
      });
    for await (const ev of chan) yield ev;
    const r = await settled;

    const isError = !r.ok;
    let content = truncateToolResult(
      r.ok ? r.content : r.err instanceof ToolError ? r.err.message : errText(r.err),
      this.o.maxToolResultChars,
    );
    if (preContext) content += reminder(preContext);
    // PostToolUse 对成功和失败都执行；反馈（含 block reason）回传给模型。
    if (this.o.hooks.has("PostToolUse")) {
      const h = await this.o.hooks.run({
        event: "PostToolUse",
        cwd: this.o.cwd,
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
    if (!isError && tool.mutatesFiles) {
      const paths = ["path", "file", "file_path"]
        .map((key) => input[key])
        .filter((value): value is string => typeof value === "string" && value.length > 0);
      this.o.onFilesChanged?.(paths);
    }
    // 图片附在本轮 tool_result 之后进入同一条 user 消息（由 run 汇总后排序）。
    // 工具失败时丢弃：错误结果配一堆图片只会白烧上下文。
    if (!isError && localImages.length) images.push(...localImages);
    yield { type: "tool_result", id: call.id, name: call.name, content, isError };
  }
}

// ---------- 模块级辅助 ----------

function errResult(id: string, name: string, msg: string): ToolResultPart {
  return { type: "tool_result", toolCallId: id, toolName: name, content: msg, isError: true };
}

function errText(err: unknown): string {
  return String((err as { message?: unknown })?.message ?? err);
}

/** 超长工具结果截中段（保头 80% + 尾 20%，头尾往往比中段信息密度高） */
export function truncateToolResult(content: string, max: number): string {
  if (content.length <= max) return content;
  const head = Math.floor(max * 0.8);
  const tail = max - head;
  return (
    content.slice(0, head) +
    `\n\n…（工具输出共 ${content.length} 字符，超过 ${max} 上限，中段已截断）…\n\n` +
    content.slice(content.length - tail)
  );
}
