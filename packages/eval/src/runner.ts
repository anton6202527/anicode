/**
 * 单任务运行器：把种子文件铺进一个临时工作目录 → 用真实 Agent（全套默认工具、
 * 权限 bypass）跑指令 → 执行任务自带的校验命令 → 汇总指标。
 *
 * 关键点：走的是 core 里真正的 agent loop 与工具链路（不是打桩），所以指标反映的是
 * 实际编辑行为。provider 可注入——真实评测传 createProvider 的结果，离线自测传脚本化 provider。
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, defaultTools, type AgentModelInfo, type Provider } from "@anicode/core";
import { EDIT_TOOLS, type EvalTask } from "./task.js";

export interface RunOptions {
  provider: Provider;
  model: string;
  modelInfo?: AgentModelInfo;
  /** 单任务最大轮数（防跑飞），默认 30。 */
  maxTurns?: number;
  /** 每个任务的整体墙钟超时（毫秒），默认 180s。 */
  timeoutMs?: number;
}

export interface TaskResult {
  id: string;
  title: string;
  /** 校验命令退出码 0 → 通过。 */
  passed: boolean;
  /** 整个 loop 的模型轮数。 */
  turns: number;
  toolCalls: number;
  editCalls: number;
  /** 编辑类工具返回 isError 的次数——「编辑失败率」的分子。 */
  editErrors: number;
  toolErrors: number;
  inputTokens: number;
  outputTokens: number;
  wallMs: number;
  /** agent/超时/校验的失败原因（若有）。 */
  error?: string;
  /** 校验命令的 stdout/stderr 尾巴，便于排查未通过原因。 */
  verifyOutput?: string;
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
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(verify.cmd, verify.args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const cap = (b: Buffer) => {
      if (output.length < 4096) output += b.toString();
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("error", (e) => resolve({ code: 127, output: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, output: output.trim() }));
  });
}

export async function runTask(task: EvalTask, opts: RunOptions): Promise<TaskResult> {
  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `anicode-eval-${task.id}-`));
  const metrics = { turns: 0, toolCalls: 0, editCalls: 0, editErrors: 0, toolErrors: 0 };
  const usage = { input: 0, output: 0 };
  let error: string | undefined;

  try {
    await writeSeed(dir, task.files);

    const agent = new Agent({
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
    });

    const drive = (async () => {
      for await (const ev of agent.send(task.prompt)) {
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
            break;
          case "error":
            error = ev.message;
            break;
        }
      }
    })();

    const timeoutMs = opts.timeoutMs ?? 180_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`任务超时 ${timeoutMs}ms`)), timeoutMs);
    });
    try {
      await Promise.race([drive, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const verify = await runVerify(dir, task.verify);
    return {
      id: task.id,
      title: task.title,
      passed: verify.code === 0,
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      editCalls: metrics.editCalls,
      editErrors: metrics.editErrors,
      toolErrors: metrics.toolErrors,
      inputTokens: usage.input,
      outputTokens: usage.output,
      wallMs: Date.now() - started,
      ...(error ? { error } : {}),
      ...(verify.code !== 0 ? { verifyOutput: verify.output } : {}),
    };
  } catch (e) {
    return {
      id: task.id,
      title: task.title,
      passed: false,
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      editCalls: metrics.editCalls,
      editErrors: metrics.editErrors,
      toolErrors: metrics.toolErrors,
      inputTokens: usage.input,
      outputTokens: usage.output,
      wallMs: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
