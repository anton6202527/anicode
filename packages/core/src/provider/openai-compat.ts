/**
 * OpenAI 兼容 provider —— 覆盖 OpenAI 官方 + 一切 OpenAI 兼容端点
 * （Ollama / DeepSeek / vLLM / OpenRouter 等），通过 baseURL 区分。
 *
 * 映射降级说明：
 * - thinking 块不回传（OpenAI 协议无对应物；o 系推理在服务端内部）
 * - tool_result 在 OpenAI 里是独立的 role:"tool" 消息，从统一模型的
 *   user 消息中拆出来，顺序保持在文本之前
 */

import OpenAI from "openai";
import type {
  ChatMessage,
  Provider,
  StopReason,
  StreamEvent,
  StreamRequest,
  ToolCallPart,
  Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";

export interface OpenAICompatOptions {
  /** 显示名，如 "openai" / "ollama" / "deepseek" */
  name?: string;
  apiKey?: string;
  baseURL?: string;
  /** SDK 内层重试次数；默认 0，由 Agent 统一负责重试，避免请求倍增。 */
  maxRetries?: number;
  /** 是否请求流末 usage chunk；部分兼容服务不认识 stream_options。默认 true。 */
  streamUsage?: boolean;
  /** 兼容端点接受的输出上限字段。默认 max_completion_tokens。 */
  maxTokensField?: MaxTokensField;
  /** 是否发送 reasoning_effort；本地/聚合兼容端点通常应关闭。默认 true。 */
  reasoningEffort?: boolean;
  /** 随每个请求发送的非敏感/调用方管理的自定义 header。 */
  defaultHeaders?: Record<string, string>;
}

export type MaxTokensField = "max_completion_tokens" | "max_tokens" | false;

export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private readonly options: OpenAICompatOptions;
  private client: OpenAI | undefined;

  constructor(opts: OpenAICompatOptions = {}) {
    this.name = opts.name ?? "openai";
    this.options = { ...opts };
  }

  private getClient(): OpenAI {
    if (!this.client) {
      const officialOpenAI = this.name === "openai";
      const apiKey =
        this.options.apiKey !== undefined ? this.options.apiKey : officialOpenAI ? undefined : "";
      const clientOptions: ConstructorParameters<typeof OpenAI>[0] = {
        // 显式空 key 也要传递：DeepSeek 等端点缺自己的 key 时，不能悄悄回退
        // 到 OPENAI_API_KEY 并把错误凭证发往第三方。
        ...(apiKey !== undefined ? { apiKey } : {}),
        // OpenAI SDK 还会隐式读取管理员 key/组织/项目。其中管理员 key
        // 会覆盖上面显式传入的第三方 key，所以非官方端点必须显式隔离。
        ...(!officialOpenAI ? { adminAPIKey: null, organization: null, project: null } : {}),
        ...(this.options.baseURL !== undefined ? { baseURL: this.options.baseURL } : {}),
        maxRetries: this.options.maxRetries ?? 0,
        ...(this.options.defaultHeaders ? { defaultHeaders: this.options.defaultHeaders } : {}),
      };

      // OPENAI_CUSTOM_HEADERS 没有对应的 SDK 关闭选项，并且会在构造器中与
      // defaultHeaders 合并。构造器全程同步，因此在这个同步临界区暂时
      // 隐藏该变量，然后立即恢复；调用方显式 defaultHeaders 不受影响。
      this.client = officialOpenAI
        ? new OpenAI(clientOptions)
        : withoutEnvironmentVariable("OPENAI_CUSTOM_HEADERS", () => new OpenAI(clientOptions));
    }
    return this.client;
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    const maxTokensField = this.options.maxTokensField ?? "max_completion_tokens";
    const body: Record<string, unknown> = {
      model: req.model,
      stream: true,
      ...(this.options.streamUsage !== false ? { stream_options: { include_usage: true } } : {}),
      ...(req.maxTokens && maxTokensField ? { [maxTokensField]: req.maxTokens } : {}),
      ...(req.effort && this.options.reasoningEffort !== false
        ? { reasoning_effort: mapEffort(req.effort) }
        : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
          }
        : {}),
      messages: toOpenAIMessages(req.system, req.messages),
    };
    const stream = await this.getClient().chat.completions.create(
      body as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming,
      { ...(req.signal ? { signal: req.signal } : {}) },
    );

    // 按 OpenAI 的 tool_calls index 聚合参数分片
    const pending = new Map<
      number,
      { id: string; name: string; json: string; argFragments: string[] }
    >();
    const textParts: string[] = [];
    let finishReason: string | null = null;
    let usage: Usage = emptyUsage();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (choice?.delta?.content) {
        textParts.push(choice.delta.content);
        yield { type: "text_delta", text: choice.delta.content };
      }
      for (const tc of choice?.delta?.tool_calls ?? []) {
        let entry = pending.get(tc.index);
        if (!entry) {
          entry = { id: "", name: "", json: "", argFragments: [] };
          pending.set(tc.index, entry);
        }
        entry.id = mergeFragment(entry.id, tc.id);
        entry.name = mergeFragment(entry.name, tc.function?.name);
        if (tc.function?.arguments) {
          entry.json += tc.function.arguments;
          entry.argFragments.push(tc.function.arguments);
        }
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          cacheWriteTokens: 0, // OpenAI 缓存写入不单独计费/上报
        };
      }
    }

    // 聚合 assistant 消息
    const toolCalls: ToolCallPart[] = [];
    for (const [index, t] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      // id/name 也可能分片，且协议没有“重命名 tool call”事件。先在 wire stream
      // 内聚合元数据，再用最终稳定 id 回放参数分片，保证 start/delta/end 可配对。
      if (!t.id) t.id = `call_${index}`;
      yield { type: "tool_call_start", id: t.id, name: t.name };
      for (const argsText of t.argFragments) {
        yield { type: "tool_call_delta", id: t.id, argsText };
      }
      const part = parseToolCall(t);
      toolCalls.push(part);
      yield { type: "tool_call_end", part };
    }
    const message: ChatMessage = {
      role: "assistant",
      content: [
        ...(textParts.length ? [{ type: "text" as const, text: textParts.join("") }] : []),
        ...toolCalls,
      ],
    };

    yield {
      type: "done",
      stopReason: mapStopReason(finishReason, toolCalls.length > 0),
      message,
      usage,
    };
  }
}

function withoutEnvironmentVariable<T>(name: string, create: () => T): T {
  const previous = process.env[name];
  delete process.env[name];
  try {
    return create();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/** 兼容“增量片段”和“每次给累计全文”两种非标准实现，避免重复拼接。 */
function mergeFragment(current: string, fragment: string | null | undefined): string {
  if (!fragment) return current;
  if (!current) return fragment;
  if (fragment === current || current.endsWith(fragment)) return current;
  if (fragment.startsWith(current)) return fragment;
  return current + fragment;
}

// ---------- 统一模型 → OpenAI ----------

type OAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

function toOpenAIMessages(system: string | undefined, messages: ChatMessage[]): OAIMessage[] {
  const out: OAIMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const m of messages) {
    if (m.role === "assistant") {
      const text = m.content
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("");
      const toolCalls = m.content
        .filter((p): p is ToolCallPart => p.type === "tool_call")
        .map((p) => ({
          id: p.id,
          type: "function" as const,
          function: { name: p.name, arguments: JSON.stringify(p.args) },
        }));
      out.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user 消息：tool_result 拆成独立 role:"tool" 消息（必须紧跟对应 assistant 轮）
    for (const part of m.content) {
      if (part.type === "tool_result") {
        out.push({
          role: "tool",
          tool_call_id: part.toolCallId,
          content: part.isError ? `[tool error] ${part.content}` : part.content,
        });
      }
    }
    const userParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const part of m.content) {
      if (part.type === "text") {
        userParts.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        userParts.push({
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${part.data}` },
        });
      }
    }
    if (userParts.length) out.push({ role: "user", content: userParts });
  }
  return out;
}

function parseToolCall(t: { id: string; name: string; json: string }): ToolCallPart {
  let args: Record<string, unknown> = {};
  try {
    args = t.json ? (JSON.parse(t.json) as Record<string, unknown>) : {};
  } catch {
    args = { __unparsed: t.json };
  }
  return { type: "tool_call", id: t.id, name: t.name, args };
}

function mapEffort(effort: string): "low" | "medium" | "high" {
  if (effort === "low") return "low";
  if (effort === "medium") return "medium";
  return "high"; // high / xhigh / max → high
}

function mapStopReason(reason: string | null, hasToolCalls: boolean): StopReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    case "stop":
      // 部分兼容端点在带工具调用结束时也报 "stop"
      return hasToolCalls ? "tool_use" : "end_turn";
    default:
      return hasToolCalls ? "tool_use" : "other";
  }
}
