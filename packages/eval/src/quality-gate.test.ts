import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateQualityGate } from "./quality-gate.js";
import { summarize } from "./report.js";
import type { TaskResult } from "./runner.js";

function task(id: string, overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id,
    title: id,
    trial: 1,
    passed: true,
    turns: 2,
    toolCalls: 1,
    editCalls: 1,
    editErrors: 0,
    toolErrors: 0,
    inputTokens: 100,
    outputTokens: 10,
    wallMs: 50,
    outcome: { status: "passed", verified: true, evaluator: "command", exitCode: 0 },
    trajectory: {
      completed: true,
      retries: 0,
      fallbacks: 0,
      compactions: 0,
      verifications: 0,
      permissionDenials: 0,
      calls: [],
      signatureSha256: "a".repeat(64),
    },
    finalResponse: {
      present: true,
      chars: 4,
      sha256: "b".repeat(64),
      completionClaim: true,
      outcomeAligned: true,
    },
    ...overrides,
  };
}

const settings = {
  suite: "offline" as const,
  catalog: "offline",
  catalogDigest: "c".repeat(64),
  expectedTaskIds: ["a", "b"],
  runtimeImage: "image@sha256:abc",
  revision: "baseline-revision",
  trials: 1,
};

test("eval quality gate: outcome, trajectory, stability and final response all fail closed", () => {
  const baseline = summarize("demo", [task("a"), task("b")], settings);
  const current = summarize(
    "demo",
    [
      task("a", {
        passed: false,
        turns: 4,
        toolErrors: 1,
        inputTokens: 250,
        editErrors: 1,
        outcome: { status: "failed", verified: true, evaluator: "command", exitCode: 1 },
        trajectory: {
          ...task("x").trajectory,
          completed: false,
          calls: [
            {
              sequence: 1,
              name: "write",
              ruleKeySha256: "c".repeat(64),
              result: "error",
            },
          ],
        },
        finalResponse: {
          present: false,
          chars: 0,
          completionClaim: true,
          outcomeAligned: false,
        },
      }),
      task("b"),
    ],
    { ...settings, revision: "current-revision" },
  );
  const result = evaluateQualityGate(current, baseline);
  assert.equal(result.passed, false);
  assert.deepEqual(
    new Set(result.violations.map((violation) => violation.metric)),
    new Set([
      "passRate",
      "editFailureRate",
      "avgTurns",
      "avgInputTokens",
      "stablePassRate",
      "toolFailureRate",
      "terminalCompletionRate",
      "finalResponseMissingRate",
      "falseCompletionClaimRate",
      "taskRegression",
    ]),
  );
});

test("eval quality gate: refuses incomparable trial profiles", () => {
  const baseline = summarize("demo", [task("a")], { ...settings, expectedTaskIds: ["a"] });
  const current = summarize("demo", [task("a", { trial: 1 }), task("a", { trial: 2 })], {
    ...settings,
    expectedTaskIds: ["a"],
    trials: 2,
  });
  assert.throws(() => evaluateQualityGate(current, baseline), /trials mismatch/);
});

test("eval quality gate: refuses a missing or substituted task even if rates improve", () => {
  const baseline = summarize(
    "demo",
    [
      task("a"),
      task("b", {
        passed: false,
        outcome: { status: "failed", verified: true, evaluator: "command", exitCode: 1 },
      }),
    ],
    settings,
  );
  const current = summarize("demo", [task("a"), task("easy")], {
    ...settings,
    expectedTaskIds: ["a", "easy"],
  });
  assert.throws(() => evaluateQualityGate(current, baseline), /task set mismatch/);
});

test("eval quality gate: refuses skipped trials", () => {
  const baseline = summarize("demo", [task("a"), task("b")], settings);
  const current = summarize(
    "demo",
    [
      task("a"),
      task("b", {
        passed: false,
        skipped: true,
        outcome: { status: "skipped", verified: false, evaluator: "requirements" },
      }),
    ],
    settings,
  );
  assert.throws(() => evaluateQualityGate(current, baseline), /skipped trials/);
});
