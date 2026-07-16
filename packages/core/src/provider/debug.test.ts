import { test } from "node:test";
import assert from "node:assert/strict";
import { DebugProvider } from "./debug.js";
import { createProvider } from "./registry.js";
import type { ChatMessage, StreamEvent } from "../types.js";
import { textMessage, toolCallsOf } from "../types.js";

async function collect(provider: DebugProvider, messages: ChatMessage[]): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of provider.stream({ model: "demo", messages })) events.push(event);
  return events;
}

test("DebugProvider: debug/demo 均可零 key 解析并流式 echo", async () => {
  assert.equal(createProvider("debug/demo").provider.name, "debug");
  assert.equal(createProvider("demo/default").provider.name, "debug");

  const provider = new DebugProvider({ delayMs: 0, chunkSize: 5 });
  const events = await collect(provider, [textMessage("user", "你好")]);
  const deltas = events
    .filter((event) => event.type === "text_delta")
    .map((event) => event.text)
    .join("");
  assert.match(deltas, /Debug provider \(demo\) 收到：你好/);
  assert.ok(events.filter((event) => event.type === "text_delta").length > 1);
  const done = events.at(-1);
  assert.ok(done && done.type === "done");
  assert.equal(done.stopReason, "end_turn");
  assert.ok(done.usage.inputTokens > 0);
});

test("DebugProvider: 四种指令生成可执行的工具场景", async () => {
  const provider = new DebugProvider({ delayMs: 0 });
  const cases = [
    ["!todo", ["todo_write"]],
    ["!write", ["write"]],
    ["!bash", ["bash"]],
    ["!parallel", ["glob", "read"]],
  ] as const;

  for (const [input, names] of cases) {
    const events = await collect(provider, [textMessage("user", input)]);
    const done = events.at(-1);
    assert.ok(done && done.type === "done");
    assert.equal(done.stopReason, "tool_use");
    assert.deepEqual(
      toolCallsOf(done.message).map((call) => call.name),
      names,
    );
    assert.equal(events.filter((event) => event.type === "tool_call_start").length, names.length);
    assert.equal(events.filter((event) => event.type === "tool_call_end").length, names.length);
  }
});

test("DebugProvider: 工具结果后收尾，不重复发起同一指令", async () => {
  const provider = new DebugProvider({ delayMs: 0 });
  const first = await collect(provider, [textMessage("user", "!bash")]);
  const done = first.at(-1);
  assert.ok(done && done.type === "done");
  const history: ChatMessage[] = [
    textMessage("user", "!bash"),
    done.message,
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "debug_bash_1",
          toolName: "bash",
          content: "anicode debug provider",
        },
      ],
    },
  ];
  const second = await collect(provider, history);
  const secondDone = second.at(-1);
  assert.ok(secondDone && secondDone.type === "done");
  assert.equal(secondDone.stopReason, "end_turn");
  assert.equal(toolCallsOf(secondDone.message).length, 0);
  assert.match(
    second
      .filter((event) => event.type === "text_delta")
      .map((event) => event.text)
      .join(""),
    /bash: 完成/,
  );
});

test("DebugProvider: 已中断请求不会产出事件", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = new DebugProvider({ delayMs: 0 });
  await assert.rejects(
    async () => {
      for await (const _event of provider.stream({
        model: "demo",
        messages: [textMessage("user", "hello")],
        signal: controller.signal,
      })) {
        // drain
      }
    },
    { name: "AbortError" },
  );
});
