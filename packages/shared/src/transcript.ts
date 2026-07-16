/**
 * 从 ChatMessage[] 重建 transcript 条目 —— TUI / Electron app / VSCode 三个前端共用。
 * 纯函数，只依赖 core 类型；resume / 晚订阅时用 snapshot.messages 还原界面靠它。
 */

import type { ChatMessage, TodoItem } from "@anicode/core";

export type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      /** 用于把并行 tool_result 精确关联回对应的 tool_call。 */
      id: string;
      name: string;
      ruleKey: string;
      status: "run" | "ok" | "err" | "deny";
      detail?: string;
    }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export function messagesToItems(messages: readonly ChatMessage[]): Item[] {
  const items: Item[] = [];
  const tools = new Map<string, Extract<Item, { kind: "tool" }>>();
  for (const m of messages) {
    for (const part of m.content) {
      if (part.type === "text" && !part.internal) {
        items.push({ kind: m.role === "user" ? "user" : "assistant", text: part.text });
      } else if (part.type === "tool_call") {
        const item: Extract<Item, { kind: "tool" }> = {
          kind: "tool",
          id: part.id,
          name: part.name,
          ruleKey: ruleKeyOf(part.name, part.args),
          status: "run",
        };
        items.push(item);
        tools.set(part.id, item);
      } else if (part.type === "tool_result") {
        const tool = tools.get(part.toolCallId);
        if (!tool) continue;
        tool.status = part.isError ? "err" : "ok";
        if (part.isError) tool.detail = firstLine(part.content);
      }
    }
  }
  return items;
}

export function todosFromMessages(messages: readonly ChatMessage[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of [...messages[i]!.content].reverse()) {
      if (part.type !== "tool_call" || part.name !== "todo_write") continue;
      const raw = part.args["todos"];
      if (!Array.isArray(raw)) return [];
      return raw.flatMap((item): TodoItem[] => {
        if (!item || typeof item !== "object") return [];
        const o = item as Record<string, unknown>;
        const content = typeof o["content"] === "string" ? o["content"] : "";
        const status = o["status"];
        if (
          !content ||
          (status !== "pending" && status !== "in_progress" && status !== "completed")
        ) {
          return [];
        }
        return [
          {
            content,
            status,
            ...(typeof o["activeForm"] === "string" ? { activeForm: o["activeForm"] } : {}),
          },
        ];
      });
    }
  }
  return [];
}

function ruleKeyOf(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return String(args["command"] ?? "");
  return String(args["path"] ?? args["pattern"] ?? JSON.stringify(args).slice(0, 60));
}

export function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return line.length > 80 ? line.slice(0, 80) + "…" : line;
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
