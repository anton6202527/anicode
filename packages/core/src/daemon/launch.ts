#!/usr/bin/env tsx
/**
 * 守护进程启动器 —— 起一个监听 unix socket 的 DaemonServer（内含 SessionManager）。
 * App / 多个 CLI 前端连它即可共享会话。
 *
 *   tsx src/daemon/launch.ts [--socket PATH] [--sessions DIR] [--cwd DIR]
 */

import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { t } from "../i18n.js";
import { promises as fs, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DaemonServer } from "./server.js";
import { defaultDaemonSocketPath, isWindowsNamedPipePath } from "./socket-path.js";
import {
  createConfiguredLocalRuntimeStack,
  telemetryForLocalStack,
  type LocalRuntimeStack,
} from "../runtime/local-stack.js";
import { WorkspaceTrustStore } from "../workspace-trust.js";
import { generateDaemonAuthToken, provisionDaemonAuthToken } from "./auth-token.js";
import {
  createProductionSessionManager,
  type ProductionSessionManagerComposition,
} from "../production-session-manager.js";
import type { SessionManagerOptions, WorkspaceTrustSource } from "../session-manager.js";
import type { Telemetry } from "../runtime/telemetry.js";

export function defaultSocketPath(): string {
  return defaultDaemonSocketPath();
}

const DAEMON_VERSION = "0.0.1";

export interface DaemonArgs {
  socketPath: string;
  sessionsDir: string;
  cwd: string;
  permissionMode: "default" | "acceptEdits" | "auto";
  help: boolean;
  version: boolean;
}

export function daemonHelpText(): string {
  return (
    `anicode-daemon ${DAEMON_VERSION}\n\n` +
    `用法: anicode-daemon [选项]\n\n` +
    `  --socket <path>       IPC endpoint 路径（默认 ${defaultSocketPath()}）\n` +
    `  --sessions <dir>      会话目录（默认 ~/.anicode/sessions）\n` +
    `  --cwd <dir>           daemon 绑定的唯一工作区（默认当前目录）\n` +
    `  --auto                自动允许工具操作\n` +
    `  --accept-edits        自动允许文件编辑，命令仍询问\n` +
    `  -h, --help            显示帮助\n` +
    `  -v, --version         显示版本`
  );
}

export function parseDaemonArgs(argv: string[]): DaemonArgs {
  let socketPath = defaultSocketPath();
  let sessionsDir = path.join(os.homedir(), ".anicode", "sessions");
  let cwd = path.resolve(process.cwd());
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
        {
          const value = valueAfter(i, arg);
          socketPath = isWindowsNamedPipePath(value) ? value : path.resolve(value);
        }
        i++;
        break;
      case "--sessions":
        mark(arg);
        sessionsDir = path.resolve(valueAfter(i, arg));
        i++;
        break;
      case "--cwd":
        mark(arg);
        cwd = path.resolve(valueAfter(i, arg));
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
  return { socketPath, sessionsDir, cwd, permissionMode, help, version };
}

export interface DaemonManagerCompositionOptions {
  cwd: string;
  sessionsDir: string;
  permissionMode: DaemonArgs["permissionMode"];
  runtimeStack: LocalRuntimeStack;
  telemetry: Telemetry;
  /** Test/embedding seams; the production launcher uses the authoritative defaults. */
  resolveProvider?: SessionManagerOptions["resolveProvider"];
  workspaceTrust?: WorkspaceTrustSource;
}

/** Daemon uses the exact same production composition contract as TUI, App and VS Code. */
export function createDaemonManagerComposition(
  options: DaemonManagerCompositionOptions,
): ProductionSessionManagerComposition {
  return createProductionSessionManager({
    cwd: options.cwd,
    sessionsDir: options.sessionsDir,
    permissionMode: options.permissionMode,
    runtimeStack: options.runtimeStack,
    telemetry: options.telemetry,
    ...(options.resolveProvider ? { resolveProvider: options.resolveProvider } : {}),
    workspaceTrust: options.workspaceTrust ?? new WorkspaceTrustStore(),
  });
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

  await prepareSocketDirectory(args.socketPath, args.socketPath === defaultSocketPath());
  await removeStaleSocket(args.socketPath);
  const workspaceScope = await fs.realpath(args.cwd);
  if (!(await fs.stat(workspaceScope)).isDirectory()) {
    throw new Error(`Daemon workspace is not a directory: ${args.cwd}`);
  }

  const runtimeStack = await createConfiguredLocalRuntimeStack(path.dirname(args.sessionsDir));
  const telemetry = telemetryForLocalStack(runtimeStack);
  const composition = createDaemonManagerComposition({
    cwd: workspaceScope,
    sessionsDir: args.sessionsDir,
    permissionMode: args.permissionMode,
    runtimeStack,
    telemetry,
  });
  const manager = composition.manager;
  const bearerToken = generateDaemonAuthToken();
  const server = new DaemonServer({
    manager,
    authToken: bearerToken,
    discoverModels: runtimeStack.discoverModels,
  });
  await server.listen(args.socketPath);
  let tokenFile: string;
  try {
    ({ tokenFile } = await provisionDaemonAuthToken({
      socketPath: args.socketPath,
      token: bearerToken,
    }));
  } catch (error) {
    await server.close();
    await composition.dispose().catch(() => undefined);
    await runtimeStack.artifacts.close?.();
    await runtimeStack.networkProxy.close();
    await runtimeStack.database.close();
    if (!isWindowsNamedPipePath(args.socketPath)) await fs.rm(args.socketPath, { force: true });
    throw error;
  }
  console.log(
    `anicode daemon 监听于 ${args.socketPath}` +
      `（工作区 ${workspaceScope}，会话目录 ${args.sessionsDir}，权限 ${args.permissionMode}，` +
      `token ${tokenFile}）`,
  );

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await server.close();
    try {
      await composition.dispose();
      if (telemetry.shutdown) await telemetry.shutdown();
      else await telemetry.forceFlush?.();
    } catch {
      console.error("anicode daemon: OTLP flush failed during shutdown");
    } finally {
      await runtimeStack.artifacts.close?.();
      await runtimeStack.networkProxy.close();
      await runtimeStack.database.close();
      if (!isWindowsNamedPipePath(args.socketPath)) await fs.rm(args.socketPath, { force: true });
      await fs.rm(tokenFile, { force: true });
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export async function removeStaleSocket(socketPath: string): Promise<void> {
  if (isWindowsNamedPipePath(socketPath)) {
    if (await socketIsActive(socketPath)) {
      throw new Error(
        t(`daemon is already listening: ${socketPath}`, `daemon 已在监听: ${socketPath}`),
      );
    }
    return;
  }
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

export async function prepareSocketDirectory(
  socketPath: string,
  hardenExistingDirectory = false,
): Promise<void> {
  if (isWindowsNamedPipePath(socketPath)) return;
  const directory = path.dirname(socketPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Daemon socket parent is not a real directory: ${directory}`);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stat.uid !== uid) {
    throw new Error(`Daemon socket parent is not owned by the current user: ${directory}`);
  }
  if (hardenExistingDirectory) {
    await fs.chmod(directory, 0o700);
    stat = await fs.lstat(directory);
  }
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`Daemon socket parent must have mode 0700: ${directory}`);
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
