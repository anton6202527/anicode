/**
 * OS 级命令沙箱 —— macOS Seatbelt（sandbox-exec）+ Linux bubblewrap（bwrap）。
 *
 * 与权限系统正交、纵深防御：权限门管「模型被允许发起什么」，沙箱管「进程真正能碰什么」——
 * 即使 prompt 注入骗过模型，进程也写不出工作区、连不出网。对齐 Codex 的
 * SandboxPolicy（read-only / workspace-write / full）与「可写根内 .git/.anicode 仍只读」。
 *
 * 策略：
 *   - macOS：`(allow default)` 打底，再收紧写入（仅工作区+临时目录+/dev）与网络；生成 SBPL
 *     交给 `sandbox-exec -p`。用 last-match-wins 让 readOnlySubpaths 的 deny 压过工作区 allow。
 *   - Linux：bwrap 建新 mount namespace，`--ro-bind / /` 整盘只读，再把工作区/临时目录
 *     rebind 成可写、把 .git 等 rebind 回只读；`--unshare-net` 断网。
 *   - 其它平台：返回 null（调用方裸跑）。
 *
 * 纯函数（buildSeatbeltProfile / buildBubblewrapArgs / wrapWithSandbox）不做任何 I/O，
 * platform 可注入，便于离线测试；运行期的「沙箱二进制是否可用」检测在 sandboxBinaryAvailable。
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";

export type SandboxPolicy = "none" | "read-only" | "workspace-write";

export interface SandboxSpec {
  policy: SandboxPolicy;
  /** 工作区根（workspace-write 下唯一默认可写的项目目录）。 */
  cwd: string;
  /** 追加可写根（如项目外的构建目录）。 */
  writableRoots?: readonly string[];
  /**
   * 可写根内部仍保持只读的子路径（对齐 Codex 的 read_only_subpaths）。
   * 典型：`<cwd>/.git`、`<cwd>/.anicode` —— 防 agent 篡改 git 历史/hooks 或会话数据。
   */
  readOnlySubpaths?: readonly string[];
  /** 是否允许出网；缺省由调用方决定（见 resolveSandboxNetwork）。 */
  network?: boolean;
}

export interface WrappedCommand {
  file: string;
  args: string[];
}

/** 解析生效策略：显式（非 none）优先，其次环境变量 AGENTX_BASH_SANDBOX，默认 workspace-write。 */
export function resolveSandboxPolicy(
  explicit: SandboxPolicy | undefined,
  env: NodeJS.ProcessEnv = process.env,
): SandboxPolicy {
  if (explicit && explicit !== "none") return explicit;
  const fromEnv = (env["AGENTX_BASH_SANDBOX"] ?? "").trim();
  if (fromEnv === "read-only" || fromEnv === "workspace-write" || fromEnv === "none")
    return fromEnv;
  // 显式 none（且无 env 覆盖）表示调用方主动关闭；否则默认收紧到 workspace-write。
  if (explicit === "none") return "none";
  return "workspace-write";
}

/**
 * 沙箱是否放行出网。默认放行 —— 若默认断网，`npm/pip/cargo install`、`git fetch` 等会被
 * 静默打断，用户多半干脆关掉整个沙箱（更糟）。想要更强隔离（防 exfil）时用
 * AGENTX_SANDBOX_NETWORK=off 一键收紧。
 */
export function resolveSandboxNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["AGENTX_SANDBOX_NETWORK"] ?? "").trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "deny" || v === "none") return false;
  return true;
}

/**
 * 若当前平台/策略支持沙箱，返回把命令包起来的 argv；否则返回 null（裸跑）。
 * 纯函数：不检测二进制是否安装（那是 sandboxBinaryAvailable 的职责），platform 可注入。
 */
export function wrapWithSandbox(
  command: string,
  spec: SandboxSpec,
  platform: NodeJS.Platform = process.platform,
): WrappedCommand | null {
  if (spec.policy === "none") return null;
  if (platform === "darwin") {
    return {
      file: "sandbox-exec",
      args: ["-p", buildSeatbeltProfile(spec), "/bin/bash", "-c", command],
    };
  }
  if (platform === "linux") {
    return { file: "bwrap", args: [...buildBubblewrapArgs(spec), "/bin/bash", "-c", command] };
  }
  return null; // Windows 等暂不支持
}

/** 生成 Seatbelt SBPL profile 文本。 */
export function buildSeatbeltProfile(spec: SandboxSpec): string {
  const lines = ["(version 1)", "(allow default)", "(deny file-write*)"];
  const roots =
    spec.policy === "workspace-write"
      ? dedupe([
          spec.cwd,
          ...(spec.writableRoots ?? []),
          os.tmpdir(),
          "/tmp",
          "/private/tmp",
          "/private/var/folders",
          "/dev",
        ])
      : ["/dev"]; // read-only：仅放行 /dev（/dev/null、/dev/stdout 等）
  for (const root of roots) lines.push(`(allow file-write* (subpath ${sbplString(root)}))`);
  // 可写根内的只读子路径：deny 放在 allow 之后，靠 SBPL 的 last-match-wins 压过工作区放行。
  if (spec.policy === "workspace-write") {
    for (const sub of spec.readOnlySubpaths ?? []) {
      lines.push(`(deny file-write* (subpath ${sbplString(sub)}))`);
    }
  }
  if (!spec.network) lines.push("(deny network*)");
  return lines.join("\n") + "\n";
}

/**
 * 生成 bubblewrap 参数（不含 bwrap 自身与末尾命令）。
 *
 * `--*-try` 变体在源路径缺失时静默跳过（保持纯函数，不做 fs 存在性检查）：
 * 临时目录/可写根/只读子路径可能不存在，用 `-try` 避免 bwrap 因缺路径而整体失败。
 */
export function buildBubblewrapArgs(spec: SandboxSpec): string[] {
  const args: string[] = [
    "--die-with-parent", // 父进程退出即清理沙箱
    "--ro-bind",
    "/",
    "/", // 整盘只读打底
    "--proc",
    "/proc",
    "--dev",
    "/dev",
  ];
  if (spec.policy === "workspace-write") {
    // 临时目录可写（构建/测试常写 tmp）。
    for (const tmp of dedupe([os.tmpdir(), "/tmp", "/var/tmp"])) {
      args.push("--bind-try", tmp, tmp);
    }
    // 工作区可写（必须存在，用 --bind 让缺失时尽早报错）。
    args.push("--bind", spec.cwd, spec.cwd);
    for (const root of dedupe([...(spec.writableRoots ?? [])])) {
      args.push("--bind-try", root, root);
    }
    // 可写根内的只读子路径：rebind 回只读（later-wins）。
    for (const sub of dedupe([...(spec.readOnlySubpaths ?? [])])) {
      args.push("--ro-bind-try", sub, sub);
    }
    args.push("--chdir", spec.cwd);
  } else {
    // read-only：给一个临时的、进程私有的 /tmp 作 scratch，不落到真实文件系统。
    args.push("--tmpfs", "/tmp", "--chdir", spec.cwd);
  }
  if (!spec.network) args.push("--unshare-net");
  return args;
}

/**
 * 运行期检测沙箱二进制是否可用；不可用时调用方应回退裸跑并告警一次。
 * 默认 env 下结果记忆化（PATH 稳定）；传入自定义 env 时不走缓存，便于测试。
 */
const binaryCache = new Map<string, boolean>();
export function sandboxBinaryAvailable(bin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const useCache = env === process.env;
  if (useCache) {
    const cached = binaryCache.get(bin);
    if (cached !== undefined) return cached;
  }
  const dirs = (env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  // sandbox-exec 常驻 /usr/bin，即便 PATH 未含也存在。
  const extra = bin === "sandbox-exec" ? ["/usr/bin"] : [];
  const found = [...dirs, ...extra].some((d) => {
    try {
      fs.accessSync(path.join(d, bin), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (useCache) binaryCache.set(bin, found);
  return found;
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items.filter((s) => s && s.length > 0))];
}

/** SBPL 字符串字面量转义。 */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
