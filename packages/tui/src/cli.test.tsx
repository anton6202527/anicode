import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  registerOpenAICompatibleProvider,
  WorkspaceTrustStore,
  type SessionHost,
} from "@anicode/core";
import {
  colorlessTerminalOutput,
  enterTerminalScreen,
  fullscreenViewportOutput,
  helpText,
  installTerminalExitGuard,
  parseArgs,
  parseExecArgs,
  resolveConfiguredProvider,
  resolveDefaultModel,
  runMcpCatalogCommand,
  runTrustCommand,
  runExecCommand,
  selectSessionId,
  startRawModeWatchdog,
  terminalSafe,
  validateArgs,
} from "./cli.js";
import { terminalMouseModeSequence } from "./app.js";

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
  assert.match(chunks[0] ?? "", /\?1007l/);
  assert.match(chunks[0] ?? "", /\?1006l/);
  assert.match(chunks[0] ?? "", /\?1000l/);
  assert.doesNotMatch(chunks.join(""), /\?1049h/);
  assert.ok(chunks.join("").includes("\u001b]11;#0a0a0a\u0007"));

  restore();
  restore();
  assert.equal(chunks.filter((chunk) => chunk.includes("\u001b[?1049l")).length, 1);
  assert.ok(chunks.join("").includes("\u001b[?1007l"));
  assert.ok(chunks.join("").includes("\u001b[?1006l"));
  assert.ok(chunks.join("").includes("\u001b[?1000l"));
  assert.ok(chunks.join("").includes("\u001b[?2004l"));
  assert.deepEqual(raw, [false]);
});

test("CLI: plain-text diagnostics strip terminal and bidi controls", () => {
  assert.equal(
    terminalSafe(
      "safe\u001b[31m red\u001b[0m\u001b]8;;https://evil.invalid\u0007 link\u001b]8;;\u0007\u202e",
    ),
    "safe red link",
  );
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

test("CLI: HTTP token file 参数严格解析且不与明文 token 混用", () => {
  const parsed = parseArgs([
    "--http",
    "http://127.0.0.1:8327",
    "--http-token-file",
    "./daemon.token",
  ]);
  assert.equal(parsed.httpTokenFile, path.resolve("daemon.token"));
  assert.throws(
    () =>
      parseArgs([
        "--http",
        "http://127.0.0.1:8327",
        "--http-token",
        "secret",
        "--http-token-file",
        "./daemon.token",
      ]),
    /不能同时使用|cannot be used together/,
  );
});

test("CLI: Workspace Trust grant 要求明确确认且执行面变化会自动失效", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cli-trust-"));
  const cwd = path.join(root, "project");
  const store = new WorkspaceTrustStore({ file: path.join(root, "trust", "workspaces.json") });
  const chunks: string[] = [];
  const output = {
    write: (chunk: string) => (chunks.push(chunk), true),
  } as unknown as NodeJS.WritableStream;
  try {
    await fs.mkdir(cwd);
    const before = await runTrustCommand(["status", "--cwd", cwd], { store, output });
    assert.equal(before?.trusted, false);

    const granted = await runTrustCommand(["grant", "--cwd", cwd], {
      store,
      output,
      confirmGrant: async (assessment) => {
        assert.equal(assessment.identity?.canonicalRoot, await fs.realpath(cwd));
        return true;
      },
    });
    assert.equal(granted?.trusted, true);

    await fs.writeFile(path.join(cwd, ".env"), "MODEL_API_KEY=changed\n");
    assert.equal((await store.assess(cwd)).reason, "execution-config-changed");

    const revoked = await runTrustCommand(["revoke", "--cwd", cwd], { store, output });
    assert.equal(revoked?.trusted, false);
    assert.match(chunks.join(""), /Workspace Trust|工作区信任/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI: 备用屏每次进入时重置固定视口并清除滚动历史", () => {
  const chunks: string[] = [];
  const raw = {
    isTTY: true,
    write(chunk: string | Buffer) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  const output = fullscreenViewportOutput(raw, true);
  output.write("before\x1b[?1049hafter");
  assert.equal(chunks.join(""), "before\x1b[?1049h\x1b[r\x1b[2J\x1b[3J\x1b[Hafter");

  const passthrough = fullscreenViewportOutput(raw, false);
  assert.equal(passthrough, raw);
});

test("CLI: 默认关闭鼠标跟踪以保留原生框选，--mouse 可显式开启滚轮", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.mouse, false);
  const defaultSequence = terminalMouseModeSequence(defaults.mouse);
  assert.match(defaultSequence, /\?1000l/);
  assert.match(defaultSequence, /\?1006l/);
  assert.match(defaultSequence, /\?1007h/);
  assert.doesNotMatch(defaultSequence, /\?1000h|\?1006h/);
  assert.equal(parseArgs(["--no-mouse"]).mouse, false);
  assert.equal(parseArgs(["--mouse"]).mouse, true);
  assert.equal(parseArgs(["--plain"]).mouse, false);
  assert.throws(() => parseArgs(["--mouse", "--no-mouse"]), /不能与|cannot be used with/);
  assert.throws(() => parseArgs(["--plain", "--mouse"]), /不能与|cannot be used with/);
});

test("CLI: MCP 开发目录可列出，并按项目或全局原子安装/移除", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-mcp-catalog-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  await fs.mkdir(cwd, { recursive: true });
  const chunks: string[] = [];
  const output = {
    write: (chunk: string) => void chunks.push(chunk),
  } as unknown as NodeJS.WritableStream;
  try {
    await runMcpCatalogCommand(["list"], { cwd, home, output });
    assert.match(chunks.join(""), /context7/);
    assert.match(chunks.join(""), /chrome-devtools/);

    await runMcpCatalogCommand(["add", "context7"], { cwd, home, output });
    const projectFile = path.join(cwd, ".anicode", "settings.local.json");
    const project = JSON.parse(await fs.readFile(projectFile, "utf8")) as {
      mcp: Record<string, { url?: string }>;
    };
    assert.equal(project.mcp.context7?.url, "https://mcp.context7.com/mcp");

    await runMcpCatalogCommand(["add", "github", "--global"], { cwd, home, output });
    const globalFile = path.join(home, ".config", "anicode", "anicode.json");
    const globalRaw = await fs.readFile(globalFile, "utf8");
    const global = JSON.parse(globalRaw) as {
      mcp: Record<string, { credential?: { id?: string } }>;
    };
    assert.equal(global.mcp.github?.credential?.id, "env:GITHUB_TOKEN");
    assert.doesNotMatch(globalRaw, /ghp_|github_pat_/);

    await runMcpCatalogCommand(["remove", "context7"], { cwd, home, output });
    const removed = JSON.parse(await fs.readFile(projectFile, "utf8")) as Record<string, unknown>;
    assert.equal(removed["mcp"], undefined);
    await assert.rejects(
      () => runMcpCatalogCommand(["add", "unknown"], { cwd, home, output }),
      /未知开发 MCP|Unknown development MCP/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

test("CLI: 终端清理本身失败也不会吞掉原始信号", () => {
  const events = new EventEmitter();
  const killed: Array<[number, NodeJS.Signals]> = [];
  const target = Object.assign(events, {
    pid: 4243,
    kill(pid: number, signal: NodeJS.Signals) {
      killed.push([pid, signal]);
      return true;
    },
  }) as unknown as NodeJS.Process;
  installTerminalExitGuard(() => {
    throw new Error("detached tty");
  }, target);

  assert.doesNotThrow(() => events.emit("SIGHUP"));
  assert.deepEqual(killed, [[4243, "SIGHUP"]]);
  assert.equal(events.listenerCount("SIGHUP"), 0);
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
  const tokenFile = path.join(dir, "serve.token");
  const server = await runServeCommand(
    ["--port", "0", "--sessions", path.join(dir, "s"), "--cwd", dir, "--token-file", tokenFile],
    { output: sink },
  );
  try {
    assert.equal((await fs.readFile(tokenFile, "utf8")).trim(), server.authenticationToken());
    const baseUrl = `http://127.0.0.1:${server.port()}`;
    const host = await buildHost({
      model: "debug/demo",
      modelExplicit: true,
      cwd: dir,
      daemon: false,
      http: baseUrl,
      httpTokenFile: tokenFile,
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

test("CLI exec: piped stdin has a hard memory boundary", async () => {
  const input = Readable.from([Buffer.alloc(4 * 1024 * 1024 + 1, 0x78)]);
  Object.defineProperty(input, "isTTY", { value: false });
  await assert.rejects(
    runExecCommand(["--demo"], { input: input as unknown as NodeJS.ReadableStream }),
    /exec stdin 超过 4194304 bytes/,
  );
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
      .map((line) => JSON.parse(line) as { type: string; message?: string });
    assert.ok(records.some((record) => record.type === "warning"));
    const warnings = records
      .filter((record) => record.type === "warning")
      .map((record) => record.message ?? "")
      .join("\n");
    assert.match(warnings, /headless run fails closed|无头运行会拒绝权限请求/);
    assert.match(warnings, /--auto\/--accept-edits/);
    assert.doesNotMatch(
      warnings,
      /only read\/glob\/grep|仅可使用 read\/glob\/grep|plan mode|计划模式/,
    );
    assert.ok(records.some((record) => record.type === "session.started"));
    assert.ok(records.some((record) => record.type === "session.event"));
    assert.equal(records[records.length - 1]?.type, "session.completed");
  } finally {
    if (previousBackend === undefined) delete process.env.ANICODE_CREDENTIAL_BACKEND;
    else process.env.ANICODE_CREDENTIAL_BACKEND = previousBackend;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI exec: inspection-failed 明确退回只读 plan，不承诺 write/bash", async (t) => {
  if (process.platform === "win32") {
    t.skip("Windows symlink privileges vary by host policy");
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-exec-trust-failed-"));
  const cwd = path.join(root, "workspace");
  const outsideEnv = path.join(root, "outside.env");
  const chunks: string[] = [];
  const output = {
    write: (chunk: string) => (chunks.push(chunk), true),
  } as unknown as NodeJS.WritableStream;
  const previousBackend = process.env.ANICODE_CREDENTIAL_BACKEND;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.ANICODE_CREDENTIAL_BACKEND = "memory";
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  try {
    await fs.mkdir(cwd);
    await fs.writeFile(outsideEnv, "UNTRUSTED_KEY=blocked\n");
    await fs.symlink(outsideEnv, path.join(cwd, ".env"));
    await runExecCommand(
      [
        "--demo",
        "--cwd",
        cwd,
        "--sessions",
        path.join(root, "sessions"),
        "--prompt",
        "inspect safely",
        "--jsonl",
      ],
      { output, error: output },
    );
    const warnings = chunks
      .join("")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: string })
      .filter((record) => record.type === "warning")
      .map((record) => record.message ?? "")
      .join("\n");
    assert.match(warnings, /Workspace inspection failed|工作区检查失败/);
    assert.match(warnings, /read\/glob\/grep/);
    assert.match(warnings, /plan mode|plan 模式/);
    assert.doesNotMatch(warnings, /approve built-in development tools|内置开发工具逐项授权/);
  } finally {
    if (previousBackend === undefined) delete process.env.ANICODE_CREDENTIAL_BACKEND;
    else process.env.ANICODE_CREDENTIAL_BACKEND = previousBackend;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});
