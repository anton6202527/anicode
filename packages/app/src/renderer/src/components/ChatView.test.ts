import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatState } from "../useSession.js";
import { ChatView } from "./ChatView.js";

function state(overrides: Partial<ChatState>): ChatState {
  return {
    items: [],
    activeTools: new Map(),
    liveText: "",
    running: false,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    todos: [],
    pendings: [],
    meta: null,
    opening: false,
    ...overrides,
  };
}

test("chat view: parses completed assistant messages but keeps streaming text cheap and safe", () => {
  const out = renderToStaticMarkup(
    React.createElement(ChatView, {
      state: state({
        items: [{ kind: "assistant", text: "**settled**" }],
        liveText: "**unfinished** <script>alert(1)</script>",
        running: true,
      }),
      onAnswerPermission: () => {},
    }),
  );

  assert.match(out, /<strong>settled<\/strong>/);
  assert.match(out, /\*\*unfinished\*\*/);
  assert.doesNotMatch(out, /<strong>unfinished<\/strong>/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /class="row assistant streaming"/);
});
