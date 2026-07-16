/**
 * 评测 CLI。
 *
 *   npm run eval -- --model anthropic/claude-opus-4-8 [--tasks id1,id2] [--max-turns 30] [--json out.json]
 *
 * --model 走 core 的 provider registry（需对应凭证）。跑完打印表格，并可导出 JSON 供
 * A/B 对比（改了 prompt/工具后再跑一遍，比对通过率/轮数/token/编辑失败率）。
 */
import { promises as fs } from "node:fs";
import { createProvider } from "@anicode/core";
import { BUILTIN_TASKS } from "./tasks/builtin.js";
import { runTask } from "./runner.js";
import { formatReport, summarize } from "./report.js";

interface Args {
  model?: string | undefined;
  tasks?: string[] | undefined;
  maxTurns?: number | undefined;
  json?: string | undefined;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model") args.model = argv[++i];
    else if (a === "--tasks") args.tasks = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a === "--max-turns") args.maxTurns = Number(argv[++i]);
    else if (a === "--json") args.json = argv[++i];
    else if (a === "--help" || a === "-h") args.model = undefined;
    else throw new Error(`未知参数: ${a}`);
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.model) {
    console.error(
      "用法: npm run eval -- --model <provider/model> [--tasks id1,id2] [--max-turns N] [--json out.json]",
    );
    console.error(`可用任务: ${BUILTIN_TASKS.map((t) => t.id).join(", ")}`);
    process.exit(2);
  }

  const created = createProvider(args.model);
  const tasks = args.tasks
    ? BUILTIN_TASKS.filter((t) => args.tasks!.includes(t.id))
    : BUILTIN_TASKS;
  if (tasks.length === 0) {
    console.error("没有匹配的任务");
    process.exit(2);
  }

  console.error(`跑 ${tasks.length} 个任务 · 模型 ${args.model}…\n`);
  const results = [];
  for (const task of tasks) {
    process.stderr.write(`  → ${task.id} … `);
    const r = await runTask(task, {
      provider: created.provider,
      model: created.model,
      ...(created.modelInfo ? { modelInfo: created.modelInfo } : {}),
      ...(args.maxTurns ? { maxTurns: args.maxTurns } : {}),
    });
    console.error(r.passed ? "✓" : `✗${r.error ? " (" + r.error + ")" : ""}`);
    results.push(r);
  }

  const sum = summarize(args.model, results);
  console.log("\n" + formatReport(sum));
  if (args.json) {
    await fs.writeFile(args.json, JSON.stringify(sum, null, 2), "utf8");
    console.error(`\nJSON 已写入 ${args.json}`);
  }

  // 全通过退出 0，否则 1——便于把 eval 接进门禁/看板。
  process.exit(sum.passed === sum.total ? 0 : 1);
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
