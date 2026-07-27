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
 *   - task 默认按副作用工具串行执行；三种情况例外地允许并发 fan-out：
 *     只读型（无写副作用）、background=true（工具立即返回，不占轮）、
 *     isolation=worktree（写发生在独立 worktree 副本，互不冲突）
 *   - 后台/续话（background / resume / task_output / task_stop）只在根 agent 可用：
 *     嵌套编排型子 agent 结束后没人接收完成通知，故嵌套 task 工具是前台-only
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolRegistry } from "./tools/tool.js";
import { ToolError } from "./tools/tool.js";
import { t } from "./i18n.js";
import { globMatch, type PermissionConfig } from "./permission.js";
import type { HookRegistration, HookRunner } from "./hooks.js";
import type { Provider, Usage } from "./types.js";
import type {
  Agent,
  AgentOptions,
  AgentEvent,
  AgentModelInfo,
  AgentResolvedModel,
} from "./agent.js";

const execFileP = promisify(execFile);

export interface SubagentDefinition {
  /** 类型名，模型经 subagent_type 参数选择它 */
  name: string;
  /** 给模型看的用途说明（何时该派这个子 agent） */
  description: string;
  /** 子 agent 的 system 提示；缺省用通用子 agent 提示 */
  system?: string;
  /** 允许的工具名子集；缺省继承父的全部工具（除 task） */
  tools?: string[];
  /**
   * 禁用的工具名（支持 * glob，如 "mcp__*"）；在 tools/继承集确定后剔除
   * （对齐 Claude Code 的 disallowedTools）。
   */
  disallowedTools?: string[];
  /** 覆盖模型；裸 id 沿用父 provider，provider/model 可跨 provider（需 resolver）。 */
  model?: string;
  /** 推理深度覆盖（对齐 Codex agents 的 model_reasoning_effort）；缺省继承父级默认。 */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTurns?: number;
  /**
   * 只读调研型：子 agent 工具面被收窄到只读工具（不能写文件/跑命令），因此**无副作用**，
   * 多个此类 task 调用可被父 agent 并行 fan-out（对齐 opencode 的 explore/并行子代理）。
   */
  readOnly?: boolean;
  /**
   * 编排型：破例保留 task 工具，使其能再往下派子 agent（否则一律被剥离防递归）。
   * 仅显式声明此项的类型才拥有嵌套委派能力；仍受 MAX_SUBAGENT_DEPTH 深度上限约束，
   * 到达上限后即便是编排型也不再下发 task。用于 规划者→执行者→工人 这类多层协作模板。
   */
  orchestrator?: boolean;
}

/** 嵌套委派的深度上限：根 task 工具为 0，每下派一层编排型子 agent +1。
 *  默认 2 支撑「主 → L1 编排 → L2 编排 → L3 工人」的三层链（对齐 Sisyphus/Atlas/Hephaestus）。 */
export const MAX_SUBAGENT_DEPTH = 2;

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

// ---------- 任务注册表（后台执行与续话的载体） ----------

export type TaskStatus = "running" | "done" | "error" | "stopped";

export interface TaskRecord {
  id: string;
  /** subagent 类型名（resume 时沿用，忽略新传入的 subagent_type）。 */
  type: string;
  description: string;
  status: TaskStatus;
  /** 当前这一轮运行是否为后台模式（同一任务可以前台起、后台续，反之亦然）。 */
  background: boolean;
  /** 子 agent 实例 —— 保留完整上下文，resume 靠它续话。 */
  agent: Agent;
  /** 后台运行的中止把手（前台运行随父回合的 signal，不设此项）。 */
  abort?: AbortController;
  /** 最终结论（status=done 时有值）。 */
  result?: string;
  error?: string;
  /** 最近活动行（后台任务的可观测性，task_output 展示）。 */
  activity?: string;
  /** isolation=worktree 时的工作目录；任务干净结束后被清理并置 worktreeRemoved。 */
  worktree?: string;
  worktreeRemoved?: boolean;
}

/** 注册表容量：超出后从最老的非 running 记录开始逐出（running 永不逐出）。 */
const TASK_REGISTRY_CAP = 32;
/** 单会话累计派生上限（对齐 Claude Code 的 spawn 总量硬顶思路）—— 防失控循环刷任务。 */
const TASK_SPAWN_CAP = 100;
/** 同时运行的后台任务上限（对齐 Codex max_concurrent_threads_per_session）。 */
const TASK_BACKGROUND_CAP = 8;

export class TaskRegistry {
  private records = new Map<string, TaskRecord>();
  private seq = 0;

  nextId(): string {
    if (this.seq >= TASK_SPAWN_CAP)
      throw new ToolError(`本会话子 agent 派生数已达上限 ${TASK_SPAWN_CAP}`);
    return `t${++this.seq}`;
  }

  /** 运行中的后台任务数（并发上限判定用）。 */
  backgroundRunning(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.status === "running" && r.abort) n++;
    return n;
  }

  assertBackgroundSlot(): void {
    if (this.backgroundRunning() >= TASK_BACKGROUND_CAP)
      throw new ToolError(
        `后台任务并发已达上限 ${TASK_BACKGROUND_CAP}；等待通知或用 task_stop 释放`,
      );
  }

  add(record: TaskRecord): void {
    this.records.set(record.id, record);
    if (this.records.size > TASK_REGISTRY_CAP) {
      for (const [id, r] of this.records) {
        if (r.status !== "running") {
          this.records.delete(id);
          break;
        }
      }
    }
  }

  get(id: string): TaskRecord | undefined {
    return this.records.get(id);
  }

  list(): TaskRecord[] {
    return [...this.records.values()];
  }

  /** 停止全部后台任务（会话销毁时调用）。返回被停掉的数量。 */
  stopAll(): number {
    let n = 0;
    for (const r of this.records.values()) {
      if (r.status === "running" && r.abort) {
        r.abort.abort();
        r.status = "stopped";
        n++;
      }
    }
    return n;
  }
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
  /**
   * 父 agent 的 HookRunner —— 触发 SubagentStart（可 block 阻止派生）与
   * SubagentStop（观察性）。matcher 匹配的是子 agent 类型名。
   */
  parentHooks?: HookRunner;
  /** 自定义 subagent 类型；general 始终可用 */
  definitions?: SubagentDefinition[];
  defaultMaxTurns?: number;
  /** 继承父级 OS 沙箱策略，避免子 agent 的 bash 成为绕过沙箱的通道。 */
  sandbox?: AgentOptions["sandbox"];
  /** 当前委派层级（根 task 工具为 0，每下派一层编排型子 agent +1）。内部用，勿手填。 */
  depth?: number;
  /** 嵌套委派深度上限；缺省 MAX_SUBAGENT_DEPTH。 */
  maxDepth?: number;
  /**
   * 任务注册表 + 完成通知回调 —— 两者都提供才启用后台/续话能力
   * （background / resume 参数与 task_output / task_stop 工具）。
   * notifyTaskDone 在后台任务收尾时被调用，文本已包好 <task-notification> 信封；
   * 接收方（父 Agent）负责按运行态选择注入方式。
   */
  registry?: TaskRegistry;
  notifyTaskDone?: (text: string) => void;
}

/** createTaskTools 的返回：task 恒有；后台能力启用时附带 task_send / task_output / task_stop。 */
export interface TaskTools {
  task: Tool;
  taskSend?: Tool;
  taskOutput?: Tool;
  taskStop?: Tool;
  all: Tool[];
}

/** 兼容入口：只要 task 工具本体（既有测试/调用方使用）。 */
export function createTaskTool(opts: TaskToolOptions): Tool {
  return createTaskTools(opts).task;
}

export function createTaskTools(opts: TaskToolOptions): TaskTools {
  const defs = new Map<string, SubagentDefinition>();
  defs.set(GENERAL_SUBAGENT.name, GENERAL_SUBAGENT);
  defs.set(EXPLORE_SUBAGENT.name, EXPLORE_SUBAGENT);
  for (const d of opts.definitions ?? []) defs.set(d.name, d);

  const typeList = [...defs.values()].map((d) => `- ${d.name}: ${d.description}`).join("\n");
  const backgroundEnabled = Boolean(opts.registry && opts.notifyTaskDone);
  const registry = opts.registry;

  const task: Tool = {
    readOnly: false,
    def: {
      name: "task",
      description:
        t(
          "Delegate one independent subtask to a subagent and get back only its final conclusion text — the intermediate steps don't consume your context. " +
            "Good for broad search, multi-file investigation, and independent work. " +
            (backgroundEnabled
              ? "background=true runs it in the background (returns a task id immediately; you'll get a <task-notification> when it finishes; check with task_output, stop with task_stop, continue it with task_send). " +
                'isolation="worktree" runs it in a detached git worktree copy so several writing tasks can run in parallel without conflicts; a clean worktree is auto-removed, a dirty one is kept and its path reported for you to merge. '
              : "") +
            "Read-only types, background tasks, and worktree-isolated tasks may run in parallel; other tasks run sequentially. Available types:\n",
          "把一项独立子任务委派给子 agent 执行，只返回其最终结论文本 —— 中间过程不占用你的上下文。" +
            "适合大范围搜索、多文件调研和独立工作。" +
            (backgroundEnabled
              ? "background=true 后台运行（立即返回任务 id；完成时你会收到 <task-notification> 通知；可用 task_output 查看、task_stop 终止、task_send 续话）。" +
                'isolation="worktree" 让它在独立 git worktree 副本中运行，多个写任务可并行互不冲突；无改动的 worktree 自动清理，有改动则保留并报告路径由你合并。'
              : "") +
            "只读类型、后台任务与 worktree 隔离任务可并行执行；其余按序执行。可用类型：\n",
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
          ...(backgroundEnabled
            ? {
                background: {
                  type: "boolean",
                  description: t(
                    "Run in the background: returns immediately with a task id; a notification arrives when it finishes",
                    "后台运行：立即返回任务 id，完成时收到通知",
                  ),
                },
                isolation: {
                  type: "string",
                  enum: ["worktree"],
                  description: t(
                    "worktree: run in an isolated detached git worktree (parallel-safe writes)",
                    "worktree：在独立 git worktree 副本中运行（写操作可并行）",
                  ),
                },
              }
            : {}),
        },
        required: ["description", "prompt"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["subagent_type"] ?? "general")}: ${String(i["description"] ?? "")}`,
    // 并发资格：只读调研型无写副作用；background 调用本身立即返回（真正的工作在轮外）；
    // worktree 隔离的写发生在独立副本。三者都可与其他调用并行 fan-out，其余保持串行。
    isConcurrencySafe: (i) => {
      if (i["background"] === true) return true;
      if (i["isolation"] === "worktree") return true;
      return Boolean(defs.get(String(i["subagent_type"] ?? "general"))?.readOnly);
    },
    async run(input, ctx: ToolContext): Promise<string> {
      const prompt = String(input["prompt"] ?? "");
      const description = String(input["description"] ?? "");
      if (!prompt) throw new ToolError("prompt 不能为空");
      const background = backgroundEnabled && input["background"] === true;
      const type = String(input["subagent_type"] ?? "general");
      const def = defs.get(type);
      if (!def)
        throw new ToolError(`未知 subagent 类型: ${type}（可选: ${[...defs.keys()].join(", ")}）`);

      // SubagentStart：父级 hook 可否决派生（如策略禁止某类型/预算控制）。
      if (opts.parentHooks?.has("SubagentStart")) {
        const h = await opts.parentHooks.run({
          event: "SubagentStart",
          cwd: opts.cwd,
          toolName: type,
          subagentType: type,
          taskDescription: description,
        });
        if (h.blocked) throw new ToolError(`SubagentStart hook 拦截: ${h.reason}`);
      }

      if (background) registry!.assertBackgroundSlot();
      // 先取 id（spawn 上限在此判定），再创建 worktree —— 顺序反了会在超限时泄漏 worktree。
      const taskId = registry?.nextId() ?? "t0";

      // isolation=worktree：为子 agent 铺一个 detached worktree 作为 cwd。
      let worktree: string | undefined;
      if (input["isolation"] === "worktree") {
        if (!backgroundEnabled)
          throw new ToolError("isolation=worktree 仅根 agent 的 task 工具支持");
        worktree = await addWorktree(opts.cwd);
      }

      const child = buildChildAgent(def, worktree ?? opts.cwd);
      const record: TaskRecord = {
        id: taskId,
        type,
        description,
        status: "running",
        background,
        agent: child,
        ...(worktree ? { worktree } : {}),
      };
      registry?.add(record);
      return runRecord(record, prompt, background, ctx);
    },
  };

  /** 按定义构造子 agent（工具收窄 / 模型解析 / 嵌套编排注册都在这里）。 */
  function buildChildAgent(def: SubagentDefinition, cwd: string): Agent {
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
    //   - 默认排除 task 及其配套（task_output/task_stop）—— 子 agent 不能再派子 agent
    //     （防递归 / 上下文与费用失控）；例外：def.orchestrator 型在深度预算内会在下方
    //     重新获得一个 depth+1 的嵌套 task（前台-only，无后台配套）；
    //   - 从「继承全部」的默认集里排除 todo_write —— 子 agent 的清单是隔离的、不展示给用户，
    //     只会污染进度流；显式 def.tools 指定了则尊重；
    //   - readOnly 型：进一步收窄到只读工具，保证「无写副作用」这一并行前提成立。
    //   - 从默认集里排除 kill_shell —— 它为了「清理不该二次确认」而标记 readOnly，
    //     于是会混进 readOnly 型子 agent 的只读工具面，破坏「无写副作用、可并行」的前提：
    //     一个并行调研子 agent 不该能杀掉主 agent 的 dev server。子 agent 仍可用
    //     bash_output 读后台输出（那才是真只读）。显式 def.tools 指定了则尊重。
    const DERIVED_DENY = new Set([
      "task",
      "task_send",
      "task_output",
      "task_stop",
      "todo_write",
      "kill_shell",
    ]);
    let base = def.tools ?? opts.tools.names().filter((n) => !DERIVED_DENY.has(n));
    if (def.readOnly) {
      const readOnlySet = new Set(opts.tools.readOnlyNames());
      base = base.filter((n) => readOnlySet.has(n));
    }
    // disallowedTools 最后应用：无论来自显式 tools 还是继承集，命中即剔除。
    if (def.disallowedTools?.length) {
      const denied = def.disallowedTools;
      base = base.filter((n) => !denied.some((pattern) => globMatch(pattern, n)));
    }
    // task 家族无条件剥离：即便显式 def.tools 列出也不下发 —— task_send/task_output/
    // task_stop 闭包持有父注册表，泄漏给子 agent 等于让它操纵兄弟任务。
    const TASK_FAMILY = new Set(["task", "task_send", "task_output", "task_stop"]);
    const childTools = opts.tools.subset(base.filter((n) => !TASK_FAMILY.has(n)));
    // 编排型子 agent 破例保留 task：注册一个 depth+1 的嵌套委派工具，使其能再往下派，
    // 直到 maxDepth 上限后即便编排型也不再下发（防无限递归 / 上下文与费用失控）。
    // 嵌套工具从同一份父全量工具集（opts.tools）子集化，故孙 agent 的工具面与子 agent 一致。
    // 嵌套 task 不带 registry/notify —— 前台-only（编排子 agent 结束后没人接收后台通知）。
    const depth = opts.depth ?? 0;
    const maxDepth = opts.maxDepth ?? MAX_SUBAGENT_DEPTH;
    if (def.orchestrator && depth < maxDepth) {
      const { registry: _r, notifyTaskDone: _n, ...rest } = opts;
      childTools.register(createTaskTool({ ...rest, depth: depth + 1 }));
    }
    return opts.makeAgent({
      provider: resolved?.provider ?? opts.provider,
      model: resolved?.model ?? def.model ?? opts.model,
      ...(!def.model && opts.modelInfo
        ? { modelInfo: opts.modelInfo }
        : resolved?.modelInfo
          ? { modelInfo: resolved.modelInfo }
          : {}),
      ...(opts.resolveModel ? { resolveModel: opts.resolveModel } : {}),
      cwd,
      ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      system: def.system ?? subagentSystem(),
      ...(def.effort ? { effort: def.effort } : {}),
      // 子 agent 不重复采集环境（每次都 spawn git，量大时拖慢）；父会话已接地。
      injectEnv: false,
      tools: childTools,
      ...(opts.permission ? { permission: opts.permission } : {}),
      ...(opts.hooks?.length ? { hooks: opts.hooks } : {}),
      maxTurns: def.maxTurns ?? opts.defaultMaxTurns ?? 30,
    });
  }

  /**
   * 驱动一条任务记录跑一轮（新任务与 resume 共用）。
   * 前台：随父回合 signal，事件经 ctx.emit 回流，返回最终结论。
   * 后台：独立 AbortController（父回合中断不影响它），立即返回任务 id；
   *       收尾时把结果包成 <task-notification> 经 notifyTaskDone 交回父 Agent。
   */
  function runRecord(
    record: TaskRecord,
    prompt: string,
    background: boolean,
    ctx: ToolContext,
  ): Promise<string> | string {
    record.status = "running";
    record.background = background;
    const child = record.agent;
    const usageBefore = { ...child.totalUsage };

    const finish = async (errorMsg: string | null, aborted: boolean): Promise<string> => {
      // task_send 续话会多轮累计，用量按本轮增量计入父会话，避免重复记账。
      ctx.addUsage?.(usageDelta(child.totalUsage, usageBefore));
      // 防伪：剥掉子 agent 输出里的通知信封标记，子输出不能伪装成宿主的控制信息。
      const answer = sanitizeChildText(finalAssistantText(child));
      record.status = aborted ? "stopped" : errorMsg ? "error" : "done";
      record.result = answer;
      if (errorMsg) record.error = errorMsg;
      let worktreeNote = "";
      if (record.worktree && !record.worktreeRemoved) {
        const state = await cleanupWorktree(opts.cwd, record.worktree).catch(() => "kept" as const);
        if (state === "removed") record.worktreeRemoved = true;
        else
          worktreeNote = t(
            `\n[changes kept in worktree: ${record.worktree} — merge or discard them]`,
            `\n[改动保留在 worktree: ${record.worktree} —— 请合并或丢弃]`,
          );
      }
      // SubagentStop：观察性，成功/失败都触发（审计/统计用）。
      if (opts.parentHooks?.has("SubagentStop")) {
        await opts.parentHooks.run({
          event: "SubagentStop",
          cwd: opts.cwd,
          toolName: record.type,
          subagentType: record.type,
          taskDescription: record.description,
          isError: errorMsg !== null,
          toolResult: errorMsg ?? answer,
        });
      }
      if (errorMsg) throw new ToolError(`子 agent 失败: ${errorMsg}`);
      return (
        (answer || t("(subagent produced no text conclusion)", "（子 agent 未产出文本结论）")) +
        worktreeNote
      );
    };

    if (!background) {
      return (async () => {
        let errorMsg: string | null = null;
        for await (const ev of child.send(prompt, ctx.signal)) {
          ctx.emit?.(ev satisfies AgentEvent);
          if (ev.type === "error") errorMsg = ev.message;
        }
        const out = await finish(errorMsg, ctx.signal.aborted);
        if (!backgroundEnabled) return out; // 嵌套（前台-only）task 无 task_send，不提任务 id
        return `${out}\n${t(`[task id: ${record.id} — use task_send to follow up with this subagent]`, `[任务 id: ${record.id} —— 用 task_send 可继续该子 agent]`)}`;
      })();
    }

    // ----- 后台：detach 驱动，完成时通知父 Agent -----
    const abort = new AbortController();
    record.abort = abort;
    void (async () => {
      let errorMsg: string | null = null;
      let out = "";
      try {
        for await (const ev of child.send(prompt, abort.signal)) {
          // 不再经 ctx.emit 回流（该工具调用已返回，通道已关）；留一条活动行供 task_output。
          if (ev.type === "tool_start") record.activity = `${ev.name}: ${ev.ruleKey}`;
          if (ev.type === "error") errorMsg = ev.message;
        }
        out = await finish(errorMsg, abort.signal.aborted).catch((e: unknown) => {
          errorMsg = e instanceof Error ? e.message : String(e);
          return "";
        });
      } catch (e) {
        errorMsg = e instanceof Error ? e.message : String(e);
        record.status = "error";
        record.error = errorMsg;
      }
      if (abort.signal.aborted) return; // task_stop / 会话销毁：静默收尾，不再通知
      opts.notifyTaskDone?.(taskNotification(record, errorMsg, out));
    })();

    return Promise.resolve(
      t(
        `Background task started (id: ${record.id}, type: ${record.type}). You'll get a <task-notification> when it finishes; task_output checks progress, task_stop cancels. Keep working on other things meanwhile — don't idle-wait.`,
        `后台任务已启动（id: ${record.id}，类型: ${record.type}）。完成时你会收到 <task-notification> 通知；task_output 查进度，task_stop 终止。期间请继续其他工作，不要空等。`,
      ),
    );
  }

  if (!backgroundEnabled) return { task, all: [task] };

  const taskSend: Tool = {
    // 续话会驱动子 agent 干活（可能写文件），按副作用工具对待。
    readOnly: false,
    def: {
      name: "task_send",
      description: t(
        "Send a follow-up message to a previous subagent (by task id) — it keeps its full context. Use for follow-up questions, iteration, or new instructions building on its earlier work. background=true detaches like a background task.",
        "给既有子 agent 发后续消息（按任务 id）—— 其上下文完整保留。适合追问、迭代、在其已有工作上追加指令。background=true 则像后台任务一样脱管运行。",
      ),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: t("Task id (e.g. t1)", "任务 id（如 t1）") },
          message: {
            type: "string",
            description: t("The follow-up instruction", "追加的指令"),
          },
          background: {
            type: "boolean",
            description: t(
              "Run the follow-up in the background (notification on finish)",
              "后台运行本次续话（完成时收到通知）",
            ),
          },
        },
        required: ["id", "message"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => `${String(i["id"] ?? "")}: ${String(i["message"] ?? "").slice(0, 60)}`,
    isConcurrencySafe: (i) => i["background"] === true,
    async run(input, ctx: ToolContext): Promise<string> {
      const id = String(input["id"] ?? "");
      const message = String(input["message"] ?? "");
      if (!message) throw new ToolError("message 不能为空");
      const record = registry!.get(id);
      if (!record) {
        const ids = registry!
          .list()
          .map((r) => `${r.id}(${r.status})`)
          .join(", ");
        throw new ToolError(`任务 ${id} 不存在（可能已被逐出）。在册任务: ${ids || "无"}`);
      }
      if (record.status === "running")
        throw new ToolError(`任务 ${id} 仍在运行，用 task_output 查看进度`);
      if (record.worktree && record.worktreeRemoved)
        throw new ToolError(`任务 ${id} 的 worktree 已清理，无法继续；请新起任务`);
      const background = input["background"] === true;
      if (background) registry!.assertBackgroundSlot();
      return runRecord(record, message, background, ctx);
    },
  };

  const taskOutput: Tool = {
    readOnly: true,
    def: {
      name: "task_output",
      description: t(
        "Check a background subagent task: status, latest activity, and (when finished) its final conclusion.",
        "查看后台子 agent 任务：状态、最近活动，结束后可取最终结论。",
      ),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: t("Task id (e.g. t1)", "任务 id（如 t1）") },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["id"] ?? ""),
    async run(input): Promise<string> {
      const record = registry!.get(String(input["id"] ?? ""));
      if (!record) {
        const ids = registry!
          .list()
          .map((r) => `${r.id}(${r.status})`)
          .join(", ");
        throw new ToolError(`任务不存在。在册任务: ${ids || "无"}`);
      }
      const u = record.agent.totalUsage;
      const lines = [
        `id: ${record.id}  type: ${record.type}  status: ${record.status}`,
        `description: ${record.description}`,
        `usage: in=${u.inputTokens} out=${u.outputTokens}`,
        ...(record.worktree
          ? [
              `worktree: ${record.worktree}${record.worktreeRemoved ? t(" (removed)", "（已清理）") : ""}`,
            ]
          : []),
        ...(record.status === "running" && record.activity
          ? [t(`activity: ${record.activity}`, `当前活动: ${record.activity}`)]
          : []),
        ...(record.error ? [`error: ${record.error}`] : []),
        ...(record.result ? ["", record.result] : []),
      ];
      return lines.join("\n");
    },
  };

  const taskStop: Tool = {
    // 与 kill_shell 同理：终止自己派生的后台任务属清理动作，不应二次确认。
    readOnly: true,
    def: {
      name: "task_stop",
      description: t(
        "Stop a running background subagent task.",
        "终止一个运行中的后台子 agent 任务。",
      ),
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: t("Task id (e.g. t1)", "任务 id（如 t1）") },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["id"] ?? ""),
    async run(input): Promise<string> {
      const record = registry!.get(String(input["id"] ?? ""));
      if (!record) throw new ToolError("任务不存在");
      if (record.status !== "running" || !record.abort)
        return t(
          `Task ${record.id} is not running (status: ${record.status})`,
          `任务 ${record.id} 未在运行（状态: ${record.status}）`,
        );
      record.abort.abort();
      record.status = "stopped";
      return t(`Task ${record.id} stopped`, `任务 ${record.id} 已终止`);
    },
  };

  return { task, taskSend, taskOutput, taskStop, all: [task, taskSend, taskOutput, taskStop] };
}

/** 剥掉子 agent 输出中的通知信封标记（防伪：子输出不能伪装成宿主控制信息）。 */
function sanitizeChildText(text: string): string {
  return text.replace(/<\/?task-notification[^>]*>/g, "");
}

/** 完成通知信封：模型据此决定消化结果 / resume 追问 / task_output 查详情。 */
function taskNotification(record: TaskRecord, errorMsg: string | null, result: string): string {
  const MAX = 12_000;
  let body = errorMsg
    ? t(`failed: ${errorMsg}`, `失败: ${errorMsg}`)
    : result || record.result || "";
  if (body.length > MAX)
    body =
      body.slice(0, MAX) +
      t("\n…(truncated; task_output for full text)", "\n…（已截断，task_output 看全文）");
  return [
    `<task-notification id="${record.id}">`,
    t(
      `Background subagent task "${record.description}" (${record.id}) ${errorMsg ? "failed" : "finished"}.`,
      `后台子 agent 任务「${record.description}」（${record.id}）${errorMsg ? "失败" : "已完成"}。`,
    ),
    body,
    t(
      `(use task_send with id "${record.id}" to follow up with this subagent)`,
      `（用 task_send 传 id "${record.id}" 可继续与该子 agent 对话）`,
    ),
    `</task-notification>`,
  ].join("\n");
}

function usageDelta(now: Usage, before: Usage): Usage {
  return {
    inputTokens: now.inputTokens - before.inputTokens,
    outputTokens: now.outputTokens - before.outputTokens,
    cacheReadTokens: now.cacheReadTokens - before.cacheReadTokens,
    cacheWriteTokens: now.cacheWriteTokens - before.cacheWriteTokens,
  };
}

// ---------- worktree 隔离 ----------

/** 在系统临时目录创建一个 detached worktree（当前 HEAD）。非 git 仓库时抛 ToolError。 */
async function addWorktree(cwd: string): Promise<string> {
  const dir = path.join(
    os.tmpdir(),
    "anicode-worktrees",
    `wt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await fs.mkdir(path.dirname(dir), { recursive: true });
  try {
    await execFileP("git", ["-C", cwd, "worktree", "add", "--detach", dir]);
  } catch (e) {
    throw new ToolError(
      `无法创建 worktree（需要 git 仓库且有至少一个 commit）: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return dir;
}

/** 任务收尾：worktree 无改动（工作区干净且 HEAD 未动）→ 移除；否则保留由父 agent 合并。 */
async function cleanupWorktree(repoCwd: string, dir: string): Promise<"removed" | "kept"> {
  const [status, headRepo, headWt] = await Promise.all([
    execFileP("git", ["-C", dir, "status", "--porcelain"]),
    execFileP("git", ["-C", repoCwd, "rev-parse", "HEAD"]),
    execFileP("git", ["-C", dir, "rev-parse", "HEAD"]),
  ]);
  if (status.stdout.trim() || headRepo.stdout.trim() !== headWt.stdout.trim()) return "kept";
  await execFileP("git", ["-C", repoCwd, "worktree", "remove", "--force", dir]);
  return "removed";
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
