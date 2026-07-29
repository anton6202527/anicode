/** 确定性 Verifier：命令由策略声明，模型只能消费结果，不能自称“已验证”。 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { TaskScheduler, type ScheduledTask } from "./scheduler.js";

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
}

export interface VerifierOptions {
  policy?: VerificationPolicy;
  autoDiscover?: boolean;
}

async function discoverChecks(cwd: string): Promise<VerificationCheck[]> {
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, "package.json"), "utf8")) as {
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

function runCheck(
  check: VerificationCheck,
  cwd: string,
  outputLimit: number,
  signal: AbortSignal,
): Promise<VerificationCheckResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const commandText = [check.command, ...(check.args ?? [])].join(" ");
    if (signal.aborted) {
      resolve({
        id: check.id,
        status: "cancelled",
        required: check.required ?? true,
        command: commandText,
        durationMs: 0,
        output: "",
      });
      return;
    }
    const child = spawn(check.command, check.args ?? [], {
      cwd: check.cwd ? path.resolve(cwd, check.cwd) : cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      if (output.length < outputLimit)
        output += chunk.toString().slice(0, outputLimit - output.length);
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    let settled = false;
    const finish = (result: Omit<VerificationCheckResult, "durationMs">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolve({ ...result, durationMs: Date.now() - started });
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish({
        id: check.id,
        status: "cancelled",
        required: check.required ?? true,
        command: commandText,
        output,
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const timeoutMs = Math.max(1_000, check.timeoutMs ?? 120_000);
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({
        id: check.id,
        status: "failed",
        required: check.required ?? true,
        command: commandText,
        output,
        reason: `timeout after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    child.on("error", (error) =>
      finish({
        id: check.id,
        status: "failed",
        required: check.required ?? true,
        command: commandText,
        output,
        reason: error.message,
      }),
    );
    child.on("close", (code) =>
      finish({
        id: check.id,
        status: code === 0 ? "passed" : "failed",
        required: check.required ?? true,
        command: commandText,
        exitCode: code ?? 1,
        output: output.trim(),
      }),
    );
  });
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
        status: "skipped",
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        checks: [],
        summary: "No verification checks configured for this change.",
      };
    }

    const outputLimit = Math.max(1_000, this.options.policy?.outputLimitChars ?? 20_000);
    const scheduler = new TaskScheduler({
      concurrency: this.options.policy?.concurrency ?? 2,
    });
    const tasks: ScheduledTask<VerificationCheckResult>[] = applicable.map((check) => ({
      id: check.id,
      ...(check.dependencies?.length ? { dependencies: check.dependencies } : {}),
      resources: [{ key: "workspace", mode: "read" }],
      run: ({ signal: taskSignal }) => runCheck(check, input.cwd, outputLimit, taskSignal),
    }));
    const scheduled = await scheduler.run(tasks, signal);
    const results = applicable.map((check) => {
      const task = scheduled.tasks[check.id]!;
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
    const requiredFailure = results.some(
      (result) => result.required && result.status !== "passed" && result.status !== "skipped",
    );
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
    };
  }
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
