/**
 * useSession —— 订阅一个会话并把事件流折叠成 React 状态。
 * 逻辑对齐 TUI 的 App reducer/handleEvent，但面向 DOM 渲染。
 */

import { useEffect, useReducer, useRef } from "react";
import { t } from "@anicode/core";
import type { SessionEvent, SessionMeta, TodoItem, Usage } from "@anicode/core";
import { messagesToItems, todosFromMessages, type Item } from "./transcript.js";

export interface PendingPerm {
  permId: string;
  toolName: string;
  ruleKey: string;
}

type ToolItem = Extract<Item, { kind: "tool" }>;

export interface ChatState {
  items: Item[];
  activeTools: Map<string, ToolItem>;
  liveText: string;
  running: boolean;
  usage: Usage;
  todos: TodoItem[];
  pendings: PendingPerm[];
  meta: SessionMeta | null;
  opening: boolean;
}

const emptyUsage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

const initialState: ChatState = {
  items: [],
  activeTools: new Map(),
  liveText: "",
  running: false,
  usage: emptyUsage,
  todos: [],
  pendings: [],
  meta: null,
  opening: true,
};

type Action =
  | { t: "reset"; state: Partial<ChatState> }
  | { t: "opening"; v: boolean }
  | { t: "push"; item: Item }
  | { t: "live"; delta: string }
  | { t: "resetLive" }
  | { t: "flushLive" }
  | { t: "toolStart"; id: string; name: string; ruleKey: string }
  | { t: "toolDeny"; id: string }
  | { t: "toolFinish"; id: string; status: "ok" | "err"; detail?: string }
  | { t: "running"; v: boolean }
  | { t: "usage"; u: Usage }
  | { t: "todos"; todos: TodoItem[] }
  | { t: "permAdd"; perm: PendingPerm }
  | { t: "permRemove"; permId: string }
  | { t: "permSet"; perms: PendingPerm[] };

function reducer(s: ChatState, a: Action): ChatState {
  switch (a.t) {
    case "reset":
      return { ...initialState, activeTools: new Map(), ...a.state, opening: false };
    case "opening":
      return { ...s, opening: a.v };
    case "push":
      return { ...s, items: [...s.items, a.item] };
    case "live":
      return { ...s, liveText: s.liveText + a.delta };
    case "resetLive":
      return { ...s, liveText: "" };
    case "flushLive":
      if (!s.liveText) return s;
      return { ...s, items: [...s.items, { kind: "assistant", text: s.liveText }], liveText: "" };
    case "toolStart": {
      const activeTools = new Map(s.activeTools);
      const previous = activeTools.get(a.id);
      activeTools.set(a.id, {
        kind: "tool",
        id: a.id,
        name: a.name,
        ruleKey: a.ruleKey,
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
      return {
        ...s,
        activeTools,
        items: [...s.items, { ...current, status, ...(a.detail ? { detail: a.detail } : {}) }],
      };
    }
    case "running":
      return { ...s, running: a.v };
    case "usage":
      return { ...s, usage: a.u };
    case "todos":
      return { ...s, todos: a.todos };
    case "permAdd":
      if (s.pendings.some((p) => p.permId === a.perm.permId)) return s;
      return { ...s, pendings: [...s.pendings, a.perm] };
    case "permRemove":
      return { ...s, pendings: s.pendings.filter((p) => p.permId !== a.permId) };
    case "permSet":
      return { ...s, pendings: a.perms };
  }
}

function applyEvent(dispatch: React.Dispatch<Action>, se: SessionEvent): void {
  if (se.type === "state") {
    dispatch({ t: "running", v: se.running });
    if (!se.running) dispatch({ t: "flushLive" });
    return;
  }
  if (se.type === "permission_request") {
    dispatch({
      t: "permAdd",
      perm: { permId: se.permId, toolName: se.toolName, ruleKey: se.ruleKey },
    });
    return;
  }
  if (se.type === "permission_resolved") {
    dispatch({ t: "permRemove", permId: se.permId });
    return;
  }
  if (se.type === "reverted") {
    dispatch({
      t: "push",
      item: {
        kind: "info",
        text: t(
          `↩ Workspace rolled back: restored ${se.restored} files, deleted ${se.deleted} new files`,
          `↩ 工作区已回滚：恢复 ${se.restored} 个文件，删除 ${se.deleted} 个新增文件`,
        ),
      },
    });
    return;
  }
  const ev = se.event;
  switch (ev.type) {
    case "user_message":
      dispatch({ t: "flushLive" });
      dispatch({ t: "push", item: { kind: "user", text: ev.text } });
      break;
    case "text":
      dispatch({ t: "live", delta: ev.text });
      break;
    case "tool_progress":
      if (isTodoProgress(ev.event)) dispatch({ t: "todos", todos: ev.event.todos });
      break;
    case "turn_reset":
      dispatch({ t: "resetLive" });
      break;
    case "retry":
      dispatch({
        t: "push",
        item: {
          kind: "info",
          text: t(
            `⟳ Transient error, retry #${ev.attempt} after ${ev.delayMs}ms`,
            `⟳ 瞬时错误，${ev.delayMs}ms 后第 ${ev.attempt} 次重试`,
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
        detail: firstLineOf(ev.content),
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
    case "done":
      dispatch({ t: "flushLive" });
      dispatch({ t: "usage", u: ev.usage });
      break;
    case "error":
      dispatch({ t: "flushLive" });
      dispatch({ t: "push", item: { kind: "error", text: ev.message } });
      break;
  }
}

export interface SessionController {
  state: ChatState;
  answerPermission: (permId: string, decision: "allow" | "allow_remember" | "deny") => void;
}

export function useSession(sessionId: string | null): SessionController {
  const [state, dispatch] = useReducer(reducer, initialState);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  useEffect(() => {
    if (!sessionId) return;
    let closed = false;
    let ready = false;
    let subId: string | null = null;
    const buffered: SessionEvent[] = [];
    dispatch({ t: "opening", v: true });

    const off = window.anicode.onEvent((envelope) => {
      if (closed || envelope.subId !== subId) return;
      if (!ready) {
        buffered.push(envelope.event);
        return;
      }
      applyEvent(dispatch, envelope.event);
    });

    window.anicode
      .open(sessionId)
      .then((result) => {
        if (closed) {
          void window.anicode.close(result.subId);
          return;
        }
        subId = result.subId;
        const snap = result.snapshot;
        const items = messagesToItems(snap.messages);
        const activeTools = new Map<string, ToolItem>();
        const restored: Item[] = [];
        for (const item of items) {
          if (item.kind === "tool" && item.status === "run") activeTools.set(item.id, item);
          else restored.push(item);
        }
        dispatch({
          t: "reset",
          state: {
            items: restored,
            activeTools,
            usage: snap.usage,
            running: snap.running,
            todos: todosFromMessages(snap.messages),
            meta: snap.meta,
            pendings: snap.pendingPermissions,
          },
        });
        ready = true;
        for (const ev of buffered) applyEvent(dispatch, ev);
      })
      .catch((err: unknown) => {
        if (closed) return;
        dispatch({ t: "opening", v: false });
        dispatch({ t: "push", item: { kind: "error", text: errorMessage(err) } });
      });

    return () => {
      closed = true;
      off();
      if (subId) void window.anicode.close(subId);
    };
  }, [sessionId]);

  const answerPermission = (permId: string, decision: "allow" | "allow_remember" | "deny") => {
    const id = sessionRef.current;
    if (!id) return;
    dispatch({ t: "permRemove", permId });
    void window.anicode.answerPermission(id, permId, decision).catch((err: unknown) => {
      dispatch({
        t: "push",
        item: {
          kind: "error",
          text: t(
            `Failed to reply to permission: ${errorMessage(err)}`,
            `授权答复失败: ${errorMessage(err)}`,
          ),
        },
      });
    });
  };

  return { state, answerPermission };
}

function isTodoProgress(value: unknown): value is { type: "todos"; todos: TodoItem[] } {
  if (!value || typeof value !== "object") return false;
  const v = value as { type?: unknown; todos?: unknown };
  return v.type === "todos" && Array.isArray(v.todos);
}

function firstLineOf(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 120 ? line.slice(0, 120) + "…" : line;
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
