/**
 * 主进程 ↔ 渲染进程之间的契约（contextBridge 暴露到 window.anicode）。
 *
 * 这是 Electron 版的「传输层」：和 daemon 一样，它只是 SessionHost 的另一种搬运方式。
 * 渲染进程据此在本地重建一个 SessionHost 交给 UI，UI 对传输一无所知。
 */

import type {
  ModelCatalogEntry,
  PermissionDecisionKind,
  ProviderDescriptor,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
} from "@anicode/core";
import type { PluginEntry } from "./plugins.js";

export type { PluginEntry } from "./plugins.js";

/**
 * 目录条目 + 主进程算好的凭证就绪状态。
 * 渲染进程读不到 process.env，凭证探测必须在主进程完成后随数据下发。
 */
export interface ModelRow extends ModelCatalogEntry {
  /** true=可直接用，false=缺凭证，undefined=无法本地判断。 */
  ready: boolean | undefined;
  readyHint: string;
  /** 内置目录还是用户在设置里自定义的。 */
  source: "builtin" | "user";
}

/** 用户自定义模型（挂在某个已有 provider 下），持久化到 models.json。 */
export interface UserModel {
  /** 已有 provider 的 id，如 openrouter / ollama / groq。 */
  provider: string;
  /** model id（provider/ 之后的部分）。 */
  model: string;
  label?: string;
  free?: boolean;
  openWeight?: boolean;
  note?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  cwd: string;
  sessionsDir: string;
  /** 当前进程能否安全读取 env 里的凭证（本地主进程可以）。 */
  inspectProviderCredentials: boolean;
}

/** open 订阅的载荷：一次拿到 snapshot + 订阅 id，事件随后经 onEvent 回流。 */
export interface OpenResult {
  subId: string;
  snapshot: SessionSnapshot;
}

/** onEvent 广播的单条消息：subId 用于路由到正确的会话订阅。 */
export interface EventEnvelope {
  subId: string;
  event: SessionEvent;
}

/** contextBridge 暴露的完整 API。所有返回值必须是结构化可克隆的。 */
export interface AgentxApi {
  appInfo(): Promise<AppInfo>;

  // —— SessionHost 面 ——
  listSessions(): Promise<SessionSummary[]>;
  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary>;
  open(sessionId: string): Promise<OpenResult>;
  close(subId: string): Promise<void>;
  send(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  setTitle(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionDecisionKind,
  ): Promise<boolean>;
  /** 注册事件监听；返回取消函数。 */
  onEvent(listener: (envelope: EventEnvelope) => void): () => void;

  // —— 模型与 provider ——
  listModelCatalog(): Promise<ModelRow[]>;
  listProviders(): Promise<ProviderDescriptor[]>;
  /** 用户自定义模型的增删查；返回更新后的完整目录（含内置与自定义）。 */
  listUserModels(): Promise<UserModel[]>;
  addUserModel(model: UserModel): Promise<ModelRow[]>;
  removeUserModel(spec: string): Promise<ModelRow[]>;

  // —— 插件市场 ——
  listPlugins(): Promise<PluginEntry[]>;
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginEntry[]>;
}

declare global {
  interface Window {
    anicode: AgentxApi;
  }
}
