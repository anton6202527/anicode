import { test } from "node:test";
import assert from "node:assert/strict";
import { registerOpenAICompatibleProvider, type SessionHost } from "@anicode/core";
import {
  detectLocalModel,
  parseArgs,
  resolveConfiguredProvider,
  resolveDefaultModel,
  selectSessionId,
  validateArgs,
} from "./cli.js";

test("CLI: --daemon --resume 只传递会话 ID，不预先 open", async () => {
  let createCalls = 0;
  const host: Pick<SessionHost, "createSession"> = {
    async createSession() {
      createCalls++;
      throw new Error("resume 不应创建会话");
    },
  };
  const args = parseArgs(["--daemon", "--resume", "session-existing"]);

  assert.equal(await selectSessionId(host, args), "session-existing");
  assert.equal(createCalls, 0);
});

test("CLI: 非 resume 路径只创建一次会话", async () => {
  let createCalls = 0;
  const host: Pick<SessionHost, "createSession"> = {
    async createSession(input) {
      createCalls++;
      assert.equal(input.cwd, "/work");
      assert.equal(input.model, "openai/gpt-test");
      return {
        id: "session-new",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
        cwd: input.cwd,
        model: input.model,
        running: false,
      };
    },
  };
  const args = parseArgs(["--cwd", "/work", "--model", "openai/gpt-test"]);

  assert.equal(await selectSessionId(host, args), "session-new");
  assert.equal(createCalls, 1);
});

test("CLI: daemon 客户端拒绝静默忽略权限模式", () => {
  for (const flag of ["--auto", "--accept-edits"]) {
    const args = parseArgs(["--daemon", flag]);
    assert.throws(() => validateArgs(args), new RegExp(`${flag}.*daemon 进程.*不会被当前连接修改`));
  }

  assert.doesNotThrow(() => validateArgs(parseArgs(["--daemon"])));
  assert.doesNotThrow(() => validateArgs(parseArgs(["--auto"])));
});

test("CLI: 严格拒绝未知参数、缺值与互斥参数", () => {
  assert.throws(() => parseArgs(["--wat"]), /未知参数: --wat/);
  assert.throws(() => parseArgs(["--model"]), /--model 需要一个值/);
  assert.throws(() => parseArgs(["--model", "--auto"]), /--model 需要一个值/);
  assert.throws(() => parseArgs(["--cwd"]), /--cwd 需要一个值/);
  assert.throws(() => parseArgs(["--auto", "--accept-edits"]), /不能同时使用/);
  assert.throws(() => parseArgs(["--demo", "--model", "openai/gpt-test"]), /不能同时使用/);
  assert.throws(() => parseArgs(["--resume", "one", "--resume", "two"]), /不能重复指定/);
});

test("CLI: demo 与隔离会话目录适合零配置本地调试", () => {
  const args = parseArgs([
    "--demo",
    "--cwd",
    "/work",
    "--sessions",
    "/tmp/anicode-test-sessions",
    "--debug-log",
    "/tmp/anicode-test.jsonl",
  ]);

  assert.equal(args.model, "debug/demo");
  assert.equal(args.cwd, "/work");
  assert.equal(args.sessionsDir, "/tmp/anicode-test-sessions");
  assert.equal(args.debugLog, "/tmp/anicode-test.jsonl");
  assert.doesNotThrow(() => validateArgs(args));
});

test("CLI: daemon 拒绝本地专属会话目录，trace 必须配日志", () => {
  assert.throws(
    () => validateArgs(parseArgs(["--daemon", "--sessions", "/tmp/sessions"])),
    /会话目录由 daemon 管理/,
  );
  assert.throws(() => validateArgs(parseArgs(["--trace-content"])), /必须与 --debug-log 一起使用/);
});

test("CLI: 无 --model 时不硬耦合 ANTHROPIC_API_KEY，无凭证回退 debug/demo", () => {
  const keys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "XAI_API_KEY",
    "MISTRAL_API_KEY",
  ];
  const saved = new Map(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  try {
    // 无参数：modelExplicit=false，运行时会挑默认；无任何云端凭证 → debug/demo（直接进 TUI）。
    assert.equal(parseArgs(["--cwd", "/w"]).modelExplicit, false);
    assert.equal(resolveDefaultModel(), "debug/demo");

    // 配了某个云端 key → 默认挑那个 provider，不再要求 ANTHROPIC_API_KEY。
    process.env["DEEPSEEK_API_KEY"] = "sk-test";
    assert.equal(resolveDefaultModel(), "deepseek/deepseek-chat");

    // 显式 --model 仍标记为 explicit（运行时不覆盖）。
    assert.equal(parseArgs(["--model", "openai/gpt-x"]).modelExplicit, true);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("CLI: detectLocalModel 探测到 Ollama 时优先返回本地 DeepSeek 模型", async () => {
  const okFetch = (async () =>
    new Response(
      JSON.stringify({ models: [{ name: "llama3.2:latest" }, { name: "deepseek-r1:latest" }] }),
      {
        status: 200,
      },
    )) as unknown as typeof fetch;
  assert.equal(await detectLocalModel(okFetch), "ollama/deepseek-r1:latest");

  // 无 deepseek → 用第一个本地模型
  const noDeepseek = (async () =>
    new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder" }] }), {
      status: 200,
    })) as unknown as typeof fetch;
  assert.equal(await detectLocalModel(noDeepseek), "ollama/qwen2.5-coder");

  // 未运行 / 出错 → null（回退云端或 debug/demo）
  const boom = (async () => {
    throw new Error("connection refused");
  }) as unknown as typeof fetch;
  assert.equal(await detectLocalModel(boom), null);

  const empty = (async () =>
    new Response(JSON.stringify({ models: [] }), { status: 200 })) as unknown as typeof fetch;
  assert.equal(await detectLocalModel(empty), null);
});

test("CLI: 本地 resolver 在建会话时给出缺凭证诊断，debug 始终可用", () => {
  const envName = "AGENTX_CLI_TEST_KEY";
  const previous = process.env[envName];
  delete process.env[envName];
  registerOpenAICompatibleProvider({
    id: "cli-missing-key-test",
    baseURL: "https://example.invalid/v1",
    apiKeyEnv: envName,
    requiresApiKey: true,
  });
  try {
    assert.throws(
      () => resolveConfiguredProvider("cli-missing-key-test/model"),
      new RegExp(`缺少凭证.*${envName}.*--demo`),
    );
    assert.equal(resolveConfiguredProvider("debug/demo").provider.name, "debug");
  } finally {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  }
});
