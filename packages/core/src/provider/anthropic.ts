/**
 * Anthropic provider —— 统一模型 ↔ Anthropic Messages API 的双向映射。
 *
 * 缓存策略（多轮 agent 的成本生死线）：
 *   断点 1：system 块 —— tools 渲染在 system 之前，此断点把 tools+system 一起缓存
 *   断点 2：最后一条消息的最后一个可缓存块 —— 缓存整个对话前缀，
 *           下一轮只有新增消息按全价计费，其余走 cache read（~0.1x）
 *   （上限 4 个断点，留 2 个余量给未来的分层策略）
 *
 * 其他要点：
 * - 默认 adaptive thinking；effort 映射到 output_config.effort
 * - thinking 块回放必须带原 signature（存在 ThinkingPart.raw），无 signature 则跳过
 * - 请求构造抽成纯函数 buildAnthropicRequest，离线可测
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  ChatMessage,
  ContentPart,
  Provider,
  StopReason,
  StreamEvent,
  StreamRequest,
  ToolCallPart,
  ToolDefinition,
  Usage,
} from "../types.js";
import { emptyUsage } from "../types.js";
import { ANTHROPIC_OAUTH_BETA } from "../auth/oauth.js";
import type { TokenSource } from "../auth/token-source.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  /** 仅对明确支持 adaptive thinking 的模型返回 true；未知模型默认关闭。 */
  adaptiveThinking?: boolean | ((model: string) => boolean);
  /** SDK 内层重试默认关闭，由 Agent 统一处理。 */
  maxRetries?: number;
  /**
   * OAuth 订阅令牌源（Claude Pro/Max）。传入即走 Bearer + oauth beta 头、注入 Claude Code
   * 身份 system 块，并在每次请求前取新 token（临期自动续期）。与 apiKey 互斥优先。
   */
  tokenSource?: TokenSource;
}

export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  private client: Anthropic;
  private readonly adaptiveThinking: AnthropicProviderOptions["adaptiveThinking"];
  private readonly tokenSource: TokenSource | undefined;
  private readonly baseURL: string | undefined;
  private readonly maxRetries: number;
  private builtToken: string | undefined;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.tokenSource = opts.tokenSource;
    this.baseURL = opts.baseURL;
    this.maxRetries = opts.maxRetries ?? 0;
    this.client = new Anthropic({
      // OAuth 模式先给占位 authToken，真正 token 在每次请求前按需构建/刷新。
      ...(this.tokenSource ? { authToken: "pending" } : {}),
      ...(!this.tokenSource && opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(this.tokenSource ? { defaultHeaders: { "anthropic-beta": ANTHROPIC_OAUTH_BETA } } : {}),
      maxRetries: this.maxRetries,
    });
    this.adaptiveThinking = opts.adaptiveThinking;
  }

  /** OAuth 模式：确保 client 持有当前有效 token（变化时重建），返回是否为 OAuth。 */
  private async ensureAuth(): Promise<boolean> {
    if (!this.tokenSource) return false;
    const token = await this.tokenSource.getAccessToken();
    if (token !== this.builtToken) {
      this.client = new Anthropic({
        authToken: token,
        ...(this.baseURL !== undefined ? { baseURL: this.baseURL } : {}),
        defaultHeaders: { "anthropic-beta": ANTHROPIC_OAUTH_BETA },
        maxRetries: this.maxRetries,
      });
      this.builtToken = token;
    }
    return true;
  }

  async *stream(req: StreamRequest): AsyncIterable<StreamEvent> {
    const oauth = await this.ensureAuth();
    const adaptiveThinking =
      typeof this.adaptiveThinking === "function"
        ? this.adaptiveThinking(req.model)
        : (this.adaptiveThinking ?? false);
    const stream = this.client.messages.stream(
      buildAnthropicRequest(req, { adaptiveThinking, oauth }),
      {
        ...(req.signal ? { signal: req.signal } : {}),
      },
    );

    // 按块索引跟踪进行中的 tool_use，便于在 block stop 时按序发出 tool_call_end
    const pendingTools = new Map<number, { id: string; name: string; json: string }>();

    for await (const event of stream) {
      switch (event.type) {
        case "content_block_start": {
          const block = event.content_block;
          if (block.type === "tool_use") {
            pendingTools.set(event.index, { id: block.id, name: block.name, json: "" });
            yield { type: "tool_call_start", id: block.id, name: block.name };
          }
          break;
        }
        case "content_block_delta": {
          const d = event.delta;
          if (d.type === "text_delta") {
            yield { type: "text_delta", text: d.text };
          } else if (d.type === "thinking_delta") {
            yield { type: "thinking_delta", text: d.thinking };
          } else if (d.type === "input_json_delta") {
            const t = pendingTools.get(event.index);
            if (t) {
              t.json += d.partial_json;
              yield { type: "tool_call_delta", id: t.id, argsText: d.partial_json };
            }
          }
          break;
        }
        case "content_block_stop": {
          const t = pendingTools.get(event.index);
          if (t) {
            pendingTools.delete(event.index);
            yield { type: "tool_call_end", part: parseToolCall(t) };
          }
          break;
        }
      }
    }

    const final = await stream.finalMessage();
    yield {
      type: "done",
      stopReason: mapStopReason(final.stop_reason),
      message: fromAnthropicContent(final.content),
      usage: mapUsage(final.usage),
    };
  }
}

// ---------- 请求构造（纯函数，可离线测试） ----------

/**
 * OAuth 订阅令牌要求首个 system 块是 Claude Code 身份声明，否则 API 拒绝。
 * 与 Claude Code / opencode 的做法一致。
 */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

export function buildAnthropicRequest(
  req: StreamRequest,
  options: { adaptiveThinking?: boolean; oauth?: boolean } = {},
): Anthropic.MessageStreamParams {
  const messages = req.messages.map(toAnthropicMessage);
  markLastMessageCache(messages);

  // OAuth 模式：身份块置顶（不缓存，块小）；真正 system 跟在其后并打缓存断点。
  const identityBlock = options.oauth
    ? [{ type: "text" as const, text: CLAUDE_CODE_IDENTITY }]
    : [];
  const userSystem = req.system
    ? [{ type: "text" as const, text: req.system, cache_control: { type: "ephemeral" as const } }]
    : [];
  const system = [...identityBlock, ...userSystem];

  return {
    model: req.model,
    max_tokens: req.maxTokens ?? 32000,
    ...(options.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
    ...(options.adaptiveThinking && req.effort ? { output_config: { effort: req.effort } } : {}),
    ...(system.length ? { system } : {}),
    ...(req.tools?.length ? { tools: req.tools.map(toAnthropicTool) } : {}),
    messages,
  };
}

/** 断点 2：打在最后一条消息的最后一个可缓存块上（thinking 块不可携带，向前找） */
function markLastMessageCache(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1];
  if (!last || !Array.isArray(last.content)) return;
  for (let i = last.content.length - 1; i >= 0; i--) {
    const block = last.content[i]!;
    if (
      block.type === "text" ||
      block.type === "tool_result" ||
      block.type === "tool_use" ||
      block.type === "image"
    ) {
      (block as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = {
        type: "ephemeral",
      };
      return;
    }
  }
}

// ---------- 统一模型 → Anthropic ----------

function toAnthropicTool(t: ToolDefinition): Anthropic.Tool {
  return {
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicMessage(m: ChatMessage): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [];
  for (const part of m.content) {
    switch (part.type) {
      case "text":
        content.push({ type: "text", text: part.text });
        break;
      case "thinking": {
        // 只有带原始 signature 才能回放；否则跳过（Anthropic 会拒绝被篡改的 thinking 块）
        const sig = (part.raw as { signature?: string } | undefined)?.signature;
        if (sig !== undefined) {
          content.push({ type: "thinking", thinking: part.text, signature: sig });
        }
        break;
      }
      case "tool_call":
        content.push({ type: "tool_use", id: part.id, name: part.name, input: part.args });
        break;
      case "tool_result":
        content.push({
          type: "tool_result",
          tool_use_id: part.toolCallId,
          content: part.content,
          ...(part.isError ? { is_error: true } : {}),
        });
        break;
      case "image":
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: part.mediaType as "image/png",
            data: part.data,
          },
        });
        break;
    }
  }
  return { role: m.role, content };
}

// ---------- Anthropic → 统一模型 ----------

function fromAnthropicContent(blocks: Anthropic.ContentBlock[]): ChatMessage {
  const content: ContentPart[] = [];
  for (const block of blocks) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      content.push({ type: "thinking", text: block.thinking, raw: { signature: block.signature } });
    } else if (block.type === "tool_use") {
      content.push({
        type: "tool_call",
        id: block.id,
        name: block.name,
        args: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  return { role: "assistant", content };
}

function parseToolCall(t: { id: string; name: string; json: string }): ToolCallPart {
  let args: Record<string, unknown> = {};
  try {
    args = t.json ? (JSON.parse(t.json) as Record<string, unknown>) : {};
  } catch {
    // 交给上层把解析失败作为 tool_result 错误回传，让模型自行修正
    args = { __unparsed: t.json };
  }
  return { type: "tool_call", id: t.id, name: t.name, args };
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

function mapUsage(u: Anthropic.Usage | undefined): Usage {
  if (!u) return emptyUsage();
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}
