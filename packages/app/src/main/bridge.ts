/**
 * IPC 桥：把主进程里的 core（SessionManager）暴露成 window.anicode。
 *
 * 与 daemon/server.ts 同构 —— 都是 SessionHost 的一种传输实现。这里额外承载
 * provider/模型目录查询与插件市场状态的读写。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { IpcMain, WebContents } from "electron";
import {
  SessionManager,
  SessionStore,
  createProvider,
  diagnoseProvider,
  listModelCatalog,
  listProviderDetails,
  probeLocalProviders,
  t,
  type OpenHandle,
  type PermissionDecisionKind,
} from "@anicode/core";
import { applyPluginToggle, PLUGIN_CATALOG, type PluginEntry } from "../shared/plugins.js";
import type { AppInfo, ModelRow, UserModel } from "../shared/api.js";
import { PluginRuntime, type McpConnector } from "./plugin-runtime.js";

export interface BridgeOptions {
  cwd: string;
  sessionsDir: string;
  pluginsFile: string;
  /** 用户自定义模型的持久化文件。 */
  modelsFile: string;
  appName: string;
  appVersion: string;
  /** 可注入的 MCP 连接器与环境（测试用）；默认走 core 的真实实现与 process.env。 */
  mcpConnector?: McpConnector;
  env?: NodeJS.ProcessEnv;
}

/** 本地资源解析：debug/本地 provider 免 key；云端缺 key 时给出清晰错误。 */
function resolveConfiguredProvider(model: string) {
  const diagnostics = diagnoseProvider(model);
  if (diagnostics.requiresApiKey && !diagnostics.hasCredentials) {
    throw new Error(
      t(
        `${diagnostics.warnings.join("；")}. You can configure the key in settings, or switch to a key-free model like debug/demo.`,
        `${diagnostics.warnings.join("；")}。可在设置里配置密钥，或改用 debug/demo 等免 key 模型。`,
      ),
    );
  }
  return createProvider(model);
}

const EVENT_CHANNEL = "anicode:event";

export class Bridge {
  private readonly manager: SessionManager;
  private readonly plugins: PluginRuntime;
  /** subId → 订阅句柄与目标 webContents，open 时建立，close/销毁时释放。 */
  private readonly subscriptions = new Map<string, { handle: OpenHandle; sender: WebContents }>();

  constructor(private readonly options: BridgeOptions) {
    this.plugins = new PluginRuntime(options.mcpConnector, options.env);
    this.manager = new SessionManager({
      store: new SessionStore(options.sessionsDir),
      resolveProvider: resolveConfiguredProvider,
      compaction: true,
      permission: { mode: "default" },
      skills: true,
      subagents: true,
      smallModel: true, // 摘要等杂活自动走便宜模型
      // 每次新建会话都据当前插件状态构建工具集：停用的内建工具移除、启用的 MCP 工具注入。
      tools: () => this.plugins.buildToolRegistry(),
    });
  }

  /** 启动时读取已保存的插件状态并连接已启用的 MCP，需在处理请求前调用。 */
  async init(): Promise<void> {
    await this.plugins.setState(await this.readSavedPlugins());
  }

  register(ipcMain: IpcMain): void {
    ipcMain.handle("app:info", (): AppInfo => this.appInfo());

    ipcMain.handle("host:listSessions", () => this.manager.listSessions());
    ipcMain.handle(
      "host:createSession",
      (_e, input: { cwd: string; model: string; title?: string }) =>
        this.manager.createSession(input),
    );
    ipcMain.handle("host:send", (_e, sessionId: string, text: string) =>
      this.manager.send(sessionId, text),
    );
    ipcMain.handle("host:interrupt", (_e, sessionId: string) => this.manager.interrupt(sessionId));
    ipcMain.handle("host:setTitle", (_e, sessionId: string, title: string) =>
      this.manager.setTitle(sessionId, title),
    );
    ipcMain.handle("host:deleteSession", (_e, sessionId: string) =>
      this.manager.deleteSession(sessionId),
    );
    ipcMain.handle(
      "host:answerPermission",
      (_e, sessionId: string, permId: string, decision: PermissionDecisionKind) =>
        this.manager.answerPermission(sessionId, permId, decision),
    );

    ipcMain.handle("host:open", async (event, sessionId: string) => {
      const subId = randomUUID();
      const sender = event.sender;
      const handle = await this.manager.open(sessionId, (ev) => {
        if (sender.isDestroyed()) return;
        sender.send(EVENT_CHANNEL, { subId, event: ev });
      });
      this.subscriptions.set(subId, { handle, sender });
      // 渲染进程窗口销毁时，主动回收其所有订阅，避免向已销毁 sender 推事件。
      sender.once("destroyed", () => this.closeSubscription(subId));
      return { subId, snapshot: handle.snapshot };
    });
    ipcMain.handle("host:close", (_e, subId: string) => {
      this.closeSubscription(subId);
    });

    ipcMain.handle("meta:catalog", () => this.catalogRows());
    ipcMain.handle("meta:providers", () => listProviderDetails());
    ipcMain.handle("meta:userModels", () => this.readUserModels());
    ipcMain.handle("meta:addUserModel", (_e, model: UserModel) => this.addUserModel(model));
    ipcMain.handle("meta:removeUserModel", (_e, spec: string) => this.removeUserModel(spec));

    ipcMain.handle("plugins:list", () => this.listPlugins());
    ipcMain.handle("plugins:setEnabled", (_e, id: string, enabled: boolean) =>
      this.setPluginEnabled(id, enabled),
    );
  }

  /** 主进程能读 env，这里算好每个模型的凭证就绪状态再下发给渲染进程；含内置目录 + 用户自定义。 */
  private async catalogRows(): Promise<ModelRow[]> {
    // 本地 provider「免 key」不等于「在跑」；探测存活，避免把连不上的本地模型标成就绪。
    const details = listProviderDetails();
    const probed = new Set(
      details.filter((d) => d.local && (d.baseURL || d.baseURLEnv)).map((d) => d.id),
    );
    const live = await probeLocalProviders(details);
    const status = { probed, live };
    const builtin: ModelRow[] = listModelCatalog().map((entry) =>
      this.toRow(entry, "builtin", status),
    );
    const userRows = (await this.readUserModels()).flatMap((m) => {
      const row = this.userModelToRow(m, status);
      return row ? [row] : [];
    });
    // 用户自定义排在前面，便于快速切到自己常用的调试模型。
    return [...userRows, ...builtin];
  }

  private toRow(
    entry: {
      spec: string;
      local: boolean;
      requiresApiKey: boolean;
      label?: string;
      model: string;
      providerId: string;
      providerName: string;
      free?: boolean;
      openWeight?: boolean;
      recommended?: boolean;
      note?: string;
    },
    source: "builtin" | "user",
    status: { probed: Set<string>; live: Set<string> },
  ): ModelRow {
    const d = diagnoseProvider(entry.spec);
    let ready: boolean | undefined;
    let readyHint: string;
    if (status.probed.has(entry.providerId)) {
      // 有本地端点的 provider：以存活探测为准，别被「免 key」误导。
      ready = status.live.has(entry.providerId);
      readyHint = ready
        ? t(`${entry.providerName} ready`, `${entry.providerName} 已就绪`)
        : t(`Start ${entry.providerName} first`, `需先启动 ${entry.providerName}`);
    } else if (!d.requiresApiKey) {
      ready = true;
      readyHint = entry.local ? t("Local / key-free", "本地 / 免 key") : t("Key-free", "免 key");
    } else {
      ready = d.hasCredentials;
      readyHint = d.hasCredentials
        ? t(
            `${d.credentialEnv ?? t("credential", "凭证")} configured`,
            `${d.credentialEnv ?? t("credential", "凭证")} 已配置`,
          )
        : t(
            `Missing ${d.apiKeyEnv.join(" / ") || "API key"}`,
            `缺 ${d.apiKeyEnv.join(" / ") || "API key"}`,
          );
    }
    return { ...entry, ready, readyHint, source };
  }

  /** 把用户模型解析成目录行；provider 不存在则丢弃（返回 null）。 */
  private userModelToRow(
    m: UserModel,
    status: { probed: Set<string>; live: Set<string> },
  ): ModelRow | null {
    const descriptor = listProviderDetails().find((p) => p.id === m.provider);
    if (!descriptor) return null;
    return this.toRow(
      {
        spec: `${m.provider}/${m.model}`,
        model: m.model,
        providerId: m.provider,
        providerName: descriptor.name,
        local: descriptor.local,
        requiresApiKey: descriptor.requiresApiKey,
        ...(m.label ? { label: m.label } : {}),
        ...(m.free !== undefined ? { free: m.free } : {}),
        ...(m.openWeight !== undefined ? { openWeight: m.openWeight } : {}),
        ...(m.note ? { note: m.note } : {}),
      },
      "user",
      status,
    );
  }

  private async readUserModels(): Promise<UserModel[]> {
    try {
      const raw = await fs.readFile(this.options.modelsFile, "utf8");
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed?.models;
      if (!Array.isArray(list)) return [];
      return list.filter(
        (m): m is UserModel =>
          m &&
          typeof m.provider === "string" &&
          typeof m.model === "string" &&
          m.provider !== "" &&
          m.model !== "",
      );
    } catch {
      return [];
    }
  }

  private async writeUserModels(models: UserModel[]): Promise<void> {
    await fs.mkdir(path.dirname(this.options.modelsFile), { recursive: true });
    await fs.writeFile(this.options.modelsFile, JSON.stringify({ models }, null, 2), "utf8");
  }

  private async addUserModel(model: UserModel): Promise<ModelRow[]> {
    const provider = model.provider?.trim();
    const id = model.model?.trim();
    if (!provider || !id)
      throw new Error(t("provider and model must not be empty", "provider 与 model 均不能为空"));
    if (!listProviderDetails().some((p) => p.id === provider)) {
      throw new Error(
        t(
          `Unknown provider "${provider}", please pick an existing provider first`,
          `未知 provider "${provider}"，请先选择已有 provider`,
        ),
      );
    }
    const spec = `${provider}/${id}`;
    const existing = await this.readUserModels();
    const next = [
      { ...model, provider, model: id },
      ...existing.filter((m) => `${m.provider}/${m.model}` !== spec),
    ];
    await this.writeUserModels(next);
    return this.catalogRows();
  }

  private async removeUserModel(spec: string): Promise<ModelRow[]> {
    const existing = await this.readUserModels();
    await this.writeUserModels(existing.filter((m) => `${m.provider}/${m.model}` !== spec));
    return this.catalogRows();
  }

  private appInfo(): AppInfo {
    return {
      name: this.options.appName,
      version: this.options.appVersion,
      cwd: this.options.cwd,
      sessionsDir: this.options.sessionsDir,
      inspectProviderCredentials: true,
    };
  }

  private closeSubscription(subId: string): void {
    const sub = this.subscriptions.get(subId);
    if (!sub) return;
    this.subscriptions.delete(subId);
    sub.handle.close();
  }

  private async readSavedPlugins(): Promise<string[]> {
    try {
      const raw = await fs.readFile(this.options.pluginsFile, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  }

  private listPlugins(): PluginEntry[] {
    return this.plugins.entriesWithStatus();
  }

  private async setPluginEnabled(id: string, enabled: boolean): Promise<PluginEntry[]> {
    const manifest = PLUGIN_CATALOG.find((p) => p.id === id);
    if (!manifest) throw new Error(t(`Unknown plugin: ${id}`, `未知插件: ${id}`));
    const saved = await this.readSavedPlugins();
    const next = applyPluginToggle(saved, id, enabled, Boolean(manifest.builtin));
    await fs.mkdir(path.dirname(this.options.pluginsFile), { recursive: true });
    await fs.writeFile(this.options.pluginsFile, JSON.stringify(next, null, 2), "utf8");
    // reconcile：连接新启用的 MCP / 断开停用的；工具集变化对新建会话生效。
    await this.plugins.setState(next);
    return this.plugins.entriesWithStatus();
  }

  dispose(): void {
    for (const subId of [...this.subscriptions.keys()]) this.closeSubscription(subId);
    this.plugins.dispose();
    this.manager.dispose();
  }
}
