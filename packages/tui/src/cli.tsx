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
import { realpathSync } from "node:fs";
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
  LocalSessionHost,
  DaemonClient,
  type SessionHost,
} from "@anicode/core";
import { App } from "./app.js";
import { DebugLogger, withDebugLogging } from "./debug-log.js";

const CLI_VERSION = "0.1.0";
// 默认走 DeepSeek 开放模型；真正生效值由 resolveDefaultModel 在运行时按凭证/本地服务挑选
// （无 DeepSeek key 时优雅回退，见 resolveDefaultModel）。
const DEFAULT_MODEL = "deepseek/deepseek-chat";

export interface CliArgs {
  model: string;
  /** 用户是否显式传了 --model；否则运行时按已配置凭证挑默认模型。 */
  modelExplicit: boolean;
  cwd: string;
  resume?: string;
  daemon: boolean;
  permissionMode: "default" | "acceptEdits" | "auto";
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
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} 需要一个值`);
  }
  return value;
}

/** 严格参数解析：未知参数、缺值和互斥组合都明确失败，不让错误进入 Ink。 */
export function parseArgs(argv: string[]): CliArgs {
  let model = DEFAULT_MODEL;
  let cwd = process.cwd();
  let resume: string | undefined;
  let daemon = false;
  let socket = path.join(os.tmpdir(), "anicode.sock");
  let sessionsDir = path.join(os.homedir(), ".anicode", "sessions");
  let sessionsExplicit = false;
  let demo = false;
  let help = false;
  let version = false;
  let showProviders = false;
  let showModels = false;
  let debugLog: string | undefined;
  let traceContent = false;
  let permissionMode: CliArgs["permissionMode"] = "default";
  const seen = new Set<string>();

  const mark = (flag: string): void => {
    if (seen.has(flag)) throw new Error(`${flag} 不能重复指定`);
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
      case "--demo":
        mark(arg);
        demo = true;
        break;
      case "--auto":
        mark(arg);
        if (permissionMode !== "default") throw new Error("--auto 与 --accept-edits 不能同时使用");
        permissionMode = "auto";
        break;
      case "--accept-edits":
        mark(arg);
        if (permissionMode !== "default") throw new Error("--auto 与 --accept-edits 不能同时使用");
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
        throw new Error(`未知参数: ${arg}\n使用 --help 查看可用参数。`);
    }
  }

  if (demo && seen.has("--model")) throw new Error("--demo 与 --model 不能同时使用");
  if (demo) model = "debug/demo";

  return {
    model,
    modelExplicit: seen.has("--model"),
    cwd,
    ...(resume ? { resume } : {}),
    daemon,
    permissionMode,
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
  };
}

export function helpText(): string {
  return `anicode ${CLI_VERSION}\n\n` +
    `用法: anicode [选项]\n\n` +
    `  --demo                    使用零 Key 的确定性调试模型\n` +
    `  --model <provider/model>  选择模型（不指定则自动挑已配置凭证的 provider，都没有则用零 Key 的 debug/demo）\n` +
    `  --cwd <dir>               Agent 工作目录\n` +
    `  --sessions <dir>          本地会话目录\n` +
    `  --resume <id>             恢复已有会话\n` +
    `  --auto                    自动允许编辑与命令\n` +
    `  --accept-edits            自动允许编辑，命令仍询问\n` +
    `  --daemon [socket]         连接共享守护进程\n` +
    `  --debug-log [file]        写入 JSONL 调试日志（不污染终端）\n` +
    `  --trace-content           调试日志包含提示/工具内容（可能敏感）\n` +
    `  --list-providers          列出可用 provider\n` +
    `  --list-models             列出内置模型目录（含免费/开源模型）\n` +
    `  -h, --help                显示帮助\n` +
    `  -v, --version             显示版本\n\n` +
    `本地零配置调试: npm run dev:tui`;
}

/** daemon 的权限策略属于守护进程内的 SessionManager，客户端连接不能静默覆盖。 */
export function validateArgs(args: CliArgs): void {
  if (args.traceContent && !args.debugLog) {
    throw new Error("--trace-content 必须与 --debug-log 一起使用");
  }
  if (args.daemon && args.sessionsExplicit) {
    throw new Error("--sessions 不能用于 --daemon 客户端：会话目录由 daemon 管理");
  }
  if (args.daemon && args.permissionMode !== "default") {
    const flag = args.permissionMode === "auto" ? "--auto" : "--accept-edits";
    throw new Error(
      `${flag} 不能用于 --daemon 客户端：权限策略由 daemon 进程统一决定。` +
        `请在启动 anicode-daemon 时传入 ${flag}；已运行 daemon 的策略不会被当前连接修改。`,
    );
  }
}

/**
 * 未显式指定模型时的默认：优先挑一个「已配置凭证」的云端 provider，
 * 都没有就回退零网络的 debug/demo —— 于是 `anicode`（无 key、无参数）能像 opencode
 * 一样直接进 TUI，再用 /model 选免费/本地模型或配置密钥。绝不因缺 ANTHROPIC_API_KEY 而退出。
 */
// 偏好开源 DeepSeek 优先，再退到其它已配置的云端；本地 Ollama 由 detectLocalModel 单独探测。
const DEFAULT_MODEL_PREFERENCES = [
  "opencode/big-pickle", // OpenCode Zen 免费（需 OPENCODE_API_KEY）
  "deepseek/deepseek-chat", // 开源，DeepSeek 官方直连
  "openrouter/deepseek/deepseek-r1:free", // 开源，OpenRouter 免费额度
  "groq/deepseek-r1-distill-llama-70b", // 开源，Groq 免费档
  "openrouter/meta-llama/llama-3.3-70b-instruct:free", // 开源
  "anthropic/claude-opus-4-8",
  "openai/gpt-5",
  "gemini/gemini-2.5-pro",
  "xai/grok-3",
];

export function resolveDefaultModel(): string {
  for (const spec of DEFAULT_MODEL_PREFERENCES) {
    try {
      const d = diagnoseProvider(spec);
      // 只在凭证已就绪时选云端；本地 provider（ollama 等）无法确认在跑，改由 detectLocalModel 探测。
      if (d.requiresApiKey && d.hasCredentials) return spec;
    } catch {
      /* 未知 spec，跳过 */
    }
  }
  return "debug/demo";
}

/**
 * 探测本地 Ollama：在跑就返回一个可用模型 spec（优先 deepseek），否则 null。
 * 这样 `anicode`（无 Key）在装了 Ollama 且拉过 deepseek-r1 时，默认就是真正免费开源的 DeepSeek。
 * 失败/超时/未运行一律静默返回 null（回退云端偏好或 debug/demo）。
 */
export async function detectLocalModel(
  fetchImpl: typeof fetch = fetch,
  baseUrl = process.env["OLLAMA_BASE_URL"] || "http://127.0.0.1:11434/v1",
): Promise<string | null> {
  const host = baseUrl.replace(/\/v1\/?$/, "");
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 400);
    let res: Response;
    try {
      res = await fetchImpl(`${host}/api/tags`, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = (await res.json()) as { models?: { name?: string }[] };
    const names = (data.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
    if (names.length === 0) return null;
    const deepseek = names.find((n) => /deepseek/i.test(n));
    return `ollama/${deepseek ?? names[0]}`;
  } catch {
    return null;
  }
}

/** 本地交互入口要求云端凭证已就绪；core registry 本身仍保持可离线解析。 */
export function assertProviderConfigured(model: string): void {
  const diagnostics = diagnoseProvider(model);
  if (diagnostics.requiresApiKey && !diagnostics.hasCredentials) {
    throw new Error(
      `${diagnostics.warnings.join("；")}。` +
        `也可以用 --demo（或根目录 npm run dev:tui）进行零 Key 调试。`,
    );
  }
}

export function resolveConfiguredProvider(model: string) {
  assertProviderConfigured(model);
  return createProvider(model);
}

export async function buildHost(args: CliArgs): Promise<SessionHost> {
  if (args.daemon) {
    return DaemonClient.connect(args.socket);
  }
  const manager = new SessionManager({
    store: new SessionStore(args.sessionsDir),
    resolveProvider: resolveConfiguredProvider,
    compaction: true,
    permission: { mode: args.permissionMode },
    skills: true,
    subagents: true,
    smallModel: true, // 摘要等杂活自动走便宜模型
  });
  return new LocalSessionHost(manager);
}

/** --resume 只选定会话；真正的 open/订阅由 App 统一执行一次。 */
export async function selectSessionId(
  host: Pick<SessionHost, "createSession">,
  args: CliArgs,
): Promise<string> {
  if (args.resume) return args.resume;
  return (await host.createSession({ cwd: args.cwd, model: args.model })).id;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
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

  // 未显式指定模型时挑默认：本地 Ollama（优先 DeepSeek，真正零 Key 免费开源）→
  // 已配置凭证的云端（DeepSeek 优先）→ 零网络 debug/demo。绝不因缺 ANTHROPIC_API_KEY 报错退出。
  if (!args.modelExplicit && !args.demo) {
    args.model = (await detectLocalModel()) ?? resolveDefaultModel();
  }

  // 校验 provider（本地模式下尽早报错）。仅当用户显式选了缺 key 的模型才会抛错。
  if (!args.daemon && !args.resume) {
    try {
      // 这里只做无副作用诊断；真正创建 provider 由 createSession 唯一执行。
      assertProviderConfigured(args.model);
    } catch (err) {
      throw new Error(`模型配置无效: ${String((err as Error).message)}`);
    }
  }

  let host: SessionHost | undefined;
  try {
    const baseHost = await buildHost(args).catch((err) => {
      throw new Error(`无法建立会话宿主: ${(err as Error).message}`);
    });
    host = baseHost;
    if (args.debugLog) {
      const logger = new DebugLogger(args.debugLog, args.traceContent);
      logger.log("cli.start", {
        model: args.model,
        cwd: args.cwd,
        daemon: args.daemon,
        permissionMode: args.permissionMode,
      });
      host = withDebugLogging(baseHost, logger);
      console.error(`anicode 调试日志: ${logger.file}`);
    }
    // 选定会话：--resume 用已有 ID，否则新建。订阅只由 App 负责。
    const sessionId = await selectSessionId(host, args);
    const instance = render(
      <App
        host={host}
        cwd={args.cwd}
        model={args.model}
        sessionId={sessionId}
        providers={listProviderDetails()}
        catalog={listModelCatalog()}
        inspectProviderCredentials={!args.daemon}
        version={CLI_VERSION}
      />,
    );
    await instance.waitUntilExit();
  } finally {
    host?.dispose();
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
