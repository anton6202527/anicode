import React, { useCallback, useEffect, useMemo, useRef } from "react";
import { t } from "@anicode/core/i18n";
import type { ChatState, PendingPerm } from "../useSession.js";
import type { Item } from "../transcript.js";
import { Markdown } from "../markdown.js";

interface Props {
  state: ChatState;
  onAnswerPermission: (
    permId: string,
    decision: "allow" | "allow_remember" | "allow_always" | "deny",
  ) => void;
}

export const ChatView = React.memo(function ChatView({ state, onAnswerPermission }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const activeTools = useMemo(() => [...state.activeTools.values()], [state.activeTools]);

  // A newly opened transcript should start at its latest message, regardless of where the user
  // had scrolled in the previous session.
  useEffect(() => {
    stickToBottomRef.current = true;
  }, [state.meta?.id]);

  // Coalesce scrolling with paint and never enqueue overlapping smooth-scroll animations while
  // tokens stream. If the user scrolls up, preserve their reading position until they return near
  // the bottom.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const element = scrollRef.current;
    if (!element) return;
    const frameId = window.requestAnimationFrame(() => {
      if (stickToBottomRef.current && scrollRef.current === element) {
        element.scrollTop = element.scrollHeight;
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [
    state.items.length,
    state.liveText.length,
    activeTools.length,
    state.todos,
    state.pendings.length,
    state.running,
    state.meta?.id,
  ]);

  const onScroll = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    stickToBottomRef.current = distanceFromBottom <= 96;
  }, []);

  const empty =
    state.items.length === 0 && !state.liveText && activeTools.length === 0 && !state.opening;

  return (
    <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-inner">
        {empty ? <EmptyState /> : null}
        <TranscriptItems items={state.items} />
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
      </div>
    </div>
  );
});

/** The items array is append-only between semantic events, so streaming frames can skip walking
 * and reconciling the entire transcript rather than only skipping each individual row render. */
const TranscriptItems = React.memo(function TranscriptItems({ items }: { items: Item[] }) {
  return (
    <>
      {items.map((item, index) => (
        <ItemRow key={index} item={item} />
      ))}
    </>
  );
});

const EmptyState = React.memo(function EmptyState() {
  return (
    <div className="empty">
      <div className="empty-logo">◆</div>
      <h1>{t("What would you like to do today?", "今天需要做点什么？")}</h1>
      <p>
        {t(
          "Type a request to start chatting. The configured default model is ready; switch it in the bottom-right.",
          "输入需求开始对话。已使用配置的默认模型，也可在右下角切换。",
        )}
      </p>
    </div>
  );
});

const ItemRow = React.memo(function ItemRow({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <Bubble role="user" text={item.text} />;
    case "assistant":
      return <Bubble role="assistant" text={item.text} />;
    case "tool":
      return <ToolRow item={item} />;
    case "info":
      return <div className="notice chat-history-item">{item.text}</div>;
    case "error":
      return <div className="notice error chat-history-item">✖ {item.text}</div>;
  }
});

const Bubble = React.memo(function Bubble({
  role,
  text,
  streaming,
}: {
  role: "user" | "assistant";
  text: string;
  streaming?: boolean;
}) {
  return (
    <div className={`row ${role}${streaming ? " streaming" : " chat-history-item"}`}>
      <div className="avatar">{role === "user" ? t("You", "你") : "◆"}</div>
      <div className="bubble">
        {role === "assistant" && !streaming ? <Markdown text={text} /> : text}
        {streaming ? <span className="caret" /> : null}
      </div>
    </div>
  );
});

const ToolRow = React.memo(function ToolRow({ item }: { item: Extract<Item, { kind: "tool" }> }) {
  const mark =
    item.status === "run" ? "⚙" : item.status === "ok" ? "✔" : item.status === "deny" ? "⊘" : "✖";
  return (
    <div
      className={`tool status-${item.status}${item.status === "run" ? "" : " chat-history-item"}`}
    >
      <span className="tool-mark">{mark}</span>
      <span className="tool-name">{item.name}</span>
      <span className="tool-key">{item.ruleKey}</span>
      {item.detail ? <span className="tool-detail">— {item.detail}</span> : null}
    </div>
  );
});

const TodoCard = React.memo(function TodoCard({ todos }: { todos: ChatState["todos"] }) {
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
});

const PermissionCard = React.memo(function PermissionCard({
  pending,
  onAnswer,
  extra,
}: {
  pending: PendingPerm;
  onAnswer: (
    permId: string,
    decision: "allow" | "allow_remember" | "allow_always" | "deny",
  ) => void;
  extra: number;
}) {
  const requiresOneTimeNetworkApproval =
    pending.toolName.toLowerCase() === "bash" && pending.network;
  return (
    <div className="perm-card">
      <div className="perm-title">
        ⚠ {t("Permission request:", "授权请求：")}
        <strong>{pending.toolName}</strong>
        {requiresOneTimeNetworkApproval ? <strong>{t(" · NETWORK", " · 联网")}</strong> : null}
        {extra > 0 ? (
          <span className="perm-more">
            {t(`(${extra} more pending)`, `（还有 ${extra} 个待裁决）`)}
          </span>
        ) : null}
      </div>
      <div className="perm-key">{pending.ruleKey}</div>
      <div className="perm-actions">
        <button className="btn allow" onClick={() => onAnswer(pending.permId, "allow")}>
          {requiresOneTimeNetworkApproval
            ? t("Allow network once", "本次允许联网")
            : t("Allow", "允许")}
        </button>
        {requiresOneTimeNetworkApproval ? null : (
          <>
            <button
              className="btn remember"
              onClick={() => onAnswer(pending.permId, "allow_remember")}
            >
              {t("Allow and remember", "允许并记住")}
            </button>
            <button
              className="btn remember"
              onClick={() => onAnswer(pending.permId, "allow_always")}
            >
              {t("Always allow (persist)", "永久允许（写入项目）")}
            </button>
          </>
        )}
        <button className="btn deny" onClick={() => onAnswer(pending.permId, "deny")}>
          {t("Deny", "拒绝")}
        </button>
      </div>
    </div>
  );
});
