export const MAX_CHAT_REQUEST_BYTES = 512 * 1024;
export const MAX_CHAT_MESSAGES = 512;
export const MAX_CHAT_TOOLS = 128;
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;

// The legacy deepseek-chat/deepseek-reasoner aliases were retired by DeepSeek in July 2026.
// Keep the default gateway catalog limited to the current, explicitly supported model IDs.
export const DEFAULT_ALLOWED_MODELS = [
  "deepseek-v4-flash",
] as const;

type JsonObject = Record<string, unknown>;

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NAME = /^[A-Za-z0-9_-]{1,128}$/u;
const MESSAGE_ROLES = new Set(["system", "user", "assistant", "tool"]);
const MAX_CONTENT_PARTS = 1_024;
const MAX_STOPS = 4;
const MAX_STOP_LENGTH = 1_024;

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  return value;
}

function namedValue(value: unknown, label: string): string {
  const name = stringValue(value, label);
  if (!NAME.test(name)) throw new RangeError(`${label} is invalid`);
  return name;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isInteger(value) || Number(value) < 1 || Number(value) > maximum
  ) {
    throw new RangeError(`max_tokens must be an integer from 1 to ${maximum}`);
  }
  return Number(value);
}

function boundedNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < minimum ||
    value > maximum
  ) {
    throw new RangeError(
      `${label} must be a number from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function messageContent(
  value: unknown,
  label: string,
  nullable: boolean,
): unknown {
  if (value === null && nullable) return null;
  if (typeof value === "string") return value;
  if (
    !Array.isArray(value) || value.length < 1 ||
    value.length > MAX_CONTENT_PARTS
  ) {
    throw new TypeError(`${label} must be text or a non-empty text-part array`);
  }
  // AniCode Cloud is text-only. Reconstruct every part so image URLs and caller-controlled
  // extension fields cannot be forwarded to the upstream provider.
  return value.map((part, index) => {
    const input = objectValue(part, `${label}[${index}]`);
    if (input["type"] !== "text") {
      throw new RangeError(`${label}[${index}] must be text`);
    }
    return {
      type: "text",
      text: stringValue(input["text"], `${label}[${index}].text`),
    };
  });
}

function toolCall(value: unknown, label: string): JsonObject {
  const input = objectValue(value, label);
  if (input["type"] !== "function") {
    throw new RangeError(`${label}.type must be function`);
  }
  const fn = objectValue(input["function"], `${label}.function`);
  const id = stringValue(input["id"], `${label}.id`);
  if (!id || id.length > 256) throw new RangeError(`${label}.id is invalid`);
  return {
    id,
    type: "function",
    function: {
      name: namedValue(fn["name"], `${label}.function.name`),
      arguments: stringValue(fn["arguments"], `${label}.function.arguments`),
    },
  };
}

function chatMessage(value: unknown, index: number): JsonObject {
  const label = `messages[${index}]`;
  const input = objectValue(value, label);
  const role = input["role"];
  if (typeof role !== "string" || !MESSAGE_ROLES.has(role)) {
    throw new RangeError(`${label}.role is not supported`);
  }
  const result: JsonObject = { role };
  if (input["name"] !== undefined) {
    result["name"] = namedValue(input["name"], `${label}.name`);
  }

  if (role === "assistant") {
    result["content"] = messageContent(
      input["content"],
      `${label}.content`,
      true,
    );
    if (input["tool_calls"] !== undefined) {
      if (
        !Array.isArray(input["tool_calls"]) ||
        input["tool_calls"].length > MAX_CHAT_TOOLS
      ) {
        throw new RangeError(`${label}.tool_calls contains too many entries`);
      }
      result["tool_calls"] = input["tool_calls"].map((entry, toolIndex) =>
        toolCall(entry, `${label}.tool_calls[${toolIndex}]`)
      );
    }
    // reasoning_content is intentionally not forwarded. The gateway fixes V4 to non-thinking
    // mode because the current AniCode OpenAI adapter does not retain provider reasoning state.
    return result;
  }

  result["content"] = messageContent(
    input["content"],
    `${label}.content`,
    false,
  );
  if (role === "tool") {
    const toolCallId = stringValue(
      input["tool_call_id"],
      `${label}.tool_call_id`,
    );
    if (!toolCallId || toolCallId.length > 256) {
      throw new RangeError(`${label}.tool_call_id is invalid`);
    }
    result["tool_call_id"] = toolCallId;
  }
  return result;
}

function chatTool(value: unknown, index: number): JsonObject {
  const label = `tools[${index}]`;
  const input = objectValue(value, label);
  if (input["type"] !== "function") {
    throw new RangeError(`${label}.type must be function`);
  }
  const fn = objectValue(input["function"], `${label}.function`);
  const result: JsonObject = {
    type: "function",
    function: {
      name: namedValue(fn["name"], `${label}.function.name`),
      parameters: objectValue(fn["parameters"], `${label}.function.parameters`),
      ...(fn["description"] === undefined ? {} : {
        description: stringValue(
          fn["description"],
          `${label}.function.description`,
        ),
      }),
    },
  };
  return result;
}

function stopValue(value: unknown): string | string[] {
  if (typeof value === "string") {
    if (value.length > MAX_STOP_LENGTH) {
      throw new RangeError("stop is too long");
    }
    return value;
  }
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_STOPS) {
    throw new RangeError(`stop must contain 1 to ${MAX_STOPS} strings`);
  }
  return value.map((entry) => {
    const stop = stringValue(entry, "stop entry");
    if (stop.length > MAX_STOP_LENGTH) {
      throw new RangeError("stop entry is too long");
    }
    return stop;
  });
}

function responseFormat(value: unknown): JsonObject {
  const input = objectValue(value, "response_format");
  if (input["type"] !== "text" && input["type"] !== "json_object") {
    throw new RangeError("response_format.type is not supported");
  }
  return { type: input["type"] };
}

function toolChoice(value: unknown): unknown {
  if (value === "none" || value === "auto" || value === "required") {
    return value;
  }
  const input = objectValue(value, "tool_choice");
  if (input["type"] !== "function") {
    throw new RangeError("tool_choice.type must be function");
  }
  const fn = objectValue(input["function"], "tool_choice.function");
  return {
    type: "function",
    function: { name: namedValue(fn["name"], "tool_choice.function.name") },
  };
}

export function configuredModels(
  value: string | undefined,
): ReadonlySet<string> {
  const configured = (value ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  const models = configured.length > 0
    ? configured
    : [...DEFAULT_ALLOWED_MODELS];
  for (const model of models) {
    if (!MODEL_ID.test(model)) {
      throw new RangeError("configured gateway model ID is invalid");
    }
  }
  return new Set(models);
}

export interface NormalizedChatRequest {
  body: JsonObject;
  model: string;
  maxTokens: number;
}

export function normalizeChatRequest(
  value: unknown,
  allowedModels: ReadonlySet<string>,
  maximumOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
): NormalizedChatRequest {
  const input = objectValue(value, "request");
  const model = input["model"];
  if (typeof model !== "string" || !allowedModels.has(model)) {
    throw new RangeError("model is not available through this gateway");
  }

  const messages = input["messages"];
  if (
    !Array.isArray(messages) || messages.length < 1 ||
    messages.length > MAX_CHAT_MESSAGES
  ) {
    throw new RangeError(
      `messages must contain 1 to ${MAX_CHAT_MESSAGES} entries`,
    );
  }
  const normalizedMessages = messages.map(chatMessage);

  let normalizedTools: JsonObject[] | undefined;
  const tools = input["tools"];
  if (tools !== undefined) {
    if (!Array.isArray(tools) || tools.length > MAX_CHAT_TOOLS) {
      throw new RangeError(
        `tools must contain at most ${MAX_CHAT_TOOLS} entries`,
      );
    }
    normalizedTools = tools.map(chatTool);
  }

  const maxTokens = boundedInteger(
    input["max_tokens"] ?? input["max_completion_tokens"],
    maximumOutputTokens,
    maximumOutputTokens,
  );
  const body: JsonObject = {
    model,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    // V4 defaults to thinking mode. AniCode currently does not retain reasoning_content between
    // tool turns, so force the compatible non-thinking mode rather than allow broken tool loops.
    thinking: { type: "disabled" },
    messages: normalizedMessages,
  };
  if (normalizedTools !== undefined) body["tools"] = normalizedTools;

  if (input["frequency_penalty"] !== undefined) {
    body["frequency_penalty"] = boundedNumber(
      input["frequency_penalty"],
      "frequency_penalty",
      -2,
      2,
    );
  }
  if (input["presence_penalty"] !== undefined) {
    body["presence_penalty"] = boundedNumber(
      input["presence_penalty"],
      "presence_penalty",
      -2,
      2,
    );
  }
  if (input["temperature"] !== undefined) {
    body["temperature"] = boundedNumber(
      input["temperature"],
      "temperature",
      0,
      2,
    );
  }
  if (input["top_p"] !== undefined) {
    body["top_p"] = boundedNumber(input["top_p"], "top_p", 0, 1);
  }
  if (input["logprobs"] !== undefined) {
    if (typeof input["logprobs"] !== "boolean") {
      throw new TypeError("logprobs must be boolean");
    }
    body["logprobs"] = input["logprobs"];
  }
  if (input["top_logprobs"] !== undefined) {
    const topLogprobs = input["top_logprobs"];
    if (
      !Number.isInteger(topLogprobs) || Number(topLogprobs) < 0 ||
      Number(topLogprobs) > 20
    ) {
      throw new RangeError("top_logprobs must be an integer from 0 to 20");
    }
    body["top_logprobs"] = Number(topLogprobs);
  }
  if (input["stop"] !== undefined) body["stop"] = stopValue(input["stop"]);
  if (input["response_format"] !== undefined) {
    body["response_format"] = responseFormat(input["response_format"]);
  }
  if (input["tool_choice"] !== undefined) {
    body["tool_choice"] = toolChoice(input["tool_choice"]);
  }

  return { body, model, maxTokens };
}

/**
 * A byte is a conservative upper bound for a BPE token: every token consumes at least one input
 * byte. Dividing bytes by three under-reserves adversarial/high-entropy input and lets concurrent
 * requests exceed the daily quota before their real usage settles.
 */
export function reservationTokens(
  requestBytes: number,
  maxOutputTokens: number,
): number {
  if (!Number.isSafeInteger(requestBytes) || requestBytes < 0) {
    throw new RangeError("request byte count is invalid");
  }
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new RangeError("maximum output token count is invalid");
  }
  const reserved = requestBytes + maxOutputTokens;
  if (!Number.isSafeInteger(reserved)) {
    throw new RangeError("token reservation is too large");
  }
  return reserved;
}

/** Read a JSON request without ever buffering more than the gateway request limit. */
export async function boundedJson(
  request: Request,
): Promise<{ value: unknown; bytes: number }> {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    if (!/^\d+$/u.test(lengthHeader)) {
      throw new RangeError("invalid content-length");
    }
    const declared = Number(lengthHeader);
    if (!Number.isSafeInteger(declared) || declared > MAX_CHAT_REQUEST_BYTES) {
      throw new RangeError("request body is too large");
    }
  }

  const reader = request.body?.getReader();
  if (!reader) throw new SyntaxError("request body is empty");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_CHAT_REQUEST_BYTES) {
        await reader.cancel("request body is too large").catch(() => undefined);
        throw new RangeError("request body is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  return { value: JSON.parse(text), bytes: total };
}

export function safeJsonError(
  status: number,
  message: string,
  code: string,
  additionalHeaders?: HeadersInit,
): Response {
  const headers = new Headers(additionalHeaders);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return Response.json(
    { error: { message, type: "anicode_gateway_error", code } },
    {
      status,
      headers,
    },
  );
}
