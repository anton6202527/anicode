import { IsolatedRuntime, type ExecutionRuntime } from "../runtime/isolated-runtime.js";
import { t } from "../i18n.js";
import { ToolRegistry, type Tool, type ToolCapability } from "./tool.js";
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
export { createWebFetchTool, webFetchTool, htmlToText } from "./webfetch.js";
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

/** Arbitrary or persistent host-process surfaces removed when native isolation is unavailable. */
export const LOCAL_PROCESS_TOOL_NAMES = [
  "bash",
  "bash_output",
  "write_stdin",
  "list_shells",
  "kill_shell",
  "diagnostics",
  "definition",
  "references",
  "symbols",
  "browser",
] as const;

/** Process surfaces that an ephemeral OCI execution cannot keep alive between tool calls. */
export const PERSISTENT_PROCESS_TOOL_NAMES = [
  "bash_output",
  "write_stdin",
  "list_shells",
  "kill_shell",
  "diagnostics",
  "definition",
  "references",
  "symbols",
  "browser",
] as const;

function withCapabilities(tool: Tool, capabilities: readonly ToolCapability[]): Tool {
  return {
    ...tool,
    capabilities,
    ...(tool.fork ? { fork: () => withCapabilities(tool.fork!(), capabilities) } : {}),
  };
}

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

function withoutBackgroundParameter(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = parameters["properties"];
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    return { ...parameters };
  }
  const foregroundProperties = { ...(properties as Record<string, unknown>) };
  delete foregroundProperties["run_in_background"];
  return { ...parameters, properties: foregroundProperties };
}

/** Foreground-only shell facade for ephemeral OCI runtimes (which intentionally lack prepare()). */
export function foregroundOnlyBash(tool: Tool = bashTool): Tool {
  return {
    ...tool,
    // OCI execution is foreground-only, not read-only: redirects, generators and formatters can
    // still mutate the mounted workspace and therefore must trigger dirty verification.
    capabilities: ["process", "filesystem-write"],
    def: {
      ...tool.def,
      description: t(
        "Run a foreground shell command inside the pinned OCI runtime. Background processes are unavailable because each execution is ephemeral.",
        "在固定摘要的 OCI 运行时中执行前台 shell 命令。每次执行都是临时容器，因此不支持后台进程。",
      ),
      parameters: withoutBackgroundParameter(tool.def.parameters),
    },
    run(input, ctx) {
      const foregroundInput = { ...input };
      delete foregroundInput["run_in_background"];
      return tool.run(foregroundInput, ctx);
    },
  };
}

export const foregroundOnlyBashTool: Tool = foregroundOnlyBash();

// Local fallback is deliberately fail-closed: if the host cannot enforce its OS sandbox,
// restricted bash fails instead of silently spawning an unrestricted process.
const restrictedLocalRuntime = new IsolatedRuntime({ failClosed: true, requireProxy: true });

/**
 * Restricted bash never exposes or honors a model-supplied network request. The runtime adapter
 * enforces the invariant again at the execution boundary, including background shells.
 */
export const restrictedWorkspaceBashTool: Tool = {
  ...bashTool,
  capabilities: ["process", "filesystem-write"],
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
    .register(withCapabilities(readTool, ["filesystem-read"]))
    .register(withCapabilities(writeTool, ["filesystem-write"]))
    .register(withCapabilities(editTool, ["filesystem-write"]))
    .register(withCapabilities(applyPatchTool, ["filesystem-write"]))
    .register(withCapabilities(globTool, ["filesystem-read"]))
    .register(withCapabilities(grepTool, ["filesystem-read"]))
    .register(withCapabilities(bashTool, ["process", "filesystem-write"]))
    .register(withCapabilities(bashOutputTool, ["persistent-process"]))
    .register(withCapabilities(killShellTool, ["persistent-process"]))
    .register(withCapabilities(writeStdinTool, ["persistent-process"]))
    .register(withCapabilities(listShellsTool, ["persistent-process"]))
    .register(withCapabilities(webFetchTool, ["network"]))
    .register(withCapabilities(createTodoTool(), ["memory"]));
}

/** 为交互式未信任工作区创建隔离的、有状态工具注册表。 */
export function restrictedWorkspaceDevelopmentTools(): ToolRegistry {
  const tools = defaultTools().subset([...RESTRICTED_WORKSPACE_DEVELOPMENT_TOOL_NAMES]);
  tools.register(restrictedWorkspaceBashTool);
  return tools;
}
