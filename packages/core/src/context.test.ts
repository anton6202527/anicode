import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadProjectMemory, composeSystem, estimateTokens, maybeCompact, microcompact } from "./context.js";
import { textMessage, type ChatMessage } from "./types.js";

test("项目记忆: 逐级向上收集 AGENTS.md，止于 .git", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mem-"));
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "AGENTS.md"), "根约定：用 pnpm");
  const sub = path.join(root, "packages", "app");
  await fs.mkdir(sub, { recursive: true });
  await fs.writeFile(path.join(sub, "AGENTS.md"), "子包约定：只写 TSX");

  const mem = await loadProjectMemory(sub);
  assert.match(mem, /子包约定/);
  assert.match(mem, /根约定/);
  // 就近优先：子包在前
  assert.ok(mem.indexOf("子包约定") < mem.indexOf("根约定"));

  const system = composeSystem("你是助手。", mem);
  assert.match(system, /你是助手/);
  assert.match(system, /项目记忆/);

  await fs.rm(root, { recursive: true, force: true });
});

test("项目记忆: 无记忆文件返回空，composeSystem 原样", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mem-"));
  const mem = await loadProjectMemory(dir);
  assert.equal(mem, "");
  assert.equal(composeSystem("base", ""), "base");
  await fs.rm(dir, { recursive: true, force: true });
});

test("compaction: 未超阈值不压缩", async () => {
  const history: ChatMessage[] = [textMessage("user", "hi"), textMessage("assistant", "hello")];
  const res = await maybeCompact(history, {
    triggerTokens: 1_000_000,
    summarizer: async () => "SUMMARY",
  });
  assert.equal(res.compacted, false);
  assert.equal(res.messages.length, 2);
});

test("compaction: 切割点避开 tool_use/tool_result 对（向后找安全边界）", async () => {
  const big = "x".repeat(16_000);
  const history: ChatMessage[] = [];
  // 4 组完整轮次：user → assistant(tool_call) → user(tool_result) → assistant(text)
  for (let i = 0; i < 4; i++) {
    history.push({ role: "user", content: [{ type: "text", text: `${big} 任务${i}` }] });
    history.push({ role: "assistant", content: [
      { type: "tool_call", id: `c${i}`, name: "read", args: { path: "f" } },
    ] });
    history.push({ role: "user", content: [
      { type: "tool_result", toolCallId: `c${i}`, toolName: "read", content: big },
    ] });
    history.push({ role: "assistant", content: [{ type: "text", text: `完成${i}` }] });
  }
  // 期望 cutoff = 16-6 = 10 → 恰落在 user(tool_result) 上，必须向后挪到安全边界
  const res = await maybeCompact(history, {
    triggerTokens: 20_000,
    keepRecentMessages: 6,
    summarizer: async () => "【摘要】",
  });

  assert.equal(res.compacted, true);
  // 摘要对之后的第一条真实消息必须是纯文本 user（不是 tool_result）
  const firstKept = res.messages[2]!;
  assert.equal(firstKept.role, "user");
  assert.ok(
    !firstKept.content.some((p) => p.type === "tool_result"),
    "保留窗口不得以 tool_result 开头",
  );
  // 保留窗口内的 tool_result 必有配对的 tool_use 在窗口内
  const keptIds = new Set(
    res.messages.flatMap((m) => m.content.filter((p) => p.type === "tool_call").map((p: any) => p.id)),
  );
  for (const m of res.messages) {
    for (const p of m.content) {
      if (p.type === "tool_result") {
        assert.ok(keptIds.has(p.toolCallId), `tool_result ${p.toolCallId} 缺配对 tool_use`);
      }
    }
  }
});

test("compaction: 无安全切割点时放弃压缩（不产出坏历史）", async () => {
  const big = "x".repeat(30_000);
  // 一整段超长工具往返，中间没有任何纯文本 user 边界（除了第 0 条）
  const history: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "唯一的开头" }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c1", name: "read", args: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "read", content: big }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c2", name: "read", args: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "c2", toolName: "read", content: big }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c3", name: "read", args: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "c3", toolName: "read", content: big }] },
    { role: "assistant", content: [{ type: "tool_call", id: "c4", name: "read", args: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "c4", toolName: "read", content: big }] },
  ];
  const res = await maybeCompact(history, {
    triggerTokens: 10_000,
    keepRecentMessages: 4,
    summarizer: async () => "【摘要】",
  });
  // 唯一边界是 index 0，切在那里没有意义（older 为空）→ 放弃
  assert.equal(res.compacted, false);
  assert.equal(res.messages.length, history.length);
});

test("compaction: 超阈值时旧轮被摘要，最近轮保留", async () => {
  // 造 20 条消息，每条约 4k token
  const big = "x".repeat(16_000);
  const history: ChatMessage[] = [];
  for (let i = 0; i < 20; i++) {
    history.push(textMessage(i % 2 === 0 ? "user" : "assistant", `${big} #${i}`));
  }
  const before = estimateTokens(history);
  assert.ok(before > 50_000);

  let summarizedCount = 0;
  const res = await maybeCompact(history, {
    triggerTokens: 50_000,
    keepRecentMessages: 4,
    summarizer: async (msgs) => {
      summarizedCount = msgs.length;
      return "【摘要】前面做了很多事";
    },
  });

  assert.equal(res.compacted, true);
  assert.equal(summarizedCount, 16); // 20 - keep(4)
  // 结构：user(占位) + assistant(摘要) + 最近4条
  assert.equal(res.messages.length, 6);
  assert.equal(res.messages[0]!.role, "user");
  assert.equal(res.messages[1]!.role, "assistant");
  assert.match((res.messages[1]!.content[0] as any).text, /摘要/);
  // 最近轮是原文尾部
  assert.match((res.messages[5]!.content[0] as any).text, /#19/);
  assert.ok(res.afterTokens < res.beforeTokens);
});

test("microcompaction: 只清旧工具结果且不修改传入历史", () => {
  const history: ChatMessage[] = [0, 1, 2].flatMap((i) => [
    { role: "assistant" as const, content: [{ type: "tool_call" as const, id: `c${i}`, name: "read", args: {} }] },
    { role: "user" as const, content: [{ type: "tool_result" as const, toolCallId: `c${i}`, toolName: "read", content: `${i}:` + "x".repeat(500) }] },
  ]);
  const res = microcompact(history, 1);
  assert.equal(res.cleared, 2);
  assert.match((history[1]!.content[0] as any).content, /^0:x/);
  assert.match((res.messages[1]!.content[0] as any).content, /已清理/);
  assert.match((res.messages[5]!.content[0] as any).content, /^2:x/);
});

test("compaction: L2 摘要读取原始工具结果，而不是 microcompaction 占位符", async () => {
  const history: ChatMessage[] = [];
  for (let i = 0; i < 4; i++) {
    history.push(textMessage("user", `任务 ${i} ` + "u".repeat(2_000)));
    history.push({ role: "assistant", content: [{ type: "tool_call", id: `c${i}`, name: "read", args: {} }] });
    history.push({ role: "user", content: [{
      type: "tool_result",
      toolCallId: `c${i}`,
      toolName: "read",
      content: `ORIGINAL_RESULT_${i}:` + "r".repeat(2_000),
    }] });
    history.push(textMessage("assistant", `完成 ${i}`));
  }
  let summaryInput: ChatMessage[] = [];
  const res = await maybeCompact(history, {
    triggerTokens: 1_000,
    keepRecentMessages: 4,
    keepToolResults: 0,
    summarizer: async (messages) => {
      summaryInput = messages;
      return "summary";
    },
  });
  assert.equal(res.compacted, true);
  const summarizedText = JSON.stringify(summaryInput);
  assert.match(summarizedText, /ORIGINAL_RESULT_0/);
  assert.doesNotMatch(summarizedText, /旧工具结果已清理/);
});
