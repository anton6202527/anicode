/**
 * ChatBridge —— 把 core 的 SessionManager 接到 webview 传输上（仅依赖 core，可离线单测）。
 * 维护「当前活动会话」：VSCode 侧边栏是单一活动对话，切模型/新建/恢复都换这个活动会话。
 */

import { t } from "@anicode/core";
import type { SessionEvent, SessionManager } from "@anicode/core";
import type { HostToWebview, PendingPerm, PermissionDecision, WebviewToHost } from "./protocol.js";
import { fileChangeFor } from "./filechange.js";

export type Poster = (msg: HostToWebview) => void;

export class ChatBridge {
  private currentId: string | null = null;
  private currentModel: string;
  private close: (() => void) | null = null;
  /** 当前活动会话是否还没有标题且没有用户消息（用于首条消息自动命名）。 */
  private needsTitle = false;

  constructor(
    private readonly manager: SessionManager,
    private readonly cwd: string,
    defaultModel: string,
    private post: Poster,
  ) {
    this.currentModel = defaultModel;
  }

  setPost(post: Poster): void {
    this.post = post;
  }

  get sessionId(): string | null {
    return this.currentId;
  }
  get model(): string {
    return this.currentModel;
  }

  /** webview ready：无活动会话则建默认会话，否则重发当前快照。 */
  async start(): Promise<void> {
    if (this.currentId) await this.open(this.currentId, this.currentModel);
    else await this.newSession(this.currentModel);
  }

  async handle(msg: WebviewToHost): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.start();
        return;
      case "send":
        await this.send(msg.text);
        return;
      case "interrupt":
        if (this.currentId) await this.manager.interrupt(this.currentId);
        return;
      case "answer":
        if (this.currentId)
          await this.manager.answerPermission(
            this.currentId,
            msg.permId,
            msg.decision as PermissionDecision,
          );
        return;
      case "newSession":
        await this.newSession(this.currentModel);
        return;
      // pickModel / resume 由扩展主机用 QuickPick 处理后调用 switchModel / resume
      case "pickModel":
      case "resume":
        return;
    }
  }

  async newSession(model: string): Promise<void> {
    try {
      const meta = await this.manager.createSession({ cwd: this.cwd, model });
      this.currentModel = model;
      await this.open(meta.id, model);
    } catch (err) {
      this.post({ type: "error", message: errorMessage(err) });
    }
  }

  async switchModel(model: string): Promise<void> {
    await this.newSession(model);
  }

  async resume(sessionId: string): Promise<void> {
    try {
      await this.open(sessionId);
    } catch (err) {
      this.post({ type: "error", message: errorMessage(err) });
    }
  }

  private async open(sessionId: string, model?: string): Promise<void> {
    this.close?.();
    this.close = null;
    const handle = await this.manager.open(sessionId, (event) => {
      this.post({ type: "event", event });
      this.maybeFileChange(sessionId, event);
    });
    this.close = handle.close;
    this.currentId = sessionId;
    const snap = handle.snapshot;
    this.currentModel = model ?? snap.meta.model;
    // 无标题且尚无用户消息 → 首条消息后自动命名。
    const hasUser = snap.messages.some((m) => m.role === "user");
    this.needsTitle = !snap.meta.title && !hasUser;
    this.post({
      type: "reset",
      info: {
        id: snap.meta.id,
        model: snap.meta.model,
        cwd: snap.meta.cwd,
        ...(snap.meta.title ? { title: snap.meta.title } : {}),
      },
      messages: snap.messages,
      usage: snap.usage,
      running: snap.running,
      pendings: snap.pendingPermissions as PendingPerm[],
    });
  }

  /** write/edit 工具成功后，从快照里取参数算出 diff 预览发给 webview。 */
  private maybeFileChange(sessionId: string, event: SessionEvent): void {
    if (event.type !== "agent") return;
    const ev = event.event;
    if (ev.type !== "tool_result" || ev.isError) return;
    if (ev.name !== "write" && ev.name !== "edit") return;
    const snap = this.manager.peek(sessionId);
    if (!snap) return;
    const change = fileChangeFor(snap.messages, ev.id);
    if (change) this.post({ type: "fileChange", change });
  }

  private async send(text: string): Promise<void> {
    const id = this.currentId;
    if (!id) return;
    const autoTitle = this.needsTitle;
    this.needsTitle = false;
    try {
      await this.manager.send(id, text);
      if (autoTitle) await this.manager.setTitle(id, deriveTitle(text));
    } catch (err) {
      this.post({ type: "error", message: errorMessage(err) });
    }
  }

  dispose(): void {
    this.close?.();
    this.close = null;
  }
}

function deriveTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const title = line.length > 40 ? line.slice(0, 40) + "…" : line;
  return title || t("New chat", "新对话");
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
