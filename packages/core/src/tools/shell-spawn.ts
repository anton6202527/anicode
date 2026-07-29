/**
 * Shell 启动参数构造 —— 前台 bash 与后台 shell 的共用底座。
 *
 * 单独成模块是为了打破 bash.ts ↔ shells.ts 的循环依赖，同时把「命令怎么被沙箱包起来」
 * 这条安全关键路径收敛到一处：后台执行绝不能成为绕过沙箱的旁路。
 */

import { realpathSync } from "node:fs";
import * as path from "node:path";
import {
  resolveSandboxPolicy,
  resolveSandboxNetwork,
  wrapWithSandbox,
  sandboxBinaryAvailable,
  type SandboxSpec,
} from "./sandbox.js";
import type { ToolContext } from "./tool.js";

/**
 * 构造实际 spawn 的 file/args：按策略包一层 OS 沙箱（macOS Seatbelt / Linux bubblewrap），
 * 写入限工作区+临时目录、.git/.anicode 只读、网络按 resolveSandboxNetwork 决定；
 * 缺沙箱二进制时回退裸跑并一次性告警。
 */
export function buildShellSpawn(
  command: string,
  sandbox: ToolContext["sandbox"],
  cwd: string,
): { file: string; args: string[] } {
  const policy = resolveSandboxPolicy(sandbox);
  // 用真实路径（解 symlink）构 profile：macOS 的 /tmp→/private/tmp、/var→/private/var 等
  // 前缀会让「字面 subpath」匹配不到内核已规范化的实际访问路径，导致 .git deny 形同虚设。
  const canonicalCwd = realpathOr(cwd);
  const spec: SandboxSpec = {
    policy,
    cwd: canonicalCwd,
    network: resolveSandboxNetwork(),
    ...(policy === "workspace-write"
      ? {
          readOnlySubpaths: [path.join(canonicalCwd, ".git"), path.join(canonicalCwd, ".anicode")],
        }
      : {}),
  };
  const wrapped = wrapWithSandbox(command, spec);
  if (wrapped) {
    if (sandboxBinaryAvailable(wrapped.file)) return { file: wrapped.file, args: wrapped.args };
    warnSandboxUnavailable(wrapped.file, policy);
  }
  return { file: "/bin/bash", args: ["-c", command] };
}

/** 解析真实路径；路径不存在等异常时回退原值（沙箱仍能用字面路径工作）。 */
function realpathOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** 缺沙箱二进制时的一次性告警（按二进制去重），避免每条命令刷屏。 */
const sandboxWarned = new Set<string>();
function warnSandboxUnavailable(bin: string, policy: string): void {
  if (sandboxWarned.has(bin)) return;
  sandboxWarned.add(bin);
  const hint =
    bin === "bwrap"
      ? "未检测到 bubblewrap（bwrap），命令将不受沙箱约束。安装后可启用文件系统隔离：apt install bubblewrap / dnf install bubblewrap。"
      : `未检测到沙箱程序 ${bin}，命令将不受沙箱约束。`;
  process.stderr.write(`[anicode] 沙箱策略=${policy} 但${hint}\n`);
}

/** 避免 BASH_ENV / 导出的 shell function 在命令正文前隐式执行。前后台共用。 */
export function sanitizedShellEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "BASH_ENV" || key === "ENV" || key.startsWith("BASH_FUNC_")) continue;
    // Provider/MCP/cloud 凭证属于宿主控制面，绝不能因为 agent 启动一个 shell 就
    // 批量继承。确需某个密钥时只能由 CredentialBroker 的短租约定向注入。
    if (isSensitiveEnvName(key)) continue;
    env[key] = value;
  }
  return env;
}

export function isSensitiveEnvName(name: string): boolean {
  const key = name.toUpperCase();
  return (
    /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_?KEY)(?:_|$)/.test(key) ||
    (/^(?:AWS|AZURE|GCP|GOOGLE|ANTHROPIC|OPENAI|DEEPSEEK|GEMINI|GITHUB|GH|NPM|PYPI|TAVILY|BRAVE)_/.test(
      key,
    ) &&
      /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/.test(key))
  );
}
