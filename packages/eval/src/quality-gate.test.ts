import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateQualityGate } from "./quality-gate.js";
import type { Summary } from "./report.js";

function summary(overrides: Partial<Summary> = {}): Summary {
  return {
    model: "demo",
    total: 2,
    passed: 2,
    skipped: 0,
    passRate: 1,
    avgTurns: 2,
    totalInputTokens: 200,
    totalOutputTokens: 20,
    editCalls: 2,
    editErrors: 0,
    editFailureRate: 0,
    totalWallMs: 100,
    results: [
      {
        id: "a",
        title: "a",
        passed: true,
        turns: 2,
        toolCalls: 1,
        editCalls: 1,
        editErrors: 0,
        toolErrors: 0,
        inputTokens: 100,
        outputTokens: 10,
        wallMs: 50,
      },
      {
        id: "b",
        title: "b",
        passed: true,
        turns: 2,
        toolCalls: 1,
        editCalls: 1,
        editErrors: 0,
        toolErrors: 0,
        inputTokens: 100,
        outputTokens: 10,
        wallMs: 50,
      },
    ],
    ...overrides,
  };
}

test("eval quality gate: 同时守通过率、任务回归、轮数、token 与编辑失败", () => {
  const baseline = summary();
  const current = summary({
    passed: 1,
    passRate: 0.5,
    avgTurns: 4,
    totalInputTokens: 500,
    editErrors: 1,
    editFailureRate: 0.5,
    results: [{ ...baseline.results[0]!, passed: false }, baseline.results[1]!],
  });
  const result = evaluateQualityGate(current, baseline);
  assert.equal(result.passed, false);
  assert.deepEqual(
    new Set(result.violations.map((violation) => violation.metric)),
    new Set(["passRate", "editFailureRate", "avgTurns", "avgInputTokens", "taskRegression"]),
  );
});
