#!/usr/bin/env tsx
/**
 * 守护进程启动器 —— 起一个监听 unix socket 的 DaemonServer（内含 SessionManager）。
 * App / 多个 CLI 前端连它即可共享会话。
 *
 *   tsx src/daemon/launch.ts [--socket PATH] [--sessions DIR]
 */

import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { t } from "../i18n.js";
import { promises as fs, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DaemonServer } from "./server.js";
import { SessionManager } from "../session-manager.js";
import { SessionStore } from "../session.js";
import { createProvider, diagnoseProvider } from "../provider/registry.js";

export function defaultSocketPath(): string {
  return path.join(os.tmpdir(), "anicode.sock");
}

const DAEMON_VERSION = "0.0.1";

export interface DaemonArgs {
  socketPath: string;
  sessionsDir: string;
  permissionMode: "default" | "acceptEdits" | "auto";
  help: boolean;
  version: boolean;
}

export function daemonHelpText(): string {
  return (
    `anicode-daemon ${DAEMON_VERSION}\n\n` +
    `用法: anicode-daemon [选项]\n\n` +
    `  --socket <path>       Unix socket 路径（默认 ${defaultSocketPath()}）\n` +
    `  --sessions <dir>      会话目录（默认 ~/.anicode/sessions）\n` +
    `  --auto                自动允许工具操作\n` +
    `  --accept-edits        自动允许文件编辑，命令仍询问\n` +
    `  -h, --help            显示帮助\n` +
    `  -v, --version         显示版本`
  );
}

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  let socketPath = defaultSocketPath();
  let sessionsDir = path.join(os.homedir(), ".anicode", "sessions");
  let permissionMode: DaemonArgs["permissionMode"] = "default";
  let help = false;
  let version = false;
  const seen = new Set<string>();
  const mark = (flag: string) => {
    if (seen.has(flag))
      throw new Error(t(`${flag} cannot be specified more than once`, `${flag} 不能重复指定`));
    seen.add(flag);
  };
  const valueAfter = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-"))
      throw new Error(t(`${flag} requires a value`, `${flag} 需要一个值`));
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--socket":
        mark(arg);
        socketPath = path.resolve(valueAfter(i, arg));
        i++;
        break;
      case "--sessions":
        mark(arg);
        sessionsDir = path.resolve(valueAfter(i, arg));
        i++;
        break;
      case "--auto":
      case "--accept-edits":
        mark(arg);
        if (permissionMode !== "default") {
          throw new Error(
            t(
              "--auto and --accept-edits cannot be used together",
              "--auto 与 --accept-edits 不能同时使用",
            ),
          );
        }
        permissionMode = arg === "--auto" ? "auto" : "acceptEdits";
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
            `Unknown argument: ${arg}\nUse --help to see available arguments.`,
            `未知参数: ${arg}\n使用 --help 查看可用参数。`,
          ),
        );
    }
  }
  return { socketPath, sessionsDir, permissionMode, help, version };
}

function resolveConfiguredProvider(model: string) {
  const diagnostics = diagnoseProvider(model);
  if (diagnostics.requiresApiKey && !diagnostics.hasCredentials) {
    throw new Error(
      t(
        `${diagnostics.warnings.join("; ")} (configure it in the daemon process environment, or use debug/demo)`,
        `${diagnostics.warnings.join("；")}（请在 daemon 进程环境中配置，或使用 debug/demo）`,
      ),
    );
  }
  return createProvider(model);
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseDaemonArgs(argv);
  if (args.help) {
    console.log(daemonHelpText());
    return;
  }
  if (args.version) {
    console.log(DAEMON_VERSION);
    return;
  }

  await removeStaleSocket(args.socketPath);

  const manager = new SessionManager({
    store: new SessionStore(args.sessionsDir),
    resolveProvider: resolveConfiguredProvider,
    compaction: true,
    permission: { mode: args.permissionMode },
    skills: true,
    subagents: true,
  });
  const server = new DaemonServer({ manager });
  await server.listen(args.socketPath);
  console.log(
    `anicode daemon 监听于 ${args.socketPath}` +
      `（会话目录 ${args.sessionsDir}，权限 ${args.permissionMode}）`,
  );

  const shutdown = async () => {
    await server.close();
    await fs.rm(args.socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function removeStaleSocket(socketPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(socketPath);
    if (!stat.isSocket()) {
      throw new Error(
        t(
          `Refusing to delete non-socket path: ${socketPath}`,
          `拒绝删除非 socket 路径: ${socketPath}`,
        ),
      );
    }
    if (await socketIsActive(socketPath)) {
      throw new Error(
        t(`daemon is already listening: ${socketPath}`, `daemon 已在监听: ${socketPath}`),
      );
    }
    await fs.rm(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function socketIsActive(socketPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(
        new Error(
          t(
            `Cannot determine whether socket is stale: ${socketPath}`,
            `无法确认 socket 是否陈旧: ${socketPath}`,
          ),
        ),
      );
    }, 500);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeAllListeners();
    };
    socket.once("connect", () => {
      cleanup();
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      socket.destroy();
      if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve(false);
      else reject(error);
    });
  });
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
    console.error(String((err as { stack?: unknown })?.stack ?? err));
    process.exitCode = 1;
  });
}
