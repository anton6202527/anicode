/**
 * PluginRuntime —— 把「启用的插件」翻译成 agent 真正拿到的工具集。
 *
 * - tool 类插件：停用时从默认工具集里移除其拥有的内置工具。
 * - mcp 类插件：启用且所需环境变量就绪时，连接 MCP server 并把它的工具注入工具集；
 *   停用时断开。连接是异步且可能失败的，因此和「同步构建工具集」分开：
 *   reconcile() 负责维护 MCP 连接，buildToolRegistry() 只读当前已连接结果，供
 *   SessionManager 的 tools 工厂在每次新建会话时同步调用。
 *
 * connect 依赖可注入，便于离线测试（真实实现用 core 的 connectMcpServers）。
 */

import {
  connectMcpServers,
  defaultTools,
  t,
  type McpClient,
  type McpServerConfig,
  type Tool,
  type ToolRegistry,
} from "@anicode/core";
import { mergePluginState, type PluginEntry, type PluginRuntimeStatus } from "../shared/plugins.js";

export type McpConnector = (
  configs: McpServerConfig[],
) => Promise<{ tools: Tool[]; clients: McpClient[] }>;

interface Connection {
  clients: McpClient[];
  tools: Tool[];
}

export class PluginRuntime {
  private savedIds: string[] = [];
  private readonly connections = new Map<string, Connection>();
  private readonly status = new Map<string, PluginRuntimeStatus>();

  constructor(
    private readonly connect: McpConnector = connectMcpServers,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /** 更新已保存状态并 reconcile MCP 连接（连接新启用的、断开已停用的）。 */
  async setState(savedIds: readonly string[]): Promise<void> {
    this.savedIds = [...savedIds];
    await this.reconcile();
  }

  private entries(): PluginEntry[] {
    return mergePluginState(this.savedIds);
  }

  private async reconcile(): Promise<void> {
    const entries = this.entries();
    const enabledMcp = entries.filter((e) => e.enabled && e.mcpServer);
    const enabledIds = new Set(enabledMcp.map((e) => e.id));

    // 断开不再启用的 MCP。
    for (const [id, conn] of [...this.connections]) {
      if (!enabledIds.has(id)) {
        conn.clients.forEach((c) => c.close());
        this.connections.delete(id);
        this.status.delete(id);
      }
    }

    // 连接新启用的 MCP（凭证就绪才连）。
    for (const entry of enabledMcp) {
      if (this.connections.has(entry.id)) continue;
      const missing = (entry.requiresEnv ?? []).filter((name) => !this.env[name]?.trim());
      if (missing.length > 0) {
        this.status.set(entry.id, {
          connected: false,
          error: t(
            `Missing environment variable ${missing.join(", ")}`,
            `缺少环境变量 ${missing.join(", ")}`,
          ),
        });
        continue;
      }
      const spec = entry.mcpServer!;
      try {
        const { tools, clients } = await this.connect([
          { name: spec.name, command: spec.command, args: [...spec.args] },
        ]);
        this.connections.set(entry.id, { clients, tools });
        this.status.set(entry.id, { connected: true, toolCount: tools.length });
      } catch (err) {
        this.status.set(entry.id, { connected: false, error: errorText(err) });
      }
    }
  }

  /**
   * 同步构建当前工具集：默认工具去掉被停用的内建工具组，再叠加已连接的 MCP 工具。
   * SessionManager 每次新建会话都会调用它，因此新会话总是拿到最新插件状态。
   */
  buildToolRegistry(): ToolRegistry {
    const entries = this.entries();
    const disabled = new Set<string>();
    for (const entry of entries) {
      if (!entry.enabled && entry.toolNames) for (const name of entry.toolNames) disabled.add(name);
    }
    const base = defaultTools();
    const registry = base.subset(base.names().filter((name) => !disabled.has(name)));
    for (const conn of this.connections.values()) {
      for (const tool of conn.tools) registry.register(tool);
    }
    return registry;
  }

  /** 把运行时状态并入插件条目，供市场 UI 展示连接/报错。 */
  entriesWithStatus(): PluginEntry[] {
    return this.entries().map((entry) => {
      const status = this.status.get(entry.id);
      return status ? { ...entry, runtime: status } : entry;
    });
  }

  dispose(): void {
    for (const conn of this.connections.values()) conn.clients.forEach((c) => c.close());
    this.connections.clear();
    this.status.clear();
  }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
