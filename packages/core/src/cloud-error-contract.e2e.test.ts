import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AgentEvent } from "./agent.js";
import { OpenAICompatProvider } from "./provider/openai-compat.js";
import { TurnRunner } from "./turn-runner.js";

async function withErrorGateway(
  response: { status: number; code: string; retryable: boolean },
  assertion: (provider: OpenAICompatProvider, calls: () => number) => Promise<void>,
): Promise<void> {
  let requestCount = 0;
  const server = http.createServer((request, reply) => {
    requestCount += 1;
    request.resume();
    reply.writeHead(response.status, {
      "content-type": "application/json",
      "retry-after": "0",
      "x-anicode-retryable": response.retryable ? "true" : "false",
    });
    reply.end(
      JSON.stringify({
        error: {
          message: "gateway fixture",
          type: "anicode_gateway_error",
          code: response.code,
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const provider = new OpenAICompatProvider({
      name: "anicode-cloud-fixture",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture",
      maxRetries: 0,
    });
    await assertion(provider, () => requestCount);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function run(provider: OpenAICompatProvider, maxRetries: number): Promise<AgentEvent[]> {
  const runner = new TurnRunner({
    provider,
    model: "deepseek-v4-flash",
    retry: { maxRetries, baseDelayMs: 0 },
    small: { provider, model: "deepseek-v4-flash" },
  });
  const events: AgentEvent[] = [];
  const stream = runner.runTurn({
    system: "",
    messages: [],
    toolDefs: [],
    signal: new AbortController().signal,
  });
  let next = await stream.next();
  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }
  assert.equal(next.value.type, "error");
  return events;
}

test("Cloud error contract: SDK preserves hard-quota headers and TurnRunner does not retry", async () => {
  await withErrorGateway(
    {
      status: 503,
      code: "upstream_balance_exhausted",
      retryable: false,
    },
    async (provider, calls) => {
      const events = await run(provider, 3);
      assert.equal(calls(), 1);
      assert.equal(
        events.some((event) => event.type === "retry"),
        false,
      );
    },
  );
});

test("Cloud error contract: SDK preserves transient 429 and TurnRunner retries once", async () => {
  await withErrorGateway(
    { status: 429, code: "upstream_rate_limited", retryable: true },
    async (provider, calls) => {
      const events = await run(provider, 1);
      assert.equal(calls(), 2);
      assert.equal(events.filter((event) => event.type === "retry").length, 1);
    },
  );
});
