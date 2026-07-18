/**
 * Hooks —— 在 agent loop 的关键节点插入用户自定义逻辑（对齐 Codex/Claude Code
 * 共有的 10 事件集）。
 *
 * 事件与挂载点：
 *   SessionStart      首次 send 装配上下文时（additionalContext 注入 system）
 *   UserPromptSubmit  用户消息进入历史之前（可拦截、可注入额外上下文）
 *   PreToolUse        权限门之前（可 block / 强制 allow / 改写入参）
 *   PermissionRequest 权限门确定要询问用户时（可 allow 自动批准 / block 自动拒绝；
 *                     都不给则照常弹确认）
 *   PostToolUse       工具执行之后（可给模型附加反馈上下文）
 *   PreCompact        上下文压缩触发前（观察性；tokens 为当前输入规模）
 *   PostCompact       压缩完成后（观察性；带 beforeTokens/afterTokens）
 *   SubagentStart     task 工具即将派生子 agent 时（可 block 阻止派生）
 *   SubagentStop      子 agent 结束时（观察性；isError 标记失败）
 *   Stop              loop 即将收尾时（可 block 强制继续，配额有限防死循环）
 *
 * 语义：
 *   - 同一事件的多个 hook 顺序执行；block 一票否决（第一个 block 的 reason 生效）
 *   - updatedInput 链式传递（后一个 hook 看到前一个改写后的入参）
 *   - additionalContext 拼接
 *   - hook 抛异常视为无操作 —— hook 是增强，不能反过来弄垮 loop
 *
 * hooks 是程序化的（函数），shell-command hook 可由调用方自行包一个 handler 实现，
 * core 不内置以避免把执行外部命令的安全面塞进内核。
 */

import { globMatch } from "./permission.js";

export type HookEventName =
  | "SessionStart"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PermissionRequest"
  | "PostToolUse"
  | "PreCompact"
  | "PostCompact"
  | "SubagentStart"
  | "SubagentStop"
  | "Stop";

export interface HookPayload {
  event: HookEventName;
  cwd: string;
  /** UserPromptSubmit：用户输入原文 */
  prompt?: string;
  /** PreToolUse / PermissionRequest / PostToolUse；Subagent* 事件里是子 agent 类型名 */
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** PermissionRequest：待确认动作的人类可读摘要（权限规则匹配用的 key） */
  ruleKey?: string;
  /** PostToolUse / SubagentStop */
  toolResult?: string;
  isError?: boolean;
  /** SubagentStart / SubagentStop：子 agent 类型与任务标题 */
  subagentType?: string;
  taskDescription?: string;
  /** PreCompact：当前输入 token 规模；PostCompact：压缩前后规模 */
  tokens?: number;
  beforeTokens?: number;
  afterTokens?: number;
  /** Stop：本次 drive 中 Stop hook 已强制继续过几轮 */
  stopContinuations?: number;
}

export interface HookResult {
  /** block：拦截该动作；allow：跳过权限门（仅 PreToolUse 有意义） */
  decision?: "block" | "allow";
  /** block 的原因（回传给模型/用户） */
  reason?: string;
  /** PreToolUse：改写工具入参 */
  updatedInput?: Record<string, unknown>;
  /** 注入给模型的额外上下文 */
  additionalContext?: string;
}

export type HookHandler = (payload: HookPayload) => HookResult | void | Promise<HookResult | void>;

export interface HookRegistration {
  event: HookEventName;
  /**
   * 工具名匹配（支持 * glob）；缺省匹配全部。对 PreToolUse/PermissionRequest/
   * PostToolUse 匹配工具名；对 SubagentStart/SubagentStop 匹配子 agent 类型名。
   */
  matcher?: string;
  handler: HookHandler;
}

/** 一个事件跑完全部命中 hook 后的聚合结论 */
export interface HookOutcome {
  blocked: boolean;
  /** PreToolUse：至少一个 hook 显式 allow 且无人 block → 跳过权限门 */
  allowed: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  additionalContext?: string;
}

const PASS: HookOutcome = { blocked: false, allowed: false };

export class HookRunner {
  private regs: HookRegistration[];

  constructor(regs: HookRegistration[] = []) {
    this.regs = regs;
  }

  /** 该事件是否有任何注册（供调用方短路，省一次异步跳转） */
  has(event: HookEventName): boolean {
    return this.regs.some((r) => r.event === event);
  }

  async run(payload: HookPayload): Promise<HookOutcome> {
    const hits = this.regs.filter(
      (r) =>
        r.event === payload.event &&
        (r.matcher === undefined ||
          (payload.toolName !== undefined && globMatch(r.matcher, payload.toolName))),
    );
    if (hits.length === 0) return PASS;

    let allowed = false;
    let updatedInput: Record<string, unknown> | undefined;
    const contexts: string[] = [];

    for (const reg of hits) {
      let res: HookResult | void;
      try {
        res = await reg.handler({
          ...payload,
          ...(updatedInput ? { toolInput: updatedInput } : {}),
        });
      } catch {
        continue; // hook 异常按无操作处理
      }
      if (!res) continue;
      if (res.decision === "block") {
        return {
          blocked: true,
          allowed: false,
          reason: res.reason ?? "被 hook 拦截",
          ...(contexts.length ? { additionalContext: contexts.join("\n") } : {}),
        };
      }
      if (res.decision === "allow") allowed = true;
      if (res.updatedInput) updatedInput = res.updatedInput;
      if (res.additionalContext) contexts.push(res.additionalContext);
    }

    return {
      blocked: false,
      allowed,
      ...(updatedInput ? { updatedInput } : {}),
      ...(contexts.length ? { additionalContext: contexts.join("\n") } : {}),
    };
  }
}
