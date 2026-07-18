/**
 * 后台 shell —— 让 agent 能跑「不会自己结束」或耗时很长的命令：dev server、
 * watch 构建、日志跟随、长测试。对齐 Claude Code 的 run_in_background +
 * BashOutput + KillShell 三件套。
 *
 * 没有它，bash 只能阻塞式跑到 120s 超时被 SIGKILL —— 起个 dev server 再验证页面
 * 这类最常见的工作流根本走不通。
 *
 * 设计要点（都是为了避免 Claude Code 已知的踩坑）：
 * - **增量读取**：bash_output 只返回「上次读之后的新输出」，读过即从缓冲区移除。
 *   避免同一段日志被反复读进上下文（Claude Code 的 token 耗尽类 bug 多源于此）。
 * - **不做后台提醒**：进程状态只在模型显式调用 bash_output 时才进上下文，
 *   绝不主动往历史里塞 system-reminder —— 后台任务不该悄悄吃掉上下文预算。
 * - **有界缓冲**：每个 shell 的待读缓冲有上限，超出丢弃**最旧**的部分（日志场景最新的最有价值），
 *   并在下次读取时如实标注丢弃量。
 * - **自动回收**：已结束且输出被读净的 shell 会被回收；总数也有上限，防泄漏。
 * - **沙箱一致**：后台命令与前台走同一个 buildShellSpawn —— 后台绝不是绕过沙箱的通道。
 *
 * 注册表是模块级（进程内共享）：后台进程本就是进程级资源，主 agent 起的 dev server
 * 让子 agent 读取是合理且期望的行为；shell id 全局唯一，读写按 id 隔离。
 * kill 只能作用于本注册表内、由 agent 自己启动的 shell，绝不接受任意 pid。
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { Tool, ToolContext } from "./tool.js";
import { ToolError } from "./tool.js";
import { buildShellSpawn, sanitizedShellEnv } from "./shell-spawn.js";
import { t } from "../i18n.js";

/** 每个 shell 的待读缓冲上限（字符）。超出丢最旧的。 */
const MAX_PENDING_CHARS = 60_000;
/** 单次 bash_output 返回上限，保护上下文。 */
const MAX_READ_CHARS = 30_000;
/** 同时保留的 shell 上限（含已结束未回收的）。 */
const MAX_SHELLS = 20;
/** 已结束且输出读净的 shell，保留这么久后回收（留出最后一次查状态的窗口）。 */
const REAP_AFTER_MS = 5 * 60_000;

export type ShellStatus = "running" | "exited" | "killed";

export interface ShellInfo {
  id: string;
  command: string;
  status: ShellStatus;
  exitCode: number | null;
  startedAt: number;
}

interface ShellEntry extends ShellInfo {
  child: ChildProcess;
  /** 尚未被 bash_output 读走的输出 */
  pending: string;
  /** 因缓冲上限被丢弃的字符数（读取时如实告知） */
  dropped: number;
  endedAt: number | null;
}

export interface ReadResult {
  chunk: string;
  status: ShellStatus;
  exitCode: number | null;
  /** 因缓冲上限被丢弃的字符数 */
  dropped: number;
  /** 被 filter 略过的行数（本次一并消费掉了） */
  filtered: number;
  command: string;
}

let seq = 0;

/** 运行期 stdio 管道是 Socket（带 unref），静态类型只到 Readable；按能力探测调用。 */
function unrefStream(s: unknown): void {
  (s as { unref?: () => void } | null)?.unref?.();
}

/** 后台 shell 注册表。进程内单例（见文件头说明），但类本身可独立实例化以便测试。 */
export class ShellRegistry {
  private shells = new Map<string, ShellEntry>();

  /** 启动一个后台 shell，立即返回 id。 */
  start(opts: { command: string; cwd: string; file: string; args: string[] }): string {
    this.reap();
    // 仍然满员就按结束时间淘汰已结束的（宽限期让位于可用性）。少了这一步，
    // 20 个秒退的 shell 会把注册表堵死 5 分钟 —— 而 kill_shell 并不删除条目，
    // 「先 kill 再重试」的提示就成了一句做不到的空话。
    if (this.shells.size >= MAX_SHELLS) this.evictFinished();
    if (this.shells.size >= MAX_SHELLS) {
      // 走到这里说明全部都还在运行：此时 kill_shell 才是真正有效的建议
      // （kill 后条目转为已结束，下次 start 会被 evictFinished 回收）。
      throw new ToolError(
        t(
          `Too many background shells (${MAX_SHELLS}), all still running. Stop one you no longer need with kill_shell, then retry.`,
          `后台 shell 数量已达上限（${MAX_SHELLS}），且都在运行中。请用 kill_shell 停掉不再需要的，然后重试。`,
        ),
      );
    }
    let child: ChildProcess;
    try {
      child = spawn(opts.file, opts.args, {
        cwd: opts.cwd,
        env: sanitizedShellEnv(),
        // stdin 开管道：交互式进程（REPL/向导/等待确认的安装脚本）可经 write_stdin 喂输入。
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      throw new ToolError(`无法启动后台命令: ${(err as Error)?.message ?? err}`);
    }

    const id = `bash_${++seq}`;
    const entry: ShellEntry = {
      id,
      command: opts.command,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      child,
      pending: "",
      dropped: 0,
    };
    const onData = (buf: Buffer) => this.append(entry, buf.toString());
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      this.append(entry, `\n[启动/运行错误] ${err.message}\n`);
      if (entry.status === "running") {
        entry.status = "exited";
        entry.exitCode = null;
        entry.endedAt = Date.now();
      }
    });
    child.on("close", (code) => {
      // kill 过的保持 killed 语义，便于模型区分「自己杀的」与「自己退的」
      if (entry.status === "running") entry.status = "exited";
      entry.exitCode = code;
      entry.endedAt = Date.now();
    });
    // 后台进程不应拖住宿主退出；宿主退出时由 killAll 统一收尸（见文件末尾）。
    // stdio 管道在运行期是 Socket（有 unref），但静态类型只到 Readable —— 按能力探测调用：
    // 只 unref 子进程而不管管道，事件循环仍会被管道拖住，unref 就白做了。
    child.unref();
    unrefStream(child.stdin);
    unrefStream(child.stdout);
    unrefStream(child.stderr);

    this.shells.set(id, entry);
    return id;
  }

  /** 追加输出，超上限丢最旧的（日志场景最新的最有价值）。 */
  private append(entry: ShellEntry, text: string): void {
    entry.pending += text;
    if (entry.pending.length > MAX_PENDING_CHARS) {
      const excess = entry.pending.length - MAX_PENDING_CHARS;
      entry.pending = entry.pending.slice(excess);
      entry.dropped += excess;
    }
  }

  /** 读取自上次读取以来的新输出（读过即清空）。id 不存在返回 null。 */
  read(id: string, filter?: RegExp): ReadResult | null {
    const entry = this.shells.get(id);
    if (!entry) return null;
    let chunk = entry.pending;
    entry.pending = "";
    const dropped = entry.dropped;
    entry.dropped = 0;
    // filter 语义同 `tail -f | grep`：不匹配的行随本次读取一并消费掉。
    // 但绝不能"静默"丢 —— 否则模型用 filter 排查一次错误，就永远看不到 dev server
    // 打印过的端口号了。这里如实回报被略过的行数，让模型知道自己没看到全部。
    let filtered = 0;
    if (filter && chunk) {
      const lines = chunk.split("\n");
      // 末尾换行会切出一个空串元素；它不是"一行输出"，不能计入略过数，
      // 否则无输出/正常结尾时会凭空报出 1 行被略过。
      if (lines[lines.length - 1] === "") lines.pop();
      const kept = lines.filter((line) => filter.test(line));
      filtered = lines.length - kept.length;
      chunk = kept.join("\n");
    }
    if (chunk.length > MAX_READ_CHARS) {
      // 超出单次上限的部分留回缓冲，下次继续读 —— 不丢数据。
      // 放回后同样要守住缓冲上限，否则这条路径会绕过 append 的封顶。
      entry.pending = this.clampPending(chunk.slice(MAX_READ_CHARS) + entry.pending, entry);
      chunk = chunk.slice(0, MAX_READ_CHARS);
    }
    this.reap();
    return {
      chunk,
      status: entry.status,
      exitCode: entry.exitCode,
      dropped,
      filtered,
      command: entry.command,
    };
  }

  /** 守住待读缓冲上限：超出丢最旧的，并计入 dropped。 */
  private clampPending(text: string, entry: ShellEntry): string {
    if (text.length <= MAX_PENDING_CHARS) return text;
    const excess = text.length - MAX_PENDING_CHARS;
    entry.dropped += excess;
    return text.slice(excess);
  }

  /** 杀掉一个后台 shell（只能是本注册表内的）。返回 false 表示 id 不存在。 */
  kill(id: string): boolean {
    const entry = this.shells.get(id);
    if (!entry) return false;
    if (entry.status === "running") {
      entry.status = "killed";
      entry.endedAt = Date.now();
      try {
        entry.child.kill("SIGKILL");
      } catch {
        /* 已经死了 */
      }
    }
    return true;
  }

  /**
   * 向运行中 shell 的 stdin 写入（对齐 Codex unified_exec 的 write_stdin）。
   * end=true 时随后关闭 stdin（很多进程读到 EOF 才继续）。
   * 返回 false 表示 id 不存在；已结束/无 stdin 的抛 ToolError。
   */
  write(id: string, data: string, end = false): boolean {
    const entry = this.shells.get(id);
    if (!entry) return false;
    if (entry.status !== "running") {
      throw new ToolError(
        t(`Shell ${id} is not running (${entry.status})`, `shell ${id} 已不在运行（${entry.status}）`),
      );
    }
    const stdin = entry.child.stdin;
    if (!stdin || stdin.destroyed) {
      throw new ToolError(t(`Shell ${id} has no writable stdin`, `shell ${id} 的 stdin 不可写`));
    }
    stdin.write(data);
    if (end) stdin.end();
    return true;
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map((e) => ({
      id: e.id,
      command: e.command,
      status: e.status,
      exitCode: e.exitCode,
      startedAt: e.startedAt,
    }));
  }

  /** 回收：已结束、输出读净、且超过保留期的 shell。 */
  private reap(): void {
    const now = Date.now();
    for (const [id, e] of this.shells) {
      if (e.status === "running") continue;
      if (e.pending.length > 0) continue; // 还有输出没被读走，留着
      if (e.endedAt !== null && now - e.endedAt < REAP_AFTER_MS) continue;
      this.shells.delete(id);
    }
  }

  /** 容量不足时的兜底：按结束时间从早到晚淘汰已结束的 shell，直到腾出位置。 */
  private evictFinished(): void {
    const finished = [...this.shells.values()]
      .filter((e) => e.status !== "running")
      .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
    for (const e of finished) {
      if (this.shells.size < MAX_SHELLS) break;
      this.shells.delete(e.id);
    }
  }

  /** 杀掉全部（宿主退出 / 会话结束时调用）。 */
  killAll(): void {
    for (const e of this.shells.values()) {
      try {
        e.child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    this.shells.clear();
  }
}

/** 进程内共享注册表（见文件头：后台进程本就是进程级资源）。 */
export const shells = new ShellRegistry();

// 宿主退出时收尸，避免留下孤儿 dev server。unref 过的子进程不会拖住退出。
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  try {
    process.on("exit", () => shells.killAll());
  } catch {
    /* 无 process 环境 */
  }
}

// ---------- 工具 ----------

/** 供 bash 工具在 run_in_background=true 时调用。 */
export function startBackgroundShell(command: string, ctx: ToolContext): string {
  installExitHook();
  const { file, args } = buildShellSpawn(command, ctx.sandbox, ctx.cwd);
  const id = shells.start({ command, cwd: ctx.cwd, file, args });
  return t(
    `Started in background. shell id: ${id}\nRead new output with bash_output({ bash_id: "${id}" }); stop it with kill_shell({ shell_id: "${id}" }).`,
    `已在后台启动。shell id: ${id}\n用 bash_output({ bash_id: "${id}" }) 读取新输出；用 kill_shell({ shell_id: "${id}" }) 停止。`,
  );
}

export const bashOutputTool: Tool = {
  // 纯读取：只返回已产生的输出，不引发任何新副作用。
  readOnly: true,
  def: {
    name: "bash_output",
    description: t(
      "Read new output from a background shell started by bash(run_in_background). Returns only output produced since the last read, plus the shell's status. Optional regex filter keeps only matching lines (useful for noisy dev servers).",
      "读取 bash(run_in_background) 启动的后台 shell 的新输出。只返回自上次读取以来的新增内容，并附带运行状态。可选 filter 正则只保留匹配行（适合刷屏的 dev server）。",
    ),
    parameters: {
      type: "object",
      properties: {
        bash_id: { type: "string", description: t("The shell id", "shell id") },
        filter: {
          type: "string",
          description: t("Regex; keep only matching lines", "正则；只保留匹配的行"),
        },
      },
      required: ["bash_id"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["bash_id"] ?? ""),
  isConcurrencySafe: () => true,
  async run(input) {
    const id = String(input["bash_id"] ?? "");
    if (!id) throw new ToolError("bash_id 不能为空");
    let filter: RegExp | undefined;
    if (input["filter"]) {
      try {
        filter = new RegExp(String(input["filter"]));
      } catch (e: any) {
        throw new ToolError(`无效的 filter 正则: ${e?.message ?? e}`);
      }
    }
    const r = shells.read(id, filter);
    if (!r) {
      throw new ToolError(
        t(
          `Unknown shell id: ${id}. It may have been killed and reaped. Use bash(run_in_background) to start a new one.`,
          `未知的 shell id: ${id}。它可能已被结束并回收。可用 bash(run_in_background) 重新启动。`,
        ),
      );
    }
    // 状态头两种语言完全一致，无需 t()。
    const head = `[${r.status}${r.exitCode !== null ? ` exit=${r.exitCode}` : ""}] ${r.command}`;
    const notes: string[] = [];
    if (r.dropped > 0) {
      notes.push(
        t(
          `…(${r.dropped} chars of older output were dropped: buffer limit)`,
          `…（较早的 ${r.dropped} 字符输出因缓冲上限被丢弃）`,
        ),
      );
    }
    // filter 会连不匹配的行一起消费掉，如实告知，避免模型以为"没别的输出了"。
    if (r.filtered > 0) {
      notes.push(
        t(
          `…(${r.filtered} lines did not match the filter and were skipped; they are consumed and won't appear in later reads)`,
          `…（另有 ${r.filtered} 行不匹配 filter 已略过；它们已被消费，后续读取不会再出现）`,
        ),
      );
    }
    const body = r.chunk || t("(no new output)", "(无新输出)");
    return [head, ...notes, body].join("\n");
  },
};

export const writeStdinTool: Tool = {
  /**
   * 非只读：向一个已授权启动的进程喂输入仍可能触发新副作用（如在 REPL 里执行命令），
   * 走权限门。授权范围仍严格限于本注册表内、agent 自己启动的 shell。
   */
  readOnly: false,
  def: {
    name: "write_stdin",
    description: t(
      "Write input to a running background shell's stdin (for interactive processes: REPLs, prompts, installers waiting for confirmation). Set end=true to close stdin afterwards (EOF).",
      "向运行中的后台 shell 的 stdin 写入输入（用于交互式进程：REPL、等待确认的向导/安装脚本）。end=true 表示写完后关闭 stdin（发送 EOF）。",
    ),
    parameters: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: t("The shell id", "shell id") },
        input: {
          type: "string",
          description: t(
            "Text to write. Include a trailing \\n if the process reads line-by-line.",
            "要写入的文本。若进程按行读取，请自带结尾 \\n。",
          ),
        },
        end: {
          type: "boolean",
          description: t("Close stdin after writing (EOF)", "写入后关闭 stdin（EOF）"),
        },
      },
      required: ["shell_id", "input"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["shell_id"] ?? ""),
  async run(input) {
    const id = String(input["shell_id"] ?? "");
    if (!id) throw new ToolError("shell_id 不能为空");
    const data = String(input["input"] ?? "");
    const end = Boolean(input["end"]);
    if (!shells.write(id, data, end)) {
      throw new ToolError(t(`Unknown shell id: ${id}`, `未知的 shell id: ${id}`));
    }
    return t(
      `Wrote ${data.length} chars to ${id}${end ? " and closed stdin" : ""}. Read the process's response with bash_output.`,
      `已向 ${id} 写入 ${data.length} 字符${end ? "，并已关闭 stdin" : ""}。用 bash_output 读取进程的响应。`,
    );
  },
};

export const listShellsTool: Tool = {
  // 纯读取：只报告注册表状态。
  readOnly: true,
  def: {
    name: "list_shells",
    description: t(
      "List background shells started by bash(run_in_background): id, command, status, exit code.",
      "列出 bash(run_in_background) 启动的后台 shell：id、命令、状态、退出码。",
    ),
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  ruleKey: () => "list_shells",
  isConcurrencySafe: () => true,
  async run() {
    const all = shells.list();
    if (all.length === 0) return t("(no background shells)", "（无后台 shell）");
    return all
      .map(
        (s) =>
          `${s.id} [${s.status}${s.exitCode !== null ? ` exit=${s.exitCode}` : ""}] ${s.command}`,
      )
      .join("\n");
  },
};

export const killShellTool: Tool = {
  /**
   * 标记只读以自动放行：它只能终止**本注册表内、由 agent 自己启动且启动时已获授权**的
   * 进程，永远不接受任意 pid —— 授权范围严格小于启动时已批准的范围，且方向是「停止副作用」
   * 而非制造副作用。让清理需要二次确认只会逼出孤儿进程。
   */
  readOnly: true,
  def: {
    name: "kill_shell",
    description: t(
      "Terminate a background shell started by bash(run_in_background).",
      "终止一个由 bash(run_in_background) 启动的后台 shell。",
    ),
    parameters: {
      type: "object",
      properties: {
        shell_id: { type: "string", description: t("The shell id", "shell id") },
      },
      required: ["shell_id"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["shell_id"] ?? ""),
  isConcurrencySafe: () => true,
  async run(input) {
    const id = String(input["shell_id"] ?? "");
    if (!id) throw new ToolError("shell_id 不能为空");
    if (!shells.kill(id)) {
      throw new ToolError(t(`Unknown shell id: ${id}`, `未知的 shell id: ${id}`));
    }
    return t(`Killed background shell ${id}.`, `已终止后台 shell ${id}。`);
  },
};
