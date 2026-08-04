import { assertComparableSummaries, type Summary } from "./report.js";

export interface QualityGatePolicy {
  maxPassRateDrop?: number;
  maxEditFailureRateIncrease?: number;
  maxAverageTurnsIncrease?: number;
  maxAverageInputTokensIncrease?: number;
  maxStablePassRateDrop?: number;
  maxFlakyTaskRateIncrease?: number;
  maxToolFailureRateIncrease?: number;
  maxTerminalCompletionRateDrop?: number;
  maxFinalResponseMissingRateIncrease?: number;
  maxFalseCompletionClaimRateIncrease?: number;
  requireNoNewTaskFailures?: boolean;
}

export interface QualityGateViolation {
  metric: string;
  baseline: number | string;
  current: number | string;
  limit: number | string;
  message: string;
}

export interface QualityGateResult {
  passed: boolean;
  violations: QualityGateViolation[];
}

function relativeIncrease(current: number, baseline: number): number {
  if (baseline <= 0) return current <= 0 ? 0 : Number.POSITIVE_INFINITY;
  return (current - baseline) / baseline;
}

export function evaluateQualityGate(
  current: Summary,
  baseline: Summary,
  policy: QualityGatePolicy = {},
): QualityGateResult {
  assertComparableSummaries(current, baseline);
  const limits: Required<QualityGatePolicy> = {
    maxPassRateDrop: policy.maxPassRateDrop ?? 0.06,
    maxEditFailureRateIncrease: policy.maxEditFailureRateIncrease ?? 0.05,
    maxAverageTurnsIncrease: policy.maxAverageTurnsIncrease ?? 0.25,
    maxAverageInputTokensIncrease: policy.maxAverageInputTokensIncrease ?? 0.3,
    maxStablePassRateDrop: policy.maxStablePassRateDrop ?? 0.06,
    maxFlakyTaskRateIncrease: policy.maxFlakyTaskRateIncrease ?? 0.05,
    maxToolFailureRateIncrease: policy.maxToolFailureRateIncrease ?? 0.05,
    maxTerminalCompletionRateDrop: policy.maxTerminalCompletionRateDrop ?? 0,
    maxFinalResponseMissingRateIncrease: policy.maxFinalResponseMissingRateIncrease ?? 0.02,
    maxFalseCompletionClaimRateIncrease: policy.maxFalseCompletionClaimRateIncrease ?? 0,
    requireNoNewTaskFailures: policy.requireNoNewTaskFailures ?? true,
  };
  const violations: QualityGateViolation[] = [];
  const passDrop = baseline.passRate - current.passRate;
  if (passDrop > limits.maxPassRateDrop) {
    violations.push({
      metric: "passRate",
      baseline: baseline.passRate,
      current: current.passRate,
      limit: limits.maxPassRateDrop,
      message: `pass rate dropped ${(passDrop * 100).toFixed(1)} percentage points`,
    });
  }
  const editIncrease = current.editFailureRate - baseline.editFailureRate;
  if (editIncrease > limits.maxEditFailureRateIncrease) {
    violations.push({
      metric: "editFailureRate",
      baseline: baseline.editFailureRate,
      current: current.editFailureRate,
      limit: limits.maxEditFailureRateIncrease,
      message: `edit failure rate increased ${(editIncrease * 100).toFixed(1)} percentage points`,
    });
  }
  const turnIncrease = relativeIncrease(current.avgTurns, baseline.avgTurns);
  if (turnIncrease > limits.maxAverageTurnsIncrease) {
    violations.push({
      metric: "avgTurns",
      baseline: baseline.avgTurns,
      current: current.avgTurns,
      limit: limits.maxAverageTurnsIncrease,
      message: `average turns increased ${(turnIncrease * 100).toFixed(1)}%`,
    });
  }
  const currentAvgInput = current.total ? current.totalInputTokens / current.total : 0;
  const baselineAvgInput = baseline.total ? baseline.totalInputTokens / baseline.total : 0;
  const tokenIncrease = relativeIncrease(currentAvgInput, baselineAvgInput);
  if (tokenIncrease > limits.maxAverageInputTokensIncrease) {
    violations.push({
      metric: "avgInputTokens",
      baseline: baselineAvgInput,
      current: currentAvgInput,
      limit: limits.maxAverageInputTokensIncrease,
      message: `average input tokens increased ${(tokenIncrease * 100).toFixed(1)}%`,
    });
  }
  const stablePassDrop = baseline.stability.stablePassRate - current.stability.stablePassRate;
  if (stablePassDrop > limits.maxStablePassRateDrop) {
    violations.push({
      metric: "stablePassRate",
      baseline: baseline.stability.stablePassRate,
      current: current.stability.stablePassRate,
      limit: limits.maxStablePassRateDrop,
      message: `stable pass rate dropped ${(stablePassDrop * 100).toFixed(1)} percentage points`,
    });
  }
  const flakyIncrease = current.stability.flakyTaskRate - baseline.stability.flakyTaskRate;
  if (flakyIncrease > limits.maxFlakyTaskRateIncrease) {
    violations.push({
      metric: "flakyTaskRate",
      baseline: baseline.stability.flakyTaskRate,
      current: current.stability.flakyTaskRate,
      limit: limits.maxFlakyTaskRateIncrease,
      message: `flaky task rate increased ${(flakyIncrease * 100).toFixed(1)} percentage points`,
    });
  }
  const toolFailureIncrease =
    current.trajectory.toolFailureRate - baseline.trajectory.toolFailureRate;
  if (toolFailureIncrease > limits.maxToolFailureRateIncrease) {
    violations.push({
      metric: "toolFailureRate",
      baseline: baseline.trajectory.toolFailureRate,
      current: current.trajectory.toolFailureRate,
      limit: limits.maxToolFailureRateIncrease,
      message: `tool failure rate increased ${(toolFailureIncrease * 100).toFixed(1)} percentage points`,
    });
  }
  const terminalDrop =
    baseline.trajectory.terminalCompletionRate - current.trajectory.terminalCompletionRate;
  if (terminalDrop > limits.maxTerminalCompletionRateDrop) {
    violations.push({
      metric: "terminalCompletionRate",
      baseline: baseline.trajectory.terminalCompletionRate,
      current: current.trajectory.terminalCompletionRate,
      limit: limits.maxTerminalCompletionRateDrop,
      message: `terminal completion rate dropped ${(terminalDrop * 100).toFixed(1)} percentage points`,
    });
  }
  const missingResponseIncrease =
    current.finalResponse.missingRate - baseline.finalResponse.missingRate;
  if (missingResponseIncrease > limits.maxFinalResponseMissingRateIncrease) {
    violations.push({
      metric: "finalResponseMissingRate",
      baseline: baseline.finalResponse.missingRate,
      current: current.finalResponse.missingRate,
      limit: limits.maxFinalResponseMissingRateIncrease,
      message: `final-response missing rate increased ${(missingResponseIncrease * 100).toFixed(1)} percentage points`,
    });
  }
  const falseClaimIncrease =
    current.finalResponse.falseCompletionClaimRate -
    baseline.finalResponse.falseCompletionClaimRate;
  if (falseClaimIncrease > limits.maxFalseCompletionClaimRateIncrease) {
    violations.push({
      metric: "falseCompletionClaimRate",
      baseline: baseline.finalResponse.falseCompletionClaimRate,
      current: current.finalResponse.falseCompletionClaimRate,
      limit: limits.maxFalseCompletionClaimRateIncrease,
      message: `false completion-claim rate increased ${(falseClaimIncrease * 100).toFixed(1)} percentage points`,
    });
  }
  if (limits.requireNoNewTaskFailures) {
    const taskPassRates = (summary: Summary): Map<string, number> => {
      const grouped = new Map<string, { passed: number; total: number }>();
      for (const result of summary.results) {
        if (result.skipped) continue;
        const value = grouped.get(result.id) ?? { passed: 0, total: 0 };
        value.total++;
        if (result.passed) value.passed++;
        grouped.set(result.id, value);
      }
      return new Map(
        [...grouped].map(([id, value]) => [id, value.total ? value.passed / value.total : 0]),
      );
    };
    const baselineRates = taskPassRates(baseline);
    const currentRates = taskPassRates(current);
    const regressed = [...baselineRates]
      .filter(([id, rate]) => rate === 1 && (currentRates.get(id) ?? 0) < 1)
      .map(([id]) => id);
    if (regressed.length) {
      violations.push({
        metric: "taskRegression",
        baseline: "passed",
        current: regressed.join(","),
        limit: "none",
        message: `previously passing tasks failed: ${regressed.join(", ")}`,
      });
    }
  }
  return { passed: violations.length === 0, violations };
}

export function formatQualityGate(result: QualityGateResult): string {
  if (result.passed) return "质量门禁通过";
  return ["质量门禁失败:", ...result.violations.map((violation) => `- ${violation.message}`)].join(
    "\n",
  );
}
