import { IsolatedRuntime, type ExecutionRuntime } from "../runtime/isolated-runtime.js";
import { ToolRegistry, type Tool } from "./tool.js";
import { readTool, writeTool, editTool, globTool, grepTool } from "./fs.js";
import { bashTool } from "./bash.js";
import { createTodoTool } from "./todo.js";
import { webFetchTool } from "./webfetch.js";
import { applyPatchTool } from "./apply-patch.js";
import { bashOutputTool, killShellTool, writeStdinTool, listShellsTool } from "./shells.js";

export * from "./tool.js";
export { readTool, writeTool, editTool, globTool, grepTool } from "./fs.js";
export {
  applyPatchTool,
  parsePatch,
  applyHunks,
  patchPaths,
  type PatchOp,
  type Hunk,
} from "./apply-patch.js";
export {
  bashTool,
  splitShellCommand,
  analyzeShellCommand,
  type ShellCommandAnalysis,
} from "./bash.js";
export { createTodoTool, type TodoItem } from "./todo.js";
export { webFetchTool, htmlToText } from "./webfetch.js";
export {
  createWebSearchTool,
  formatSearchResults,
  tavilyBackend,
  braveBackend,
  parseTavilyResponse,
  parseBraveResponse,
  webSearchBackendFromEnv,
  webSearchBackendFromBroker,
  type BrokerWebSearchOptions,
  type WebSearchBackend,
  type WebSearchResult,
  type WebSearchQuery,
} from "./web-search.js";
export { buildShellSpawn, sanitizedShellEnv } from "./shell-spawn.js";
export {
  bashOutputTool,
  killShellTool,
  writeStdinTool,
  listShellsTool,
  startBackgroundShell,
  shells,
  ShellRegistry,
  type ShellInfo,
  type ShellStatus,
} from "./shells.js";
export {
  type SandboxPolicy,
  type SandboxSpec,
  wrapWithSandbox,
  buildSeatbeltProfile,
  resolveSandboxPolicy,
} from "./sandbox.js";
export { createBrowserTool, formatReport, type BrowserToolOptions } from "./browser.js";

/**
 * 未信任工作区在非交互/高权限启动模式下的 fail-closed 工具面。
 * 这些工具没有外部副作用，因此 plan 模式无需等待不存在的授权 UI。
 */
export const RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES = ["read", "glob", "grep"] as const;

/**
 * 未信任工作区在交互式 default 模式下可用的、逐项审计过的内置开发工具面。
 * 刻意排除 WebFetch、browser、MCP、skill/task 与任何宿主注入工具。
 */
export const RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES = [
  ...RESTRICTED_WORKSPACE_READ_ONLY_TOOL_NAMES,
  "write",
  "edit",
  "apply_patch",
  "bash",
  "bash_output",
  "write_stdin",
  "list_shells",
  "kill_shell",
  "todo_write",
] as const;

function withoutNetworkParameter(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = parameters["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return { ...parameters };
  }
  const restrictedProperties = { ...(properties as Record<string, unknown>) };
  delete restrictedProperties["network"];
  return { ...parameters, properties: restrictedProperties };
}

function forceNetworkDisabled(runtime: ExecutionRuntime): ExecutionRuntime {
  return {
    run: (request) => runtime.run({ ...request, network: false }),
    ...(runtime.prepare
      ? { prepare: (request) => runtime.prepare!({ ...request, network: false }) }
      : {}),
  };
}

// Local fallback is deliberately fail-closed: if the host cannot enforce its OS sandbox,
// restricted bash fails instead of silently spawning an unrestricted process.
const restrictedLocalRuntime = new IsolatedRuntime({ failClosed: true, requireProxy: true });

/**
 * Restricted bash never exposes or honors a model-supplied network request. The runtime adapter
 * enforces the invariant again at the execution boundary, including background shells.
 */
export const restrictedWorkspaceBashTool: Tool = {
  ...bashTool,
  def: {
    ...bashTool.def,
    parameters: withoutNetworkParameter(bashTool.def.parameters),
  },
  run(input, ctx) {
    const runtime = forceNetworkDisabled(ctx.isolatedRuntime ?? restrictedLocalRuntime);
    return bashTool.run(
      { ...input, network: false },
      { ...ctx, sandbox: "workspace-write", isolatedRuntime: runtime },
    );
  },
};

/**
 * 默认工具集：Read/Write/Edit/ApplyPatch/Glob/Grep/Bash/BashOutput/KillShell/WebFetch/TodoWrite
 * （todo 有状态，每次新建）
 */
export function defaultTools(): ToolRegistry {
  return new ToolRegistry()
    .register(readTool)
    .register(writeTool)
    .register(editTool)
    .register(applyPatchTool)
    .register(globTool)
    .register(grepTool)
    .register(bashTool)
    .register(bashOutputTool)
    .register(killShellTool)
    .register(writeStdinTool)
    .register(listShellsTool)
    .register(webFetchTool)
    .register(createTodoTool());
}

/** 为交互式未信任工作区创建隔离的、有状态工具注册表。 */
export function restrictedWorkspaceDevelopmentTools(): ToolRegistry {
  const tools = defaultTools().subset([...RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES]);
  tools.register(restrictedWorkspaceBashTool);
  return tools;
}
