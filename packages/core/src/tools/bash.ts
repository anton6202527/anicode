/**
 * Bash 工具 —— 执行 shell 命令。副作用最大的工具，权限门的主要看护对象。
 *
 * 安全说明：
 * - 命令在 cwd 下执行，默认经 OS 级沙箱（macOS Seatbelt / Linux bubblewrap，见 sandbox.ts）：
 *   写入限工作区+临时目录，.git/.anicode 保持只读；网络默认放行，可用
 *   AGENTX_SANDBOX_NETWORK=off 收紧。缺沙箱二进制时回退裸跑并告警一次。
 * - 有超时；abort signal 会 kill 子进程
 * - ruleKey 直接返回命令原文，便于 "Bash(git *)" 这类规则匹配
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { buildShellSpawn, sanitizedShellEnv } from "./shell-spawn.js";
import { terminateProcessTree } from "../runtime/isolated-runtime.js";
import { startBackgroundShell } from "./shells.js";
import type { Tool, ToolContext } from "./tool.js";
import { ToolError } from "./tool.js";
import { t } from "../i18n.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 30_000; // 截断超长输出，保护上下文

/**
 * 头尾双向截断的输出捕获。
 *
 * 为什么不是「攒满 MAX_OUTPUT 就丢弃后续」：构建/测试的失败摘要几乎总在**结尾**
 * （"3 failing"、栈回溯、exit 提示），只留头部等于把最有用的那段丢了。这里保留
 * 头 80% + 尾 20%（与 Agent 层 truncateToolResult 一致），中段超限才丢。
 *
 * 增量拼接期间不做截断（避免每块都 O(n) 重排）；结束时一次性成形。tail 用环形
 * 缓冲，内存有界，长跑命令也不会把整份输出堆在内存里。
 */
class OutputCapture {
  private head = "";
  private tail = "";
  private headFull = false;
  private overflow = false;
  private readonly headCap: number;
  private readonly tailCap: number;

  constructor(private readonly max: number = MAX_OUTPUT) {
    this.headCap = Math.floor(max * 0.8);
    this.tailCap = max - this.headCap;
  }

  push(chunk: string): void {
    if (!this.headFull) {
      const room = this.headCap - this.head.length;
      if (chunk.length <= room) {
        this.head += chunk;
        return;
      }
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      this.headFull = true;
    }
    // 头部已满，其余进尾部环形缓冲：只保留最后 tailCap 个字符。
    this.tail += chunk;
    if (this.tail.length > this.tailCap) {
      this.overflow = true;
      this.tail = this.tail.slice(this.tail.length - this.tailCap);
    }
  }

  /** 成形最终文本；suffix 追加在正文后（如超时/中断说明），不计入截断预算。 */
  render(suffix = ""): string {
    let body: string;
    if (!this.overflow) {
      body = this.head + this.tail;
    } else {
      body = `${this.head}\n…（输出超过 ${this.max} 字符，中段已截断）…\n${this.tail}`;
    }
    if (!body) body = "(无输出)";
    return body + suffix;
  }
}

/**
 * 把复合命令按顶层 shell 操作符（&& || ; | & 换行）拆成子命令（尊重引号）。
 * 权限规则据此逐段匹配："git status && rm -rf /" 绝不该命中 "Bash(git *)"。
 * 保守解析：不理解子 shell/重定向的语义，只做顶层切分 —— 拆不细则整段匹配，
 * 宁可多问一次也不放行。
 */
export interface ShellCommandAnalysis {
  parts: string[];
  /** false = 遇到重定向/命令替换/分组等无法由轻量扫描器可靠展开的语法 */
  complete: boolean;
}

export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const rawParts: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let complete = true;
  const flush = () => {
    const part = cur.trim();
    if (part) rawParts.push(part);
    cur = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (quote === '"' && c === "\\") {
        if (i + 1 < command.length) cur += command[++i]!;
        else complete = false;
        continue;
      }
      if (quote === '"' && (c === "`" || (c === "$" && command[i + 1] === "("))) {
        complete = false;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "\\") {
      cur += c;
      if (i + 1 < command.length) cur += command[++i]!;
      else complete = false;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    // 这些语法可隐藏额外可执行命令或产生写入；保留原文但标记分析不完整。
    if (
      c === "`" ||
      c === ">" ||
      c === "<" ||
      c === "(" ||
      c === ")" ||
      c === "{" ||
      c === "}" ||
      (c === "$" && command[i + 1] === "(") ||
      (c === "#" && (i === 0 || /\s/.test(command[i - 1]!)))
    ) {
      complete = false;
      cur += c;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      flush();
      i++;
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "\r") {
      flush();
      if (c === "\r" && command[i + 1] === "\n") i++;
      continue;
    }
    cur += c;
  }
  if (quote) complete = false;
  flush();
  const parts: string[] = [];
  for (const raw of rawParts) {
    const normalized = normalizeSimpleCommand(raw);
    if (normalized.command) parts.push(normalized.command);
    if (!normalized.complete) complete = false;
  }
  return { parts, complete };
}

export function splitShellCommand(command: string): string[] {
  return analyzeShellCommand(command).parts;
}

const SYSTEM_NETWORK_COMMANDS = new Set([
  "networksetup",
  "scutil",
  "route",
  "ifconfig",
  "ip",
  "resolvectl",
  "nmcli",
  "netplan",
  "netsh",
  "pfctl",
  "iptables",
  "ip6tables",
  "nft",
  "ufw",
  "firewall-cmd",
  "systemctl",
  "service",
  "killall",
  "dscacheutil",
  "set-dnsclientserveraddress",
  "set-netipinterface",
  "set-netroute",
  "disable-netadapter",
  "enable-netadapter",
  "restart-netadapter",
]);

/**
 * Native credential-store clients are never a model-facing credential API. They bypass the
 * CredentialBroker's allowlist, audit trail, scope checks, cache and hermetic Keychain sentinel,
 * so even read-only verbs must fail before a child process is started.
 */
const SYSTEM_CREDENTIAL_STORE_COMMANDS = new Set([
  "security",
  "secret-tool",
  "kwallet-query",
  "cmdkey",
  "cmdkey.exe",
]);

const EXECUTION_WRAPPERS = new Set([
  "sudo",
  "doas",
  "env",
  "command",
  "builtin",
  "exec",
  "eval",
  "source",
  ".",
  "nohup",
  "nice",
  "timeout",
  "xargs",
  "parallel",
  "sh",
  "bash",
  "dash",
  "zsh",
  "ksh",
  "fish",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe",
]);

function normalizedPolicyWords(part: string): string[] {
  return part
    .split(/\s+/)
    .map((word) => word.replace(/^["']|["',;]$/g, ""))
    .filter(Boolean);
}

function wrappedCommandIndex(words: readonly string[], commands: ReadonlySet<string>): number {
  if (words.length === 0) return -1;
  let firstIndex = 0;
  while (firstIndex < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[firstIndex]!)) {
    firstIndex++;
  }
  if (firstIndex >= words.length) return -1;
  const first = path.basename(words[firstIndex]!).toLowerCase();
  if (commands.has(first)) return firstIndex;
  if (!EXECUTION_WRAPPERS.has(first)) return -1;
  // `analyzeShellCommand` removes quoting while preserving words. Searching the normalized
  // wrapper tail catches absolute paths and nested forms such as `env ... security`,
  // `command -- secret-tool`, `sh -c 'kwallet-query ...'` and `cmd /c cmdkey`.
  return words.findIndex((word, index) => {
    if (index <= firstIndex) return false;
    return commands.has(path.basename(word).toLowerCase());
  });
}

function firstCommandAfterOptions(
  words: readonly string[],
  start: number,
  optionsWithValue: ReadonlySet<string> = new Set(),
): number {
  let index = start;
  while (index < words.length) {
    const token = words[index]!;
    const lower = token.toLowerCase();
    if (token === "--") return index + 1 < words.length ? index + 1 : -1;
    if (!token.startsWith("-") || token === "-") return index;
    const option = lower.includes("=") ? lower.slice(0, lower.indexOf("=")) : lower;
    if (optionsWithValue.has(option) && !lower.includes("=")) index += 2;
    else index++;
  }
  return -1;
}

const SUDO_OPTIONS_WITH_VALUE = new Set([
  "-u",
  "--user",
  "-g",
  "--group",
  "-h",
  "--host",
  "-p",
  "--prompt",
  "-c",
  "--close-from",
  "-r",
  "--role",
  "-t",
  "--type",
  "-d",
  "--chdir",
]);
const ENV_OPTIONS_WITH_VALUE = new Set(["-u", "--unset", "-c", "--chdir"]);
const XARGS_OPTIONS_WITH_VALUE = new Set([
  "-a",
  "--arg-file",
  "-e",
  "--eof",
  "-i",
  "--replace",
  "-l",
  "--max-lines",
  "-n",
  "--max-args",
  "-p",
  "--max-procs",
  "-s",
  "--max-chars",
]);

function nextWrappedExecutableIndex(words: readonly string[], wrapperIndex: number): number {
  const wrapper = path
    .basename(words[wrapperIndex]!)
    .toLowerCase()
    .replace(/\.exe$/u, "");
  const start = wrapperIndex + 1;
  if (wrapper === "env") {
    let index = start;
    while (index < words.length) {
      const token = words[index]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
        index++;
        continue;
      }
      const next = firstCommandAfterOptions(words, index, ENV_OPTIONS_WITH_VALUE);
      if (next !== index) {
        if (next < 0) return -1;
        index = next;
        continue;
      }
      return index;
    }
    return -1;
  }
  if (wrapper === "command") {
    if (words.slice(start).some((word) => word === "-v" || word === "-V")) return -1;
    return firstCommandAfterOptions(words, start);
  }
  if (["sudo", "doas"].includes(wrapper)) {
    return firstCommandAfterOptions(words, start, SUDO_OPTIONS_WITH_VALUE);
  }
  if (["sh", "bash", "dash", "zsh", "ksh", "fish"].includes(wrapper)) {
    const commandOption = words.findIndex(
      (word, index) =>
        index >= start && (word === "--command" || word === "-c" || /^-[^-]*c[^-]*$/u.test(word)),
    );
    return commandOption >= 0 && commandOption + 1 < words.length ? commandOption + 1 : -1;
  }
  if (["powershell", "pwsh"].includes(wrapper)) {
    const commandOption = words.findIndex(
      (word, index) => index >= start && ["-command", "-c", "/c"].includes(word.toLowerCase()),
    );
    return commandOption >= 0 && commandOption + 1 < words.length ? commandOption + 1 : -1;
  }
  if (wrapper === "cmd") {
    const commandOption = words.findIndex(
      (word, index) => index >= start && ["/c", "/k"].includes(word.toLowerCase()),
    );
    return commandOption >= 0 && commandOption + 1 < words.length ? commandOption + 1 : -1;
  }
  if (wrapper === "timeout") {
    const duration = firstCommandAfterOptions(words, start);
    return duration >= 0 && duration + 1 < words.length ? duration + 1 : -1;
  }
  if (wrapper === "nice") {
    return firstCommandAfterOptions(words, start, new Set(["-n", "--adjustment"]));
  }
  if (["xargs", "parallel"].includes(wrapper)) {
    return firstCommandAfterOptions(words, start, XARGS_OPTIONS_WITH_VALUE);
  }
  return firstCommandAfterOptions(words, start);
}

function credentialStoreCommandIndex(words: readonly string[]): number {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  while (index >= 0 && index < words.length) {
    const executable = path.basename(words[index]!).toLowerCase();
    if (SYSTEM_CREDENTIAL_STORE_COMMANDS.has(executable)) return index;
    if (!EXECUTION_WRAPPERS.has(executable)) return -1;
    index = nextWrappedExecutableIndex(words, index);
  }
  return -1;
}

/**
 * Hard credential boundary for model-visible shell execution. A command that needs a credential
 * must use a scoped Broker lease; invoking a host credential-store client is never allowed.
 */
export function systemCredentialStoreAccessReason(command: string): string | undefined {
  for (const part of analyzeShellCommand(command).parts) {
    const words = normalizedPolicyWords(part);
    const commandIndex = credentialStoreCommandIndex(words);
    if (commandIndex < 0) continue;
    return `${path.basename(words[commandIndex]!).toLowerCase()} would bypass the CredentialBroker`;
  }
  return undefined;
}

/**
 * Hard process-safety boundary for commands that can reconfigure the host's shared networking.
 * Read-only diagnostics remain available; mutations must be performed deliberately outside AniCode.
 */
export function systemNetworkMutationReason(command: string): string | undefined {
  for (const part of analyzeShellCommand(command).parts) {
    const words = normalizedPolicyWords(part);
    if (words.length === 0) continue;
    const commandIndex = wrappedCommandIndex(words, SYSTEM_NETWORK_COMMANDS);
    if (commandIndex < 0) {
      if (mutatesNetworkConfigurationFile(part)) {
        return "writing host DNS/network configuration files is not allowed";
      }
      continue;
    }
    const executable = path.basename(words[commandIndex]!).toLowerCase();
    const args = words.slice(commandIndex + 1).map((word) => word.toLowerCase());
    if (networkCommandMutates(executable, args, part)) {
      return `${executable} would modify shared system network configuration`;
    }
  }
  return undefined;
}

function networkCommandMutates(executable: string, args: string[], raw: string): boolean {
  const has = (...values: string[]) => args.some((arg) => values.includes(arg));
  const starts = (...prefixes: string[]) =>
    args.some((arg) => prefixes.some((p) => arg.startsWith(p)));
  switch (executable) {
    case "networksetup":
      return starts("-set", "-create", "-remove", "-order", "-detectnewhardware");
    case "scutil":
      return !args.some((arg) => ["--proxy", "--dns", "--nwi", "--get", "--status"].includes(arg));
    case "route":
      return has("add", "delete", "del", "change", "flush");
    case "ifconfig":
      return (
        has("up", "down", "alias", "-alias", "create", "destroy", "delete", "name") ||
        starts("mtu", "lladdr", "ether") ||
        args.some(
          (arg, index) =>
            (arg === "inet" || arg === "inet6") &&
            args[index + 1] !== undefined &&
            !args[index + 1]!.startsWith("-"),
        )
      );
    case "ip": {
      const area = args.findIndex((arg) =>
        ["route", "link", "address", "addr", "rule", "neighbour", "neighbor", "netns"].includes(
          arg,
        ),
      );
      return (
        area >= 0 &&
        args
          .slice(area + 1)
          .some((arg) =>
            ["add", "del", "delete", "change", "replace", "append", "flush", "set"].includes(arg),
          )
      );
    }
    case "resolvectl":
      return has("dns", "domain", "default-route", "llmnr", "mdns", "dnssec", "nta", "revert");
    case "nmcli":
      return has(
        "up",
        "down",
        "modify",
        "mod",
        "add",
        "delete",
        "del",
        "connect",
        "disconnect",
        "reapply",
        "on",
        "off",
      );
    case "netplan":
      return has("apply", "try", "set");
    case "netsh":
      return !has("show", "dump", "help", "/?", "?");
    case "set-dnsclientserveraddress":
    case "set-netipinterface":
    case "set-netroute":
    case "disable-netadapter":
    case "enable-netadapter":
    case "restart-netadapter":
      return true;
    case "pfctl":
      return !has("-s", "-sr", "-sn", "-sa");
    case "iptables":
    case "ip6tables":
      return !args.some((arg) =>
        ["-l", "-s", "--list", "--list-rules", "--check", "-c"].includes(arg),
      );
    case "nft":
      return !has("list", "get", "describe", "monitor");
    case "ufw":
      return !has("status", "show");
    case "firewall-cmd":
      return !has("--state", "--get-active-zones", "--list-all", "--list-all-zones");
    case "systemctl":
    case "service":
      return (
        /(?:networkmanager|systemd-resolved|networking|network\.service)/i.test(raw) &&
        has("start", "stop", "restart", "reload", "enable", "disable", "mask")
      );
    case "killall":
      return args.some((arg) => arg.includes("mdnsresponder") || arg.includes("systemd-resolved"));
    case "dscacheutil":
      return has("-flushcache");
    default:
      return false;
  }
}

function mutatesNetworkConfigurationFile(command: string): boolean {
  if (!/(?:\/etc\/(?:resolv\.conf|hosts)|SystemConfiguration)/i.test(command)) return false;
  return /(?:^|\s)(?:tee|sed|perl|python\d*|ruby|cp|mv|rm|install|truncate)(?:\s|$)|>>?|\|/i.test(
    command,
  );
}

const SHELL_CONTROL_WORDS = new Set([
  "!",
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "select",
  "function",
  "coproc",
  "time",
]);
const COMMAND_WRAPPERS = new Set([
  "env",
  "command",
  "builtin",
  "exec",
  "eval",
  "source",
  ".",
  "sudo",
  "doas",
  "nohup",
  "xargs",
  "parallel",
  "nice",
  "timeout",
]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "dash", "zsh", "ksh", "fish"]);

/**
 * 把一个已切分的简单命令词法规范化：去掉不改变词义的引号/转义、合并空白，
 * 并把绝对/相对可执行路径归一成 basename。无法可靠展开的包装器与控制语法
 * 标为 incomplete，让权限引擎拒绝用细粒度 glob 自动放行。
 */
function normalizeSimpleCommand(raw: string): { command: string; complete: boolean } {
  const words: string[] = [];
  let word = "";
  let active = false;
  let quote: '"' | "'" | null = null;
  let complete = true;
  const pushWord = () => {
    if (!active) return;
    words.push(word);
    word = "";
    active = false;
  };

  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      active = true;
      continue;
    }
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "\\") {
        if (i + 1 >= raw.length) {
          complete = false;
        } else {
          const next = raw[++i]!;
          // bash 双引号里反斜杠只转义 $ ` " \\ 与换行；其他字符前的
          // 反斜杠会原样保留，不能把 "g\\it" 错规范化成 "git"。
          if (next === "$" || next === "`" || next === '"' || next === "\\") word += next;
          else if (next !== "\n") word += `\\${next}`;
        }
      } else {
        if (c === "$" || c === "`") complete = false;
        word += c;
      }
      active = true;
      continue;
    }
    if (/\s/.test(c)) {
      pushWord();
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      active = true;
      continue;
    }
    if (c === "\\") {
      active = true;
      if (i + 1 < raw.length) word += raw[++i]!;
      else complete = false;
      continue;
    }
    if (c === "$" || c === "`" || c === "*" || c === "?" || c === "[") complete = false;
    word += c;
    active = true;
  }
  if (quote) complete = false;
  pushWord();
  if (words.length === 0) return { command: "", complete };

  // 赋值前缀与 shell 控制字会改变真正的命令位置。
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || SHELL_CONTROL_WORDS.has(words[0]!)) {
    complete = false;
  }
  const originalExecutable = words[0]!;
  const executable = path.basename(originalExecutable);
  words[0] = executable;
  // basename 规范化用于让 deny 捕获 /bin/rm；但带路径的可执行文件可能只是
  // 恶意同名程序，不能据此获得 Bash(git *) 一类细粒度 allow。
  if (originalExecutable !== executable) complete = false;
  if (COMMAND_WRAPPERS.has(executable)) complete = false;
  if (SHELL_INTERPRETERS.has(executable) && words.some((w) => w === "-c" || w === "--command")) {
    complete = false;
  }
  if (
    executable === "find" &&
    words.some((w) => /^-(?:exec|execdir|ok|okdir|delete|fprint|fls)/.test(w))
  ) {
    complete = false;
  }
  // `git -c alias.x=!command x` 是一个任意命令入口，不能命中 Bash(git *) 自动放行。
  if (executable === "git" && words.some((w) => w === "-c" || w.startsWith("--config-env="))) {
    complete = false;
  }

  const command = words
    .map((w) => (w === "" || /[\s;&|<>]/.test(w) ? JSON.stringify(w) : w))
    .join(" ");
  return { command, complete };
}

export const bashTool: Tool = {
  readOnly: false,
  def: {
    name: "bash",
    description: t(
      "Run a shell command in the working directory, returning combined stdout+stderr and the exit code. Use for running builds, tests, git, etc.",
      "在工作目录下执行一条 shell 命令，返回合并的 stdout+stderr 与退出码。用于运行构建、测试、git 等。",
    ),
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: t("The shell command to run", "要执行的 shell 命令"),
        },
        timeout_ms: {
          type: "number",
          description: t(
            `Timeout in milliseconds (default ${DEFAULT_TIMEOUT_MS})`,
            `超时毫秒数（默认 ${DEFAULT_TIMEOUT_MS}）`,
          ),
        },
        run_in_background: {
          type: "boolean",
          description: t(
            "Run in the background and return a shell id immediately instead of blocking. Use for dev servers, watch builds, log tailing, and anything long-running or that never exits on its own. Read its output later with bash_output, stop it with kill_shell.",
            "在后台运行并立即返回 shell id，不阻塞。适合 dev server、watch 构建、日志跟随，以及任何长时间运行或不会自己结束的命令。之后用 bash_output 读输出、kill_shell 停止。",
          ),
        },
        network: {
          type: "boolean",
          description: t(
            "Request network access through the configured AniCode proxy (default false).",
            "申请通过 AniCode 代理访问网络（默认 false）。",
          ),
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["command"] ?? ""),
  ruleParts: (i) => analyzeShellCommand(String(i["command"] ?? "")).parts,
  rulePartsComplete: (i) => analyzeShellCommand(String(i["command"] ?? "")).complete,
  // shell 的实际副作用无法靠首词白名单可靠判断（重定向、find -delete、git 配置等）。
  // 真沙箱/完整 AST 分析落地前一律串行。
  isConcurrencySafe: () => false,
  run(input, ctx: ToolContext): Promise<string> {
    const command = String(input["command"] ?? "");
    if (!command) throw new ToolError("command 不能为空");
    if (ctx.signal.aborted) throw new ToolError("命令被中断");
    const credentialStoreAccess = systemCredentialStoreAccessReason(command);
    if (credentialStoreAccess) {
      throw new ToolError(
        t(
          `Refusing host credential-store access: ${credentialStoreAccess}. Use a scoped CredentialBroker reference instead.`,
          `拒绝访问宿主凭据库：${credentialStoreAccess}。请改用限域的 CredentialBroker 引用。`,
        ),
      );
    }
    const networkMutation = systemNetworkMutationReason(command);
    if (networkMutation) {
      throw new ToolError(
        t(
          `Refusing host network reconfiguration: ${networkMutation}. AniCode only uses process-scoped proxy settings.`,
          `拒绝修改宿主网络配置：${networkMutation}。AniCode 只允许使用进程级代理设置。`,
        ),
      );
    }

    // 后台模式：立即返回 shell id，不阻塞、不受 timeout 约束（这正是它存在的意义）。
    // 沙箱与前台完全一致（共用 buildShellSpawn），权限门也已在此之前走过。
    if (input["run_in_background"]) {
      return Promise.resolve(
        startBackgroundShell(command, ctx, { network: input["network"] === true }),
      );
    }

    const requestedTimeout = Number(input["timeout_ms"] ?? DEFAULT_TIMEOUT_MS);
    const timeout = Number.isFinite(requestedTimeout)
      ? Math.max(1000, requestedTimeout)
      : DEFAULT_TIMEOUT_MS;

    if (ctx.isolatedRuntime) {
      return ctx.isolatedRuntime
        .run({
          command,
          cwd: ctx.cwd,
          ...(ctx.sandbox ? { policy: ctx.sandbox } : {}),
          timeoutMs: timeout,
          signal: ctx.signal,
          network: input["network"] === true,
          ...(ctx.traceContext ? { traceContext: ctx.traceContext } : {}),
        })
        .then((result) =>
          result.timedOut
            ? `[timeout ${timeout}ms]\n${result.output}`
            : `[exit ${result.exitCode ?? "?"}]\n${result.output || t("(no output)", "（无输出）")}`,
        );
    }

    const { file: spawnFile, args: spawnArgs } = buildShellSpawn(command, ctx.sandbox, ctx.cwd);

    return new Promise((resolve, reject) => {
      const child = spawn(spawnFile, spawnArgs, {
        cwd: ctx.cwd,
        env: sanitizedShellEnv(),
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const capture = new OutputCapture();
      const onData = (buf: Buffer) => capture.push(buf.toString());
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      // 超时不是「无结果」：命令挂住前往往已经打印了关键线索（哪个测试卡住、
      // 连到哪个地址）。把已捕获的输出如实回给模型，比只丢一句「超时」有用得多。
      let terminal: "timeout" | "abort" | undefined;
      let termination: Promise<void> | undefined;
      const stop = () => {
        termination ??= terminateProcessTree(child);
        void termination.catch(() => undefined);
        return termination;
      };
      const timer = setTimeout(() => {
        terminal = "timeout";
        void stop();
      }, timeout);

      // 用户中断与超时不同：这是显式打断，应作为错误上抛，让 loop 结束本轮。
      const onAbort = () => {
        terminal = "abort";
        clearTimeout(timer);
        void stop();
      };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();

      child.on("error", (err) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        reject(new ToolError(`无法启动命令: ${err.message}`));
      });
      child.on("close", (code) => {
        void (async () => {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          if (!termination && process.platform !== "win32") {
            termination = terminateProcessTree(child);
          }
          await termination;
          if (terminal === "abort") {
            reject(new ToolError("命令被中断"));
            return;
          }
          if (terminal === "timeout") {
            resolve(
              `[timeout ${timeout}ms]\n${capture.render(
                t(
                  `\n…（command exceeded ${timeout}ms and was killed; output above is what it printed before that）`,
                  `\n…（命令超过 ${timeout}ms 被终止；以上是终止前的输出）`,
                ),
              )}`,
            );
            return;
          }
          resolve(`[exit ${code ?? "?"}]\n${capture.render()}`);
        })().catch((error) =>
          reject(
            new ToolError(
              `命令进程树清理失败: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      });
    });
  },
};

// buildShellSpawn / sanitizedShellEnv 见 shell-spawn.ts —— 单独成模块以打破
// bash ↔ shells 的循环依赖；需要的模块直接从那里导入。
