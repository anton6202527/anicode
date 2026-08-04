import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  approveCandidateManifest,
  createCandidateManifest,
  serializeBaseline,
  verifyReviewedBaseline,
} from "./baseline.js";
import { summarize } from "./report.js";
import type { TaskResult } from "./runner.js";

function task(overrides: Partial<TaskResult> = {}): TaskResult {
  return {
    id: "task-a",
    title: "Task A",
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

function baselineSummary() {
  return summarize("provider/model", [task()], {
    suite: "offline",
    catalog: "offline",
    catalogDigest: "c".repeat(64),
    expectedTaskIds: ["task-a"],
    runtimeImage: "image@sha256:abc",
    revision: "1a2b3c4d5e6f789012345678901234567890abcd",
    trials: 1,
  });
}

test("baseline lifecycle: candidate is not trusted; reviewed digest is verified", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const trustedKeys = {
    approver: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
  const summary = baselineSummary();
  const text = serializeBaseline(summary);
  const candidate = createCandidateManifest(text, summary);
  assert.throws(
    () => verifyReviewedBaseline(text, summary, candidate, trustedKeys),
    /not reviewed/,
  );

  const reviewed = approveCandidateManifest(
    text,
    summary,
    candidate,
    "reviewer@example.com",
    "https://github.com/example/anicode/actions/runs/123",
    privateKey.export({ type: "pkcs8", format: "pem" }),
    "approver",
  );
  assert.doesNotThrow(() => verifyReviewedBaseline(text, summary, reviewed, trustedKeys));
  assert.throws(
    () =>
      verifyReviewedBaseline(
        text.replace("provider/model", "provider/other"),
        summary,
        reviewed,
        trustedKeys,
      ),
    /SHA-256/,
  );
  assert.throws(
    () => verifyReviewedBaseline(text, summary, reviewed, { other: trustedKeys.approver }),
    /not trusted/,
  );
});

test("baseline lifecycle: refuses unverifiable or local results", () => {
  const local = summarize("provider/model", [task()], {
    suite: "offline",
    catalog: "offline",
    catalogDigest: "c".repeat(64),
    expectedTaskIds: ["task-a"],
    runtimeImage: "local",
    revision: "local",
    trials: 1,
  });
  assert.throws(() => serializeBaseline(local), /commit hash/);

  assert.throws(
    () =>
      summarize(
        "provider/model",
        [
          task({
            passed: true,
            outcome: { status: "agent_error", verified: false, evaluator: "command" },
          }),
        ],
        {
          suite: "offline",
          catalog: "offline",
          catalogDigest: "c".repeat(64),
          expectedTaskIds: ["task-a"],
          runtimeImage: "image@sha256:abc",
          revision: "1a2b3c4d5e6f789012345678901234567890abcd",
          trials: 1,
        },
      ),
    /inconsistent deterministic outcome evidence/,
  );
});
