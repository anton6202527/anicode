import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage } from "@anicode/core";
import { fileChangeFor } from "./filechange.js";

function toolMsg(id: string, name: string, args: Record<string, unknown>): ChatMessage {
  return { role: "assistant", content: [{ type: "tool_call", id, name, args }] };
}

test("fileChangeFor: write → 全部新增，路径与统计正确", () => {
  const msgs = [toolMsg("t1", "write", { path: "src/a.ts", content: "line1\nline2\nline3" })];
  const fc = fileChangeFor(msgs, "t1");
  assert.ok(fc);
  assert.equal(fc!.kind, "write");
  assert.equal(fc!.path, "src/a.ts");
  assert.equal(fc!.added, 3);
  assert.equal(fc!.removed, 0);
  assert.ok(fc!.lines.every((l) => l.t === "add"));
});

test("fileChangeFor: edit → old/new 的行级 diff", () => {
  const msgs = [
    toolMsg("t2", "edit", { path: "b.py", old_string: "a\nb\nc", new_string: "a\nB\nc\nd" }),
  ];
  const fc = fileChangeFor(msgs, "t2");
  assert.ok(fc);
  assert.equal(fc!.kind, "edit");
  assert.equal(fc!.added, 2);
  assert.equal(fc!.removed, 1);
});

test("fileChangeFor: 非文件工具或未知 id → null", () => {
  const msgs = [toolMsg("t3", "bash", { command: "ls" })];
  assert.equal(fileChangeFor(msgs, "t3"), null);
  assert.equal(fileChangeFor(msgs, "missing"), null);
});
