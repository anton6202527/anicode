/**
 * SessionHost —— 前端（TUI/App/CI）唯一面对的契约。
 *
 * 这是架构的拱心石：前端只认这个接口，不关心 core 是「进程内」还是「socket 那头」。
 *   - LocalSessionHost：直接包 SessionManager（单进程，零 IPC 开销）
 *   - RemoteSessionHost：daemon 客户端（见 daemon/client.ts），跨进程共享会话
 * 两者行为等价，可互换 —— 正如 core 对 UI 无关，前端也对传输无关。
 */

import type {
  PermissionAnswer,
  RewindMode,
  SessionEvent,
  SessionSnapshot,
  SessionSummary,
  SessionManager,
} from "./session-manager.js";
import type { PermissionMode, PermissionProfile } from "./permission.js";

export type PermissionDecisionKind = PermissionAnswer;

export interface OpenHandle {
  snapshot: SessionSnapshot;
  /** 取消订阅 */
  close(): void;
}

export interface SessionHost {
  listSessions(): Promise<SessionSummary[]>;
  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary>;
  /** 订阅一个会话：立即拿 snapshot，之后经 listener 实时收事件 */
  open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle>;
  /**
   * 发消息驱动 loop；事件经 open 的 listener 回流；resolve 于本次 loop 结束。
   * opts.model：per-prompt 模型覆盖——仅这一次 drive 用该模型（steering 时忽略）。
   */
  send(sessionId: string, text: string, opts?: { model?: string }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** true 表示本次成功裁决；false 表示已被其他观察者抢先处理或请求已失效。 */
  answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionDecisionKind,
  ): Promise<boolean | void>;
  /**
   * 撤销/回滚到某快照（缺省=最近一个）。mode：files（默认）仅文件；
   * conversation 仅截断对话；both 两者（对齐 Claude Code /rewind）。
   */
  undo(
    sessionId: string,
    checkpointId?: string,
    mode?: RewindMode,
  ): Promise<{ restored: number; deleted: number; removedMessages?: number }>;
  /**
   * fork：把会话历史复制成新会话（可截断到前 upToMessage 条）。可选：
   * 未接线的传输可不实现，前端应在调用前判空。
   */
  forkSession?(
    sessionId: string,
    opts?: { title?: string; upToMessage?: number },
  ): Promise<SessionSummary>;
  /** 手动压缩上下文（/compact）。可选，同 forkSession 的接线边界。 */
  compact?(
    sessionId: string,
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }>;
  /**
   * 运行时切换权限模式（如 /plan 计划模式）。可选：不支持的传输（暂未接线的 daemon）
   * 可不实现，前端应在调用前判空。
   */
  setPermissionMode?(sessionId: string, mode: PermissionMode): Promise<void>;
  /**
   * 运行时切换权限档位（内置 readonly/default/workspace/full + 配置自定义）。
   * 返回切换后的生效模式。可选，同 setPermissionMode 的接线边界。
   */
  setPermissionProfile?(sessionId: string, name: string): Promise<PermissionMode>;
  /** 会话可用的权限档位（供 /profile 无参列表）。可选。 */
  listPermissionProfiles?(sessionId: string): Promise<Record<string, PermissionProfile>>;
  /** 释放资源：远程断开 socket；本地中断本进程持有的 live drive。 */
  dispose(): void;
}

/** 进程内实现：直接委托给 SessionManager */
export class LocalSessionHost implements SessionHost {
  constructor(private manager: SessionManager) {}

  listSessions(): Promise<SessionSummary[]> {
    return this.manager.listSessions();
  }
  createSession(input: { cwd: string; model: string; title?: string }): Promise<SessionSummary> {
    return this.manager.createSession(input);
  }
  async open(sessionId: string, listener: (ev: SessionEvent) => void): Promise<OpenHandle> {
    return this.manager.open(sessionId, listener);
  }
  send(sessionId: string, text: string, opts?: { model?: string }): Promise<void> {
    return this.manager.send(sessionId, text, opts);
  }
  interrupt(sessionId: string): Promise<void> {
    return this.manager.interrupt(sessionId);
  }
  answerPermission(
    sessionId: string,
    permId: string,
    decision: PermissionDecisionKind,
  ): Promise<boolean> {
    return this.manager.answerPermission(sessionId, permId, decision);
  }
  undo(
    sessionId: string,
    checkpointId?: string,
    mode?: RewindMode,
  ): Promise<{ restored: number; deleted: number; removedMessages: number }> {
    return this.manager.undo(sessionId, checkpointId, mode);
  }
  forkSession(
    sessionId: string,
    opts?: { title?: string; upToMessage?: number },
  ): Promise<SessionSummary> {
    return this.manager.forkSession(sessionId, opts);
  }
  compact(
    sessionId: string,
  ): Promise<{ compacted: boolean; beforeTokens: number; afterTokens: number }> {
    return this.manager.compact(sessionId);
  }
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<void> {
    return this.manager.setPermissionMode(sessionId, mode);
  }
  setPermissionProfile(sessionId: string, name: string): Promise<PermissionMode> {
    return this.manager.setPermissionProfile(sessionId, name);
  }
  listPermissionProfiles(sessionId: string): Promise<Record<string, PermissionProfile>> {
    return this.manager.listPermissionProfiles(sessionId);
  }
  dispose(): void {
    this.manager.dispose();
  }
}
