import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { registerOpenAICompatibleProvider, type SessionHost } from "@anicode/core";
import {
  colorlessTerminalOutput,
  enterTerminalScreen,
  helpText,
  installTerminalExitGuard,
  parseArgs,
  parseExecArgs,
  resolveConfiguredProvider,
  resolveDefaultModel,
  runExecCommand,
  selectSessionId,
  startRawModeWatchdog,
  validateArgs,
} from "./cli.js";

test("CLI: Ink 管理备用屏，清理器只做一次紧急恢复", () => {
  const chunks: string[] = [];
  const raw: boolean[] = [];
  const restore = enterTerminalScreen(
    {
      isTTY: true,
      write(chunk) {
        chunks.push(chunk);
      },
    },
    {
      isTTY: true,
      isRaw: false,
      setRawMode(enabled) {
        raw.push(enabled);
      },
    },
    { alternateScreen: true },
  );
  assert.match(chunks[0] ?? "", /\?1006l/);
  assert.match(chunks[0] ?? "", /\?1000l/);
  assert.doesNotMatch(chunks.join(""), /\?1049h/);
  assert.ok(chunks.join("").includes("\u001b]11;#0a0a0a\u0007"));

  restore();
  restore();
  assert.equal(chunks.filter((chunk) => chunk.includes("\u001b[?1049l")).length, 1);
  assert.ok(chunks.join("").includes("\u001b[?1006l"));
  assert.ok(chunks.join("").includes("\u001b[?1000l"));
  assert.ok(chunks.join("").includes("\u001b[?2004l"));
  assert.deepEqual(raw, [false]);
});

test("CLI: --plain 关闭颜色、鼠标与备用屏，颜色适配器保留光标控制", () => {
  const args = parseArgs(["--plain"]);
  assert.equal(args.noColor, true);
  assert.equal(args.mouse, false);
  assert.equal(args.noAltScreen, true);

  const chunks: string[] = [];
  const output = colorlessTerminalOutput({
    isTTY: true,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    on() {},
    off() {},
  } as unknown as NodeJS.WriteStream);
  output.write("\u001b[31mred\u001b[0m\u001b[2J");
  assert.equal(chunks.join(""), "red\u001b[2J");
});

test("CLI: 默认保留终端原生框选，--mouse 才显式开启跟踪", () => {
  assert.equal(parseArgs([]).mouse, false);
  assert.equal(parseArgs(["--no-mouse"]).mouse, false);
  assert.equal(parseArgs(["--mouse"]).mouse, true);
  assert.throws(() => parseArgs(["--mouse", "--no-mouse"]), /不能与|cannot be used with/);
  assert.throws(() => parseArgs(["--plain", "--mouse"]), /不能与|cannot be used with/);
});

test("CLI: 收到 SIGTERM 时先幂等恢复终端再重发原信号", () => {
  const events = new EventEmitter();
  const killed: Array<[number, NodeJS.Signals]> = [];
  let cleaned = 0;
  const target = Object.assign(events, {
    pid: 4242,
    kill(pid: number, signal: NodeJS.Signals) {
      killed.push([pid, signal]);
      return true;
    },
  }) as unknown as NodeJS.Process;

  const remove = installTerminalExitGuard(() => cleaned++, target);
  events.emit("SIGTERM");
  events.emit("SIGTERM");

  assert.equal(cleaned, 1);
  assert.deepEqual(killed, [[4242, "SIGTERM"]]);
  assert.equal(events.listenerCount("SIGTERM"), 0);
  remove();
});

test("CLI: TUI 运行期间持续重申 raw mode，停止后不再改写终端", async () => {
  const calls: boolean[] = [];
  const input = {
    isTTY: true,
    destroyed: false,
    setRawMode(enabled: boolean) {
      calls.push(enabled);
    },
  };
  const stop = startRawModeWatchdog(input, 10);
  const deadline = Date.now() + 250;
  while (calls.length < 4 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(calls.length >= 4);
  for (let i = 0; i < calls.length; i += 2) {
    assert.deepEqual(calls.slice(i, i + 2), [false, true]);
  }

  stop();
  const stoppedAt = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(calls.length, stoppedAt);
});

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
  assert.equal(args.daemon, false);
  assert.equal(args.http, undefined);
  assert.match(helpText(), /无需 AniCode 后端服务|no AniCode backend\/server/);
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
    assert.equal(resolveDefaultModel(), "deepseek/deepseek-v4-flash");

    // 显式 --model 仍标记为 explicit（运行时不覆盖）。
    assert.equal(parseArgs(["--model", "openai/gpt-x"]).modelExplicit, true);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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

test("CLI: serve 起 HTTP 服务 → --http host 连上走通完整会话（demo 模型）", async () => {
  const { runServeCommand, buildHost } = await import("./cli.js");
  const { promises: fs } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-serve-"));
  const sink = { write: () => true } as unknown as NodeJS.WritableStream;
  const server = await runServeCommand(["--port", "0", "--sessions", path.join(dir, "s")], {
    output: sink,
  });
  try {
    const baseUrl = `http://127.0.0.1:${server.port()}`;
    const host = await buildHost({
      model: "debug/demo",
      modelExplicit: true,
      cwd: dir,
      daemon: false,
      http: baseUrl,
      permissionMode: "default",
      socket: "",
      sessionsDir: path.join(dir, "unused"),
      sessionsExplicit: false,
      demo: false,
      help: false,
      version: false,
      listProviders: false,
      listModels: false,
      traceContent: false,
      noColor: false,
      mouse: false,
      noAltScreen: false,
      plain: false,
    });
    const meta = await host.createSession({ cwd: dir, model: "debug/demo" });
    const events: unknown[] = [];
    const handle = await host.open(meta.id, (ev) => events.push(ev));
    assert.equal(handle.snapshot.meta.id, meta.id);
    await host.send(meta.id, "hello");
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(events.length > 0, "SSE 应推来会话事件");
    handle.close();
    host.dispose();
  } finally {
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI: --http 与 --daemon 互斥", () => {
  assert.throws(
    () => parseArgs(["--http", "http://127.0.0.1:1", "--daemon"]),
    /不能同时使用|together/,
  );
});

test("CLI exec: 参数严格解析，默认 JSONL", () => {
  const parsed = parseExecArgs(["--demo", "--prompt", "hello", "--timeout", "5000"]);
  assert.equal(parsed.args.model, "debug/demo");
  assert.equal(parsed.prompt, "hello");
  assert.equal(parsed.jsonl, true);
  assert.equal(parsed.timeoutMs, 5000);
  assert.throws(() => parseExecArgs(["--demo", "--timeout", "nope", "--prompt", "x"]), /正毫秒数/);
});

test("CLI exec: demo 模型无 TTY 完成一次 JSONL 会话", async () => {
  const { promises: fs } = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-exec-"));
  const chunks: string[] = [];
  const output = {
    write: (chunk: string) => (chunks.push(chunk), true),
  } as unknown as NodeJS.WritableStream;
  const previousBackend = process.env.ANICODE_CREDENTIAL_BACKEND;
  process.env.ANICODE_CREDENTIAL_BACKEND = "memory";
  try {
    await runExecCommand(
      [
        "--demo",
        "--cwd",
        dir,
        "--sessions",
        path.join(dir, "sessions"),
        "--prompt",
        "hello",
        "--jsonl",
      ],
      { output, error: output },
    );
    const records = chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string });
    assert.equal(records[0]?.type, "session.started");
    assert.ok(records.some((record) => record.type === "session.event"));
    assert.equal(records[records.length - 1]?.type, "session.completed");
  } finally {
    if (previousBackend === undefined) delete process.env.ANICODE_CREDENTIAL_BACKEND;
    else process.env.ANICODE_CREDENTIAL_BACKEND = previousBackend;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
