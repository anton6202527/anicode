/**
 * Anthropic 请求构造的离线测试 —— 重点验证缓存断点放置。
 * 断点放错 = 成本悄悄爆炸且无报错，必须用测试钉死。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { AnthropicProvider, buildAnthropicRequest, CLAUDE_CODE_IDENTITY } from "./anthropic.js";
import type { ChatMessage, StreamEvent } from "../types.js";

const tools = [{ name: "read", description: "读文件", parameters: { type: "object" as const } }];

async function streamAnthropicToolArgumentFragments(fragments: string[]): Promise<StreamEvent[]> {
  const wireEvents = [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "tool_stream", name: "read", input: {} },
    },
    ...fragments.map((partial_json) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json },
    })),
    { type: "content_block_stop", index: 0 },
  ];
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield* wireEvents;
    },
    async finalMessage() {
      return {
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tool_stream", name: "read", input: {} }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  };
  const provider = new AnthropicProvider({ apiKey: "test" });
  (provider as unknown as { client: { messages: { stream: () => typeof fakeStream } } }).client = {
    messages: { stream: () => fakeStream },
  };

  const events: StreamEvent[] = [];
  for await (const event of provider.stream({ model: "fake", messages: [] })) {
    events.push(event);
  }
  return events;
}

test("缓存断点: system 块 + 最后一条消息的最后块", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: [{ type: "text", text: "第一问" }] },
    { role: "assistant", content: [{ type: "text", text: "第一答" }] },
    { role: "user", content: [{ type: "text", text: "第二问" }] },
  ];
  const req = buildAnthropicRequest({ model: "m", system: "sys", messages, tools });

  // tools 断点（打在最后一个工具上）
  const wireTools = req.tools as any[];
  assert.deepEqual(wireTools[wireTools.length - 1].cache_control, { type: "ephemeral" });

  // system 断点（覆盖 tools+system 前缀）
  const sys = req.system as any[];
  assert.deepEqual(sys[0].cache_control, { type: "ephemeral" });

  // 消息断点只在最后一条的最后块
  const wire = req.messages as any[];
  assert.equal(wire[0].content[0].cache_control, undefined);
  assert.equal(wire[1].content[0].cache_control, undefined);
  assert.deepEqual(wire[2].content[0].cache_control, { type: "ephemeral" });
});

test("缓存断点: 有 tools 但无 system 时，tools 仍独立打断点（不至于零缓存）", () => {
  const messages: ChatMessage[] = [{ role: "user", content: [{ type: "text", text: "问" }] }];
  const req = buildAnthropicRequest({ model: "m", messages, tools });
  assert.equal(req.system, undefined);
  const wireTools = req.tools as any[];
  assert.deepEqual(wireTools[wireTools.length - 1].cache_control, { type: "ephemeral" });
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

test("Anthropic 流: CJK 与跨 chunk surrogate 参数按原值拼接", async () => {
  const expectedJson = '{"text":"你好🙂"}';
  const events = await streamAnthropicToolArgumentFragments([
    '{"text":"你',
    "好\ud83d",
    '\ude42"}',
  ]);
  const deltas = events
    .filter((event) => event.type === "tool_call_delta")
    .map((event) => (event.type === "tool_call_delta" ? event.argsText : ""));
  assert.equal(deltas.join(""), expectedJson);
  const end = events.find((event) => event.type === "tool_call_end");
  assert.ok(end && end.type === "tool_call_end");
  assert.deepEqual(end.part.args, { text: "你好🙂" });
});

test("Anthropic 流: 工具参数按真实 UTF-8 字节执行 2 MiB 边界", async () => {
  const limit = 2 * 1024 * 1024;
  const prefix = '{"value":"';
  const suffix = '"}';
  const high = "\ud83d";
  const low = "\ude42";
  const fixedBytes = Buffer.byteLength(prefix + high + low + suffix, "utf8");
  const fill = "a".repeat(limit - fixedBytes);
  const fragments = [
    prefix,
    ...Array.from({ length: 128 }, (_, index) =>
      fill.slice((index * fill.length) / 128, ((index + 1) * fill.length) / 128),
    ),
    high,
    low,
    suffix,
  ];

  const events = await streamAnthropicToolArgumentFragments(fragments);
  const end = events.find((event) => event.type === "tool_call_end");
  assert.ok(end && end.type === "tool_call_end");
  assert.equal((end.part.args.value as string).length, fill.length + 2);

  await assert.rejects(
    () => streamAnthropicToolArgumentFragments([...fragments.slice(0, -1), "x", suffix]),
    /Provider tool-call arguments limit exceeded/,
  );
});
