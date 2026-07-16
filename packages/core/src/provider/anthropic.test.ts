/**
 * Anthropic 请求构造的离线测试 —— 重点验证缓存断点放置。
 * 断点放错 = 成本悄悄爆炸且无报错，必须用测试钉死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAnthropicRequest, CLAUDE_CODE_IDENTITY } from "./anthropic.js";
import type { ChatMessage } from "../types.js";

const tools = [{ name: "read", description: "读文件", parameters: { type: "object" as const } }];

test("缓存断点: system 块 + 最后一条消息的最后块", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "第一问" }] },
    { role: "assistant", content: [{ type: "text", text: "第一答" }] },
    { role: "user", content: [{ type: "text", text: "第二问" }] },
  ];
  const req = buildAnthropicRequest({ model: "m", system: "sys", messages, tools });

  // system 断点（覆盖 tools+system 前缀）
  const sys = req.system as any[];
  assert.deepEqual(sys[0].cache_control, { type: "ephemeral" });

  // 消息断点只在最后一条的最后块
  const wire = req.messages as any[];
  assert.equal(wire[0].content[0].cache_control, undefined);
  assert.equal(wire[1].content[0].cache_control, undefined);
  assert.deepEqual(wire[2].content[0].cache_control, { type: "ephemeral" });
});

test("OAuth: 身份 system 块置顶且不缓存，用户 system 跟随并打缓存断点", () => {
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  const req = buildAnthropicRequest({ model: "m", system: "sys", messages }, { oauth: true });
  const sys = req.system as any[];
  assert.equal(sys[0].text, CLAUDE_CODE_IDENTITY);
  assert.equal(sys[0].cache_control, undefined); // 身份块不缓存
  assert.equal(sys[1].text, "sys");
  assert.deepEqual(sys[1].cache_control, { type: "ephemeral" });
});

test("OAuth: 非 oauth 模式不注入身份块", () => {
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
  const req = buildAnthropicRequest({ model: "m", system: "sys", messages });
  const sys = req.system as any[];
  assert.equal(sys.length, 1);
  assert.equal(sys[0].text, "sys");
});

test("缓存断点: 最后块是 thinking 时向前找可缓存块", () => {
  // 构造一条以 thinking 结尾的 assistant 消息（极端情形）
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "问" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "答" },
        { type: "thinking", text: "推理", raw: { signature: "sig" } },
      ],
    },
  ];
  const req = buildAnthropicRequest({ model: "m", messages });
  const wire = req.messages as any[];
  const lastMsg = wire[1].content;
  // thinking 块不带 cache_control；断点落在它前面的 text 块
  assert.equal(lastMsg[1].cache_control, undefined);
  assert.deepEqual(lastMsg[0].cache_control, { type: "ephemeral" });
});

test("缓存断点: tool_result 消息也可作为断点载体", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "问" }] },
    {
      role: "assistant",
      content: [{ type: "tool_call", id: "c1", name: "read", args: { path: "a" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", toolCallId: "c1", toolName: "read", content: "文件内容" }],
    },
  ];
  const req = buildAnthropicRequest({ model: "m", messages, tools });
  const wire = req.messages as any[];
  assert.deepEqual(wire[2].content[0].cache_control, { type: "ephemeral" });
  // 中间的 tool_use 不带
  assert.equal(wire[1].content[0].cache_control, undefined);
});

test("thinking 回放: 无 signature 的块被剔除，有 signature 的保留", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "问" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "无签名推理" }, // 无 raw.signature
        { type: "thinking", text: "有签名推理", raw: { signature: "s1" } },
        { type: "text", text: "答" },
      ],
    },
    { role: "user", content: [{ type: "text", text: "继续" }] },
  ];
  const req = buildAnthropicRequest({ model: "m", messages });
  const assistant = (req.messages as any[])[1];
  const kinds = assistant.content.map((b: any) => b.type);
  assert.deepEqual(kinds, ["thinking", "text"]); // 只剩带签名的那条 + 文本
  assert.equal(assistant.content[0].signature, "s1");
});

test("adaptive thinking: 未明确支持的模型默认不发送", () => {
  const req = buildAnthropicRequest({
    model: "private-or-legacy-model",
    messages: [{ role: "user", content: [{ type: "text", text: "问" }] }],
    effort: "high",
  });
  assert.equal(req.thinking, undefined);
  assert.equal(req.output_config, undefined);
});

test("adaptive thinking: profile 明确允许时才发送 thinking 与 effort", () => {
  const req = buildAnthropicRequest(
    {
      model: "claude-opus-4-8",
      messages: [{ role: "user", content: [{ type: "text", text: "问" }] }],
      effort: "high",
    },
    { adaptiveThinking: true },
  );
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.deepEqual(req.output_config, { effort: "high" });
});
