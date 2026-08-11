import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, type AgentEvent } from "./agent.js";
import type { ChatMessage } from "./types.js";
import type { ResolvedModel } from "./provider/registry.js";
import { scriptedProvider } from "./testutil/scripted-provider.js";

function assistant(...content: ChatMessage["content"]): ChatMessage[] {
  return [{ role: "assistant", content }];
}

test("Subagent: provider/model override 通过 resolver 使用另一 provider", async () => {
  const parent = scriptedProvider([
    assistant({
      type: "tool_call",
      id: "task-cross",
      name: "task",
      args: { description: "cross", prompt: "do it", subagent_type: "cross" },
    }),
    assistant({ type: "text", text: "parent done" }),
  ]);
  const child = scriptedProvider([
    assistant({ type: "text", text: "child from another provider" }),
  ]);
  const resolved = {
    provider: child,
    model: "child-model",
    modelInfo: {
      providerId: "other",
      model: "child-model",
      capabilities: { tools: true, reasoning: false },
      limits: { contextWindow: 8_192, maxOutputTokens: 1_024 },
    },
  } as ResolvedModel;
  const agent = new Agent({
    provider: parent,
    model: "parent-model",
    cwd: process.cwd(),
    projectMemory: false,
    permission: { mode: "auto" },
    subagents: [{ name: "cross", description: "cross provider", model: "other/child-model" }],
    resolveModel(spec) {
      assert.equal(spec, "other/child-model");
      return resolved;
    },
  });

  const events: AgentEvent[] = [];
  for await (const event of agent.send("delegate")) events.push(event);

  assert.equal(child.calls.length, 1);
  assert.equal(child.calls[0]?.model, "child-model");
  assert.equal(child.calls[0]?.maxTokens, 1_024);
  assert.equal(parent.calls.length, 2);
  const result = events.find((event) => event.type === "tool_result" && event.name === "task");
  assert.ok(result && result.type === "tool_result");
  assert.match(result.content, /child from another provider/);
});
