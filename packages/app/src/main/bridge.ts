/**
 * IPC 桥：把主进程里的 core（SessionManager）暴露成 window.anicode。
 *
 * 与 daemon/server.ts 同构 —— 都是 SessionHost 的一种传输实现。这里额外承载
 * provider/模型目录查询与插件市场状态的读写。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import {
  SessionManager,
  SessionStore,
  MigratingSessionStore,
  createProvider,
  diagnoseProvider,
  listModelCatalog,
  listProviderDetails,
  probeLocalProviders,
  resolveDefaultModel,
  createLocalRuntimeStack,
  ContextCompiler,
  Verifier,
  SecurityPolicyEngine,
  telemetryForLocalStack,
  t,
  type LocalRuntimeStack,
  type OpenHandle,
  type PermissionDecisionKind,
  type Telemetry,
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
  /** 项目配置指定的默认模型；缺省时按已配置凭证自动选择。 */
  defaultModel?: string;
  /** 可注入的 MCP 连接器与环境（测试用）；默认走 core 的真实实现与 process.env。 */
  mcpConnector?: McpConnector;
  env?: NodeJS.ProcessEnv;
  /** Main-frame allowlist owned by the BrowserWindow lifecycle. */
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string, maximum = 4_096): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new TypeError(`${label} must be a non-empty string of at most ${maximum} characters`);
  }
  return value;
}

function sessionId(value: unknown): string {
  const id = stringValue(value, "sessionId", 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) throw new TypeError("Invalid sessionId");
  return id;
}

function parseUserModel(value: unknown): UserModel {
  const input = record(value, "model");
  if (input["free"] !== undefined && typeof input["free"] !== "boolean") {
    throw new TypeError("model.free must be boolean");
  }
  if (input["openWeight"] !== undefined && typeof input["openWeight"] !== "boolean") {
    throw new TypeError("model.openWeight must be boolean");
  }
  return {
    provider: stringValue(input["provider"], "model.provider", 128),
    model: stringValue(input["model"], "model.model", 256),
    ...(input["label"] !== undefined
      ? { label: stringValue(input["label"], "model.label", 256) }
      : {}),
    ...(input["note"] !== undefined
      ? { note: stringValue(input["note"], "model.note", 1_024) }
      : {}),
    ...(typeof input["free"] === "boolean" ? { free: input["free"] } : {}),
    ...(typeof input["openWeight"] === "boolean" ? { openWeight: input["openWeight"] } : {}),
  };
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
  private readonly runtimeStack: LocalRuntimeStack;
  private readonly telemetry: Telemetry;
  private disposePromise: Promise<void> | undefined;
  /**
   * 被市场关闭的文件系统技能名。稳定引用传给 SessionManager 的 skills.disabled，
   * 开关时原地更新内容 —— 新建的会话在首次 send 读它，即时生效（已进行中的会话不受影响）。
   */
  private readonly disabledSkills: string[] = [];
  /** subId → 订阅句柄与目标 webContents，open 时建立，close/销毁时释放。 */
  private readonly subscriptions = new Map<string, { handle: OpenHandle; sender: WebContents }>();

  constructor(private readonly options: BridgeOptions) {
    const runtimeStack = createLocalRuntimeStack(
      path.dirname(options.sessionsDir),
      options.env ?? process.env,
    );
    const telemetry = telemetryForLocalStack(runtimeStack, options.env ?? process.env);
    this.runtimeStack = runtimeStack;
    this.telemetry = telemetry;
    this.plugins = new PluginRuntime(options.mcpConnector, options.env, runtimeStack.broker, {
      telemetry,
      networkProxy: runtimeStack.networkProxy,
      credentialBroker: runtimeStack.broker,
      executionRuntime: runtimeStack.isolatedRuntime,
    });
    this.manager = new SessionManager({
      store: new MigratingSessionStore(
        runtimeStack.sessions,
        new SessionStore(options.sessionsDir),
      ),
      runtime: runtimeStack.runtime,
      artifacts: runtimeStack.artifacts,
      commandInbox: runtimeStack.commandInbox,
      outbox: runtimeStack.outbox,
      networkProxy: runtimeStack.networkProxy,
      worktreeOwnership: runtimeStack.worktreeOwnership,
      contextCompiler: new ContextCompiler({ tokenBudget: 12_000 }),
      verifier: new Verifier({ autoDiscover: true }),
      securityPolicy: SecurityPolicyEngine.workspaceBoundary(),
      telemetry,
      isolatedRuntime: runtimeStack.isolatedRuntime,
      resolveProvider: resolveConfiguredProvider,
      compaction: true,
      permission: { mode: "default" },
      skills: { disabled: this.disabledSkills },
      subagents: true,
      smallModel: true, // 摘要等杂活自动走便宜模型
      // 每次新建会话都据当前插件状态构建工具集：停用的内建工具移除、启用的 MCP 工具注入。
      tools: () => this.plugins.buildToolRegistry(),
    });
  }

  /** 启动时发现文件系统技能、读取已保存的插件状态并连接已启用的 MCP，需在处理请求前调用。 */
  async init(): Promise<void> {
    await this.plugins.refreshSkills(this.options.cwd);
    await this.plugins.setState(await this.readSavedPlugins());
    this.syncDisabledSkills();
  }

  /** 把「被关闭的文件系统技能」同步进传给 agent 的稳定数组（原地更新，保持引用）。 */
  private syncDisabledSkills(): void {
    const names = this.plugins.disabledSkillNames();
    this.disabledSkills.length = 0;
    this.disabledSkills.push(...names);
  }

  register(ipcMain: IpcMain): void {
    const handle = (
      channel: string,
      handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
    ): void => {
      ipcMain.handle(channel, (event, ...args) => {
        if (!this.options.isTrustedSender(event)) throw new Error("Blocked untrusted IPC sender");
        return handler(event, ...args);
      });
    };

    handle("app:info", (): AppInfo => this.appInfo());
    handle("host:listSessions", () => this.manager.listSessions());
    handle("host:createSession", (_event, value) => {
      const input = record(value, "session");
      const cwd = path.resolve(stringValue(input["cwd"], "session.cwd"));
      if (cwd !== path.resolve(this.options.cwd)) throw new Error("Session cwd is outside app workspace");
      return this.manager.createSession({
        cwd,
        model: stringValue(input["model"], "session.model", 256),
        ...(input["title"] !== undefined
          ? { title: stringValue(input["title"], "session.title", 512) }
          : {}),
      });
    });
    handle("host:send", (_event, id, text) =>
      this.manager.send(sessionId(id), stringValue(text, "text", 1_048_576)),
    );
    handle("host:interrupt", (_event, id) => this.manager.interrupt(sessionId(id)));
    handle("host:setTitle", (_event, id, title) =>
      this.manager.setTitle(sessionId(id), stringValue(title, "title", 512)),
    );
    handle("host:deleteSession", (_event, id) => this.manager.deleteSession(sessionId(id)));
    handle("host:answerPermission", (_event, id, permissionId, value) => {
      const decisions: PermissionDecisionKind[] = [
        "allow",
        "allow_remember",
        "allow_always",
        "deny",
      ];
      if (!decisions.includes(value as PermissionDecisionKind)) {
        throw new TypeError("Invalid permission decision");
      }
      return this.manager.answerPermission(
        sessionId(id),
        stringValue(permissionId, "permissionId", 256),
        value as PermissionDecisionKind,
      );
    });

    handle("host:open", async (event, id) => {
      const subId = randomUUID();
      const sender = event.sender;
      const openHandle = await this.manager.open(sessionId(id), (ev) => {
        if (sender.isDestroyed()) return;
        sender.send(EVENT_CHANNEL, { subId, event: ev });
      });
      this.subscriptions.set(subId, { handle: openHandle, sender });
      // 渲染进程窗口销毁时，主动回收其所有订阅，避免向已销毁 sender 推事件。
      sender.once("destroyed", () => this.closeSubscription(subId));
      return { subId, snapshot: openHandle.snapshot };
    });
    handle("host:close", (_event, id) => {
      this.closeSubscription(stringValue(id, "subscriptionId", 64));
    });

    handle("meta:catalog", () => this.catalogRows());
    handle("meta:providers", () => listProviderDetails());
    handle("meta:userModels", () => this.readUserModels());
    handle("meta:addUserModel", (_event, model) => this.addUserModel(parseUserModel(model)));
    handle("meta:removeUserModel", (_event, spec) =>
      this.removeUserModel(stringValue(spec, "model spec", 384)),
    );

    handle("plugins:list", () => this.listPlugins());
    handle("plugins:setEnabled", (_event, id, enabled) => {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be boolean");
      return this.setPluginEnabled(stringValue(id, "plugin id", 256), enabled);
    });
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
      defaultModel: this.options.defaultModel ?? resolveDefaultModel(),
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
    // 文件系统技能（skill.fs.*）不在静态目录里，语义同 builtin（默认启用、可显式关闭）。
    const isFsSkill = id.startsWith("skill.fs.");
    if (!manifest && !isFsSkill) throw new Error(t(`Unknown plugin: ${id}`, `未知插件: ${id}`));
    const builtin = isFsSkill ? true : Boolean(manifest?.builtin);
    const saved = await this.readSavedPlugins();
    const next = applyPluginToggle(saved, id, enabled, builtin);
    await fs.mkdir(path.dirname(this.options.pluginsFile), { recursive: true });
    await fs.writeFile(this.options.pluginsFile, JSON.stringify(next, null, 2), "utf8");
    // reconcile：连接新启用的 MCP / 断开停用的；工具集变化对新建会话生效。
    await this.plugins.setState(next);
    // 技能开关同步进 agent 的 disabled 列表（对新建会话生效）。
    this.syncDisabledSkills();
    return this.plugins.entriesWithStatus();
  }

  /**
   * 完整关闭 Bridge 自己创建的全部资源。幂等 Promise 让 Electron 退出流程和测试都能
   * 等待 OTLP flush、代理 socket 与 SQLite WAL 真正落盘/关闭。
   */
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      const failures: unknown[] = [];
      const attempt = async (close: () => void | Promise<void>) => {
        try {
          await close();
        } catch (error) {
          failures.push(error);
        }
      };

      for (const subId of [...this.subscriptions.keys()]) {
        await attempt(() => this.closeSubscription(subId));
      }
      await attempt(() => this.plugins.dispose());
      await attempt(() => this.manager.dispose());
      await attempt(async () => {
        if (this.telemetry.shutdown) await this.telemetry.shutdown();
        else await this.telemetry.forceFlush?.();
      });
      await attempt(() => this.runtimeStack.networkProxy.close());
      await attempt(() => this.runtimeStack.database.close());

      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to dispose one or more Bridge resources");
      }
    })();
    return this.disposePromise;
  }
}
