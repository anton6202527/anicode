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
import { coreOwnedTool, isCoreOwnedTool } from "./core-owned.js";

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

/**
 * Execution boundary selected by the trusted host when a tool is registered.
 *
 * `trusted-in-process` is an explicit compatibility escape hatch for host-owned closures. It must
 * never be inferred for production extension inputs. `managed-external` is reserved for a
 * core-owned proxy adapter (currently MCP/LSP) whose transport owns cancellation and close proof.
 * `isolated-module` is the declarative third-party path: ToolExecutor imports the module only in a
 * sandboxed child process and never serializes or evaluates the Tool's `run` closure.
 */
export type ToolExecutionBoundary =
  | { kind: "trusted-in-process" }
  | {
      kind: "managed-external";
      protocol: "mcp-stdio" | "mcp-http" | "lsp" | "runtime";
      /** Whether cancellation proves the external worker stopped or leaves a remote outcome open. */
      cancellation: "close-confirmed" | "outcome-indeterminate";
      /** External namespace; the public tool name must be `${namespace}__...`. */
      namespace: string;
    }
  | {
      kind: "isolated-module";
      protocolVersion: 1;
      namespace: string;
      /** Workspace-relative ESM path. Absolute paths and traversal are rejected. */
      module: string;
      /** SHA-256 of the self-contained entry module source. */
      sha256: string;
      exportName: string;
    };

/** Data-only manifest accepted from an untrusted extension catalog. */
export interface IsolatedModuleToolManifest {
  version: 1;
  namespace: string;
  name: string;
  description: string;
  parameters: ToolDefinition["parameters"];
  module: string;
  /** SHA-256 of the self-contained entry module source. */
  sha256: string;
  exportName?: string;
  capabilities: readonly ToolCapability[];
  readOnly: boolean;
  mutatesFiles?: boolean;
  /** Optional primitive input fields included in the permission summary. */
  ruleKeyFields?: readonly string[];
}

export interface Tool {
  readonly def: ToolDefinition;
  /** Explicit for production extensions; omitted built-ins remain trusted host code. */
  readonly execution?: ToolExecutionBoundary;
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

const TOOL_NAME_SEGMENT = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TOOL_EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const RULE_KEY_FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const TOOL_CAPABILITIES = new Set<ToolCapability>([
  "memory",
  "filesystem-read",
  "filesystem-write",
  "network",
  "process",
  "persistent-process",
]);
const ISOLATED_TOOL_BRAND = new WeakSet<Tool>();
const MANAGED_EXTERNAL_TOOL_BRAND = new WeakSet<Tool>();

/**
 * Convert a data-only third-party manifest into the normal Tool surface. The placeholder `run`
 * must never execute: ToolExecutor dispatches `isolated-module` through its core-owned process
 * adapter. Keeping the adapter here avoids function serialization and preserves existing registry
 * and provider contracts.
 */
export function isolatedModuleTool(manifest: IsolatedModuleToolManifest): Tool {
  const normalized = normalizeIsolatedManifest(manifest);
  const exportName = normalized.exportName ?? "run";
  if (!TOOL_EXPORT_NAME.test(exportName)) {
    throw new TypeError("isolated tool exportName is invalid");
  }
  if (normalized.capabilities.includes("persistent-process")) {
    throw new TypeError("isolated tools cannot declare persistent-process capability");
  }
  assertManifestCapabilities(normalized);
  const name = `${normalized.namespace}__${normalized.name}`;
  if (name.length > 64) throw new TypeError("isolated tool full name exceeds 64 characters");
  const fields = Object.freeze([...(normalized.ruleKeyFields ?? [])]);
  const execution = Object.freeze({
    kind: "isolated-module" as const,
    protocolVersion: 1 as const,
    namespace: normalized.namespace,
    module: normalized.module,
    sha256: normalized.sha256,
    exportName,
  });
  const def = deepFreeze({
    name,
    description: normalized.description,
    parameters: normalized.parameters,
  });
  const capabilities = Object.freeze([...normalized.capabilities]);
  const tool: Tool = {
    def,
    execution,
    capabilities,
    readOnly: normalized.readOnly,
    ...(normalized.mutatesFiles !== undefined ? { mutatesFiles: normalized.mutatesFiles } : {}),
    ruleKey(input) {
      if (fields.length === 0) return name;
      const summary = fields.map((field) => `${field}=${permissionValue(input[field])}`).join(", ");
      return `${name}(${summary})`.slice(0, 1_024);
    },
    async run() {
      throw new ToolError("Isolated module tools must execute through ToolExecutor");
    },
  };
  ISOLATED_TOOL_BRAND.add(tool);
  return Object.freeze(tool);
}

/** Internal brand check; the WeakSet cannot be forged by an extension manifest. */
export function isIsolatedModuleTool(tool: Tool): boolean {
  return ISOLATED_TOOL_BRAND.has(tool);
}

type ManagedExternalBoundary = Extract<ToolExecutionBoundary, { kind: "managed-external" }>;

/**
 * Internal-only normalizer for core-owned proxy adapters such as MCP. This symbol is intentionally
 * not re-exported from the package root, so plugin code cannot bless its own in-process closure as
 * a managed transport.
 */
export function managedExternalTool(tool: Tool, boundary: ManagedExternalBoundary): Tool {
  assertToolNameSegment(boundary.namespace, "managed tool namespace");
  const prefix = `${boundary.namespace}__`;
  if (!tool.def.name.startsWith(prefix) || tool.def.name.length > 64) {
    throw new TypeError(`Managed tool ${tool.def.name} is outside its namespace`);
  }
  assertToolNameSegment(tool.def.name.slice(prefix.length), "managed tool name suffix");
  if (typeof tool.run !== "function" || typeof tool.ruleKey !== "function") {
    throw new TypeError("Managed external tool adapter is invalid");
  }
  const def = deepFreeze({
    name: boundedString(tool.def.name, 64, "managed tool name"),
    description: boundedString(tool.def.description, 16 * 1024, "managed tool description"),
    parameters: cloneBoundedPlainJson(
      tool.def.parameters,
      256 * 1024,
      "managed tool parameters",
    ) as ToolDefinition["parameters"],
  });
  const capabilities = tool.capabilities
    ? Object.freeze(validateCapabilities(tool.capabilities))
    : undefined;
  const normalized: Tool = Object.freeze({
    ...tool,
    def,
    execution: Object.freeze({ ...boundary }),
    ...(capabilities ? { capabilities } : {}),
  });
  MANAGED_EXTERNAL_TOOL_BRAND.add(normalized);
  return normalized;
}

/** Internal brand check for core-owned proxy adapters. */
export function isManagedExternalTool(tool: Tool): boolean {
  return MANAGED_EXTERNAL_TOOL_BRAND.has(tool);
}

/** Normalize provider/hook input before any isolated-tool callback or permission summary sees it. */
export function normalizeIsolatedToolInput(
  value: Record<string, unknown>,
  maxBytes = 512 * 1024,
): Record<string, unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024) {
    throw new TypeError("isolated tool input limit is invalid");
  }
  const normalized = cloneBoundedPlainJson(value, maxBytes, "isolated tool input");
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new ToolError("isolated tool input must be a plain JSON object");
  }
  return normalized as Record<string, unknown>;
}

function normalizeIsolatedManifest(
  manifest: IsolatedModuleToolManifest,
): IsolatedModuleToolManifest {
  const value = cloneBoundedPlainJson(manifest, 256 * 1024, "isolated tool manifest") as Record<
    string,
    unknown
  >;
  const allowed = new Set([
    "version",
    "namespace",
    "name",
    "description",
    "parameters",
    "module",
    "sha256",
    "exportName",
    "capabilities",
    "readOnly",
    "mutatesFiles",
    "ruleKeyFields",
  ]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`Unknown isolated tool manifest field: ${key}`);
  }
  if (value["version"] !== 1) throw new TypeError("Unsupported isolated tool manifest version");
  const namespace = boundedString(value["namespace"], 64, "isolated tool namespace");
  const name = boundedString(value["name"], 64, "isolated tool name");
  assertToolNameSegment(namespace, "isolated tool namespace");
  assertToolNameSegment(name, "isolated tool name");
  const description = boundedString(value["description"], 16 * 1024, "isolated tool description");
  const module = boundedString(value["module"], 1_024, "isolated tool module");
  assertRelativeModulePath(module);
  const sha256 = boundedString(value["sha256"], 64, "isolated tool sha256");
  if (!SHA256_HEX.test(sha256)) throw new TypeError("isolated tool sha256 is invalid");
  const exportNameValue = value["exportName"];
  if (exportNameValue !== undefined && typeof exportNameValue !== "string") {
    throw new TypeError("isolated tool exportName must be a string");
  }
  if (typeof value["readOnly"] !== "boolean") {
    throw new TypeError("isolated tool readOnly must be boolean");
  }
  if (value["mutatesFiles"] !== undefined && typeof value["mutatesFiles"] !== "boolean") {
    throw new TypeError("isolated tool mutatesFiles must be boolean");
  }
  if (
    !value["parameters"] ||
    typeof value["parameters"] !== "object" ||
    Array.isArray(value["parameters"])
  ) {
    throw new TypeError("isolated tool parameters must be a JSON object");
  }
  const capabilities = validateCapabilities(value["capabilities"]);
  const ruleKeyFieldsValue = value["ruleKeyFields"];
  let ruleKeyFields: string[] | undefined;
  if (ruleKeyFieldsValue !== undefined) {
    if (!Array.isArray(ruleKeyFieldsValue) || ruleKeyFieldsValue.length > 16) {
      throw new TypeError("isolated tool ruleKeyFields must contain at most 16 strings");
    }
    ruleKeyFields = ruleKeyFieldsValue.map((field) => {
      if (typeof field !== "string" || !RULE_KEY_FIELD.test(field)) {
        throw new TypeError("isolated tool ruleKeyFields contains an invalid field");
      }
      return field;
    });
    if (new Set(ruleKeyFields).size !== ruleKeyFields.length) {
      throw new TypeError("isolated tool ruleKeyFields contains duplicates");
    }
  }
  return {
    version: 1,
    namespace,
    name,
    description,
    parameters: value["parameters"] as ToolDefinition["parameters"],
    module,
    sha256,
    ...(exportNameValue !== undefined ? { exportName: exportNameValue } : {}),
    capabilities,
    readOnly: value["readOnly"],
    ...(value["mutatesFiles"] !== undefined
      ? { mutatesFiles: value["mutatesFiles"] as boolean }
      : {}),
    ...(ruleKeyFields ? { ruleKeyFields } : {}),
  };
}

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
  private canonicalNames = new Map<string, string>();
  private deferredNames = new Set<string>();

  register(tool: Tool, opts?: { deferred?: boolean }): this {
    const canonical = canonicalToolName(tool.def.name);
    const existing = this.canonicalNames.get(canonical);
    if (existing && existing !== tool.def.name) {
      throw new TypeError(
        `Tool name collision after permission canonicalization: ${existing} / ${tool.def.name}`,
      );
    }
    this.tools.set(tool.def.name, tool);
    this.canonicalNames.set(canonical, tool.def.name);
    if (opts?.deferred) this.deferredNames.add(tool.def.name);
    else this.deferredNames.delete(tool.def.name);
    return this;
  }

  /**
   * Register a production extension without the legacy last-write-wins behavior.
   *
   * Every extension must declare its boundary. Process/module and proxy-backed extensions must
   * also stay inside their declared namespace, preventing a plugin from shadowing a built-in or a
   * different plugin's tool. Host-owned closures remain possible only via the explicit
   * `trusted-in-process` marker.
   */
  registerExtension(tool: Tool, opts?: { deferred?: boolean }): this {
    const execution = tool.execution;
    if (!execution) {
      throw new TypeError(`Extension tool ${tool.def.name} has no execution boundary`);
    }
    const collision = this.canonicalNames.get(canonicalToolName(tool.def.name));
    if (collision) {
      throw new TypeError(`Extension tool name collision: ${collision} / ${tool.def.name}`);
    }
    if (execution.kind === "trusted-in-process") {
      assertToolNameSegment(tool.def.name, "trusted extension tool name");
    } else {
      assertToolNameSegment(execution.namespace, "extension namespace");
      if (!tool.def.name.startsWith(`${execution.namespace}__`)) {
        throw new TypeError(
          `Extension tool ${tool.def.name} is outside namespace ${execution.namespace}`,
        );
      }
    }
    if (execution.kind === "isolated-module") {
      if (!isIsolatedModuleTool(tool)) {
        throw new TypeError("Isolated extension tools must come from a data-only manifest");
      }
      if (execution.protocolVersion !== 1) {
        throw new TypeError("Unsupported isolated tool protocol version");
      }
      assertRelativeModulePath(execution.module);
      if (!SHA256_HEX.test(execution.sha256)) {
        throw new TypeError("isolated tool sha256 is invalid");
      }
      if (!TOOL_EXPORT_NAME.test(execution.exportName)) {
        throw new TypeError("isolated tool exportName is invalid");
      }
      if (tool.capabilities?.includes("persistent-process")) {
        throw new TypeError("isolated tools cannot declare persistent-process capability");
      }
      assertManifestCapabilities({
        readOnly: tool.readOnly,
        ...(tool.mutatesFiles !== undefined ? { mutatesFiles: tool.mutatesFiles } : {}),
        capabilities: tool.capabilities ?? [],
      });
    } else if (execution.kind === "managed-external" && !isManagedExternalTool(tool)) {
      throw new TypeError("Managed external tools must use a core-owned proxy adapter");
    }
    return this.register(tool, opts);
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
          tool.execution?.kind !== "isolated-module" &&
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
      if (!t) continue;
      const forked = t.fork?.() ?? t;
      // WeakSet provenance is intentionally non-structural. Preserve it explicitly when a
      // reviewed tool creates its per-Agent stateful instance.
      if (forked !== t && isCoreOwnedTool(t)) coreOwnedTool(forked);
      if (forked !== t && ISOLATED_TOOL_BRAND.has(t)) ISOLATED_TOOL_BRAND.add(forked);
      if (forked !== t && MANAGED_EXTERNAL_TOOL_BRAND.has(t)) {
        MANAGED_EXTERNAL_TOOL_BRAND.add(forked);
      }
      sub.register(forked, { deferred: this.deferredNames.has(name) });
    }
    return sub;
  }
}

function assertToolNameSegment(value: string, label: string): void {
  if (!TOOL_NAME_SEGMENT.test(value)) throw new TypeError(`${label} is invalid`);
}

/** Permission identifiers are ASCII; avoid locale/Unicode case folding in collision checks. */
function canonicalToolName(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

function assertRelativeModulePath(value: string): void {
  const segments = value.startsWith("./") ? value.slice(2).split("/") : [];
  if (
    !value.startsWith("./") ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.includes(",") ||
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(segment) || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError(
      "isolated tool module must be a literal traversal-free workspace-relative path",
    );
  }
}

function permissionValue(value: unknown): string {
  if (value === null) return "null";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value).slice(0, 256);
  return "[complex]";
}

function assertManifestCapabilities(input: {
  readOnly: boolean;
  mutatesFiles?: boolean;
  capabilities: readonly ToolCapability[];
}): void {
  const filesystemWrite = input.capabilities.includes("filesystem-write");
  const filesystemRead = input.capabilities.includes("filesystem-read");
  if (filesystemWrite && !filesystemRead) {
    throw new TypeError("isolated filesystem-write capability requires filesystem-read");
  }
  if (input.readOnly && (input.mutatesFiles || filesystemWrite)) {
    throw new TypeError("isolated readOnly tool cannot declare workspace mutation");
  }
  if (Boolean(input.mutatesFiles) !== filesystemWrite) {
    throw new TypeError(
      "isolated tool mutatesFiles and filesystem-write capability must be declared together",
    );
  }
}

function validateCapabilities(value: unknown): ToolCapability[] {
  if (!Array.isArray(value) || value.length > TOOL_CAPABILITIES.size) {
    throw new TypeError("tool capabilities must be a bounded array");
  }
  const capabilities = value.map((capability) => {
    if (typeof capability !== "string" || !TOOL_CAPABILITIES.has(capability as ToolCapability)) {
      throw new TypeError("tool capabilities contains an unknown value");
    }
    return capability as ToolCapability;
  });
  if (new Set(capabilities).size !== capabilities.length) {
    throw new TypeError("tool capabilities contains duplicates");
  }
  return capabilities;
}

function boundedString(value: unknown, maxBytes: number, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maxBytes
  ) {
    throw new TypeError(`${label} must be a non-empty string up to ${maxBytes} bytes`);
  }
  return value;
}

function cloneBoundedPlainJson(value: unknown, maxBytes: number, label: string): unknown {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    if (depth > 64) throw new TypeError(`${label} exceeds JSON depth limit`);
    if (++nodes > 100_000) throw new TypeError(`${label} exceeds JSON node limit`);
    if (current === null || typeof current === "string" || typeof current === "boolean") return;
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError(`${label} contains a non-finite number`);
      return;
    }
    if (typeof current !== "object") throw new TypeError(`${label} is not plain JSON`);
    if (seen.has(current)) throw new TypeError(`${label} contains a cycle`);
    seen.add(current);
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null && !Array.isArray(current)) {
      throw new TypeError(`${label} is not plain JSON`);
    }
    const descriptors = Object.getOwnPropertyDescriptors(current);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key === "symbol") throw new TypeError(`${label} contains a symbol key`);
      if (Array.isArray(current) && key === "length") continue;
      const descriptor = descriptors[key]!;
      if (descriptor.get || descriptor.set || !("value" in descriptor)) {
        throw new TypeError(`${label} contains an accessor`);
      }
      if (!descriptor.enumerable) throw new TypeError(`${label} contains hidden properties`);
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(current)) {
      for (let index = 0; index < current.length; index++) {
        if (!Object.hasOwn(current, index)) throw new TypeError(`${label} contains a sparse array`);
      }
    }
    seen.delete(current);
  };
  visit(value, 0);
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new TypeError(`${label} exceeds ${maxBytes} bytes`);
  }
  return JSON.parse(json) as unknown;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
