import {
  boundedJson,
  configuredModels,
  MAX_CHAT_REQUEST_BYTES,
  normalizeChatRequest,
  reservationTokens,
} from "./policy.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

function rejects(
  operation: () => unknown,
  message = "expected operation to reject",
): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
}

Deno.test("normalizes a V4 streaming request through strict field allowlists", () => {
  const result = normalizeChatRequest(
    {
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "user",
          content: [{
            type: "text",
            text: "hello",
            image_url: "https://attacker.invalid",
          }],
          caller_extension: "drop-me",
        },
        {
          role: "assistant",
          content: null,
          reasoning_content: "must-not-be-forwarded",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "lookup",
                arguments: "{}",
                transport: "drop-me",
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "done",
          extension: "drop-me",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            description: "look up data",
            parameters: { type: "object", properties: {} },
            remote_url: "https://attacker.invalid",
          },
        },
      ],
      max_tokens: 512,
      stream: false,
      stream_options: { include_usage: false },
      thinking: { type: "enabled" },
      base_url: "http://attacker.invalid",
    },
    configuredModels(undefined),
  );
  assert(result.body["stream"] === true);
  assert(
    (result.body["stream_options"] as { include_usage: boolean })
      .include_usage === true,
  );
  assert((result.body["thinking"] as { type: string }).type === "disabled");
  assert(result.body["base_url"] === undefined);
  const serialized = JSON.stringify(result.body);
  assert(!serialized.includes("attacker.invalid"));
  assert(!serialized.includes("reasoning_content"));
  assert(!serialized.includes("caller_extension"));
});

Deno.test("defaults only to currently deployed DeepSeek V4 models", () => {
  assert(
    JSON.stringify([...configuredModels(undefined)]) ===
      JSON.stringify(["deepseek-v4-flash", "deepseek-v4-pro"]),
  );
  assert(configuredModels("private-model").has("private-model"));
  rejects(() => configuredModels("../../invalid model"));
});

Deno.test("rejects unknown models, deprecated aliases, and excessive output", () => {
  for (
    const input of [
      {
        model: "attacker/model",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        model: "deepseek-chat",
        messages: [{ role: "user", content: "hello" }],
      },
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 99_999,
      },
    ]
  ) {
    rejects(() => normalizeChatRequest(input, configuredModels(undefined)));
  }
});

Deno.test("rejects unsupported roles, image parts, and malformed tools", () => {
  for (
    const messages of [
      [{ role: "developer", content: "hello" }],
      [{
        role: "user",
        content: [{ type: "image_url", image_url: { url: "data:x" } }],
      }],
    ]
  ) {
    rejects(() =>
      normalizeChatRequest(
        { model: "deepseek-v4-flash", messages },
        configuredModels(undefined),
      )
    );
  }
  rejects(() =>
    normalizeChatRequest(
      {
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "remote", endpoint: "https://attacker.invalid" }],
      },
      configuredModels(undefined),
    )
  );
});

Deno.test("validates optional sampling and response fields", () => {
  for (
    const extra of [
      { temperature: Number.NaN },
      { top_p: 2 },
      { logprobs: "yes" },
      { top_logprobs: 21 },
      { stop: ["a", "b", "c", "d", "e"] },
      { response_format: { type: "json_schema", json_schema: {} } },
      { tool_choice: { type: "remote" } },
    ]
  ) {
    rejects(() =>
      normalizeChatRequest(
        {
          model: "deepseek-v4-pro",
          messages: [{ role: "user", content: "hello" }],
          ...extra,
        },
        configuredModels(undefined),
      )
    );
  }
});

Deno.test("reserves a byte-conservative input bound plus output", () => {
  assert(reservationTokens(3_000, 8_192) === 11_192);
  rejects(() => reservationTokens(-1, 8_192));
});

Deno.test("boundedJson parses a normal body and rejects chunked oversized input", async () => {
  const normalBody = JSON.stringify({ model: "deepseek-v4-flash" });
  const parsed = await boundedJson(
    new Request("https://gateway.invalid", {
      method: "POST",
      body: normalBody,
    }),
  );
  assert(parsed.bytes === new TextEncoder().encode(normalBody).byteLength);
  assert((parsed.value as { model: string }).model === "deepseek-v4-flash");

  const oversized = new Uint8Array(MAX_CHAT_REQUEST_BYTES + 1);
  let rejected = false;
  try {
    await boundedJson(
      new Request("https://gateway.invalid", {
        method: "POST",
        body: oversized,
      }),
    );
  } catch (error) {
    rejected = error instanceof RangeError;
  }
  assert(rejected, "oversized request should be rejected while streaming");
});
