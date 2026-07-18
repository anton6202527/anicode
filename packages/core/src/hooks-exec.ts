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
 *   - 其他退出码 / 启动失败 / 超时：视为无操作（hook 是增强，不能弄垮 loop）
 *   - 超时默认 60s，到点 SIGKILL
 *
 * 安全边界：命令来自用户自己的配置文件（等同 shell 配置的信任级别），
 * 不经过权限引擎——hook 本身就是用户加装的策略引擎。
 */

import { spawn } from "node:child_process";
import type { HookEventName, HookPayload, HookRegistration, HookResult } from "./hooks.js";

export interface CommandHookConfig {
  event: HookEventName;
  /** 工具名/子 agent 类型匹配（* glob）；缺省匹配全部。 */
  matcher?: string;
  /** 经 /bin/sh -c 执行的命令行。 */
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
  "Stop",
];

export function isHookEventName(v: unknown): v is HookEventName {
  return typeof v === "string" && (HOOK_EVENTS as readonly string[]).includes(v);
}

/** 执行一条命令 hook：stdin 喂 payload JSON，按退出码/输出解释结果。 */
async function runCommandHook(
  cfg: CommandHookConfig,
  payload: HookPayload,
): Promise<HookResult | void> {
  const timeoutMs = cfg.timeoutMs ?? 60_000;
  return new Promise<HookResult | void>((resolve) => {
    let child;
    try {
      child = spawn("/bin/sh", ["-c", cfg.command], {
        cwd: payload.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(undefined);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: HookResult | void) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已退出 */
      }
      finish(undefined); // 超时按无操作
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", (b: Buffer) => (stdout += b.toString()));
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code === 2) {
        // Claude Code 约定：exit 2 = block，stderr 为理由
        finish({ decision: "block", reason: (stderr || stdout).trim() || "被命令 hook 拦截" });
        return;
      }
      if (code !== 0) {
        finish(undefined);
        return;
      }
      const text = stdout.trim();
      if (!text) {
        finish(undefined);
        return;
      }
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const out: HookResult = {};
          if (parsed.decision === "block" || parsed.decision === "allow")
            out.decision = parsed.decision;
          if (typeof parsed.reason === "string") out.reason = parsed.reason;
          if (
            parsed.updatedInput &&
            typeof parsed.updatedInput === "object" &&
            !Array.isArray(parsed.updatedInput)
          )
            out.updatedInput = parsed.updatedInput as Record<string, unknown>;
          if (typeof parsed.additionalContext === "string")
            out.additionalContext = parsed.additionalContext;
          finish(out);
          return;
        }
      } catch {
        /* 非 JSON：整段 stdout 作为注入上下文 */
      }
      finish({ additionalContext: text });
    });
    // stdin 喂 payload；附 hook_event_name 别名字段方便复用 Claude Code 脚本。
    try {
      child.stdin?.write(JSON.stringify({ ...payload, hook_event_name: payload.event }));
      child.stdin?.end();
    } catch {
      /* 进程可能已退出 */
    }
  });
}

/** 把一条配置转成 HookRegistration。 */
export function commandHook(cfg: CommandHookConfig): HookRegistration {
  return {
    event: cfg.event,
    ...(cfg.matcher !== undefined ? { matcher: cfg.matcher } : {}),
    handler: (payload) => runCommandHook(cfg, payload),
  };
}

/** 批量转换；无效条目（未知事件/空命令）静默剔除，不让一处笔误弄垮启动。 */
export function commandHooksFromConfig(entries: unknown): HookRegistration[] {
  if (!Array.isArray(entries)) return [];
  const out: HookRegistration[] = [];
  for (const e of entries) {
    const rec = e as Partial<CommandHookConfig> | null;
    if (!rec || !isHookEventName(rec.event)) continue;
    if (typeof rec.command !== "string" || !rec.command.trim()) continue;
    out.push(
      commandHook({
        event: rec.event,
        command: rec.command,
        ...(typeof rec.matcher === "string" ? { matcher: rec.matcher } : {}),
        ...(typeof rec.timeoutMs === "number" && rec.timeoutMs > 0
          ? { timeoutMs: rec.timeoutMs }
          : {}),
      }),
    );
  }
  return out;
}
