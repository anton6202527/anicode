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
  discoverSkills,
  t,
  type McpClient,
  type McpServerConfig,
  type SkillMeta,
  type Tool,
  type ToolRegistry,
  type CredentialBroker,
  isCredentialEnvironmentName,
} from "@anicode/core";
import {
  mergePluginState,
  mergeSkillState,
  type PluginEntry,
  type PluginRuntimeStatus,
} from "../shared/plugins.js";

export type McpConnector = (
  configs: McpServerConfig[],
  handlers?: NonNullable<Parameters<typeof connectMcpServers>[1]>,
) => Promise<{ tools: Tool[]; clients: McpClient[] }>;

interface Connection {
  clients: McpClient[];
  tools: Tool[];
}

export class PluginRuntime {
  private savedIds: string[] = [];
  private skills: SkillMeta[] = [];
  private readonly connections = new Map<string, Connection>();
  private readonly status = new Map<string, PluginRuntimeStatus>();
  private suspended = false;

  constructor(
    private readonly connect: McpConnector = connectMcpServers,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly broker?: CredentialBroker,
    private readonly connectHandlers?: NonNullable<Parameters<typeof connectMcpServers>[1]>,
  ) {}

  /** 扫描文件系统技能（全局 + 项目级），供市场展示与开关；失败静默保持空表。 */
  async refreshSkills(cwd: string): Promise<void> {
    try {
      this.skills = await discoverSkills(cwd);
    } catch {
      this.skills = [];
    }
  }

  /** 被用户显式关闭的文件系统技能名（供 agent 的 skills.disabled 排除）。 */
  disabledSkillNames(): string[] {
    return mergeSkillState(this.savedIds, this.skills)
      .filter((e) => !e.enabled)
      .map((e) => e.name);
  }

  /** 更新已保存状态并 reconcile MCP 连接（连接新启用的、断开已停用的）。 */
  async setState(savedIds: readonly string[]): Promise<void> {
    this.savedIds = [...savedIds];
    await this.reconcile();
  }

  /** Trust revocation closes every process/network sidecar before a restricted Agent is rebuilt. */
  async setSuspended(suspended: boolean): Promise<void> {
    if (this.suspended === suspended) return;
    this.suspended = suspended;
    await this.reconcile();
  }

  private entries(): PluginEntry[] {
    return [...mergePluginState(this.savedIds), ...mergeSkillState(this.savedIds, this.skills)];
  }

  private async reconcile(): Promise<void> {
    if (this.suspended) {
      await Promise.allSettled(
        [...this.connections.values()].flatMap((conn) =>
          conn.clients.map((client) => client.close()),
        ),
      );
      this.connections.clear();
      this.status.clear();
      return;
    }
    const entries = this.entries();
    const enabledMcp = entries.filter((e) => e.enabled && e.mcpServer);
    const enabledIds = new Set(enabledMcp.map((e) => e.id));

    // 断开不再启用的 MCP。
    for (const [id, conn] of [...this.connections]) {
      if (!enabledIds.has(id)) {
        await Promise.allSettled(conn.clients.map((client) => client.close()));
        this.connections.delete(id);
        this.status.delete(id);
      }
    }

    // 连接新启用的 MCP（凭证就绪才连）。
    for (const entry of enabledMcp) {
      if (this.connections.has(entry.id)) continue;
      const missing = (entry.requiresEnv ?? []).filter((name) =>
        isCredentialEnvironmentName(name)
          ? !this.broker?.has(`env:${name}`)
          : !this.env[name]?.trim(),
      );
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
      if (!("url" in spec)) {
        // Native stdio children can detach into a new session outside killpg. Reject before the
        // connector gets any chance to spawn; HTTP remains the production plugin transport.
        this.status.set(entry.id, {
          connected: false,
          error: "stdio MCP requires managed cgroup/container/job-object containment",
        });
        continue;
      }
      try {
        const config: McpServerConfig = {
          ...spec,
          ...(spec.headers ? { headers: { ...spec.headers } } : {}),
        };
        const { tools, clients } = await this.connect([config], this.connectHandlers);
        if (
          tools.some(
            (tool) =>
              tool.execution?.kind === "managed-external" &&
              tool.execution.protocol === "mcp-stdio",
          )
        ) {
          const closed = await Promise.allSettled(clients.map((client) => client.close()));
          const failures = closed.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length > 0) {
            throw new AggregateError(
              failures,
              "Rejected stdio MCP connection and failed to close its clients",
            );
          }
          throw new Error("stdio MCP requires managed process containment");
        }
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
    for (const conn of this.suspended ? [] : this.connections.values()) {
      for (const tool of conn.tools) {
        if (
          tool.execution?.kind === "managed-external" &&
          tool.execution.protocol === "mcp-stdio"
        ) {
          throw new TypeError(
            `stdio MCP tool ${tool.def.name} requires managed process containment`,
          );
        }
        registry.registerExtension(tool);
      }
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

  async dispose(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.connections.values()].flatMap((conn) =>
        conn.clients.map((client) => client.close()),
      ),
    );
    this.connections.clear();
    this.status.clear();
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to close MCP plugin process trees");
    }
  }
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
