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
  /**
   * 宿主机上即使在只读沙箱中也绝不能被模型读取的凭据路径。
   *
   * `--ro-bind / /` 与 Seatbelt 的 `(allow default)` 都会让只读并不等于保密；因此凭据
   * 目录必须再做一次显式遮蔽。调用方应只传已经存在并完成 realpath 规范化的路径，避免
   * bubblewrap 因不存在的挂载点失败。
   */
  deniedReadPaths?: readonly DeniedReadPath[];
  /** 宿主私有根（通常是真实 HOME）；在 Linux 中以空 tmpfs 覆盖，在 macOS 中 deny。 */
  hiddenReadRoots?: readonly string[];
  /** hiddenReadRoots 内经审计后允许只读回挂的工具链目录。 */
  readableRoots?: readonly string[];
  /** 是否允许出网；缺省由调用方决定（见 resolveSandboxNetwork）。 */
  network?: boolean;
  /** 唯一允许连接的本地显式代理；设置后仍先 deny network*。 */
  networkProxy?: { host: string; port: number };
}

export interface DeniedReadPath {
  path: string;
  kind: "file" | "directory";
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
 * 沙箱是否放行出网。生产默认断网；必须由单次工具调用显式申请并通过受控代理。
 */
export function resolveSandboxNetwork(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["AGENTX_SANDBOX_NETWORK"] ?? "").trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0" || v === "deny" || v === "none") return false;
  return v === "on" || v === "true" || v === "1" || v === "allow";
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
  // Blocking credential CLI names is only a convenience guard: an interpreter could call
  // Security.framework directly. Deny the per-user/system Keychain XPC services at the process
  // sandbox boundary so model-visible commands cannot bypass CredentialBroker through another
  // executable. This changes only the spawned process profile, never host Keychain configuration.
  for (const service of [
    "com.apple.securityd",
    "com.apple.securityd.xpc",
    "com.apple.securityd.general",
    "com.apple.securityd.systemkeychain",
    "com.apple.securityd.aps",
    "com.apple.securityd.sos",
    "com.apple.securityd.ckks",
    "com.apple.security.XPCKeychainSandboxCheck",
    "com.apple.security.keychain-circle-notification",
    "com.apple.security.cloudkeychainproxy3",
  ]) {
    lines.push(`(deny mach-lookup (global-name ${sbplString(service)}))`);
  }
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
  for (const hidden of dedupe(spec.hiddenReadRoots ?? [])) {
    lines.push(`(deny file-read* (subpath ${sbplString(hidden)}))`);
  }
  // 当前工作区是用户明确授权给 agent 的数据面；HOME 内工具链只按显式根回挂。
  for (const readable of dedupe([spec.cwd, ...(spec.readableRoots ?? [])])) {
    lines.push(`(allow file-read* (subpath ${sbplString(readable)}))`);
  }
  // `(allow default)` 会允许读取整台宿主机；凭据路径必须在所有通用 allow 之后显式 deny。
  for (const denied of dedupeDeniedReadPaths(spec.deniedReadPaths ?? [])) {
    const matcher = denied.kind === "directory" ? "subpath" : "literal";
    lines.push(`(deny file-read* (${matcher} ${sbplString(denied.path)}))`);
  }
  if (spec.networkProxy) {
    lines.push("(deny network*)");
    lines.push(
      `(allow network-outbound (remote ip ${sbplString(
        `${spec.networkProxy.host}:${spec.networkProxy.port}`,
      )}))`,
    );
  } else if (!spec.network) lines.push("(deny network*)");
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
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
    "--ro-bind",
    "/",
    "/", // 整盘只读打底
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    // 隐藏宿主服务 socket、兄弟进程和宿主临时文件；workspace 稍后按授权回挂。
    "--tmpfs",
    "/run",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/var/tmp",
  ];
  // 隐藏真实 HOME 后再回挂经审计的只读工具链和工作区。后续的 workspace writable bind
  // 会覆盖 cwd 的只读 bind；bubblewrap 在建立 namespace 前打开 bind source，因此源仍来自宿主。
  for (const hidden of dedupe(spec.hiddenReadRoots ?? [])) args.push("--tmpfs", hidden);
  for (const readable of dedupe(spec.readableRoots ?? [])) {
    args.push("--ro-bind-try", readable, readable);
  }
  if (spec.policy === "workspace-write") {
    // /tmp 与 /var/tmp 已是 namespace 私有 tmpfs：构建可写，但看不到宿主临时文件。
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
    // HOME 被遮蔽时显式把当前工作区只读回挂；/tmp 已是私有 scratch。
    if ((spec.hiddenReadRoots?.length ?? 0) > 0) {
      args.push("--ro-bind", spec.cwd, spec.cwd);
    }
    args.push("--chdir", spec.cwd);
  }
  // 整盘只读仍会泄露 ~/.ssh、云 CLI 配置等。目录用私有 tmpfs 遮蔽，文件用 /dev/null
  // 覆盖；规则放在 workspace rebind 之后，避免工作区恰好位于 $HOME 时被再次暴露。
  for (const denied of dedupeDeniedReadPaths(spec.deniedReadPaths ?? [])) {
    if (denied.kind === "directory") args.push("--tmpfs", denied.path);
    else args.push("--ro-bind", "/dev/null", denied.path);
  }
  if (!spec.network) args.push("--unshare-net");
  return args;
}

/**
 * 收集宿主机默认凭据位置。只返回实际存在的规范化路径，并把文件/目录类型固定下来，供
 * 两种 OS 沙箱生成不可绕过的 read deny/mask。环境变量中的自定义凭据路径不在这里读取：
 * 相关变量会被 sanitizedShellEnv 移除，避免反向成为路径泄露通道。
 */
export function sensitiveHostReadPaths(home = os.homedir()): DeniedReadPath[] {
  const candidates = [
    ".ssh",
    ".aws",
    ".azure",
    ".kube",
    ".docker",
    ".gnupg",
    ".password-store",
    ".codex",
    ".claude",
    ".gemini",
    ".anicode",
    ".config/gcloud",
    ".config/gh",
    ".config/glab-cli",
    ".config/op",
    ".config/1Password",
    ".config/anicode",
    ".local/share/keyrings",
    "Library/Keychains",
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
  ];
  const found: DeniedReadPath[] = [];
  for (const relative of candidates) {
    const candidate = path.resolve(home, relative);
    try {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) found.push({ path: resolved, kind: "directory" });
      else if (stat.isFile() || stat.isSymbolicLink()) found.push({ path: resolved, kind: "file" });
    } catch {
      // 不存在/不可访问的路径不应让沙箱构造失败。
    }
  }
  return dedupeDeniedReadPaths(found);
}

/**
 * HOME 默认整体隐藏；只回挂常见版本管理器中不可变的可执行工具链。该列表刻意不包含
 * ~/.config、浏览器资料、shell 历史或包管理器 credential/cache 根。
 */
export function sandboxHostReadBoundary(home = os.homedir()): {
  hiddenReadRoots: string[];
  readableRoots: string[];
} {
  const hiddenReadRoots: string[] = [];
  try {
    hiddenReadRoots.push(fs.realpathSync(home));
  } catch {
    // 无 HOME 时不虚构一个可能遮蔽工作区父路径的规则。
  }
  const candidates = [
    ".nvm/versions",
    ".asdf/installs",
    ".pyenv/versions",
    ".local/bin",
    ".cargo/bin",
    ".bun/bin",
    ".deno/bin",
  ];
  const readableRoots: string[] = [];
  for (const relative of candidates) {
    try {
      const resolved = fs.realpathSync(path.resolve(home, relative));
      if (fs.statSync(resolved).isDirectory()) readableRoots.push(resolved);
    } catch {
      // Optional toolchain is absent.
    }
  }
  return { hiddenReadRoots: dedupe(hiddenReadRoots), readableRoots: dedupe(readableRoots) };
}

/**
 * 运行期检测沙箱二进制是否可用；不可用时调用方应回退裸跑并告警一次。
 * 默认 env 下结果记忆化（PATH 稳定）；传入自定义 env 时不走缓存，便于测试。
 */
export function resolveSandboxBinary(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const useCache = env === process.env && platform === process.platform;
  const cacheKey = `${platform}:${bin}`;
  if (useCache) {
    const cached = binaryPathCache.get(cacheKey);
    if (cached !== undefined) return cached || null;
  }
  // Security boundary programs are never resolved from caller-controlled PATH. The selected file
  // and all parent directories must be root-owned and non-writable by group/others, which removes
  // both PATH substitution and post-check replacement for an unprivileged workspace process.
  const trustedDirs =
    bin === "sandbox-exec"
      ? platform === "darwin"
        ? ["/usr/bin"]
        : []
      : bin === "bwrap"
        ? platform === "linux"
          ? ["/usr/bin", "/bin", "/usr/local/bin"]
          : []
        : (env["PATH"] ?? "").split(path.delimiter).filter(path.isAbsolute);
  let resolved: string | null = null;
  for (const dir of dedupe(trustedDirs)) {
    const candidate = path.join(dir, bin);
    if (trustedExecutable(candidate, bin === "sandbox-exec" || bin === "bwrap")) {
      resolved = candidate;
      break;
    }
  }
  if (useCache) binaryPathCache.set(cacheKey, resolved ?? "");
  return resolved;
}

export function sandboxBinaryAvailable(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return resolveSandboxBinary(bin, env, platform) !== null;
}

const binaryPathCache = new Map<string, string>();

function trustedExecutable(candidate: string, requireSystemOwnership: boolean): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) return false;
    if (!requireSystemOwnership) return true;
    if (typeof stat.uid === "number" && stat.uid !== 0) return false;
    if ((stat.mode & 0o022) !== 0) return false;
    let parent = path.dirname(candidate);
    for (;;) {
      const parentStat = fs.statSync(parent);
      if (typeof parentStat.uid === "number" && parentStat.uid !== 0) return false;
      if ((parentStat.mode & 0o022) !== 0) return false;
      const next = path.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return true;
  } catch {
    return false;
  }
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items.filter((s) => s && s.length > 0))];
}

function dedupeDeniedReadPaths(items: readonly DeniedReadPath[]): DeniedReadPath[] {
  const seen = new Set<string>();
  const result: DeniedReadPath[] = [];
  for (const item of items) {
    const key = `${item.kind}\0${item.path}`;
    if (!item.path || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

/** SBPL 字符串字面量转义。 */
function sbplString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
