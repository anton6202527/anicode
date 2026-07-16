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
 *   - task 本身按副作用工具处理并串行执行：子 agent 可写文件/跑命令，也会产生
 *     模型费用；在没有 worktree 隔离前绝不能把多个 task 当成只读调用并发
 */

import type { Tool, ToolContext, ToolRegistry } from "./tools/tool.js";
import { ToolError } from "./tools/tool.js";
import { t } from "./i18n.js";
import type { PermissionConfig } from "./permission.js";
import type { HookRegistration } from "./hooks.js";
import type { Provider } from "./types.js";
import type {
  Agent,
  AgentOptions,
  AgentEvent,
  AgentModelInfo,
  AgentResolvedModel,
} from "./agent.js";

export interface SubagentDefinition {
  /** 类型名，模型经 subagent_type 参数选择它 */
  name: string;
  /** 给模型看的用途说明（何时该派这个子 agent） */
  description: string;
  /** 子 agent 的 system 提示；缺省用通用子 agent 提示 */
  system?: string;
  /** 允许的工具名子集；缺省继承父的全部工具（除 task） */
  tools?: string[];
  /** 覆盖模型；裸 id 沿用父 provider，provider/model 可跨 provider（需 resolver）。 */
  model?: string;
  maxTurns?: number;
  /**
   * 只读调研型：子 agent 工具面被收窄到只读工具（不能写文件/跑命令），因此**无副作用**，
   * 多个此类 task 调用可被父 agent 并行 fan-out（对齐 opencode 的 explore/并行子代理）。
   */
  readOnly?: boolean;
}

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
  /** 自定义 subagent 类型；general 始终可用 */
  definitions?: SubagentDefinition[];
  defaultMaxTurns?: number;
  /** 继承父级 OS 沙箱策略，避免子 agent 的 bash 成为绕过沙箱的通道。 */
  sandbox?: AgentOptions["sandbox"];
}

export function createTaskTool(opts: TaskToolOptions): Tool {
  const defs = new Map<string, SubagentDefinition>();
  defs.set(GENERAL_SUBAGENT.name, GENERAL_SUBAGENT);
  defs.set(EXPLORE_SUBAGENT.name, EXPLORE_SUBAGENT);
  for (const d of opts.definitions ?? []) defs.set(d.name, d);

  const typeList = [...defs.values()].map((d) => `- ${d.name}: ${d.description}`).join("\n");

  return {
    readOnly: false,
    def: {
      name: "task",
      description:
        t(
          "Delegate one independent subtask to a subagent and get back only its final conclusion text — the intermediate steps don't consume your context. " +
            "Good for broad search, multi-file investigation, and independent work; they share the current cwd and multiple tasks run sequentially. Available types:\n",
          "把一项独立子任务委派给子 agent 执行，只返回其最终结论文本 —— 中间过程不占用你的上下文。" +
            "适合大范围搜索、多文件调研和独立工作；当前共享 cwd，多个 task 按序执行。可用类型：\n",
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
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["subagent_type"] ?? "general")}: ${String(i["description"] ?? "")}`,
    // 只读调研型子 agent 无写副作用 → 允许多个 task 调用并行 fan-out；其余保持串行。
    isConcurrencySafe: (i) => Boolean(defs.get(String(i["subagent_type"] ?? "general"))?.readOnly),
    async run(input, ctx: ToolContext): Promise<string> {
      const type = String(input["subagent_type"] ?? "general");
      const prompt = String(input["prompt"] ?? "");
      if (!prompt) throw new ToolError("prompt 不能为空");
      const def = defs.get(type);
      if (!def)
        throw new ToolError(`未知 subagent 类型: ${type}（可选: ${[...defs.keys()].join(", ")}）`);

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
      //   - 始终排除 task —— 子 agent 不能再派子 agent（防递归 / 上下文与费用失控）；
      //   - 从「继承全部」的默认集里排除 todo_write —— 子 agent 的清单是隔离的、不展示给用户，
      //     只会污染进度流；显式 def.tools 指定了则尊重；
      //   - readOnly 型：进一步收窄到只读工具，保证「无写副作用」这一并行前提成立。
      const DERIVED_DENY = new Set(["task", "todo_write"]);
      let base = def.tools ?? opts.tools.names().filter((n) => !DERIVED_DENY.has(n));
      if (def.readOnly) {
        const readOnlySet = new Set(opts.tools.readOnlyNames());
        base = base.filter((n) => readOnlySet.has(n));
      }
      const allowedNames = base.filter((n) => n !== "task");
      const child = opts.makeAgent({
        provider: resolved?.provider ?? opts.provider,
        model: resolved?.model ?? def.model ?? opts.model,
        ...(!def.model && opts.modelInfo
          ? { modelInfo: opts.modelInfo }
          : resolved?.modelInfo
            ? { modelInfo: resolved.modelInfo }
            : {}),
        ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
        cwd: opts.cwd,
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
        system: def.system ?? subagentSystem(),
        // 子 agent 不重复采集环境（每次都 spawn git，量大时拖慢）；父会话已接地。
        injectEnv: false,
        tools: opts.tools.subset(allowedNames),
        ...(opts.permission ? { permission: opts.permission } : {}),
        ...(opts.hooks?.length ? { hooks: opts.hooks } : {}),
        maxTurns: def.maxTurns ?? opts.defaultMaxTurns ?? 30,
      });

      let errorMsg: string | null = null;
      try {
        for await (const ev of child.send(prompt, ctx.signal)) {
          ctx.emit?.(ev satisfies AgentEvent);
          if (ev.type === "error") errorMsg = ev.message;
        }
      } finally {
        ctx.addUsage?.(child.totalUsage);
      }
      if (errorMsg) throw new ToolError(`子 agent 失败: ${errorMsg}`);

      const answer = finalAssistantText(child);
      return answer || "（子 agent 未产出文本结论）";
    },
  };
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
