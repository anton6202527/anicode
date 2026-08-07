/**
 * App —— Ink 前端，只依赖 SessionHost 接口（本地 or daemon 一视同仁）。
 *
 * 职责：订阅当前会话的事件流并渲染；收集输入（含 /斜杠命令）；把权限请求
 * 变成 y/a/n 交互回 answerPermission。会话逻辑全在 core，App 不碰。
 *
 * 斜杠命令：/help · /status · /providers · /skills · /model <provider/model> · /sessions · /resume <id> · /new [标题] · /undo · /exit
 */

import * as os from "node:os";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  Box,
  Text,
  useApp,
  useInput,
  useIsScreenReaderEnabled,
  usePaste,
  useStdout,
  useWindowSize,
  type DOMElement,
  type Key,
} from "ink";
import {
  diagnoseProvider,
  discoverSkills,
  expandCommand,
  t,
  getLang,
  setLang,
  onLangChange,
} from "@anicode/core";
import type {
  ChatMessage,
  CustomCommand,
  ModelCatalogEntry,
  NetworkToolDisabledReason,
  NetworkToolStatuses,
  PermissionAnswer,
  PermissionMode,
  PendingPermission,
  ProviderDescriptor,
  SessionEvent,
  SessionHost,
  SessionMeta,
  SessionSummary,
  SkillMeta,
  TodoItem,
  Usage,
} from "@anicode/core";
import { expandFileMentions } from "./mentions.js";
import {
  messagesToItems,
  todosFromMessages,
  firstLine,
  truncate,
  type Item,
} from "./transcript.js";
import { ensureOllama } from "./ollama.js";
import { sanitizeTerminalText } from "./terminal-text.js";
import { MarkdownText } from "./markdown.js";
import { editInExternalEditor } from "./external-editor.js";
import type { TerminalCaretController } from "./terminal-caret.js";
import {
  clampGraphemeIndex,
  graphemes,
  nextGraphemeIndex,
  previousGraphemeIndex,
  sliceTerminalColumns,
} from "./text-layout.js";
import {
  compositeFrame,
  buildModelPickerOverlay,
  buildSessionsOverlay,
  buildPermissionOverlay,
  buildCommandMenuOverlay,
  permissionInputPreview,
  permissionPatchPreview,
  hitTestSprite,
  windowHorizontally,
  dispWidth,
  truncWidth,
  type Sprite,
  type CommandMenuRow,
} from "./overlay.js";

// dispWidth 现居 overlay.ts（合成层与渲染层共用）；沿用旧导出路径供测试引用。
export { dispWidth };

/** transcript 行：既有条目 + 欢迎 logo（logo 放进 Static 只画一次，避免动态区重绘鬼影）。 */
type Row = Item | { kind: "logo" };

interface State {
  /** 只追加的已完成 transcript；Ink Static 不支持原位更新。 */
  items: Row[];
  /** 尚未产生 tool_result 的调用，在 Static 下方动态渲染。 */
  activeTools: Map<string, Extract<Item, { kind: "tool" }>>;
  /** 运行中 task（子 agent）的实时活动行，键=task 调用 id；子 agent 结束即清除。 */
  subagentActivity: Map<string, string>;
  liveText: string;
  /** 流式思考过程（thinking 增量）；正文开始后收起，不入 transcript。 */
  liveThinking: string;
  running: boolean;
  usage: Usage;
  /** 会话累计成本估算（美元）；模型无内置价格信息时为 undefined。 */
  costUSD?: number;
  todos: TodoItem[];
  meta: { id: string; cwd: string; model: string; title?: string };
  /** Core snapshot is authoritative; false means the SessionManager has enforced restricted mode. */
  workspaceTrusted: boolean;
  /** inspection-failed is stricter than an ordinary untrusted workspace. */
  workspaceTrustReason: string | undefined;
  /** 每次成功 open 都重挂 Static，避免会话切换时沿用旧索引。 */
  generation: number;
  opening: boolean;
}

type Action =
  | {
      t: "reset";
      items: Row[];
      activeTools: Map<string, Extract<Item, { kind: "tool" }>>;
      usage: Usage;
      costUSD?: number;
      running: boolean;
      todos: TodoItem[];
      meta: State["meta"];
      workspaceTrusted: boolean;
      workspaceTrustReason: string | undefined;
    }
  | { t: "opening"; v: boolean; restrict?: boolean }
  | { t: "push"; item: Item }
  | { t: "live"; delta: string }
  | { t: "liveThinking"; delta: string }
  | { t: "resetLive" }
  | { t: "flushLive" }
  | { t: "toolStart"; id: string; name: string; ruleKey: string }
  | { t: "toolDeny"; id: string }
  | { t: "toolFinish"; id: string; status: "ok" | "err"; detail?: string }
  | { t: "subagentActivity"; id: string; line: string }
  | { t: "running"; v: boolean }
  | { t: "usage"; u: Usage; costUSD?: number }
  | { t: "title"; title: string }
  | { t: "todos"; todos: TodoItem[] }
  | { t: "workspaceTrust"; trusted: boolean; reason?: string };

/** UI cache only; durable history remains in SessionHost. Keep Yoga/node work bounded. */
export const MAX_TRANSCRIPT_ROWS = 1_000;
export const MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
export const MAX_LIVE_TEXT_CHARS = 256 * 1024;
const MAX_LIVE_THINKING_CHARS = 32 * 1024;
const MAX_ACTIVE_TOOLS = 200;
const MAX_TODOS = 200;
const MAX_PENDING_PERMISSIONS = 100;
const MAX_SESSION_PICKER_ROWS = 1_000;

function normalizeTranscriptRow(row: Row): Row {
  if (row.kind === "logo") return row;
  if (row.kind === "tool") {
    return {
      ...row,
      name: terminalDisplayText(row.name, 4 * 1024),
      ruleKey: terminalDisplayText(row.ruleKey, 16 * 1024),
      ...(row.detail ? { detail: terminalDisplayText(row.detail, 16 * 1024) } : {}),
    };
  }
  return { ...row, text: terminalDisplayText(row.text) };
}

function transcriptRowBytes(row: Row): number {
  if (row.kind === "logo") return 8;
  if (row.kind === "tool") {
    return Buffer.byteLength(row.id + row.name + row.ruleKey + (row.detail ?? ""), "utf8") + 64;
  }
  return Buffer.byteLength(row.text, "utf8") + 32;
}

function boundNormalizedTranscriptRows(rows: Row[], max: number, maxBytes: number): Row[] {
  if (max <= 0 || maxBytes <= 0 || rows.length === 0) return [];
  const last = rows[rows.length - 1]!;
  if (max === 1) return [last];

  // Preserve the session boundary plus one contiguous recent tail. If the newest
  // row alone exceeds the byte budget (for example an adversarial tool id), keep
  // it so the UI never hides the current operation; its display fields are capped.
  const first = rows[0]!;
  const tail: Row[] = [];
  let bytes = transcriptRowBytes(first);
  for (let i = rows.length - 1; i >= 1 && tail.length < max - 1; i--) {
    const row = rows[i]!;
    const rowBytes = transcriptRowBytes(row);
    if (tail.length > 0 && bytes + rowBytes > maxBytes) break;
    tail.push(row);
    bytes += rowBytes;
  }
  tail.reverse();
  return tail.length === rows.length - 1 ? rows : [first, ...tail];
}

export function boundTranscriptRows(
  rows: Row[],
  max = MAX_TRANSCRIPT_ROWS,
  maxBytes = MAX_TRANSCRIPT_BYTES,
): Row[] {
  return boundNormalizedTranscriptRows(rows.map(normalizeTranscriptRow), max, maxBytes);
}

function appendTranscriptRow(rows: Row[], row: Row): Row[] {
  return boundNormalizedTranscriptRows(
    [...rows, normalizeTranscriptRow(row)],
    MAX_TRANSCRIPT_ROWS,
    MAX_TRANSCRIPT_BYTES,
  );
}

function boundActiveTools(
  tools: Map<string, Extract<Item, { kind: "tool" }>>,
): Map<string, Extract<Item, { kind: "tool" }>> {
  const recent = [...tools.entries()].slice(-MAX_ACTIVE_TOOLS);
  return new Map(
    recent.map(([id, tool]) => [
      id,
      normalizeTranscriptRow(tool) as Extract<Item, { kind: "tool" }>,
    ]),
  );
}

function boundTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos.slice(0, MAX_TODOS).map((todo) => ({
    ...todo,
    content: terminalInlineText(todo.content),
    ...(todo.activeForm ? { activeForm: terminalInlineText(todo.activeForm) } : {}),
  }));
}

function appendBoundedText(current: string, delta: string, max: number): string {
  const next = current + delta;
  if (next.length <= max) return next;
  return `… ${t("older live output omitted", "较早的实时输出已省略")} …\n${next.slice(-max)}`;
}

function strictWorkspaceInspectionNotice(cwd: string): string {
  return t(
    `Workspace inspection failed: the strict read-only safety lock is enforced for ${cwd}. Only built-in read/glob/grep are available; writes, edits, bash, MCP, hooks, project extensions, and network access are disabled. Resolve the inspection error and reopen the session.`,
    `工作区检查失败：${cwd} 已启用严格只读安全锁。仅可使用内置 read/glob/grep；写入、编辑、bash、MCP、hooks、项目扩展和网络访问均已禁用。请排除检查错误后重新打开会话。`,
  );
}

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case "reset":
      return {
        items: boundTranscriptRows(a.items),
        activeTools: boundActiveTools(a.activeTools),
        subagentActivity: new Map(),
        liveText: "",
        liveThinking: "",
        running: a.running,
        usage: a.usage,
        ...(a.costUSD !== undefined ? { costUSD: a.costUSD } : {}),
        todos: boundTodos(a.todos),
        meta: a.meta,
        workspaceTrusted: a.workspaceTrusted,
        workspaceTrustReason: a.workspaceTrustReason,
        generation: s.generation + 1,
        opening: false,
      };
    case "opening":
      return {
        ...s,
        opening: a.v,
        ...(a.v && a.restrict ? { workspaceTrusted: false, workspaceTrustReason: undefined } : {}),
      };
    case "push":
      return { ...s, items: appendTranscriptRow(s.items, a.item) };
    case "live":
      // 正文开始流式后收起思考展示（对齐 Claude Code：thinking 只在酝酿期可见）。
      return {
        ...s,
        liveText: appendBoundedText(s.liveText, a.delta, MAX_LIVE_TEXT_CHARS),
        liveThinking: "",
      };
    case "liveThinking":
      return {
        ...s,
        liveThinking: appendBoundedText(s.liveThinking, a.delta, MAX_LIVE_THINKING_CHARS),
      };
    case "resetLive":
      return { ...s, liveText: "", liveThinking: "" };
    case "flushLive":
      if (!s.liveText) return s.liveThinking ? { ...s, liveThinking: "" } : s;
      return {
        ...s,
        items: appendTranscriptRow(s.items, { kind: "assistant", text: s.liveText }),
        liveText: "",
        liveThinking: "",
      };
    case "toolStart": {
      const activeTools = new Map(s.activeTools);
      if (!activeTools.has(a.id) && activeTools.size >= MAX_ACTIVE_TOOLS) {
        const oldest = activeTools.keys().next().value;
        if (oldest !== undefined) activeTools.delete(oldest);
      }
      const previous = activeTools.get(a.id);
      activeTools.set(a.id, {
        kind: "tool",
        id: a.id,
        name: terminalInlineText(a.name),
        ruleKey: terminalDisplayText(a.ruleKey, 16 * 1024),
        status: previous?.status === "deny" ? "deny" : "run",
      });
      return { ...s, activeTools };
    }
    case "toolDeny": {
      const current = s.activeTools.get(a.id);
      if (!current) return s;
      const activeTools = new Map(s.activeTools);
      activeTools.set(a.id, { ...current, status: "deny" });
      return { ...s, activeTools };
    }
    case "toolFinish": {
      const current = s.activeTools.get(a.id);
      if (!current) return s;
      const activeTools = new Map(s.activeTools);
      activeTools.delete(a.id);
      const status = current.status === "deny" ? "deny" : a.status;
      const item: Extract<Item, { kind: "tool" }> = {
        ...current,
        status,
        ...(a.detail ? { detail: a.detail } : {}),
      };
      // task 结束：清除其子 agent 活动行。
      let subagentActivity = s.subagentActivity;
      if (subagentActivity.has(a.id)) {
        subagentActivity = new Map(subagentActivity);
        subagentActivity.delete(a.id);
      }
      return {
        ...s,
        activeTools,
        subagentActivity,
        items: appendTranscriptRow(s.items, item),
      };
    }
    case "subagentActivity": {
      // 仅对仍在运行的 task 更新（tool_result 后 task 已从 activeTools 移除）。
      if (!s.activeTools.has(a.id)) return s;
      const subagentActivity = new Map(s.subagentActivity);
      subagentActivity.set(a.id, a.line);
      return { ...s, subagentActivity };
    }
    case "running":
      // 任务清单是当前 turn 的瞬时进度，不属于已完成结果；空闲后立即丢弃，
      // 避免下一条 prompt 开始时短暂闪回上一轮清单。
      return a.v ? { ...s, running: true } : { ...s, running: false, todos: [] };
    case "usage":
      return { ...s, usage: a.u, ...(a.costUSD !== undefined ? { costUSD: a.costUSD } : {}) };
    case "title":
      return { ...s, meta: { ...s.meta, title: a.title } };
    case "todos":
      return { ...s, todos: boundTodos(a.todos) };
    case "workspaceTrust": {
      if (s.workspaceTrusted === a.trusted && s.workspaceTrustReason === a.reason) return s;
      const notice = a.trusted
        ? t(
            "Workspace trust was granted; local workspace integrations are available again.",
            "工作区已授予信任；本地工作区集成已恢复。",
          )
        : a.reason === "inspection-failed"
          ? strictWorkspaceInspectionNotice(s.meta.cwd)
          : t(
              `Workspace trust was revoked${a.reason ? ` (${a.reason})` : ""}; local workspace integrations are now disabled.`,
              `工作区信任已撤销${a.reason ? `（${a.reason}）` : ""}；本地工作区集成现已禁用。`,
            );
      return {
        ...s,
        workspaceTrusted: a.trusted,
        workspaceTrustReason: a.reason,
        items: appendTranscriptRow(s.items, { kind: "info", text: notice }),
        // A trust downgrade drains the core session. Do not retain controls for
        // privileged work that belonged to the previous trusted instance.
        ...(a.trusted
          ? {}
          : {
              activeTools: new Map<string, Extract<Item, { kind: "tool" }>>(),
              subagentActivity: new Map<string, string>(),
              todos: [],
            }),
      };
    }
  }
}

/** 思考流只展示尾部：压平空白，按终端宽度截末尾——动态区高度不随思考长度增长。 */
function thinkingTail(s: string, cols: number): string {
  const flat = sanitizeTerminalText(s).replace(/\s+/g, " ").trim();
  const max = Math.max(40, Math.min(cols * 2, 240));
  return flat.length > max ? `…${flat.slice(nextGraphemeIndex(flat, flat.length - max))}` : flat;
}

const emptyUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export const MAX_COMPOSER_BYTES = 128 * 1024;
export const MAX_RENDERED_ITEM_CHARS = 64 * 1024;

export function truncateInputBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  let bytes = 0;
  let output = "";
  for (const part of graphemes(text)) {
    const size = Buffer.byteLength(part.text, "utf8");
    if (bytes + size > maxBytes) return { text: output, truncated: true };
    output += part.text;
    bytes += size;
  }
  return { text: output, truncated: false };
}

/** Normalize untrusted clipboard/input chunks without ever interpreting LF as submit. */
export function normalizePastedInput(
  text: string,
  maxBytes = MAX_COMPOSER_BYTES,
): { text: string; truncated: boolean } {
  const normalized = sanitizeTerminalText(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
  return truncateInputBytes(normalized, maxBytes);
}

export function terminalDisplayText(text: string, max = MAX_RENDERED_ITEM_CHARS): string {
  const safe = sanitizeTerminalText(text);
  if (safe.length <= max) return safe;
  const start = nextGraphemeIndex(safe, safe.length - max);
  return `… ${t("older display content omitted", "较早的显示内容已省略")} …\n${safe.slice(start)}`;
}

/** Render a copy-safe POSIX shell argument without allowing host-owned cwd metadata to add syntax. */
function shellQuote(value: string): string {
  const safe = sanitizeTerminalText(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(safe)) return safe;
  return `'${safe.replaceAll("'", `'\\''`)}'`;
}

/** Metadata belongs on one terminal row; control sequences/newlines are never markup. */
function terminalInlineText(text: string, max = 4 * 1024): string {
  return terminalDisplayText(text, max)
    .replace(/[\t\n]+/g, " ")
    .trim();
}

/** Extract user-authored prompts from a persisted conversation for composer history. */
export function promptHistoryFromMessages(messages: readonly ChatMessage[], max = 200): string[] {
  if (max <= 0) return [];
  const history: string[] = [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const text = message.content
      .filter(
        (part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
          part.type === "text" && !part.internal,
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (!text || history[history.length - 1] === text) continue;
    history.push(text);
    if (history.length > max) history.shift();
  }
  return history;
}

export function lineStart(text: string, cursor: number): number {
  const safe = clampGraphemeIndex(text, cursor);
  return safe === 0 ? 0 : text.lastIndexOf("\n", safe - 1) + 1;
}

export function lineEnd(text: string, cursor: number): number {
  const safe = clampGraphemeIndex(text, cursor);
  const newline = text.indexOf("\n", safe);
  return newline < 0 ? text.length : newline;
}

/** Move one logical composer line while retaining the closest display column. */
export function moveCursorLine(text: string, cursor: number, direction: -1 | 1): number {
  const safe = clampGraphemeIndex(text, cursor);
  const currentStart = lineStart(text, safe);
  const desiredColumn = dispWidth(text.slice(currentStart, safe));
  let targetStart: number;
  let targetEnd: number;
  if (direction < 0) {
    if (currentStart === 0) return safe;
    targetEnd = currentStart - 1;
    targetStart = targetEnd === 0 ? 0 : text.lastIndexOf("\n", targetEnd - 1) + 1;
  } else {
    const currentEnd = lineEnd(text, safe);
    if (currentEnd === text.length) return safe;
    targetStart = currentEnd + 1;
    targetEnd = lineEnd(text, targetStart);
  }
  let width = 0;
  let target = targetStart;
  for (const part of graphemes(text.slice(targetStart, targetEnd))) {
    if (width + part.width > desiredColumn) break;
    width += part.width;
    target = targetStart + part.end;
  }
  return target;
}

/** 品牌名（欢迎页 logo 与状态栏）。 */
export const APP_NAME = "AniCode Zen";

/** 内置斜杠命令（名字不含前导 `/`），供命令补全菜单展示与运行。描述按当前语言取词。 */
function builtinCommands(): CommandMenuRow[] {
  return [
    { name: "help", description: t("Show command help", "显示命令帮助") },
    {
      name: "status",
      description: t(
        "Show current session, model, directory and network tools",
        "显示当前会话、模型、目录与联网工具",
      ),
    },
    {
      name: "tools",
      description: t(
        "Show web_search/webfetch availability and disabled reasons",
        "显示 web_search/webfetch 可用状态与禁用原因",
      ),
    },
    { name: "usage", description: t("Show token and cache usage", "显示 token 与缓存用量") },
    {
      name: "tasks",
      description: t("List background subagent tasks", "列出后台子 agent 任务"),
    },
    {
      name: "tool",
      description: t(
        "Toggle the latest tool output /tool [id]",
        "展开/收起最近工具输出 /tool [id]",
      ),
    },
    { name: "editor", description: t("Edit the prompt in $EDITOR", "使用 $EDITOR 编辑提示词") },
    {
      name: "providers",
      description: t("List providers and credential hints", "列出 provider 及凭证提示"),
    },
    {
      name: "model",
      description: t(
        "Model picker (Tab=next prompt only); /model <spec> [once]",
        "模型选择器（Tab=仅下一条）；/model <spec> [once]",
      ),
    },
    { name: "sessions", description: t("List recent sessions", "列出最近会话") },
    { name: "reconnect", description: t("Reconnect the session stream", "重新连接会话事件流") },
    {
      name: "mouse",
      description: t(
        "Toggle full mouse tracking; off keeps native text selection",
        "切换完整鼠标跟踪；关闭时保留终端原生框选",
      ),
    },
    {
      name: "resume",
      description: t("Resume an existing session /resume <id>", "载入已有会话 /resume <id>"),
    },
    {
      name: "new",
      description: t("New session with current model and directory", "以当前模型和目录新建会话"),
    },
    {
      name: "undo",
      description: t(
        "Rewind the last turn /undo [files|conversation|both] (default files)",
        "回滚上一轮 /undo [files|conversation|both]（默认仅文件）",
      ),
    },
    {
      name: "fork",
      description: t(
        "Fork this session into a new one /fork [title]",
        "把当前会话分叉成新会话 /fork [标题]",
      ),
    },
    {
      name: "profile",
      description: t(
        "Switch permission profile /profile [name] (default/workspace/full)",
        "切换权限档位 /profile [name]（default/workspace/full）",
      ),
    },
    {
      name: "init",
      description: t(
        "Analyze this repo and generate AGENTS.md project memory",
        "分析当前仓库并生成 AGENTS.md 项目记忆",
      ),
    },
    {
      name: "diff",
      description: t("Show working tree changes (incl. untracked)", "查看工作区改动（含未跟踪）"),
    },
    {
      name: "review",
      description: t(
        "Code review: /review [uncommitted|branch <base>|commit <sha>|<custom>]",
        "代码审查：/review [uncommitted|branch <base>|commit <sha>|自定义指令]",
      ),
    },
    {
      name: "compact",
      description: t(
        "Compact conversation context now (summarize older turns)",
        "立即压缩上下文（把较早的对话折叠成摘要）",
      ),
    },
    {
      name: "skills",
      description: t(
        "List auto-detected skills and their availability",
        "列出自动发现的技能及其可用状态",
      ),
    },
    {
      name: "mcp",
      description: t("Show MCP servers, resources and prompts", "查看 MCP 服务器、资源与提示模板"),
    },
    {
      name: "lang",
      description: t("Switch UI language /lang <en|zh>", "切换界面语言 /lang <en|zh>"),
    },
    { name: "exit", description: t("Exit", "退出") },
  ];
}

/**
 * 依据输入框内容筛选斜杠命令补全项。仅在「正在敲命令名」阶段返回非空：
 * 以 `/` 开头且尚未出现空格（还没进参数）。空 `/` 列全部；否则前缀匹配优先，
 * 无前缀命中再回落子串匹配。
 */
export function matchCommands(all: readonly CommandMenuRow[], text: string): CommandMenuRow[] {
  if (!text.startsWith("/")) return [];
  const rest = text.slice(1);
  if (/\s/.test(rest)) return [];
  const q = rest.toLowerCase();
  if (q === "") return [...all];
  const prefix = all.filter((c) => c.name.toLowerCase().startsWith(q));
  if (prefix.length > 0) return prefix;
  return all.filter((c) => c.name.toLowerCase().includes(q));
}

/**
 * shift+tab 权限模式轮盘（对齐 Claude Code 的循环切换）：
 * default 逐项确认 → acceptEdits 自动放行编辑 → bypass 全自动跳过授权 → 回到 default。
 * 切到 default 之外任一档都免去逐次授权；bypass 最危险，只跳过授权但压不过显式 deny/ask 规则。
 */
export const PERM_CYCLE: readonly PermissionMode[] = ["default", "acceptEdits", "bypass"];

/** 当前权限模式的状态行提示（default 无提示，返回 null）。i18n 双语。 */
export function permModeHint(mode: PermissionMode): string | null {
  switch (mode) {
    case "acceptEdits":
      return t("⏵⏵ accept edits on (Shift+Tab to cycle)", "⏵⏵ 自动接受编辑（Shift+Tab 切换）");
    case "plan":
      return t("⏸ strict read-only safety lock", "⏸ 严格只读安全锁");
    case "auto":
    case "bypass":
      return t(
        "⏵⏵ bypass permissions on (Shift+Tab to cycle)",
        "⏵⏵ 跳过所有授权（Shift+Tab 切换）",
      );
    default:
      return null;
  }
}

/** 切模式时给会话流的一句反馈（default 也给，说明回到逐项确认）。i18n 双语。 */
export function permModeNotice(mode: PermissionMode): string {
  switch (mode) {
    case "acceptEdits":
      return t(
        "Permission mode: accept edits — auto-approve file edits; bash still asks",
        "权限模式：自动接受编辑 —— 文件编辑自动放行，bash 等仍会询问",
      );
    case "plan":
      return t("Strict read-only safety lock is active.", "严格只读安全锁已启用。");
    case "auto":
    case "bypass":
      return t(
        "Permission mode: bypass — auto-approve everything except deny/ask rules",
        "权限模式：跳过授权 —— 除 deny/ask 规则外一律自动放行",
      );
    default:
      return t(
        "Permission mode: normal — confirm each side-effecting action",
        "权限模式：普通 —— 逐项确认有副作用的动作",
      );
  }
}

/** 会话选择器的本地即时筛选；标题优先，同时支持 id / model / cwd。 */
export function filterSessionRows(
  rows: readonly SessionSummary[],
  filter: string,
): SessionSummary[] {
  const q = filter.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter((row) =>
    [row.title, row.id, row.model, row.cwd].some((value) => value?.toLowerCase().includes(q)),
  );
}
// 生成中的 braille spinner 帧（对齐 opencode 的动画指示手感）。
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 元素相对整帧顶端的行号：yoga 只给出相对父节点的偏移，逐级累加即绝对行。 */
function absoluteTop(el: DOMElement): number {
  let top = 0;
  for (let n: DOMElement | undefined = el; n; n = n.parentNode) {
    top += n.yogaNode?.getComputedTop() ?? 0;
  }
  return top;
}

/**
 * Ink 的 clearTerminal 全屏擦除序列（`ESC[2J`=清屏 `ESC[3J`=清回滚 `ESC[H`=归位）。
 * 整帧高度 >= 终端高度时 Ink 每帧都以它开头（见 ink/build/ink.js 的 outputHeight 分支）。
 */
const INK_CLEAR_TERMINAL = "\x1b[2J\x1b[3J\x1b[H";

/**
 * 把 Ink 的「先擦成空屏再重画」改写成「原地重绘」，消除逐键全屏闪烁/抖动。
 *
 * 整帧高度 == 终端高度 → Ink 每帧先发 `ESC[2J ESC[3J`（连回滚一起擦成空白）再从
 * 第 1 行重画；两步之间终端会短暂全白，逐键输入时就是肉眼可见的抖动。这里不擦屏，
 * 只归位到左上角（`ESC[H`），并在每行末尾补 `ESC[K` 擦到行尾覆盖旧字符、帧末补
 * `ESC[J` 清掉下方残留——屏幕栅格始终有效，绝不出现空帧。行首各补 `ESC[0m` 复位，
 * 避免 BCE 用上一段的背景色去擦行。
 *
 * 关键：仍保留 `ESC[H` 归位，故帧首行 == 终端第 1 行不变，下面按绝对坐标停放 IME
 * 光标的算法（absoluteTop(panel)+2）依旧成立。
 */
function inPlaceRedraw(chunk: string, overlay: Sprite | null): string {
  const body = chunk.slice(INK_CLEAR_TERMINAL.length);
  let lines = body.split("\n");
  // 浮层弹框：把精灵行覆盖到整帧对应行的中间列上，背景四周照旧透出（对齐 opencode）。
  if (overlay) lines = compositeFrame(lines, overlay);
  return "\x1b[H" + lines.map((l) => l + "\x1b[0m\x1b[K").join("\n") + "\x1b[0m\x1b[K\x1b[J";
}

/**
 * 把终端真实光标停在输入框插入点上。
 *
 * 输入法候选框由终端按真实光标位置弹出，而 Ink 画完一帧后光标停在画面末尾，
 * 中文候选框因此卡在右下角。见 inPlaceRedraw：我们把整帧重绘钉在终端第 1 行起，
 * 故帧内行号 == 终端行号，可以直接按绝对坐标停放光标，也不会干扰下一帧的重画起点。
 *
 * onRender 有 32ms 节流、可能晚于 React effect 触发，所以这里包住 stdout.write：
 * 每次写出前藏起光标、写完后按最新坐标重新停放。返回值需在每次提交后调用以更新坐标。
 */
interface FrameCompositor {
  /** 把真实光标停到插入点（输入法候选框跟随）；null 表示藏起（弹框打开时）。 */
  setCaret: (target: { row: number; col: number } | null) => void;
  /** 设置/清除当前浮层弹框精灵；下一帧写出时合成到整帧上。 */
  setOverlay: (overlay: Sprite | null) => void;
}

function useFrameCompositor(enabled: boolean): FrameCompositor {
  const targetRef = useRef<{ row: number; col: number } | null>(null);
  const overlayRef = useRef<Sprite | null>(null);
  // 最近一帧 Ink 的原始清屏帧；弹框开/关/翻页时据此立刻重合成，不必等下一次 Ink 渲染。
  const lastChunkRef = useRef<string | null>(null);
  const parkRef = useRef<() => void>(() => {});
  const repaintRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    const out = process.stdout;
    if (!out.isTTY) return;
    const orig = out.write.bind(out) as (...args: unknown[]) => boolean;
    const park = () => {
      const t = targetRef.current;
      if (t) orig(`\x1b[${t.row};${t.col}H\x1b[?25h`);
    };
    parkRef.current = park;
    repaintRef.current = () => {
      const chunk = lastChunkRef.current;
      if (!chunk) return;
      orig("\x1b[?25l");
      orig(inPlaceRedraw(chunk, overlayRef.current));
      park();
    };
    out.write = function (...args: unknown[]) {
      // 拦下 Ink 的全屏清屏帧，改成原地重绘 + 合成浮层；其余写出（OSC、park 序列等）原样透传。
      if (typeof args[0] === "string" && args[0].startsWith(INK_CLEAR_TERMINAL)) {
        lastChunkRef.current = args[0];
        args = [inPlaceRedraw(args[0], overlayRef.current), ...args.slice(1)];
      }
      orig("\x1b[?25l");
      const ret = orig(...args);
      park();
      return ret;
    } as NodeJS.WriteStream["write"];
    return () => {
      out.write = orig as NodeJS.WriteStream["write"];
      parkRef.current = () => {};
      repaintRef.current = () => {};
      orig("\x1b[?25l");
    };
  }, [enabled]);
  const setCaret = useCallback((target: { row: number; col: number } | null) => {
    targetRef.current = target;
    parkRef.current();
  }, []);
  const setOverlay = useCallback((overlay: Sprite | null) => {
    const changed = overlayRef.current !== overlay;
    overlayRef.current = overlay;
    // 立刻按新浮层重绘最近一帧：保证弹框开/关/内容变化即时可见，与 Ink 渲染节流解耦。
    if (changed) repaintRef.current();
  }, []);
  return { setCaret, setOverlay };
}

/** 终端尺寸（rows/cols）；resize 时更新。非 TTY（测试）给合理默认值。 */
function useTerminalSize(): { rows: number; cols: number } {
  const { columns, rows } = useWindowSize();
  return {
    rows: rows > 0 ? rows : 24,
    cols: columns > 0 ? columns : 80,
  };
}

const TERMINAL_MOUSE_TRACKING_OFF = "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l";
const TERMINAL_MOUSE_MODES_OFF = `\x1b[?1007l${TERMINAL_MOUSE_TRACKING_OFF}`;

/**
 * 完整跟踪用于点击和 SGR 滚轮；可选择模式只启用 alternate scroll（1007），
 * 让备用屏把滚轮转换成方向键，同时保留无修饰键的终端原生框选。
 */
export function terminalMouseModeSequence(fullTracking: boolean): string {
  return fullTracking
    ? `\x1b[?1007l${TERMINAL_MOUSE_TRACKING_OFF}\x1b[?1000h\x1b[?1006h`
    : `${TERMINAL_MOUSE_TRACKING_OFF}\x1b[?1007h`;
}

type PendingPerm = PendingPermission;

/** Shell network access is intentionally one-shot; the core re-confirms every invocation. */
export function permissionAnswersFor(
  pending: Pick<PendingPermission, "toolName" | "network">,
): readonly PermissionAnswer[] {
  return pending.toolName.toLowerCase() === "bash" && pending.network === true
    ? ["allow", "deny"]
    : ["allow", "allow_remember", "allow_always", "deny"];
}

interface SessionPickerState {
  rows: SessionSummary[];
  index: number;
  filter: string;
}

interface ModelPickerState {
  rows: PickerRow[];
  index: number;
  filter: string;
  /** Identity of this specific picker opening, not merely its visible rows. */
  generation: number;
  /** Session identity captured when the picker was opened. */
  sessionId: string;
  sessionGeneration: number;
}

export interface AppProps {
  host: SessionHost;
  cwd: string;
  model: string;
  sessionId: string;
  /** CLI/daemon 提供的 canonical provider 安全元数据，不含任何 key 值。 */
  providers?: readonly ProviderDescriptor[];
  /** 内置可选模型目录（含免费/开源模型），供 /model 选择器使用。 */
  catalog?: readonly ModelCatalogEntry[];
  /** 测试可覆盖宿主侧模型探测；缺省委托 SessionHost，能力缺失时 fail closed。 */
  discoverModels?: (providerId: string) => Promise<readonly string[] | undefined>;
  /**
   * 仅供未使用生产 CredentialBroker 的嵌入/测试宿主检查当前进程环境。
   * 正式宿主会迁走环境密钥，必须以宿主的模型探测结果为准。
   */
  inspectProviderCredentials?: boolean;
  /** 自定义斜杠命令（.anicode/command/*.md）。 */
  commands?: readonly CustomCommand[];
  /** /mcp 状态查询（server/工具/资源/prompts 概览）；未配置 MCP 时省略。 */
  mcpStatus?: () => Promise<string>;
  /** CLI 版本号，显示在底部状态栏。 */
  version?: string;
  /** 是否启用完整 xterm 鼠标跟踪；默认关闭，保留终端原生框选。 */
  mouse?: boolean;
  /** 旧 stdout 帧合成器仅保留为显式实验开关，生产默认走 Ink 原生渲染。 */
  experimentalOverlay?: boolean;
  /** Deterministic size override for embedding/tests; normal CLI uses useWindowSize. */
  terminalSize?: { rows: number; cols: number };
  keybindings?: Partial<Record<TuiKeybindingAction, string>>;
  /** CLI sets this for a real TTY; embeddings/tests leave terminal modes untouched. */
  terminalControl?: boolean;
  /** CLI-owned absolute terminal caret used to anchor IME composition without global patches. */
  terminalCaret?: TerminalCaretController;
  /** Initial paint only; the first host snapshot replaces this value. */
  workspaceTrusted?: boolean;
  /** Production hosts require an explicit trusted assessment; legacy test hosts may omit it. */
  requireWorkspaceTrust?: boolean;
  /** False for daemon/HTTP clients whose session cwd belongs to another process or machine. */
  canInspectWorkspace?: boolean;
  /** False when this client must not mutate host-owned permission controls (for example remote hosts). */
  allowPermissionControls?: boolean;
  /** Test/embed override; invoked only for a local host selecting an Ollama model. */
  ensureLocalOllama?: () => Promise<
    "running" | "started" | "manual" | "unsafe" | "missing" | "timeout"
  >;
}

export type TuiKeybindingAction =
  | "commandPalette"
  | "externalEditor"
  | "reconnect"
  | "toggleToolOutput"
  | "permissionCycle"
  | "quit";

export const DEFAULT_KEYBINDINGS: Record<TuiKeybindingAction, string> = {
  commandPalette: "ctrl+p",
  externalEditor: "ctrl+g",
  reconnect: "ctrl+r",
  toggleToolOutput: "ctrl+o",
  permissionCycle: "shift+tab",
  quit: "ctrl+q",
};

export function matchesKeybinding(input: string, key: Key, binding: string): boolean {
  const parts = binding
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  const primary = parts[parts.length - 1];
  if (!primary) return false;
  const wantsCtrl = parts.includes("ctrl");
  const wantsShift = parts.includes("shift");
  const wantsMeta = parts.includes("meta") || parts.includes("alt") || parts.includes("option");
  if (key.ctrl !== wantsCtrl || key.meta !== wantsMeta) return false;
  if (wantsShift && !key.shift) return false;
  const rawCode = input.length === 1 ? input.charCodeAt(0) : 0;
  const normalized =
    rawCode >= 1 && rawCode <= 26 ? String.fromCharCode(96 + rawCode) : input.toLowerCase();
  if (primary === "tab") return key.tab;
  if (primary === "enter" || primary === "return") return key.return;
  if (primary === "escape" || primary === "esc") return key.escape;
  return normalized === primary;
}

export function App({
  host,
  cwd,
  model,
  sessionId: initialId,
  providers = [],
  catalog = [],
  discoverModels: discoverModelsOverride,
  inspectProviderCredentials = false,
  commands = [],
  mcpStatus,
  mouse = false,
  experimentalOverlay = false,
  terminalSize,
  keybindings,
  terminalControl = false,
  terminalCaret,
  workspaceTrusted: initialWorkspaceTrusted = true,
  requireWorkspaceTrust = false,
  canInspectWorkspace = true,
  allowPermissionControls = true,
  ensureLocalOllama = ensureOllama,
}: AppProps) {
  const { exit, suspendTerminal } = useApp();
  const discoverModels = useCallback(
    (providerId: string): Promise<readonly string[] | undefined> => {
      if (discoverModelsOverride) return discoverModelsOverride(providerId);
      if (host.discoverModels) return host.discoverModels(providerId);
      return Promise.resolve(undefined);
    },
    [discoverModelsOverride, host],
  );
  const screenReader = useIsScreenReaderEnabled();
  const suspendTerminalWithCaret = useCallback(
    async (callback: () => void | Promise<void>): Promise<void> => {
      terminalCaret?.pause();
      try {
        await suspendTerminal(callback);
      } finally {
        terminalCaret?.resume();
      }
    },
    [suspendTerminal, terminalCaret],
  );
  const detectedSize = useTerminalSize();
  const termRows = Math.max(1, terminalSize?.rows ?? detectedSize.rows);
  const termCols = Math.max(1, terminalSize?.cols ?? detectedSize.cols);
  const bindings = useMemo(() => ({ ...DEFAULT_KEYBINDINGS, ...keybindings }), [keybindings]);
  const { stdout } = useStdout();
  const [mouseTracking, setMouseTracking] = useState(mouse);
  useEffect(() => setMouseTracking(mouse), [mouse]);
  // 浮层模式：仅当 Ink 直接驱动真实 TTY 时启用「盖屏弹框」帧合成；
  // ink-testing 用的是另一个 stdout（stdout !== process.stdout），仍走 in-tree 渲染，测试不受影响。
  const overlayMode = experimentalOverlay && terminalControl && !!stdout.isTTY;
  const [sessionId, setSessionId] = useState(initialId);
  const [reconnectGeneration, reconnect] = useReducer((value: number) => value + 1, 0);
  const [state, dispatch] = useReducer(reducer, {
    items: [],
    activeTools: new Map(),
    subagentActivity: new Map(),
    liveText: "",
    liveThinking: "",
    running: false,
    usage: emptyUsage,
    todos: [],
    meta: { id: initialId, cwd, model },
    workspaceTrusted: requireWorkspaceTrust
      ? initialWorkspaceTrusted === true
      : initialWorkspaceTrusted,
    workspaceTrustReason: undefined,
    generation: 0,
    opening: true,
  });
  const [input, setInput] = useState("");
  const [expandedToolIds, setExpandedToolIds] = useState<Set<string>>(() => new Set());
  // 光标位置（0..input.length）。用 ref 与渲染态双写，保证同 tick 内多次编辑基于最新值。
  const [cursor, setCursor] = useState(0);
  // 输入面板节点 + 真实光标停放（输入法候选框跟随真实光标）。
  const panelRef = useRef<DOMElement | null>(null);
  const { setCaret, setOverlay } = useFrameCompositor(overlayMode);
  const absoluteCaretEnabled =
    terminalControl && !!stdout.isTTY && !overlayMode && terminalCaret?.enabled === true;
  const cursorRef = useRef(0);
  // 已提交行的历史，供 ↑/↓ 回溯（最新在末尾）。histRef 为当前浏览位置（null=不在浏览）。
  const historyRef = useRef<string[]>([]);
  const histPosRef = useRef<number | null>(null);
  const recordPromptHistory = useCallback((raw: string): void => {
    const text = raw.trim();
    if (!text) return;
    const history = historyRef.current;
    if (history[history.length - 1] !== text) history.push(text);
    if (history.length > 200) history.shift();
  }, []);
  // 同一 tick 内的分块输入必须基于最新值，而不是 React 上一帧的闭包。
  const inputRef = useRef("");
  // 权限请求队列：并行只读工具可能同时产生多个 ask（如 askRules 命中），逐个裁决
  const [pendings, setPendings] = useState<PendingPerm[]>([]);
  // Ink can emit a key event in the narrow window after a newly rendered frame is visible but
  // before useInput's effect-event closure has refreshed. Keep the visible queue available
  // synchronously so the first key pressed on a permission dialog is never dropped.
  const pendingsRef = useRef<PendingPerm[]>(pendings);
  pendingsRef.current = pendings;
  const [permissionIndex, setPermissionIndex] = useState(0);
  const permissionIndexRef = useRef(0);
  const setPermissionSelection = useCallback((index: number, optionCount = 4) => {
    const count = Math.max(1, optionCount);
    const value = ((index % count) + count) % count;
    permissionIndexRef.current = value;
    setPermissionIndex(value);
  }, []);
  const [sessions, setSessions] = useState<SessionPickerState | null>(null);
  const activePermissionId = pendings[0]?.permId;
  const activePermissionRisk = pendings[0]?.risk;
  useLayoutEffect(() => {
    const active = pendings[0];
    const options = active ? permissionAnswersFor(active) : [];
    setPermissionSelection(
      activePermissionRisk === "high" ? options.length - 1 : 0,
      options.length,
    );
  }, [activePermissionId, activePermissionRisk, pendings, setPermissionSelection]);
  useEffect(() => {
    if (activePermissionId && terminalControl && stdout.isTTY) stdout.write("\x07");
  }, [activePermissionId, stdout, terminalControl]);
  // /model 选择器：非空即打开，index 为高亮项，filter 为搜索词。
  const [picker, setPicker] = useState<ModelPickerState | null>(null);
  /** Invalidates selection verification when a picker closes/reopens or another choice starts. */
  const modelPickerGenerationRef = useRef(0);
  const modelSelectionGenerationRef = useRef(0);
  // /lang 切换语言：整屏重渲染，让所有 t() 就地重取。
  const [, bumpLang] = useReducer((n: number) => n + 1, 0);
  useEffect(() => onLangChange(bumpLang), []);
  // 斜杠命令补全菜单：内置命令 + 自定义命令；菜单开关由输入框内容派生，menuIndex 为高亮项。
  // 依赖 getLang() 使切换语言时描述随之更新。
  const lang = getLang();
  const allCommands = useMemo<CommandMenuRow[]>(
    () => [
      ...builtinCommands(),
      ...(state.workspaceTrusted
        ? commands.map((c) => ({
            name: c.name,
            description: c.description || t("Custom command", "自定义命令"),
          }))
        : []),
    ],
    // lang 是有意的重算触发器：builtinCommands()/t() 读的是当前语言，切换时须重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [commands, lang, state.workspaceTrusted],
  );
  const [menuIndex, setMenuIndex] = useState(0);
  const menuIndexRef = useRef(0);
  // OpenCode 同款 leader：Ctrl+X 后接一键命令；状态短暂显示在输入框下方。
  const [leaderPending, setLeaderPending] = useState(false);
  const leaderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 权限模式由宿主快照恢复；内部 plan 值仅用于检查失败后的严格只读安全锁兼容。
  // UI ref 统一承接 Shift+Tab 与 /profile，再由宿主快照校准。
  const [permMode, setPermMode] = useState<PermissionMode>("default");
  const permModeRef = useRef<PermissionMode>("default");
  const updatePermMode = useCallback((mode: PermissionMode): void => {
    permModeRef.current = mode;
    setPermMode(mode);
  }, []);
  // per-prompt 模型覆盖：仅下一条消息生效（/model <spec> once 或选择器里 Tab 设定）。
  const [nextModel, setNextModel] = useState<string | null>(null);
  const activeSessionRef = useRef({ id: sessionId, generation: state.generation });
  activeSessionRef.current = { id: sessionId, generation: state.generation };
  const workspaceTrustedRef = useRef(state.workspaceTrusted);
  const workspaceTrustReasonRef = useRef<string | undefined>(state.workspaceTrustReason);
  const permissionControlsEnabled =
    allowPermissionControls &&
    state.workspaceTrusted &&
    state.workspaceTrustReason !== "inspection-failed";

  const closeModelPicker = useCallback((): void => {
    modelPickerGenerationRef.current++;
    modelSelectionGenerationRef.current++;
    setPicker(null);
  }, []);

  const switchSession = useCallback(
    (id: string): void => {
      // Invalidate old async picker work synchronously, before React commits the
      // session state change. This closes the event-loop race with a resolved verification.
      modelPickerGenerationRef.current++;
      modelSelectionGenerationRef.current++;
      activeSessionRef.current = { id, generation: state.generation };
      setPicker(null);
      setNextModel(null);
      setSessionId(id);
    },
    [state.generation],
  );

  useEffect(() => {
    if (state.workspaceTrusted) return;
    // Restricted workspaces still use the ordinary per-action permission dialog for built-in
    // tools. Pending requests are cleared only by the authoritative downgrade, so later requests
    // (including askRules on strict read/glob/grep) remain answerable and cannot deadlock a drive.
    setExpandedToolIds(new Set());
    const strict = state.workspaceTrustReason === "inspection-failed";
    updatePermMode(strict ? "plan" : "default");
  }, [state.workspaceTrustReason, state.workspaceTrusted, updatePermMode]);
  // 超窄终端下弹框横向滚动偏移（列）；仅当弹框比屏还宽时生效，切换弹框时归零。
  const [hoff, setHoff] = useState(0);
  const hoffRef = useRef(0);
  const setHscroll = useCallback((n: number): void => {
    const v = Math.max(0, n);
    hoffRef.current = v;
    setHoff(v);
  }, []);
  const setMenuIdx = useCallback((i: number): void => {
    menuIndexRef.current = i;
    setMenuIndex(i);
  }, []);
  const menuWheelRef = useRef({ delta: 0, size: 0 });
  const menuWheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queueMenuWheel = useCallback(
    (delta: number, size: number): void => {
      menuWheelRef.current.delta += delta;
      menuWheelRef.current.size = size;
      if (menuWheelTimerRef.current) return;
      menuWheelTimerRef.current = setTimeout(() => {
        menuWheelTimerRef.current = null;
        const pending = menuWheelRef.current;
        menuWheelRef.current = { delta: 0, size: 0 };
        if (pending.size > 0) {
          setMenuIdx(Math.max(0, Math.min(menuIndexRef.current + pending.delta, pending.size - 1)));
        }
      }, 0);
    },
    [setMenuIdx],
  );
  useEffect(
    () => () => {
      if (menuWheelTimerRef.current) clearTimeout(menuWheelTimerRef.current);
    },
    [],
  );
  // 默认只启用 alternate scroll：滚轮转为方向键，鼠标仍由终端负责原生拖选。
  // --mouse 或 /mouse on 才启用完整点击/SGR 滚轮跟踪；iTerm2 下可按 Option 临时选字。
  useEffect(() => {
    if (!terminalControl || !stdout.isTTY) return;
    stdout.write(terminalMouseModeSequence(mouseTracking));
    return () => {
      stdout.write(TERMINAL_MOUSE_MODES_OFF);
    };
  }, [mouseTracking, stdout, terminalControl]);
  const conversationEmpty =
    !state.items.some((i) => i.kind === "user" || i.kind === "assistant" || i.kind === "tool") &&
    !state.liveText &&
    state.activeTools.size === 0;
  // 回看滚动偏移：0=贴底看最新，>0=结果视口向上回看的终端行数。
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollOffsetRef = useRef(0);
  const transcriptViewportRef = useRef<DOMElement | null>(null);
  const transcriptContentRef = useRef<DOMElement | null>(null);
  const transcriptMetricsRef = useRef<{ content: number; viewport: number } | null>(null);
  const maxTranscriptScroll = useCallback((): number => {
    const viewport = transcriptViewportRef.current?.yogaNode?.getComputedHeight() ?? 0;
    const content = transcriptContentRef.current?.yogaNode?.getComputedHeight() ?? 0;
    return Math.max(0, content - viewport);
  }, []);
  const scrollTranscript = useCallback(
    (rows: number): void => {
      const next = Math.max(0, Math.min(scrollOffsetRef.current + rows, maxTranscriptScroll()));
      scrollOffsetRef.current = next;
      setScrollOffset(next);
    },
    [maxTranscriptScroll],
  );
  const resetTranscriptScroll = useCallback((): void => {
    scrollOffsetRef.current = 0;
    setScrollOffset(0);
  }, []);
  // Preserve the visible top row while the transcript grows, rewraps on resize,
  // or shrinks after a tool is collapsed. At the live bottom, remain pinned there.
  useLayoutEffect(() => {
    const viewport = transcriptViewportRef.current?.yogaNode?.getComputedHeight() ?? 0;
    const content = transcriptContentRef.current?.yogaNode?.getComputedHeight() ?? 0;
    const previous = transcriptMetricsRef.current;
    transcriptMetricsRef.current = { content, viewport };
    if (!previous) return;
    const max = Math.max(0, content - viewport);
    const current = scrollOffsetRef.current;
    const anchored =
      current === 0
        ? 0
        : Math.max(
            0,
            Math.min(current + (content - previous.content) - (viewport - previous.viewport), max),
          );
    if (anchored === current) return;
    scrollOffsetRef.current = anchored;
    setScrollOffset(anchored);
  }, [
    termRows,
    termCols,
    state.items,
    state.liveText,
    state.liveThinking,
    state.activeTools,
    state.subagentActivity,
    state.todos,
    state.running,
    expandedToolIds,
  ]);
  const closeRef = useRef<(() => void) | null>(null);
  const flushRef = useRef<(() => void) | null>(null);
  // 流式生成指示：running 期间以 ~120ms 步进推进 spinner 帧并刷新计时。
  const [spin, setSpin] = useState(0);
  const runStartRef = useRef(0);
  useEffect(() => {
    if (!state.running) return;
    runStartRef.current = Date.now();
    if (screenReader) return;
    const id = setInterval(() => setSpin((n) => n + 1), 120);
    return () => clearInterval(id);
  }, [screenReader, state.running]);

  useEffect(
    () => () => {
      if (leaderTimerRef.current) clearTimeout(leaderTimerRef.current);
    },
    [],
  );

  const beginModelPickerSelection = useCallback((opened: ModelPickerState): (() => boolean) => {
    const selectionGeneration = ++modelSelectionGenerationRef.current;
    const pickerGeneration = opened.generation;
    const selectedSessionId = opened.sessionId;
    const selectedSessionGeneration = opened.sessionGeneration;
    return () => {
      const active = activeSessionRef.current;
      return (
        modelPickerGenerationRef.current === pickerGeneration &&
        modelSelectionGenerationRef.current === selectionGeneration &&
        active.id === selectedSessionId &&
        active.generation === selectedSessionGeneration
      );
    };
  }, []);

  const beginExplicitModelSelection = useCallback((): (() => boolean) => {
    const selectionGeneration = ++modelSelectionGenerationRef.current;
    const selectedSession = { ...activeSessionRef.current };
    return () => {
      const active = activeSessionRef.current;
      return (
        modelSelectionGenerationRef.current === selectionGeneration &&
        active.id === selectedSession.id &&
        active.generation === selectedSession.generation
      );
    };
  }, []);

  const selectModel = useCallback(
    async (spec: string, isCurrent: () => boolean = () => true): Promise<void> => {
      if (!isCurrent()) return;
      // 本地 Ollama 模型只探测 loopback。自动启动必须由用户显式配置可信绝对路径。
      if (spec.startsWith("ollama/") && canInspectWorkspace) {
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text: t("Ensuring the local Ollama is started…", "正在确保本地 Ollama 已启动…"),
          },
        });
        const r = await ensureLocalOllama();
        if (!isCurrent()) return;
        if (r === "unsafe") {
          closeModelPicker();
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "Ollama endpoints must use loopback without URL credentials.",
                "Ollama 端点必须是无 URL 凭据的本机 loopback 地址。",
              ),
            },
          });
          return;
        }
        if (r === "manual") {
          closeModelPicker();
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "Ollama is not running. Start `ollama serve` manually, or explicitly configure ANICODE_OLLAMA_AUTO_START=1 with ANICODE_OLLAMA_EXECUTABLE set to its absolute trusted path.",
                "Ollama 尚未运行。请手动启动 `ollama serve`；或显式设置 ANICODE_OLLAMA_AUTO_START=1，并将 ANICODE_OLLAMA_EXECUTABLE 设为可信绝对路径。",
              ),
            },
          });
          return;
        }
        if (r === "missing") {
          closeModelPicker();
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "The ollama command was not found; please install Ollama first (https://ollama.com).",
                "未检测到 ollama 命令，请先安装 Ollama（https://ollama.com）。",
              ),
            },
          });
          return;
        }
        if (r === "timeout") {
          closeModelPicker();
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "Ollama startup timed out; please run `ollama serve` manually and retry.",
                "Ollama 启动超时，请手动运行 `ollama serve` 后重试。",
              ),
            },
          });
          return;
        }
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text:
              r === "started"
                ? t("Ollama has been started automatically.", "Ollama 已自动启动。")
                : t("Ollama is already running.", "Ollama 已在运行。"),
          },
        });
      }
      // 已有结果时通过 fork 复制完整历史并切换模型。这样 provider/model 仍由 host
      // 持久化校验，又不会把用户从当前结果页送回一个空白欢迎页。空会话和不支持
      // fork 的第三方 host 保留兼容路径，仍创建一个正常的新会话。
      const meta =
        !conversationEmpty && host.forkSession
          ? await host.forkSession(sessionId, {
              model: spec,
              ...(state.meta.title ? { title: state.meta.title } : {}),
            })
          : await host.createSession({ cwd: state.meta.cwd, model: spec });
      if (!isCurrent()) return;
      setSessions(null);
      switchSession(meta.id);
    },
    [
      closeModelPicker,
      canInspectWorkspace,
      conversationEmpty,
      ensureLocalOllama,
      host,
      sessionId,
      state.meta.cwd,
      state.meta.title,
      switchSession,
    ],
  );

  const openSessionPicker = useCallback(async (): Promise<void> => {
    const listed = await host.listSessions();
    const currentRow = listed.find((row) => row.id === sessionId);
    const rows = listed.slice(0, MAX_SESSION_PICKER_ROWS);
    if (currentRow && !rows.some((row) => row.id === currentRow.id)) {
      rows[Math.max(0, MAX_SESSION_PICKER_ROWS - 1)] = currentRow;
    }
    const current = rows.findIndex((row) => row.id === sessionId);
    closeModelPicker();
    setSessions({ rows, index: current >= 0 ? current : 0, filter: "" });
  }, [closeModelPicker, host, sessionId]);

  // 订阅当前会话：载入 snapshot → 渲染，远端流断开后指数退避重连。
  useEffect(() => {
    let closed = false;
    let subscriptionGeneration = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let activeClose: (() => void) | null = null;
    closeRef.current?.();
    closeRef.current = null;
    setPendings([]);
    setExpandedToolIds(new Set());
    closeModelPicker();
    updatePermMode("default"); // snapshot 到达后会替换为宿主的权威模式
    if (requireWorkspaceTrust) {
      workspaceTrustedRef.current = false;
      workspaceTrustReasonRef.current = undefined;
    }
    dispatch({ t: "opening", v: true, restrict: requireWorkspaceTrust });
    // 事件合流：流式 token 高频到达时，把一帧内的事件攒成一批，
    // 用 ~16ms 定时器统一 flush（React18 会自动 batch 这些 dispatch），
    // 把「每 token 一次全屏重渲染」降到 ~60fps 上限。
    const queue: SessionEvent[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (queue.length === 0) return;
      const batch = queue.splice(0, queue.length);
      for (const ev of batch) handleEvent(ev, dispatch, setPendings);
    };
    flushRef.current = flush;
    const MAX_RECONNECT_ATTEMPTS = 5;
    const connect = (attempt: number): void => {
      const generation = ++subscriptionGeneration;
      let ready = false;
      const buffered: SessionEvent[] = [];
      const onEvent = (ev: SessionEvent) => {
        if (closed || generation !== subscriptionGeneration) return;
        const trustUpdate = workspaceTrustUpdateFromEvent(ev);
        if (trustUpdate) {
          workspaceTrustedRef.current = trustUpdate.trusted;
          workspaceTrustReasonRef.current = trustUpdate.reason;
        }
        if (!ready) {
          buffered.push(ev);
          return;
        }
        queue.push(ev);
        if (!flushTimer) flushTimer = setTimeout(flush, 16);
      };
      const retry = (error: unknown): void => {
        if (closed || generation !== subscriptionGeneration) return;
        activeClose = null;
        closeRef.current = null;
        dispatch({ t: "opening", v: false });
        if (attempt >= MAX_RECONNECT_ATTEMPTS) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                `Connection unavailable: ${errorMessage(error)}. Run /reconnect to retry.`,
                `连接不可用：${errorMessage(error)}。运行 /reconnect 重试。`,
              ),
            },
          });
          return;
        }
        const delay = Math.min(8_000, 300 * 2 ** attempt);
        if (attempt === 0) {
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(`Connection lost; retrying in ${delay}ms…`, `连接已断开；${delay}ms 后重试…`),
            },
          });
        }
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect(attempt + 1);
        }, delay);
      };

      void host
        .open(sessionId, onEvent)
        .then((handle) => {
          if (closed || generation !== subscriptionGeneration) {
            handle.close();
            return;
          }
          activeClose = handle.close;
          closeRef.current = handle.close;
          const snap = handle.snapshot;
          const restored = restoreTranscript(snap.messages);
          const workspaceTrusted = requireWorkspaceTrust
            ? snap.workspaceTrust?.trusted === true
            : snap.workspaceTrust?.trusted !== false;
          const workspaceTrustReason = snap.workspaceTrust?.reason;
          workspaceTrustedRef.current = workspaceTrusted;
          workspaceTrustReasonRef.current = workspaceTrustReason;
          const strictWorkspaceInspection =
            !workspaceTrusted && workspaceTrustReason === "inspection-failed";
          const snapshotPermissionMode = strictWorkspaceInspection
            ? "plan"
            : !workspaceTrusted &&
                snap.permissionMode !== undefined &&
                snap.permissionMode !== "default" &&
                snap.permissionMode !== "plan"
              ? "default"
              : (snap.permissionMode ?? "default");
          updatePermMode(snapshotPermissionMode);
          const initialItems: Row[] = [
            sessionBoundary(snap.meta),
            ...(workspaceTrusted
              ? []
              : [
                  {
                    kind: "info" as const,
                    text: strictWorkspaceInspection
                      ? strictWorkspaceInspectionNotice(snap.meta.cwd)
                      : t(
                          `Restricted workspace (${workspaceTrustReason ?? "not-trusted"}): built-in write/edit/apply_patch/bash tools remain available with per-action authorization. MCP, hooks, project extensions, and network access are disabled. Use anicode trust grant --cwd ${snap.meta.cwd} in an interactive terminal to restore integrations.`,
                          `工作区处于受限模式（${workspaceTrustReason ?? "not-trusted"}）：内置 write/edit/apply_patch/bash 工具仍可逐项授权；MCP、hooks、项目扩展与网络访问已禁用。可在交互式终端运行 anicode trust grant --cwd ${snap.meta.cwd} 恢复集成。`,
                        ),
                  },
                ]),
            ...restored.items,
          ];
          historyRef.current = promptHistoryFromMessages(snap.messages);
          histPosRef.current = null;
          dispatch({
            t: "reset",
            items: initialItems,
            activeTools: restored.activeTools,
            usage: snap.usage,
            ...(snap.costUSD !== undefined ? { costUSD: snap.costUSD } : {}),
            running: snap.running,
            // 只为仍在运行的恢复会话还原清单；空闲会话中的 todo 属于旧结果。
            todos: snap.running ? todosFromMessages(snap.messages) : [],
            meta: {
              id: snap.meta.id,
              cwd: snap.meta.cwd,
              model: snap.meta.model,
              ...(snap.meta.title ? { title: snap.meta.title } : {}),
            },
            workspaceTrusted,
            workspaceTrustReason,
          });
          setPendings(snap.pendingPermissions);
          resetTranscriptScroll();
          ready = true;
          for (const ev of buffered) {
            const trustUpdate = workspaceTrustUpdateFromEvent(ev);
            if (trustUpdate) {
              workspaceTrustedRef.current = trustUpdate.trusted;
              workspaceTrustReasonRef.current = trustUpdate.reason;
            }
            handleEvent(ev, dispatch, setPendings);
          }
          if (attempt > 0) {
            dispatch({
              t: "push",
              item: { kind: "info", text: t("Connection restored", "连接已恢复") },
            });
          }
          void handle.closed?.then((error) => {
            if (closed || generation !== subscriptionGeneration) return;
            handle.close();
            retry(error ?? new Error(t("subscription closed", "订阅已关闭")));
          });
        })
        .catch(retry);
    };
    connect(0);
    return () => {
      closed = true;
      subscriptionGeneration++;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = null;
      flushRef.current = null;
      activeClose?.();
      closeRef.current = null;
    };
  }, [
    closeModelPicker,
    host,
    reconnectGeneration,
    requireWorkspaceTrust,
    resetTranscriptScroll,
    sessionId,
    updatePermMode,
  ]);

  const toggleToolDetail = useCallback(
    (requestedId?: string): boolean => {
      const tools = state.items.filter(
        (item): item is Extract<Item, { kind: "tool" }> => item.kind === "tool" && !!item.detail,
      );
      const target = requestedId
        ? tools.find((tool) => tool.id === requestedId)
        : tools[tools.length - 1];
      if (!target) return false;
      setExpandedToolIds((current) => {
        const next = new Set(current);
        if (next.has(target.id)) next.delete(target.id);
        else next.add(target.id);
        return next;
      });
      return true;
    },
    [state.items],
  );

  const verifyAdvertisedModel = useCallback(
    async (spec: string, isCurrent: () => boolean = () => true): Promise<boolean> => {
      const slash = spec.indexOf("/");
      const providerId = slash > 0 ? spec.slice(0, slash) : "";
      const modelId = slash > 0 ? spec.slice(slash + 1) : "";
      if (!providerId || !modelId) {
        if (!isCurrent()) return false;
        dispatch({
          t: "push",
          item: {
            kind: "error",
            text: t(
              `Invalid model spec ${spec}; expected <provider/model>`,
              `模型标识 ${spec} 无效；应使用 <provider/model> 格式`,
            ),
          },
        });
        return false;
      }

      let advertised: readonly string[] | undefined;
      try {
        advertised = await discoverModels(providerId);
      } catch {
        advertised = undefined;
      }
      // The picker/session may have changed while discovery was in flight. A
      // stale response must be completely silent, including its error notice.
      if (!isCurrent()) return false;
      if (advertised?.includes(modelId)) return true;

      if (advertised === undefined) {
        const provider = providers.find(
          (candidate) => candidate.id === providerId || candidate.aliases.includes(providerId),
        );
        const credentialHint = provider?.apiKeyEnv.join(" / ");
        const projectEnvUnavailable =
          requireWorkspaceTrust && canInspectWorkspace && !workspaceTrustedRef.current;
        const trustCommand = `anicode trust grant --cwd ${shellQuote(state.meta.cwd)}`;
        dispatch({
          t: "push",
          item: {
            kind: "error",
            text: projectEnvUnavailable
              ? t(
                  `Cannot verify ${spec}: the model endpoint could not be queried, and restricted workspaces do not load project .env credentials. If this project is trusted, run ${trustCommand} in an interactive terminal, restart AniCode, and retry.`,
                  `${spec} 无法从模型端点校验，且受限工作区不会加载项目 .env 凭据。确认项目内容可信后，请在交互式终端运行 ${trustCommand}，重启 AniCode 后重试。`,
                )
              : t(
                  `Cannot verify ${spec}: the model endpoint could not be queried. Check ${credentialHint || "provider credentials"}, endpoint configuration, and network connectivity, then retry.`,
                  `${spec} 无法从模型端点校验。请检查${credentialHint ? ` ${credentialHint}` : " Provider 凭据"}、端点配置和网络连接后重试。`,
                ),
          },
        });
        return false;
      }

      dispatch({
        t: "push",
        item: {
          kind: "error",
          text: t(
            `${spec} is not currently advertised by its model endpoint; the endpoint returned a model list successfully, so choose another endpoint-supported model`,
            `${spec} 当前未被模型端点列为可用；端点已成功返回模型列表，请选择该端点支持的其他模型`,
          ),
        },
      });
      return false;
    },
    [canInspectWorkspace, discoverModels, providers, requireWorkspaceTrust, state.meta.cwd],
  );

  const runSlash = useCallback(
    async (line: string): Promise<boolean> => {
      const [rawCmd = "", ...rest] = line.slice(1).trim().split(/\s+/);
      // 兼容 OpenCode 的常用别名，同时保留 anicode 原有命令名。
      const cmd =
        rawCmd === "models"
          ? "model"
          : rawCmd === "clear"
            ? "new"
            : rawCmd === "continue"
              ? "sessions"
              : rawCmd;
      if (cmd === "exit" || cmd === "quit") {
        exit();
        return true;
      }
      if (cmd === "help") {
        dispatch({ t: "push", item: { kind: "info", text: helpText() } });
        return true;
      }
      if (cmd === "reconnect") {
        reconnect();
        return true;
      }
      if (cmd === "editor") {
        if (!canInspectWorkspace || !workspaceTrustedRef.current) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "The local editor is unavailable for a remote or restricted workspace.",
                "远端或受限工作区中不可使用本地编辑器。",
              ),
            },
          });
          return true;
        }
        try {
          const edited = await editInExternalEditor(inputRef.current, {
            cwd: state.meta.cwd,
            suspendTerminal: suspendTerminalWithCaret,
          });
          const normalized = normalizePastedInput(edited);
          inputRef.current = normalized.text;
          cursorRef.current = normalized.text.length;
          setInput(normalized.text);
          setCursor(normalized.text.length);
          if (normalized.truncated) {
            dispatch({
              t: "push",
              item: {
                kind: "info",
                text: t(
                  "Editor content was truncated to the composer limit",
                  "编辑器内容已按输入上限截断",
                ),
              },
            });
          }
        } catch (error) {
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(error) } });
        }
        return true;
      }
      if (cmd === "tasks") {
        // 临时 open 拿一份新鲜 snapshot（含后台任务摘要）；本地/daemon 两种宿主通吃。
        const handle = await host.open(state.meta.id, () => {});
        handle.close();
        const tasks = handle.snapshot.backgroundTasks ?? [];
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text: tasks.length
              ? tasks
                  .map(
                    (task) =>
                      `${task.id} [${task.status}] ${task.type} · ${task.description}` +
                      (task.worktree ? ` (worktree: ${task.worktree})` : ""),
                  )
                  .join("\n")
              : t("No background tasks", "无后台任务"),
          },
        });
        return true;
      }
      if (cmd === "tool") {
        if (!toggleToolDetail(rest[0])) {
          dispatch({
            t: "push",
            item: { kind: "info", text: t("No matching tool output", "没有匹配的工具输出") },
          });
        }
        return true;
      }
      if (cmd === "status") {
        // 上下文占用取自新鲜 snapshot（最近一轮真实输入 token / 模型窗口，对齐 Codex /status）。
        let ctx = "";
        let networkTools: NetworkToolStatuses | undefined;
        try {
          const handle = await host.open(state.meta.id, () => {});
          handle.close();
          networkTools = handle.snapshot.networkTools;
          const usage = handle.snapshot.contextUsage;
          if (usage) {
            const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
            ctx = usage.window
              ? t(
                  ` · context ${k(usage.tokens)}/${k(usage.window)} (${Math.round((usage.tokens / usage.window) * 100)}%)`,
                  ` · 上下文 ${k(usage.tokens)}/${k(usage.window)}（${Math.round((usage.tokens / usage.window) * 100)}%）`,
                )
              : t(` · context ${k(usage.tokens)} tokens`, ` · 上下文 ${k(usage.tokens)} tokens`);
          }
        } catch {
          /* 上下文信息尽力而为 */
        }
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text:
              t(
                `Session ${state.meta.id} · ${state.meta.model} · ${state.meta.cwd}`,
                `会话 ${state.meta.id} · ${state.meta.model} · ${state.meta.cwd}`,
              ) +
              ` · ${state.running ? t("running", "运行中") : t("idle", "空闲")}` +
              ctx +
              (state.meta.title ? ` · ${state.meta.title}` : "") +
              (networkTools ? `\n${networkToolsText(networkTools)}` : ""),
          },
        });
        return true;
      }
      if (cmd === "tools") {
        const handle = await host.open(state.meta.id, () => {});
        handle.close();
        dispatch({
          t: "push",
          item: { kind: "info", text: networkToolsText(handle.snapshot.networkTools) },
        });
        return true;
      }
      if (cmd === "usage") {
        const usage = state.usage;
        const total =
          usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text:
              t(
                `Input ${usage.inputTokens} · output ${usage.outputTokens} · cache create ${usage.cacheWriteTokens} · cache read ${usage.cacheReadTokens} · total ${total}`,
                `输入 ${usage.inputTokens} · 输出 ${usage.outputTokens} · 缓存写入 ${usage.cacheWriteTokens} · 缓存读取 ${usage.cacheReadTokens} · 合计 ${total}`,
              ) + (state.costUSD !== undefined ? ` · $${state.costUSD.toFixed(4)}` : ""),
          },
        });
        return true;
      }
      if (cmd === "mouse") {
        const requested = (rest[0] ?? "").toLowerCase();
        if (requested && requested !== "on" && requested !== "off") {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t("Usage: /mouse [on|off]", "用法：/mouse [on|off]"),
            },
          });
          return true;
        }
        const enabled = requested ? requested === "on" : !mouseTracking;
        setMouseTracking(enabled);
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text: enabled
              ? t(
                  "Mouse wheel tracking enabled; Option-drag selects in iTerm2, or use /mouse off",
                  "已开启鼠标滚轮跟踪；iTerm2 按住 Option 可拖选，或用 /mouse off",
                )
              : t(
                  "Native text selection and wheel scrolling enabled; PageUp/PageDown also scroll",
                  "已开启原生框选和滚轮回看；PageUp/PageDown 也可回看",
                ),
          },
        });
        return true;
      }
      if (cmd === "providers") {
        dispatch({
          t: "push",
          item: { kind: "info", text: providersText(providers, inspectProviderCredentials) },
        });
        return true;
      }
      if (cmd === "skills") {
        if (!canInspectWorkspace) {
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(
                "The connected host does not expose workspace skill discovery.",
                "当前连接的宿主未开放工作区 Skill 发现。",
              ),
            },
          });
          return true;
        }
        if (!workspaceTrustedRef.current) {
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(
                "Skills are disabled in a restricted workspace.",
                "受限工作区中已禁用 Skills。",
              ),
            },
          });
          return true;
        }
        const skills = await discoverSkills(state.meta.cwd, [], { includeProject: true });
        dispatch({ t: "push", item: { kind: "info", text: skillsText(skills) } });
        return true;
      }
      if (cmd === "model") {
        const spec = rest[0];
        if (!spec) {
          // 浏览阶段只使用非敏感 provider/catalog 元数据，绝不调用鉴权 `/models`。
          // 用户按 Enter/Tab 最终选定后，verifyAdvertisedModel 才只读取该
          // provider 的凭据并做一次在线校验。
          const rows = buildPickerRows(catalog, providers, inspectProviderCredentials);
          if (rows.length === 0) {
            dispatch({
              t: "push",
              item: {
                kind: "error",
                text: t(
                  "No models are present in the local catalog; use /model <provider/model> for an explicit host-validated selection",
                  "本地模型目录为空；可用 /model <provider/model> 显式选择并交由宿主校验",
                ),
              },
            });
            return true;
          }
          setSessions(null);
          const pickerGeneration = ++modelPickerGenerationRef.current;
          modelSelectionGenerationRef.current++;
          const active = activeSessionRef.current;
          setPicker({
            rows,
            index: 0,
            filter: "",
            generation: pickerGeneration,
            sessionId: active.id,
            sessionGeneration: active.generation,
          });
          return true;
        }
        const isCurrent = beginExplicitModelSelection();
        if (!(await verifyAdvertisedModel(spec, isCurrent)) || !isCurrent()) return true;
        // `/model <spec> once`：仅下一条消息用该模型（per-prompt 覆盖），不新建会话。
        if ((rest[1] ?? "").toLowerCase() === "once") {
          if (!isCurrent()) return true;
          setNextModel(spec);
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(
                `Next message will use ${spec} (this prompt only)`,
                `下一条消息将使用 ${spec}（仅这一条）`,
              ),
            },
          });
          return true;
        }
        await selectModel(spec, isCurrent);
        return true;
      }
      if (cmd === "sessions") {
        await openSessionPicker();
        return true;
      }
      if (cmd === "resume") {
        const id = rest[0];
        if (!id) {
          await openSessionPicker();
          return true;
        }
        setSessions(null);
        switchSession(id); // 触发 useEffect 重新订阅
        return true;
      }
      if (cmd === "new") {
        const title = rest.join(" ") || undefined;
        const meta = await host.createSession({
          cwd: state.meta.cwd,
          model: state.meta.model,
          ...(title ? { title } : {}),
        });
        setSessions(null);
        switchSession(meta.id);
        return true;
      }
      if (cmd === "undo") {
        // 参数：可选 mode（files/conversation/both）与可选 checkpoint id，顺序任意。
        const MODES = ["files", "conversation", "both"] as const;
        const modeArg = rest.find((a) => (MODES as readonly string[]).includes(a)) as
          (typeof MODES)[number] | undefined;
        const ckptArg = rest.find((a) => !(MODES as readonly string[]).includes(a));
        // 成功提示由广播的 reverted 事件统一渲染（所有订阅者一致）；这里只兜错误。
        try {
          await host.undo(sessionId, ckptArg, modeArg);
        } catch (err) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(`Undo failed: ${errorMessage(err)}`, `撤销失败：${errorMessage(err)}`),
            },
          });
        }
        return true;
      }
      if (cmd === "fork") {
        if (!host.forkSession) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t("This transport doesn't support fork.", "当前传输不支持 fork。"),
            },
          });
          return true;
        }
        try {
          const title = rest.join(" ") || undefined;
          const meta = await host.forkSession(sessionId, title ? { title } : undefined);
          setSessions(null);
          switchSession(meta.id); // 切到分叉出的新会话；原会话保持不动
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(`⑂ Forked to new session ${meta.id}`, `⑂ 已分叉到新会话 ${meta.id}`),
            },
          });
        } catch (err) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(`Fork failed: ${errorMessage(err)}`, `分叉失败：${errorMessage(err)}`),
            },
          });
        }
        return true;
      }
      if (cmd === "profile") {
        if (!allowPermissionControls) {
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(
                "Permission profiles are owned by the host and cannot be changed from this client.",
                "权限档位由宿主管理，当前客户端无法切换。",
              ),
            },
          });
          return true;
        }
        if (!workspaceTrustedRef.current) {
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(
                "Permission profiles are disabled in a restricted workspace.",
                "受限工作区中已禁用权限档位。",
              ),
            },
          });
          return true;
        }
        if (!host.setPermissionProfile || !host.listPermissionProfiles) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                "This transport doesn't support runtime permission profiles.",
                "当前传输不支持运行时权限档位。",
              ),
            },
          });
          return true;
        }
        const name = (rest[0] ?? "").trim();
        try {
          const profiles = await host.listPermissionProfiles(sessionId);
          const visibleProfiles = Object.entries(profiles).filter(([, profile]) => {
            return profile.mode !== "plan";
          });
          if (!name) {
            // 内部只读安全档位不作为可交互 TUI 档位暴露。
            const lines = visibleProfiles.map(
              ([n, p]) =>
                `  ${n}${p.mode ? ` → ${p.mode}` : ""}${p.description ? ` · ${p.description}` : ""}`,
            );
            dispatch({
              t: "push",
              item: {
                kind: "info",
                text:
                  t("Available permission profiles:", "可用权限档位：") + "\n" + lines.join("\n"),
              },
            });
            return true;
          }
          if (profiles[name]?.mode === "plan") {
            dispatch({
              t: "push",
              item: {
                kind: "error",
                text: t(
                  "Read-only permission profiles are not available in the TUI.",
                  "TUI 不提供只读权限档位。",
                ),
              },
            });
            return true;
          }
          const mode = await host.setPermissionProfile(sessionId, name);
          updatePermMode(mode); // 权限指示与档位保持一致
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(
                `Permission profile: ${name} (mode: ${mode})`,
                `已切换权限档位：${name}（模式 ${mode}）`,
              ),
            },
          });
        } catch (err) {
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        }
        return true;
      }
      if (cmd === "lang") {
        const want = (rest[0] ?? "").toLowerCase();
        const next = want.startsWith("zh")
          ? "zh"
          : want.startsWith("en")
            ? "en"
            : getLang() === "zh"
              ? "en"
              : "zh";
        setLang(next);
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text: t(`Language switched to English`, `界面语言已切换为中文`),
          },
        });
        return true;
      }
      if (cmd === "diff") {
        if (!canInspectWorkspace || !workspaceTrustedRef.current) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: !canInspectWorkspace
                ? t(
                    "/diff is unavailable because this client cannot inspect the host workspace.",
                    "/diff 不可用：当前客户端无法检查宿主工作区。",
                  )
                : t("/diff is disabled in a restricted workspace.", "/diff 在受限工作区中已禁用。"),
            },
          });
          return true;
        }
        const operationSession = { ...activeSessionRef.current };
        const operationIsCurrent = (): boolean => {
          const active = activeSessionRef.current;
          return (
            workspaceTrustedRef.current &&
            active.id === operationSession.id &&
            active.generation === operationSession.generation
          );
        };
        // 对齐 Codex /diff：直接展示当前工作区改动（含未跟踪文件），不经模型。
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const run = promisify(execFile);
        try {
          const [diff, untracked] = await Promise.all([
            run("git", ["-C", state.meta.cwd, "diff", "HEAD", "--stat", "--patch"], {
              maxBuffer: 4 * 1024 * 1024,
            }),
            run("git", ["-C", state.meta.cwd, "ls-files", "--others", "--exclude-standard"]),
          ]);
          if (!operationIsCurrent()) return true;
          const MAX_LINES = 400;
          const lines = diff.stdout.split("\n");
          const body =
            lines.length > MAX_LINES
              ? lines.slice(0, MAX_LINES).join("\n") +
                t(
                  `\n… (${lines.length - MAX_LINES} more lines truncated)`,
                  `\n…（截断 ${lines.length - MAX_LINES} 行）`,
                )
              : diff.stdout;
          const extra = untracked.stdout.trim()
            ? t("\nUntracked:\n", "\n未跟踪文件：\n") +
              untracked.stdout
                .trim()
                .split("\n")
                .map((f) => `  ? ${f}`)
                .join("\n")
            : "";
          const text = (body.trim() || t("(no changes)", "（无改动）")) + extra;
          dispatch({ t: "push", item: { kind: "info", text } });
        } catch (err) {
          if (!operationIsCurrent()) return true;
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        }
        return true;
      }
      if (cmd === "review") {
        // 对齐 Codex /review：uncommitted（默认）/ branch <base> / commit <sha> / 自定义指令。
        const target = rest.join(" ").trim();
        let scope: string;
        if (!target || target === "uncommitted") {
          scope = t(
            "the uncommitted changes (run `git diff HEAD` and `git status --short`; include untracked files)",
            "未提交的改动（执行 `git diff HEAD` 与 `git status --short`，包含未跟踪文件）",
          );
        } else if (rest[0] === "branch") {
          const base = rest[1] ?? "main";
          scope = t(
            `the changes of this branch against merge-base with ${base} (run \`git diff $(git merge-base HEAD ${base})...HEAD\`)`,
            `当前分支相对 ${base} 合并基的改动（执行 \`git diff $(git merge-base HEAD ${base})...HEAD\`）`,
          );
        } else if (rest[0] === "commit") {
          const sha = rest[1] ?? "HEAD";
          scope = t(
            `the commit ${sha} (run \`git show ${sha}\`)`,
            `提交 ${sha}（执行 \`git show ${sha}\`）`,
          );
        } else {
          scope = target; // 自定义审查指令原样交给模型
        }
        const prompt = t(
          `Act as a rigorous code reviewer. Review ${scope}.
Requirements: read the actual diff and surrounding code before judging; verify each finding against the codebase instead of pattern-matching. Report only real issues (correctness bugs, security risks, data loss, race conditions, broken contracts, missing tests for changed behavior) — no style nits unless they hide bugs, no praise. For each finding give: severity (P0/P1/P2), file:line, what breaks and a concrete failure scenario, and a minimal suggested fix. If the changes look sound after genuine verification, say so briefly. Do NOT modify any files.`,
          `请以严格代码审查者的身份审查${scope}。
要求：先读真实 diff 与周边代码再下结论；每个发现都要对照代码库核实，不要凭模式匹配臆断。只报真实问题（正确性 bug、安全风险、数据丢失、竞态、契约破坏、改动行为缺测试）——不报无关风格问题、不写夸奖。每个发现给出：严重级（P0/P1/P2）、file:line、会坏在哪里及具体失败场景、最小修复建议。若认真核实后确无问题，简短说明即可。不要修改任何文件。`,
        );
        dispatch({ t: "running", v: true });
        void host.send(sessionId, prompt).catch((err) => {
          dispatch({ t: "running", v: false });
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
        return true;
      }
      if (cmd === "init") {
        // 对齐 Claude Code /init：引导 agent 调研仓库并沉淀 AGENTS.md（项目记忆，下次会话自动注入）。
        const prompt = t(
          "Analyze this repository (build/test/lint commands, architecture, code conventions, directory layout) and write an AGENTS.md at the repo root as project memory for coding agents. Keep it concise (under ~60 lines), focused on what an agent must know to work here: commands to run, conventions to follow, pitfalls to avoid. If AGENTS.md or CLAUDE.md already exists, improve it instead of overwriting blindly.",
          "请调研当前仓库（构建/测试/lint 命令、架构、代码约定、目录结构），在仓库根目录写一份 AGENTS.md 作为编码 agent 的项目记忆。保持精炼（约 60 行内），聚焦 agent 在这里干活必须知道的信息：要跑的命令、要遵守的约定、要避开的坑。若已存在 AGENTS.md 或 CLAUDE.md，请在其基础上改进而不是盲目覆盖。",
        );
        dispatch({ t: "running", v: true });
        void host.send(sessionId, prompt).catch((err) => {
          dispatch({ t: "running", v: false });
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
        return true;
      }
      if (cmd === "compact") {
        if (!host.compact) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t("This transport doesn't support /compact.", "当前传输不支持 /compact。"),
            },
          });
          return true;
        }
        try {
          const r = await host.compact(sessionId);
          // compacted=true 时广播的 compacted 事件已渲染提示；这里只兜「无可压缩」。
          if (!r.compacted) {
            dispatch({
              t: "push",
              item: {
                kind: "info",
                text: t(
                  "Nothing to compact (history is still short).",
                  "没有可压缩的内容（历史还很短）。",
                ),
              },
            });
          }
        } catch (err) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(`Compact failed: ${errorMessage(err)}`, `压缩失败：${errorMessage(err)}`),
            },
          });
        }
        return true;
      }
      if (cmd === "mcp") {
        if (!workspaceTrustedRef.current) {
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t("MCP is disabled in a restricted workspace.", "受限工作区中已禁用 MCP。"),
            },
          });
          return true;
        }
        if (!mcpStatus) {
          dispatch({
            t: "push",
            item: {
              kind: "info",
              text: t(
                "No MCP servers configured (anicode.json `mcp`).",
                "未配置 MCP 服务器（anicode.json 的 mcp 键）。",
              ),
            },
          });
          return true;
        }
        try {
          dispatch({ t: "push", item: { kind: "info", text: await mcpStatus() } });
        } catch (err) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                `MCP query failed: ${errorMessage(err)}`,
                `MCP 查询失败：${errorMessage(err)}`,
              ),
            },
          });
        }
        return true;
      }
      // 自定义命令（.anicode/command/*.md 或 MCP prompt）：产出提示后发送。
      const custom = workspaceTrustedRef.current ? commands.find((c) => c.name === cmd) : undefined;
      if (custom) {
        let prompt: string;
        try {
          // resolve 型（MCP prompt）异步渲染；静态模板走 expandCommand。
          prompt = custom.resolve
            ? await custom.resolve(rest.join(" "))
            : expandCommand(custom, rest.join(" "));
        } catch (err) {
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                `Command render failed: ${errorMessage(err)}`,
                `命令渲染失败：${errorMessage(err)}`,
              ),
            },
          });
          return true;
        }
        dispatch({ t: "running", v: true });
        void host.send(sessionId, prompt).catch((err) => {
          dispatch({ t: "running", v: false });
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
        return true;
      }
      dispatch({
        t: "push",
        item: { kind: "error", text: t(`Unknown command: /${cmd}`, `未知命令: /${cmd}`) },
      });
      return true;
    },
    [
      host,
      providers,
      catalog,
      inspectProviderCredentials,
      selectModel,
      openSessionPicker,
      state.meta,
      state.running,
      state.usage,
      state.costUSD,
      exit,
      commands,
      canInspectWorkspace,
      allowPermissionControls,
      mcpStatus,
      sessionId,
      updatePermMode,
      reconnect,
      toggleToolDetail,
      suspendTerminalWithCaret,
      mouseTracking,
      beginExplicitModelSelection,
      verifyAdvertisedModel,
      switchSession,
    ],
  );

  // 输入缓冲区与光标一起改写：ref 供同 tick 内连续编辑，state 供渲染。
  // 文本变化时把命令菜单高亮重置到首项（新筛选集从头选），仅移动光标时不动高亮。
  const setBuf = useCallback((text: string, cur: number): void => {
    const c = clampGraphemeIndex(text, cur);
    if (text !== inputRef.current) {
      menuIndexRef.current = 0;
      setMenuIndex(0);
    }
    inputRef.current = text;
    cursorRef.current = c;
    setInput(text);
    setCursor(c);
  }, []);

  const submitLine = useCallback(
    (raw: string): void => {
      resetTranscriptScroll(); // 提交后回到底部跟随最新
      const text = raw.trim();
      recordPromptHistory(text);
      histPosRef.current = null;
      if (!text) return;
      if (text.startsWith("/")) {
        void runSlash(text).catch((err) =>
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } }),
        );
        return;
      }
      // 运行中发送 = steering（core 在 turn 边界注入）；user 条目由事件渲染。
      // @文件只能由拥有该工作区且当前仍受信任的本地客户端展开。远端
      // 客户端必须把原文交给 host，绝不能读取客户端机器上的同名 cwd。
      const modelOverride = nextModel; // per-prompt 覆盖：本条消费掉即清
      if (modelOverride) setNextModel(null);
      dispatch({ t: "running", v: true });
      const mayInspect = canInspectWorkspace && workspaceTrustedRef.current;
      const expansion = mayInspect
        ? expandFileMentions(text, state.meta.cwd)
        : Promise.resolve({ text, missing: [] as string[] });
      void expansion
        .then(({ text: expanded, missing }) => {
          // A trust downgrade may race the filesystem read. Do not send locally
          // expanded contents after the authoritative trust event has arrived.
          const useExpanded = mayInspect && workspaceTrustedRef.current;
          if (useExpanded) {
            for (const m of missing) {
              dispatch({
                t: "push",
                item: {
                  kind: "info",
                  text: t(`@${m}: file not found, kept as-is`, `@${m}: 未找到该文件，已按原文保留`),
                },
              });
            }
          }
          return host.send(
            sessionId,
            useExpanded ? expanded : text,
            modelOverride ? { model: modelOverride } : undefined,
          );
        })
        .catch((err) => {
          dispatch({ t: "running", v: false });
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
    },
    [
      host,
      canInspectWorkspace,
      nextModel,
      recordPromptHistory,
      resetTranscriptScroll,
      runSlash,
      sessionId,
      state.meta.cwd,
    ],
  );

  // Shift+Tab 轮盘仅对受信任工作区开放；检查失败时保留内部只读锁兼容值。
  const cyclePermMode = useCallback((): void => {
    if (workspaceTrustReasonRef.current === "inspection-failed") {
      updatePermMode("plan");
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            "Workspace inspection failed; the strict read-only safety lock cannot be changed.",
            "工作区检查失败；严格只读安全锁无法切换。",
          ),
        },
      });
      return;
    }
    if (!workspaceTrustedRef.current) {
      updatePermMode("default");
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            "Permission controls are fixed in a restricted workspace.",
            "受限工作区中权限模式固定，无法切换。",
          ),
        },
      });
      return;
    }
    if (!allowPermissionControls) {
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            "Permission controls are owned by the host and cannot be changed from this client.",
            "权限设置由宿主管理，当前客户端无法切换。",
          ),
        },
      });
      return;
    }
    if (!host.setPermissionMode) {
      dispatch({
        t: "push",
        item: {
          kind: "error",
          text: t(
            "This transport doesn't support runtime permission modes.",
            "当前传输不支持运行时权限模式切换。",
          ),
        },
      });
      return;
    }
    const cycle = PERM_CYCLE;
    const current = permModeRef.current;
    const cur = cycle.indexOf(current as (typeof cycle)[number]);
    const next = cur < 0 ? "default" : cycle[(cur + 1) % cycle.length]!;
    updatePermMode(next);
    void host.setPermissionMode(sessionId, next).catch((err) => {
      // A later rapid Shift+Tab may already have advanced again; do not let this
      // request's failure roll that newer optimistic state back.
      if (permModeRef.current === next) updatePermMode(current);
      dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
    });
    dispatch({ t: "push", item: { kind: "info", text: permModeNotice(next) } });
  }, [allowPermissionControls, host, sessionId, updatePermMode]);

  // Ink 7 separates bracketed paste from key input. Clipboard text is inserted
  // verbatim (after control-sequence sanitization), including newlines, and is
  // never submitted implicitly—even when the clipboard ends in LF.
  usePaste(
    (pasted) => {
      const normalized = normalizePastedInput(pasted);
      if (!normalized.text) return;
      const buf = inputRef.current;
      const cur = cursorRef.current;
      const available = Math.max(0, MAX_COMPOSER_BYTES - Buffer.byteLength(buf, "utf8"));
      const inserted = truncateInputBytes(normalized.text, available);
      histPosRef.current = null;
      setBuf(buf.slice(0, cur) + inserted.text + buf.slice(cur), cur + inserted.text.length);
      if (normalized.truncated || inserted.truncated) {
        dispatch({
          t: "push",
          item: {
            kind: "info",
            text: t(
              `Paste was truncated at ${MAX_COMPOSER_BYTES / 1024} KiB`,
              `粘贴内容已按 ${MAX_COMPOSER_BYTES / 1024} KiB 上限截断`,
            ),
          },
        });
      }
    },
    { isActive: !picker && !sessions && pendings.length === 0 },
  );

  useInput((ch, key) => {
    const mouse = parseMouseInput(ch);
    // POSIX job control: Ctrl+Z must suspend instead of exiting. Ink's suspension
    // boundary restores raw/alternate-screen state before SIGTSTP and redraws on SIGCONT.
    const ctrlZ = (key.ctrl && ch.toLowerCase() === "z") || ch === "\u001a";
    if (ctrlZ && process.platform !== "win32") {
      void suspendTerminalWithCaret(() => {
        process.kill(process.pid, "SIGTSTP");
      }).catch((err) => {
        dispatch({
          t: "push",
          item: {
            kind: "error",
            text: t(`Suspend failed: ${errorMessage(err)}`, `挂起失败: ${errorMessage(err)}`),
          },
        });
      });
      return;
    }
    if (matchesKeybinding(ch, key, bindings.quit)) {
      exit();
      return;
    }
    // Permission mode is a global control: keep it reachable even while a permission,
    // model, or session picker is open. A request that is already waiting still needs
    // one explicit decision; the new mode governs subsequent checks.
    if (matchesKeybinding(ch, key, bindings.permissionCycle)) {
      cyclePermMode();
      return;
    }
    // 弹框/命令菜单打开时，主界面不参与回看滚动（对齐需求：弹框在，主界面不滚动）。
    const pending = pendingsRef.current[0];
    const dialogOpen = !!(picker || pending || sessions);
    const menuRows = dialogOpen ? [] : matchCommands(allCommands, inputRef.current);
    const menuOpen = menuRows.length > 0;
    const executeLeader = (shortcut: string): void => {
      const command =
        shortcut === "n"
          ? "/new"
          : shortcut === "l"
            ? "/sessions"
            : shortcut === "m"
              ? "/model"
              : shortcut === "s"
                ? "/status"
                : shortcut === "c"
                  ? "/compact"
                  : shortcut === "u"
                    ? "/undo both"
                    : null;
      if (shortcut === "q") {
        exit();
        return;
      }
      if (command) {
        void runSlash(command).catch((err) => {
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
      }
    };
    // 回看历史：PageUp 往上翻一屏，PageDown 往下；到底部即回到跟随最新。
    if (key.pageUp) {
      if (dialogOpen || menuOpen) return;
      const page = Math.max(1, termRows - 2);
      scrollTranscript(page);
      return;
    }
    if (key.pageDown) {
      if (dialogOpen || menuOpen) return;
      const page = Math.max(1, termRows - 2);
      scrollTranscript(-page);
      return;
    }
    // selectable 模式不接管鼠标；终端的 alternate-scroll(1007) 会把滚轮变成普通
    // ↑/↓。结果区确实可滚且输入为空（或已经在回看）时，把无修饰方向键解释为滚轮。
    // 短会话和有内容的 composer 仍保留原有的多行编辑/Prompt 历史行为。
    const selectableScrollArrow =
      !mouseTracking &&
      !dialogOpen &&
      !menuOpen &&
      !key.ctrl &&
      !key.meta &&
      !key.shift &&
      (inputRef.current.length === 0 || scrollOffset > 0) &&
      maxTranscriptScroll() > 0;
    if (selectableScrollArrow && key.upArrow) {
      scrollTranscript(3);
      return;
    }
    if (selectableScrollArrow && key.downArrow) {
      scrollTranscript(-3);
      return;
    }
    // 普通结果页的滚轮只移动内部会话视口，不交给终端滚动整块 alt-screen。
    // 触控板可能在一个 stdin chunk 里合并多次事件，wheelDelta 已累计。
    if (mouse !== null && !dialogOpen && !menuOpen) {
      if (mouse.wheelDelta !== 0) {
        scrollTranscript(-mouse.wheelDelta * 3);
      }
      return;
    }
    if (picker) {
      const visible = filterPickerRows(picker.rows, picker.filter);
      const chooseModel = (spec: string, once: boolean): void => {
        const isCurrent = beginModelPickerSelection(picker);
        void (async () => {
          if (!(await verifyAdvertisedModel(spec, isCurrent)) || !isCurrent()) return;
          if (once) {
            // All checks above are synchronous from this point; invalidate the
            // picker before publishing the one-shot selection.
            closeModelPicker();
            setNextModel(spec);
            dispatch({
              t: "push",
              item: {
                kind: "info",
                text: t(
                  `Next message will use ${spec} (this prompt only)`,
                  `下一条消息将使用 ${spec}（仅这一条）`,
                ),
              },
            });
            return;
          }
          await selectModel(spec, isCurrent);
        })().catch((err) => {
          if (!isCurrent()) return;
          closeModelPicker();
          dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
        });
      };
      if (mouse !== null) {
        if (mouse.wheelDelta !== 0) {
          setPicker((p) => {
            if (!p) return p;
            const n = filterPickerRows(p.rows, p.filter).length;
            if (n === 0) return p;
            return {
              ...p,
              index: Math.max(0, Math.min(p.index + mouse.wheelDelta, n - 1)),
            };
          });
        } else if (mouse.leftClick) {
          const anchor = panelRef.current ? absoluteTop(panelRef.current) : undefined;
          const sprite = windowHorizontally(
            buildModelPickerOverlay(
              visible,
              picker.index,
              picker.filter,
              termRows,
              termCols,
              anchor,
            ),
            termCols,
            hoffRef.current,
          );
          const clicked = hitTestSprite(sprite, mouse.leftClick.column, mouse.leftClick.row);
          const spec = clicked === null ? undefined : visible[clicked]?.spec;
          if (spec) chooseModel(spec, false);
        }
        return;
      }
      if (key.escape) {
        closeModelPicker();
        return;
      }
      // 超窄终端弹框比屏还宽时，←/→ 横向滚动查看被裁掉的内容（不宽则无副作用）。
      if (key.leftArrow) return setHscroll(hoffRef.current - 4);
      if (key.rightArrow) return setHscroll(hoffRef.current + 4);
      if (key.upArrow) {
        setPicker((p) => {
          if (!p) return p;
          const n = filterPickerRows(p.rows, p.filter).length || 1;
          return { ...p, index: (p.index - 1 + n) % n };
        });
        return;
      }
      if (key.downArrow) {
        setPicker((p) => {
          if (!p) return p;
          const n = filterPickerRows(p.rows, p.filter).length || 1;
          return { ...p, index: (p.index + 1) % n };
        });
        return;
      }
      if (key.return) {
        const spec = visible[picker.index]?.spec;
        if (spec) chooseModel(spec, false);
        return;
      }
      // Tab：per-prompt 覆盖——仅下一条消息用选中模型，不新建会话。
      if (key.tab) {
        const spec = visible[picker.index]?.spec;
        if (spec) chooseModel(spec, true);
        return;
      }
      if (key.backspace || key.delete) {
        setPicker((p) => (p ? { ...p, filter: p.filter.slice(0, -1), index: 0 } : p));
        return;
      }
      // 可打印字符 → 追加到搜索词并回到首行。
      if (ch && !key.ctrl && !key.meta && !key.tab) {
        setPicker((p) => (p ? { ...p, filter: p.filter + ch, index: 0 } : p));
        return;
      }
      return;
    }
    if (sessions) {
      const visible = filterSessionRows(sessions.rows, sessions.filter);
      if (mouse !== null) {
        if (mouse.wheelDelta !== 0) {
          setSessions((current) => {
            if (!current) return current;
            const n = filterSessionRows(current.rows, current.filter).length;
            if (n === 0) return current;
            return {
              ...current,
              index: Math.max(0, Math.min(current.index + mouse.wheelDelta, n - 1)),
            };
          });
        } else if (mouse.leftClick) {
          const sprite = windowHorizontally(
            buildSessionsOverlay(visible, termRows, termCols, {
              index: sessions.index,
              filter: sessions.filter,
              currentId: sessionId,
            }),
            termCols,
            hoffRef.current,
          );
          const clicked = hitTestSprite(sprite, mouse.leftClick.column, mouse.leftClick.row);
          const selected = clicked === null ? undefined : visible[clicked];
          if (selected) {
            setSessions(null);
            switchSession(selected.id);
          }
        }
        return;
      }
      if (key.escape) {
        setSessions(null);
        return;
      }
      if (key.leftArrow) return setHscroll(hoffRef.current - 4);
      if (key.rightArrow) return setHscroll(hoffRef.current + 4);
      if (key.upArrow) {
        const n = visible.length || 1;
        setSessions((current) =>
          current ? { ...current, index: (current.index - 1 + n) % n } : current,
        );
        return;
      }
      if (key.downArrow) {
        const n = visible.length || 1;
        setSessions((current) =>
          current ? { ...current, index: (current.index + 1) % n } : current,
        );
        return;
      }
      if (key.return) {
        const selected = visible[sessions.index];
        if (selected) {
          setSessions(null);
          switchSession(selected.id);
        }
        return;
      }
      if (key.backspace || key.delete) {
        setSessions((current) =>
          current ? { ...current, filter: current.filter.slice(0, -1), index: 0 } : current,
        );
        return;
      }
      if (ch && !key.ctrl && !key.meta && !key.tab) {
        setSessions((current) =>
          current ? { ...current, filter: current.filter + ch, index: 0 } : current,
        );
      }
      return;
    }
    if (pending) {
      if (key.escape) {
        const interrupted = pendingsRef.current;
        setPendings([]);
        void host.interrupt(sessionId).catch((err) => {
          setPendings((q) => mergePendings(interrupted, q));
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(`Interrupt failed: ${errorMessage(err)}`, `中断失败: ${errorMessage(err)}`),
            },
          });
        });
        return;
      }
      const options = permissionAnswersFor(pending);
      let selectedByMouse: PermissionAnswer | null = null;
      if (mouse !== null) {
        if (mouse.wheelDelta !== 0) {
          setPermissionSelection(permissionIndexRef.current + mouse.wheelDelta, options.length);
        } else if (mouse.leftClick) {
          const anchor = panelRef.current ? absoluteTop(panelRef.current) : termRows;
          const sprite = buildPermissionOverlay(
            pendings,
            termRows,
            termCols,
            permissionIndexRef.current,
            anchor,
            permissionControlsEnabled,
          );
          const clicked = hitTestSprite(sprite, mouse.leftClick.column, mouse.leftClick.row);
          if (clicked !== null) {
            setPermissionSelection(clicked);
            selectedByMouse = options[clicked] ?? null;
          }
        }
        if (!selectedByMouse) return;
      }
      if (key.upArrow || key.leftArrow) {
        setPermissionSelection(permissionIndexRef.current - 1, options.length);
        return;
      }
      if (key.downArrow || key.rightArrow) {
        setPermissionSelection(permissionIndexRef.current + 1, options.length);
        return;
      }
      const kind: PermissionAnswer | null = selectedByMouse
        ? selectedByMouse
        : key.return
          ? options[permissionIndexRef.current]!
          : ch === "y" || ch === "Y"
            ? "allow"
            : options.includes("allow_remember") && (ch === "a" || ch === "A")
              ? "allow_remember"
              : options.includes("allow_always") && (ch === "p" || ch === "P")
                ? "allow_always"
                : ch === "n" || ch === "N"
                  ? "deny"
                  : null;
      if (!kind) return; // 方向键/误触等不应被当成拒绝
      setPermissionSelection(0);
      setPendings((q) => q.slice(1));
      void host
        .answerPermission(sessionId, pending.permId, kind)
        .then((answered) => {
          if (answered === false) {
            dispatch({
              t: "push",
              item: {
                kind: "info",
                text: t(
                  "This permission request was already handled by another client",
                  "该授权请求已由其他客户端处理",
                ),
              },
            });
          }
        })
        .catch((err) => {
          setPendings((q) => mergePendings([pending], q));
          dispatch({
            t: "push",
            item: {
              kind: "error",
              text: t(
                `Permission reply failed: ${errorMessage(err)}`,
                `授权答复失败: ${errorMessage(err)}`,
              ),
            },
          });
        });
      return;
    }
    // 很快的组合键可能被 PTY 合并为一个 chunk（"\x18l"）；按 leader + 单键解析。
    if (!dialogOpen && ch.length === 2 && ch.startsWith("\u0018")) {
      setBuf("", 0);
      executeLeader(ch.slice(1));
      return;
    }
    // Ctrl+P 直接打开命令面板（本质是聚焦 `/` 补全菜单）。
    if (matchesKeybinding(ch, key, bindings.commandPalette)) {
      setBuf("/", 1);
      setMenuIdx(0);
      return;
    }
    if (matchesKeybinding(ch, key, bindings.reconnect)) {
      reconnect();
      return;
    }
    if (matchesKeybinding(ch, key, bindings.toggleToolOutput)) {
      toggleToolDetail();
      return;
    }
    if (matchesKeybinding(ch, key, bindings.externalEditor)) {
      void runSlash("/editor");
      return;
    }

    // OpenCode 风格 Ctrl+X leader：下一键触发常用动作。
    if ((key.ctrl && ch === "x") || ch === "\u0018") {
      if (leaderTimerRef.current) clearTimeout(leaderTimerRef.current);
      setLeaderPending(true);
      leaderTimerRef.current = setTimeout(() => {
        leaderTimerRef.current = null;
        setLeaderPending(false);
      }, 1500);
      return;
    }
    if (leaderPending) {
      if (leaderTimerRef.current) clearTimeout(leaderTimerRef.current);
      leaderTimerRef.current = null;
      setLeaderPending(false);
      executeLeader(ch);
      return;
    }
    if (state.running && key.escape) {
      void host.interrupt(sessionId).catch((err) => {
        dispatch({
          t: "push",
          item: {
            kind: "error",
            text: t(`Interrupt failed: ${errorMessage(err)}`, `中断失败: ${errorMessage(err)}`),
          },
        });
      });
      return;
    }
    // 斜杠命令补全菜单（输入框正上方、方向朝上）：正在敲命令名时接管方向键/Tab/Enter/Esc。
    if (menuOpen) {
      const n = menuRows.length;
      const cur = Math.min(menuIndexRef.current, n - 1);
      if (mouse !== null) {
        if (mouse.wheelDelta !== 0) {
          queueMenuWheel(mouse.wheelDelta, n);
        } else if (mouse.leftClick && panelRef.current) {
          const sprite = buildCommandMenuOverlay(
            menuRows,
            cur,
            absoluteTop(panelRef.current),
            termRows,
            termCols,
          );
          const clicked = hitTestSprite(sprite, mouse.leftClick.column, mouse.leftClick.row);
          const command = clicked === null ? undefined : menuRows[clicked]?.name;
          if (command) {
            setMenuIdx(clicked!);
            setBuf("", 0);
            submitLine(`/${command}`);
          }
        }
        return;
      }
      if (key.upArrow) return setMenuIdx((cur - 1 + n) % n);
      if (key.downArrow) return setMenuIdx((cur + 1) % n);
      if (key.escape) return setBuf("", 0); // 关闭菜单（清掉半截命令）
      const picked = menuRows[cur]!.name;
      if (key.tab) return setBuf(`/${picked} `, picked.length + 2); // 补全命令名，留空格待输参数
      if (key.return) {
        setBuf("", 0);
        submitLine(`/${picked}`); // 直接运行高亮命令
        return;
      }
      // 其余可打印键/退格继续落到下方常规编辑，实时收窄候选。
    }
    const buf = inputRef.current;
    const cur = cursorRef.current;
    const isCtrl = (letter: string, code: string) => key.ctrl && (ch === letter || ch === code);

    // —— 光标移动 ——
    if (key.leftArrow) return setBuf(buf, previousGraphemeIndex(buf, cur));
    if (key.rightArrow) return setBuf(buf, nextGraphemeIndex(buf, cur));
    if (key.home) return setBuf(buf, lineStart(buf, cur));
    if (key.end) return setBuf(buf, lineEnd(buf, cur));
    if (isCtrl("a", "")) return setBuf(buf, 0); // 行首
    if (isCtrl("e", "")) return setBuf(buf, buf.length); // 行尾

    // —— 历史回溯（↑ 往旧，↓ 往新，越过最新回到空行）——
    if (key.upArrow && lineStart(buf, cur) > 0) {
      return setBuf(buf, moveCursorLine(buf, cur, -1));
    }
    if (key.upArrow) {
      const h = historyRef.current;
      if (h.length === 0) return;
      const pos = Math.max(0, (histPosRef.current ?? h.length) - 1);
      histPosRef.current = pos;
      return setBuf(h[pos]!, h[pos]!.length);
    }
    if (key.downArrow && lineEnd(buf, cur) < buf.length) {
      return setBuf(buf, moveCursorLine(buf, cur, 1));
    }
    if (key.downArrow) {
      const h = historyRef.current;
      if (histPosRef.current === null) return;
      const pos = histPosRef.current + 1;
      if (pos >= h.length) {
        histPosRef.current = null;
        return setBuf("", 0);
      }
      histPosRef.current = pos;
      return setBuf(h[pos]!, h[pos]!.length);
    }

    // —— 删除 ——
    if (isCtrl("u", "")) return setBuf(buf.slice(cur), 0); // 删到行首
    if (isCtrl("k", "")) return setBuf(buf.slice(0, cur), cur); // 删到行尾
    if (isCtrl("w", "")) {
      // 删除光标前一个词：先吃掉空白，再吃掉非空白。
      let i = cur;
      while (i > 0) {
        const previous = previousGraphemeIndex(buf, i);
        if (!/\s/u.test(buf.slice(previous, i))) break;
        i = previous;
      }
      while (i > 0) {
        const previous = previousGraphemeIndex(buf, i);
        if (/\s/u.test(buf.slice(previous, i))) break;
        i = previous;
      }
      return setBuf(buf.slice(0, i) + buf.slice(cur), i);
    }

    const normalized = ch.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (key.return && (key.shift || key.meta || key.ctrl)) {
      histPosRef.current = null;
      setBuf(buf.slice(0, cur) + "\n" + buf.slice(cur), cur + 1);
    } else if (key.return) {
      const text = inputRef.current;
      setBuf("", 0);
      submitLine(text);
    } else if (key.backspace) {
      if (cur === 0) return;
      histPosRef.current = null;
      const previous = previousGraphemeIndex(buf, cur);
      setBuf(buf.slice(0, previous) + buf.slice(cur), previous);
    } else if (key.delete) {
      if (cur === buf.length) return;
      histPosRef.current = null;
      const next = nextGraphemeIndex(buf, cur);
      setBuf(buf.slice(0, cur) + buf.slice(next), cur);
    } else if (ch && !key.ctrl && !key.meta) {
      histPosRef.current = null;
      // Unbracketed multi-character chunks are insertion only. A trailing LF
      // can therefore never execute a prompt accidentally.
      const safe = normalizePastedInput(normalized).text;
      setBuf(buf.slice(0, cur) + safe + buf.slice(cur), cur + safe.length);
    }
  });

  // 模型选择器复用底部输入框显示筛选词；授权与会话列表仍会接管输入并隐藏光标。
  const composerText = picker?.filter ?? input;
  const composerCursor = picker ? picker.filter.length : cursor;
  // CLI 输出层按绝对 CUP 坐标停放真实光标，避开 Ink 全屏相对坐标在不同终端上的偏移。
  const caretHidden = !!(pendings[0] || sessions);
  useLayoutEffect(() => {
    if (!absoluteCaretEnabled || caretHidden) {
      terminalCaret?.setTarget(null);
      return;
    }
    const panel = panelRef.current;
    if (!panel) return;
    const maxInputRows = Math.max(1, Math.min(5, termRows - 10));
    const position = composerCaretPosition({
      panelTop: absoluteTop(panel),
      text: composerText,
      cursor: composerCursor,
      width: termCols,
      maxInputRows,
      terminalRows: termRows,
    });
    terminalCaret.setTarget({ row: position.y + 1, col: position.x + 1 });
  }, [
    absoluteCaretEnabled,
    caretHidden,
    termRows,
    composerText,
    composerCursor,
    termCols,
    state,
    terminalCaret,
  ]);
  useEffect(() => () => terminalCaret?.setTarget(null), [terminalCaret]);

  // 实验帧合成器保留自己的 stdout 停放逻辑；生产默认只走上面的窄作用域输出适配器。
  useEffect(() => {
    if (!overlayMode) return;
    if (caretHidden) return setCaret(null);
    const panel = panelRef.current;
    if (!panel) return setCaret(null);
    const position = composerCaretPosition({
      panelTop: absoluteTop(panel),
      text: composerText,
      cursor: composerCursor,
      width: termCols,
      maxInputRows: Math.max(1, Math.min(5, termRows - 10)),
      terminalRows: termRows,
    });
    setCaret({ row: position.y + 1, col: position.x + 1 });
  });

  // 浮层弹框精灵：把当前打开的弹框算成一组定宽 ANSI 行，交给写入层合成到整帧上。
  // 仅浮层模式（真实 TTY）生效；非 TTY 下清空，弹框改由下方 in-tree 渲染（测试可见）。
  // 切换弹框时横向滚动归零（新弹框从左端看起）。
  const dialogKey = picker ? "picker" : pendings[0] ? "perm" : sessions ? "sess" : "none";
  useEffect(() => {
    setHscroll(0);
  }, [dialogKey, setHscroll]);

  useEffect(() => {
    if (!overlayMode) return setOverlay(null);
    // 超窄终端下弹框可能比屏还宽：统一过一遍横向开窗（不宽则原样返回），补横向滚动条。
    const show = (s: Sprite) => setOverlay(windowHorizontally(s, termCols, hoff));
    if (picker) {
      const visible = filterPickerRows(picker.rows, picker.filter);
      const anchor = panelRef.current ? absoluteTop(panelRef.current) : termRows;
      return show(
        buildModelPickerOverlay(visible, picker.index, picker.filter, termRows, termCols, anchor),
      );
    }
    if (pendings[0]) {
      const anchor = panelRef.current ? absoluteTop(panelRef.current) : termRows;
      return show(
        buildPermissionOverlay(
          pendings,
          termRows,
          termCols,
          permissionIndex,
          anchor,
          permissionControlsEnabled,
        ),
      );
    }
    if (sessions) {
      const visible = filterSessionRows(sessions.rows, sessions.filter);
      return show(
        buildSessionsOverlay(visible, termRows, termCols, {
          index: sessions.index,
          filter: sessions.filter,
          currentId: sessionId,
        }),
      );
    }
    // 斜杠命令菜单：钉在输入框正上方（需读输入面板的绝对行号）。菜单宽度已封顶屏宽，无需横向开窗。
    const menu = matchCommands(allCommands, input);
    const panel = panelRef.current;
    if (menu.length > 0 && panel) {
      return setOverlay(
        buildCommandMenuOverlay(menu, menuIndex, absoluteTop(panel), termRows, termCols),
      );
    }
    return setOverlay(null);
  }, [
    overlayMode,
    picker,
    pendings,
    permissionIndex,
    permissionControlsEnabled,
    sessions,
    sessionId,
    input,
    menuIndex,
    allCommands,
    termRows,
    termCols,
    hoff,
    lang,
    setOverlay,
  ]);

  const u = state.usage;
  // 在 MAX_TRANSCRIPT_ROWS 硬上限内保留完整渲染树，外层视口只裁剪不可见行。
  // 这样 Yoga 计算的内容高度始终覆盖完整历史，不会因尾部虚拟窗口形成假顶部；
  // scrollOffset 是终端行数，单条超长回复也可以逐行回看。
  const visibleItems = state.items;
  const baseKey = 0;

  const spinner = screenReader
    ? state.running
      ? t("generating", "生成中")
      : ""
    : state.running
      ? SPINNER[spin % SPINNER.length]!
      : "●";
  const elapsedS =
    state.running && runStartRef.current
      ? Math.floor((Date.now() - runStartRef.current) / 1000)
      : 0;

  // 模型选择器与命令菜单都属于输入框的向上补全面板，不再居中接管整屏。
  const showInput = overlayMode || !sessions;
  // 非浮层模式（测试）下命令菜单改由 in-tree 渲染在输入框上方；浮层模式由写入层合成盖屏。
  const inTreeMenu = !overlayMode && !picker ? matchCommands(allCommands, input) : [];
  const currentPermModeHint =
    state.workspaceTrustReason === "inspection-failed"
      ? t(
          "⏸ strict read-only safety lock (workspace inspection failed)",
          "⏸ 严格只读安全锁（工作区检查失败）",
        )
      : permModeHint(permMode);
  // 提示行仅在需要时出现（对齐 opencode 的极简）：运行中显示中断/追加；
  // 严格安全锁、非默认权限档位或临时模型激活时提示其状态；否则空闲态不显示常规导航提示。
  const hintItems = leaderPending
    ? [
        t(
          "ctrl+x: n new · l sessions · m models · s status · c compact · u undo · q quit",
          "ctrl+x：n 新建 · l 会话 · m 模型 · s 状态 · c 压缩 · u 撤销 · q 退出",
        ),
      ]
    : state.running
      ? [
          t("esc interrupt", "esc 中断"),
          t("enter append", "enter 追加"),
          ...(currentPermModeHint ? [currentPermModeHint] : []),
        ]
      : [
          ...(currentPermModeHint ? [currentPermModeHint] : []),
          ...(nextModel
            ? [
                t(
                  `↳ next: ${terminalInlineText(nextModel)} (once)`,
                  `↳ 下一条: ${terminalInlineText(nextModel)}（仅一次）`,
                ),
              ]
            : []),
        ];
  const inlinePickerHeight = Math.max(8, Math.min(12, termRows - 8));
  const inlineMenuHeight = Math.min(10, inTreeMenu.length) + 2;
  const inputCluster = showInput ? (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      {/*
       * Ink/Yoga 没有 absolute positioning。零高容器 + 负上边距把候选层画到输入框
       * 上方，但不计入 controls 高度：菜单开关时输入框、首页与状态栏都不会位移。
       */}
      {picker && !overlayMode ? (
        <Box height={0} flexShrink={0}>
          <Box marginTop={-inlinePickerHeight}>
            <ModelPicker
              rows={picker.rows}
              index={picker.index}
              filter={picker.filter}
              width={termCols}
              maxRows={inlinePickerHeight}
            />
          </Box>
        </Box>
      ) : inTreeMenu.length > 0 ? (
        <Box height={0} width={termCols} flexShrink={0}>
          <Box marginTop={-inlineMenuHeight} width={termCols}>
            <CommandMenu rows={inTreeMenu} index={menuIndex} width={termCols} />
          </Box>
        </Box>
      ) : null}
      <InputPanel
        panelRef={panelRef}
        text={composerText}
        cursor={composerCursor}
        model={state.meta.model}
        running={state.running}
        spinner={spinner}
        width={termCols}
        maxInputRows={Math.max(1, Math.min(5, termRows - 10))}
        placeholder={picker ? t("Search models…", "搜索模型…") : undefined}
      />
      {hintItems.length > 0 ? (
        <Box justifyContent="flex-end">
          <Text dimColor wrap="truncate">
            {fitHints(hintItems, termCols)}
          </Text>
        </Box>
      ) : null}
      {conversationEmpty && termRows >= 22 && !pendings[0] && !sessions ? (
        <WelcomeTip width={termCols} />
      ) : null}
    </Box>
  ) : null;

  // 底部状态栏精简为一行（对齐 opencode）：左 cwd，右 token/花费。模型已在输入框内展示，
  // 这里不再重复；品牌行也去掉。成本无价格信息时省略。
  const cwdLabel = terminalInlineText(tildify(state.meta.cwd));
  const costPart =
    state.costUSD !== undefined && state.costUSD > 0 ? ` · $${state.costUSD.toFixed(4)}` : "";
  const cachePart =
    u.cacheReadTokens > 0 || u.cacheWriteTokens > 0
      ? ` · cache ${u.cacheReadTokens}r/${u.cacheWriteTokens}w`
      : "";
  const statusRight = `${u.inputTokens}/${u.outputTokens} tokens${cachePart}${costPart}`;

  // 底部控件：会话列表 / 授权弹窗 / 输入框。浮层模式下前两者改为盖屏合成，这里只留输入框。
  const controls = (
    <>
      {!overlayMode && sessions ? (
        <SessionList
          sessions={filterSessionRows(sessions.rows, sessions.filter)}
          index={sessions.index}
          filter={sessions.filter}
          currentId={sessionId}
        />
      ) : null}
      {!overlayMode && pendings[0] ? (
        <PermissionPanel
          pending={pendings[0]}
          pendingCount={pendings.length}
          index={permissionIndex}
          termRows={termRows}
          termCols={termCols}
          showPermissionControls={permissionControlsEnabled}
        />
      ) : null}
      {!pendings[0] || overlayMode || termRows >= 16 ? inputCluster : null}
    </>
  );

  return (
    <Box flexDirection="column" width={termCols} height={termRows} overflow="hidden">
      {conversationEmpty ? (
        // 首次进入 / 空会话：opencode 风格欢迎页——顶部保留会话边界与信息条目，
        // 大 logo + 输入框（含 Tip）作为一组垂直居中。
        <>
          {!pendings[0] || termRows >= 8
            ? state.items
                .filter((i) => i.kind !== "logo")
                .map((item, i) => (
                  <ItemView
                    key={`top:${i}`}
                    item={item as Item}
                    width={termCols}
                    expanded={item.kind === "tool" && expandedToolIds.has(item.id)}
                  />
                ))
            : null}
          <Box
            flexGrow={1}
            minHeight={0}
            flexDirection="column"
            overflow="hidden"
            justifyContent="center"
          >
            {!pendings[0] || termRows >= 16 ? <Welcome width={termCols} /> : null}
            {controls}
          </Box>
        </>
      ) : (
        <>
          {/*
           * 固定视口布局：会话区占据剩余高度并贴底（最新可见），输入框固定在下方。
           * minHeight={0} + overflow hidden 让会话区在内容超高时只裁掉顶部，绝不把整帧顶出
           * 终端而导致「整体滑动」；PageUp/PageDown 通过 scrollOffset 在会话区内回看历史。
           */}
          <Box
            ref={transcriptViewportRef}
            flexGrow={1}
            flexShrink={1}
            flexBasis={0}
            minHeight={0}
            flexDirection="column"
            overflow="hidden"
            justifyContent="flex-end"
            aria-role="list"
            aria-state={{ busy: state.running }}
          >
            {/*
             * 内层 flexShrink={0}：不让 Ink 把消息行按 flex 压缩（否则会渲染成
             * 「隔行采样」的错乱内容并溢出终端）。外层贴底 + overflow 裁掉顶部，
             * 于是永远只显示最新内容的连续尾部，输入框牢牢固定在下方、终端不出滚动条。
             */}
            <Box
              ref={transcriptContentRef}
              flexShrink={0}
              flexDirection="column"
              marginBottom={-scrollOffset}
            >
              {visibleItems.map((item, i) =>
                item.kind === "logo" ? null : (
                  <ItemView
                    key={baseKey + i}
                    item={item}
                    width={termCols}
                    expanded={item.kind === "tool" && expandedToolIds.has(item.id)}
                  />
                ),
              )}

              {state.liveText ? (
                <Box>
                  <Text color="green">{spinner} </Text>
                  <Text>{terminalDisplayText(state.liveText)}</Text>
                </Box>
              ) : state.running && state.liveThinking ? (
                // 思考酝酿期：暗色斜体滚动展示尾部（对齐 Claude Code 的 thinking 可见性）。
                <Box>
                  <Text color="magenta">✻ </Text>
                  <Text dimColor italic>
                    {thinkingTail(state.liveThinking, termCols)}
                  </Text>
                </Box>
              ) : state.running ? (
                <Box>
                  <Text color="yellow">{spinner} </Text>
                  <Text dimColor>
                    {t(
                      `generating… ${elapsedS}s (esc interrupt)`,
                      `生成中… ${elapsedS}s（esc 中断）`,
                    )}
                  </Text>
                </Box>
              ) : null}

              {[...state.activeTools.values()].map((tool) => {
                const activity =
                  tool.name === "task" ? state.subagentActivity.get(tool.id) : undefined;
                return (
                  <Box key={tool.id} flexDirection="column">
                    <ItemView item={tool} />
                    {activity ? (
                      <Text dimColor wrap="truncate">
                        {"  ↳ "}
                        {truncate(sanitizeTerminalText(activity), Math.max(0, termCols - 6))}
                      </Text>
                    ) : null}
                  </Box>
                );
              })}

              {state.running && state.todos.some((todo) => todo.status !== "completed") ? (
                <TodoList todos={state.todos} />
              ) : null}
            </Box>
          </Box>

          {controls}
        </>
      )}

      <Box
        justifyContent="space-between"
        flexShrink={0}
        aria-hidden={screenReader}
        display={pendings[0] && termRows < 8 ? "none" : "flex"}
      >
        {/* 路径拿左侧剩余列（尾部优先，从头截断）；token/花费固定在右。 */}
        <Text dimColor wrap="truncate">
          {truncWidthStart(cwdLabel, termCols - dispWidth(statusRight) - 1)}
        </Text>
        <Text dimColor wrap="truncate">
          {statusRight}
        </Text>
      </Box>
    </Box>
  );
}

/** 用 ~ 缩写 home 目录，其余原样（状态栏展示路径用）。 */
function tildify(p: string): string {
  const home = process.env["HOME"] || "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/**
 * Trust changes are delivered by newer hosts as an authoritative session event.
 * Keep a narrow compatibility decoder so this TUI remains usable while daemon
 * and SDK clients roll forward independently.
 */
function workspaceTrustUpdateFromEvent(
  se: SessionEvent,
): { trusted: boolean; reason?: string } | undefined {
  const record = se as unknown as Record<string, unknown>;
  if (
    record["type"] !== "workspace_trust" &&
    record["type"] !== "workspace_trust_changed" &&
    record["type"] !== "workspace_trust_change"
  ) {
    return undefined;
  }
  const nested =
    record["workspaceTrust"] && typeof record["workspaceTrust"] === "object"
      ? (record["workspaceTrust"] as Record<string, unknown>)
      : record["assessment"] && typeof record["assessment"] === "object"
        ? (record["assessment"] as Record<string, unknown>)
        : record;
  if (typeof nested["trusted"] !== "boolean") return undefined;
  const reason = typeof nested["reason"] === "string" ? nested["reason"] : undefined;
  return { trusted: nested["trusted"], ...(reason ? { reason } : {}) };
}

function handleEvent(
  se: SessionEvent,
  dispatch: React.Dispatch<Action>,
  setPendings: React.Dispatch<React.SetStateAction<PendingPerm[]>>,
) {
  if (se.type === "workspace_trust") {
    const update = workspaceTrustUpdateFromEvent(se);
    if (!update) return;
    if (!update.trusted) setPendings([]);
    dispatch({ t: "workspaceTrust", ...update });
    return;
  }
  const trustUpdate = workspaceTrustUpdateFromEvent(se);
  if (trustUpdate) {
    if (!trustUpdate.trusted) setPendings([]);
    dispatch({ t: "workspaceTrust", ...trustUpdate });
    return;
  }
  if (se.type === "state") {
    dispatch({ t: "running", v: se.running });
    if (!se.running) dispatch({ t: "flushLive" });
    return;
  }
  if (se.type === "permission_request") {
    const { type: _type, ...pending } = se;
    setPendings((q) => mergePendings(q, [pending]));
    return;
  }
  if (se.type === "permission_resolved") {
    setPendings((q) => q.filter((p) => p.permId !== se.permId));
    return;
  }
  if (se.type === "title") {
    dispatch({ t: "title", title: se.title });
    return;
  }
  if (se.type === "reverted") {
    // undo/rewind 也可能由其它订阅者（另一个 TUI/CLI）触发；所有观察者都提示一下。
    const convPart =
      (se.removedMessages ?? 0) > 0
        ? t(`, rewound ${se.removedMessages} messages`, `，回退 ${se.removedMessages} 条对话`)
        : "";
    dispatch({
      t: "push",
      item: {
        kind: "info",
        text: t(
          `↩ Rolled back: restored ${se.restored} files, deleted ${se.deleted} new files${convPart}`,
          `↩ 已回滚：恢复 ${se.restored} 个文件，删除 ${se.deleted} 个新增文件${convPart}`,
        ),
      },
    });
    return;
  }
  // se.type === "agent"
  const ev = se.event;
  switch (ev.type) {
    case "user_message":
      dispatch({ t: "flushLive" });
      // 空闲期后台任务完成通知（SessionManager 自动 drive）：收敛成一行 info，
      // 不当成用户长消息渲染（全文已进模型历史）。
      if (ev.text.startsWith("<task-notification")) {
        const head = ev.text.split("\n").find((l) => l && !l.startsWith("<")) ?? "";
        dispatch({ t: "push", item: { kind: "info", text: `◆ ${head}` } });
        break;
      }
      dispatch({ t: "push", item: { kind: "user", text: ev.text } });
      break;
    case "text":
      dispatch({ t: "live", delta: ev.text });
      break;
    case "thinking":
      dispatch({ t: "liveThinking", delta: ev.text });
      break;
    case "tool_input_delta":
      break;
    case "tool_progress": {
      if (isTodoProgress(ev.event)) {
        dispatch({ t: "todos", todos: ev.event.todos });
        break;
      }
      // task 工具把子 agent 的内部事件经此通道转发上来（ev.id=task 调用 id）。
      // 取一条活动行（子 agent 当前在跑什么工具），实时显示在该 task 行下方。
      if (ev.name === "task") {
        const line = subagentActivityLine(ev.event);
        if (line) dispatch({ t: "subagentActivity", id: ev.id, line });
      }
      break;
    }
    case "turn_reset":
      dispatch({ t: "resetLive" });
      break;
    case "retry":
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            `⟳ provider transient error, retry #${ev.attempt} after ${ev.delayMs}ms (${firstLine(ev.reason)})`,
            `⟳ provider 瞬时错误，${ev.delayMs}ms 后第 ${ev.attempt} 次重试（${firstLine(ev.reason)}）`,
          ),
        },
      });
      break;
    case "tool_start":
      dispatch({ t: "flushLive" });
      dispatch({ t: "toolStart", id: ev.id, name: ev.name, ruleKey: ev.ruleKey });
      break;
    case "tool_permission":
      if (ev.decision === "deny") dispatch({ t: "toolDeny", id: ev.id });
      break;
    case "tool_result":
      dispatch({
        t: "toolFinish",
        id: ev.id,
        status: ev.isError ? "err" : "ok",
        detail: ev.content,
      });
      break;
    case "turn_end":
      dispatch({ t: "usage", u: ev.usage });
      break;
    case "compacted":
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            `Context compacted ${ev.beforeTokens}→${ev.afterTokens} tokens`,
            `上下文已压缩 ${ev.beforeTokens}→${ev.afterTokens} tokens`,
          ),
        },
      });
      break;
    case "model_fallback":
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            `⇄ Model fallback: ${ev.from} → ${ev.to} (${firstLine(ev.reason)})`,
            `⇄ 模型降级：${ev.from} → ${ev.to}（${firstLine(ev.reason)}）`,
          ),
        },
      });
      break;
    case "task_notice": {
      // 后台任务完成通知已注入历史；给用户一行摘要（首行含任务名与成败）。
      dispatch({ t: "flushLive" });
      const head = ev.text.split("\n").find((l) => l && !l.startsWith("<")) ?? "";
      dispatch({
        t: "push",
        item: { kind: "info", text: t(`◆ ${head}`, `◆ ${head}`) },
      });
      break;
    }
    case "done":
      dispatch({ t: "flushLive" });
      dispatch({
        t: "usage",
        u: ev.usage,
        ...(ev.costUSD !== undefined ? { costUSD: ev.costUSD } : {}),
      });
      break;
    case "error":
      dispatch({ t: "flushLive" });
      dispatch({ t: "push", item: { kind: "error", text: ev.message } });
      break;
  }
}

function restoreTranscript(messages: readonly ChatMessage[]): {
  items: Item[];
  activeTools: Map<string, Extract<Item, { kind: "tool" }>>;
} {
  const items: Item[] = [];
  const activeTools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const item of messagesToItems(messages)) {
    if (item.kind === "tool" && item.status === "run") activeTools.set(item.id, item);
    else items.push(item);
  }
  return { items, activeTools };
}

function sessionBoundary(meta: SessionMeta): Item {
  return {
    kind: "info",
    text:
      t(
        `── Session boundary ${meta.id} · ${meta.model}`,
        `── 会话边界 ${meta.id} · ${meta.model}`,
      ) +
      (meta.title ? ` · ${meta.title}` : "") +
      " ──",
  };
}

function networkToolDisabledReason(reason: NetworkToolDisabledReason): string {
  switch (reason) {
    case "workspace_restricted":
      return t("workspace is restricted", "工作区未授信");
    case "credential_not_configured":
      return t("search credential is not configured", "未配置搜索凭据");
    case "network_policy":
      return t("blocked by network policy", "被网络策略阻止");
    case "network_proxy_unavailable":
      return t("controlled network proxy is unavailable", "受控网络代理不可用");
    case "host_disabled":
      return t("disabled by the host", "宿主已禁用");
  }
}

/** Shared formatter for /status and /tools; it never probes the network or a credential backend. */
export function networkToolsText(status: NetworkToolStatuses | undefined): string {
  if (!status) {
    return t("Network tools: status unavailable from this host", "联网工具：当前宿主未提供状态");
  }
  const line = (
    name: "web_search" | "webfetch",
    tool: NetworkToolStatuses[keyof NetworkToolStatuses],
  ) =>
    tool.state === "ready"
      ? `✓ ${name}: ${t("ready", "可用")}${tool.provider ? ` (${tool.provider})` : ""}`
      : `✗ ${name}: ${t("disabled", "已禁用")} · ${networkToolDisabledReason(tool.reason)}`;
  return [
    t("Network tools", "联网工具"),
    line("web_search", status.webSearch),
    line("webfetch", status.webFetch),
  ].join("\n");
}

function helpText(): string {
  return [
    t("/help                 Show command help", "/help                 显示命令帮助"),
    t(
      "/status               Show session, model, directory and network tools",
      "/status               显示会话、模型、目录与联网工具",
    ),
    t(
      "/tools                Show web_search/webfetch readiness",
      "/tools                显示 web_search/webfetch 状态",
    ),
    t(
      "/usage                Show token/cache/cost totals",
      "/usage                显示 token/缓存/成本统计",
    ),
    t(
      "/providers            List canonical providers and credential hints",
      "/providers            列出 canonical provider 及凭证提示",
    ),
    t(
      "/model                Open the built-in model picker (including Free/open-weight models)",
      "/model                打开内置模型选择器（含免费/开源模型）",
    ),
    t(
      "/model <provider/model> Start a new session directly with the given model",
      "/model <provider/model> 直接以指定模型新建会话",
    ),
    t(
      "/sessions             Search and switch sessions (/resume and /continue)",
      "/sessions             搜索并切换会话（也可用 /resume、/continue）",
    ),
    t(
      "/mouse [on|off]       Full tracking; off keeps native selection (PageUp/Down scrolls)",
      "/mouse [on|off]       完整鼠标跟踪；off 原生框选（PageUp/Down 回看）",
    ),
    t(
      "/resume <sessionId>   Load directly; without an id, open the picker",
      "/resume <sessionId>   直接载入；不带 id 时打开选择器",
    ),
    t(
      "/new [title]          Start a new session with the current model and directory",
      "/new [标题]           以当前模型和目录新建会话",
    ),
    t(
      "Ctrl+P command palette · Ctrl+X then n/l/m/s/c/u/q for common actions",
      "Ctrl+P 命令面板 · Ctrl+X 后按 n/l/m/s/c/u/q 执行常用操作",
    ),
    t(
      "Ctrl+G external editor · Ctrl+O tool output · Ctrl+R reconnect (configurable under tui.keybindings)",
      "Ctrl+G 外部编辑器 · Ctrl+O 工具输出 · Ctrl+R 重连（可在 tui.keybindings 配置）",
    ),
    t(
      "Shift+Tab             Cycle permission mode (trusted workspaces only)",
      "Shift+Tab             轮换权限模式（仅可信工作区）",
    ),
    t(
      "/undo [mode]          Rewind the last turn; mode: files (default) / conversation / both",
      "/undo [mode]          回滚上一轮；mode：files（默认，仅文件）/ conversation（仅对话）/ both（两者）",
    ),
    t(
      "/fork [title]         Fork this session into a new one (original untouched)",
      "/fork [标题]          把当前会话分叉成新会话（原会话不动）",
    ),
    t(
      "/skills               List auto-detected skills and availability",
      "/skills               列出自动发现的技能及可用状态",
    ),
    t("/lang <en|zh>         Switch UI language", "/lang <en|zh>         切换界面语言"),
    t("/exit                 Exit", "/exit                 退出"),
  ].join("\n");
}

function providersText(
  providers: readonly ProviderDescriptor[],
  inspectCredentials: boolean,
): string {
  if (providers.length === 0) {
    return t(
      "The current host does not provide a provider list; you can still use /model <provider/model> and let the host validate",
      "当前宿主未提供 provider 列表；仍可用 /model <provider/model> 交由 host 校验",
    );
  }
  return [
    t(
      "Provider (canonical id · protocol · location · credential)",
      "Provider（canonical id · 协议 · 位置 · 凭证）",
    ),
    ...providers.map((provider) => {
      const credentialState = inspectCredentials
        ? inspectProviderCredential(provider, `${provider.id}/__credential_status__`)
        : undefined;
      const credential = !provider.requiresApiKey
        ? t("No API key required", "无需 API key")
        : !inspectCredentials
          ? t(
              `Credential validated by host (${provider.apiKeyEnv.join(t(" or ", " 或 ")) || "API key"})`,
              `凭证由宿主校验（${provider.apiKeyEnv.join(t(" or ", " 或 ")) || "API key"}）`,
            )
          : credentialState?.ready
            ? t(
                `${credentialState.source ?? t("Credential", "凭证")} configured`,
                `${credentialState.source ?? t("Credential", "凭证")} 已配置`,
              )
            : t(
                `Missing ${provider.apiKeyEnv.join(t(" or ", " 或 ")) || t("API key env var", "API key 环境变量")}`,
                `缺少 ${provider.apiKeyEnv.join(t(" or ", " 或 ")) || t("API key env var", "API key 环境变量")}`,
              );
      return `${provider.id} · ${provider.name} · ${provider.protocol} · ${provider.local ? t("local", "本地") : t("cloud", "云端")} · ${credential}`;
    }),
  ].join("\n");
}

function skillsText(skills: readonly SkillMeta[]): string {
  if (skills.length === 0) {
    return t(
      "No skills detected. Drop a <name>/SKILL.md under ~/.claude/skills, ~/.agents/skills, or <project>/.claude/skills.",
      "未发现技能。可在 ~/.claude/skills、~/.agents/skills 或 <项目>/.claude/skills 下放置 <名字>/SKILL.md。",
    );
  }
  const home = os.homedir();
  const short = (p: string | undefined): string =>
    p && p.startsWith(home) ? `~${p.slice(home.length)}` : (p ?? "");
  const ready = skills.filter((s) => s.available !== false).length;
  const header = t(
    `Detected ${skills.length} skill(s), ${ready} ready. Load one with the skill tool when a task matches:`,
    `发现 ${skills.length} 个技能，${ready} 个就绪。任务匹配时用 skill 工具加载：`,
  );
  const rows = skills.map((s) => {
    const status =
      s.available === false
        ? t(
            ` — unavailable (needs ${s.requiresBins?.join(", ") ?? "a CLI"})`,
            ` — 不可用（需 ${s.requiresBins?.join("、") ?? "某 CLI"}）`,
          )
        : "";
    const desc = (s.description || t("(no description)", "（无描述）")).slice(0, 80);
    return `• ${s.name}${status}\n    ${desc}\n    ${short(s.sourceRoot)}`;
  });
  return [header, ...rows].join("\n");
}

interface PickerRow {
  providerId: string;
  spec: string;
  label: string;
  providerName: string;
  free: boolean;
  openWeight: boolean;
  recommended: boolean;
  local: boolean;
  note?: string;
  /** 凭证是否就绪；无法本地探测时为 undefined（由宿主校验）。 */
  ready: boolean | undefined;
  readyHint: string;
}

/**
 * 读取 provider 的安全凭证状态。生产环境中的 Key 会在启动时从 process.env 迁入
 * CredentialBroker，因此必须优先走 registry 诊断；自定义测试 descriptor 未注册时才
 * 回退到环境变量。这里只返回存在性和变量名，不暴露凭证值。
 */
function inspectProviderCredential(
  provider: ProviderDescriptor,
  spec: string,
): { ready: boolean; source?: string } {
  try {
    const diagnostics = diagnoseProvider(spec);
    return {
      ready: diagnostics.hasCredentials,
      ...(diagnostics.credentialEnv ? { source: diagnostics.credentialEnv } : {}),
    };
  } catch {
    const source = provider.apiKeyEnv.find((name) => Boolean(process.env[name]?.trim()));
    return { ready: Boolean(source), ...(source ? { source } : {}) };
  }
}

/** 把打平的模型目录转成选择器行，并按（就绪·推荐）优先稳定排序。 */
export function buildPickerRows(
  catalog: readonly ModelCatalogEntry[],
  providers: readonly ProviderDescriptor[],
  inspectCredentials: boolean,
  liveProbe?: ProviderProbe,
): PickerRow[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const currentCatalog = syncDiscoveredModels(catalog, providers, liveProbe?.models).filter(
    (entry) => !liveProbe || liveProbe.live.has(entry.providerId),
  );
  const rows = currentCatalog.map((entry): PickerRow => {
    const descriptor = byId.get(entry.providerId);
    const apiKeyEnv = descriptor?.apiKeyEnv ?? [];
    let ready: boolean | undefined;
    let readyHint: string;
    if (liveProbe?.probed.has(entry.providerId)) {
      // 只有宿主使用自身 CredentialBroker 成功完成鉴权 `/models` 后，provider 才会进入
      // currentCatalog。此结果就是权威的凭证/端点就绪状态；不能再从 TUI 进程的
      // process.env 复查，因为生产安全栈会在启动时把 key 迁入 Broker 并清空环境变量。
      const endpointReady = liveProbe.live.has(entry.providerId);
      ready = endpointReady;
      readyHint = !endpointReady
        ? t(`Start ${entry.providerName} first`, `需先启动 ${entry.providerName}`)
        : t(`${entry.providerName} ready`, `${entry.providerName} 已就绪`);
    } else if (!entry.requiresApiKey) {
      ready = true;
      readyHint = entry.local ? t("local/no key", "本地/免 key") : t("no key", "免 key");
    } else if (!inspectCredentials) {
      ready = undefined;
      readyHint = t("Credential validated by host", "凭证由宿主校验");
    } else {
      const credentialState = descriptor
        ? inspectProviderCredential(descriptor, entry.spec)
        : { ready: false };
      ready = credentialState.ready;
      readyHint = ready
        ? t(
            `${credentialState.source ?? t("Credential", "凭证")} configured`,
            `${credentialState.source ?? t("Credential", "凭证")} 已配置`,
          )
        : t(
            `Missing ${apiKeyEnv.join("/") || "API key"}`,
            `缺 ${apiKeyEnv.join("/") || "API key"}`,
          );
    }
    return {
      providerId: entry.providerId,
      spec: entry.spec,
      label: entry.label ?? entry.model,
      providerName: entry.providerName,
      free: Boolean(entry.free),
      openWeight: Boolean(entry.openWeight),
      recommended: Boolean(entry.recommended),
      local: entry.local,
      ...(entry.note ? { note: entry.note } : {}),
      ready,
      readyHint,
    };
  });
  // 已就绪 provider 优先，未配置凭证的旧/备用 provider 下沉；稳定排序保留各 provider
  // 与其模型的原始顺序，分组不会被拆散。
  const rank = (row: PickerRow) => (row.ready === true ? 0 : row.ready === undefined ? 1 : 2);
  return rows.sort((a, b) => rank(a) - rank(b));
}

interface ProviderProbe {
  probed: Set<string>;
  live: Set<string>;
  /** 成功读取鉴权 `/models` 的 provider 才出现在 map 中。 */
  models: Map<string, readonly string[]>;
}

/** 用实时 `/models` 清理静态目录，并把服务新增的模型立即补进选择器。 */
function syncDiscoveredModels(
  catalog: readonly ModelCatalogEntry[],
  providers: readonly ProviderDescriptor[],
  discovered: ReadonlyMap<string, readonly string[]> | undefined,
): ModelCatalogEntry[] {
  if (!discovered || discovered.size === 0) return [...catalog];
  const byProvider = new Map<string, ModelCatalogEntry[]>();
  for (const entry of catalog) {
    const rows = byProvider.get(entry.providerId) ?? [];
    rows.push(entry);
    byProvider.set(entry.providerId, rows);
  }
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  const order = [
    ...new Set([
      ...providers.map((provider) => provider.id),
      ...catalog.map((entry) => entry.providerId),
      ...discovered.keys(),
    ]),
  ];
  const result: ModelCatalogEntry[] = [];
  for (const providerId of order) {
    const staticRows = byProvider.get(providerId) ?? [];
    const liveModels = discovered.get(providerId);
    if (!liveModels) {
      result.push(...staticRows);
      continue;
    }
    const live = new Set(liveModels);
    const known = new Set<string>();
    for (const entry of staticRows) {
      if (!live.has(entry.model)) continue;
      result.push(entry);
      known.add(entry.model);
    }
    const provider = providerById.get(providerId);
    if (!provider) continue;
    for (const model of liveModels) {
      if (known.has(model)) continue;
      result.push({
        model,
        label: model,
        providerId,
        providerName: provider.name,
        spec: `${providerId}/${model}`,
        local: provider.local,
        requiresApiKey: provider.requiresApiKey,
      });
    }
  }
  return result;
}

/** 按搜索词过滤选择器行（匹配 label / spec / provider）。 */
export function filterPickerRows(rows: readonly PickerRow[], filter: string): PickerRow[] {
  const q = filter.trim().toLowerCase();
  if (!q) return [...rows];
  return rows.filter(
    (r) =>
      r.spec.toLowerCase().includes(q) ||
      r.label.toLowerCase().includes(q) ||
      r.providerName.toLowerCase().includes(q),
  );
}

// opencode 同款选择器高亮色（暖橙）。
const PICKER_HL = "#f6b17a";
const PICKER_BG = "#1c1c1c";

/** 同 truncWidth，但保留尾部、省略号放在头部（路径的尾巴比头部有信息量）。 */
function truncWidthStart(s: string, max: number): string {
  if (dispWidth(s) <= max) return s;
  if (max <= 0) return "";
  const chars = graphemes(s);
  let out = "";
  let w = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = chars[i]!.width;
    if (w + cw > max - 1) break;
    out = chars[i]!.text + out;
    w += cw;
  }
  return "…" + out;
}

/** 提示条：按 " · " 连接，放不下就从尾部整条丢弃——截成半截词没有意义。 */
function fitHints(hints: readonly string[], width: number): string {
  let n = hints.length;
  while (n > 0 && dispWidth(hints.slice(0, n).join(" · ")) > width) n--;
  return hints.slice(0, n).join(" · ");
}

function ModelPicker({
  rows,
  index,
  filter,
  width = 72,
  maxRows = 24,
}: {
  rows: PickerRow[];
  index: number;
  filter: string;
  width?: number;
  maxRows?: number;
}) {
  const visible = filterPickerRows(rows, filter);
  const height = Math.max(8, Math.min(12, maxRows));
  const inner = Math.max(1, width - 2); // 仅扣除左右边框；内容背景必须贴边铺满
  type Entry =
    | { kind: "provider"; name: string }
    | { kind: "model"; row: PickerRow; index: number }
    | { kind: "empty" }
    | { kind: "no-match" };
  const entries: Entry[] = [];
  visible.forEach((row, rowIndex) => {
    if (rowIndex === 0 || visible[rowIndex - 1]?.providerName !== row.providerName) {
      entries.push({ kind: "provider", name: row.providerName });
    }
    entries.push({ kind: "model", row, index: rowIndex });
  });
  // 标题占 1 行、边框占 2 行；其余候选围绕高亮项开窗并在面板底部对齐。
  const maxEntries = Math.max(1, height - 3);
  const selectedLine = Math.max(
    0,
    entries.findIndex((entry) => entry.kind === "model" && entry.index === index),
  );
  const start =
    entries.length > maxEntries
      ? Math.min(
          Math.max(0, selectedLine - Math.floor(maxEntries / 2)),
          entries.length - maxEntries,
        )
      : 0;
  const windowEntries: Entry[] =
    visible.length === 0 ? [{ kind: "no-match" }] : entries.slice(start, start + maxEntries);
  // 负边距让选择器覆盖 transcript。每一行必须真正写满背景色，否则终端上一帧的
  // 字符会从“空白”处透出；候选不足时在顶部补不透明空行，使内容仍贴着输入框。
  const paintedEntries: Entry[] = [
    ...Array.from({ length: Math.max(0, maxEntries - windowEntries.length) }, () => ({
      kind: "empty" as const,
    })),
    ...windowEntries,
  ];
  const fill = (used: number) => " ".repeat(Math.max(0, inner - used));
  const title = t("Select model", "选择模型");
  const titleGap = Math.max(1, inner - dispWidth(title) - dispWidth("esc"));

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      width={width}
      height={height}
    >
      <Text backgroundColor={PICKER_BG} wrap="truncate">
        <Text bold>{title}</Text>
        {" ".repeat(titleGap)}
        <Text dimColor>esc</Text>
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {paintedEntries.map((entry, i) => {
          if (entry.kind === "empty") {
            return (
              <Text key={`empty:${i}`} backgroundColor={PICKER_BG} wrap="truncate">
                {" ".repeat(inner)}
              </Text>
            );
          }
          if (entry.kind === "no-match") {
            const label = t("(no matching models)", "（无匹配模型）");
            return (
              <Text key="no-match" backgroundColor={PICKER_BG} dimColor wrap="truncate">
                {label}
                {fill(dispWidth(label))}
              </Text>
            );
          }
          if (entry.kind === "provider") {
            const providerName = terminalInlineText(entry.name);
            return (
              <Text
                key={`provider:${start + i}:${entry.name}`}
                backgroundColor={PICKER_BG}
                color="magenta"
                bold
                wrap="truncate"
              >
                {providerName}
                {fill(dispWidth(providerName))}
              </Text>
            );
          }
          const { row, index: globalIdx } = entry;
          const selected = globalIdx === index;
          const label = terminalInlineText(row.label);
          const rightTag = terminalInlineText(
            row.free ? "Free" : row.ready === false ? row.readyHint : "",
          );
          // 选中行画成整行暖橙底、深色字（对齐 opencode）。
          if (selected) {
            const rightW = dispWidth(rightTag);
            const left = truncWidth(`● ${label}`, inner - rightW - 1);
            const pad = Math.max(1, inner - dispWidth(left) - rightW);
            return (
              <Text key={row.spec} backgroundColor={PICKER_HL} color="black">
                {left}
                {" ".repeat(pad)}
                {rightTag}
              </Text>
            );
          }
          return (
            <Text key={row.spec} backgroundColor={PICKER_BG} wrap="truncate">
              {"  "}
              {truncWidth(label, Math.max(1, inner - dispWidth(rightTag) - 3))}
              {fill(
                2 +
                  dispWidth(truncWidth(label, Math.max(1, inner - dispWidth(rightTag) - 3))) +
                  dispWidth(rightTag),
              )}
              <Text dimColor>{rightTag}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

// ---------- 欢迎页 logo（仅首次进入 / 空会话展示，对齐 opencode） ----------

/** 取 s 在 [from, to) 这段全局列区间内的可见部分；s 自身占据 [offset, offset+s.length)。 */
function clipSegment(s: string, offset: number, from: number, to: number): string {
  const a = Math.max(from, offset);
  const b = Math.min(to, offset + s.length);
  return b <= a ? "" : s.slice(a - offset, b - offset);
}

// opencode 风格：5 行实心块（█）大字 wordmark，笔画 1 格宽（与 opencode 同等纤细），
// 字形普遍 4 列宽（i 3 列），字间留 1 空列。前段 ani 中灰、后段 code 亮白。
const LOGO_ROWS = 5;
const LOGO_GLYPHS: Record<string, string[]> = {
  a: [" ██ ", "█  █", "████", "█  █", "█  █"],
  n: ["█  █", "██ █", "█ ██", "█  █", "█  █"],
  i: ["███", " █ ", " █ ", " █ ", "███"],
  c: [" ███", "█   ", "█   ", "█   ", " ███"],
  o: ["████", "█  █", "█  █", "█  █", "████"],
  d: ["███ ", "█  █", "█  █", "█  █", "███ "],
  e: ["████", "█   ", "███ ", "█   ", "████"],
};

/** 把若干字母拼成 LOGO_ROWS 行块字（字间 1 空列）。 */
function bigWord(letters: string): string[] {
  const rows: string[] = Array.from({ length: LOGO_ROWS }, () => "");
  const chars = [...letters];
  chars.forEach((ch, idx) => {
    const g = LOGO_GLYPHS[ch]!;
    for (let r = 0; r < LOGO_ROWS; r++) rows[r] += (idx > 0 ? " " : "") + g[r];
  });
  return rows;
}

export function Welcome({ width }: { width: number }) {
  const head = bigWord("ani");
  const tail = bigWord("code");
  const headW = head[0]!.length;
  const bigW = headW + 1 + tail[0]!.length; // ani + 空列 + code
  // 始终画完整 logo；放不下就居中裁两侧（大不了两边显示不全），不回落、不折行。
  // marginBottom 与下方输入框之间留出间距（对齐 opencode 的呼吸感）。
  const from = Math.max(0, Math.floor((bigW - width) / 2));
  const to = from + Math.min(width, bigW);
  return (
    <Box flexDirection="column" alignItems="center" marginBottom={2} aria-hidden={true}>
      {Array.from({ length: LOGO_ROWS }).map((_, r) => (
        <Text key={r} wrap="truncate">
          <Text color="#6b6b6b">{clipSegment(head[r]!, 0, from, to)}</Text>
          <Text>{clipSegment(" ", headW, from, to)}</Text>
          <Text color="#e6e6e6" bold>
            {clipSegment(tail[r]!, headW + 1, from, to)}
          </Text>
        </Text>
      ))}
    </Box>
  );
}

/** 空会话欢迎页提示：对齐 opencode 的橙色 Tip 标记与命令高亮。 */
export function WelcomeTip({ width }: { width: number }) {
  if (width < 28) return null;
  const cardWidth = Math.min(64, width - 4);
  return (
    <Box width={width} justifyContent="center" marginTop={1} aria-hidden={true}>
      <Box width={cardWidth}>
        <Text wrap="wrap">
          <Text color="#f59e0b">● </Text>
          <Text color="#f59e0b" bold>
            Tip
          </Text>
          <Text dimColor>
            {t(" Describe the outcome directly, or run ", " 直接说明目标，或运行 ")}
          </Text>
          <Text bold>/help</Text>
          <Text dimColor>
            {t(
              " to explore commands; research, writing, analysis, planning, and code are all welcome",
              " 查看命令；调研、写作、分析、规划和代码任务都可以",
            )}
          </Text>
        </Text>
      </Box>
    </Box>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function mergePendings(a: PendingPerm[], b: PendingPerm[]): PendingPerm[] {
  const merged = new Map<string, PendingPerm>();
  for (const p of [...a, ...b]) merged.set(p.permId, p);
  return [...merged.values()].slice(0, MAX_PENDING_PERMISSIONS);
}

interface MouseInput {
  wheelDelta: number;
  leftClick?: { column: number; row: number };
}

/**
 * 批量解析一个 stdin chunk 里的 xterm SGR 鼠标事件。触控板常把十几条序列合并；
 * Ink 只会剥掉第一个 ESC，所以全局扫描并同时接受后续仍带 ESC 的序列。
 */
export function parseMouseInput(input: string): MouseInput | null {
  const event = /(?:\x1b)?\[<(\d+);(\d+);(\d+)([mM])/g;
  let found = false;
  const result: MouseInput = { wheelDelta: 0 };
  for (const match of input.matchAll(event)) {
    found = true;
    const button = Number(match[1]);
    if ((button & 64) !== 0) {
      result.wheelDelta += (button & 1) === 0 ? -1 : 1;
    } else if (match[4] === "M" && (button & 3) === 0 && (button & 32) === 0) {
      result.leftClick = { column: Number(match[2]), row: Number(match[3]) };
    }
  }
  return found ? result : null;
}

function isTodoProgress(value: unknown): value is { type: "todos"; todos: TodoItem[] } {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; todos?: unknown };
  return v.type === "todos" && Array.isArray(v.todos);
}

/**
 * 从子 agent 转发上来的内部事件里提炼一条「它正在干什么」的活动行。
 * 只取工具动作（信息量最大）：tool_start=正在调用某工具，tool_result=某工具刚完成；
 * 嵌套子 agent（编排型再往下派）的事件是 tool_progress 套 tool_progress，递归下钻到叶子，
 * 每下探一层加一个 › 前缀表示层级。文本/思考等噪声事件返回 null（不刷新活动行）。
 */
export function subagentActivityLine(inner: unknown): string | null {
  if (!inner || typeof inner !== "object") return null;
  const e = inner as {
    type?: string;
    name?: string;
    ruleKey?: string;
    isError?: boolean;
    event?: unknown;
  };
  switch (e.type) {
    case "tool_start":
      return `⚙ ${e.name ?? ""}${e.ruleKey ? ` ${truncate(e.ruleKey, 40)}` : ""}`.trim();
    case "tool_result":
      return `${e.isError ? "✖" : "✔"} ${e.name ?? ""}`.trim();
    case "tool_progress": {
      const deeper = subagentActivityLine(e.event);
      return deeper ? `› ${deeper}` : null;
    }
    default:
      return null;
  }
}

function TodoList({ todos }: { todos: TodoItem[] }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      aria-role="list"
    >
      <Text dimColor>{t("Task list", "任务清单")}</Text>
      {todos.map((todo, i) => {
        const mark = todo.status === "completed" ? "✔" : todo.status === "in_progress" ? "●" : "○";
        const markColor =
          todo.status === "completed" ? "green" : todo.status === "in_progress" ? "yellow" : "gray";
        const text =
          todo.status === "in_progress" && todo.activeForm ? todo.activeForm : todo.content;
        return (
          <Text key={`${i}:${todo.content}`}>
            <Text color={markColor as never}>{mark} </Text>
            <Text
              {...(todo.status === "in_progress"
                ? { color: "yellow" as const, bold: true }
                : todo.status === "completed"
                  ? { dimColor: true }
                  : {})}
            >
              {terminalInlineText(text)}
            </Text>
          </Text>
        );
      })}
    </Box>
  );
}

/** 斜杠命令补全菜单（in-tree 版，用于非浮层模式/测试）；高亮项暖橙底。 */
function CommandMenu({
  rows,
  index,
  width,
}: {
  rows: CommandMenuRow[];
  index: number;
  width: number;
}) {
  const idx = Math.max(0, Math.min(index, rows.length - 1));
  const viewportHeight = Math.max(1, Math.min(10, rows.length));
  const panelHeight = viewportHeight + 2;
  const start =
    rows.length > viewportHeight
      ? Math.min(Math.max(0, idx - Math.floor(viewportHeight / 2)), rows.length - viewportHeight)
      : 0;
  const visible = rows.slice(start, start + viewportHeight);
  const nameCol =
    Math.min(18, Math.max(1, ...rows.map((r) => dispWidth("/" + terminalInlineText(r.name))))) + 2;
  const inner = Math.max(1, width - 2);
  const fill = (used: number) => " ".repeat(Math.max(0, inner - used));
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      width={width}
      height={panelHeight}
      overflow="hidden"
    >
      {visible.map((r, i) => {
        const globalIndex = start + i;
        const name = "/" + terminalInlineText(r.name);
        const namePad = name + " ".repeat(Math.max(1, nameCol - dispWidth(name)));
        const description = truncWidth(
          terminalInlineText(r.description),
          Math.max(1, inner - dispWidth(namePad)),
        );
        const trailing = fill(dispWidth(namePad) + dispWidth(description));
        if (globalIndex === idx) {
          return (
            <Text key={r.name} backgroundColor={PICKER_HL} color="black" wrap="truncate">
              <Text bold>{namePad}</Text>
              {description}
              {trailing}
            </Text>
          );
        }
        return (
          <Text key={r.name} backgroundColor={PICKER_BG} wrap="truncate">
            <Text color="#f6b17a">{namePad}</Text>
            <Text dimColor>{description}</Text>
            {trailing}
          </Text>
        );
      })}
    </Box>
  );
}

function SessionList({
  sessions,
  index,
  filter,
  currentId,
}: {
  sessions: SessionSummary[];
  index: number;
  filter: string;
  currentId: string;
}) {
  const viewportHeight = 10;
  const idx = Math.max(0, Math.min(index, sessions.length - 1));
  const start =
    sessions.length > viewportHeight
      ? Math.min(
          Math.max(0, idx - Math.floor(viewportHeight / 2)),
          sessions.length - viewportHeight,
        )
      : 0;
  const visible = sessions.slice(start, start + viewportHeight);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      aria-role="listbox"
    >
      <Text color="cyan" bold>
        {t("Sessions", "会话列表")}
      </Text>
      <Text dimColor>
        {filter ? `${terminalInlineText(filter)} ` : ""}
        {t("Search · ↑↓ select · Enter open · esc close", "搜索 · ↑↓ 选择 · Enter 打开 · esc 关闭")}
      </Text>
      {sessions.length === 0 ? (
        <Text dimColor>
          {filter
            ? t("(no matching sessions)", "（无匹配会话）")
            : t("(no sessions)", "（暂无会话）")}
        </Text>
      ) : null}
      {visible.map((s, i) => {
        const selected = start + i === idx;
        const current = s.id === currentId;
        return (
          <Text
            key={s.id}
            {...(selected ? { backgroundColor: PICKER_HL, color: "black" } : {})}
            aria-label={`${terminalInlineText(s.title ?? t("(untitled)", "(无标题)"))} ${terminalInlineText(s.model)}`}
          >
            {current ? "● " : "  "}
            {terminalInlineText(s.title ?? t("(untitled)", "(无标题)"))}
            {s.running ? t(" · running", " · 运行中") : ""}
            <Text dimColor={!selected}> {terminalInlineText(s.model)}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

function PermissionPanel({
  pending,
  pendingCount,
  index,
  termRows,
  termCols,
  showPermissionControls,
}: {
  pending: PendingPerm;
  pendingCount: number;
  index: number;
  termRows: number;
  termCols: number;
  showPermissionControls: boolean;
}) {
  const rememberable = permissionAnswersFor(pending).includes("allow_remember");
  const networkApproval = pending.toolName.toLowerCase() === "bash" && pending.network === true;
  const options = [
    {
      keyName: "y",
      label: networkApproval
        ? t("Allow network once", "本次允许联网")
        : t("Allow once", "允许一次"),
      short: networkApproval ? t("Network once", "联网一次") : t("Once", "一次"),
      color: "green",
    },
    ...(rememberable
      ? [
          {
            keyName: "a",
            label: t("Allow for this session", "本会话允许并记住"),
            short: t("Session", "会话"),
            color: "cyan",
          },
          {
            keyName: "p",
            label: t("Always allow in this project", "永久允许（写入项目）"),
            short: t("Project", "项目"),
            color: "magenta",
          },
        ]
      : []),
    { keyName: "n", label: t("Deny", "拒绝"), short: t("Deny", "拒绝"), color: "red" },
  ];
  const title = `${t("⚠ Permission request: ", "⚠ 授权请求: ")}${terminalInlineText(
    pending.toolName,
  )} · ${(pending.risk ?? "medium").toUpperCase()}${networkApproval ? t(" · NETWORK", " · 联网") : ""}${
    pendingCount > 1
      ? t(` (${pendingCount - 1} more pending)`, `（还有 ${pendingCount - 1} 个待裁决）`)
      : ""
  }`;
  const compact = termRows < 16;

  if (termRows < 8) {
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        overflow="hidden"
        aria-role="radiogroup"
      >
        <Text color="yellow" bold wrap="truncate">
          {truncWidth(
            `⚠ ${terminalInlineText(pending.toolName)}${networkApproval ? t(" · NETWORK", " · 联网") : ""}`,
            Math.max(1, termCols - 2),
          )}
        </Text>
        <Text wrap="truncate">
          [<Text color="red">n</Text>] {t("Deny", "拒绝")} · [<Text color="green">y</Text>]{" "}
          {networkApproval ? t("Network once", "联网一次") : t("Once", "一次")}
        </Text>
      </Box>
    );
  }

  if (compact) {
    const selected = options[index] ?? options[0]!;
    // Deny is deliberately first so it remains visible even in the narrowest
    // supported terminal; arrows still reach every option and Enter confirms.
    const compactKeys = [options[options.length - 1]!, ...options.slice(0, -1)];
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        overflow="hidden"
        aria-role="radiogroup"
      >
        <Text color="yellow" bold wrap="truncate">
          {truncWidth(title, Math.max(1, termCols - 4))}
        </Text>
        <Text bold wrap="truncate">
          {truncWidth(terminalInlineText(pending.ruleKey, 16 * 1024), Math.max(1, termCols - 4))}
        </Text>
        <Text inverse bold wrap="truncate">
          {`› [${selected.keyName}] ${selected.label}`}
        </Text>
        <Text wrap="truncate">
          {compactKeys.map((option, optionIndex) => (
            <React.Fragment key={option.keyName}>
              {optionIndex > 0 ? " · " : ""}[<Text color={option.color}>{option.keyName}</Text>]{" "}
              {option.short}
            </React.Fragment>
          ))}
        </Text>
        <Text dimColor wrap="truncate">
          {showPermissionControls
            ? t(
                "↑↓ select · Enter confirm · Shift+Tab mode",
                "↑↓ 选择 · Enter 确认 · Shift+Tab 切模式",
              )
            : t("↑↓ select · Enter confirm", "↑↓ 选择 · Enter 确认")}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
      aria-role="radiogroup"
    >
      <Box>
        <Text color="yellow" bold>
          {title}
        </Text>
      </Box>
      {pending.cwd ? (
        <Box>
          <Text>{`cwd: ${terminalInlineText(pending.cwd)}`}</Text>
        </Box>
      ) : null}
      <Box>
        <Text bold>{terminalDisplayText(pending.ruleKey, 16 * 1024)}</Text>
      </Box>
      <Box>
        <Text>{permissionInputPreview(pending.input)}</Text>
      </Box>
      {permissionPatchPreview(pending.input, 6).map((line, lineIndex) => (
        <Box key={`patch:${lineIndex}`}>
          <Text
            color={line.startsWith("+") ? "green" : line.startsWith("-") ? "red" : "gray"}
            wrap="truncate"
          >
            {truncWidth(line, Math.max(1, termCols - 4))}
          </Text>
        </Box>
      ))}
      {pending.rulePartsComplete === false ? (
        <Text color="red" bold>
          {t("Command analysis is incomplete", "无法完整解析命令边界")}
        </Text>
      ) : null}
      {options.map(({ keyName, label, color }, optionIndex) => (
        <Box key={keyName} aria-role="radio" aria-state={{ selected: optionIndex === index }}>
          <Text inverse={optionIndex === index} bold>
            {optionIndex === index ? "› " : "  "}[<Text color={color}>{keyName}</Text>] {label}
          </Text>
        </Box>
      ))}
      <Box>
        <Text>
          {showPermissionControls
            ? t(
                "↑↓ select · Enter confirm · Shift+Tab mode",
                "↑↓ 选择 · Enter 确认 · Shift+Tab 切模式",
              )
            : t("↑↓ select · Enter confirm", "↑↓ 选择 · Enter 确认")}
        </Text>
      </Box>
    </Box>
  );
}

// opencode 同款输入面板：整块底色比屏底稍亮一档、左侧青色竖条，撑满整行宽度。
const PANEL_BG = "#1e1e1e";
const PANEL_BAR = "#22d3ee";
// 取词放到调用点（渲染时），保证 /lang 切换后占位文案随之更新（不是 import 期冻结一次）。
const panelPlaceholder = () =>
  t(
    "Describe your goal… e.g. “research this topic” or “fix a failing test”",
    "输入你的目标… 例如「调研这个主题」或「修复失败测试」",
  );
const PANEL_DIM = "#9a9a9a";

function pad(width: number, used: number): string {
  return " ".repeat(Math.max(0, width - used));
}

/** 按显示列取 s 的 [from, to) 段；宽字符被窗口边界劈开时用空格占位，避免整行错列。 */
function sliceCols(s: string, from: number, to: number): string {
  return sliceTerminalColumns(s, from, to);
}

/** 按显示宽度把文本折成多行（保留原有换行；CJK 无词边界，按列硬折即可）。 */
function wrapCols(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    const total = dispWidth(para);
    if (total === 0) {
      out.push("");
      continue;
    }
    for (let start = 0; start < total; start += width)
      out.push(sliceCols(para, start, start + width));
  }
  return out.length > 0 ? out : [""];
}

/**
 * 用户消息气泡：与输入框同款——左侧青色竖条 + 深灰底 + 上下留白，整行填满背景。
 * 对齐 opencode 的用户消息展示。文本按可用宽度折行。
 */
function UserBubble({ text, width }: { text: string; width: number }) {
  const avail = Math.max(1, width - 3); // 竖条(1) + 左空格(1) + 右留白(1)
  const lines = wrapCols(terminalDisplayText(text), avail);
  const rows: { content: React.ReactNode; used: number }[] = [
    { content: null, used: 0 },
    ...lines.map((line) => ({
      content: (
        <>
          {" "}
          <Text color="#e6e6e6">{line}</Text>
        </>
      ),
      used: 1 + dispWidth(line),
    })),
    { content: null, used: 0 },
  ];
  return (
    <Box flexDirection="column" width={width} marginTop={1}>
      {rows.map((r, i) => (
        <Text key={i} backgroundColor={PANEL_BG} wrap="truncate">
          <Text color={PANEL_BAR}>▎</Text>
          {r.content}
          {pad(width, 1 + r.used)}
        </Text>
      ))}
    </Box>
  );
}

type Seg = { t: string; color: string };

/** 按列预算依次裁剪各段：整段放得下就原样，跨越边界的那段截断，之后的整段丢弃。 */
function fitSegments(segs: Seg[], budget: number): Seg[] {
  const out: Seg[] = [];
  let left = budget;
  for (const s of segs) {
    if (left <= 0) break;
    const w = dispWidth(s.t);
    if (w <= left) {
      out.push(s);
      left -= w;
    } else {
      out.push({ ...s, t: truncWidth(s.t, left) });
      left = 0;
    }
  }
  return out;
}

/**
 * 输入行的水平滚动窗口。单行输入放不下时不折行（会撑破面板）也不截断（会看不见正在敲的字），
 * 而是让窗口跟着光标走：文本放得下就从头显示，放不下就把光标块钉在右边缘。
 * App 用它算真实光标该停在第几列，InputPanel 用它取可见片段——两边必须同一套算法。
 */
export function inputView(text: string, cursor: number, width: number) {
  const avail = Math.max(1, width - 2); // 竖条 + 前导空格之后留给文本的列数
  const c = clampGraphemeIndex(text, cursor);
  const caretX = dispWidth(text.slice(0, c));
  const next = nextGraphemeIndex(text, c);
  const at = text.slice(c, next) || " "; // 文末光标是一个空块
  const endX = caretX + dispWidth(at);
  const totalX = Math.max(dispWidth(text), endX);
  const startX = totalX <= avail ? 0 : Math.min(caretX, Math.max(0, endX - avail));
  return { avail, caretX, at, endX, startX };
}

export interface ComposerLayout {
  lines: Array<{ text: string; start: number; end: number }>;
  activeLine: number;
  visibleStart: number;
  visibleLines: Array<{ text: string; start: number; end: number }>;
  activeVisibleLine: number;
}

export interface ComposerCaretPosition {
  /** Ink output-relative column, zero-based. */
  x: number;
  /** Ink output-relative row, zero-based. */
  y: number;
}

/**
 * 输入框插入点在 Ink 整帧中的真实终端坐标。这里与 InputPanel 共用 composerLayout /
 * inputView，确保中文宽字符、emoji、水平开窗和多行输入时 IME 光标都落在绘制光标上。
 */
export function composerCaretPosition(options: {
  panelTop: number;
  text: string;
  cursor: number;
  width: number;
  maxInputRows: number;
  terminalRows: number;
}): ComposerCaretPosition {
  const layout = composerLayout(options.text, options.cursor, options.maxInputRows);
  const line = layout.lines[layout.activeLine]!;
  const { caretX, startX } = inputView(line.text, options.cursor - line.start, options.width);
  return {
    // 竖条占第 0 列、前导空格占第 1 列，文本/插入点从第 2 列开始。
    x: Math.max(0, Math.min(options.width - 1, 2 + caretX - startX)),
    // 面板第 0 行是上留白，编辑器从下一行开始。
    y: Math.max(
      0,
      Math.min(options.terminalRows - 1, options.panelTop + 1 + layout.activeVisibleLine),
    ),
  };
}

/** Logical-line viewport for the multiline composer. */
export function composerLayout(
  text: string,
  cursor: number,
  maxVisibleLines: number,
): ComposerLayout {
  const safe = clampGraphemeIndex(text, cursor);
  const rawLines = text.split("\n");
  let offset = 0;
  const lines = rawLines.map((line) => {
    const entry = { text: line, start: offset, end: offset + line.length };
    offset += line.length + 1;
    return entry;
  });
  const currentStart = lineStart(text, safe);
  const activeLine = Math.max(
    0,
    lines.findIndex((line) => line.start === currentStart),
  );
  const count = Math.max(1, maxVisibleLines);
  const visibleStart = Math.max(
    0,
    Math.min(activeLine - Math.floor(count / 2), Math.max(0, lines.length - count)),
  );
  const visibleLines = lines.slice(visibleStart, visibleStart + count);
  return {
    lines,
    activeLine,
    visibleStart,
    visibleLines,
    activeVisibleLine: activeLine - visibleStart,
  };
}

export function InputPanel({
  panelRef,
  text,
  cursor,
  model,
  running,
  spinner,
  width,
  maxInputRows = 5,
  placeholder,
}: {
  panelRef?: React.Ref<DOMElement>;
  text: string;
  cursor: number;
  model: string;
  running: boolean;
  spinner: string;
  width: number;
  maxInputRows?: number;
  placeholder?: string | undefined;
}) {
  if (width <= 3) {
    return (
      <Box
        width={Math.max(1, width)}
        ref={panelRef}
        overflow="hidden"
        aria-role="textbox"
        aria-label={`${t("Prompt", "输入")}: ${text || placeholder || panelPlaceholder()}`}
        aria-state={{ multiline: true, busy: running }}
      >
        <Text wrap="truncate">{running ? spinner : "›"}</Text>
      </Box>
    );
  }
  const barColor = running ? "gray" : PANEL_BAR;
  const cursorCell = (ch: string) => (
    <Text color="black" backgroundColor="#dcdcdc">
      {ch}
    </Text>
  );

  const layout = composerLayout(text, cursor, maxInputRows);
  const editorRows = layout.visibleLines.map((line, visibleIndex) => {
    const active = visibleIndex === layout.activeVisibleLine;
    const localCursor = active ? cursor - line.start : line.text.length;
    const { avail, caretX, at, endX, startX } = inputView(line.text, localCursor, width);
    if (!text && active) {
      const ph = truncWidth(placeholder ?? panelPlaceholder(), Math.max(0, avail - 1));
      return {
        key: line.start,
        node: (
          <>
            {" "}
            {cursorCell(" ")}
            <Text color={PANEL_DIM}>{ph}</Text>
          </>
        ),
        used: 2 + dispWidth(ph),
      };
    }
    if (!active) {
      const content = truncWidth(line.text, avail);
      return {
        key: line.start,
        node: <> {content}</>,
        used: 1 + dispWidth(content),
      };
    }
    const before = sliceCols(line.text, startX, caretX);
    const after = sliceCols(line.text, endX, startX + avail);
    return {
      key: line.start,
      node: (
        <>
          {" "}
          {before}
          {cursorCell(at)}
          {after}
        </>
      ),
      used: 1 + dispWidth(before) + dispWidth(at) + dispWidth(after),
    };
  });

  // 模型行只显示 provider 后面的模型标识；项目名与会话标题已在其他界面提供。
  // 例如 deepseek/deepseek-v4-flash → deepseek-v4-flash；OpenRouter 的嵌套 model id 保留。
  const safeModel = terminalInlineText(model);
  const slash = safeModel.indexOf("/");
  const modelLabel = slash >= 0 ? safeModel.slice(slash + 1) : safeModel;

  // 前导空格 +（运行中才画的 spinner）+ 模型名按剩余列预算裁掉。
  // 空闲态不再显示 ● 点（对齐 opencode）；spinner 仅在生成时作为活动指示出现。
  const metaSegs = fitSegments([{ t: modelLabel, color: "white" }], Math.max(0, width - 4));
  // 前导 1 列空格；运行时再加 spinner + 空格（共 3 列），空闲时只占 1 列。
  const metaUsed = (running ? 3 : 1) + metaSegs.reduce((w, s) => w + dispWidth(s.t), 0);

  // 每行统一：竖条(▎, 1/4 块，宽 1 格) + 内容 + 补白；竖条贯穿整块高度（对齐 opencode）。
  // wrap=truncate 兜底：上面的列宽都算准了才不会真截到字，但即便算漏一格，
  // 也只是少画一列，而不是折行把面板撑成两行、竖条断掉。
  const bar = <Text color={barColor}>▎</Text>;
  const rowLine = (content: React.ReactNode, used: number) => (
    <Text backgroundColor={PANEL_BG} wrap="truncate">
      {bar}
      {content}
      {pad(width, 1 + used)}
    </Text>
  );

  return (
    <Box
      flexDirection="column"
      width={width}
      ref={panelRef}
      aria-role="textbox"
      aria-label={`${t("Prompt", "输入")}: ${
        text ? terminalDisplayText(text) : (placeholder ?? panelPlaceholder())
      }. ${t("Model", "模型")}: ${modelLabel}`}
      aria-state={{ multiline: true, busy: running }}
    >
      {rowLine(null, 0)}
      {editorRows.map((row) => (
        <React.Fragment key={row.key}>{rowLine(row.node, row.used)}</React.Fragment>
      ))}
      {rowLine(null, 0)}
      {rowLine(
        <>
          {" "}
          {running ? (
            <>
              <Text color="yellow">{spinner}</Text>{" "}
            </>
          ) : null}
          {metaSegs.map((s) => (
            <Text key={s.t} color={s.color}>
              {s.t}
            </Text>
          ))}
        </>,
        metaUsed,
      )}
      {rowLine(null, 0)}
    </Box>
  );
}

// memo：历史条目引用不变时跳过重渲染，流式期间只有尾部活动条目会更新。
const ItemView = React.memo(ItemViewImpl);

function ItemViewImpl({
  item,
  width,
  expanded = false,
}: {
  item: Item;
  width?: number;
  expanded?: boolean;
}) {
  switch (item.kind) {
    case "info":
      return <Text dimColor>{terminalDisplayText(item.text)}</Text>;
    case "user":
      // 有终端宽度时用青色竖条 + 深灰底的气泡（对齐 opencode）；无宽度（兜底）退回 ❯ 前缀。
      return width ? (
        <UserBubble text={item.text} width={width} />
      ) : (
        <Box>
          <Text color="blue" bold>
            ❯{" "}
          </Text>
          <Text>{terminalDisplayText(item.text)}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box>
          <Text color="green">● </Text>
          <MarkdownText text={terminalDisplayText(item.text)} />
        </Box>
      );
    case "tool": {
      const mark =
        item.status === "run"
          ? "⚙"
          : item.status === "ok"
            ? "✔"
            : item.status === "deny"
              ? "⊘"
              : "✖";
      const color =
        item.status === "ok"
          ? "cyan"
          : item.status === "err"
            ? "red"
            : item.status === "deny"
              ? "yellow"
              : "gray";
      return (
        <Box flexDirection="column">
          <Text color={color as never}>
            {` ${mark} ${sanitizeTerminalText(item.name)}`}
            <Text dimColor> {truncWidth(sanitizeTerminalText(item.ruleKey), 50)}</Text>
            {item.detail ? (
              <Text dimColor> — {firstLine(sanitizeTerminalText(item.detail))}</Text>
            ) : null}
            {item.detail ? (
              <Text dimColor>{expanded ? " [ctrl+o: collapse]" : " [ctrl+o: expand]"}</Text>
            ) : null}
          </Text>
          {expanded && item.detail ? (
            <Box marginLeft={3} borderStyle="single" borderColor="gray" paddingX={1}>
              <MarkdownText text={terminalDisplayText(item.detail, 16 * 1024)} />
            </Box>
          ) : null}
        </Box>
      );
    }
    case "error":
      return <Text color="red">✖ {terminalDisplayText(item.text)}</Text>;
  }
}
