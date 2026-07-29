/**
 * 插件市场的数据模型与内置目录。
 *
 * anicode 的「插件」统一抽象为可挂到 agent 上的能力来源：MCP server、skill、内建工具组。
 * 本文件描述目录与状态；主进程的 PluginRuntime 会把启用项接进 SessionManager：
 * 内建工具可按组移除，MCP 服务会连接并把工具注入新会话。
 */

import { t } from "@anicode/core/i18n";
import type { SkillMeta } from "@anicode/core";

export type PluginCategory = "mcp" | "skill" | "tool";

/** MCP 类插件的 stdio 启动配置（对齐 core 的 McpServerConfig）。 */
export interface McpServerSpec {
  /** 工具前缀名，工具以 `<name>__<tool>` 暴露。 */
  name: string;
  command: string;
  args: readonly string[];
  /** 需要联网时必须由隔离运行时强制经过 AniCode Network Proxy。 */
  network?: boolean;
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
  /** skill 类插件运行所需的可执行文件（frontmatter metadata.requires.bins）。 */
  requiresBins?: readonly string[];
  /** skill 依赖是否就绪（requiresBins 全在 PATH 上）；文件系统技能才有意义。 */
  available?: boolean;
  /** 来源：内置目录 vs 文件系统自动发现。 */
  source?: "builtin" | "filesystem";
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
    name: t("File tools", "文件工具"),
    description: t(
      "Read, write, and search workspace files (read / write / edit / glob / grep), with sandbox and permission confirmation.",
      "读写、检索工作区文件（read / write / edit / glob / grep），带沙箱与权限确认。",
    ),
    category: "tool",
    author: "AniCode Zen",
    icon: "📁",
    version: "1.0.0",
    builtin: true,
    toolNames: ["read", "write", "edit", "glob", "grep"],
  },
  {
    id: "core.bash",
    name: t("Bash terminal", "Bash 终端"),
    description: t(
      "Run shell commands in the working directory, constrained by permission rules.",
      "在工作目录执行 shell 命令，受权限规则约束。",
    ),
    category: "tool",
    author: "AniCode Zen",
    icon: "⌨️",
    version: "1.0.0",
    builtin: true,
    toolNames: ["bash"],
  },
  {
    id: "core.todo",
    name: t("Task list", "任务清单"),
    description: t(
      "Let the agent maintain a structured todo; the UI shows progress in real time.",
      "让 agent 维护结构化 todo，界面实时展示进度。",
    ),
    category: "tool",
    author: "AniCode Zen",
    icon: "✅",
    version: "1.0.0",
    builtin: true,
    toolNames: ["todo_write"],
  },
  {
    id: "mcp.websearch",
    name: t("Web search", "Web 搜索"),
    description: t(
      "Search and fetch web pages over MCP to enrich answers with real-time information.",
      "通过 MCP 联网检索与抓取网页，为回答补充实时信息。",
    ),
    category: "mcp",
    author: "community",
    icon: "🔎",
    version: "0.3.0",
    mcpServer: {
      name: "websearch",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-web-search"],
      network: true,
    },
    requiresEnv: ["BRAVE_API_KEY"],
    homepage: "https://modelcontextprotocol.io",
  },
  {
    id: "mcp.github",
    name: "GitHub",
    description: t(
      "GitHub MCP server for reading/writing issues / PRs, searching repositories, and managing branches.",
      "读写 issue / PR、检索仓库、管理分支的 GitHub MCP server。",
    ),
    category: "mcp",
    author: "github",
    icon: "🐙",
    version: "0.6.0",
    mcpServer: {
      name: "github",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      network: true,
    },
    requiresEnv: ["GITHUB_TOKEN"],
    homepage: "https://github.com/github/github-mcp-server",
  },
  {
    id: "mcp.playwright",
    name: t("Playwright browser", "Playwright 浏览器"),
    description: t(
      "Drive a real browser to click, fill forms, screenshot, and run end-to-end verification.",
      "驱动真实浏览器做点击、填表、截图与端到端验证。",
    ),
    category: "mcp",
    author: "microsoft",
    icon: "🎭",
    version: "0.2.0",
    mcpServer: {
      name: "playwright",
      command: "npx",
      args: ["-y", "@playwright/mcp"],
      network: true,
    },
    homepage: "https://github.com/microsoft/playwright-mcp",
  },
  {
    id: "skill.pdf",
    name: t("PDF reader", "PDF 阅读"),
    description: t(
      "A skill that parses PDF text and tables, with paginated reading for long documents.",
      "解析 PDF 文本与表格，支持长文档分页读取的 skill。",
    ),
    category: "skill",
    author: "community",
    icon: "📄",
    version: "1.1.0",
  },
  {
    id: "skill.dataviz",
    name: t("Data visualization", "数据可视化"),
    description: t(
      "A skill with design guidance and code for generating charts and dashboards.",
      "生成图表与仪表盘的设计指引与代码 skill。",
    ),
    category: "skill",
    author: "AniCode Zen",
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

/** 文件系统自动发现的技能对应的插件 id。 */
export function skillPluginId(name: string): string {
  return `skill.fs.${name}`;
}

/**
 * 把 core 发现的文件系统技能投影成市场条目。
 * 语义同 builtin：默认启用（自动加载），用户可显式关闭（保存为 `!id`）。
 * icon 用可用性区分，description 已由 core 截断。
 */
export function mergeSkillState(
  enabledIds: readonly string[],
  skills: readonly SkillMeta[],
): PluginEntry[] {
  const saved = new Set(enabledIds);
  return skills.map((skill) => {
    const id = skillPluginId(skill.name);
    const available = skill.available !== false;
    return {
      id,
      name: skill.name,
      description: skill.description || t("(no description)", "（无描述）"),
      category: "skill" as const,
      author: t("Filesystem skill", "文件系统技能"),
      icon: available ? "🧩" : "⚠️",
      version: "—",
      source: "filesystem" as const,
      builtin: true, // 默认启用，可显式关闭
      available,
      ...(skill.requiresBins ? { requiresBins: skill.requiresBins } : {}),
      enabled: !saved.has(`!${id}`),
    };
  });
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
