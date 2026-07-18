/**
 * webview 前端（纯 DOM，无框架，走 VSCode 主题变量）。
 * 收主机的 reset/event 消息折叠成状态并渲染；用户输入与操作经 postMessage 回主机。
 * 所有模型输出都用 textContent/DOM 构建，绝不用 innerHTML，天然无 XSS。
 */

// 走零依赖子路径，避免把 core 的 Node-only 依赖（Anthropic/OpenAI SDK）打进浏览器 bundle。
import { t } from "@anicode/core/i18n";
import type { SessionEvent, TodoItem, Usage } from "@anicode/core";
import type { FileChange, HostToWebview, PendingPerm, SessionInfo } from "../protocol.js";
import { messagesToItems, todosFromMessages, firstLine, type Item } from "../transcript.js";
import { renderMarkdown } from "./markdown.js";

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
  "Message anicode… (Enter to send, Shift+Enter for newline)",
  "给 anicode 发消息…（Enter 发送，Shift+Enter 换行）",
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
window.addEventListener("message", (e: MessageEvent<HostToWebview>) => {
  const msg = e.data;
  if (msg.type === "reset") applyReset(msg);
  else if (msg.type === "event") applyEvent(msg.event);
  else if (msg.type === "fileChange") {
    state.fileChanges.set(msg.change.toolId, msg.change);
    render();
  } else if (msg.type === "error") {
    state.items.push({ kind: "error", text: msg.message });
    render();
  }
});

function applyReset(msg: Extract<HostToWebview, { type: "reset" }>): void {
  state.info = msg.info;
  state.activeTools = new Map();
  state.items = [];
  for (const item of messagesToItems(msg.messages)) {
    if (item.kind === "tool" && item.status === "run") state.activeTools.set(item.id, item);
    else state.items.push(item);
  }
  state.todos = todosFromMessages(msg.messages);
  state.usage = msg.usage;
  state.running = msg.running;
  state.pendings = msg.pendings;
  state.liveText = "";
  state.fileChanges = new Map();
  render();
}

function applyEvent(se: SessionEvent): void {
  if (se.type === "state") {
    state.running = se.running;
    if (!se.running) flushLive();
    render();
    return;
  }
  if (se.type === "permission_request") {
    if (!state.pendings.some((p) => p.permId === se.permId))
      state.pendings.push({ permId: se.permId, toolName: se.toolName, ruleKey: se.ruleKey });
    render();
    return;
  }
  if (se.type === "permission_resolved") {
    state.pendings = state.pendings.filter((p) => p.permId !== se.permId);
    render();
    return;
  }
  if (se.type === "reverted") {
    state.items.push({
      kind: "info",
      text: t(
        `↩ Workspace reverted: restored ${se.restored} files, removed ${se.deleted} newly added files`,
        `↩ 工作区已回滚：恢复 ${se.restored} 个文件，删除 ${se.deleted} 个新增文件`,
      ),
    });
    render();
    return;
  }
  if (se.type === "title") {
    // 标题变化：webview 暂不展示标题，忽略。
    return;
  }
  const ev = se.event;
  switch (ev.type) {
    case "user_message":
      flushLive();
      state.items.push({ kind: "user", text: ev.text });
      render();
      break;
    case "text":
      state.liveText += ev.text;
      renderLive();
      break;
    case "tool_progress":
      if (isTodo(ev.event)) {
        state.todos = ev.event.todos;
        render();
      }
      break;
    case "turn_reset":
      state.liveText = "";
      renderLive();
      break;
    case "tool_start":
      flushLive();
      state.activeTools.set(ev.id, {
        kind: "tool",
        id: ev.id,
        name: ev.name,
        ruleKey: ev.ruleKey,
        status: "run",
      });
      render();
      break;
    case "tool_permission":
      if (ev.decision === "deny") {
        const t = state.activeTools.get(ev.id);
        if (t) t.status = "deny";
        render();
      }
      break;
    case "tool_result": {
      const t = state.activeTools.get(ev.id);
      state.activeTools.delete(ev.id);
      if (t) {
        state.items.push({
          ...t,
          status: t.status === "deny" ? "deny" : ev.isError ? "err" : "ok",
          ...(ev.isError ? { detail: firstLine(ev.content) } : {}),
        });
      }
      render();
      break;
    }
    case "turn_end":
      state.usage = ev.usage;
      break;
    case "compacted":
      state.items.push({
        kind: "info",
        text: t(
          `Context compacted ${ev.beforeTokens}→${ev.afterTokens} tokens`,
          `上下文已压缩 ${ev.beforeTokens}→${ev.afterTokens} tokens`,
        ),
      });
      render();
      break;
    case "done":
      flushLive();
      state.usage = ev.usage;
      render();
      break;
    case "error":
      flushLive();
      state.items.push({ kind: "error", text: ev.message });
      render();
      break;
  }
}

function flushLive(): void {
  if (state.liveText) {
    state.items.push({ kind: "assistant", text: state.liveText });
    state.liveText = "";
  }
}

// ---------- 渲染 ----------
let liveEl: HTMLElement | null = null;

function render(): void {
  messages.innerHTML = "";
  liveEl = null;
  for (const item of state.items) {
    messages.append(renderItem(item));
    if (item.kind === "tool") {
      const fc = state.fileChanges.get(item.id);
      if (fc) messages.append(renderFileChange(fc));
    }
  }
  if (state.liveText) {
    const bubble = assistantBubble(state.liveText, true);
    liveEl = bubble.querySelector(".md");
    messages.append(bubble);
  }
  for (const t of state.activeTools.values()) messages.append(renderItem(t));
  if (state.todos.length) messages.append(renderTodos(state.todos));
  if (state.pendings[0])
    messages.append(renderPermission(state.pendings[0], state.pendings.length - 1));

  modelChip.textContent = `${state.info?.model ?? "—"} ▾`;
  sendBtn.textContent = state.running ? "■" : "↑";
  scrollToEnd();
}

function renderLive(): void {
  if (!state.liveText) return;
  if (!liveEl) {
    render();
    return;
  }
  liveEl.innerHTML = "";
  renderMarkdown(liveEl, state.liveText);
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
  title.textContent =
    t(`⚠ Permission request: ${p.toolName}`, `⚠ 授权请求：${p.toolName}`) +
    (extra > 0 ? t(`(${extra} more pending)`, `（还有 ${extra} 个待裁决）`) : "");
  const key = div("perm-key");
  key.textContent = p.ruleKey;
  const actions = div("perm-actions");
  actions.append(
    permButton(t("Allow", "允许"), "allow", p.permId, "allow"),
    permButton(t("Allow and remember", "允许并记住"), "remember", p.permId, "allow_remember"),
    permButton(t("Always allow (persist)", "永久允许（写入项目）"), "remember", p.permId, "allow_always"),
    permButton(t("Deny", "拒绝"), "deny", p.permId, "deny"),
  );
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
