/**
 * Kubernetes workspace-write Job 入口。
 *
 * Pod/CNI 提供 OS 隔离；本入口再把命令放进 emptyDir 临时副本执行，成功后经
 * TransactionalExecutionRuntime/PatchSet 原子提交回 PVC。它不接受命令行拼接，命令与
 * cwd 都从受控环境字段读取，避免 Kubernetes command/args 的 shell quoting 歧义。
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
} from "./isolated-runtime.js";
import { TransactionalExecutionRuntime } from "./transactional-runtime.js";

const OUTPUT_LIMIT = 1024 * 1024;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Pod 本身已经是隔离边界；这里只负责执行、超时、取消与有界日志。 */
class PodProcessRuntime implements ExecutionRuntime {
  run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-lc", request.command], {
        cwd: request.cwd,
        env: request.env ?? process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      let timedOut = false;
      const capture = (chunk: Buffer) => {
        if (output.length < OUTPUT_LIMIT) {
          output += chunk.toString().slice(0, OUTPUT_LIMIT - output.length);
        }
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      const timeout = setTimeout(
        () => {
          timedOut = true;
          child.kill("SIGKILL");
        },
        Math.max(1_000, request.timeoutMs ?? 120_000),
      );
      const abort = () => child.kill("SIGKILL");
      request.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        reject(error);
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", abort);
        resolve({
          exitCode,
          output,
          timedOut,
          sandboxed: true,
          durationMs: Date.now() - started,
        });
      });
    });
  }
}

function safeCwd(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("ANICODE_JOB_RELATIVE_CWD escapes the workspace");
  }
  return resolved;
}

export async function main(): Promise<void> {
  const source = path.resolve(required("ANICODE_JOB_SOURCE"));
  const relativeCwd = required("ANICODE_JOB_RELATIVE_CWD");
  safeCwd(source, relativeCwd);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const runtime = new TransactionalExecutionRuntime(new PodProcessRuntime(), {
      maxFiles: Number(process.env.ANICODE_TRANSACTIONAL_SHELL_MAX_FILES ?? 200_000),
      maxChangedBytes: Number(
        process.env.ANICODE_TRANSACTIONAL_SHELL_MAX_CHANGED_BYTES ?? 100 * 1024 * 1024,
      ),
    });
    // TransactionalExecutionRuntime clones the workspace root. A constant wrapper changes cwd
    // inside that clone, while the original user command remains an opaque environment value.
    const result = await runtime.run({
      command: 'cd -- "$ANICODE_JOB_RELATIVE_CWD" && exec /bin/sh -lc "$ANICODE_JOB_COMMAND"',
      cwd: source,
      policy: "workspace-write",
      network: process.env.ANICODE_JOB_NETWORK === "1",
      timeoutMs: Number(process.env.ANICODE_JOB_TIMEOUT_MS ?? 120_000),
      signal: controller.signal,
      env: process.env,
    });
    process.stdout.write(result.output);
    process.exitCode = result.exitCode ?? 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
