/**
 * Provider 抽象层的统一数据模型。
 *
 * 设计原则：
 * 1. 以「内容块数组」为消息载体（对齐 Anthropic 的表达力上限，OpenAI 侧做降维映射），
 *    这样 thinking / 并行工具调用等高级能力不会在抽象层丢失。
 * 2. 流式事件是唯一的输出通道 —— 非流式只是流式的聚合，不单独建模。
 * 3. provider 私有字段（如 Anthropic thinking 的 signature）通过 `raw` 透传，
 *    保证多轮回放时不破坏各家协议要求。
 */

// ---------- 消息 ----------

export interface TextPart {
  type: "text";
  text: string;
  /** 内部注入的上下文；provider 可见，但 transcript/UI 不应冒充用户原话展示。 */
  internal?: boolean;
}

/** 模型的推理块。回放时必须原样传回（Anthropic 校验 signature） */
export interface ThinkingPart {
  type: "thinking";
  text: string;
  /** provider 私有数据，回放时原样透传（Anthropic: signature） */
  raw?: unknown;
}

/** 模型发起的一次工具调用（出现在 assistant 消息中） */
export interface ToolCallPart {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 工具执行结果（出现在 user 消息中，回传给模型） */
export interface ToolResultPart {
  type: "tool_result";
  toolCallId: string;
  /** 对应的工具名 —— OpenAI 协议回放时需要 */
  toolName: string;
  content: string;
  isError?: boolean;
}

export interface ImagePart {
  type: "image";
  /** e.g. "image/png" */
  mediaType: string;
  /** base64 编码 */
  data: string;
}

export type ContentPart = TextPart | ThinkingPart | ToolCallPart | ToolResultPart | ImagePart;

export interface ChatMessage {
  role: "user" | "assistant";
  content: ContentPart[];
}

// ---------- 工具定义 ----------

export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（object 类型） */
  parameters: Record<string, unknown>;
}

// ---------- 请求 ----------

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamRequest {
  /** provider 原生 model id，如 "claude-opus-4-8" / "gpt-5.2" */
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  /** 推理深度（各 provider 自行映射：Anthropic→output_config.effort，OpenAI→reasoning_effort） */
  effort?: Effort;
  signal?: AbortSignal;
}

// ---------- 流式事件 ----------

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argsText: string }
  | { type: "tool_call_end"; part: ToolCallPart }
  /** 一轮结束：附带聚合好的 assistant 消息（可直接 push 进历史回放） */
  | {
      type: "done";
      stopReason: StopReason;
      message: ChatMessage;
      usage: Usage;
    };

// ---------- Provider 接口 ----------

export interface Provider {
  /** 唯一标识，如 "anthropic" / "openai" / "ollama" */
  readonly name: string;
  /** 发起一次流式补全。实现必须以 done 事件收尾（或抛异常）。 */
  stream(req: StreamRequest): AsyncIterable<StreamEvent>;
}

// ---------- 工具函数 ----------

export function textMessage(role: ChatMessage["role"], text: string): ChatMessage {
  return { role, content: [{ type: "text", text }] };
}

/** 从聚合消息中取出所有工具调用（用于 agent loop 判断是否继续） */
export function toolCallsOf(message: ChatMessage): ToolCallPart[] {
  return message.content.filter((p): p is ToolCallPart => p.type === "tool_call");
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
