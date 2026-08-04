/**
 * 单任务运行器：把种子文件铺进一个临时工作目录 → 用真实 Agent（全套默认工具、
 * 权限 bypass）跑指令 → 执行任务自带的校验命令 → 汇总指标。
 *
 * 关键点：走的是 core 里真正的 agent loop 与工具链路（不是打桩），所以指标反映的是
 * 实际编辑行为。provider 可注入——真实评测传 createProvider 的结果，离线自测传脚本化 provider。
 */
import { spawn } from "node:child_process";
import { accessSync, constants, promises as fs, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Agent,
  defaultTools,
  sanitizedShellEnv,
  terminateProcessTree,
  type AgentModelInfo,
  type ExecutionRuntime,
  type NetworkProxy,
  type Provider,
  type Telemetry,
} from "@anicode/core";
import {
  EvalTraceCollector,
  type EvalOutcome,
  type FinalResponseMetrics,
  type TrajectoryMetrics,
} from "./metrics.js";
import { EDIT_TOOLS, verifyFilesOf, type EvalTask } from "./task.js";

export interface RunOptions {
  provider: Provider;
  model: string;
  modelInfo?: AgentModelInfo;
  /** 单任务最大轮数（防跑飞），默认 30。 */
  maxTurns?: number;
  /** 每个任务的整体墙钟超时（毫秒），默认 180s。 */
  timeoutMs?: number;
  /** Deterministic verifier wall-clock timeout (defaults to 60s). */
  verifyTimeoutMs?: number;
  /** 给 Agent 开 repo map（system 注入代码地图）——用于 A/B 对比 scaffolding 效果。 */
  repomap?: boolean;
  /** 与生产宿主相同的 OS/OCI 执行边界；模型发起的 Bash 不得裸 spawn。 */
  isolatedRuntime?: ExecutionRuntime;
  /** 内建 HTTP 工具与 provider 使用的策略出口。 */
  networkProxy?: NetworkProxy;
  telemetry?: Telemetry;
  /** 1-based repeated run number for stochastic stability analysis. */
  trial?: number;
}

const binCache = new Map<string, boolean>();

/** PATH lookup without executing repository-controlled shell helpers or leaving child processes. */
export function commandAvailable(command: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathValue = env.PATH ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  const hasExtension = path.extname(command).length > 0;
  const names =
    process.platform === "win32" && !hasExtension ? extensions.map((e) => command + e) : [command];
  const directories = command.includes(path.sep)
    ? [""]
    : pathValue.split(path.delimiter).map((entry) => entry || process.cwd());
  for (const directory of directories) {
    for (const name of names) {
      const candidate = directory ? path.join(directory, name) : path.resolve(name);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (process.platform !== "win32") accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        // Keep searching PATH.
      }
    }
  }
  return false;
}

/** 返回任务 requires 里在 PATH 上找不到的可执行文件（空数组 = 依赖齐全）。 */
export function missingRequirements(task: EvalTask): string[] {
  return (task.requires ?? []).filter((bin) => {
    let ok = binCache.get(bin);
    if (ok === undefined) {
      ok = commandAvailable(bin);
      binCache.set(bin, ok);
    }
    return !ok;
  });
}

/** 生成一条「因缺工具链而跳过」的结果记录。 */
export function skippedResult(task: EvalTask, missing: string[], trial = 1): TaskResult {
  const observed = new EvalTraceCollector().finish([], "skipped");
  return {
    id: task.id,
    title: task.title,
    trial,
    passed: false,
    skipped: true,
    turns: 0,
    toolCalls: 0,
    editCalls: 0,
    editErrors: 0,
    toolErrors: 0,
    inputTokens: 0,
    outputTokens: 0,
    wallMs: 0,
    outcome: { status: "skipped", verified: false, evaluator: "requirements" },
    ...observed,
    error: `缺工具链: ${missing.join(", ")}`,
  };
}

export interface TaskResult {
  id: string;
  title: string;
  /** 1-based trial index; defaults to 1 when reading legacy reports. */
  trial: number;
  /** 校验命令退出码 0 → 通过。 */
  passed: boolean;
  /** 因缺工具链等原因未真正运行——不计入通过率分母。 */
  skipped?: boolean;
  /** 整个 loop 的模型轮数。 */
  turns: number;
  toolCalls: number;
  editCalls: number;
  /** 编辑类工具返回 isError 的次数——「编辑失败率」的分子。 */
  editErrors: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  costUSD?: number;
  wallMs: number;
  outcome: EvalOutcome;
  trajectory: TrajectoryMetrics;
  finalResponse: FinalResponseMetrics;
  /** agent/超时/校验的失败原因（若有）。 */
  error?: string;
  /** 校验命令的 stdout/stderr 尾巴，便于排查未通过原因。 */
  verifyOutput?: string;
  /** Privacy-preserving verifier evidence for real-repository runs. */
  verificationEvidence?: {
    evaluator: "swebench";
    category: "passed" | "failed";
    outputSha256: string;
    outputChars: number;
  };
}

async function writeSeed(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

function runVerify(
  dir: string,
  verify: EvalTask["verify"],
  timeoutMs: number,
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(verify.cmd, verify.args, {
      cwd: dir,
      env: sanitizedShellEnv(),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    let termination: Promise<void> | undefined;
    const cap = (b: Buffer) => {
      if (output.length < 4096) output += b.toString().slice(0, 4096 - output.length);
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    const timer = setTimeout(() => {
      timedOut = true;
      termination ??= terminateProcessTree(child, { graceMs: 250 });
      void termination.catch(reject);
    }, timeoutMs);
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: 127, output: String(e) });
    });
    child.on("close", (code) => {
      void (async () => {
        if (!termination && process.platform !== "win32") {
          termination = terminateProcessTree(child, { graceMs: 250 });
        }
        await termination;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          code: timedOut ? 124 : (code ?? 1),
          output: `${timedOut ? `[timeout ${timeoutMs}ms]\n` : ""}${output.trim()}`,
        });
      })().catch(reject);
    });
  });
}

export async function runTask(task: EvalTask, opts: RunOptions): Promise<TaskResult> {
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `anicode-eval-${task.id}-`));
  const metrics = { turns: 0, toolCalls: 0, editCalls: 0, editErrors: 0, toolErrors: 0 };
  const usage = { input: 0, output: 0 };
  const trial = Math.max(1, Math.floor(opts.trial ?? 1));
  const trace = new EvalTraceCollector();
  let agent: Agent | undefined;
  let costUSD: number | undefined;
  let error: string | undefined;

  try {
    await writeSeed(dir, task.files);

    agent = new Agent({
      provider: opts.provider,
      model: opts.model,
      ...(opts.modelInfo ? { modelInfo: opts.modelInfo } : {}),
      cwd: dir,
      tools: defaultTools(),
      // 评测在一次性临时目录里跑：全自动放行（bypass），不做交互授权。
      permission: { mode: "bypass" },
      projectMemory: false,
      injectEnv: false,
      maxTurns: opts.maxTurns ?? 30,
      ...(opts.isolatedRuntime ? { isolatedRuntime: opts.isolatedRuntime } : {}),
      ...(opts.networkProxy ? { networkProxy: opts.networkProxy } : {}),
      ...(opts.telemetry ? { telemetry: opts.telemetry } : {}),
      ...(opts.repomap ? { repoMap: true } : {}),
    });

    const abort = new AbortController();
    const drive = (async () => {
      for await (const ev of agent.send(task.prompt, abort.signal)) {
        trace.record(ev);
        switch (ev.type) {
          case "tool_start":
            metrics.toolCalls++;
            if (EDIT_TOOLS.has(ev.name)) metrics.editCalls++;
            break;
          case "tool_result":
            if (ev.isError) {
              metrics.toolErrors++;
              if (EDIT_TOOLS.has(ev.name)) metrics.editErrors++;
            }
            break;
          case "done":
            metrics.turns = ev.turns;
            usage.input = ev.usage.inputTokens;
            usage.output = ev.usage.outputTokens;
            costUSD = ev.costUSD;
            break;
          case "error":
            error = ev.message;
            break;
        }
      }
    })();

    const timeoutMs = opts.timeoutMs ?? 180_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    try {
      const terminal = await Promise.race([drive.then(() => "done" as const), timeout]);
      if (terminal === "timeout") {
        abort.abort(new Error(`任务超时 ${timeoutMs}ms`));
        // A provider may ignore AbortSignal; the task must still return at its deadline.
        void drive.catch(() => undefined);
        throw new Error(`任务超时 ${timeoutMs}ms`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    // 防作弊：跑校验前把校验相关文件从种子恢复（agent 改校验脚本不算通过）。
    const protectedFiles = verifyFilesOf(task);
    if (protectedFiles.length > 0) {
      await writeSeed(dir, Object.fromEntries(protectedFiles.map((f) => [f, task.files[f] ?? ""])));
    }
    const verify = await runVerify(dir, task.verify, opts.verifyTimeoutMs ?? 60_000);
    const outcome: EvalOutcome = {
      status: verify.code === 0 ? "passed" : "failed",
      verified: true,
      evaluator: "command",
      exitCode: verify.code,
    };
    const observed = trace.finish(agent.messages, outcome.status);
    return {
      id: task.id,
      title: task.title,
      trial,
      passed: verify.code === 0,
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      editCalls: metrics.editCalls,
      editErrors: metrics.editErrors,
      toolErrors: metrics.toolErrors,
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(costUSD !== undefined ? { costUSD } : {}),
      wallMs: Date.now() - started,
      outcome,
      ...observed,
      ...(error ? { error } : {}),
      ...(verify.code !== 0 ? { verifyOutput: verify.output } : {}),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const status = /(?:任务超时|timeout)/i.test(message) ? "timeout" : "agent_error";
    const observed = trace.finish(agent?.messages ?? [], status);
    return {
      id: task.id,
      title: task.title,
      trial,
      passed: false,
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      editCalls: metrics.editCalls,
      editErrors: metrics.editErrors,
      toolErrors: metrics.toolErrors,
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(costUSD !== undefined ? { costUSD } : {}),
      wallMs: Date.now() - started,
      outcome: { status, verified: false, evaluator: "command" },
      ...observed,
      error: message,
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
