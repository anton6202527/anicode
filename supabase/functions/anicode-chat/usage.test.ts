import {
  type GatewaySettlementStatus,
  meteredSseStream,
  OpenAiUsageMeter,
} from "./usage.ts";

function assert(
  condition: unknown,
  message = "assertion failed",
): asserts condition {
  if (!condition) throw new Error(message);
}

const encoder = new TextEncoder();

Deno.test("extracts usage across split SSE chunks and never trusts a smaller total", () => {
  const meter = new OpenAiUsageMeter();
  meter.push(encoder.encode('data: {"choices":[],"usa'));
  meter.push(
    encoder.encode(
      'ge":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":3}}\r\n\r\n',
    ),
  );
  const usage = meter.finish();
  assert(usage?.totalTokens === 19);
  assert(usage.promptTokens === 12);
  assert(usage.completionTokens === 7);
});

Deno.test("ignores unsafe integer usage values", () => {
  const meter = new OpenAiUsageMeter();
  meter.push(
    encoder.encode(
      `data: {"usage":{"prompt_tokens":${
        Number.MAX_SAFE_INTEGER + 1
      },"completion_tokens":1}}\n\n`,
    ),
  );
  assert(meter.finish() === undefined);
});

Deno.test("ignores impossible all-zero usage", () => {
  const meter = new OpenAiUsageMeter();
  meter.push(
    encoder.encode(
      'data: {"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n',
    ),
  );
  assert(meter.finish() === undefined);
});

Deno.test("successful SSE forwarding settles once with bounded reported usage", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
      );
      controller.enqueue(
        encoder.encode(
          'data: {"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n',
        ),
      );
      controller.close();
    },
  });
  const settlements: Array<
    { charged: number; status: GatewaySettlementStatus }
  > = [];
  const { readable, completion } = meteredSseStream(upstream, {
    signal: new AbortController().signal,
    reservedTokens: 100,
    settle(charged, status) {
      settlements.push({ charged, status });
    },
  });
  await new Response(readable).arrayBuffer();
  await completion;
  assert(
    JSON.stringify(settlements) ===
      JSON.stringify([{ charged: 19, status: "completed" }]),
  );
});

Deno.test("missing usage settles the full reservation", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  let settlement:
    | { charged: number; status: GatewaySettlementStatus }
    | undefined;
  const { readable, completion } = meteredSseStream(upstream, {
    signal: new AbortController().signal,
    reservedTokens: 123,
    settle(charged, status) {
      settlement = { charged, status };
    },
  });
  await new Response(readable).arrayBuffer();
  await completion;
  assert(settlement?.charged === 123);
  assert(settlement.status === "completed");
});

Deno.test("an aborted stream settles exactly once as aborted", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("data: {}\n\n"));
    },
  });
  const abort = new AbortController();
  const settlements: Array<
    { charged: number; status: GatewaySettlementStatus }
  > = [];
  const { readable, completion } = meteredSseStream(upstream, {
    signal: abort.signal,
    reservedTokens: 77,
    settle(charged, status) {
      settlements.push({ charged, status });
    },
  });
  const reader = readable.getReader();
  await reader.read();
  abort.abort();
  await completion;
  assert(
    JSON.stringify(settlements) ===
      JSON.stringify([{ charged: 77, status: "aborted" }]),
  );
});

Deno.test("a settlement rejection does not trigger a contradictory second settlement", async () => {
  const upstream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  let calls = 0;
  const { readable, completion } = meteredSseStream(upstream, {
    signal: new AbortController().signal,
    reservedTokens: 5,
    settle() {
      calls++;
      throw new Error("database unavailable");
    },
  });
  await new Response(readable).arrayBuffer();
  let rejected = false;
  try {
    await completion;
  } catch {
    rejected = true;
  }
  assert(rejected);
  assert(calls === 1);
});
