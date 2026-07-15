import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { OpenAICompatProvider } from "./openai-compat.js";

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/v1`;
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

test("OpenAI compatibility profile: 可省略不兼容字段并设置 header", async () => {
  let body: Record<string, unknown> | undefined;
  let header = "";
  const server = http.createServer((req, res) => {
    header = String(req.headers["x-anicode-fixture"] ?? "");
    let text = "";
    req.on("data", (chunk) => (text += chunk));
    req.on("end", () => {
      body = JSON.parse(text) as Record<string, unknown>;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  const baseURL = await listen(server);
  try {
    const provider = new OpenAICompatProvider({
      baseURL,
      apiKey: "fixture",
      streamUsage: false,
      maxTokensField: "max_tokens",
      reasoningEffort: false,
      defaultHeaders: { "x-anicode-fixture": "present" },
    });
    for await (const _event of provider.stream({
      model: "fixture",
      messages: [],
      maxTokens: 321,
      effort: "high",
    })) {
      // drain
    }
    assert.ok(body);
    assert.equal(body["max_tokens"], 321);
    assert.equal("max_completion_tokens" in body, false);
    assert.equal("stream_options" in body, false);
    assert.equal("reasoning_effort" in body, false);
    assert.equal(header, "present");
  } finally {
    await close(server);
  }
});

test("OpenAI SDK 内层重试默认关闭", async () => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "fixture failure", type: "server_error" } }));
  });
  const baseURL = await listen(server);
  try {
    const provider = new OpenAICompatProvider({ baseURL, apiKey: "fixture" });
    await assert.rejects(async () => {
      for await (const _event of provider.stream({ model: "fixture", messages: [] })) {
        // drain
      }
    }, /fixture failure/);
    assert.equal(requests, 1);
  } finally {
    await close(server);
  }
});

test("具名第三方兼容 provider 不会隐式读取 OPENAI_API_KEY", async () => {
  const old = process.env["OPENAI_API_KEY"];
  process.env["OPENAI_API_KEY"] = "must-not-leak";
  try {
    const provider = new OpenAICompatProvider({
      name: "third-party",
      baseURL: "http://127.0.0.1:9/v1",
    });
    await assert.rejects(async () => {
      for await (const _event of provider.stream({ model: "fixture", messages: [] })) {
        // drain
      }
    }, /Missing credentials/);
  } finally {
    if (old === undefined) delete process.env["OPENAI_API_KEY"];
    else process.env["OPENAI_API_KEY"] = old;
  }
});

test("第三方端点隔离 OpenAI 组织、项目、管理员 key 和自定义 header", async () => {
  const captured: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    captured.push(req.headers);
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        `data: ${JSON.stringify({
          id: "fixture",
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
  });
  const baseURL = await listen(server);
  const environment = [
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT_ID",
    "OPENAI_ADMIN_KEY",
    "OPENAI_CUSTOM_HEADERS",
  ] as const;
  const previous = Object.fromEntries(environment.map((name) => [name, process.env[name]]));
  process.env["OPENAI_ORG_ID"] = "org-must-not-leak";
  process.env["OPENAI_PROJECT_ID"] = "project-must-not-leak";
  process.env["OPENAI_ADMIN_KEY"] = "admin-must-not-leak";
  process.env["OPENAI_CUSTOM_HEADERS"] = [
    "x-openai-env: must-not-leak",
    "x-explicit-provider: env-must-not-win",
  ].join("\n");

  try {
    const thirdParty = new OpenAICompatProvider({
      name: "third-party",
      baseURL,
      apiKey: "third-party-key",
      streamUsage: false,
      defaultHeaders: { "x-explicit-provider": "provider-value" },
    });
    for await (const _event of thirdParty.stream({ model: "fixture", messages: [] })) {
      // drain
    }

    // 官方 OpenAI 路径继续保留 SDK 的 OPENAI_* 环境变量行为。
    const official = new OpenAICompatProvider({
      name: "openai",
      baseURL,
      apiKey: "official-key",
      streamUsage: false,
    });
    for await (const _event of official.stream({ model: "fixture", messages: [] })) {
      // drain
    }

    assert.equal(captured.length, 2);
    const thirdPartyHeaders = captured[0]!;
    assert.equal(thirdPartyHeaders.authorization, "Bearer third-party-key");
    assert.equal(thirdPartyHeaders["openai-organization"], undefined);
    assert.equal(thirdPartyHeaders["openai-project"], undefined);
    assert.equal(thirdPartyHeaders["x-openai-env"], undefined);
    assert.equal(thirdPartyHeaders["x-explicit-provider"], "provider-value");

    const officialHeaders = captured[1]!;
    assert.equal(officialHeaders.authorization, "Bearer official-key");
    assert.equal(officialHeaders["openai-organization"], "org-must-not-leak");
    assert.equal(officialHeaders["openai-project"], "project-must-not-leak");
    assert.equal(officialHeaders["x-openai-env"], "must-not-leak");
  } finally {
    for (const name of environment) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await close(server);
  }
});
