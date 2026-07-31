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
  createProvider,
  telemetryForLocalStack,
} from "@anicode/core";
import { BUILTIN_TASKS } from "./tasks/builtin.js";
import { missingRequirements, runTask, skippedResult } from "./runner.js";
import { formatReport, summarize, type Summary } from "./report.js";
import { evaluateQualityGate, formatQualityGate } from "./quality-gate.js";
import { REAL_REPO_TASKS } from "./tasks/real-repo.generated.js";
import { missingRealRequirements, runRealRepoTask } from "./real-repo.js";
import type { TaskResult } from "./runner.js";

interface Args {
  suite?: "offline" | "real" | undefined;
  model?: string | undefined;
  tasks?: string[] | undefined;
  lang?: string[] | undefined;
  kind?: string[] | undefined;
  maxTurns?: number | undefined;
  json?: string | undefined;
  repomap?: boolean | undefined;
  baseline?: string | undefined;
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
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
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

/** 与基线比较：通过率下降超容忍度则返回失败说明，否则 null。 */
export function compareToBaseline(
  current: Summary,
  baseline: Summary,
  tolerance: number,
): string | null {
  const drop = baseline.passRate - current.passRate;
  if (drop > tolerance) {
    return (
      `回归：通过率 ${(current.passRate * 100).toFixed(0)}% 低于基线 ` +
      `${(baseline.passRate * 100).toFixed(0)}%（容忍 ${(tolerance * 100).toFixed(0)} 个百分点）`
    );
  }
  return null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    console.error(
      "用法: npm run eval -- --model <provider/model> [--tasks id1,id2] [--lang js,go] " +
        "[--suite offline|real] [--kind fix,debug] [--max-turns N] [--limit N] " +
        "[--concurrency N] [--shard-index N --shard-count N] " +
        "[--repomap] [--json out.json] " +
        "[--baseline prev.json] [--bootstrap-baseline] [--tolerance 0.06]",
    );
    console.error(`可用任务: ${BUILTIN_TASKS.map((t) => t.id).join(", ")}`);
    process.exitCode = 2;
    return;
  }

  const suite = args.suite ?? "offline";
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
    const created = createProvider(args.model);
    const results: TaskResult[] = [];
    const concurrency = Math.max(1, Math.min(16, Math.floor(args.concurrency ?? 1)));
    const shardIndex = Math.floor(args.shardIndex ?? 0);
    const shardCount = Math.floor(args.shardCount ?? 1);
    if (suite === "real") {
      let tasks = REAL_REPO_TASKS;
      if (args.tasks) tasks = tasks.filter((task) => args.tasks!.includes(task.id));
      if (args.lang) tasks = tasks.filter((task) => args.lang!.includes(task.language));
      if (args.limit !== undefined) tasks = tasks.slice(0, Math.max(0, Math.floor(args.limit)));
      tasks = selectShard(tasks, shardIndex, shardCount);
      if (tasks.length === 0) {
        console.error("没有匹配的真实仓库任务");
        process.exitCode = 2;
        return;
      }
      const missing = missingRealRequirements(args.python ?? "python3");
      if (missing.length) {
        console.error(
          `真实评测需要 git、Docker 和 swebench harness；当前缺少: ${missing.join(", ")}`,
        );
        process.exitCode = 2;
        return;
      }
      console.error(
        `跑 ${tasks.length} 个真实仓库任务 · 模型 ${args.model} · ` +
          `分片 ${shardIndex + 1}/${shardCount} · 并发 ${concurrency}…\n`,
      );
      results.push(
        ...(await mapConcurrent(tasks, concurrency, async (task) => {
          process.stderr.write(`  → ${task.id} (${task.language}) … `);
          const result = await runRealRepoTask(task, {
            provider: created.provider,
            model: created.model,
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
    } else {
      let tasks = BUILTIN_TASKS;
      if (args.tasks) tasks = tasks.filter((task) => args.tasks!.includes(task.id));
      if (args.lang) tasks = tasks.filter((task) => args.lang!.includes(task.lang));
      if (args.kind) tasks = tasks.filter((task) => args.kind!.includes(task.kind));
      if (args.limit !== undefined) tasks = tasks.slice(0, Math.max(0, Math.floor(args.limit)));
      tasks = selectShard(tasks, shardIndex, shardCount);
      if (tasks.length === 0) {
        console.error("没有匹配的任务");
        process.exitCode = 2;
        return;
      }
      console.error(
        `跑 ${tasks.length} 个离线任务 · 模型 ${args.model} · ` +
          `分片 ${shardIndex + 1}/${shardCount} · 并发 ${concurrency}…\n`,
      );
      results.push(
        ...(await mapConcurrent(tasks, concurrency, async (task) => {
          process.stderr.write(`  → ${task.id} … `);
          const missing = missingRequirements(task);
          if (missing.length > 0) {
            console.error(`↷ 跳过（缺 ${missing.join(", ")}）`);
            return skippedResult(task, missing);
          }
          const result = await runTask(task, {
            provider: created.provider,
            model: created.model,
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
    }

    const sum = summarize(args.model, results, {
      ...(args.repomap ? { repomap: true } : {}),
      suite,
      shardIndex,
      shardCount,
      runtimeImage: process.env.ANICODE_RUNTIME_IMAGE ?? "local",
      revision: process.env.GITHUB_SHA ?? process.env.ANICODE_EVAL_REVISION ?? "local",
      catalog: suite === "real" ? "swe-bench-pinned-280-v1" : "offline",
    });
    console.log("\n" + formatReport(sum));
    if (args.json) {
      await fs.writeFile(args.json, JSON.stringify(sum, null, 2), "utf8");
      console.error(`\nJSON 已写入 ${args.json}`);
    }

    if (args.baseline) {
      let baseline: Summary | undefined;
      try {
        baseline = JSON.parse(await fs.readFile(args.baseline, "utf8")) as Summary;
      } catch (error) {
        if (args.bootstrapBaseline && (error as NodeJS.ErrnoException).code === "ENOENT") {
          await fs.mkdir(path.dirname(path.resolve(args.baseline)), { recursive: true });
          await fs.writeFile(args.baseline, JSON.stringify(sum, null, 2) + "\n", "utf8");
          console.error(`已初始化基线 ${args.baseline}；请审核后提交，再启用回归门`);
          return;
        }
        throw new Error(
          `Eval baseline ${args.baseline} is required and unreadable: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (baseline) {
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
    }

    // 无基线时：全通过退出 0，否则 1——便于把 eval 接进门禁/看板。
    process.exitCode = args.deferGate || sum.passed === sum.total ? 0 : 1;
  } finally {
    await telemetry.forceFlush?.();
    await runtimeStack.networkProxy.close();
    await runtimeStack.database.close();
  }
}

// 仅作为 CLI 入口执行时才跑 main（便于测试导入 compareToBaseline）。
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  void main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
