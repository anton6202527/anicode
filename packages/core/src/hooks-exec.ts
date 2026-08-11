/**
 * 命令式 hooks —— 把「配置里的一条 shell 命令」适配成 HookRegistration
 * （对齐 Claude Code settings hooks / Codex hooks.json 的用户侧形态）。
 *
 * 协议（对齐 Claude Code 的约定，方便用户迁移已有 hook 脚本）：
 *   - HookPayload 以 JSON 写入命令的 stdin（含 hook_event_name 别名字段）
 *   - 退出码 0：stdout 若是 JSON 对象则解析为 HookResult
 *     （{decision?, reason?, updatedInput?, additionalContext?}）；
 *     非 JSON 的非空 stdout 视为 additionalContext
 *   - 退出码 2：block，stderr（缺省 stdout）作为 reason
 *   - 其他退出码 / 超时：视为无操作；隔离或进程树清理失败则 fail-close
 *   - 超时默认 60s，并等待整棵进程树退出
 *
 * 安全边界：命令来自用户自己的配置文件（等同 shell 配置的信任级别），
 * 不经过交互式权限确认；production runtime 仍强制 sandbox 与事务化提交。
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  HookExecutionBoundaryError,
  type HookEventName,
  type HookPayload,
  type HookRegistration,
  type HookResult,
} from "./hooks.js";
import {
  RuntimeTerminationError,
  terminateProcessTree,
  type ExecutionRuntime,
} from "./runtime/isolated-runtime.js";
import { sanitizedShellEnv } from "./tools/shell-spawn.js";

export interface CommandHookConfig {
  event: HookEventName;
  /** 工具名/子 agent 类型匹配（* glob）；缺省匹配全部。 */
  matcher?: string;
  /** 经平台命令解释器（POSIX sh / Windows cmd）执行的命令行。 */
  command: string;
  /** 超时毫秒；默认 60000。 */
  timeoutMs?: number;
}

const HOOK_EVENTS: readonly HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStart",
  "SubagentStop",
  "Notification",
  "Stop",
];
const MAX_HOOK_OUTPUT_CHARS = 1024 * 1024;

export interface CommandHookOptions {
  /** Production hosts pass the same fail-closed OS isolation boundary used by shell/MCP. */
  executionRuntime?: ExecutionRuntime;
}

export function isHookEventName(v: unknown): v is HookEventName {
  return typeof v === "string" && (HOOK_EVENTS as readonly string[]).includes(v);
}

function interpretCommandHook(code: number | null, stdout: string, stderr = ""): HookResult | void {
  if (code === 2) {
    return { decision: "block", reason: (stderr || stdout).trim() || "被命令 hook 拦截" };
  }
  if (code !== 0) return undefined;
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: HookResult = {};
      if (parsed.decision === "block" || parsed.decision === "allow") {
        out.decision = parsed.decision;
      }
      if (typeof parsed.reason === "string") out.reason = parsed.reason;
      if (
        parsed.updatedInput &&
        typeof parsed.updatedInput === "object" &&
        !Array.isArray(parsed.updatedInput)
      ) {
        out.updatedInput = parsed.updatedInput as Record<string, unknown>;
      }
      if (typeof parsed.additionalContext === "string") {
        out.additionalContext = parsed.additionalContext;
      }
      return out;
    }
  } catch {
    // Non-JSON output is context for the next model turn.
  }
  return { additionalContext: text };
}

/** 执行一条命令 hook：stdin 喂 payload JSON，按退出码/输出解释结果。 */
async function runCommandHook(
  cfg: CommandHookConfig,
  payload: HookPayload,
  options: CommandHookOptions,
): Promise<HookResult | void> {
  const requestedTimeout = cfg.timeoutMs ?? 60_000;
  const timeoutMs =
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(Math.max(100, requestedTimeout), 300_000)
      : 60_000;
  if (payload.signal?.aborted) return undefined;
  const stdin = JSON.stringify({ ...payload, signal: undefined, hook_event_name: payload.event });
  if (options.executionRuntime) {
    try {
      const result = await options.executionRuntime.run({
        command: cfg.command,
        cwd: payload.cwd,
        stdin,
        includeTransactionSummary: false,
        policy: "workspace-write",
        network: false,
        timeoutMs,
        ...(payload.signal ? { signal: payload.signal } : {}),
        env: sanitizedShellEnv(),
      });
      if (payload.signal?.aborted || result.timedOut) return undefined;
      return interpretCommandHook(result.exitCode, result.output);
    } catch (error) {
      // Cancellation is best-effort only after the runtime has proved the workload gone. Never
      // let the caller's already-aborted signal hide an indeterminate external process tree.
      if (error instanceof RuntimeTerminationError) {
        throw new HookExecutionBoundaryError("Command hook termination proof failed", {
          cause: error,
        });
      }
      if (payload.signal?.aborted) return undefined;
      throw new HookExecutionBoundaryError(
        `Command hook isolated execution failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
  return new Promise<HookResult | void>((resolve, reject) => {
    let child;
    try {
      const shell = hostCommandShell(cfg.command);
      child = spawn(shell.file, shell.args, {
        cwd: payload.cwd,
        env: sanitizedShellEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        // Match Node's own cmd.exe shell boundary: the /s outer-quote contract must reach cmd
        // verbatim instead of being escaped a second time by libuv's generic argv serializer.
        windowsVerbatimArguments: process.platform === "win32",
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let termination: Promise<void> | undefined;
    const finish = (r: HookResult | void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        payload.signal?.removeEventListener("abort", onAbort);
        resolve(r);
      }
    };
    const failBoundary = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      payload.signal?.removeEventListener("abort", onAbort);
      reject(
        new HookExecutionBoundaryError(
          `Command hook process tree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    };
    const terminate = () => {
      termination ??= terminateProcessTree(child);
      void termination.catch(() => undefined);
      return termination;
    };
    const timer = setTimeout(() => {
      void terminate().then(() => finish(undefined), failBoundary); // 超时按无操作
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => void terminate().then(() => finish(undefined), failBoundary);
    payload.signal?.addEventListener("abort", onAbort, { once: true });
    // Abort can race the pre-spawn check and listener installation; close that window explicitly.
    if (payload.signal?.aborted) onAbort();
    const capture = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_HOOK_OUTPUT_CHARS) return current;
      return current + chunk.toString().slice(0, MAX_HOOK_OUTPUT_CHARS - current.length);
    };
    child.stdout?.on("data", (b: Buffer) => (stdout = capture(stdout, b)));
    child.stderr?.on("data", (b: Buffer) => (stderr = capture(stderr, b)));
    child.stdin?.on("error", () => {
      // Hook may exit before consuming stdin; close/exit still carries the result.
    });
    child.on("error", (error) => {
      if (!child.pid) {
        finish(undefined);
        return;
      }
      void terminate().then(
        () => finish(undefined),
        (cleanupError) => failBoundary(new AggregateError([error, cleanupError])),
      );
    });
    child.on("close", (code) => {
      void (async () => {
        if (!termination && process.platform !== "win32") {
          termination = terminateProcessTree(child);
        }
        await termination;
        finish(interpretCommandHook(code, stdout, stderr));
      })().catch(failBoundary);
    });
    // stdin 喂 payload；附 hook_event_name 别名字段方便复用 Claude Code 脚本。
    try {
      child.stdin?.write(stdin);
      child.stdin?.end();
    } catch {
      /* 进程可能已退出 */
    }
  });
}

function hostCommandShell(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    // /d disables registry AutoRun commands. With /s, cmd strips the first and last quote around
    // the command string; provide that outer pair explicitly so an already-quoted executable path
    // keeps its own quotes instead of being split at spaces.
    return {
      file: windowsCommandInterpreter(process.env),
      args: windowsCommandArguments(command),
    };
  }
  return { file: "/bin/sh", args: ["-c", command] };
}

/** @internal Exported only so the Windows cmd quoting boundary has a platform-neutral unit test. */
export function windowsCommandArguments(command: string): string[] {
  return ["/d", "/s", "/c", `"${command}"`];
}

function windowsCommandInterpreter(env: NodeJS.ProcessEnv): string {
  const configured = env["ComSpec"]?.trim();
  if (
    configured &&
    path.win32.isAbsolute(configured) &&
    path.win32.basename(configured).toLowerCase() === "cmd.exe"
  ) {
    return configured;
  }
  const systemRoot = env["SystemRoot"]?.trim() || env["windir"]?.trim();
  if (systemRoot && path.win32.isAbsolute(systemRoot)) {
    return path.win32.join(systemRoot, "System32", "cmd.exe");
  }
  // Avoid a PATH lookup even in a malformed inherited environment.
  return "C:\\Windows\\System32\\cmd.exe";
}

/** 把一条配置转成 HookRegistration。 */
export function commandHook(
  cfg: CommandHookConfig,
  options: CommandHookOptions = {},
): HookRegistration {
  return {
    event: cfg.event,
    mutatesWorkspace: true,
    cancellation: "close-confirmed",
    ...(cfg.matcher !== undefined ? { matcher: cfg.matcher } : {}),
    handler: (payload) => runCommandHook(cfg, payload, options),
  };
}

/** 批量转换；无效条目（未知事件/空命令）静默剔除，不让一处笔误弄垮启动。 */
export function commandHooksFromConfig(
  entries: unknown,
  options: CommandHookOptions = {},
): HookRegistration[] {
  if (!Array.isArray(entries)) return [];
  const out: HookRegistration[] = [];
  for (const e of entries) {
    const rec = e as Partial<CommandHookConfig> | null;
    if (!rec || !isHookEventName(rec.event)) continue;
    if (typeof rec.command !== "string" || !rec.command.trim()) continue;
    out.push(
      commandHook(
        {
          event: rec.event,
          command: rec.command,
          ...(typeof rec.matcher === "string" ? { matcher: rec.matcher } : {}),
          ...(typeof rec.timeoutMs === "number" && rec.timeoutMs > 0
            ? { timeoutMs: rec.timeoutMs }
            : {}),
        },
        options,
      ),
    );
  }
  return out;
}
