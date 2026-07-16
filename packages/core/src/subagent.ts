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
}

/** 内置通用类型：全工具、通用提示 —— 对齐 Claude Code 的 general-purpose */
export const GENERAL_SUBAGENT: SubagentDefinition = {
  name: "general",
  description: "通用子 agent：多步搜索、跨文件调研、独立子任务。",
};

const SUBAGENT_SYSTEM = `你是一个子 agent，负责完成主 agent 委派的一项独立任务。
- 自主完成，不要向用户提问（你的输出只有主 agent 能看到）。
- 最终一条消息就是你交回的结果：直接给出结论/发现/产物位置，不要寒暄。`;

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
  for (const d of opts.definitions ?? []) defs.set(d.name, d);

  const typeList = [...defs.values()].map((d) => `- ${d.name}: ${d.description}`).join("\n");

  return {
    readOnly: false,
    def: {
      name: "task",
      description:
        "把一项独立子任务委派给子 agent 执行，只返回其最终结论文本 —— 中间过程不占用你的上下文。" +
        "适合大范围搜索、多文件调研和独立工作；当前共享 cwd，多个 task 按序执行。可用类型：\n" + typeList,
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "任务的简短标题（3~8 字）" },
          prompt: {
            type: "string",
            description: "给子 agent 的完整任务指令（它看不到你的对话历史，需自包含）",
          },
          subagent_type: {
            type: "string",
            description: `子 agent 类型（默认 general）。可选: ${[...defs.keys()].join(", ")}`,
          },
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["subagent_type"] ?? "general")}: ${String(i["description"] ?? "")}`,
    isConcurrencySafe: () => false,
    async run(input, ctx: ToolContext): Promise<string> {
      const type = String(input["subagent_type"] ?? "general");
      const prompt = String(input["prompt"] ?? "");
      if (!prompt) throw new ToolError("prompt 不能为空");
      const def = defs.get(type);
      if (!def) throw new ToolError(`未知 subagent 类型: ${type}（可选: ${[...defs.keys()].join(", ")}）`);

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

      // 工具收窄：排除 task 防递归；有显式子集则取交集
      const allowedNames = (def.tools ?? opts.tools.names()).filter((n) => n !== "task");
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
        system: def.system ?? SUBAGENT_SYSTEM,
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
