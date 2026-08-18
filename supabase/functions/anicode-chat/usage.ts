const MAX_PENDING_SSE_TEXT = 64 * 1024;

export interface GatewayUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  reasoningTokens: number;
}

export type GatewaySettlementStatus = "completed" | "failed" | "aborted";

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

export class OpenAiUsageMeter {
  private readonly decoder = new TextDecoder();
  private pending = "";
  private usageValue: GatewayUsage | undefined;

  push(chunk: Uint8Array): void {
    this.pending += this.decoder.decode(chunk, { stream: true });
    this.consumeLines(false);
    if (this.pending.length > MAX_PENDING_SSE_TEXT) {
      this.pending = this.pending.slice(-MAX_PENDING_SSE_TEXT);
    }
  }

  finish(): GatewayUsage | undefined {
    this.pending += this.decoder.decode();
    this.consumeLines(true);
    return this.usageValue;
  }

  get usage(): GatewayUsage | undefined {
    return this.usageValue;
  }

  private consumeLines(final: boolean): void {
    const lines = this.pending.split(/\r\n|\r|\n/u);
    this.pending = final ? "" : (lines.pop() ?? "");
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const parsed = JSON.parse(payload) as {
          usage?: Record<string, unknown> & {
            prompt_tokens_details?: Record<string, unknown>;
            completion_tokens_details?: Record<string, unknown>;
          };
        };
        const promptTokens = nonNegativeInteger(
          parsed.usage?.["prompt_tokens"],
        );
        const completionTokens = nonNegativeInteger(
          parsed.usage?.["completion_tokens"],
        );
        const reportedTotal = nonNegativeInteger(
          parsed.usage?.["total_tokens"],
        );
        if (promptTokens === undefined || completionTokens === undefined) {
          continue;
        }
        const summedTotal = promptTokens + completionTokens;
        // Every accepted chat request has a non-empty prompt. An all-zero event is therefore not a
        // trustworthy final usage record; treating it as missing charges the reservation instead.
        if (!Number.isSafeInteger(summedTotal) || summedTotal === 0) continue;
        const reportedCacheHit = nonNegativeInteger(
          parsed.usage?.["prompt_cache_hit_tokens"] ??
            parsed.usage?.prompt_tokens_details?.["cached_tokens"],
        );
        const promptCacheHitTokens = Math.min(
          promptTokens,
          reportedCacheHit ?? 0,
        );
        const reportedCacheMiss = nonNegativeInteger(
          parsed.usage?.["prompt_cache_miss_tokens"],
        );
        const promptCacheMissTokens = reportedCacheMiss !== undefined &&
            promptCacheHitTokens + reportedCacheMiss <= promptTokens
          ? reportedCacheMiss
          : promptTokens - promptCacheHitTokens;
        const reasoningTokens = Math.min(
          completionTokens,
          nonNegativeInteger(
            parsed.usage?.completion_tokens_details?.["reasoning_tokens"],
          ) ?? 0,
        );
        const next: GatewayUsage = {
          promptTokens,
          completionTokens,
          // Never let a malformed or stale total under-count its own component values.
          totalTokens: Math.max(reportedTotal ?? summedTotal, summedTotal),
          promptCacheHitTokens,
          promptCacheMissTokens,
          reasoningTokens,
        };
        // Providers normally emit usage only in the final chunk. Retaining the greatest valid
        // observation also fails safely if an intermediary/proxy repeats an older smaller value.
        if (
          !this.usageValue || next.totalTokens >= this.usageValue.totalTokens
        ) {
          this.usageValue = next;
        }
      } catch {
        // Provider content remains opaque unless it is a valid usage-bearing SSE event.
      }
    }
  }
}

export interface MeteredSseOptions {
  signal: AbortSignal;
  reservedTokens: number;
  settle(
    chargedTokens: number,
    status: GatewaySettlementStatus,
    usage?: GatewayUsage,
  ): void | Promise<void>;
}

/**
 * Forward an upstream SSE stream while coupling exactly one quota settlement to the pipe outcome.
 * A settlement failure is not mistaken for a stream failure and therefore never causes a second,
 * contradictory settlement attempt.
 */
export function meteredSseStream(
  upstream: ReadableStream<Uint8Array>,
  options: MeteredSseOptions,
): { readable: ReadableStream<Uint8Array>; completion: Promise<void> } {
  if (
    !Number.isSafeInteger(options.reservedTokens) || options.reservedTokens < 1
  ) {
    throw new RangeError("reserved token count is invalid");
  }
  const meter = new OpenAiUsageMeter();
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      meter.push(chunk);
      controller.enqueue(chunk);
    },
  });
  const piping = upstream.pipeTo(transform.writable, {
    signal: options.signal,
  });
  const completion = piping.then(
    async () => {
      const usage = meter.finish();
      // A reservation is a concurrency fence, not a cap on the provider's authoritative bill.
      // Preserve any overrun so subsequent requests are blocked and operators can investigate it.
      const charged = usage?.totalTokens ?? options.reservedTokens;
      await options.settle(charged, "completed", usage);
    },
    async () => {
      await options.settle(
        options.reservedTokens,
        options.signal.aborted ? "aborted" : "failed",
      );
    },
  );
  return { readable: transform.readable, completion };
}
