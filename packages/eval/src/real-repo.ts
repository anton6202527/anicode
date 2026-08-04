/** SWE-bench 真实仓库评测：固定 commit、答案隔离、真实 agent patch、官方 Docker harness。 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
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
import { EDIT_TOOLS } from "./task.js";
import { EvalTraceCollector, type EvalOutcome } from "./metrics.js";
import { commandAvailable, type TaskResult } from "./runner.js";

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
  /** 1-based repeated run number for stochastic stability analysis. */
  trial?: number;
  /** 测试/私有 runner 可替换仓库准备和评分，但不得把 reference patch 传给 agent。 */
  prepare?: (task: RealRepoEvalTask, directory: string) => Promise<void>;
  evaluate?: (input: {
    task: RealRepoEvalTask;
    modelPatch: string;
    runDirectory: string;
  }) => Promise<{
    passed: boolean;
    evidence?: {
      evaluator: "swebench";
      category: "passed" | "failed";
      outputSha256: string;
      outputChars: number;
    };
  }>;
}

export function runBoundedCommand(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs?: number;
    terminationGraceMs?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  } = {},
): Promise<{ code: number; output: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      resolve({ code: 124, output: "", timedOut: true });
      return;
    }
    const child = spawn(file, args, {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    let timedOut = false;
    const graceMs = Math.max(100, Math.min(5_000, options.terminationGraceMs ?? 500));
    let termination: Promise<void> | undefined;
    const timeoutMs = Math.max(1, options.timeoutMs ?? 30 * 60_000);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      resolve({ code, output: output.trim(), timedOut });
    };
    const requestTermination = () => {
      termination ??= terminateProcessTree(child, { graceMs });
      void termination.catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abort);
        reject(error);
      });
    };
    const abort = () => {
      timedOut = true;
      requestTermination();
    };
    const capture = (chunk: Buffer) => {
      if (output.length < 64_000) output += chunk.toString().slice(0, 64_000 - output.length);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const timeout = setTimeout(() => {
      timedOut = true;
      requestTermination();
    }, timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once("error", (error) => {
      output += String(error);
      finish(timedOut ? 124 : 127);
    });
    child.once("close", (code) => {
      void (async () => {
        if (!termination && process.platform !== "win32") {
          termination = terminateProcessTree(child, { graceMs });
        }
        await termination;
        finish(timedOut ? 124 : (code ?? 1));
      })().catch(reject);
    });
  });
}

async function prepareRepository(task: RealRepoEvalTask, directory: string): Promise<void> {
  const cloned = await runBoundedCommand(
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
  const checked = await runBoundedCommand("git", ["checkout", "--detach", task.baseCommit], {
    cwd: directory,
    timeoutMs: 5 * 60_000,
  });
  if (checked.code !== 0) throw new Error(`git checkout failed: ${checked.output.slice(-2_000)}`);
  await runBoundedCommand("git", ["remote", "remove", "origin"], { cwd: directory });
}

function canonicalRunId(instanceId: string): string {
  return `anicode-${instanceId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
}

function canonicalReportPath(
  evaluatorDirectory: string,
  runId: string,
  instanceId: string,
): string {
  return path.join(
    evaluatorDirectory,
    "logs",
    "run_evaluation",
    runId,
    "anicode",
    instanceId,
    "report.json",
  );
}

/** Read precisely the one report emitted by the harness, never any agent-writable JSON. */
export async function readCanonicalResolvedReport(
  evaluatorDirectory: string,
  runId: string,
  instanceId: string,
): Promise<boolean> {
  const reportPath = canonicalReportPath(evaluatorDirectory, runId, instanceId);
  const stat = await fs.lstat(reportPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("SWE-bench canonical report is not a regular file");
  }
  let report: unknown;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch {
    throw new Error("SWE-bench canonical report is not valid JSON");
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("SWE-bench canonical report must be an object");
  }
  const keys = Object.keys(report);
  if (keys.length !== 1 || keys[0] !== instanceId) {
    throw new Error("SWE-bench canonical report has an unexpected instance ID");
  }
  const record = (report as Record<string, unknown>)[instanceId];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("SWE-bench canonical report instance is malformed");
  }
  const resolved = (record as Record<string, unknown>).resolved;
  if (typeof resolved !== "boolean") {
    throw new Error("SWE-bench canonical report is missing a boolean resolved field");
  }
  return resolved;
}

export function redactedVerifierEvidence(
  output: string,
  passed: boolean,
): {
  evaluator: "swebench";
  category: "passed" | "failed";
  outputSha256: string;
  outputChars: number;
} {
  return {
    evaluator: "swebench",
    category: passed ? "passed" : "failed",
    outputSha256: createHash("sha256").update(output).digest("hex"),
    outputChars: output.length,
  };
}

async function officialEvaluator(input: {
  task: RealRepoEvalTask;
  modelPatch: string;
  evaluatorDirectory: string;
  python: string;
  timeoutMs: number;
}): Promise<{
  passed: boolean;
  evidence: {
    evaluator: "swebench";
    category: "passed" | "failed";
    outputSha256: string;
    outputChars: number;
  };
}> {
  const prediction = path.join(input.evaluatorDirectory, "prediction.json");
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
  const runId = canonicalRunId(input.task.instanceId);
  const evaluated = await runBoundedCommand(
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
    { cwd: input.evaluatorDirectory, timeoutMs: input.timeoutMs },
  );
  if (evaluated.timedOut) {
    throw new Error("SWE-bench evaluator timed out (exit 124)");
  }
  if (evaluated.code !== 0) {
    throw new Error(`SWE-bench evaluator exited with ${evaluated.code}`);
  }
  const passed = await readCanonicalResolvedReport(
    input.evaluatorDirectory,
    runId,
    input.task.instanceId,
  );
  return {
    passed,
    evidence: redactedVerifierEvidence(evaluated.output, passed),
  };
}

export async function missingRealRequirements(python = "python3"): Promise<string[]> {
  const missing = ["git", "docker", python].filter((bin) => !commandAvailable(bin));
  if (!missing.includes(python)) {
    const module = await runBoundedCommand(python, ["-c", "import swebench"], {
      timeoutMs: 10_000,
      env: sanitizedShellEnv(),
    }).catch(() => null);
    if (!module || module.code !== 0) missing.push(`${python}:swebench`);
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
  // The agent's sandbox is mounted at workspace only. Harness reports are written to this sibling
  // directory after the drive has finished, so model tools cannot manufacture a passing report.
  const evaluatorDirectory = path.join(runDirectory, "evaluator");
  const metrics = { turns: 0, toolCalls: 0, editCalls: 0, editErrors: 0, toolErrors: 0 };
  const usage = { input: 0, output: 0 };
  const trial = Math.max(1, Math.floor(options.trial ?? 1));
  const trace = new EvalTraceCollector();
  let agent: Agent | undefined;
  let costUSD: number | undefined;
  let agentError: string | undefined;
  try {
    await (options.prepare ?? prepareRepository)(task, workspace);
    await fs.mkdir(evaluatorDirectory, { recursive: true, mode: 0o700 });
    agent = new Agent({
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
    const abort = new AbortController();
    const drive = (async () => {
      for await (const event of agent.send(task.prompt, abort.signal)) {
        trace.record(event);
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
          costUSD = event.costUSD;
        } else if (event.type === "error") agentError = event.message;
      }
    })();
    const timeoutMs = options.timeoutMs ?? 10 * 60_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const terminal = await Promise.race([
        drive.then(() => "done" as const),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), timeoutMs);
        }),
      ]);
      if (terminal === "timeout") {
        abort.abort(new Error(`real task timeout ${timeoutMs}ms`));
        // A provider may ignore AbortSignal. Do not let it keep this task (or its shard) alive.
        void drive.catch(() => undefined);
        throw new Error(`real task timeout ${timeoutMs}ms`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    const diff = await runBoundedCommand(
      "git",
      ["diff", "--binary", "--no-ext-diff", task.baseCommit],
      {
        cwd: workspace,
        timeoutMs: 60_000,
      },
    );
    if (diff.code !== 0) throw new Error(`git diff failed: ${diff.output.slice(-2_000)}`);
    const evaluated = options.evaluate
      ? await options.evaluate({ task, modelPatch: diff.output, runDirectory })
      : await officialEvaluator({
          task,
          modelPatch: diff.output,
          evaluatorDirectory,
          python: options.python ?? "python3",
          timeoutMs: options.evaluatorTimeoutMs ?? 45 * 60_000,
        });
    const outcome: EvalOutcome = {
      status: evaluated.passed ? "passed" : "failed",
      verified: true,
      evaluator: "swebench",
      patchBytes: Buffer.byteLength(diff.output),
    };
    const observed = trace.finish(agent.messages, outcome.status);
    return {
      id: task.id,
      title: `${task.repo} · ${task.instanceId}`,
      trial,
      passed: evaluated.passed,
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
      ...(agentError ? { error: agentError } : {}),
      ...(evaluated.evidence ? { verificationEvidence: evaluated.evidence } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /timeout/i.test(message) ? "timeout" : "agent_error";
    const observed = trace.finish(agent?.messages ?? [], status);
    return {
      id: task.id,
      title: `${task.repo} · ${task.instanceId}`,
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
      outcome: { status, verified: false, evaluator: "swebench" },
      ...observed,
      error: message,
    };
  } finally {
    if (!options.keepWorkspace) await fs.rm(runDirectory, { recursive: true, force: true });
    else console.error(`保留真实评测工作区: ${runDirectory}`);
  }
}
