/**
 * OpenAI 兼容 provider 的端到端测试（无需真实 API key）：
 * 起一个本地假的 /v1/chat/completions SSE 服务器，验证
 *   请求映射（tool_result → role:"tool"）、流式解析、
 *   分片工具参数聚合、stopReason / usage 映射
 * 的完整闭环 —— 这也是对 Ollama / DeepSeek 等兼容端点行为的回归测试。
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OpenAICompatProvider } from "./openai-compat.js";
import type { ChatMessage, StreamEvent } from "../types.js";
import { textMessage, toolCallsOf } from "../types.js";

let server: http.Server;
let baseURL: string;
let requestCount = 0;
let secondRequestBody: any = null;

function sse(res: http.ServerResponse, payloads: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const p of payloads) res.write(`data: ${JSON.stringify(p)}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const chunkBase = { id: "cmpl-1", object: "chat.completion.chunk", created: 1, model: "fake" };

async function streamToolArgumentFragments(fragments: string[]): Promise<StreamEvent[]> {
  const fixtureServer = http.createServer((req, res) => {
    req.on("end", () => {
      sse(res, [
        {
          ...chunkBase,
          choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
        },
        ...fragments.map((argumentsText, index) => ({
          ...chunkBase,
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    ...(index === 0 ? { id: "call_stream", type: "function" } : {}),
                    function: {
                      ...(index === 0 ? { name: "bash" } : {}),
                      arguments: argumentsText,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        })),
        { ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
      ]);
    });
    req.resume();
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const address = fixtureServer.address();
  assert.ok(address && typeof address !== "string");

  try {
    const provider = new OpenAICompatProvider({
      name: "fragment-fixture",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "test",
      streamUsage: false,
    });
    const events: StreamEvent[] = [];
    for await (const event of provider.stream({ model: "fake", messages: [] })) {
      events.push(event);
    }
    return events;
  } finally {
    await new Promise<void>((resolve, reject) =>
      fixtureServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function assertToolArgumentStream(events: StreamEvent[], expectedJson: string): void {
  const done = events.find((event) => event.type === "done");
  assert.ok(done && done.type === "done");
  assert.deepEqual(toolCallsOf(done.message)[0]?.args, JSON.parse(expectedJson));
  assert.equal(
    events
      .filter((event) => event.type === "tool_call_delta")
      .map((event) => (event.type === "tool_call_delta" ? event.argsText : ""))
      .join(""),
    expectedJson,
  );
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requestCount += 1;
      if (requestCount === 1) {
        // 第一轮：返回一个参数分两片传输的工具调用
        sse(res, [
          {
            ...chunkBase,
            choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
          },
          {
            ...chunkBase,
            choices: [
              {
                index: 0,
                // 某些兼容端点会把 id/name 也拆片；adapter 必须和 arguments 一样聚合。
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_",
                      type: "function",
                      function: { name: "a", arguments: '{"a":' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...chunkBase,
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: "abc", function: { name: "dd", arguments: "12345," } },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          {
            ...chunkBase,
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: '"b":67890}' } }] },
                finish_reason: null,
              },
            ],
          },
          { ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
          {
            ...chunkBase,
            choices: [],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              // DeepSeek reports cache hits at the top level rather than in OpenAI's
              // prompt_tokens_details object.
              prompt_cache_hit_tokens: 40,
            },
          },
        ]);
      } else {
        // 第二轮：记录请求体（验证 tool_result 映射），返回纯文本
        secondRequestBody = JSON.parse(body);
        sse(res, [
          {
            ...chunkBase,
            choices: [
              { index: 0, delta: { role: "assistant", content: "结果是 " }, finish_reason: null },
            ],
          },
          {
            ...chunkBase,
            choices: [{ index: 0, delta: { content: "80235。" }, finish_reason: null }],
          },
          { ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          { ...chunkBase, choices: [], usage: { prompt_tokens: 130, completion_tokens: 8 } },
        ]);
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, () => res()));
  const addr = server.address() as { port: number };
  baseURL = `http://127.0.0.1:${addr.port}/v1`;
});

after(() => server.close());

test("OpenAI 兼容层: 完整工具调用回路", async () => {
  const provider = new OpenAICompatProvider({ name: "fake", baseURL, apiKey: "test" });
  const messages: ChatMessage[] = [textMessage("user", "算一下 12345+67890")];
  const tools = [{ name: "add", description: "加法", parameters: { type: "object" } }];

  // ---- 第一轮：期待工具调用 ----
  const events1: StreamEvent[] = [];
  for await (const ev of provider.stream({ model: "fake", messages, tools })) events1.push(ev);

  const done1 = events1.find((e) => e.type === "done");
  assert.ok(done1 && done1.type === "done");
  assert.equal(done1.stopReason, "tool_use");
  assert.equal(done1.usage.inputTokens, 60);
  assert.equal(done1.usage.cacheReadTokens, 40);

  // 分片参数被正确聚合
  const calls = toolCallsOf(done1.message);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "add");
  assert.deepEqual(calls[0]!.args, { a: 12345, b: 67890 });

  // 事件顺序与 id 配对：start → delta(×3) → end
  const kinds = events1.map((e) => e.type);
  assert.ok(kinds.indexOf("tool_call_start") < kinds.indexOf("tool_call_delta"));
  assert.ok(kinds.lastIndexOf("tool_call_delta") < kinds.indexOf("tool_call_end"));
  for (const event of events1) {
    if (event.type === "tool_call_start" || event.type === "tool_call_delta") {
      assert.equal(event.id, "call_abc");
    } else if (event.type === "tool_call_end") {
      assert.equal(event.part.id, "call_abc");
    }
  }

  // ---- 回传工具结果，第二轮 ----
  messages.push(done1.message);
  messages.push({
    role: "user",
    content: [{ type: "tool_result", toolCallId: "call_abc", toolName: "add", content: "80235" }],
  });

  const events2: StreamEvent[] = [];
  for await (const ev of provider.stream({ model: "fake", messages, tools })) events2.push(ev);

  // 请求体里 tool_result 被正确翻译成 role:"tool" 消息
  const wireMessages = secondRequestBody.messages as any[];
  const toolMsg = wireMessages.find((m) => m.role === "tool");
  assert.ok(toolMsg, "应包含 role:tool 消息");
  assert.equal(toolMsg.tool_call_id, "call_abc");
  assert.equal(toolMsg.content, "80235");
  const assistantMsg = wireMessages.find((m) => m.role === "assistant" && m.tool_calls);
  assert.equal(assistantMsg.tool_calls[0].id, "call_abc");
  assert.equal(assistantMsg.tool_calls[0].function.name, "add");

  // 第二轮输出纯文本并正常收尾
  const text = events2
    .filter((e) => e.type === "text_delta")
    .map((e: any) => e.text)
    .join("");
  assert.equal(text, "结果是 80235。");
  const done2 = events2.find((e) => e.type === "done");
  assert.ok(done2 && done2.type === "done");
  assert.equal(done2.stopReason, "end_turn");
});

test("OpenAI 兼容层: 保留相邻重复的合法工具参数增量", async () => {
  const expectedJson = '{"command":"echo haha"}';
  const events = await streamToolArgumentFragments(['{"command":"echo ', "ha", "ha", '"}']);

  assertToolArgumentStream(events, expectedJson);
});

test("OpenAI 兼容层: 累计全文快照不会被重复拼接", async () => {
  const expectedJson = '{"command":"echo echo"}';
  const events = await streamToolArgumentFragments([
    '{"command":"echo',
    '{"command":"echo',
    '{"command":"echo echo',
    expectedJson,
  ]);

  assertToolArgumentStream(events, expectedJson);
});

test("OpenAI 兼容层: CJK 与跨 chunk surrogate 在增量和累计快照中保持原值", async () => {
  const high = "\ud83d";
  const low = "\ude42";
  const expectedJson = '{"text":"你好🙂"}';

  const incremental = await streamToolArgumentFragments(['{"text":"你', `好${high}`, `${low}"}`]);
  assertToolArgumentStream(incremental, expectedJson);

  const prefix = `{"text":"你好${high}`;
  const snapshots = await streamToolArgumentFragments([prefix, `${prefix}${low}`, expectedJson]);
  assertToolArgumentStream(snapshots, expectedJson);
});

test("OpenAI 兼容层: 工具参数按真实 UTF-8 字节执行 2 MiB 边界", async () => {
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

  const events = await streamToolArgumentFragments(fragments);
  const end = events.find((event) => event.type === "tool_call_end");
  assert.ok(end && end.type === "tool_call_end");
  assert.equal((end.part.args.value as string).length, fill.length + 2);
  assert.equal(
    Buffer.byteLength(
      events
        .filter((event) => event.type === "tool_call_delta")
        .map((event) => (event.type === "tool_call_delta" ? event.argsText : ""))
        .join(""),
      "utf8",
    ),
    limit,
  );

  await assert.rejects(
    () => streamToolArgumentFragments([...fragments.slice(0, -1), "x", suffix]),
    /Provider tool-call arguments limit exceeded/,
  );
});
