import React, { useEffect, useRef } from "react";
import { t } from "@anicode/core";
import type { ChatState, PendingPerm } from "../useSession.js";
import type { Item } from "../transcript.js";
import { Markdown } from "../markdown.js";

interface Props {
  state: ChatState;
  onAnswerPermission: (permId: string, decision: "allow" | "allow_remember" | "deny") => void;
}

export function ChatView({ state, onAnswerPermission }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const activeTools = [...state.activeTools.values()];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state.items.length, state.liveText, activeTools.length, state.pendings.length]);

  const empty =
    state.items.length === 0 && !state.liveText && activeTools.length === 0 && !state.opening;

  return (
    <div className="chat-scroll">
      <div className="chat-inner">
        {empty ? <EmptyState /> : null}
        {state.items.map((item, i) => (
          <ItemRow key={i} item={item} />
        ))}
        {state.liveText ? <Bubble role="assistant" text={state.liveText} streaming /> : null}
        {activeTools.map((tool) => (
          <ToolRow key={tool.id} item={tool} />
        ))}
        {state.todos.length > 0 ? <TodoCard todos={state.todos} /> : null}
        {state.pendings[0] ? (
          <PermissionCard
            pending={state.pendings[0]}
            onAnswer={onAnswerPermission}
            extra={state.pendings.length - 1}
          />
        ) : null}
        {state.running && !state.liveText && activeTools.length === 0 ? (
          <div className="thinking">● {t("Thinking…", "思考中…")}</div>
        ) : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-logo">◆</div>
      <h1>{t("What would you like to do today?", "今天需要做点什么？")}</h1>
      <p>
        {t(
          "Type a request to start chatting. Uses the zero-network debug/demo model by default; switch it in the bottom-right.",
          "输入需求开始对话。默认使用零网络的 debug/demo 模型，可在右下角切换。",
        )}
      </p>
    </div>
  );
}

function ItemRow({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <Bubble role="user" text={item.text} />;
    case "assistant":
      return <Bubble role="assistant" text={item.text} />;
    case "tool":
      return <ToolRow item={item} />;
    case "info":
      return <div className="notice">{item.text}</div>;
    case "error":
      return <div className="notice error">✖ {item.text}</div>;
  }
}

function Bubble({
  role,
  text,
  streaming,
}: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className={`row ${role}`}>
      <div className="avatar">{role === "user" ? t("You", "你") : "◆"}</div>
      <div className="bubble">
        {role === "assistant" ? <Markdown text={text} /> : text}
        {streaming ? <span className="caret" /> : null}
      </div>
    </div>
  );
}

function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const mark =
    item.status === "run" ? "⚙" : item.status === "ok" ? "✔" : item.status === "deny" ? "⊘" : "✖";
  return (
    <div className={`tool status-${item.status}`}>
      <span className="tool-mark">{mark}</span>
      <span className="tool-name">{item.name}</span>
      <span className="tool-key">{item.ruleKey}</span>
      {item.detail ? <span className="tool-detail">— {item.detail}</span> : null}
    </div>
  );
}

function TodoCard({ todos }: { todos: ChatState["todos"] }) {
  return (
    <div className="todo-card">
      <div className="todo-title">{t("Task list", "任务清单")}</div>
      {todos.map((t, i) => {
        const mark = t.status === "completed" ? "✔" : t.status === "in_progress" ? "●" : "○";
        const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.content;
        return (
          <div key={i} className={`todo-item ${t.status}`}>
            <span>{mark}</span> {text}
          </div>
        );
      })}
    </div>
  );
}

function PermissionCard({
  pending,
  onAnswer,
  extra,
}: {
  pending: PendingPerm;
  onAnswer: (permId: string, decision: "allow" | "allow_remember" | "deny") => void;
  extra: number;
}) {
  return (
    <div className="perm-card">
      <div className="perm-title">
        ⚠ {t("Permission request:", "授权请求：")}
        <strong>{pending.toolName}</strong>
        {extra > 0 ? (
          <span className="perm-more">
            {t(`(${extra} more pending)`, `（还有 ${extra} 个待裁决）`)}
          </span>
        ) : null}
      </div>
      <div className="perm-key">{pending.ruleKey}</div>
      <div className="perm-actions">
        <button className="btn allow" onClick={() => onAnswer(pending.permId, "allow")}>
          {t("Allow", "允许")}
        </button>
        <button className="btn remember" onClick={() => onAnswer(pending.permId, "allow_remember")}>
          {t("Allow and remember", "允许并记住")}
        </button>
        <button className="btn deny" onClick={() => onAnswer(pending.permId, "deny")}>
          {t("Deny", "拒绝")}
        </button>
      </div>
    </div>
  );
}
