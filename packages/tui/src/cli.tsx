#!/usr/bin/env tsx
/**
 * anicode TUI 入口。
 *
 * 前端只认 SessionHost；这里决定用哪种实现：
 *   默认         → LocalSessionHost（进程内 SessionManager，零 IPC）
 *   --daemon [P] → 连 daemon 的 DaemonClient（跨进程共享会话，可与 App/其他 CLI 接管）
 *
 *   anicode [--model provider/model] [--cwd DIR] [--auto|--accept-edits] [--daemon [SOCKET]] [--resume ID]
 */

import * as os from "node:os";
import * as path from "node:path";
import { promises as fs, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import React from "react";
import { render } from "ink";
import {
  createProvider,
  diagnoseProvider,
  listProviderDetails,
  listModelCatalog,
  SessionManager,
  SessionStore,
  MigratingSessionStore,
  LocalSessionHost,
  DaemonClient,
  defaultDaemonSocketPath,
  HttpSessionHost,
  HttpDaemonServer,
  loadConfig,
  serveMcp,
  discoverPlugins,
  type PluginDirs,
  loadProjectEnv,
  resolveDefaultModel,
  commandHooksFromConfig,
  toMcpServerConfigs,
  toSubagentDefinitions,
  toLspServers,
  browserToolOptions,
  connectMcpServers,
  DEVELOPMENT_MCP_CATALOG,
  findDevelopmentMcp,
  loadCommands,
  defaultTools,
  createDiagnosticsTool,
  LspPool,
  AuthStore,
  createLocalRuntimeStack,
  createConfiguredLocalRuntimeStack,
  ContextCompiler,
  Verifier,
  SecurityPolicyEngine,
  telemetryFromEnv,
  telemetryForLocalStack,
  ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE,
  t,
  type SessionHost,
  type AnicodeConfig,
  type CustomCommand,
  type Tool,
  type McpClient,
  type LocalRuntimeStack,
  type Telemetry,
  type McpServerConfig,
} from "@anicode/core";
import { App, type TuiKeybindingAction } from "./app.js";
import { DebugLogger, withDebugLogging } from "./debug-log.js";
import { TuiErrorBoundary } from "./error-boundary.js";
import { createTerminalCaretOutput } from "./terminal-caret.js";

// 版本号由 build.mjs 经 esbuild define 注入（发布包 package.json 单一事实源）；
// tsx 直跑源码（无 define）时回落到下面的常量。
declare const __ANICODE_VERSION__: string | undefined;
const CLI_VERSION = typeof __ANICODE_VERSION__ !== "undefined" ? __ANICODE_VERSION__ : "0.2.0";
const DISPLAY_NAME = "AniCode Zen";
// 默认走 DeepSeek 开放模型；真正生效值由 resolveDefaultModel 在运行时按凭证/本地服务挑选
// （无 DeepSeek key 时优雅回退，见 resolveDefaultModel）。
const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";

export { resolveDefaultModel };

interface RawModeInput {
  isTTY?: boolean;
  destroyed?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
}

interface TerminalScreenOutput {
  isTTY?: boolean;
  write: (chunk: string) => unknown;
}

interface TerminalScreenInput {
  isTTY?: boolean;
  isRaw?: boolean;
  destroyed?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
}

interface TerminalScreenOptions {
  color?: boolean;
  /** Emergency fallback only; Ink owns the normal alternate-screen lifecycle. */
  alternateScreen?: boolean;
}

const SGR_COLOR = /\u001b\[[0-9;:]*m/g;

export function stripAnsiColors(text: string): string {
  return text.replace(SGR_COLOR, "");
}

/** Output adapter used by --no-color; cursor/erase control sequences are retained. */
export function colorlessTerminalOutput(output: NodeJS.WriteStream): NodeJS.WriteStream {
  const write = ((chunk: unknown, ...args: unknown[]) => {
    const safe =
      typeof chunk === "string"
        ? stripAnsiColors(chunk)
        : Buffer.isBuffer(chunk)
          ? Buffer.from(stripAnsiColors(chunk.toString("utf8")), "utf8")
          : chunk;
    return (output.write as (...values: unknown[]) => boolean).call(output, safe, ...args);
  }) as NodeJS.WriteStream["write"];
  return new Proxy(output, {
    get(target, property) {
      if (property === "write") return write;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const ENTER_ALTERNATE_SCREEN = "\x1b[?1049h";
const RESET_FULLSCREEN_VIEWPORT = "\x1b[r\x1b[2J\x1b[3J\x1b[H";

/**
 * 每次 Ink 进入/恢复备用屏时重置滚动区域并清掉备用屏自己的历史。
 * 某些终端会为全屏帧保留可滚动轨迹；这会让固定高度首页仍出现原生滚动条。
 */
export function fullscreenViewportOutput(
  output: NodeJS.WriteStream,
  enabled: boolean,
): NodeJS.WriteStream {
  if (!enabled) return output;
  const originalWrite = output.write.bind(output) as (...args: unknown[]) => boolean;
  const write = ((chunk: unknown, ...args: unknown[]) => {
    const decorated =
      typeof chunk === "string"
        ? chunk.replaceAll(
            ENTER_ALTERNATE_SCREEN,
            ENTER_ALTERNATE_SCREEN + RESET_FULLSCREEN_VIEWPORT,
          )
        : Buffer.isBuffer(chunk)
          ? Buffer.from(
              chunk
                .toString("utf8")
                .replaceAll(
                  ENTER_ALTERNATE_SCREEN,
                  ENTER_ALTERNATE_SCREEN + RESET_FULLSCREEN_VIEWPORT,
                ),
              "utf8",
            )
          : chunk;
    return originalWrite(decorated, ...args);
  }) as NodeJS.WriteStream["write"];
  return new Proxy(output, {
    get(target, property) {
      if (property === "write") return write;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 在 Ink 首帧之前设置可选终端配色。备用屏由 Ink 7 原生管理；这里的清理函数
 * 负责 raw mode、鼠标/粘贴状态与配色复位，并保留一次紧急备用屏退出兜底。
 */
export function enterTerminalScreen(
  output: TerminalScreenOutput = process.stdout,
  input: TerminalScreenInput = process.stdin,
  options: TerminalScreenOptions = {},
): () => void {
  if (!output.isTTY) return () => {};
  const initialRaw = input.isRaw === true;
  const color = options.color ?? true;
  // Start from a known baseline. If a previous TUI crashed while application mouse mode
  // was active, reset it first; App will opt back in after mounting only for --mouse.
  output.write("\x1b[?1007l\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l");
  if (color) {
    output.write("\x1b]11;#0a0a0a\x07");
    output.write("\x1b]17;#264f78\x07\x1b]19;#dcdcdc\x07");
  }
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    if (input.isTTY && !input.destroyed && input.setRawMode) {
      try {
        input.setRawMode(initialRaw);
      } catch {
        /* best effort: the TTY may already have been detached */
      }
    }
    output.write(
      "\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1007l\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
    );
    if (color) {
      output.write("\x1b]111\x07");
      output.write("\x1b]117\x07\x1b]119\x07");
    }
    if (options.alternateScreen) output.write("\x1b[?1049l");
  };
}

type GuardedSignal = "SIGINT" | "SIGTERM" | "SIGHUP";

/**
 * Restore the terminal before catchable process termination paths.  Signal handlers
 * remove themselves and re-raise the original signal so callers still observe the
 * conventional exit status (130/143/129) instead of a false successful exit.
 */
export function installTerminalExitGuard(
  cleanup: () => void,
  target: NodeJS.Process = process,
): () => void {
  let installed = true;
  const signals: GuardedSignal[] = ["SIGINT", "SIGTERM", "SIGHUP"];

  const remove = () => {
    if (!installed) return;
    installed = false;
    for (const signal of signals) target.off(signal, handlers[signal]);
    target.off("exit", onExit);
    target.off("uncaughtException", onUncaughtException);
    target.off("unhandledRejection", onUnhandledRejection);
  };
  const terminate = (signal: GuardedSignal) => {
    cleanup();
    remove();
    target.kill(target.pid, signal);
  };
  const handlers: Record<GuardedSignal, () => void> = {
    SIGINT: () => terminate("SIGINT"),
    SIGTERM: () => terminate("SIGTERM"),
    SIGHUP: () => terminate("SIGHUP"),
  };
  const onExit = () => cleanup();
  const rethrow = (reason: unknown) => {
    cleanup();
    remove();
    queueMicrotask(() => {
      throw reason instanceof Error ? reason : new Error(String(reason));
    });
  };
  const onUncaughtException = (error: Error) => rethrow(error);
  const onUnhandledRejection = (reason: unknown) => rethrow(reason);

  for (const signal of signals) target.once(signal, handlers[signal]);
  target.once("exit", onExit);
  target.once("uncaughtException", onUncaughtException);
  target.once("unhandledRejection", onUnhandledRejection);
  return remove;
}

/**
 * Ink 只在组件挂载/卸载时切 raw mode；若 IDE 任务面板、job control 或其它 TTY
 * 状态切换在运行期间把终端恢复成 canonical mode，Ink 的内部计数仍认为 raw mode
 * 已开启，按键就会在屏幕底部回显成 `^[[B`，useInput 则完全收不到。
 *
 * Node 的 `stdin.isRaw` 与 libuv 的 TTY mode 都是上次 setRawMode 的缓存，不能反映
 * 外部 termios 改动；单独重复 `setRawMode(true)` 也会被 libuv 当作无变化而跳过。
 * 因此启动及 SIGCONT（从 job control 恢复）时先 false 再 true 强制重申。
 * 可选 interval 只供诊断/兼容旧终端，生产默认不轮询，避免打断 bracketed paste。
 */
export function startRawModeWatchdog(
  input: RawModeInput = process.stdin,
  intervalMs = 0,
): () => void {
  if (!input.isTTY || typeof input.setRawMode !== "function") return () => {};
  const restore = () => {
    if (input.destroyed) return;
    input.setRawMode?.(false);
    input.setRawMode?.(true);
  };
  restore();
  process.on("SIGCONT", restore);
  const timer = intervalMs > 0 ? setInterval(restore, intervalMs) : undefined;
  timer?.unref?.();
  return () => {
    process.off("SIGCONT", restore);
    if (timer) clearInterval(timer);
  };
}

export interface CliArgs {
  model: string;
  /** 用户是否显式传了 --model；否则运行时按已配置凭证挑默认模型。 */
  modelExplicit: boolean;
  cwd: string;
  resume?: string;
  daemon: boolean;
  /** HTTP host 模式：连一个 `anicode serve` 起的 HTTP+SSE 服务。 */
  http?: string;
  httpToken?: string;
  permissionMode: "default" | "acceptEdits" | "auto";
  /** 配置档名（anicode.json 的 profiles 键，对齐 Codex --profile）。 */
  profile?: string;
  socket: string;
  sessionsDir: string;
  sessionsExplicit: boolean;
  demo: boolean;
  help: boolean;
  version: boolean;
  listProviders: boolean;
  listModels: boolean;
  debugLog?: string;
  traceContent: boolean;
  /** Disable styling while retaining the interactive layout. */
  noColor: boolean;
  /** Full xterm mouse tracking; on by default so the fixed transcript viewport receives wheel input. */
  mouse: boolean;
  /** Render in the primary screen buffer. */
  noAltScreen: boolean;
  /** Minimal terminal-effects mode: no colors, mouse tracking or alternate screen. */
  plain: boolean;
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(t(`${flag} requires a value`, `${flag} 需要一个值`));
  }
  return value;
}

/** 严格参数解析：未知参数、缺值和互斥组合都明确失败，不让错误进入 Ink。 */
export function parseArgs(argv: string[]): CliArgs {
  let model = DEFAULT_MODEL;
  let cwd = process.cwd();
  let resume: string | undefined;
  let daemon = false;
  let socket = defaultDaemonSocketPath();
  let sessionsDir = path.join(os.homedir(), ".anicode", "sessions");
  let sessionsExplicit = false;
  let demo = false;
  let help = false;
  let version = false;
  let showProviders = false;
  let showModels = false;
  let debugLog: string | undefined;
  let traceContent = false;
  let http: string | undefined;
  let httpToken: string | undefined;
  let permissionMode: CliArgs["permissionMode"] = "default";
  let profile: string | undefined;
  let noColor = "NO_COLOR" in process.env;
  let mouse = true;
  let noAltScreen = false;
  let plain = false;
  const seen = new Set<string>();

  const mark = (flag: string): void => {
    if (seen.has(flag))
      throw new Error(t(`${flag} cannot be specified more than once`, `${flag} 不能重复指定`));
    seen.add(flag);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--model": {
        mark(arg);
        model = requiredValue(argv, i, arg);
        i++;
        break;
      }
      case "--cwd": {
        mark(arg);
        cwd = path.resolve(requiredValue(argv, i, arg));
        i++;
        break;
      }
      case "--resume": {
        mark(arg);
        resume = requiredValue(argv, i, arg);
        i++;
        break;
      }
      case "--profile": {
        mark(arg);
        profile = requiredValue(argv, i, arg);
        i++;
        break;
      }
      case "--sessions": {
        mark(arg);
        sessionsDir = path.resolve(requiredValue(argv, i, arg));
        sessionsExplicit = true;
        i++;
        break;
      }
      case "--daemon": {
        mark(arg);
        daemon = true;
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          socket = path.resolve(next);
          i++;
        }
        break;
      }
      case "--http":
        mark(arg);
        http = requiredValue(argv, i, arg);
        i++;
        break;
      case "--http-token":
        mark(arg);
        httpToken = requiredValue(argv, i, arg);
        i++;
        break;
      case "--demo":
        mark(arg);
        demo = true;
        break;
      case "--auto":
        mark(arg);
        if (permissionMode !== "default")
          throw new Error(
            t(
              "--auto and --accept-edits cannot be used together",
              "--auto 与 --accept-edits 不能同时使用",
            ),
          );
        permissionMode = "auto";
        break;
      case "--accept-edits":
        mark(arg);
        if (permissionMode !== "default")
          throw new Error(
            t(
              "--auto and --accept-edits cannot be used together",
              "--auto 与 --accept-edits 不能同时使用",
            ),
          );
        permissionMode = "acceptEdits";
        break;
      case "--debug-log": {
        mark(arg);
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          debugLog = path.resolve(next);
          i++;
        } else {
          debugLog = path.resolve(".anicode-dev", "tui.jsonl");
        }
        break;
      }
      case "--trace-content":
        mark(arg);
        traceContent = true;
        break;
      case "--no-color":
        mark(arg);
        noColor = true;
        break;
      case "--mouse":
        mark(arg);
        if (seen.has("--no-mouse") || seen.has("--plain")) {
          throw new Error(
            t(
              "--mouse cannot be used with --no-mouse or --plain",
              "--mouse 不能与 --no-mouse 或 --plain 同时使用",
            ),
          );
        }
        mouse = true;
        break;
      case "--no-mouse":
        mark(arg);
        if (seen.has("--mouse")) {
          throw new Error(
            t(
              "--mouse cannot be used with --no-mouse or --plain",
              "--mouse 不能与 --no-mouse 或 --plain 同时使用",
            ),
          );
        }
        mouse = false;
        break;
      case "--no-alt-screen":
        mark(arg);
        noAltScreen = true;
        break;
      case "--plain":
        mark(arg);
        if (seen.has("--mouse")) {
          throw new Error(
            t(
              "--mouse cannot be used with --no-mouse or --plain",
              "--mouse 不能与 --no-mouse 或 --plain 同时使用",
            ),
          );
        }
        plain = true;
        noColor = true;
        mouse = false;
        noAltScreen = true;
        break;
      case "--list-providers":
        mark(arg);
        showProviders = true;
        break;
      case "--list-models":
        mark(arg);
        showModels = true;
        break;
      case "--help":
      case "-h":
        mark("--help");
        help = true;
        break;
      case "--version":
      case "-v":
        mark("--version");
        version = true;
        break;
      default:
        throw new Error(
          t(
            `Unknown argument: ${arg}\nUse --help to see available options.`,
            `未知参数: ${arg}\n使用 --help 查看可用参数。`,
          ),
        );
    }
  }

  if (demo && seen.has("--model"))
    throw new Error(
      t("--demo and --model cannot be used together", "--demo 与 --model 不能同时使用"),
    );
  if (demo) model = "debug/demo";

  if (http && daemon)
    throw new Error(
      t("--http and --daemon cannot be used together", "--http 与 --daemon 不能同时使用"),
    );

  return {
    model,
    modelExplicit: seen.has("--model"),
    cwd,
    ...(resume ? { resume } : {}),
    daemon,
    ...(http ? { http } : {}),
    ...((httpToken ?? process.env.ANICODE_HTTP_TOKEN)
      ? { httpToken: httpToken ?? process.env.ANICODE_HTTP_TOKEN! }
      : {}),
    permissionMode,
    ...(profile ? { profile } : {}),
    socket,
    sessionsDir,
    sessionsExplicit,
    demo,
    help,
    version,
    listProviders: showProviders,
    listModels: showModels,
    ...(debugLog ? { debugLog } : {}),
    traceContent,
    noColor,
    mouse,
    noAltScreen,
    plain,
  };
}

export function helpText(): string {
  return (
    `${DISPLAY_NAME} ${CLI_VERSION}\n\n` +
    t(`Usage: anicode [options]\n\n`, `用法: anicode [选项]\n\n`) +
    t(
      `Default: standalone local process with embedded SQLite; no AniCode backend/server or external database required.\n\n`,
      `默认：本地单进程 + 内置 SQLite，无需 AniCode 后端服务或外部数据库。\n\n`,
    ) +
    t(
      `  --demo                    Use the zero-key deterministic debug model\n`,
      `  --demo                    使用零 Key 的确定性调试模型\n`,
    ) +
    t(
      `  --model <provider/model>  Select model (auto-picks a provider with configured credentials, else the zero-key debug/demo)\n`,
      `  --model <provider/model>  选择模型（不指定则自动挑已配置凭证的 provider，都没有则用零 Key 的 debug/demo）\n`,
    ) +
    t(
      `  --cwd <dir>               Agent working directory\n`,
      `  --cwd <dir>               Agent 工作目录\n`,
    ) +
    t(
      `  --sessions <dir>          Local session directory\n`,
      `  --sessions <dir>          本地会话目录\n`,
    ) +
    t(
      `  --resume <id>             Resume an existing session\n`,
      `  --resume <id>             恢复已有会话\n`,
    ) +
    t(
      `  --profile <name>          Apply a config profile from anicode.json (profiles key)\n`,
      `  --profile <name>          应用 anicode.json 里的配置档（profiles 键）\n`,
    ) +
    t(
      `  --auto                    Automatically allow edits and commands\n`,
      `  --auto                    自动允许编辑与命令\n`,
    ) +
    t(
      `  --accept-edits            Automatically allow edits, still ask for commands\n`,
      `  --accept-edits            自动允许编辑，命令仍询问\n`,
    ) +
    t(
      `  --daemon [socket]         Connect to shared daemon\n`,
      `  --daemon [socket]         连接共享守护进程\n`,
    ) +
    t(
      `  --http <url>              Connect to an anicode serve HTTP host (see: anicode serve)\n`,
      `  --http <url>              连接 anicode serve 起的 HTTP 服务（另见: anicode serve）\n`,
    ) +
    t(
      `  --http-token <token>      Bearer token for --http (or ANICODE_HTTP_TOKEN)\n`,
      `  --http-token <token>      --http 的 Bearer token（或 ANICODE_HTTP_TOKEN）\n`,
    ) +
    t(
      `  --debug-log [file]        Write JSONL debug log (without polluting the terminal)\n`,
      `  --debug-log [file]        写入 JSONL 调试日志（不污染终端）\n`,
    ) +
    t(
      `  --trace-content           Debug log includes prompt/tool content (may be sensitive)\n`,
      `  --trace-content           调试日志包含提示/工具内容（可能敏感）\n`,
    ) +
    t(
      `  --plain                   Primary screen, no color and no mouse tracking\n`,
      `  --plain                   主屏纯文本模式，不使用颜色和鼠标跟踪\n`,
    ) +
    t(
      `  --no-color                Disable ANSI colors (also honors NO_COLOR)\n`,
      `  --no-color                关闭 ANSI 颜色（同时遵循 NO_COLOR）\n`,
    ) +
    t(
      `  --mouse                   Enable click/wheel tracking (default; Option-drag selects in iTerm2)\n`,
      `  --mouse                   开启点击/滚轮跟踪（默认；iTerm2 按 Option 拖选文字）\n`,
    ) +
    t(
      `  --no-mouse                Disable tracking for plain drag-selection; PageUp/Down scrolls\n`,
      `  --no-mouse                关闭跟踪以直接拖选文字；PageUp/Down 回看\n`,
    ) +
    t(
      `  --no-alt-screen           Keep the TUI in the primary screen buffer\n`,
      `  --no-alt-screen           在主屏缓冲区运行 TUI\n`,
    ) +
    t(
      `  --list-providers          List available providers\n`,
      `  --list-providers          列出可用 provider\n`,
    ) +
    t(
      `  --list-models             List the built-in model catalog (including Free/open-weight models)\n`,
      `  --list-models             列出内置模型目录（含免费/开源模型）\n`,
    ) +
    t(`  -h, --help                Show help\n`, `  -h, --help                显示帮助\n`) +
    t(`  -v, --version             Show version\n\n`, `  -v, --version             显示版本\n\n`) +
    t(`Subcommands:\n`, `子命令:\n`) +
    t(
      `  exec --prompt <text>      Run one prompt headlessly (JSONL by default)\n`,
      `  exec --prompt <text>      无头执行一条提示词（默认 JSONL）\n`,
    ) +
    t(
      `  auth login [provider]     Disabled pending provider authorization; configure an API key\n`,
      `  auth login [provider]     等待提供商授权，当前已禁用；请配置 API key\n`,
    ) +
    t(
      `  auth logout [provider]    Log out and delete local credentials\n`,
      `  auth logout [provider]    登出并删除本地凭证\n`,
    ) +
    t(
      `  auth list                 View logged-in credentials\n\n`,
      `  auth list                 查看已登录凭证\n\n`,
    ) +
    t(
      `  mcp list                  List curated development MCP servers\n`,
      `  mcp list                  列出内置开发编程 MCP\n`,
    ) +
    t(
      `  mcp add <id> [--global]   Install an MCP for this project (or globally)\n`,
      `  mcp add <id> [--global]   为当前项目（或全局）安装 MCP\n`,
    ) +
    t(
      `  mcp remove <id>           Remove a catalog MCP from this project\n`,
      `  mcp remove <id>           从当前项目移除目录 MCP\n`,
    ) +
    t(
      `  mcp serve                 Expose AniCode itself as an MCP server over stdio\n`,
      `  mcp serve                 通过 stdio 将 AniCode 自身暴露为 MCP server\n`,
    ) +
    t(`Local zero-config debugging: npm run dev:tui:demo`, `本地零配置调试: npm run dev:tui:demo`)
  );
}

/** daemon 的权限策略属于守护进程内的 SessionManager，客户端连接不能静默覆盖。 */
export function validateArgs(args: CliArgs): void {
  if (args.traceContent && !args.debugLog) {
    throw new Error(
      t(
        "--trace-content must be used together with --debug-log",
        "--trace-content 必须与 --debug-log 一起使用",
      ),
    );
  }
  if (args.daemon && args.sessionsExplicit) {
    throw new Error(
      t(
        "--sessions cannot be used with a --daemon client: the session directory is managed by the daemon",
        "--sessions 不能用于 --daemon 客户端：会话目录由 daemon 管理",
      ),
    );
  }
  if (args.daemon && args.permissionMode !== "default") {
    const flag = args.permissionMode === "auto" ? "--auto" : "--accept-edits";
    throw new Error(
      t(
        `${flag} cannot be used with a --daemon client: the permission policy is decided uniformly by the daemon process.`,
        `${flag} 不能用于 --daemon 客户端：权限策略由 daemon 进程统一决定。`,
      ) +
        t(
          `Pass ${flag} when starting anicode-daemon; the policy of an already-running daemon will not be modified by the current connection.`,
          `请在启动 anicode-daemon 时传入 ${flag}；已运行 daemon 的策略不会被当前连接修改。`,
        ),
    );
  }
}

/** 本地交互入口要求云端凭证已就绪；core registry 本身仍保持可离线解析。 */
export function assertProviderConfigured(model: string): void {
  const diagnostics = diagnoseProvider(model);
  if (diagnostics.requiresApiKey && !diagnostics.hasCredentials) {
    throw new Error(
      t(`${diagnostics.warnings.join("；")}.`, `${diagnostics.warnings.join("；")}。`) +
        t(
          `You can also use --demo (or npm run dev:tui:demo at the repo root) for zero-key debugging.`,
          `也可以用 --demo（或根目录 npm run dev:tui:demo）进行零 Key 调试。`,
        ),
    );
  }
}

export function resolveConfiguredProvider(model: string) {
  assertProviderConfigured(model);
  return createProvider(model);
}

export async function buildHost(
  args: CliArgs,
  extras: {
    config?: AnicodeConfig;
    extraTools?: Tool[];
    deferredTools?: Tool[];
    plugins?: PluginDirs;
    runtimeStack?: LocalRuntimeStack;
    telemetry?: Telemetry;
  } = {},
): Promise<SessionHost> {
  if (args.daemon) {
    return DaemonClient.connect(args.socket);
  }
  if (args.http) {
    return new HttpSessionHost({
      baseUrl: args.http,
      ...(args.httpToken ? { token: args.httpToken } : {}),
    });
  }
  return new LocalSessionHost(buildManager(args, extras));
}

/** 本地 SessionManager 构造：LocalSessionHost 与 `anicode serve` 共用同一套装配。 */
export function buildManager(
  args: Pick<CliArgs, "sessionsDir" | "permissionMode">,
  extras: {
    config?: AnicodeConfig;
    extraTools?: Tool[];
    deferredTools?: Tool[];
    runtimeStack?: LocalRuntimeStack;
    telemetry?: Telemetry;
    /** 插件目录（discoverPlugins 的产物）：agents/skills 子目录并入既有发现器。 */
    plugins?: PluginDirs;
  } = {},
): SessionManager {
  const config = extras.config ?? {};
  // 配置里的自定义 agents + 文件系统发现（.claude/agents/*.md + 插件 agents/，首次 send 时扫描）；
  // 程序化（config）定义同名覆盖文件定义，内置 general/explore 始终可用。
  const configAgents = toSubagentDefinitions(config);
  const subagents = {
    discover: true,
    definitions: configAgents,
    ...(extras.plugins?.agents.length ? { dirs: extras.plugins.agents } : {}),
  };
  const skills = extras.plugins?.skills.length ? { dirs: extras.plugins.skills } : true;
  const extraTools = extras.extraTools ?? [];
  const deferredTools = extras.deferredTools ?? [];
  const runtimeStack =
    extras.runtimeStack ?? createLocalRuntimeStack(path.dirname(args.sessionsDir));
  const configuredBrowser = browserToolOptions(config);
  const securedBrowser =
    configuredBrowser === false
      ? false
      : {
          ...configuredBrowser,
          ...(process.env.ANICODE_NETWORK_PROXY_URL
            ? { proxyUrl: process.env.ANICODE_NETWORK_PROXY_URL }
            : {}),
          requireProxy: true,
        };
  const manager = new SessionManager({
    store: new MigratingSessionStore(runtimeStack.sessions, new SessionStore(args.sessionsDir)),
    runtime: runtimeStack.runtime,
    artifacts: runtimeStack.artifacts,
    commandInbox: runtimeStack.commandInbox,
    outbox: runtimeStack.outbox,
    networkProxy: runtimeStack.networkProxy,
    worktreeOwnership: runtimeStack.worktreeOwnership,
    contextCompiler: new ContextCompiler({ tokenBudget: 12_000 }),
    verifier: new Verifier({ autoDiscover: true }),
    securityPolicy: SecurityPolicyEngine.workspaceBoundary(),
    telemetry: extras.telemetry ?? telemetryForLocalStack(runtimeStack),
    isolatedRuntime: runtimeStack.isolatedRuntime,
    resolveProvider: resolveConfiguredProvider,
    compaction: true,
    permission: {
      mode: args.permissionMode,
      // anicode.json / .anicode/settings.local.json 的基础权限规则（deny 永远最先）
      ...(config.permissions?.allow?.length ? { allowRules: config.permissions.allow } : {}),
      ...(config.permissions?.deny?.length ? { denyRules: config.permissions.deny } : {}),
      ...(config.permissions?.ask?.length ? { askRules: config.permissions.ask } : {}),
    },
    persistPermissions: true, // allow_always 写回项目 .anicode/settings.local.json
    // 配置里的权限档位：自定义档位表 + 启动即生效的档位名（/profile 运行时可再切）。
    ...(config.permissionProfiles ? { permissionProfiles: config.permissionProfiles } : {}),
    ...(config.permissionProfile ? { permissionProfile: config.permissionProfile } : {}),
    skills,
    subagents,
    checkpoints: true, // 每轮前记工作区 git 快照，支持 /undo 回滚文件改动
    repoMap: true, // 会话开始注入代码骨架（repo map），帮模型少盲 grep、首次定位更准
    // 内置 browser 工具：写完前端自动开页验证。默认开启，config.browser=false 可关。
    browser: securedBrowser,

    // MCP / diagnostics 等附加工具与内置工具合流；无附加工具时沿用默认工具集。
    // deferredTools（大量 MCP）延迟暴露：schema 不进请求，模型经 tool_search 按需激活。
    ...(extraTools.length > 0 || deferredTools.length > 0
      ? {
          tools: () => {
            const reg = defaultTools();
            for (const t of extraTools) reg.register(t);
            for (const t of deferredTools) reg.register(t, { deferred: true });
            return reg;
          },
        }
      : {}),
    smallModel: config.smallModel ?? true, // 摘要等杂活自动走便宜模型
    // 模型降级链：主模型限流/过载时按序切换（anicode.json 的 fallbackModels）。
    ...(config.fallbackModels?.length ? { fallbackModels: config.fallbackModels } : {}),
    // 命令式 hooks（anicode.json 的 hooks 键）：payload JSON 走 stdin，exit 2=block。
    ...(config.hooks?.length
      ? {
          hooks: commandHooksFromConfig(config.hooks, {
            executionRuntime: runtimeStack.isolatedRuntime,
          }),
        }
      : {}),
    autoTitle: true, // 首轮后用小模型给无标题会话起名（失败静默）
  });
  return manager;
}

/**
 * `anicode serve [--port N] [--host H] [--token T] [--sessions DIR]` ——
 * 起 HTTP+SSE 会话服务（server-first）：任意数量的 CLI/App/Web 客户端可用
 * `anicode --http http://H:N` 连上来共享/接管会话。默认只绑 127.0.0.1；
 * 绑非回环地址必须配 --token（或 ANICODE_HTTP_TOKEN）。
 */
export async function runServeCommand(
  argv: string[],
  io: { output?: NodeJS.WritableStream } = {},
): Promise<HttpDaemonServer> {
  const out = io.output ?? process.stderr;
  let port = 8317;
  let hostAddr = "127.0.0.1";
  let token = process.env.ANICODE_HTTP_TOKEN;
  let sessionsDir = path.join(os.homedir(), ".anicode", "sessions");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--port") {
      port = Number(requiredValue(argv, i, arg));
      i++;
    } else if (arg === "--host") {
      hostAddr = requiredValue(argv, i, arg);
      i++;
    } else if (arg === "--token") {
      token = requiredValue(argv, i, arg);
      i++;
    } else if (arg === "--sessions") {
      sessionsDir = path.resolve(requiredValue(argv, i, arg));
      i++;
    } else {
      throw new Error(t(`Unknown serve argument: ${arg}`, `serve 未知参数: ${arg}`));
    }
  }
  if (hostAddr !== "127.0.0.1" && hostAddr !== "localhost" && hostAddr !== "::1") {
    throw new Error(
      t(
        "The HTTP daemon is loopback-only; put an HTTPS/mTLS reverse proxy in front for remote access",
        "HTTP daemon 仅允许绑定回环地址；远程访问请在前面部署 HTTPS/mTLS 反向代理",
      ),
    );
  }
  const { config } = await loadConfig();
  const runtimeStack = await createConfiguredLocalRuntimeStack(path.dirname(sessionsDir));
  const manager = buildManager(
    { sessionsDir, permissionMode: "default" },
    { config, runtimeStack },
  );
  const server = new HttpDaemonServer({
    manager,
    ...(token ? { token } : {}),
    onClose: async () => {
      manager.dispose();
      await runtimeStack.networkProxy.close();
      await runtimeStack.database.close();
    },
  });
  await server.listen(port, hostAddr);
  out.write(
    t(
      `anicode serve listening on http://${hostAddr}:${server.port()} (sessions: ${sessionsDir})\n`,
      `anicode serve 已监听 http://${hostAddr}:${server.port()}（会话目录: ${sessionsDir}）\n`,
    ),
  );
  return server;
}

/** --resume 只选定会话；真正的 open/订阅由 App 统一执行一次。 */
export async function selectSessionId(
  host: Pick<SessionHost, "createSession">,
  args: CliArgs,
): Promise<string> {
  if (args.resume) return args.resume;
  return (await host.createSession({ cwd: args.cwd, model: args.model })).id;
}

/**
 * `anicode auth <login|logout|list> [provider]` —— OAuth 凭证检查/清理；生产登录入口默认禁用。
 * login 走 PKCE：打开浏览器授权 → 用户粘回 `code#state` → 换 token 存 ~/.anicode/auth.json。
 */
/**
 * `anicode mcp` —— 把 anicode 作为 MCP server 暴露（对齐 `codex mcp-server`）。
 * stdio 换行分隔 JSON-RPC；工具 anicode（新会话跑任务）/ anicode_reply（续会话）。
 * 嵌入场景无人点确认框 → 权限默认 auto（可 --permission-mode 覆盖，deny 规则仍最先生效）。
 */
export async function runMcpCommand(
  argv: string[],
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<{ close(): void }> {
  let cwd = process.cwd();
  let model: string | undefined;
  let sessionsDir = path.join(os.homedir(), ".anicode", "sessions");
  let permissionMode: CliArgs["permissionMode"] = "auto";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--cwd") {
      cwd = path.resolve(requiredValue(argv, i, arg));
      i++;
    } else if (arg === "--model") {
      model = requiredValue(argv, i, arg);
      i++;
    } else if (arg === "--sessions") {
      sessionsDir = path.resolve(requiredValue(argv, i, arg));
      i++;
    } else if (arg === "--permission-mode") {
      permissionMode = requiredValue(argv, i, arg) as CliArgs["permissionMode"];
      i++;
    } else {
      throw new Error(t(`Unknown mcp argument: ${arg}`, `mcp 未知参数: ${arg}`));
    }
  }
  const { config } = await loadConfig({ cwd });
  const runtimeStack = await createConfiguredLocalRuntimeStack(path.dirname(sessionsDir));
  const manager = buildManager({ sessionsDir, permissionMode }, { config, runtimeStack });
  const server = serveMcp({
    manager,
    model: model ?? config.model ?? resolveDefaultModel(),
    cwd,
    ...(io.input ? { input: io.input } : {}),
    ...(io.output ? { output: io.output } : {}),
    serverInfo: { name: "anicode", version: CLI_VERSION },
  });
  return {
    close() {
      server.close();
      manager.dispose();
      void runtimeStack.networkProxy.close().then(() => runtimeStack.database.close());
    },
  };
}

type McpCatalogScope = "project" | "global";

/** `anicode mcp list|add|remove` — manage the curated development MCP catalog. */
export async function runMcpCatalogCommand(
  argv: string[],
  io: {
    output?: NodeJS.WritableStream;
    cwd?: string;
    home?: string;
  } = {},
): Promise<void> {
  const output = io.output ?? process.stdout;
  const command = argv[0] ?? "list";
  let cwd = path.resolve(io.cwd ?? process.cwd());
  const home = path.resolve(io.home ?? os.homedir());
  let scope: McpCatalogScope = "project";
  let json = false;
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--global") {
      scope = "global";
    } else if (arg === "--project") {
      scope = "project";
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--cwd") {
      cwd = path.resolve(requiredValue(argv, i, arg));
      i++;
    } else if (arg.startsWith("-")) {
      throw new Error(t(`Unknown mcp catalog option: ${arg}`, `未知 MCP 目录参数: ${arg}`));
    } else {
      positional.push(arg);
    }
  }

  if (command === "list") {
    if (positional.length > 0) {
      throw new Error(t("mcp list takes no id", "mcp list 不接受 id"));
    }
    const { config } = await loadConfig({ cwd, home });
    const installed = new Set(Object.keys(config.mcp ?? {}));
    const rows = DEVELOPMENT_MCP_CATALOG.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      installed: installed.has(entry.server.name),
      transport: "url" in entry.server ? "http" : "stdio",
      requiresEnv: [...(entry.requiresEnv ?? [])],
      version: entry.version,
    }));
    if (json) {
      output.write(`${JSON.stringify(rows, null, 2)}\n`);
      return;
    }
    output.write(`${t("Development MCP catalog", "开发编程 MCP 目录")}\n`);
    for (const row of rows) {
      const credential =
        row.requiresEnv.length > 0
          ? t(` · credential ${row.requiresEnv.join("/")}`, ` · 凭证 ${row.requiresEnv.join("/")}`)
          : "";
      output.write(
        `${row.installed ? "✓" : "○"} ${row.id.padEnd(18)} ${row.name} · ${row.transport} · ${row.version}${credential}\n`,
      );
      output.write(`  ${row.description}\n`);
    }
    output.write(
      t(
        "Use `anicode mcp add <id>` for this project, or append `--global` for all projects.\n",
        "使用 `anicode mcp add <id>` 安装到当前项目，追加 `--global` 则全局安装。\n",
      ),
    );
    return;
  }

  if (command !== "add" && command !== "remove") {
    throw new Error(
      t(
        `Unknown mcp command: ${command} (expected list/add/remove/serve)`,
        `未知 mcp 命令: ${command}（可用 list/add/remove/serve）`,
      ),
    );
  }
  if (positional.length !== 1) {
    throw new Error(
      t(`mcp ${command} requires exactly one id`, `mcp ${command} 需要且仅需要一个 id`),
    );
  }
  const entry = findDevelopmentMcp(positional[0]!);
  if (!entry) {
    throw new Error(
      t(
        `Unknown development MCP: ${positional[0]} (run anicode mcp list)`,
        `未知开发 MCP: ${positional[0]}（请运行 anicode mcp list）`,
      ),
    );
  }
  const file =
    scope === "global"
      ? path.join(home, ".config", "anicode", "anicode.json")
      : path.join(cwd, ".anicode", "settings.local.json");
  const serverName = entry.server.name;
  await mutateMcpSettings(file, serverName, command === "add" ? entry.server : undefined);
  output.write(
    command === "add"
      ? t(
          `Installed ${entry.name} in ${file}. It will connect on the next AniCode start.${entry.requiresEnv?.length ? ` Set ${entry.requiresEnv.join(" or ")} first.` : ""}\n`,
          `已将 ${entry.name} 安装到 ${file}，下次启动 AniCode 时连接。${entry.requiresEnv?.length ? ` 请先设置 ${entry.requiresEnv.join(" 或 ")}。` : ""}\n`,
        )
      : t(`Removed ${entry.name} from ${file}.\n`, `已从 ${file} 移除 ${entry.name}。\n`),
  );
}

async function mutateMcpSettings(
  file: string,
  serverName: string,
  server: McpServerConfig | undefined,
): Promise<void> {
  let root: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${file}: top level must be an object`);
    }
    root = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const previous = root["mcp"];
  if (
    previous !== undefined &&
    (!previous || typeof previous !== "object" || Array.isArray(previous))
  ) {
    throw new Error(`${file}: mcp must be an object`);
  }
  const mcp = { ...((previous as Record<string, unknown> | undefined) ?? {}) };
  if (server) {
    const { name: _name, ...config } = server;
    mcp[serverName] = config;
  } else {
    delete mcp[serverName];
  }
  if (Object.keys(mcp).length > 0) root["mcp"] = mcp;
  else delete root["mcp"];

  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function runAuthCommand(
  argv: string[],
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<void> {
  const sub = argv[0] ?? "";
  const provider = argv[1] ?? "anthropic";
  const store = new AuthStore();
  const out = io.output ?? process.stdout;
  const log = (s: string) => out.write(s + "\n");

  if (sub === "list") {
    const creds = await store.list();
    if (creds.length === 0) {
      log(
        t(
          "No OAuth credentials. Configure the provider API key documented for your selected model.",
          "尚无 OAuth 凭证。请为所选模型配置对应 provider 的 API key。",
        ),
      );
      return;
    }
    for (const c of creds) {
      const exp = c.expiresAt
        ? t(
            `, access expires at ${new Date(c.expiresAt).toLocaleString()}`,
            `，access 过期于 ${new Date(c.expiresAt).toLocaleString()}`,
          )
        : "";
      log(`${c.providerId}\t${c.type}${exp}`);
    }
    return;
  }

  if (sub === "logout") {
    const removed = await store.remove(provider);
    log(
      removed
        ? t(`Logged out ${provider}`, `已登出 ${provider}`)
        : t(`${provider} not logged in`, `${provider} 未登录`),
    );
    return;
  }

  if (sub === "login") {
    throw new Error(
      t(
        `${ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE}. Requested provider: ${provider}`,
        `Anthropic 订阅 OAuth 在第三方客户端获得明确书面授权前已禁用；请使用 Anthropic API key 或官方支持的企业 provider。请求的 provider: ${provider}`,
      ),
    );
  }

  throw new Error(
    t(
      `Usage: anicode auth <login|logout|list> [provider]`,
      `用法: anicode auth <login|logout|list> [provider]`,
    ),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ExecCommandOptions {
  args: CliArgs;
  prompt?: string;
  jsonl: boolean;
  timeoutMs: number;
  help: boolean;
}

export function parseExecArgs(argv: string[]): ExecCommandOptions {
  const base: string[] = [];
  let prompt: string | undefined;
  let jsonl = true;
  let timeoutMs = 30 * 60_000;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      prompt = argv.slice(i + 1).join(" ");
      break;
    }
    if (arg === "--prompt") {
      prompt = requiredValue(argv, i, arg);
      i++;
      continue;
    }
    if (arg === "--jsonl") {
      jsonl = true;
      continue;
    }
    if (arg === "--text") {
      jsonl = false;
      continue;
    }
    if (arg === "--timeout") {
      const raw = requiredValue(argv, i, arg);
      timeoutMs = Number(raw);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
        throw new Error(
          t("--timeout must be a positive number of milliseconds", "--timeout 必须是正毫秒数"),
        );
      i++;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    base.push(arg);
  }
  const args = parseArgs(base);
  validateArgs(args);
  return { args, ...(prompt !== undefined ? { prompt } : {}), jsonl, timeoutMs, help };
}

export function execHelpText(): string {
  return t(
    `Usage: anicode exec [TUI options] [--jsonl|--text] [--timeout MS] (--prompt TEXT | -- TEXT)\n\n` +
      `Runs one prompt without a TUI. JSONL is the default. Permissions are denied unless the selected runtime policy already allows them; use --auto only in a suitably isolated workspace.\n`,
    `用法: anicode exec [TUI 选项] [--jsonl|--text] [--timeout 毫秒] (--prompt 文本 | -- 文本)\n\n` +
      `无 TUI 执行一条提示词，默认输出 JSONL。未被运行时策略放行的权限会被拒绝；仅应在妥善隔离的工作区使用 --auto。\n`,
  );
}

const MAX_EXEC_STDIN_BYTES = 4 * 1024 * 1024;

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of input as AsyncIterable<Buffer | string>) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_EXEC_STDIN_BYTES) {
      throw new Error(
        t(
          `exec stdin exceeds ${MAX_EXEC_STDIN_BYTES} bytes`,
          `exec stdin 超过 ${MAX_EXEC_STDIN_BYTES} bytes`,
        ),
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function runExecCommand(
  argv: string[],
  io: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
    error?: NodeJS.WritableStream;
  } = {},
): Promise<void> {
  const parsed = parseExecArgs(argv);
  const output = io.output ?? process.stdout;
  const errorOutput = io.error ?? process.stderr;
  if (parsed.help) {
    output.write(execHelpText());
    return;
  }
  const args = parsed.args;
  if (args.version) {
    output.write(`${CLI_VERSION}\n`);
    return;
  }
  await loadProjectEnv({ cwd: args.cwd });
  if (args.listProviders) {
    output.write(
      `${listProviderDetails()
        .map((provider) => provider.id)
        .join("\n")}\n`,
    );
    return;
  }
  if (args.listModels) {
    output.write(
      `${listModelCatalog()
        .map((entry) => entry.spec)
        .join("\n")}\n`,
    );
    return;
  }
  const input = io.input ?? process.stdin;
  if (parsed.prompt === undefined && (input as NodeJS.ReadStream).isTTY) {
    throw new Error(
      t(
        "exec requires --prompt, -- TEXT, or piped stdin",
        "exec 需要 --prompt、-- 文本或管道 stdin",
      ),
    );
  }
  const prompt = parsed.prompt ?? (await readAll(input));
  if (!prompt.trim()) throw new Error(t("exec requires a non-empty prompt", "exec 需要非空提示词"));
  if (Buffer.byteLength(prompt, "utf8") > MAX_EXEC_STDIN_BYTES) {
    throw new Error(
      t(
        `exec prompt exceeds ${MAX_EXEC_STDIN_BYTES} bytes`,
        `exec 提示词超过 ${MAX_EXEC_STDIN_BYTES} bytes`,
      ),
    );
  }

  const emit = (type: string, properties: Record<string, unknown> = {}): void => {
    if (parsed.jsonl) output.write(`${JSON.stringify({ type, ...properties })}\n`);
  };
  const warn = (message: string): void => {
    if (parsed.jsonl) emit("warning", { message });
    else errorOutput.write(`${message}\n`);
  };

  const { config, warnings } = await loadConfig({
    cwd: args.cwd,
    ...(args.profile ? { profile: args.profile } : {}),
  });
  for (const warning of warnings) warn(warning);
  if (!args.modelExplicit && !args.demo) args.model = config.model ?? resolveDefaultModel();
  if (!args.daemon && !args.http && !args.resume) assertProviderConfigured(args.model);

  const runtimeStack =
    !args.daemon && !args.http
      ? await createConfiguredLocalRuntimeStack(path.dirname(args.sessionsDir))
      : undefined;
  const telemetry = runtimeStack ? telemetryForLocalStack(runtimeStack) : telemetryFromEnv();
  let mcpClients: McpClient[] = [];
  let lspPool: LspPool | undefined;
  let host: SessionHost | undefined;
  try {
    let mcpTools: Tool[] = [];
    if (runtimeStack) {
      const mcpConfigs = toMcpServerConfigs(config);
      if (mcpConfigs.length > 0) {
        try {
          const connected = await connectMcpServers(mcpConfigs, {
            telemetry,
            networkProxy: runtimeStack.networkProxy,
            credentialBroker: runtimeStack.broker,
            executionRuntime: runtimeStack.isolatedRuntime,
          });
          mcpClients = connected.clients;
          mcpTools = connected.tools;
        } catch (error) {
          warn(`MCP connection failed: ${errorMessage(error)}`);
        }
      }
    }
    const lspServers = args.daemon ? [] : toLspServers(config);
    lspPool =
      lspServers.length > 0
        ? new LspPool(args.cwd, lspServers, runtimeStack?.isolatedRuntime)
        : undefined;
    const deferMcp = mcpTools.length > 8;
    const extraTools: Tool[] = [
      ...(deferMcp ? [] : mcpTools),
      ...(lspPool ? [createDiagnosticsTool(lspPool)] : []),
    ];
    const plugins = args.daemon ? undefined : await discoverPlugins(args.cwd);
    host = await buildHost(args, {
      config,
      extraTools,
      deferredTools: deferMcp ? mcpTools : [],
      ...(plugins ? { plugins } : {}),
      ...(runtimeStack ? { runtimeStack } : {}),
      telemetry,
    });
    if (args.debugLog) {
      const logger = new DebugLogger(args.debugLog, args.traceContent);
      logger.log("cli.exec.start", { model: args.model, cwd: args.cwd });
      host = withDebugLogging(host, logger);
    }

    const sessionId = await selectSessionId(host, args);
    emit("session.started", { sessionId, model: args.model, cwd: args.cwd });
    let wroteText = false;
    const permissionReplies: Promise<unknown>[] = [];
    const handle = await host.open(sessionId, (event) => {
      if (parsed.jsonl) emit("session.event", { sessionId, event });
      else if (event.type === "agent" && event.event.type === "text") {
        output.write(event.event.text);
        wroteText = true;
      }
      if (event.type === "permission_request") {
        permissionReplies.push(
          host!
            .answerPermission(sessionId, event.permId, "deny")
            .catch((error) => warn(`Permission denial failed: ${errorMessage(error)}`)),
        );
      }
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error(t("exec timed out", "exec 执行超时"))),
        parsed.timeoutMs,
      );
      timeout.unref?.();
    });
    try {
      await Promise.race([
        host.send(sessionId, prompt, {
          idempotencyKey: `exec-${process.pid}-${Date.now()}`,
        }),
        timedOut,
      ]);
      await Promise.allSettled(permissionReplies);
    } catch (error) {
      await host.interrupt(sessionId).catch(() => undefined);
      emit("session.failed", { sessionId, error: errorMessage(error) });
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    handle.close();
    const finalHandle = await host.open(sessionId, () => {});
    emit("session.completed", {
      sessionId,
      usage: finalHandle.snapshot.usage,
      ...(finalHandle.snapshot.costUSD !== undefined
        ? { costUSD: finalHandle.snapshot.costUSD }
        : {}),
    });
    finalHandle.close();
    if (!parsed.jsonl && wroteText) output.write("\n");
  } finally {
    host?.dispose();
    lspPool?.closeAll();
    for (const client of mcpClients) {
      try {
        client.close();
      } catch {
        // Cleanup is best-effort; preserve the command's real result.
      }
    }
    await runtimeStack?.networkProxy.close().catch(() => undefined);
    await runtimeStack?.database.close().catch(() => undefined);
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  // auth/serve 子命令在 parseArgs 之前拦截（不进会话流程）。
  if (argv[0] === "auth") {
    await runAuthCommand(argv.slice(1));
    return;
  }
  if (argv[0] === "mcp") {
    await loadProjectEnv({ cwd: process.cwd() });
    const subcommand = argv[1];
    if (subcommand === "list" || subcommand === "add" || subcommand === "remove") {
      await runMcpCatalogCommand(argv.slice(1));
      return;
    }
    const server = await runMcpCommand(subcommand === "serve" ? argv.slice(2) : argv.slice(1));
    // stdio server 常驻直到 stdin 关闭（客户端断开）或收到信号。
    await new Promise<void>((resolve) => {
      process.stdin.once("end", resolve);
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    server.close();
    return;
  }
  if (argv[0] === "serve") {
    await loadProjectEnv({ cwd: process.cwd() });
    const server = await runServeCommand(argv.slice(1));
    // 前台常驻直到 SIGINT/SIGTERM。
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    await server.close();
    return;
  }
  if (argv[0] === "exec") {
    await runExecCommand(argv.slice(1));
    return;
  }

  const args = parseArgs(argv);
  validateArgs(args);

  if (args.help) {
    console.log(helpText());
    return;
  }
  if (args.version) {
    console.log(CLI_VERSION);
    return;
  }
  await loadProjectEnv({ cwd: args.cwd });
  if (args.listProviders) {
    console.log(
      listProviderDetails()
        .map((provider) => {
          const where = provider.local ? "local" : "cloud";
          const key = provider.requiresApiKey
            ? `key: ${provider.apiKeyEnv.join(" | ")}`
            : "key: not required";
          return `${provider.id}\t${provider.protocol}\t${where}\t${key}`;
        })
        .join("\n"),
    );
    return;
  }
  if (args.listModels) {
    console.log(
      listModelCatalog()
        .map((m) => {
          const tags = [
            m.free ? "free" : null,
            m.openWeight ? "open" : null,
            m.local ? "local" : null,
            m.recommended ? "recommended" : null,
          ]
            .filter(Boolean)
            .join(",");
          return `${m.spec}\t${tags || "-"}\t${m.note ?? m.label ?? ""}`;
        })
        .join("\n"),
    );
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      t(
        "Interactive TUI requires a terminal (TTY). Use --help, --list-models, or the `anicode exec` headless command.",
        "交互式 TUI 需要终端（TTY）。可使用 --help、--list-models，或无头模式 `anicode exec`。",
      ),
    );
  }

  // 读取 anicode.json（全局+项目合并）；非法配置只提示不致命。
  const { config, warnings: configWarnings } = await loadConfig({
    cwd: args.cwd,
    ...(args.profile ? { profile: args.profile } : {}),
  });
  for (const w of configWarnings)
    console.error(t(`${DISPLAY_NAME} config warning: ${w}`, `${DISPLAY_NAME} 配置告警: ${w}`));

  // 安全栈必须先于 provider/MCP 创建：环境密钥此时迁入 Broker 并从进程环境删除，
  // provider、HTTP MCP 与后续工具共用同一个策略出口和 trace exporter。
  const localRuntimeStack =
    !args.daemon && !args.http
      ? await createConfiguredLocalRuntimeStack(path.dirname(args.sessionsDir))
      : undefined;
  const telemetry = localRuntimeStack
    ? telemetryForLocalStack(localRuntimeStack)
    : telemetryFromEnv();

  // 未显式指定模型时挑默认：配置 model → 已配置凭证的 DeepSeek → 零网络 debug/demo。
  // 绝不因缺 DEEPSEEK_API_KEY 报错退出。
  if (!args.modelExplicit && !args.demo) {
    args.model = config.model ?? resolveDefaultModel();
  }

  // 校验 provider（本地模式下尽早报错）。仅当用户显式选了缺 key 的模型才会抛错。
  if (!args.daemon && !args.resume) {
    try {
      // 这里只做无副作用诊断；真正创建 provider 由 createSession 唯一执行。
      assertProviderConfigured(args.model);
    } catch (err) {
      throw new Error(
        t(
          `Invalid model configuration: ${String((err as Error).message)}`,
          `模型配置无效: ${String((err as Error).message)}`,
        ),
        { cause: err },
      );
    }
  }

  // 连接配置里的 MCP 服务器（本地进程内模式才需要；daemon 由其自身进程负责）。
  let mcpClients: McpClient[] = [];
  let mcpTools: Tool[] = [];
  if (!args.daemon && !args.http) {
    const mcpConfigs = toMcpServerConfigs(config);
    if (mcpConfigs.length > 0) {
      try {
        const connected = await connectMcpServers(mcpConfigs, {
          telemetry,
          networkProxy: localRuntimeStack!.networkProxy,
          credentialBroker: localRuntimeStack!.broker,
          executionRuntime: localRuntimeStack!.isolatedRuntime,
        });
        mcpTools = connected.tools;
        mcpClients = connected.clients;
        console.error(
          t(
            `${DISPLAY_NAME}: connected ${mcpClients.length} MCP servers, ${mcpTools.length} tools`,
            `${DISPLAY_NAME}: 已连接 ${mcpClients.length} 个 MCP 服务器，${mcpTools.length} 个工具`,
          ),
        );
      } catch (err) {
        console.error(
          t(
            `${DISPLAY_NAME}: MCP connection failed (skipped): ${(err as Error).message}`,
            `${DISPLAY_NAME}: MCP 连接失败（已跳过）: ${(err as Error).message}`,
          ),
        );
      }
    }
  }
  // 配置了 LSP 服务器则建池，并暴露 diagnostics 工具（惰性按扩展名启动服务器）。
  const lspServers = args.daemon ? [] : toLspServers(config);
  const lspPool =
    lspServers.length > 0
      ? new LspPool(args.cwd, lspServers, localRuntimeStack?.isolatedRuntime)
      : undefined;
  // MCP 工具超过阈值时转 deferred（延迟暴露）：schema 不占每次请求，
  // 模型经 tool_search 按需检索激活——对齐 Codex 的 MCP tool search 默认行为。
  const DEFER_MCP_THRESHOLD = 8;
  const deferMcp = mcpTools.length > DEFER_MCP_THRESHOLD;
  const extraTools: Tool[] = [
    ...(deferMcp ? [] : mcpTools),
    ...(lspPool ? [createDiagnosticsTool(lspPool)] : []),
  ];
  const deferredTools: Tool[] = deferMcp ? mcpTools : [];

  // 插件目录（~/.anicode/plugins + <cwd>/.anicode/plugins）：agents/skills/commands
  // 子目录并入既有发现器（对齐 Claude Code plugins 的「目录捆绑扩展」形态）。
  const plugins = args.daemon ? undefined : await discoverPlugins(args.cwd);

  // 自定义斜杠命令（.anicode/command/*.md，全局+插件+项目）。
  const commands: CustomCommand[] = args.daemon
    ? []
    : await loadCommands({
        cwd: args.cwd,
        ...(plugins?.commands.length ? { extraDirs: plugins.commands } : {}),
      });

  // MCP prompts → 斜杠命令 /mcp__<server>__<prompt>（对齐 Claude Code）。
  // 定位参数按 prompt 声明的 arguments 顺序映射；渲染经 prompts/get 实时取。
  for (const client of mcpClients) {
    if (!client.capabilities.prompts) continue;
    try {
      for (const p of await client.listPrompts()) {
        const promptDef = p;
        commands.push({
          name: `mcp__${client.name}__${p.name}`,
          description:
            p.description ??
            t(`MCP prompt from ${client.name}`, `来自 ${client.name} 的 MCP 提示模板`),
          template: "",
          source: `mcp:${client.name}`,
          resolve: async (argText: string) => {
            const parts = argText.trim() ? argText.trim().split(/\s+/) : [];
            const argMap: Record<string, string> = {};
            (promptDef.arguments ?? []).forEach((a, i) => {
              if (parts[i] !== undefined) argMap[a.name] = parts[i]!;
            });
            return client.getPrompt(
              promptDef.name,
              Object.keys(argMap).length > 0 ? argMap : undefined,
            );
          },
        });
      }
    } catch (err) {
      console.error(
        t(
          `${DISPLAY_NAME}: failed to list prompts from MCP server ${client.name}: ${(err as Error).message}`,
          `${DISPLAY_NAME}: 拉取 MCP 服务器 ${client.name} 的 prompts 失败: ${(err as Error).message}`,
        ),
      );
    }
  }

  // /mcp 状态概览：server 能力、资源、prompts（延迟查询，命令触发时才拉）。
  const mcpStatus =
    mcpClients.length === 0
      ? undefined
      : async (): Promise<string> => {
          const lines: string[] = [];
          for (const client of mcpClients) {
            const caps = client.capabilities;
            const flag = (v: boolean) => (v ? "✓" : "—");
            lines.push(
              `▸ ${client.name}  tools:${flag(caps.tools)} resources:${flag(caps.resources)} prompts:${flag(caps.prompts)}`,
            );
            try {
              for (const r of (await client.listResources()).slice(0, 20)) {
                lines.push(`    ${t("resource", "资源")} ${r.uri}${r.name ? `（${r.name}）` : ""}`);
              }
              for (const p of await client.listPrompts()) {
                lines.push(
                  `    ${t("prompt", "提示")} /mcp__${client.name}__${p.name}${p.description ? ` — ${p.description}` : ""}`,
                );
              }
            } catch (err) {
              lines.push(`    ${t("query failed", "查询失败")}: ${(err as Error).message}`);
            }
          }
          return lines.join("\n");
        };

  let host: SessionHost | undefined;
  let debugLogger: DebugLogger | undefined;
  try {
    const baseHost = await buildHost(args, {
      config,
      extraTools,
      deferredTools,
      ...(plugins ? { plugins } : {}),
      ...(localRuntimeStack ? { runtimeStack: localRuntimeStack } : {}),
      telemetry,
    }).catch((err) => {
      throw new Error(
        t(
          `Failed to establish session host: ${(err as Error).message}`,
          `无法建立会话宿主: ${(err as Error).message}`,
        ),
      );
    });
    host = baseHost;
    if (args.debugLog) {
      const logger = new DebugLogger(args.debugLog, args.traceContent);
      debugLogger = logger;
      logger.log("cli.start", {
        model: args.model,
        cwd: args.cwd,
        daemon: args.daemon,
        permissionMode: args.permissionMode,
      });
      host = withDebugLogging(baseHost, logger);
      console.error(
        t(`${DISPLAY_NAME} debug log: ${logger.file}`, `${DISPLAY_NAME} 调试日志: ${logger.file}`),
      );
    }
    // 选定会话：--resume 用已有 ID，否则新建。订阅只由 App 负责。
    const sessionId = await selectSessionId(host, args);
    const screenReader = process.env.INK_SCREEN_READER === "true";
    const alternateScreen = !args.noAltScreen && !screenReader;
    const mouse = args.mouse && !screenReader;
    const experimentalOverlay = process.env.ANICODE_EXPERIMENTAL_TUI_OVERLAY === "1";
    const baseTerminalOutput = args.noColor
      ? colorlessTerminalOutput(process.stdout)
      : process.stdout;
    const fullscreenOutput = fullscreenViewportOutput(baseTerminalOutput, alternateScreen);
    const terminalCaret = createTerminalCaretOutput(fullscreenOutput, {
      enabled: !screenReader && !experimentalOverlay,
    });
    const terminalOutput = terminalCaret.output;
    const restoreTerminalScreen = enterTerminalScreen(terminalOutput, process.stdin, {
      color: !args.noColor,
      alternateScreen,
    });
    let instance: ReturnType<typeof render> | undefined;
    let stopRawModeWatchdog = () => {};
    const emergencyTerminalCleanup = () => {
      stopRawModeWatchdog();
      terminalCaret.controller.dispose();
      // Unmount first so Ink cannot repaint onto the primary screen after we leave
      // alternate-screen mode during a signal/exception shutdown.
      instance?.unmount();
      restoreTerminalScreen();
    };
    const removeTerminalExitGuard = installTerminalExitGuard(emergencyTerminalCleanup);
    try {
      instance = render(
        <TuiErrorBoundary
          onError={(error, componentStack) =>
            debugLogger?.log("tui.render_crash", {
              message: error.message,
              stack: error.stack,
              componentStack,
            })
          }
        >
          <App
            host={host}
            cwd={args.cwd}
            model={args.model}
            sessionId={sessionId}
            providers={listProviderDetails()}
            catalog={listModelCatalog()}
            commands={commands}
            {...(mcpStatus ? { mcpStatus } : {})}
            inspectProviderCredentials={!args.daemon}
            version={CLI_VERSION}
            mouse={mouse}
            experimentalOverlay={experimentalOverlay}
            terminalCaret={terminalCaret.controller}
            {...(config.tui?.keybindings
              ? {
                  keybindings: config.tui.keybindings as Partial<
                    Record<TuiKeybindingAction, string>
                  >,
                }
              : {})}
            terminalControl
          />
        </TuiErrorBoundary>,
        {
          stdout: terminalOutput,
          alternateScreen,
          incrementalRendering: !screenReader,
          isScreenReaderEnabled: screenReader,
          maxFps: 30,
        },
      );
      stopRawModeWatchdog = startRawModeWatchdog();
      try {
        await instance.waitUntilExit();
      } finally {
        stopRawModeWatchdog();
      }
    } finally {
      removeTerminalExitGuard();
      terminalCaret.controller.dispose();
      restoreTerminalScreen();
    }
  } finally {
    host?.dispose();
    lspPool?.closeAll();
    for (const c of mcpClients) {
      try {
        c.close();
      } catch {
        // 关闭 MCP 子进程失败不影响退出
      }
    }
    await localRuntimeStack?.networkProxy.close().catch(() => undefined);
    await localRuntimeStack?.database.close().catch(() => undefined);
  }
}

function canonicalPath(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  canonicalPath(fileURLToPath(import.meta.url)) === canonicalPath(path.resolve(invokedPath))
) {
  main().catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exitCode = 1;
  });
}
