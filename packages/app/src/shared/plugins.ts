/**
 * 插件市场的数据模型与内置目录。
 *
 * anicode 的「插件」统一抽象为可挂到 agent 上的能力来源：MCP server、skill、内建工具组。
 * 本文件只描述目录与状态；实际把启用的插件接进 SessionManager 的工具链是后续工作
 * （见 main/bridge.ts 里的 TODO）。市场 UI 现在负责浏览、启用/停用并持久化选择。
 */

export type PluginCategory = "mcp" | "skill" | "tool";

/** MCP 类插件的 stdio 启动配置（对齐 core 的 McpServerConfig）。 */
export interface McpServerSpec {
  /** 工具前缀名，工具以 `<name>__<tool>` 暴露。 */
  name: string;
  command: string;
  args: readonly string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  description: string;
  category: PluginCategory;
  author: string;
  /** 展示用 emoji 图标。 */
  icon: string;
  version: string;
  homepage?: string;
  /** tool 类插件拥有的 core 内置工具名；停用时从工具集移除这些工具。 */
  toolNames?: readonly string[];
  /** mcp 类插件的 server 启动配置；启用且凭证就绪时连接并注入其工具。 */
  mcpServer?: McpServerSpec;
  /** 需要的环境变量名（不含值）；缺失时 MCP 插件不会连接。 */
  requiresEnv?: readonly string[];
  /** 官方内建、随附即用。 */
  builtin?: boolean;
}

/** 插件运行时状态（MCP 连接结果），由主进程算出后随 PluginEntry 下发。 */
export interface PluginRuntimeStatus {
  connected: boolean;
  error?: string;
  toolCount?: number;
}

export interface PluginEntry extends PluginManifest {
  enabled: boolean;
  /** 仅 MCP 插件在启用后带上；展示连接/报错状态。 */
  runtime?: PluginRuntimeStatus;
}

/**
 * 内置市场目录。builtin 插件默认启用；其余默认停用，用户在市场里开关。
 * 这些条目对应 core 已有或计划中的能力来源，命名对齐主流 MCP 生态。
 */
export const PLUGIN_CATALOG: readonly PluginManifest[] = [
  {
    id: "core.filesystem",
    name: "文件工具",
    description: "读写、检索工作区文件（read / write / edit / glob / grep），带沙箱与权限确认。",
    category: "tool",
    author: "anicode",
    icon: "📁",
    version: "1.0.0",
    builtin: true,
    toolNames: ["read", "write", "edit", "glob", "grep"],
  },
  {
    id: "core.bash",
    name: "Bash 终端",
    description: "在工作目录执行 shell 命令，受权限规则约束。",
    category: "tool",
    author: "anicode",
    icon: "⌨️",
    version: "1.0.0",
    builtin: true,
    toolNames: ["bash"],
  },
  {
    id: "core.todo",
    name: "任务清单",
    description: "让 agent 维护结构化 todo，界面实时展示进度。",
    category: "tool",
    author: "anicode",
    icon: "✅",
    version: "1.0.0",
    builtin: true,
    toolNames: ["todo_write"],
  },
  {
    id: "mcp.websearch",
    name: "Web 搜索",
    description: "通过 MCP 联网检索与抓取网页，为回答补充实时信息。",
    category: "mcp",
    author: "community",
    icon: "🔎",
    version: "0.3.0",
    mcpServer: { name: "websearch", command: "npx", args: ["-y", "@modelcontextprotocol/server-web-search"] },
    requiresEnv: ["BRAVE_API_KEY"],
    homepage: "https://modelcontextprotocol.io",
  },
  {
    id: "mcp.github",
    name: "GitHub",
    description: "读写 issue / PR、检索仓库、管理分支的 GitHub MCP server。",
    category: "mcp",
    author: "github",
    icon: "🐙",
    version: "0.6.0",
    mcpServer: { name: "github", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
    requiresEnv: ["GITHUB_TOKEN"],
    homepage: "https://github.com/github/github-mcp-server",
  },
  {
    id: "mcp.playwright",
    name: "Playwright 浏览器",
    description: "驱动真实浏览器做点击、填表、截图与端到端验证。",
    category: "mcp",
    author: "microsoft",
    icon: "🎭",
    version: "0.2.0",
    mcpServer: { name: "playwright", command: "npx", args: ["-y", "@playwright/mcp"] },
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "skill.pdf",
    name: "PDF 阅读",
    description: "解析 PDF 文本与表格，支持长文档分页读取的 skill。",
    category: "skill",
    author: "community",
    icon: "📄",
    version: "1.1.0",
  },
  {
    id: "skill.dataviz",
    name: "数据可视化",
    description: "生成图表与仪表盘的设计指引与代码 skill。",
    category: "skill",
    author: "anicode",
    icon: "📊",
    version: "1.0.0",
  },
];

/** 依据内置目录 + 已保存的开关状态，合成完整的插件条目列表。 */
export function mergePluginState(enabledIds: readonly string[]): PluginEntry[] {
  const enabled = new Set(enabledIds);
  return PLUGIN_CATALOG.map((manifest) => ({
    ...manifest,
    // builtin 未被显式关闭时默认启用；其余以保存的状态为准。
    enabled: manifest.builtin ? !enabled.has(`!${manifest.id}`) : enabled.has(manifest.id),
  }));
}

/**
 * 把一次开关操作应用到「已保存状态」数组上并返回新数组。
 * 约定：非 builtin 插件用其 id 记录「已启用」；builtin 插件用 `!id` 记录「已停用」。
 */
export function applyPluginToggle(
  saved: readonly string[],
  id: string,
  enabled: boolean,
  builtin: boolean,
): string[] {
  const set = new Set(saved);
  if (builtin) {
    if (enabled) set.delete(`!${id}`);
    else set.add(`!${id}`);
  } else {
    if (enabled) set.add(id);
    else set.delete(id);
  }
  return [...set];
}
