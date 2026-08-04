/**
 * 工具接口 —— core 内部工具的统一形态。
 *
 * 一个工具 = ToolDefinition（喂给模型的 schema）+ 执行逻辑 + 元数据（只读？规则键？）。
 * 元数据让权限引擎无需硬编码工具名即可决策。
 */

import type { ImagePart, ToolDefinition, Usage } from "../types.js";
import type { ExecutionRuntime } from "../runtime/isolated-runtime.js";
import type { NetworkProxy } from "../runtime/network-proxy.js";
import type { SpanContext } from "../runtime/telemetry.js";

export interface ToolContext {
  /** 工作目录（所有相对路径的根，也是沙箱边界） */
  cwd: string;
  signal: AbortSignal;
  /**
   * 当前模型是否支持视觉。工具据此决定「附图」还是「只回一句文本说明」——
   * 给不支持视觉的模型塞 image 块会被 provider 直接拒绝。
   * 未知能力时按 false 处理（保守：宁可降级为文本，也不要整轮请求失败）。
   */
  modelSupportsImages?: boolean;
  /**
   * 给本次工具结果附带图片（如 read 一张截图/设计稿）。与 emit / addUsage 同属
   * 「工具向父 Agent 回传附加数据」的回调，因此 run() 的返回值仍是纯文本 —— 既有工具无需改动。
   *
   * Agent 会把图片排在本轮全部 tool_result 之后送进同一条 user 消息：
   * 两个 provider 的映射层本就支持独立 image 块（Anthropic image / OpenAI image_url），
   * 故无需改 provider。调用前应先检查 modelSupportsImages。
   */
  attachImage?: (image: ImagePart) => void;
  /** OS 级命令沙箱策略（bash 工具据此包一层 sandbox-exec）；缺省 none / 读环境变量。 */
  sandbox?: "none" | "read-only" | "workspace-write";
  /** 统一隔离执行后端；有值时前后台 shell 都不得走旧的裸 spawn 旁路。 */
  isolatedRuntime?: ExecutionRuntime;
  /** 所有内置 HTTP 工具统一走此策略化出口；生产宿主必须注入。 */
  networkProxy?: NetworkProxy;
  /** 当前工具 span；MCP/Remote Runtime/子 agent 用它延续同一 W3C trace。 */
  traceContext?: SpanContext;
  /**
   * 长任务进度上报通道（可选）。工具执行中调用它，事件会被 Agent 包成
   * tool_progress 实时转发给订阅者 —— 子 agent（task 工具）靠它回流内部事件流。
   * payload 形状由工具自定义，Agent 原样透传。
   */
  emit?: (progress: unknown) => void;
  /**
   * 工具内部产生的模型用量计入父 Agent。task 工具用它汇总子 agent 用量，
   * 避免会话快照与实际账单分叉。
   */
  addUsage?: (usage: Usage) => void;
}

export type ToolCapability =
  "memory" | "filesystem-read" | "filesystem-write" | "network" | "process" | "persistent-process";

export interface Tool {
  readonly def: ToolDefinition;
  /**
   * Host capabilities required by this implementation. Production restricted/container hosts
   * fail closed when this declaration is absent; plugin code is still part of the trusted host
   * boundary and must not under-declare what it executes.
   */
  readonly capabilities?: readonly ToolCapability[];
  /** 是否只读（无副作用）—— 权限引擎据此自动放行；也是并行执行的默认资格线 */
  readonly readOnly: boolean;
  /** 是否属于"文件编辑类"（write/edit）—— acceptEdits 权限模式据此自动放行 */
  readonly mutatesFiles?: boolean;
  /** 从入参生成人类可读的动作摘要（UI 展示 + 权限规则匹配） */
  ruleKey(input: Record<string, unknown>): string;
  /**
   * 本次调用是否可与其他调用并发（按入参判定，对齐 Claude Code 的
   * isConcurrencySafe）。缺省回落到 readOnly；有内部状态的只读工具应显式返回 false。
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean;
  /**
   * 把动作摘要拆成独立匹配单元（权限规则用）。bash 用它把复合命令按
   * && / || / ; / | 拆开 —— allow 需每个子命令都命中，deny 任一命中即拒。
   * 缺省 [ruleKey]。
   */
  ruleParts?(input: Record<string, unknown>): string[];
  /**
   * ruleParts 是否完整描述了命令的可执行单元。false 表示遇到复杂 shell 语法等
   * 无法可靠分析的情况；权限引擎会保守处理细粒度规则。
   */
  rulePartsComplete?(input: Record<string, unknown>): boolean;
  /**
   * 为另一个 Agent 创建独立工具实例。有闭包状态的工具必须实现；无状态工具可省略。
   */
  fork?(): Tool;
  /** Release instance-bound resources (browser/process/client pools). Idempotent when implemented. */
  close?(): Promise<void>;
  /**
   * 执行，返回给模型的文本结果。抛异常 = 工具错误（上层包成 is_error 回传）。
   * 需要附带图片时用 ctx.attachImage，不改变本返回值契约。
   *
   * Deadline note: callbacks/results are ignored after ctx.signal aborts, but JavaScript cannot
   * forcibly terminate an arbitrary non-cooperative in-process Promise. Side-effecting production
   * tools therefore must execute through ctx.isolatedRuntime (or another killable worker/process)
   * and honour ctx.signal; merely racing a third-party JS Promise cannot undo late side effects.
   */
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class ToolError extends Error {}

/**
 * 把 { name → Tool } 注册进一个可查询的集合。
 *
 * deferred（延迟暴露）：标记为 deferred 的工具不进 definitions()（即不占请求里的
 * schema 篇幅），模型通过 tool_search 元工具按需检索并激活。适合大量 MCP 工具场景——
 * 避免几十个工具 schema 把每次请求撑爆。直接调用未激活的 deferred 工具时会被
 * 自动激活并执行（宽容语义）。
 */
export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private deferredNames = new Set<string>();

  register(tool: Tool, opts?: { deferred?: boolean }): this {
    this.tools.set(tool.def.name, tool);
    if (opts?.deferred) this.deferredNames.add(tool.def.name);
    else this.deferredNames.delete(tool.def.name);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** 暴露给模型的 schema（不含未激活的 deferred 工具）。 */
  definitions(): ToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => !this.deferredNames.has(t.def.name))
      .map((t) => t.def);
  }

  /** 尚未激活的 deferred 工具定义（tool_search 的检索面）。 */
  deferredDefinitions(): ToolDefinition[] {
    return [...this.deferredNames].map((n) => this.tools.get(n)!.def);
  }

  hasDeferred(): boolean {
    return this.deferredNames.size > 0;
  }

  isDeferred(name: string): boolean {
    return this.deferredNames.has(name);
  }

  /** 激活一个 deferred 工具（下一轮起 schema 进请求）。返回是否确有此延迟工具。 */
  activate(name: string): boolean {
    return this.deferredNames.delete(name);
  }

  readOnlyNames(): string[] {
    return [...this.tools.values()].filter((t) => t.readOnly).map((t) => t.def.name);
  }

  /**
   * Read-only tools which are safe to auto-approve without crossing a host/external boundary.
   * `readOnly` only means the tool does not mutate AniCode's workspace; a browser, HTTP lookup or
   * process-control tool can still disclose data or affect an external system. Those tools must
   * therefore remain visible to the normal permission rules/confirmation path.
   */
  permissionReadOnlyNames(): string[] {
    const approvalSensitive = new Set<ToolCapability>([
      "filesystem-write",
      "network",
      "process",
      "persistent-process",
    ]);
    return [...this.tools.values()]
      .filter(
        (tool) =>
          tool.readOnly &&
          !tool.capabilities?.some((capability) => approvalSensitive.has(capability)),
      )
      .map((tool) => tool.def.name);
  }

  editNames(): string[] {
    return [...this.tools.values()].filter((t) => t.mutatesFiles).map((t) => t.def.name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Close only resources owned by tool instances in this registry. */
  async closeAll(): Promise<void> {
    const closers = [...new Set([...this.tools.values()].filter((tool) => tool.close))];
    const results = await Promise.allSettled(closers.map((tool) => tool.close!()));
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) throw new AggregateError(failures, "Failed to close tool resources");
  }

  /** 为一个新 Agent 创建独立 registry；有状态工具通过 fork() 隔离闭包状态。 */
  clone(): ToolRegistry {
    return this.subset(this.names());
  }

  /** 生成指定工具子集；有 fork() 的有状态工具会得到独立实例。deferred 标记随行。 */
  subset(names: string[]): ToolRegistry {
    const sub = new ToolRegistry();
    for (const name of names) {
      const t = this.tools.get(name);
      if (t) sub.register(t.fork?.() ?? t, { deferred: this.deferredNames.has(name) });
    }
    return sub;
  }
}
