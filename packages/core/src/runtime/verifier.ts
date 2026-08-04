/** 确定性 Verifier：命令由策略声明，模型只能消费结果，不能自称“已验证”。 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";
import type { ExecutionRuntime } from "./isolated-runtime.js";
import { TaskScheduler, type ScheduledTask } from "./scheduler.js";
import { withDiscardedWorkspace } from "./transactional-runtime.js";
import { workspaceRevisionDigest } from "./workspace-revision.js";

export interface VerificationCheck {
  id: string;
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  required?: boolean;
  dependencies?: string[];
  /** 有改动文件时，仅匹配到这些后缀的检查才运行。 */
  fileExtensions?: string[];
}

export interface VerificationPolicy {
  checks: VerificationCheck[];
  concurrency?: number;
  outputLimitChars?: number;
}

export interface VerificationCheckResult {
  id: string;
  status: "passed" | "failed" | "skipped" | "cancelled";
  required: boolean;
  command: string;
  exitCode?: number;
  durationMs: number;
  output: string;
  reason?: string;
}

export interface VerificationReport {
  id: string;
  status: "passed" | "failed" | "skipped" | "cancelled";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  checks: VerificationCheckResult[];
  summary: string;
  /** Evidence is valid only for this exact real-workspace revision. */
  workspaceRevisionBefore?: string;
  workspaceRevisionAfter?: string;
}

export interface VerifierOptions {
  policy?: VerificationPolicy;
  autoDiscover?: boolean;
  /** 必须显式注入受控执行后端；Verifier 永不回退到宿主 raw spawn。 */
  executionRuntime?: ExecutionRuntime;
}

async function discoverChecks(cwd: string): Promise<VerificationCheck[]> {
  try {
    const manifest = path.join(cwd, "package.json");
    const stat = await fs.lstat(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      throw new Error("package.json must be a regular file no larger than 1 MiB");
    }
    const pkg = JSON.parse(await fs.readFile(manifest, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};
    return ["typecheck", "test", "lint"]
      .filter((name) => scripts[name])
      .map((name) => ({
        id: name,
        command: "npm",
        args: ["run", name, "--if-present"],
        required: name !== "lint",
        timeoutMs: name === "test" ? 180_000 : 120_000,
      }));
  } catch {
    return [];
  }
}

async function runCheck(
  check: VerificationCheck,
  cwd: string,
  outputLimit: number,
  signal: AbortSignal,
  executionRuntime: ExecutionRuntime | undefined,
): Promise<VerificationCheckResult> {
  const started = Date.now();
  const commandText = [check.command, ...(check.args ?? [])].join(" ");
  const base = {
    id: check.id,
    required: check.required ?? true,
    command: commandText,
  };
  if (signal.aborted) {
    return { ...base, status: "cancelled", durationMs: 0, output: "" };
  }
  if (!executionRuntime) {
    return {
      ...base,
      status: "failed",
      durationMs: Date.now() - started,
      output: "",
      reason: "Verifier execution runtime is not configured; raw process fallback is forbidden",
    };
  }

  const workspace = await canonical(cwd);
  const checkCwd = await canonical(check.cwd ? path.resolve(workspace, check.cwd) : workspace);
  if (!isWithin(workspace, checkCwd)) {
    return {
      ...base,
      status: "failed",
      durationMs: Date.now() - started,
      output: "",
      reason: `Verification cwd escapes the workspace: ${check.cwd}`,
    };
  }
  const timeoutMs = Math.max(1_000, check.timeoutMs ?? 120_000);
  try {
    const result = await executionRuntime.run({
      command: [check.command, ...(check.args ?? [])].map(shellQuote).join(" "),
      cwd: checkCwd,
      policy: "workspace-write",
      network: false,
      timeoutMs,
      signal,
      env: sanitizedShellEnv(),
    });
    const output = result.output.slice(0, outputLimit).trim();
    if (signal.aborted) {
      return {
        ...base,
        status: "cancelled",
        durationMs: Date.now() - started,
        output,
      };
    }
    return {
      ...base,
      status: result.exitCode === 0 && !result.timedOut ? "passed" : "failed",
      exitCode: result.exitCode ?? 1,
      durationMs: Date.now() - started,
      output,
      ...(result.timedOut ? { reason: `timeout after ${timeoutMs}ms` } : {}),
    };
  } catch (error) {
    return {
      ...base,
      status: signal.aborted ? "cancelled" : "failed",
      durationMs: Date.now() - started,
      output: "",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export class Verifier {
  constructor(private readonly options: VerifierOptions = {}) {}

  async verify(input: {
    cwd: string;
    changedFiles?: string[];
    signal?: AbortSignal;
  }): Promise<VerificationReport> {
    const started = Date.now();
    const startedAt = new Date(started).toISOString();
    const signal = input.signal ?? new AbortController().signal;
    const configured = this.options.policy?.checks ?? [];
    const checks =
      configured.length > 0
        ? configured
        : this.options.autoDiscover
          ? await discoverChecks(input.cwd)
          : [];
    const applicable = checks.filter((check) => {
      if (!check.fileExtensions?.length || !input.changedFiles?.length) return true;
      return input.changedFiles.some((file) => check.fileExtensions!.includes(path.extname(file)));
    });

    if (applicable.length === 0) {
      const finishedAt = new Date().toISOString();
      return {
        id: `verify_${started.toString(36)}`,
        status: signal.aborted ? "cancelled" : "failed",
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        checks: [],
        summary: "No applicable verification evidence is configured for this change.",
      };
    }
    if (!applicable.some((check) => check.required ?? true)) {
      const finishedAt = new Date().toISOString();
      return {
        id: `verify_${started.toString(36)}`,
        status: signal.aborted ? "cancelled" : "failed",
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        checks: [
          verificationBoundaryFailure(
            new Error("No applicable required verification check is configured"),
            0,
          ),
        ],
        summary: "No required verification evidence is configured for this change.",
      };
    }

    let workspaceRevisionBefore: string;
    try {
      workspaceRevisionBefore = await workspaceRevisionDigest(
        input.cwd,
        input.changedFiles,
        signal,
      );
    } catch (error) {
      const finishedAt = new Date().toISOString();
      return {
        id: `verify_${started.toString(36)}`,
        status: signal.aborted ? "cancelled" : "failed",
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        checks: [revisionFailure(error, 0)],
        summary: "Workspace revision could not be captured before verification.",
      };
    }

    const outputLimit = Math.max(1_000, this.options.policy?.outputLimitChars ?? 20_000);
    let results: VerificationCheckResult[];
    try {
      if (!this.options.executionRuntime) {
        results = await executeChecks(applicable, input.cwd, outputLimit, signal, undefined, 2);
      } else {
        results = await withDiscardedWorkspace(
          this.options.executionRuntime,
          input.cwd,
          signal,
          (runtime, stagedCwd) =>
            executeChecks(
              applicable,
              stagedCwd,
              outputLimit,
              signal,
              runtime,
              this.options.policy?.concurrency ?? 2,
            ),
        );
      }
    } catch (error) {
      results = [verificationBoundaryFailure(error, Date.now() - started)];
    }
    let workspaceRevisionAfter: string | undefined;
    try {
      workspaceRevisionAfter = await workspaceRevisionDigest(input.cwd, input.changedFiles, signal);
      if (workspaceRevisionAfter !== workspaceRevisionBefore) {
        results.push(
          revisionFailure(
            new Error(
              `Workspace changed during verification (${workspaceRevisionBefore} -> ${workspaceRevisionAfter})`,
            ),
            Date.now() - started,
          ),
        );
      }
    } catch (error) {
      results.push(revisionFailure(error, Date.now() - started));
    }
    const requiredFailure = results.some((result) => result.required && result.status !== "passed");
    const status = signal.aborted ? "cancelled" : requiredFailure ? "failed" : "passed";
    const finishedAt = new Date().toISOString();
    const passed = results.filter((result) => result.status === "passed").length;
    return {
      id: `verify_${started.toString(36)}`,
      status,
      startedAt,
      finishedAt,
      durationMs: Date.now() - started,
      checks: results,
      summary: `${passed}/${results.length} checks passed${requiredFailure ? "; required checks failed" : ""}.`,
      workspaceRevisionBefore,
      ...(workspaceRevisionAfter ? { workspaceRevisionAfter } : {}),
    };
  }
}

async function executeChecks(
  checks: readonly VerificationCheck[],
  cwd: string,
  outputLimit: number,
  signal: AbortSignal,
  executionRuntime: ExecutionRuntime | undefined,
  concurrency: number,
): Promise<VerificationCheckResult[]> {
  const scheduler = new TaskScheduler({ concurrency });
  const observed = new Map<string, VerificationCheckResult>();
  const tasks: ScheduledTask<VerificationCheckResult>[] = checks.map((check) => ({
    id: check.id,
    ...(check.dependencies?.length ? { dependencies: check.dependencies } : {}),
    // Every check may write build/cache outputs inside the shared disposable clone. Serialize the
    // workspace so typecheck/test/lint cannot race each other's generated evidence.
    resources: [{ key: "workspace", mode: "write" }],
    run: async ({ signal: taskSignal }) => {
      const result = await runCheck(check, cwd, outputLimit, taskSignal, executionRuntime);
      observed.set(check.id, result);
      if (result.status !== "passed") throw new Error(result.reason ?? result.status);
      return result;
    },
  }));
  const scheduled = await scheduler.run(tasks, signal);
  return checks.map((check) => {
    const task = scheduled.tasks[check.id]!;
    const observedResult = observed.get(check.id);
    if (observedResult) return observedResult;
    if (task.value) return task.value as VerificationCheckResult;
    return {
      id: check.id,
      status: task.state === "cancelled" ? ("cancelled" as const) : ("skipped" as const),
      required: check.required ?? true,
      command: [check.command, ...(check.args ?? [])].join(" "),
      durationMs: 0,
      output: "",
      ...(task.error ? { reason: task.error } : {}),
    };
  });
}

async function canonical(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function revisionFailure(error: unknown, durationMs: number): VerificationCheckResult {
  return {
    id: "anicode.workspace-revision",
    status: "failed",
    required: true,
    command: "internal workspace revision evidence",
    durationMs,
    output: "",
    reason: error instanceof Error ? error.message : String(error),
  };
}

function verificationBoundaryFailure(error: unknown, durationMs: number): VerificationCheckResult {
  return {
    id: "anicode.verification-boundary",
    status: "failed",
    required: true,
    command: "internal disposable workspace boundary",
    durationMs,
    output: "",
    reason: error instanceof Error ? error.message : String(error),
  };
}

export function renderVerificationReport(report: VerificationReport): string {
  const lines = [`Verification ${report.status}: ${report.summary}`];
  for (const check of report.checks) {
    lines.push(`- ${check.id}: ${check.status} (${check.command})`);
    if (check.reason) lines.push(`  ${check.reason}`);
    if (check.status === "failed" && check.output) lines.push(check.output.slice(-4_000));
  }
  return lines.join("\n");
}
