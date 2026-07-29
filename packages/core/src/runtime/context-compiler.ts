/** Context Compiler：把异构上下文编译成有预算、有来源、可复现的 prompt。 */

import { createHash } from "node:crypto";

export type ContextKind =
  | "instruction"
  | "environment"
  | "memory"
  | "repository"
  | "skill"
  | "retrieval"
  | "conversation"
  | "runtime";

export interface ContextSource {
  id: string;
  kind: ContextKind;
  content: string;
  /** 0..100，越大越重要。 */
  priority?: number;
  /** 必选来源会优先进入预算；过大时会被显式截断而不是静默丢弃。 */
  required?: boolean;
  /** 上游检索器给出的 0..1 分数。 */
  relevance?: number;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CompiledContext {
  text: string;
  estimatedTokens: number;
  selected: { id: string; kind: ContextKind; tokens: number; truncated: boolean }[];
  dropped: { id: string; reason: "duplicate" | "budget" | "empty" }[];
  digest: string;
}

export interface ContextCompilerOptions {
  tokenBudget?: number;
  charsPerToken?: number;
  now?: () => number;
}

function terms(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[\p{L}\p{N}_$.-]{2,}/gu) ?? []).slice(0, 256));
}

function lexicalRelevance(query: Set<string>, content: string): number {
  if (query.size === 0) return 0;
  const haystack = terms(content);
  let hits = 0;
  for (const term of query) if (haystack.has(term)) hits++;
  return hits / query.size;
}

function clipContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  if (maxChars < 80) return content.slice(0, Math.max(0, maxChars));
  const marker = "\n…[context truncated]…\n";
  const remaining = maxChars - marker.length;
  const head = Math.ceil(remaining * 0.7);
  return content.slice(0, head) + marker + content.slice(-(remaining - head));
}

export class ContextCompiler {
  private readonly tokenBudget: number;
  private readonly charsPerToken: number;
  private readonly now: () => number;

  constructor(options: ContextCompilerOptions = {}) {
    this.tokenBudget = Math.max(256, options.tokenBudget ?? 12_000);
    this.charsPerToken = Math.max(1, options.charsPerToken ?? 4);
    this.now = options.now ?? Date.now;
  }

  compile(input: {
    query?: string;
    sources: ContextSource[];
    tokenBudget?: number;
  }): CompiledContext {
    const tokenBudget = Math.max(64, input.tokenBudget ?? this.tokenBudget);
    const budgetChars = tokenBudget * this.charsPerToken;
    const query = terms(input.query ?? "");
    const dropped: CompiledContext["dropped"] = [];
    const hashes = new Set<string>();
    const candidates = input.sources
      .flatMap((source, index) => {
        const content = source.content.trim();
        if (!content) {
          dropped.push({ id: source.id, reason: "empty" });
          return [];
        }
        const hash = createHash("sha256").update(content).digest("hex");
        if (hashes.has(hash)) {
          dropped.push({ id: source.id, reason: "duplicate" });
          return [];
        }
        hashes.add(hash);
        const updated = source.updatedAt ? Date.parse(source.updatedAt) : Number.NaN;
        const ageDays = Number.isFinite(updated)
          ? Math.max(0, (this.now() - updated) / 86_400_000)
          : 365;
        const freshness = 1 / (1 + ageDays / 30);
        const relevance = Math.max(
          Math.min(source.relevance ?? 0, 1),
          lexicalRelevance(query, content),
        );
        const score =
          (source.required ? 10_000 : 0) +
          Math.max(0, Math.min(source.priority ?? 50, 100)) * 10 +
          relevance * 200 +
          freshness * 20 -
          index / 10_000;
        return [{ source, content, score }];
      })
      .sort((a, b) => b.score - a.score);

    const chunks: string[] = [];
    const selected: CompiledContext["selected"] = [];
    let used = 0;
    for (const candidate of candidates) {
      const prefix = `<context-source id=${JSON.stringify(candidate.source.id)} kind=${JSON.stringify(candidate.source.kind)}>`;
      const suffix = "</context-source>";
      const overhead = prefix.length + suffix.length + 2;
      const available = budgetChars - used - overhead;
      if (available <= 0) {
        dropped.push({ id: candidate.source.id, reason: "budget" });
        continue;
      }
      if (!candidate.source.required && candidate.content.length > available) {
        dropped.push({ id: candidate.source.id, reason: "budget" });
        continue;
      }
      const clipped = clipContent(candidate.content, available);
      const block = `${prefix}\n${clipped}\n${suffix}`;
      chunks.push(block);
      used += block.length + 2;
      selected.push({
        id: candidate.source.id,
        kind: candidate.source.kind,
        tokens: Math.ceil(block.length / this.charsPerToken),
        truncated: clipped.length < candidate.content.length,
      });
    }
    const text = chunks.join("\n\n");
    return {
      text,
      estimatedTokens: Math.ceil(text.length / this.charsPerToken),
      selected,
      dropped,
      digest: createHash("sha256").update(text).digest("hex"),
    };
  }
}
