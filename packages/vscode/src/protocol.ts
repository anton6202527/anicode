/**
 * 扩展主机 ↔ webview 的消息协议（VSCode postMessage 传输）。
 * 又一个 SessionHost 传输实现：主机跑 core，webview 只渲染。
 */

import type { ChatMessage, SessionEvent, Usage } from "@anicode/core";
import type { DiffLine } from "@anicode/shared";

/** 一次文件写/改的结构化预览，供 webview 渲染红绿 diff。 */
export interface FileChange {
  toolId: string;
  path: string;
  kind: "write" | "edit";
  added: number;
  removed: number;
  lines: DiffLine[];
  /** lines 是否因过长被截断。 */
  truncated?: boolean;
}

export interface SessionInfo {
  id: string;
  model: string;
  cwd: string;
  title?: string;
}

export interface PendingPerm {
  permId: string;
  toolName: string;
  ruleKey: string;
}

export type PermissionDecision = "allow" | "allow_remember" | "allow_always" | "deny";

/** 主机 → webview */
export type HostToWebview =
  | {
      type: "reset";
      info: SessionInfo;
      messages: ChatMessage[];
      usage: Usage;
      running: boolean;
      pendings: PendingPerm[];
    }
  | { type: "event"; event: SessionEvent }
  | { type: "fileChange"; change: FileChange }
  | { type: "error"; message: string };

/** webview → 主机 */
export type WebviewToHost =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "interrupt" }
  | { type: "answer"; permId: string; decision: PermissionDecision }
  | { type: "newSession" }
  | { type: "pickModel" }
  | { type: "resume" }
  | { type: "openFile"; path: string };
