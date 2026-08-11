import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent } from "@anicode/core";
import { coalesceSessionEvents } from "./event-batch.js";

const text = (value: string): SessionEvent => ({
  type: "agent",
  event: { type: "text", text: value },
});

test("coalesceSessionEvents: adjacent deltas merge without crossing control boundaries", () => {
  const state: SessionEvent = { type: "state", running: true };
  const events = coalesceSessionEvents([text("a"), text("b"), state, text("c"), text("d")]);
  assert.deepEqual(events, [text("ab"), state, text("cd")]);
});

test("coalesceSessionEvents: thinking and tool inputs retain their distinct streams", () => {
  const events = coalesceSessionEvents([
    { type: "agent", event: { type: "thinking", text: "one" } },
    { type: "agent", event: { type: "thinking", text: " two" } },
    {
      type: "agent",
      event: { type: "tool_input_delta", id: "a", name: "read", delta: '{"path":' },
    },
    {
      type: "agent",
      event: { type: "tool_input_delta", id: "a", name: "read", delta: '"x"}' },
    },
    {
      type: "agent",
      event: { type: "tool_input_delta", id: "b", name: "read", delta: "{}" },
    },
  ]);
  assert.deepEqual(events, [
    { type: "agent", event: { type: "thinking", text: "one two" } },
    {
      type: "agent",
      event: { type: "tool_input_delta", id: "a", name: "read", delta: '{"path":"x"}' },
    },
    {
      type: "agent",
      event: { type: "tool_input_delta", id: "b", name: "read", delta: "{}" },
    },
  ]);
});
