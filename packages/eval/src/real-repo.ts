/** SWE-bench 真实仓库评测：固定 commit、答案隔离、真实 agent patch、官方 Docker harness。 */

import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  Agent,
  defaultTools,
  type AgentModelInfo,
  type ExecutionRuntime,
  type NetworkProxy,
  type Provider,
  type Telemetry,
} from "@anicode/core";
import { EDIT_TOOLS } from "./task.js";
import type { TaskResult } from "./runner.js";

export interface RealRepoEvalTask {
  id: string;
  sourceDataset: "SWE-bench/SWE-bench_Multilingual" | "SWE-bench/SWE-bench_Verified";
  rowIndex: number;
  instanceId: string;
  repo: string;
  baseCommit: string;
  language: string;
  prompt: string;
  failToPass: string[];
  passToPass: string[];
}

export interface RealRepoRunOptions {
  provider: Provider;
  model: string;
  modelInfo?: AgentModelInfo;
  maxTurns?: number;
  timeoutMs?: number;
  evaluatorTimeoutMs?: number;
  repomap?: boolean;
  python?: string;
  keepWorkspace?: boolean;
  isolatedRuntime?: ExecutionRuntime;
  networkProxy?: NetworkProxy;
  telemetry?: Telemetry;
  /** 测试/私有 runner 可替换仓库准备和评分，但不得把 reference patch 传给 agent。 */
  prepare?: (task: RealRepoEvalTask, directory: string) => Promise<void>;
  evaluate?: (input: {
    task: RealRepoEvalTask;
    modelPatch: string;
    runDirectory: string;
  }) => Promise<{ passed: boolean; output?: string }>;
}

function command(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      if (output.length < 64_000) output += chunk.toString().slice(0, 64_000 - output.length);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 30 * 60_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, output: String(error) });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, output: output.trim() });
    });
  });
}

async function prepareRepository(task: RealRepoEvalTask, directory: string): Promise<void> {
  const cloned = await command(
    "git",
    [
      "clone",
      "--filter=blob:none",
      "--no-checkout",
      `https://github.com/${task.repo}.git`,
      directory,
    ],
    { timeoutMs: 10 * 60_000 },
  );
  if (cloned.code !== 0) throw new Error(`git clone failed: ${cloned.output.slice(-2_000)}`);
  const checked = await command("git", ["checkout", "--detach", task.baseCommit], {
    cwd: directory,
    timeoutMs: 5 * 60_000,
  });
  if (checked.code !== 0) throw new Error(`git checkout failed: ${checked.output.slice(-2_000)}`);
  await command("git", ["remote", "remove", "origin"], { cwd: directory });
}

async function findResolved(root: string, instanceId: string): Promise<boolean> {
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.name.endsWith(".json")) {
        try {
          const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
          const record = value[instanceId] ?? value;
          if (
            record &&
            typeof record === "object" &&
            (record as Record<string, unknown>)["resolved"] === true
          ) {
            return true;
          }
        } catch {
          // 不是 report JSON。
        }
      }
    }
  }
  return false;
}

async function officialEvaluator(input: {
  task: RealRepoEvalTask;
  modelPatch: string;
  runDirectory: string;
  python: string;
  timeoutMs: number;
}): Promise<{ passed: boolean; output?: string }> {
  const prediction = path.join(input.runDirectory, "prediction.json");
  await fs.writeFile(
    prediction,
    JSON.stringify([
      {
        instance_id: input.task.instanceId,
        model_name_or_path: "anicode",
        model_patch: input.modelPatch,
      },
    ]),
    "utf8",
  );
  const runId = `anicode-${input.task.instanceId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
  const evaluated = await command(
    input.python,
    [
      "-m",
      "swebench.harness.run_evaluation",
      "--dataset_name",
      input.task.sourceDataset,
      "--predictions_path",
      prediction,
      "--max_workers",
      "1",
      "--run_id",
      runId,
      "--instance_ids",
      input.task.instanceId,
    ],
    { cwd: input.runDirectory, timeoutMs: input.timeoutMs },
  );
  const passed = await findResolved(input.runDirectory, input.task.instanceId);
  return { passed, output: evaluated.output.slice(-8_000) };
}

export function missingRealRequirements(python = "python3"): string[] {
  const missing = ["git", "docker", python].filter(
    (bin) =>
      spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" })
        .status !== 0,
  );
  if (!missing.includes(python)) {
    const module = spawnSync(python, ["-c", "import swebench"], { stdio: "ignore" });
    if (module.status !== 0) missing.push(`${python}:swebench`);
  }
  return missing;
}

export async function runRealRepoTask(
  task: RealRepoEvalTask,
  options: RealRepoRunOptions,
): Promise<TaskResult> {
  const started = Date.now();
  const runDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `anicode-real-${task.instanceId}-`));
  const workspace = path.join(runDirectory, "repo");
  const metrics = { turns: 0, toolCalls: 0, editCalls: 0, editErrors: 0, toolErrors: 0 };
  const usage = { input: 0, output: 0 };
  let agentError: string | undefined;
  try {
    await (options.prepare ?? prepareRepository)(task, workspace);
    const agent = new Agent({
      provider: options.provider,
      model: options.model,
      ...(options.modelInfo ? { modelInfo: options.modelInfo } : {}),
      cwd: workspace,
      tools: defaultTools(),
      permission: { mode: "bypass" },
      projectMemory: false,
      injectEnv: false,
      maxTurns: options.maxTurns ?? 40,
      ...(options.isolatedRuntime ? { isolatedRuntime: options.isolatedRuntime } : {}),
      ...(options.networkProxy ? { networkProxy: options.networkProxy } : {}),
      ...(options.telemetry ? { telemetry: options.telemetry } : {}),
      ...(options.repomap ? { repoMap: true } : {}),
    });
    const drive = (async () => {
      for await (const event of agent.send(task.prompt)) {
        if (event.type === "tool_start") {
          metrics.toolCalls++;
          if (EDIT_TOOLS.has(event.name)) metrics.editCalls++;
        } else if (event.type === "tool_result" && event.isError) {
          metrics.toolErrors++;
          if (EDIT_TOOLS.has(event.name)) metrics.editErrors++;
        } else if (event.type === "done") {
          metrics.turns = event.turns;
          usage.input = event.usage.inputTokens;
          usage.output = event.usage.outputTokens;
        } else if (event.type === "error") agentError = event.message;
      }
    })();
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        drive,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`real task timeout ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const diff = await command("git", ["diff", "--binary", "--no-ext-diff", task.baseCommit], {
      cwd: workspace,
      timeoutMs: 60_000,
    });
    if (diff.code !== 0) throw new Error(`git diff failed: ${diff.output.slice(-2_000)}`);
    const evaluated = options.evaluate
      ? await options.evaluate({ task, modelPatch: diff.output, runDirectory })
      : await officialEvaluator({
          task,
          modelPatch: diff.output,
          runDirectory,
          python: options.python ?? "python3",
          timeoutMs: options.evaluatorTimeoutMs ?? 45 * 60_000,
        });
    return {
      id: task.id,
      title: `${task.repo} · ${task.instanceId}`,
      passed: evaluated.passed,
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      editCalls: metrics.editCalls,
      editErrors: metrics.editErrors,
      toolErrors: metrics.toolErrors,
      inputTokens: usage.input,
      outputTokens: usage.output,
      wallMs: Date.now() - started,
      ...(agentError ? { error: agentError } : {}),
      ...(!evaluated.passed && evaluated.output ? { verifyOutput: evaluated.output } : {}),
    };
  } catch (error) {
    return {
      id: task.id,
      title: `${task.repo} · ${task.instanceId}`,
      passed: false,
      turns: metrics.turns,
      toolCalls: metrics.toolCalls,
      editCalls: metrics.editCalls,
      editErrors: metrics.editErrors,
      toolErrors: metrics.toolErrors,
      inputTokens: usage.input,
      outputTokens: usage.output,
      wallMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (!options.keepWorkspace) await fs.rm(runDirectory, { recursive: true, force: true });
    else console.error(`保留真实评测工作区: ${runDirectory}`);
  }
}
