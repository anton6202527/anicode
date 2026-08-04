/** 汇总与打印评测报告（终端表格 + 可选 JSON）。 */
import type { EvalOutcomeStatus } from "./metrics.js";
import type { TaskResult } from "./runner.js";

export const EVAL_REPORT_SCHEMA_VERSION = 2 as const;

export interface StabilitySummary {
  trialsPerTask: number;
  stablePassedTasks: number;
  stablePassRate: number;
  flakyTasks: number;
  flakyTaskRate: number;
  trialPassRateStdDev: number;
  /** Mean distinct privacy-preserving trajectory signatures per task, normalized to [0, 1]. */
  trajectoryDiversity: number;
}

export interface TrajectorySummary {
  toolCalls: number;
  toolErrors: number;
  toolFailureRate: number;
  completedRuns: number;
  terminalCompletionRate: number;
  runsWithToolErrors: number;
  toolErrorRecoveryRate: number;
  retries: number;
  fallbacks: number;
  compactions: number;
  verifications: number;
  permissionDenials: number;
}

export interface FinalResponseSummary {
  present: number;
  missingRate: number;
  explicitCompletionClaims: number;
  falseCompletionClaims: number;
  falseCompletionClaimRate: number;
}

export interface Summary {
  schemaVersion: typeof EVAL_REPORT_SCHEMA_VERSION;
  model: string;
  /** 运行时设置（A/B 对比时应逐项一致才可比）。 */
  settings?: {
    repomap?: boolean;
    suite?: "offline" | "real";
    shardIndex?: number;
    shardCount?: number;
    runtimeImage?: string;
    revision?: string;
    catalog?: string;
    /** SHA-256 of the full selected task catalog, before sharding. */
    catalogDigest?: string;
    /** Exact task IDs this report is responsible for (one shard, or the full merged set). */
    expectedTaskIds?: string[];
    trials?: number;
  };
  /** 实际运行的 trial 数（不含 skipped）。 */
  total: number;
  /** 实际运行的不同任务数。 */
  taskCount: number;
  passed: number;
  /** 因缺工具链跳过的 trial 数。 */
  skipped: number;
  passRate: number;
  passRateCi95: { low: number; high: number };
  stability: StabilitySummary;
  trajectory: TrajectorySummary;
  finalResponse: FinalResponseSummary;
  outcomes: Record<EvalOutcomeStatus, number>;
  avgTurns: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUSD?: number;
  editCalls: number;
  editErrors: number;
  /** 编辑失败率 = editErrors / editCalls（无编辑则 0）。 */
  editFailureRate: number;
  totalWallMs: number;
  results: TaskResult[];
}

function trialOf(result: TaskResult): number {
  return result.trial ?? 1;
}

function groupByTask(results: TaskResult[]): Map<string, TaskResult[]> {
  const grouped = new Map<string, TaskResult[]>();
  for (const result of results) {
    const values = grouped.get(result.id) ?? [];
    values.push(result);
    grouped.set(result.id, values);
  }
  return grouped;
}

function taskIdSet(ids: readonly string[], label: string): Set<string> {
  const set = new Set(ids);
  if (set.size !== ids.length || [...set].some((id) => !id.trim())) {
    throw new Error(`${label} must contain unique, non-empty task IDs`);
  }
  return set;
}

function validateTrials(
  results: TaskResult[],
  trials: number,
  expectedTaskIds?: readonly string[],
): void {
  const keys = new Set<string>();
  for (const result of results) {
    const trial = trialOf(result);
    if (!Number.isInteger(trial) || trial < 1 || trial > trials) {
      throw new Error(`Invalid eval trial ${result.id}#${trial}; expected 1..${trials}`);
    }
    const key = `${result.id}#${trial}`;
    if (keys.has(key)) throw new Error(`Duplicate eval result: ${key}`);
    keys.add(key);
  }
  for (const [id, taskResults] of groupByTask(results)) {
    if (taskResults.length !== trials) {
      throw new Error(`Incomplete trial set for ${id}: received ${taskResults.length}/${trials}`);
    }
  }
  if (expectedTaskIds) {
    const expected = taskIdSet(expectedTaskIds, "Expected eval task set");
    const actual = new Set(groupByTask(results).keys());
    const missing = [...expected].filter((id) => !actual.has(id));
    const unexpected = [...actual].filter((id) => !expected.has(id));
    if (missing.length || unexpected.length) {
      throw new Error(
        `Eval task coverage mismatch: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
      );
    }
  }
}

function validateResultEvidence(results: TaskResult[], suite?: "offline" | "real"): void {
  const statuses = new Set<EvalOutcomeStatus>([
    "passed",
    "failed",
    "agent_error",
    "timeout",
    "skipped",
  ]);
  const nonNegative = (value: unknown, label: string, integer = false): void => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      (integer && !Number.isInteger(value))
    ) {
      throw new Error(`Eval result has invalid ${label}`);
    }
  };
  for (const result of results) {
    if (!result.outcome || !statuses.has(result.outcome.status)) {
      throw new Error(`Eval result ${result.id} has invalid deterministic outcome evidence`);
    }
    const passedByEvidence = result.outcome.status === "passed" && result.outcome.verified === true;
    if (
      result.passed !== passedByEvidence ||
      Boolean(result.skipped) !== (result.outcome.status === "skipped")
    ) {
      throw new Error(`Eval result ${result.id} has inconsistent deterministic outcome evidence`);
    }
    nonNegative(result.trial, "trial", true);
    for (const [label, value, integer] of [
      ["turns", result.turns, true],
      ["toolCalls", result.toolCalls, true],
      ["editCalls", result.editCalls, true],
      ["editErrors", result.editErrors, true],
      ["toolErrors", result.toolErrors, true],
      ["inputTokens", result.inputTokens, true],
      ["outputTokens", result.outputTokens, true],
      ["wallMs", result.wallMs, false],
      ["finalResponse.chars", result.finalResponse?.chars, true],
      ["trajectory.retries", result.trajectory?.retries, true],
      ["trajectory.fallbacks", result.trajectory?.fallbacks, true],
      ["trajectory.compactions", result.trajectory?.compactions, true],
      ["trajectory.verifications", result.trajectory?.verifications, true],
      ["trajectory.permissionDenials", result.trajectory?.permissionDenials, true],
    ] as const) {
      nonNegative(value, label, integer);
    }
    if (result.costUSD !== undefined) nonNegative(result.costUSD, "costUSD");
    if (result.outcome.exitCode !== undefined)
      nonNegative(result.outcome.exitCode, "outcome.exitCode", true);
    if (result.outcome.patchBytes !== undefined)
      nonNegative(result.outcome.patchBytes, "outcome.patchBytes", true);
    if (!Array.isArray(result.trajectory?.calls)) {
      throw new Error(`Eval result ${result.id} has invalid trajectory calls`);
    }
    if (suite === "real" && result.skipped) {
      throw new Error(`Real eval result ${result.id} was skipped`);
    }
  }
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}

export function summarize(
  model: string,
  results: TaskResult[],
  settings?: Summary["settings"],
): Summary {
  const trials = Math.max(
    1,
    Math.floor(settings?.trials ?? Math.max(1, ...results.map((result) => trialOf(result)))),
  );
  validateTrials(results, trials, settings?.expectedTaskIds);
  validateResultEvidence(results, settings?.suite);
  const ran = results.filter((result) => !result.skipped);
  const skipped = results.length - ran.length;
  const passed = ran.filter((result) => result.passed).length;
  const editCalls = ran.reduce((sum, result) => sum + result.editCalls, 0);
  const editErrors = ran.reduce((sum, result) => sum + result.editErrors, 0);
  const passRate = ran.length ? passed / ran.length : 0;
  const passRateCi95 = wilsonInterval(passed, ran.length);
  const grouped = groupByTask(ran);
  const stablePassedTasks = [...grouped.values()].filter(
    (taskResults) => taskResults.length === trials && taskResults.every((result) => result.passed),
  ).length;
  const flakyTasks = [...grouped.values()].filter((taskResults) => {
    const taskPassed = taskResults.filter((result) => result.passed).length;
    return taskPassed > 0 && taskPassed < taskResults.length;
  }).length;
  const trialPassRates = Array.from({ length: trials }, (_, index) => {
    const trialResults = ran.filter((result) => trialOf(result) === index + 1);
    return trialResults.length
      ? trialResults.filter((result) => result.passed).length / trialResults.length
      : 0;
  });
  const toolCalls = ran.reduce((sum, result) => sum + result.toolCalls, 0);
  const toolErrors = ran.reduce((sum, result) => sum + result.toolErrors, 0);
  const runsWithToolErrors = ran.filter((result) => result.toolErrors > 0);
  const explicitCompletionClaims = ran.filter(
    (result) => result.finalResponse.completionClaim,
  ).length;
  const falseCompletionClaims = ran.filter(
    (result) => result.finalResponse.completionClaim && !result.finalResponse.outcomeAligned,
  ).length;
  const outcomes: Record<EvalOutcomeStatus, number> = {
    passed: 0,
    failed: 0,
    agent_error: 0,
    timeout: 0,
    skipped: 0,
  };
  for (const result of results) outcomes[result.outcome.status]++;
  const costs = ran.map((result) => result.costUSD).filter((cost): cost is number => cost != null);

  return {
    schemaVersion: EVAL_REPORT_SCHEMA_VERSION,
    model,
    settings: { ...(settings ?? {}), trials },
    total: ran.length,
    taskCount: grouped.size,
    passed,
    skipped,
    passRate,
    passRateCi95,
    stability: {
      trialsPerTask: trials,
      stablePassedTasks,
      stablePassRate: grouped.size ? stablePassedTasks / grouped.size : 0,
      flakyTasks,
      flakyTaskRate: grouped.size ? flakyTasks / grouped.size : 0,
      trialPassRateStdDev: standardDeviation(trialPassRates),
      trajectoryDiversity: grouped.size
        ? [...grouped.values()].reduce(
            (sum, taskResults) =>
              sum +
              new Set(taskResults.map((result) => result.trajectory.signatureSha256)).size / trials,
            0,
          ) / grouped.size
        : 0,
    },
    trajectory: {
      toolCalls,
      toolErrors,
      toolFailureRate: toolCalls ? toolErrors / toolCalls : 0,
      completedRuns: ran.filter((result) => result.trajectory.completed).length,
      terminalCompletionRate: ran.length
        ? ran.filter((result) => result.trajectory.completed).length / ran.length
        : 0,
      runsWithToolErrors: runsWithToolErrors.length,
      toolErrorRecoveryRate: runsWithToolErrors.length
        ? runsWithToolErrors.filter((result) => result.passed).length / runsWithToolErrors.length
        : 1,
      retries: ran.reduce((sum, result) => sum + result.trajectory.retries, 0),
      fallbacks: ran.reduce((sum, result) => sum + result.trajectory.fallbacks, 0),
      compactions: ran.reduce((sum, result) => sum + result.trajectory.compactions, 0),
      verifications: ran.reduce((sum, result) => sum + result.trajectory.verifications, 0),
      permissionDenials: ran.reduce((sum, result) => sum + result.trajectory.permissionDenials, 0),
    },
    finalResponse: {
      present: ran.filter((result) => result.finalResponse.present).length,
      missingRate: ran.length
        ? ran.filter((result) => !result.finalResponse.present).length / ran.length
        : 0,
      explicitCompletionClaims,
      falseCompletionClaims,
      falseCompletionClaimRate: explicitCompletionClaims
        ? falseCompletionClaims / explicitCompletionClaims
        : 0,
    },
    outcomes,
    avgTurns: ran.length ? ran.reduce((sum, result) => sum + result.turns, 0) / ran.length : 0,
    totalInputTokens: ran.reduce((sum, result) => sum + result.inputTokens, 0),
    totalOutputTokens: ran.reduce((sum, result) => sum + result.outputTokens, 0),
    ...(costs.length === ran.length
      ? { totalCostUSD: costs.reduce((sum, cost) => sum + cost, 0) }
      : {}),
    editCalls,
    editErrors,
    editFailureRate: editCalls ? editErrors / editCalls : 0,
    totalWallMs: ran.reduce((sum, result) => sum + result.wallMs, 0),
    results,
  };
}

export function mergeSummaries(summaries: Summary[]): Summary {
  if (summaries.length === 0) throw new Error("No eval summaries to merge");
  const first = summaries[0]!;
  if (!first.settings?.expectedTaskIds?.length || !first.settings.catalogDigest) {
    throw new Error("Eval shard is missing a task coverage commitment or catalog digest");
  }
  const expectedShards = first.settings?.shardCount ?? summaries.length;
  const shardIndexes = new Set(summaries.map((summary) => summary.settings?.shardIndex));
  const completeIndexes = Array.from({ length: expectedShards }, (_, index) => index).every(
    (index) => shardIndexes.has(index),
  );
  if (
    summaries.length !== expectedShards ||
    shardIndexes.size !== expectedShards ||
    !completeIndexes
  ) {
    throw new Error(`Incomplete eval shard set: received ${summaries.length}/${expectedShards}`);
  }
  for (const summary of summaries) {
    if (summary.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION) {
      throw new Error(`Unsupported eval report schema: ${String(summary.schemaVersion)}`);
    }
    if (summary.model !== first.model) throw new Error("Eval shard model mismatch");
    for (const field of [
      "suite",
      "catalog",
      "catalogDigest",
      "runtimeImage",
      "revision",
      "repomap",
      "trials",
    ] as const) {
      if (summary.settings?.[field] !== first.settings?.[field]) {
        throw new Error(`Eval shard ${field} mismatch`);
      }
    }
    if (!summary.settings?.expectedTaskIds?.length) {
      throw new Error("Eval shard is missing expected task IDs");
    }
    if (summary.results.some((result) => result.skipped)) {
      throw new Error("Eval shard contains skipped trials");
    }
    // Re-summarizing verifies that persisted metrics and task/trial coverage match the raw results.
    summarize(summary.model, summary.results, summary.settings);
  }
  const expectedTaskIds = summaries.flatMap((summary) => summary.settings!.expectedTaskIds!);
  taskIdSet(expectedTaskIds, "Merged expected eval task set");
  const results = summaries.flatMap((summary) => summary.results);
  return summarize(first.model, results, {
    ...(first.settings ?? {}),
    shardIndex: 0,
    shardCount: 1,
    expectedTaskIds,
  });
}

export function assertComparableSummaries(current: Summary, baseline: Summary): void {
  if (
    current.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION ||
    baseline.schemaVersion !== EVAL_REPORT_SCHEMA_VERSION
  ) {
    throw new Error(
      `Eval baseline schema mismatch; expected ${EVAL_REPORT_SCHEMA_VERSION}. Bootstrap and review a new baseline`,
    );
  }
  if (current.model !== baseline.model) throw new Error("Eval baseline model mismatch");
  for (const field of [
    "suite",
    "catalog",
    "catalogDigest",
    "runtimeImage",
    "repomap",
    "trials",
  ] as const) {
    if (current.settings?.[field] !== baseline.settings?.[field]) {
      throw new Error(
        `Eval baseline ${field} mismatch; create and review a separately keyed baseline`,
      );
    }
  }
  const currentIds = current.settings?.expectedTaskIds;
  const baselineIds = baseline.settings?.expectedTaskIds;
  if (!currentIds?.length || !baselineIds?.length) {
    throw new Error("Eval baseline task coverage commitment is missing");
  }
  if (current.skipped !== 0 || current.results.some((result) => result.skipped)) {
    throw new Error(
      "Current eval contains skipped trials and is not comparable to a reviewed baseline",
    );
  }
  const currentSet = taskIdSet(currentIds, "Current eval task set");
  const baselineSet = taskIdSet(baselineIds, "Baseline eval task set");
  const missing = [...baselineSet].filter((id) => !currentSet.has(id));
  const unexpected = [...currentSet].filter((id) => !baselineSet.has(id));
  if (
    missing.length ||
    unexpected.length ||
    current.taskCount !== baseline.taskCount ||
    current.total !== baseline.total
  ) {
    throw new Error(
      `Eval baseline task set mismatch: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
    );
  }
}

function wilsonInterval(passed: number, total: number): { low: number; high: number } {
  if (total === 0) return { low: 0, high: 0 };
  const z = 1.959963984540054;
  const rate = passed / total;
  const denominator = 1 + (z * z) / total;
  const center = (rate + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total));
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

/** 渲染成人可读表格（纯字符串，便于测试与重定向）。 */
export function formatReport(summary: Summary): string {
  const lines: string[] = [];
  lines.push(`模型: ${summary.model}${summary.settings?.repomap ? " (repomap)" : ""}`);
  lines.push("");
  lines.push(
    [
      pad("任务", 20),
      pad("通过", 6),
      pad("轮数", 6),
      pad("工具", 6),
      pad("编辑失败", 8),
      pad("in/out tok", 14),
      "ms",
    ].join(" "),
  );
  lines.push("-".repeat(76));
  for (const result of summary.results) {
    const id = summary.stability.trialsPerTask > 1 ? `${result.id}#${trialOf(result)}` : result.id;
    lines.push(
      [
        pad(id, 20),
        pad(result.skipped ? "↷" : result.passed ? "✓" : "✗", 6),
        pad(String(result.turns), 6),
        pad(String(result.toolCalls), 6),
        pad(`${result.editErrors}/${result.editCalls}`, 8),
        pad(`${result.inputTokens}/${result.outputTokens}`, 14),
        String(result.wallMs),
      ].join(" "),
    );
    if (result.error) lines.push(`  ! ${result.error}`);
  }
  lines.push("-".repeat(76));
  lines.push(
    `trial 通过率 ${summary.passed}/${summary.total} (${(summary.passRate * 100).toFixed(0)}%)` +
      ` [95% CI ${(summary.passRateCi95.low * 100).toFixed(0)}–${(
        summary.passRateCi95.high * 100
      ).toFixed(0)}%]` +
      (summary.skipped ? ` · 跳过 ${summary.skipped}` : "") +
      ` · 稳定通过 ${(summary.stability.stablePassRate * 100).toFixed(0)}%` +
      ` · flaky ${(summary.stability.flakyTaskRate * 100).toFixed(0)}%`,
  );
  lines.push(
    `平均轮数 ${summary.avgTurns.toFixed(1)} · ` +
      `工具失败率 ${(summary.trajectory.toolFailureRate * 100).toFixed(0)}% · ` +
      `编辑失败率 ${(summary.editFailureRate * 100).toFixed(0)}% (${summary.editErrors}/${summary.editCalls}) · ` +
      `终态完成率 ${(summary.trajectory.terminalCompletionRate * 100).toFixed(0)}% · ` +
      `收尾缺失率 ${(summary.finalResponse.missingRate * 100).toFixed(0)}%`,
  );
  lines.push(
    `token in ${summary.totalInputTokens} / out ${summary.totalOutputTokens}` +
      (summary.totalCostUSD !== undefined ? ` · $${summary.totalCostUSD.toFixed(4)}` : "") +
      ` · ${(summary.totalWallMs / 1000).toFixed(1)}s`,
  );
  return lines.join("\n");
}
