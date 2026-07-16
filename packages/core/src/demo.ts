/**
 * 抽象层端到端验证：一个最小 agent loop，跑通
 *   流式文本 → 工具调用 → 结果回传 → 最终回答
 * 换 provider 只改命令行参数，loop 代码零改动 —— 这就是抽象层要证明的事。
 *
 *   npx tsx src/demo.ts openai/gpt-5.2
 *   npx tsx src/demo.ts anthropic/claude-opus-4-8
 *   npx tsx src/demo.ts ollama/qwen3
 */

import { createProvider, textMessage, toolCallsOf } from "./index.js";
import { t } from "./i18n.js";
import type { ChatMessage, ToolDefinition } from "./index.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const tools: ToolDefinition[] = [
  {
    name: "get_current_time",
    description: "获取当前的日期和时间（ISO 8601 格式）",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "add",
    description: "计算两个数字之和",
    parameters: {
      type: "object",
      properties: {
        a: { type: "number" },
        b: { type: "number" },
      },
      required: ["a", "b"],
      additionalProperties: false,
    },
  },
];

function runTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "get_current_time":
      return new Date().toISOString();
    case "add":
      return String(Number(args["a"]) + Number(args["b"]));
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

async function main() {
  const spec = process.argv[2] ?? "openai/gpt-5.2";
  const { provider, model } = createProvider(spec);
  console.log(dim(`provider=${provider.name} model=${model}\n`));

  const messages: ChatMessage[] = [
    textMessage(
      "user",
      "现在几点了？另外帮我算一下 12345 + 67890。用工具，最后用一句中文总结两个结果。",
    ),
  ];

  // agent loop：直到模型不再调用工具
  for (let turn = 0; turn < 8; turn++) {
    let stopReason = "";
    let finalMessage: ChatMessage | null = null;

    for await (const ev of provider.stream({
      model,
      messages,
      tools,
      effort: "low",
      maxTokens: 4096,
    })) {
      switch (ev.type) {
        case "text_delta":
          process.stdout.write(ev.text);
          break;
        case "thinking_delta":
          break; // demo 里不展示推理
        case "tool_call_start":
          process.stdout.write(`\n${cyan("⚙ 调用工具")} ${ev.name} `);
          break;
        case "tool_call_end":
          process.stdout.write(dim(JSON.stringify(ev.part.args)) + "\n");
          break;
        case "done":
          stopReason = ev.stopReason;
          finalMessage = ev.message;
          console.log(
            dim(
              `\n[turn ${turn}] stop=${ev.stopReason} · in ${ev.usage.inputTokens} (cache ${ev.usage.cacheReadTokens}) / out ${ev.usage.outputTokens}`,
            ),
          );
          break;
      }
    }

    if (!finalMessage)
      throw new Error(t("provider did not emit a done event", "provider 没有产出 done 事件"));
    messages.push(finalMessage);

    const calls = toolCallsOf(finalMessage);
    if (stopReason !== "tool_use" || calls.length === 0) break;

    // 执行工具，把结果作为 user 消息回传
    messages.push({
      role: "user",
      content: calls.map((c) => {
        try {
          return {
            type: "tool_result" as const,
            toolCallId: c.id,
            toolName: c.name,
            content: runTool(c.name, c.args),
          };
        } catch (err) {
          return {
            type: "tool_result" as const,
            toolCallId: c.id,
            toolName: c.name,
            content: String(err),
            isError: true,
          };
        }
      }),
    });
  }
  console.log();
}

main().catch((err) => {
  console.error(String(err?.stack ?? err));
  process.exit(1);
});
