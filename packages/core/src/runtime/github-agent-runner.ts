/** Headless, fail-closed agent entrypoint for an ephemeral GitHub Actions runner. */

import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { Agent, type AgentEvent } from "../agent.js";
import { createProvider } from "../provider/registry.js";
import { SecurityPolicyEngine } from "../security/policy.js";
import { createConfiguredLocalRuntimeStack, telemetryForLocalStack } from "./local-stack.js";
import { Verifier, type VerificationReport } from "./verifier.js";
import {
  createIsolatedGitPlumbing,
  hardenedGitArguments,
  hardenedGitEnvironment,
  trustedGitExecutable,
  validateGitRepository,
} from "./git-control.js";

const runFile = promisify(execFile);

type JobType = "github-analysis" | "github-repair" | "github-merge-group";

interface GitHubAgentResult {
  jobType: JobType;
  headSha: string;
  changedFiles: string[];
  summary: string;
  verification: VerificationReport;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeJobType(value: string): JobType {
  if (["github-analysis", "github-repair", "github-merge-group"].includes(value)) {
    return value as JobType;
  }
  throw new Error("ANICODE_GITHUB_JOB_TYPE is invalid");
}

async function changedFiles(cwd: string): Promise<string[]> {
  const repository = await validateGitRepository(cwd);
  const executable = await trustedGitExecutable();
  const head = await runFile(executable, hardenedGitArguments(["rev-parse", "HEAD"], cwd), {
    cwd,
    env: hardenedGitEnvironment(),
    maxBuffer: 1024 * 1024,
  });
  const plumbing = await createIsolatedGitPlumbing(cwd, path.join(repository.gitDir, "index"));
  let stdout: string;
  try {
    await fs.writeFile(path.join(plumbing.gitDir, "HEAD"), `${head.stdout.trim()}\n`, {
      mode: 0o600,
    });
    const result = await runFile(
      executable,
      hardenedGitArguments(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd),
      {
        cwd,
        env: hardenedGitEnvironment(plumbing.environment),
        maxBuffer: 8 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
  } finally {
    await plumbing.cleanup();
  }
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .filter((file) => file && !file.startsWith(".anicode/"))
    .sort();
}

function prompt(type: JobType, input: { headSha: string; failedUrl?: string }): string {
  if (type === "github-analysis") {
    return [
      `Review the checked-out GitHub change at ${input.headSha}.`,
      "Inspect the diff and repository guidance, run the appropriate deterministic checks, and report concrete findings.",
      "Do not edit files for an analysis-only job.",
    ].join("\n");
  }
  if (type === "github-merge-group") {
    return [
      `Verify the checked-out merge-group commit ${input.headSha}.`,
      "Run the repository's deterministic checks and diagnose any failure. Do not make speculative edits.",
    ].join("\n");
  }
  return [
    `Repair the checked-out GitHub change at ${input.headSha}.`,
    input.failedUrl ? `The failing CI run is ${input.failedUrl}.` : "CI reported a failure.",
    "Reproduce the failure, implement the smallest correct fix, and keep iterating until the deterministic verifier passes.",
    "All source edits must use the provided write/edit/apply_patch tools; do not modify .git or runtime state.",
  ].join("\n");
}

async function main(): Promise<void> {
  const cwd = path.resolve(process.env.GITHUB_WORKSPACE ?? process.cwd());
  const jobType = safeJobType(required("ANICODE_GITHUB_JOB_TYPE"));
  const headSha = required("ANICODE_GITHUB_HEAD_SHA");
  if (!/^[0-9a-f]{40,64}$/i.test(headSha)) throw new Error("ANICODE_GITHUB_HEAD_SHA is invalid");
  const modelSpec = required("ANICODE_GITHUB_MODEL");
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-github-agent-"));
  let stack: Awaited<ReturnType<typeof createConfiguredLocalRuntimeStack>> | undefined;
  let telemetry: ReturnType<typeof telemetryForLocalStack> | undefined;
  try {
    stack = await createConfiguredLocalRuntimeStack(runtimeDir, process.env);
    telemetry = telemetryForLocalStack(stack, process.env);
    const model = createProvider(modelSpec);
    if (
      model.descriptor.kind === "debug" ||
      (model.diagnostics.requiresApiKey && !model.diagnostics.hasCredentials)
    ) {
      throw new Error(`Production GitHub agent model is not credentialed: ${modelSpec}`);
    }
    const verifier = new Verifier({
      autoDiscover: true,
      executionRuntime: stack.isolatedRuntime,
    });
    const agent = new Agent({
      provider: model.provider,
      model: model.model,
      modelInfo: model.modelInfo,
      cwd,
      permission: { mode: "auto" },
      sandbox: jobType === "github-analysis" ? "read-only" : "workspace-write",
      projectMemory: true,
      repoMap: true,
      checkpoints: true,
      skills: true,
      subagents: false,
      maxTurns: Math.max(1, Number(process.env.ANICODE_GITHUB_MAX_TURNS ?? 40)),
      networkProxy: stack.networkProxy,
      isolatedRuntime: stack.isolatedRuntime,
      verifier,
      verificationMaxAttempts: Math.max(
        0,
        Number(process.env.ANICODE_GITHUB_VERIFICATION_ATTEMPTS ?? 3),
      ),
      securityPolicy: SecurityPolicyEngine.workspaceBoundary(),
      telemetry,
    });
    const text: string[] = [];
    let fatal: string | undefined;
    for await (const event of agent.send(
      prompt(jobType, {
        headSha,
        ...(process.env.ANICODE_GITHUB_FAILED_URL
          ? { failedUrl: process.env.ANICODE_GITHUB_FAILED_URL }
          : {}),
      }),
    )) {
      consume(event, text, (message) => {
        fatal = message;
      });
    }
    if (fatal) throw new Error(fatal);
    const files = await changedFiles(cwd);
    if (jobType !== "github-repair" && files.length > 0) {
      throw new Error(`${jobType} is read-only but changed ${files.length} files`);
    }
    const verification = await verifier.verify({ cwd, changedFiles: files });
    if (verification.status !== "passed" && verification.status !== "skipped") {
      throw new Error(`Deterministic verification failed: ${verification.summary}`);
    }
    const result: GitHubAgentResult = {
      jobType,
      headSha,
      changedFiles: files,
      summary: text.join("").trim().slice(-20_000) || verification.summary,
      verification,
    };
    const output = path.resolve(
      process.env.ANICODE_GITHUB_RESULT ?? path.join(runtimeDir, "github-agent-result.json"),
    );
    await fs.writeFile(output, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = stack?.broker.redact(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    // Do not attach the original as cause: it may contain a credential before Broker redaction.
    // eslint-disable-next-line preserve-caught-error
    throw new Error(message ?? "GitHub agent failed");
  } finally {
    if (telemetry?.shutdown) await telemetry.shutdown().catch(() => undefined);
    else await telemetry?.forceFlush?.().catch(() => undefined);
    await stack?.networkProxy.close().catch(() => undefined);
    await stack?.database.close().catch(() => undefined);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }
}

function consume(event: AgentEvent, text: string[], fatal: (message: string) => void): void {
  if (event.type === "text") text.push(event.text);
  if (event.type === "error") fatal(event.message);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
