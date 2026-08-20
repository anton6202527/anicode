import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PERFORMANCE_PROFILES,
  renderPerformanceSummary,
  runPerformanceBenchmark,
  type PerformanceBenchmarkResult,
  type TimingSummary,
} from "./performance-benchmark.js";

function assertTiming(value: TimingSummary, expectedSamples: number): void {
  assert.equal(value.samples, expectedSamples);
  for (const field of ["totalMs", "meanMs", "medianMs", "p95Ms", "minMs", "maxMs"] as const) {
    assert.equal(Number.isFinite(value[field]), true, `${field} should be finite`);
    assert.ok(value[field] >= 0, `${field} should be non-negative`);
  }
  assert.ok(value.minMs <= value.maxMs);
}

function timingFields(result: PerformanceBenchmarkResult): TimingSummary[] {
  return [
    result.repoMap.lightweight.cold,
    result.repoMap.lightweight.warm,
    result.sqliteWorkerQueue.operations.enqueue,
    result.sqliteWorkerQueue.operations.claim,
    result.sqliteWorkerQueue.operations.get,
    result.sqliteSession.operations.appendMany,
    result.sqliteSession.operations.getMeta,
    result.sqliteSession.operations.updateMeta,
  ];
}

test("performance harness smoke profile reports stable fields, scale, and operation semantics", async () => {
  const result = await runPerformanceBenchmark("smoke");
  const config = PERFORMANCE_PROFILES.smoke;

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.profile, "smoke");
  assert.equal(result.config.repoMapFiles, config.repoMapFiles);
  assert.equal(result.config.workerHistoryRows, config.workerHistoryRows);
  assert.equal(result.config.sessionHistoryMessages, config.sessionHistoryMessages);
  assert.equal(result.repoMap.lightweight.files, config.repoMapFiles);
  assert.ok(result.repoMap.lightweight.coldOutputBytes > 0);
  assert.ok(result.repoMap.lightweight.warmOutputBytes > 0);
  assert.equal(result.repoMap.productionColdBudget.files, config.productionRepoMapFiles);
  assert.equal(result.repoMap.productionColdBudget.configuredMs, config.productionColdBudgetMs);
  assert.ok(
    result.repoMap.productionColdBudget.observedMs <= config.productionColdBudgetMs + 75,
    `production cold repo-map took ${result.repoMap.productionColdBudget.observedMs}ms for a ${config.productionColdBudgetMs}ms budget`,
  );
  assert.equal(
    result.repoMap.productionColdBudget.returnedBeforePrewarm,
    result.repoMap.productionColdBudget.firstOutputBytes > 0,
  );
  assert.ok(result.repoMap.productionColdBudget.afterPrewarmOutputBytes > 0);

  assert.equal(result.sqliteWorkerQueue.historyRowsVerified, config.workerHistoryRows);
  assert.equal(result.sqliteWorkerQueue.semantics.enqueued, config.samples);
  assert.equal(result.sqliteWorkerQueue.semantics.claimed, config.samples);
  assert.equal(result.sqliteWorkerQueue.semantics.uniqueClaims, config.samples);
  assert.equal(result.sqliteWorkerQueue.semantics.pointReadId, "history-000000");
  assert.equal(result.sqliteWorkerQueue.semantics.pointReadStatus, "succeeded");

  const expectedMessages =
    config.sessionHistoryMessages + config.samples * config.sessionAppendBatchSize;
  assert.equal(result.sqliteSession.semantics.expectedMessages, expectedMessages);
  assert.equal(result.sqliteSession.semantics.verifiedMessages, expectedMessages);
  assert.equal(result.sqliteSession.semantics.pointReadId, "performance-session");
  assert.equal(result.sqliteSession.semantics.finalTitle, `benchmark-title-${config.samples - 1}`);
  assert.equal(result.sqliteSession.semantics.metadataUpdateAvoidedTranscriptRewrite, true);

  timingFields(result).forEach((timing, index) => {
    assertTiming(timing, index === 0 ? 1 : config.samples);
  });

  const serialized = JSON.parse(JSON.stringify(result)) as PerformanceBenchmarkResult;
  assert.equal(serialized.schemaVersion, 1);
  const summary = renderPerformanceSummary(result);
  assert.match(summary, /repo-map production cold/);
  assert.match(summary, /SQLite worker 100 history rows/);
  assert.match(summary, /SQLite session 80 history messages/);
});
