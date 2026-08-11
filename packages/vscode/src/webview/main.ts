/**
 * webview 前端（纯 DOM，无框架，走 VSCode 主题变量）。
 * 收主机的 reset/event 消息折叠成状态并渲染；用户输入与操作经 postMessage 回主机。
 * 所有模型输出都用 textContent/DOM 构建，绝不用 innerHTML，天然无 XSS。
 */

// 走零依赖子路径，避免把 core 的 Node-only 依赖（Anthropic/OpenAI SDK）打进浏览器 bundle。
import { t } from "@anicode/core/i18n";
import type { SessionEvent, TodoItem, Usage } from "@anicode/core";
import { coalesceSessionEvents } from "../event-batch.js";
import type { FileChange, HostToWebview, PendingPerm, SessionInfo } from "../protocol.js";
import { messagesToItems, todosFromMessages, firstLine, type Item } from "../transcript.js";
import { renderMarkdown, StreamingMarkdownRenderer } from "./markdown.js";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
const vscode = acquireVsCodeApi();

type ToolItem = Extract<Item, { kind: "tool" }>;

const state = {
  info: null as SessionInfo | null,
  items: [] as Item[],
  activeTools: new Map<string, ToolItem>(),
  liveText: "",
  running: false,
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } as Usage,
  todos: [] as TodoItem[],
  pendings: [] as PendingPerm[],
  fileChanges: new Map<string, FileChange>(),
};

// Durable history stays in SessionManager; these limits only bound browser layout/DOM work.
const MAX_TRANSCRIPT_ITEMS = 1_000;
const MAX_ITEM_CHARS = 256 * 1024;
const MAX_TOOL_DETAIL_CHARS = 64 * 1024;
const MAX_LIVE_CHARS = 256 * 1024;
const MAX_ACTIVE_TOOLS = 200;
const MAX_TODOS = 200;
const MAX_PENDING_PERMISSIONS = 100;

function boundedText(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = t("… older display content omitted …", "… 较早的显示内容已省略 …");
  const keep = Math.max(0, max - marker.length - 1);
  return keep > 0 ? `${marker}\n${text.slice(-keep)}` : marker.slice(0, max);
}

function boundedItem(item: Item): Item {
  if (item.kind === "tool") {
    return {
      ...item,
      name: boundedText(item.name, 4 * 1024),
      ruleKey: boundedText(item.ruleKey, 16 * 1024),
      ...(item.detail ? { detail: boundedText(item.detail, MAX_TOOL_DETAIL_CHARS) } : {}),
    };
  }
  return { ...item, text: boundedText(item.text, MAX_ITEM_CHARS) };
}

function pushItem(item: Item): void {
  state.items.push(boundedItem(item));
  if (state.items.length <= MAX_TRANSCRIPT_ITEMS) return;
  state.items = state.items.slice(-MAX_TRANSCRIPT_ITEMS);
}

function setActiveTool(id: string, tool: ToolItem): void {
  if (!state.activeTools.has(id) && state.activeTools.size >= MAX_ACTIVE_TOOLS) {
    const oldest = state.activeTools.keys().next().value;
    if (oldest !== undefined) state.activeTools.delete(oldest);
  }
  state.activeTools.set(id, boundedItem(tool) as ToolItem);
}

function appendLiveText(delta: string): void {
  if (delta.length >= MAX_LIVE_CHARS) {
    state.liveText = boundedText(delta, MAX_LIVE_CHARS);
    return;
  }
  if (state.liveText.length + delta.length <= MAX_LIVE_CHARS) {
    state.liveText += delta;
    return;
  }
  state.liveText = boundedText(state.liveText + delta, MAX_LIVE_CHARS);
}

// ---------- DOM 骨架 ----------
const root = document.getElementById("root")!;
root.innerHTML = "";

const header = div("header");
const modelChip = button("chip", () => post({ type: "pickModel" }));
const newBtn = button("chip ghost", () => post({ type: "newSession" }));
newBtn.textContent = t("＋ New chat", "＋ 新对话");
const resumeBtn = button("chip ghost", () => post({ type: "resume" }));
resumeBtn.textContent = t("↺ Resume", "↺ 恢复");
header.append(modelChip, spacer(), newBtn, resumeBtn);

const scroll = div("scroll");
const messages = div("messages");
scroll.append(messages);

const composer = div("composer");
const textarea = document.createElement("textarea");
textarea.className = "input";
textarea.rows = 1;
textarea.placeholder = t(
  "Message AniCode Zen… (Enter to send, Shift+Enter for newline)",
  "给 AniCode Zen 发消息…（Enter 发送，Shift+Enter 换行）",
);
const sendBtn = button("send", submit);
sendBtn.textContent = "↑";
composer.append(textarea, sendBtn);

root.append(header, scroll, composer);

textarea.addEventListener("input", autoGrow);
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
});

// ---------- 消息处理 ----------
type RenderIntent = 0 | 1 | 2;
const NO_RENDER: RenderIntent = 0;
const LIVE_RENDER: RenderIntent = 1;
const FULL_RENDER: RenderIntent = 2;
const eventQueue: SessionEvent[] = [];
let eventFrame: number | undefined;

window.addEventListener("message", (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  if (msg.type === "reset") {
    cancelQueuedEvents();
    applyReset(msg);
  } else if (msg.type === "event") {
    eventQueue.push(msg.event);
    if (eventFrame === undefined) eventFrame = requestAnimationFrame(() => flushQueuedEvents());
  } else if (msg.type === "fileChange") {
    flushQueuedEvents(false);
    state.fileChanges.set(msg.change.toolId, msg.change);
    render();
  } else if (msg.type === "error") {
    flushQueuedEvents(false);
    pushItem({ kind: "error", text: msg.message });
    render();
  }
});

function cancelQueuedEvents(): void {
  if (eventFrame !== undefined) cancelAnimationFrame(eventFrame);
  eventFrame = undefined;
  eventQueue.length = 0;
}

function flushQueuedEvents(renderResult = true): RenderIntent {
  if (eventFrame !== undefined) cancelAnimationFrame(eventFrame);
  eventFrame = undefined;
  let intent: RenderIntent = NO_RENDER;
  const queued = coalesceSessionEvents(eventQueue);
  eventQueue.length = 0;
  for (const event of queued) {
    intent = Math.max(intent, applyEvent(event)) as RenderIntent;
  }
  if (renderResult) {
    if (intent === FULL_RENDER) render();
    else if (intent === LIVE_RENDER) renderLive();
  }
  return intent;
}

function applyReset(msg: Extract<HostToWebview, { type: "reset" }>): void {
  state.info = msg.info;
  state.activeTools = new Map();
  const restoredItems: Item[] = [];
  for (const item of messagesToItems(msg.messages)) {
    if (item.kind === "tool" && item.status === "run") setActiveTool(item.id, item);
    else restoredItems.push(boundedItem(item));
  }
  state.items = restoredItems.slice(-MAX_TRANSCRIPT_ITEMS);
  state.todos = todosFromMessages(msg.messages).slice(0, MAX_TODOS);
  state.usage = msg.usage;
  state.running = msg.running;
  state.pendings = msg.pendings.slice(0, MAX_PENDING_PERMISSIONS);
  state.liveText = "";
  state.fileChanges = new Map();
  render();
}

function applyEvent(se: SessionEvent): RenderIntent {
  if (se.type === "state") {
    state.running = se.running;
    if (!se.running) flushLive();
    return FULL_RENDER;
  }
  if (se.type === "permission_request") {
    if (!state.pendings.some((p) => p.permId === se.permId))
      state.pendings.push({
        permId: se.permId,
        toolName: se.toolName,
        ruleKey: se.ruleKey,
        ...(se.network !== undefined ? { network: se.network } : {}),
      });
    if (state.pendings.length > MAX_PENDING_PERMISSIONS) {
      state.pendings.length = MAX_PENDING_PERMISSIONS;
    }
    return FULL_RENDER;
  }
  if (se.type === "permission_resolved") {
    state.pendings = state.pendings.filter((p) => p.permId !== se.permId);
    return FULL_RENDER;
  }
  if (se.type === "reverted") {
    pushItem({
      kind: "info",
      text: t(
        `↩ Workspace reverted: restored ${se.restored} files, removed ${se.deleted} newly added files`,
        `↩ 工作区已回滚：恢复 ${se.restored} 个文件，删除 ${se.deleted} 个新增文件`,
      ),
    });
    return FULL_RENDER;
  }
  if (se.type === "title") {
    // 标题变化：webview 暂不展示标题，忽略。
    return NO_RENDER;
  }
  if (se.type === "workspace_trust") {
    pushItem({
      kind: "info",
      text: se.assessment.trusted
        ? t("Workspace trust granted", "工作区已授信")
        : t(
            "Workspace trust revoked; restricted mode is active",
            "工作区信任已撤销，受限模式已生效",
          ),
    });
    return FULL_RENDER;
  }
  const ev = se.event;
  switch (ev.type) {
    case "user_message":
      flushLive();
      // 后台任务完成通知（自动 drive 的 user 消息）：收敛成一行 info（与 TUI/restore 一致）。
      if (ev.text.startsWith("<task-notification")) {
        pushItem({ kind: "info", text: `◆ ${noticeHead(ev.text)}` });
        return FULL_RENDER;
      }
      pushItem({ kind: "user", text: ev.text });
      return FULL_RENDER;
    case "task_notice":
      // 运行中注入的后台任务完成通知：一行 info 摘要（全文只给模型看）。
      flushLive();
      pushItem({ kind: "info", text: `◆ ${noticeHead(ev.text)}` });
      return FULL_RENDER;
    case "text":
      appendLiveText(ev.text);
      return LIVE_RENDER;
    case "tool_progress":
      if (isTodo(ev.event)) {
        state.todos = ev.event.todos.slice(0, MAX_TODOS);
        return FULL_RENDER;
      }
      return NO_RENDER;
    case "turn_reset":
      state.liveText = "";
      return FULL_RENDER;
    case "tool_start":
      flushLive();
      setActiveTool(ev.id, {
        kind: "tool",
        id: ev.id,
        name: ev.name,
        ruleKey: ev.ruleKey,
        status: "run",
      });
      return FULL_RENDER;
    case "tool_permission":
      if (ev.decision === "deny") {
        const t = state.activeTools.get(ev.id);
        if (t) t.status = "deny";
        return FULL_RENDER;
      }
      return NO_RENDER;
    case "tool_result": {
      const t = state.activeTools.get(ev.id);
      state.activeTools.delete(ev.id);
      if (t) {
        pushItem({
          ...t,
          status: t.status === "deny" ? "deny" : ev.isError ? "err" : "ok",
          ...(ev.isError ? { detail: firstLine(ev.content) } : {}),
        });
      }
      return FULL_RENDER;
    }
    case "turn_end":
      state.usage = ev.usage;
      return NO_RENDER;
    case "compacted":
      pushItem({
        kind: "info",
        text: t(
          `Context compacted ${ev.beforeTokens}→${ev.afterTokens} tokens`,
          `上下文已压缩 ${ev.beforeTokens}→${ev.afterTokens} tokens`,
        ),
      });
      return FULL_RENDER;
    case "done":
      flushLive();
      state.usage = ev.usage;
      return FULL_RENDER;
    case "error":
      flushLive();
      pushItem({ kind: "error", text: ev.message });
      return FULL_RENDER;
    default:
      return NO_RENDER;
  }
}

function flushLive(): void {
  if (state.liveText) {
    pushItem({ kind: "assistant", text: state.liveText });
    state.liveText = "";
  }
}

// ---------- 渲染 ----------
let liveEl: HTMLElement | null = null;
let liveMarkdown: StreamingMarkdownRenderer | null = null;
const itemElementCache = new WeakMap<object, HTMLElement>();
const fileChangeElementCache = new WeakMap<object, HTMLElement>();

function render(): void {
  const fragment = document.createDocumentFragment();
  liveEl = null;
  liveMarkdown = null;
  for (const item of state.items) {
    let element = itemElementCache.get(item);
    if (!element) {
      element = renderItem(item);
      itemElementCache.set(item, element);
    }
    fragment.append(element);
    if (item.kind === "tool") {
      const fc = state.fileChanges.get(item.id);
      if (fc) {
        let changeElement = fileChangeElementCache.get(fc);
        if (!changeElement) {
          changeElement = renderFileChange(fc);
          fileChangeElementCache.set(fc, changeElement);
        }
        fragment.append(changeElement);
      }
    }
  }
  if (state.liveText) {
    const bubble = assistantBubble("", true);
    liveEl = bubble.querySelector(".md");
    if (liveEl) {
      liveMarkdown = new StreamingMarkdownRenderer(liveEl);
      liveMarkdown.render(state.liveText);
    }
    fragment.append(bubble);
  }
  for (const t of state.activeTools.values()) fragment.append(renderItem(t));
  if (state.todos.length) fragment.append(renderTodos(state.todos));
  if (state.pendings[0])
    fragment.append(renderPermission(state.pendings[0], state.pendings.length - 1));

  messages.replaceChildren(fragment);

  modelChip.textContent = `${state.info?.model ?? "—"} ▾`;
  sendBtn.textContent = state.running ? "■" : "↑";
  scrollToEnd();
}

function renderLive(): void {
  if (!state.liveText) return;
  if (!liveEl || !liveMarkdown) {
    render();
    return;
  }
  liveMarkdown.render(state.liveText);
  scrollToEnd();
}

function renderItem(item: Item): HTMLElement {
  switch (item.kind) {
    case "user": {
      const row = div("row user");
      const b = div("bubble");
      b.textContent = item.text;
      row.append(b);
      return row;
    }
    case "assistant":
      return assistantBubble(item.text, false);
    case "tool": {
      const el = div(`tool status-${item.status}`);
      const mark =
        item.status === "run"
          ? "⚙"
          : item.status === "ok"
            ? "✔"
            : item.status === "deny"
              ? "⊘"
              : "✖";
      el.append(
        span("tool-mark", mark),
        span("tool-name", item.name),
        span("tool-key", item.ruleKey),
      );
      if (item.detail) el.append(span("tool-detail", "— " + item.detail));
      return el;
    }
    case "info":
      return div("notice", item.text);
    case "error":
      return div("notice error", "✖ " + item.text);
  }
}

function assistantBubble(text: string, streaming: boolean): HTMLElement {
  const row = div("row assistant");
  const b = div("bubble");
  const md = div("md");
  renderMarkdown(md, text);
  b.append(md);
  if (streaming) b.append(span("caret", ""));
  row.append(b);
  return row;
}

function renderFileChange(change: FileChange): HTMLElement {
  const box = div("filechange");
  const head = div("fc-head");
  const path = span("fc-path", change.path);
  const stat = div("fc-stat");
  if (change.added) stat.append(span("fc-add", `+${change.added}`));
  if (change.removed) stat.append(span("fc-del", `-${change.removed}`));
  const open = button("fc-open", () => post({ type: "openFile", path: change.path }));
  open.textContent = t("Open file", "打开文件");
  head.append(path, stat, spacer(), open);
  box.append(head);

  const body = div("fc-body");
  for (const line of change.lines) {
    const sign = line.t === "add" ? "+" : line.t === "del" ? "-" : " ";
    body.append(div(`fc-line ${line.t}`, sign + " " + line.text));
  }
  if (change.truncated)
    body.append(div("fc-line ctx", t("… diff too long, truncated", "… 差异过长，已截断")));
  box.append(body);
  return box;
}

function renderTodos(todos: TodoItem[]): HTMLElement {
  const box = div("todo-card");
  box.append(div("todo-title", t("Task list", "任务清单")));
  for (const t of todos) {
    const mark = t.status === "completed" ? "✔" : t.status === "in_progress" ? "●" : "○";
    const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
    box.append(div(`todo-item ${t.status}`, `${mark} ${text}`));
  }
  return box;
}

function renderPermission(p: PendingPerm, extra: number): HTMLElement {
  const card = div("perm-card");
  const title = div("perm-title");
  const networkApproval = p.toolName.toLowerCase() === "bash" && p.network === true;
  title.textContent =
    t(
      `⚠ Permission request: ${p.toolName}${networkApproval ? " · NETWORK" : ""}`,
      `⚠ 授权请求：${p.toolName}${networkApproval ? " · 联网" : ""}`,
    ) + (extra > 0 ? t(`(${extra} more pending)`, `（还有 ${extra} 个待裁决）`) : "");
  const key = div("perm-key");
  key.textContent = p.ruleKey;
  const actions = div("perm-actions");
  actions.append(
    permButton(
      networkApproval ? t("Allow network once", "本次允许联网") : t("Allow", "允许"),
      "allow",
      p.permId,
      "allow",
    ),
  );
  if (!networkApproval) {
    actions.append(
      permButton(t("Allow and remember", "允许并记住"), "remember", p.permId, "allow_remember"),
      permButton(
        t("Always allow (persist)", "永久允许（写入项目）"),
        "remember",
        p.permId,
        "allow_always",
      ),
    );
  }
  actions.append(permButton(t("Deny", "拒绝"), "deny", p.permId, "deny"));
  card.append(title, key, actions);
  return card;
}

function permButton(
  label: string,
  cls: string,
  permId: string,
  decision: "allow" | "allow_remember" | "allow_always" | "deny",
): HTMLElement {
  const b = button(`btn ${cls}`, () => post({ type: "answer", permId, decision }));
  b.textContent = label;
  return b;
}

// ---------- 辅助 ----------
function submit(): void {
  if (state.running) {
    post({ type: "interrupt" });
    return;
  }
  const text = textarea.value.trim();
  if (!text) return;
  textarea.value = "";
  autoGrow();
  post({ type: "send", text });
}

/** 通知信封的首个内容行（跳过 <task-notification> 标记）作为一行摘要。 */
function noticeHead(text: string): string {
  return text.split("\n").find((l) => l && !l.startsWith("<")) ?? "";
}

function autoGrow(): void {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

function scrollToEnd(): void {
  scroll.scrollTop = scroll.scrollHeight;
}

function post(msg: unknown): void {
  vscode.postMessage(msg);
}

function isTodo(value: unknown): value is { type: "todos"; todos: TodoItem[] } {
  const v = value as { type?: unknown; todos?: unknown } | null;
  return !!v && v.type === "todos" && Array.isArray(v.todos);
}

function div(className: string, text?: string): HTMLElement {
  const el = document.createElement("div");
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
function span(className: string, text: string): HTMLElement {
  const el = document.createElement("span");
  el.className = className;
  el.textContent = text;
  return el;
}
function button(className: string, onClick: () => void): HTMLElement {
  const el = document.createElement("button");
  el.className = className;
  el.addEventListener("click", onClick);
  return el;
}
function spacer(): HTMLElement {
  return div("spacer");
}

post({ type: "ready" });
