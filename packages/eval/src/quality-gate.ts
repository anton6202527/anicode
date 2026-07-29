import type { Summary } from "./report.js";

export interface QualityGatePolicy {
  maxPassRateDrop?: number;
  maxEditFailureRateIncrease?: number;
  maxAverageTurnsIncrease?: number;
  maxAverageInputTokensIncrease?: number;
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
  const limits: Required<QualityGatePolicy> = {
    maxPassRateDrop: policy.maxPassRateDrop ?? 0.06,
    maxEditFailureRateIncrease: policy.maxEditFailureRateIncrease ?? 0.05,
    maxAverageTurnsIncrease: policy.maxAverageTurnsIncrease ?? 0.25,
    maxAverageInputTokensIncrease: policy.maxAverageInputTokensIncrease ?? 0.3,
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
  if (limits.requireNoNewTaskFailures) {
    const baselinePassed = new Set(
      baseline.results.filter((result) => result.passed).map((result) => result.id),
    );
    const regressed = current.results
      .filter((result) => baselinePassed.has(result.id) && !result.passed && !result.skipped)
      .map((result) => result.id);
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
