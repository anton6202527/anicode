import { createHash } from "node:crypto";
import type { AgentEvent, ChatMessage } from "@anicode/core";

export type EvalOutcomeStatus = "passed" | "failed" | "agent_error" | "timeout" | "skipped";

export interface EvalOutcome {
  status: EvalOutcomeStatus;
  /** A deterministic evaluator, not the model's prose, decided the outcome. */
  verified: boolean;
  evaluator: "command" | "swebench" | "requirements";
  exitCode?: number;
  patchBytes?: number;
}

export interface ToolTrace {
  sequence: number;
  name: string;
  /** Hashes make parameter/result regressions reviewable without retaining potentially sensitive text. */
  argumentsSha256?: string;
  argumentsChars?: number;
  ruleKeySha256: string;
  result: "success" | "error" | "incomplete";
  resultSha256?: string;
  resultChars?: number;
  elapsedMs?: number;
}

export interface TrajectoryMetrics {
  completed: boolean;
  retries: number;
  fallbacks: number;
  compactions: number;
  verifications: number;
  permissionDenials: number;
  calls: ToolTrace[];
  /** Stable over timings and raw text; useful for multi-trial trajectory diversity analysis. */
  signatureSha256: string;
}

export interface FinalResponseMetrics {
  present: boolean;
  chars: number;
  sha256?: string;
  /** Conservative detector; only explicit, non-negated completion language is counted. */
  completionClaim: boolean;
  /** False only when a failed deterministic outcome contradicts an explicit completion claim. */
  outcomeAligned: boolean;
}

interface MutableToolTrace extends ToolTrace {
  id: string;
  startedAt: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableValue(item)]),
    );
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function assistantFinalText(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== "assistant") continue;
    return message.content
      .filter(
        (part): part is Extract<(typeof message.content)[number], { type: "text" }> =>
          part.type === "text",
      )
      .map((part) => part.text)
      .join("")
      .trim();
  }
  return "";
}

function explicitCompletionClaim(text: string): boolean {
  if (!text) return false;
  const hasClaim =
    /\b(?:done|completed|fixed|implemented|resolved|finished)\b/i.test(text) ||
    /(?:已|已经)(?:完成|修复|实现|解决|处理完)/u.test(text);
  if (!hasClaim) return false;
  // Prefer false negatives to falsely accusing a response that honestly reports failure.
  return !/(?:\bnot\b|n't|\bfailed\b|\bfailure\b|\berror\b|未完成|未修复|没有完成|失败|报错|无法)/i.test(
    text,
  );
}

/** Collects a privacy-preserving execution trajectory from the public Agent event stream. */
export class EvalTraceCollector {
  private readonly startedAt = Date.now();
  private readonly calls: MutableToolTrace[] = [];
  private readonly byId = new Map<string, MutableToolTrace>();
  private retries = 0;
  private fallbacks = 0;
  private compactions = 0;
  private verifications = 0;
  private permissionDenials = 0;
  private completed = false;

  record(event: AgentEvent): void {
    if (event.type === "tool_start") {
      const call: MutableToolTrace = {
        id: event.id,
        startedAt: Date.now(),
        sequence: this.calls.length + 1,
        name: event.name,
        ruleKeySha256: sha256(event.ruleKey),
        result: "incomplete",
      };
      this.calls.push(call);
      this.byId.set(event.id, call);
    } else if (event.type === "tool_result") {
      const call = this.byId.get(event.id);
      if (call) {
        call.result = event.isError ? "error" : "success";
        call.resultChars = event.content.length;
        call.resultSha256 = sha256(event.content);
        call.elapsedMs = Math.max(0, Date.now() - call.startedAt);
      }
    } else if (event.type === "tool_permission" && event.decision === "deny") {
      this.permissionDenials++;
    } else if (event.type === "retry") {
      this.retries++;
    } else if (event.type === "model_fallback") {
      this.fallbacks++;
    } else if (event.type === "compacted") {
      this.compactions++;
    } else if (event.type === "verification") {
      this.verifications++;
    } else if (event.type === "done") {
      this.completed = true;
    }
  }

  finish(
    messages: readonly ChatMessage[],
    outcomeStatus: EvalOutcomeStatus,
  ): { trajectory: TrajectoryMetrics; finalResponse: FinalResponseMetrics } {
    const argumentsById = new Map<string, unknown>();
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.content) {
        if (part.type === "tool_call") argumentsById.set(part.id, part.args);
      }
    }
    for (const call of this.calls) {
      const args = argumentsById.get(call.id);
      if (args !== undefined) {
        const serialized = stableJson(args);
        call.argumentsChars = serialized.length;
        call.argumentsSha256 = sha256(serialized);
      }
    }
    const publicCalls: ToolTrace[] = this.calls.map(
      ({ id: _id, startedAt: _startedAt, ...call }) => call,
    );
    const signatureSha256 = sha256(
      stableJson({
        calls: publicCalls.map((call) => ({
          name: call.name,
          argumentsSha256: call.argumentsSha256 ?? null,
          result: call.result,
          resultSha256: call.resultSha256 ?? null,
        })),
        retries: this.retries,
        fallbacks: this.fallbacks,
        compactions: this.compactions,
        verifications: this.verifications,
        permissionDenials: this.permissionDenials,
      }),
    );
    const text = assistantFinalText(messages);
    const completionClaim = explicitCompletionClaim(text);
    return {
      trajectory: {
        completed: this.completed,
        retries: this.retries,
        fallbacks: this.fallbacks,
        compactions: this.compactions,
        verifications: this.verifications,
        permissionDenials: this.permissionDenials,
        calls: publicCalls,
        signatureSha256,
      },
      finalResponse: {
        present: text.length > 0,
        chars: text.length,
        ...(text ? { sha256: sha256(text) } : {}),
        completionClaim,
        outcomeAligned: outcomeStatus === "passed" || !completionClaim,
      },
    };
  }

  /** Kept for future latency attribution while making the collector's clock explicit. */
  get elapsedMs(): number {
    return Date.now() - this.startedAt;
  }
}
