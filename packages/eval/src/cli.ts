/**
 * 评测 CLI。
 *
 *   npm run eval -- --model anthropic/claude-opus-4-8 [--tasks id1,id2] [--lang go,py]
 *                   [--kind debug] [--max-turns 30] [--repomap] [--json out.json]
 *                   [--baseline prev.json] [--tolerance 0.06]
 *
 * --model 走 core 的 provider registry（需对应凭证）。跑完打印表格，并可导出 JSON 供
 * A/B 对比（改了 prompt/工具后再跑一遍，比对通过率/轮数/token/编辑失败率）。
 * --baseline 与历史 JSON 对比：通过率下降超过 --tolerance（默认 0.06，约容忍
 * 默认 100+ 任务；通过率容忍度按比例配置，nightly 用它守回归。
 * 缺工具链（python3/go）的任务自动跳过，不计入通过率分母。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  createConfiguredLocalRuntimeStack,
  telemetryForLocalStack,
  type LocalRuntimeStack,
} from "@anicode/core";
import { BUILTIN_TASKS } from "./tasks/builtin.js";
import { missingRequirements, runTask, skippedResult } from "./runner.js";
import { formatReport, summarize, type Summary } from "./report.js";
import { evaluateQualityGate, formatQualityGate } from "./quality-gate.js";
import { REAL_REPO_TASKS } from "./tasks/real-repo.generated.js";
import { missingRealRequirements, runRealRepoTask } from "./real-repo.js";
import type { TaskResult } from "./runner.js";
import { verifyReviewedBaseline, type BaselineManifest } from "./baseline.js";
import { catalogDigest } from "./catalog.js";

export interface EvalArgs {
  suite?: "offline" | "real" | undefined;
  model?: string | undefined;
  tasks?: string[] | undefined;
  lang?: string[] | undefined;
  kind?: string[] | undefined;
  maxTurns?: number | undefined;
  json?: string | undefined;
  repomap?: boolean | undefined;
  baseline?: string | undefined;
  baselineManifest?: string | undefined;
  tolerance?: number | undefined;
  maxTokenIncrease?: number | undefined;
  maxTurnIncrease?: number | undefined;
  maxEditFailureIncrease?: number | undefined;
  limit?: number | undefined;
  python?: string | undefined;
  keepWorkspaces?: boolean | undefined;
  bootstrapBaseline?: boolean | undefined;
  concurrency?: number | undefined;
  shardIndex?: number | undefined;
  shardCount?: number | undefined;
  deferGate?: boolean | undefined;
  trials?: number | undefined;
}

function parseArgs(argv: string[]): EvalArgs {
  const args: EvalArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") {
      const suite = argv[++i];
      if (suite !== "offline" && suite !== "real") throw new Error(`未知 suite: ${suite}`);
      args.suite = suite;
    } else if (a === "--model") args.model = argv[++i];
    else if (a === "--tasks") args.tasks = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--lang") args.lang = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--kind") args.kind = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--repomap") args.repomap = true;
    else if (a === "--baseline") args.baseline = argv[++i];
    else if (a === "--baseline-manifest") args.baselineManifest = argv[++i];
    else if (a === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (a === "--max-token-increase") args.maxTokenIncrease = Number(argv[++i]);
    else if (a === "--max-turn-increase") args.maxTurnIncrease = Number(argv[++i]);
    else if (a === "--max-edit-failure-increase") args.maxEditFailureIncrease = Number(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--python") args.python = argv[++i];
    else if (a === "--keep-workspaces") args.keepWorkspaces = true;
    else if (a === "--bootstrap-baseline") args.bootstrapBaseline = true;
    else if (a === "--concurrency") args.concurrency = Number(argv[++i]);
    else if (a === "--shard-index") args.shardIndex = Number(argv[++i]);
    else if (a === "--shard-count") args.shardCount = Number(argv[++i]);
    else if (a === "--defer-gate") args.deferGate = true;
    else if (a === "--trials") args.trials = Number(argv[++i]);
    else if (a === "--help" || a === "-h") args.model = undefined;
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

export function selectShard<T>(items: T[], index = 0, count = 1): T[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("--shard-count must be >= 1");
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error("--shard-index must be in [0, shard-count)");
  }
  return items.filter((_, itemIndex) => itemIndex % count === index);
}

function optionalInteger(
  value: number | undefined,
  flag: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be an integer in [${minimum}, ${maximum}]`);
  }
  return value;
}

function optionalFinite(
  value: number | undefined,
  flag: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} must be a finite number in [${minimum}, ${maximum}]`);
  }
  return value;
}

export function validateNumericArgs(args: EvalArgs): void {
  optionalInteger(args.maxTurns, "--max-turns", 1, 200);
  optionalInteger(args.limit, "--limit", 1, REAL_REPO_TASKS.length);
  optionalInteger(args.concurrency, "--concurrency", 1, 16);
  const shardCount = optionalInteger(args.shardCount, "--shard-count", 1, REAL_REPO_TASKS.length);
  const shardIndex = optionalInteger(
    args.shardIndex,
    "--shard-index",
    0,
    REAL_REPO_TASKS.length - 1,
  );
  if (shardIndex !== undefined && shardIndex >= (shardCount ?? 1)) {
    throw new Error("--shard-index must be in [0, shard-count)");
  }
  optionalInteger(args.trials, "--trials", 1, 20);
  optionalFinite(args.tolerance, "--tolerance", 0, 1);
  optionalFinite(args.maxTokenIncrease, "--max-token-increase", 0, 10);
  optionalFinite(args.maxTurnIncrease, "--max-turn-increase", 0, 10);
  optionalFinite(args.maxEditFailureIncrease, "--max-edit-failure-increase", 0, 1);
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= items.length) return;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

/** Keep eval provider construction bound to the stack that owns its Broker and NetworkProxy. */
export function resolveEvalProvider(
  runtimeStack: Pick<LocalRuntimeStack, "resolveProvider">,
  modelSpec: string,
): ReturnType<LocalRuntimeStack["resolveProvider"]> {
  return runtimeStack.resolveProvider(modelSpec);
}

function trialJobs<T>(items: T[], trials: number): Array<{ item: T; trial: number }> {
  return items.flatMap((item) =>
    Array.from({ length: trials }, (_, index) => ({ item, trial: index + 1 })),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    console.error(
      "用法: npm run eval -- --model <provider/model> [--tasks id1,id2] [--lang js,go] " +
        "[--suite offline|real] [--kind fix,debug] [--max-turns N] [--limit N] " +
        "[--concurrency N] [--shard-index N --shard-count N] " +
        "[--trials N] " +
        "[--repomap] [--json out.json] " +
        "[--baseline prev.json --baseline-manifest prev.manifest.json] [--tolerance 0.06]",
    );
    console.error(`可用任务: ${BUILTIN_TASKS.map((t) => t.id).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  validateNumericArgs(args);

  const suite = args.suite ?? "offline";
  if (args.bootstrapBaseline) {
    throw new Error(
      "--bootstrap-baseline no longer writes a trusted baseline. Write --json output, then use eval:baseline create and eval:baseline approve",
    );
  }
  const trials = args.trials ?? 1;
  if (args.baseline && !args.baselineManifest) {
    throw new Error("--baseline-manifest is required with --baseline");
  }
  if (suite === "real" && !process.env.ANICODE_NETWORK_ALLOW_DOMAINS?.trim()) {
    throw new Error(
      "真实评测必须显式设置 ANICODE_NETWORK_ALLOW_DOMAINS；模型请求不允许使用默认全域名策略",
    );
  }
  // 与 TUI/daemon 共用生产装配：长期密钥从 Keychain/Vault/KMS 水合到 Broker 后从
  // process.env 清除；provider fetch 经 DNS 固定、SSRF 防护和可审计的 NetworkProxy。
  // runtime.db 同时保留 credential/network 审计记录，目录已由仓库 .gitignore 排除。
  const runtimeStack = await createConfiguredLocalRuntimeStack(
    process.env.ANICODE_EVAL_STATE_DIR ?? path.join(process.cwd(), ".anicode", "eval"),
  );
  const telemetry = telemetryForLocalStack(runtimeStack);
  try {
    const created = resolveEvalProvider(runtimeStack, args.model);
    const results: TaskResult[] = [];
    const concurrency = args.concurrency ?? 1;
    const shardIndex = args.shardIndex ?? 0;
    const shardCount = args.shardCount ?? 1;
    if (suite === "real") {
      let tasks = REAL_REPO_TASKS;
      if (args.tasks) tasks = tasks.filter((task) => args.tasks!.includes(task.id));
      if (args.lang) tasks = tasks.filter((task) => args.lang!.includes(task.language));
      if (args.limit !== undefined) tasks = tasks.slice(0, args.limit);
      const fullCatalogDigest = catalogDigest(tasks);
      tasks = selectShard(tasks, shardIndex, shardCount);
      if (tasks.length === 0) {
        console.error("没有匹配的真实仓库任务");
        process.exitCode = 2;
        return;
      }
      const missing = await missingRealRequirements(args.python ?? "python3");
      if (missing.length) {
        console.error(
          `真实评测需要 git、Docker 和 swebench harness；当前缺少: ${missing.join(", ")}`,
        );
        process.exitCode = 2;
        return;
      }
      console.error(
        `跑 ${tasks.length} 个真实仓库任务 × ${trials} trials · 模型 ${args.model} · ` +
          `分片 ${shardIndex + 1}/${shardCount} · 并发 ${concurrency}…\n`,
      );
      const realExpectedTaskIds = tasks.map((task) => task.id);
      results.push(
        ...(await mapConcurrent(trialJobs(tasks, trials), concurrency, async ({ item, trial }) => {
          process.stderr.write(`  → ${item.id}#${trial} (${item.language}) … `);
          const result = await runRealRepoTask(item, {
            provider: created.provider,
            model: created.model,
            trial,
            ...(created.modelInfo ? { modelInfo: created.modelInfo } : {}),
            ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
            ...(args.repomap ? { repomap: true } : {}),
            ...(args.python ? { python: args.python } : {}),
            ...(args.keepWorkspaces ? { keepWorkspace: true } : {}),
            isolatedRuntime: runtimeStack.isolatedRuntime,
            networkProxy: runtimeStack.networkProxy,
            telemetry,
          });
          console.error(result.passed ? "✓" : `✗${result.error ? " (" + result.error + ")" : ""}`);
          return result;
        })),
      );
      const sum = summarize(args.model, results, {
        ...(args.repomap ? { repomap: true } : {}),
        suite,
        shardIndex,
        shardCount,
        runtimeImage: process.env.ANICODE_RUNTIME_IMAGE ?? "local",
        revision: process.env.GITHUB_SHA ?? process.env.ANICODE_EVAL_REVISION ?? "local",
        catalog: "swe-bench-pinned-280-v1",
        catalogDigest: fullCatalogDigest,
        expectedTaskIds: realExpectedTaskIds,
        trials,
      });
      await finish(sum, args);
      return;
    } else {
      let tasks = BUILTIN_TASKS;
      if (args.tasks) tasks = tasks.filter((task) => args.tasks!.includes(task.id));
      if (args.lang) tasks = tasks.filter((task) => args.lang!.includes(task.lang));
      if (args.kind) tasks = tasks.filter((task) => args.kind!.includes(task.kind));
      if (args.limit !== undefined) tasks = tasks.slice(0, args.limit);
      const fullCatalogDigest = catalogDigest(tasks);
      tasks = selectShard(tasks, shardIndex, shardCount);
      if (tasks.length === 0) {
        console.error("没有匹配的任务");
        process.exitCode = 2;
        return;
      }
      console.error(
        `跑 ${tasks.length} 个离线任务 × ${trials} trials · 模型 ${args.model} · ` +
          `分片 ${shardIndex + 1}/${shardCount} · 并发 ${concurrency}…\n`,
      );
      results.push(
        ...(await mapConcurrent(trialJobs(tasks, trials), concurrency, async ({ item, trial }) => {
          process.stderr.write(`  → ${item.id}#${trial} … `);
          const missing = missingRequirements(item);
          if (missing.length > 0) {
            console.error(`↷ 跳过（缺 ${missing.join(", ")}）`);
            return skippedResult(item, missing, trial);
          }
          const result = await runTask(item, {
            provider: created.provider,
            model: created.model,
            trial,
            ...(created.modelInfo ? { modelInfo: created.modelInfo } : {}),
            ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
            ...(args.repomap ? { repomap: true } : {}),
            isolatedRuntime: runtimeStack.isolatedRuntime,
            networkProxy: runtimeStack.networkProxy,
            telemetry,
          });
          console.error(result.passed ? "✓" : `✗${result.error ? " (" + result.error + ")" : ""}`);
          return result;
        })),
      );
      const sum = summarize(args.model, results, {
        ...(args.repomap ? { repomap: true } : {}),
        suite,
        shardIndex,
        shardCount,
        runtimeImage: process.env.ANICODE_RUNTIME_IMAGE ?? "local",
        revision: process.env.GITHUB_SHA ?? process.env.ANICODE_EVAL_REVISION ?? "local",
        catalog: "offline",
        catalogDigest: fullCatalogDigest,
        expectedTaskIds: tasks.map((task) => task.id),
        trials,
      });
      await finish(sum, args);
      return;
    }
  } finally {
    await telemetry.forceFlush?.();
    await runtimeStack.artifacts.close?.();
    await runtimeStack.networkProxy.close();
    await runtimeStack.database.close();
  }
}

async function finish(sum: Summary, args: EvalArgs): Promise<void> {
  console.log("\n" + formatReport(sum));
  if (args.json) {
    await fs.writeFile(args.json, JSON.stringify(sum, null, 2), "utf8");
    console.error(`\nJSON 已写入 ${args.json}`);
  }

  if (args.baseline) {
    let baseline: Summary;
    let baselineText: string;
    try {
      baselineText = await fs.readFile(args.baseline, "utf8");
      baseline = JSON.parse(baselineText) as Summary;
    } catch (error) {
      throw new Error(
        `Eval baseline ${args.baseline} is required and unreadable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    const manifest = JSON.parse(
      await fs.readFile(args.baselineManifest!, "utf8"),
    ) as BaselineManifest;
    verifyReviewedBaseline(baselineText, baseline, manifest, trustedBaselineKeys());
    const gate = evaluateQualityGate(sum, baseline, {
      maxPassRateDrop: args.tolerance ?? 0.06,
      ...(args.maxTokenIncrease !== undefined
        ? { maxAverageInputTokensIncrease: args.maxTokenIncrease }
        : {}),
      ...(args.maxTurnIncrease !== undefined
        ? { maxAverageTurnsIncrease: args.maxTurnIncrease }
        : {}),
      ...(args.maxEditFailureIncrease !== undefined
        ? { maxEditFailureRateIncrease: args.maxEditFailureIncrease }
        : {}),
    });
    if (!gate.passed) {
      console.error(`\n${formatQualityGate(gate)}`);
      process.exitCode = 1;
      return;
    }
    console.error(
      `\n基线比较通过（基线 ${(baseline.passRate * 100).toFixed(0)}% → ` +
        `当前 ${(sum.passRate * 100).toFixed(0)}%）`,
    );
    return;
  }

  // 无基线时：全通过退出 0，否则 1——便于把 eval 接进门禁/看板。
  process.exitCode = args.deferGate || sum.passed === sum.total ? 0 : 1;
}

function trustedBaselineKeys(): Record<string, string> {
  const raw = process.env.ANICODE_EVAL_BASELINE_TRUSTED_KEYS;
  if (!raw)
    throw new Error("ANICODE_EVAL_BASELINE_TRUSTED_KEYS is required to verify a reviewed baseline");
  let keys: unknown;
  try {
    keys = JSON.parse(raw);
  } catch {
    throw new Error(
      "ANICODE_EVAL_BASELINE_TRUSTED_KEYS must be a JSON key-id to Ed25519 public-key map",
    );
  }
  if (!keys || typeof keys !== "object" || Array.isArray(keys) || Object.keys(keys).length === 0) {
    throw new Error("ANICODE_EVAL_BASELINE_TRUSTED_KEYS must contain at least one trusted key");
  }
  if (Object.values(keys as Record<string, unknown>).some((value) => typeof value !== "string")) {
    throw new Error("ANICODE_EVAL_BASELINE_TRUSTED_KEYS values must be PEM or base64 SPKI strings");
  }
  return keys as Record<string, string>;
}

// 仅作为 CLI 入口执行时才跑 main（测试可安全导入 shard helpers）。
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  void main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
