import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AuthStore,
  createLocalRuntimeStack,
  registerOpenAICompatibleProvider,
  WorkspaceTrustStore,
  type SessionHost,
  type SyncSecretBackend,
} from "@anicode/core";
import {
  assertProviderConfigured,
  colorlessTerminalOutput,
  disposeCliRuntimeResources,
  enterTerminalScreen,
  fullscreenViewportOutput,
  helpText,
  installTerminalExitGuard,
  parseArgs,
  parseExecArgs,
  resolveConfiguredProvider,
  resolveDefaultModel,
  resolveInteractivePermissionMode,
  runAuthCommand,
  runMcpCatalogCommand,
  runMcpCommand,
  runCredentialsCommand,
  runTrustCommand,
  runExecCommand,
  selectSessionId,
  selectStartupModel,
  startRawModeWatchdog,
  terminalSafe,
  validateArgs,
} from "./cli.js";
import { terminalMouseModeSequence } from "./app.js";

class RecordingCredentialBackend implements SyncSecretBackend {
  readonly kind: string;
  readonly values = new Map<string, string>();
  getCalls = 0;
  listCalls = 0;

  constructor(kind = "recording-test-backend") {
    this.kind = kind;
  }

  getSync(key: string): string | undefined {
    this.getCalls++;
    return this.values.get(key);
  }
  putSync(key: string, value: string): void {
    this.values.set(key, value);
  }
  deleteSync(key: string): boolean {
    return this.values.delete(key);
  }
  listSync(): string[] {
    this.listCalls++;
    throw new Error("credentials list must not enumerate the secret backend");
  }
  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }
  async put(key: string, value: string): Promise<void> {
    this.putSync(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.deleteSync(key);
  }
  async list(): Promise<string[]> {
    return this.listSync();
  }
}

test("CLI credentials: import/remove 精确 key；list 只读 allowlist 元数据", async () => {
  const backend = new RecordingCredentialBackend();
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_BACKEND: "keychain",
    ANICODE_CREDENTIAL_KEYS: "DEEPSEEK_API_KEY, OPENAI_API_KEY,DEEPSEEK_API_KEY",
    OPENAI_API_KEY: "explicit-test-secret",
  };
  const chunks: string[] = [];
  const output = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;

  await runCredentialsCommand(["list"], { env, output, backend });
  assert.deepEqual(chunks.splice(0), ["DEEPSEEK_API_KEY\n", "OPENAI_API_KEY\n"]);
  assert.equal(backend.listCalls, 0);
  assert.equal(backend.getCalls, 0);

  await runCredentialsCommand(["import", "OPENAI_API_KEY"], { env, output, backend });
  assert.equal(backend.values.get("env:OPENAI_API_KEY"), "explicit-test-secret");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.doesNotMatch(chunks.join(""), /explicit-test-secret/);

  await runCredentialsCommand(["remove", "OPENAI_API_KEY"], { env, output, backend });
  assert.equal(backend.values.has("env:OPENAI_API_KEY"), false);
  assert.equal(backend.getCalls, 0);
  assert.equal(backend.listCalls, 0);
});

test("CLI credentials: 拒绝通配符、env: 前缀及 memory 持久化", async () => {
  const output = { write: () => true } as unknown as NodeJS.WritableStream;
  await assert.rejects(
    runCredentialsCommand(["import", "*_TOKEN"], {
      env: { "*_TOKEN": "secret" },
      output,
      backend: new RecordingCredentialBackend(),
    }),
    /精确|exact/,
  );
  await assert.rejects(
    runCredentialsCommand(["remove", "env:OPENAI_API_KEY"], {
      env: {},
      output,
      backend: new RecordingCredentialBackend(),
    }),
    /精确|exact/,
  );
  await assert.rejects(
    runCredentialsCommand(["import", "openai_api_key"], {
      env: { openai_api_key: "secret" },
      output,
      backend: new RecordingCredentialBackend(),
    }),
    /大写|uppercase/,
  );
  await assert.rejects(
    runCredentialsCommand(["import", "OPENAI_API_KEY"], {
      env: { ANICODE_CREDENTIAL_BACKEND: "memory", OPENAI_API_KEY: "secret" },
      output,
      backend: new RecordingCredentialBackend(),
    }),
    /memory.*不能持久化|memory.*cannot persist/,
  );
  await assert.rejects(
    runCredentialsCommand(["remove", "OPENAI_API_KEY"], {
      env: { ANICODE_CREDENTIAL_BACKEND: "keychain", ANICODE_DISABLE_OS_KEYCHAIN: "1" },
      output,
      backend: new RecordingCredentialBackend("os-keychain"),
    }),
    /forbids access to the operating-system credential store/,
  );
  await assert.rejects(
    runCredentialsCommand(["import", "OPENAI_API_KEY"], {
      env: { OPENAI_API_KEY: "x".repeat(64 * 1024 + 1) },
      output,
      backend: new RecordingCredentialBackend(),
    }),
    /65536.*字节|65536-byte/,
  );
});

test("CLI credentials: 异步导入不删除并发替换的新环境值", async () => {
  const env: NodeJS.ProcessEnv = { OPENAI_API_KEY: "value-being-imported" };
  const backend = new RecordingCredentialBackend();
  backend.put = async (key, value) => {
    backend.putSync(key, value);
    env.OPENAI_API_KEY = "newer-process-value";
  };

  await runCredentialsCommand(["import", "OPENAI_API_KEY"], {
    env,
    output: { write: () => true } as unknown as NodeJS.WritableStream,
    backend,
  });

  assert.equal(backend.values.get("env:OPENAI_API_KEY"), "value-being-imported");
  assert.equal(env.OPENAI_API_KEY, "newer-process-value");
});

test("CLI auth migrate: 仅在显式命令迁移旧凭证且不输出密钥", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cli-auth-migrate-"));
  const file = path.join(dir, "auth.json");
  const backend = new RecordingCredentialBackend();
  const chunks: string[] = [];
  const output = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  try {
    await fs.writeFile(
      file,
      `${JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "must-not-print-access",
          refresh: "must-not-print-refresh",
          expiresAt: 123,
        },
      })}\n`,
      { mode: 0o600 },
    );
    const store = new AuthStore({ file, backend });

    await runAuthCommand(["migrate"], { output, store });

    assert.ok(backend.values.has("auth:anthropic"));
    assert.equal(backend.values.has("auth-index:v1"), false);
    const stateText = await fs.readFile(`${file}.state.json`, "utf8");
    assert.deepEqual(JSON.parse(stateText), {
      version: 1,
      providers: {
        anthropic: { mode: "backend-authoritative", type: "oauth", expiresAt: 123 },
      },
    });
    assert.doesNotMatch(stateText, /"(?:access|refresh)"\s*:/);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {});
    assert.match(chunks.join(""), /anthropic/);
    assert.doesNotMatch(chunks.join(""), /must-not-print/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("CLI auth metadata commands do not construct a Keychain backend under the sentinel", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cli-auth-metadata-"));
  const file = path.join(dir, "auth.json");
  const coordinationFile = path.join(dir, "auth-state.json");
  const chunks: string[] = [];
  const output = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  const storeOptions = {
    file,
    coordinationFile,
    backend: "keychain" as const,
    env: {
      ANICODE_CREDENTIAL_BACKEND: "keychain",
      ANICODE_DISABLE_OS_KEYCHAIN: "1",
    },
  };
  try {
    await fs.writeFile(
      file,
      `${JSON.stringify({
        legacy: { type: "oauth", access: "hidden", refresh: "hidden", expiresAt: 11 },
      })}\n`,
      { mode: 0o600 },
    );
    await fs.writeFile(
      coordinationFile,
      `${JSON.stringify({
        version: 1,
        providers: {
          migrated: { mode: "backend-authoritative", type: "oauth", expiresAt: 22 },
        },
      })}\n`,
      { mode: 0o600 },
    );

    await runAuthCommand(["list"], { output, storeOptions });
    assert.match(chunks.join(""), /legacy/);
    assert.match(chunks.join(""), /migrated/);
    assert.doesNotMatch(chunks.join(""), /hidden/);

    await assert.rejects(
      runAuthCommand(["login", "anthropic"], { output, storeOptions }),
      /OAuth|oauth|disabled|禁用/,
    );
    await assert.rejects(
      runAuthCommand(["logout", "anthropic"], { output, storeOptions }),
      /forbids access to the operating-system credential store/,
    );
    await assert.rejects(
      runAuthCommand(["migrate"], { output, storeOptions }),
      /forbids access to the operating-system credential store/,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

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

test("CLI: 已信任本地交互默认最高权限，受限、显式、exec 与远端保持各自策略", () => {
  const local = parseArgs([]);
  assert.equal(local.permissionMode, "default", "共享解析器必须继续 fail closed");
  assert.equal(local.permissionModeExplicit, false);
  assert.equal(resolveInteractivePermissionMode(local, true), "bypass");
  assert.equal(resolveInteractivePermissionMode(local, false), "default");

  const daemon = parseArgs(["--daemon"]);
  assert.equal(resolveInteractivePermissionMode(daemon, true), "default");
  const http = parseArgs(["--http", "http://127.0.0.1:8327"]);
  assert.equal(resolveInteractivePermissionMode(http, true), "default");

  assert.equal(resolveInteractivePermissionMode(parseArgs(["--auto"]), true), "auto");
  assert.equal(parseArgs(["--auto"]).permissionModeExplicit, true);
  assert.equal(
    resolveInteractivePermissionMode(parseArgs(["--accept-edits"]), true),
    "acceptEdits",
  );
  assert.equal(parseExecArgs(["--demo", "--prompt", "hello"]).args.permissionMode, "default");
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
      assert.equal(input.cwd, path.resolve("/work"));
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

test("CLI: daemon/HTTP 客户端拒绝静默忽略本地权限与会话目录参数", () => {
  for (const transport of [["--daemon"], ["--http", "http://127.0.0.1:8327"]]) {
    for (const flag of ["--auto", "--accept-edits"]) {
      const args = parseArgs([...transport, flag]);
      assert.throws(() => validateArgs(args), new RegExp(`${flag}.*宿主.*不会修改`));
    }
    assert.throws(
      () => validateArgs(parseArgs([...transport, "--sessions", "/tmp/sessions"])),
      /--sessions.*宿主管理/,
    );
  }

  assert.doesNotThrow(() => validateArgs(parseArgs(["--daemon"])));
  assert.doesNotThrow(() => validateArgs(parseArgs(["--http", "http://127.0.0.1:8327"])));
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
  assert.equal(args.cwd, path.resolve("/work"));
  assert.equal(args.sessionsDir, path.resolve("/tmp/anicode-test-sessions"));
  assert.equal(args.debugLog, path.resolve("/tmp/anicode-test.jsonl"));
  assert.equal(args.daemon, false);
  assert.equal(args.http, undefined);
  assert.match(helpText(), /无需 AniCode 后端服务|no AniCode backend\/server/);
  assert.doesNotThrow(() => validateArgs(args));
});

test("CLI: daemon 拒绝本地专属会话目录，trace 必须配日志", () => {
  assert.throws(
    () => validateArgs(parseArgs(["--daemon", "--sessions", "/tmp/sessions"])),
    /会话目录由宿主管理/,
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

test("CLI: 隐式配置模型缺凭证时安全回退，显式模型与无效 provider 保持 fail-fast", () => {
  const missingCredentials = {
    diagnoseProvider(model: string) {
      if (model === "unknown/model") throw new Error("Unknown provider: unknown");
      return {
        requiresApiKey: model !== "debug/demo",
        hasCredentials: model === "debug/demo",
        warnings: model === "debug/demo" ? [] : ["missing DEEPSEEK_API_KEY"],
      };
    },
    resolveDefaultModel: () => "debug/demo",
  };

  assert.deepEqual(
    selectStartupModel(
      {
        model: "deepseek/deepseek-v4-flash",
        modelExplicit: false,
        demo: false,
      },
      "deepseek/deepseek-v4-flash",
      missingCredentials,
    ),
    {
      model: "debug/demo",
      fallbackFrom: "deepseek/deepseek-v4-flash",
      fallbackReason: "missing DEEPSEEK_API_KEY",
    },
  );

  const explicit = selectStartupModel(
    { model: "deepseek/deepseek-v4-flash", modelExplicit: true, demo: false },
    "debug/demo",
    missingCredentials,
  );
  assert.deepEqual(explicit, { model: "deepseek/deepseek-v4-flash" });
  assert.throws(
    () => assertProviderConfigured(explicit.model, missingCredentials.diagnoseProvider),
    /DEEPSEEK_API_KEY.*--demo/,
  );
  assert.deepEqual(
    selectStartupModel(
      { model: "debug/demo", modelExplicit: false, demo: true },
      "deepseek/deepseek-v4-flash",
      missingCredentials,
    ),
    { model: "debug/demo" },
  );
  assert.throws(
    () =>
      selectStartupModel(
        { model: "deepseek/deepseek-v4-flash", modelExplicit: false, demo: false },
        "unknown/model",
        missingCredentials,
      ),
    /Unknown provider/,
  );
});

test("CLI: 模型选择读取当前 runtime Broker，而不是密钥清理后的 process.env", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cli-provider-broker-"));
  const env: NodeJS.ProcessEnv = {
    ANICODE_CREDENTIAL_BACKEND: "memory",
    DEEPSEEK_API_KEY: "test-only-secret",
  };
  const stack = createLocalRuntimeStack(root, env);
  try {
    assert.equal(env.DEEPSEEK_API_KEY, undefined, "credential must leave the mutable environment");
    assert.deepEqual(
      selectStartupModel(
        {
          model: "deepseek/deepseek-v4-flash",
          modelExplicit: false,
          demo: false,
        },
        "deepseek/deepseek-v4-flash",
        stack.providers,
      ),
      { model: "deepseek/deepseek-v4-flash" },
    );
    assert.doesNotThrow(() =>
      assertProviderConfigured("deepseek/deepseek-v4-flash", stack.providers.diagnoseProvider),
    );
  } finally {
    await Promise.resolve(stack.artifacts.close?.()).catch(() => undefined);
    await stack.networkProxy.close().catch(() => undefined);
    await stack.database.close().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI: runtime 清理即使中途失败也会关闭 telemetry、sandbox、artifact、proxy 与 database", async () => {
  const closed: string[] = [];
  const runtime = {
    isolatedRuntime: {
      async shutdown() {
        closed.push("isolatedRuntime");
      },
    },
    artifacts: {
      async close() {
        closed.push("artifacts");
        throw new Error("artifact close failed");
      },
    },
    networkProxy: {
      async close() {
        closed.push("networkProxy");
      },
    },
    database: {
      async close() {
        closed.push("database");
      },
    },
  } as unknown as Parameters<typeof disposeCliRuntimeResources>[0];
  const telemetry = {
    startSpan: () => {
      throw new Error("unused");
    },
    async shutdown() {
      closed.push("telemetry");
    },
  };

  await assert.rejects(disposeCliRuntimeResources(runtime, telemetry), AggregateError);
  assert.deepEqual(closed, [
    "telemetry",
    "isolatedRuntime",
    "artifacts",
    "networkProxy",
    "database",
  ]);
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
      permissionModeExplicit: false,
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

test("CLI headless: 配置模型缺凭证时 exec 与 MCP fail-fast，不伪装成 demo 成功", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-headless-model-"));
  const cwd = path.join(root, "workspace");
  const previousBackend = process.env.ANICODE_CREDENTIAL_BACKEND;
  const previousDeepSeek = process.env.DEEPSEEK_API_KEY;
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.ANICODE_CREDENTIAL_BACKEND = "memory";
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  delete process.env.DEEPSEEK_API_KEY;
  try {
    await fs.mkdir(cwd);
    await fs.writeFile(
      path.join(cwd, "anicode.json"),
      JSON.stringify({ model: "deepseek/deepseek-v4-flash" }),
    );
    const output = { write: () => true } as unknown as NodeJS.WritableStream;
    await assert.rejects(
      runExecCommand(
        [
          "--cwd",
          cwd,
          "--sessions",
          path.join(root, "exec-sessions"),
          "--prompt",
          "must use the configured model",
        ],
        { output, error: output },
      ),
      /DEEPSEEK_API_KEY.*--demo/,
    );
    await assert.rejects(
      runMcpCommand(["--cwd", cwd, "--sessions", path.join(root, "mcp-sessions")], { output }),
      /DEEPSEEK_API_KEY.*--demo/,
    );
  } finally {
    if (previousBackend === undefined) delete process.env.ANICODE_CREDENTIAL_BACKEND;
    else process.env.ANICODE_CREDENTIAL_BACKEND = previousBackend;
    if (previousDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previousDeepSeek;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CLI exec: inspection-failed 明确退回严格只读安全策略，不承诺 write/bash", async (t) => {
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
    assert.match(warnings, /strict read-only safety policy|严格只读安全策略/);
    assert.doesNotMatch(warnings, /plan mode|plan 模式|计划模式/);
    assert.doesNotMatch(warnings, /approve built-in development tools|内置开发工具逐项授权/);
  } finally {
    if (previousBackend === undefined) delete process.env.ANICODE_CREDENTIAL_BACKEND;
    else process.env.ANICODE_CREDENTIAL_BACKEND = previousBackend;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});
