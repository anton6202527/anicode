/**
 * TodoWrite —— 任务清单工具（对齐 Claude Code 的 TodoWrite）。
 *
 * 语义：每次调用**整表替换**（无增量 API → 天然无状态不一致问题）。
 * 长任务里模型靠它自我组织步骤、对抗上下文腐化；UI 经 tool_progress
 * 事件拿到最新清单可常驻渲染。
 *
 * 有状态：每个 Agent 应持有自己的实例（createTodoTool() 工厂），
 * 勿把同一实例注册给多个会话。
 */

import type { Tool } from "./tool.js";
import { ToolError } from "./tool.js";
import { t } from "../i18n.js";

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  /** 进行时文案（如"正在跑测试"），UI 对 in_progress 项展示 */
  activeForm?: string;
}

export function createTodoTool(): Tool & { readonly todos: readonly TodoItem[] } {
  let todos: TodoItem[] = [];

  return {
    get todos(): readonly TodoItem[] {
      return todos;
    },
    readOnly: true, // 只改内存清单，无外部副作用；可并发、免授权
    def: {
      name: "todo_write",
      description: t(
        "Maintain the current todo list (whole-list replacement). List the plan when starting a multi-step task, mark an item in_progress before starting it, and mark it completed immediately after finishing.",
        "维护当前任务清单（整表替换）。多步任务开始时列出计划，动手前把该项标 in_progress，完成后立即标 completed。",
      ),
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: t(
              "The full new todo list (replaces the old one)",
              "完整的新任务列表（覆盖旧表）",
            ),
            items: {
              type: "object",
              properties: {
                content: {
                  type: "string",
                  description: t("Task content (imperative)", "任务内容（祈使句）"),
                },
                status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                activeForm: {
                  type: "string",
                  description: t("Present-continuous wording (optional)", "进行时文案（可选）"),
                },
              },
              required: ["content", "status"],
              additionalProperties: false,
            },
          },
        },
        required: ["todos"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${(i["todos"] as unknown[] | undefined)?.length ?? 0} 项`,
    // 会改闭包内清单；同一轮多个调用必须按模型给出的顺序执行。
    isConcurrencySafe: () => false,
    fork: createTodoTool,
    async run(input, ctx) {
      const raw = input["todos"];
      if (!Array.isArray(raw)) throw new ToolError("todos 必须是数组");
      todos = raw.map((t) => normalize(t));
      ctx.emit?.({ type: "todos", todos: [...todos] });
      const remaining = todos.filter((t) => t.status !== "completed").length;
      return `清单已更新：共 ${todos.length} 项，未完成 ${remaining} 项`;
    },
  };
}

/** 容错归一化：模型偶尔写近似键名（active_form 等），修复而非报错 */
function normalize(t: unknown): TodoItem {
  const o = (t ?? {}) as Record<string, unknown>;
  const content = String(o["content"] ?? o["task"] ?? "").trim();
  if (!content) throw new ToolError("任务项缺少 content");
  const status = String(o["status"] ?? "pending");
  if (status !== "pending" && status !== "in_progress" && status !== "completed") {
    throw new ToolError(`非法 status: ${status}`);
  }
  const active = o["activeForm"] ?? o["active_form"];
  return { content, status, ...(active ? { activeForm: String(active) } : {}) };
}
