import { performance } from "node:perf_hooks";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { gatherRepoMap, prewarmRepoMap } from "../src/repomap.js";
import {
  SqliteRuntimeDatabase,
  SqliteRuntimeSessionStore,
  SqliteWorkerQueueStore,
} from "../src/runtime/sqlite.js";
import type { WorkerJob } from "../src/runtime/worker.js";
import type { ChatMessage } from "../src/types.js";

export interface TimingSummary {
  samples: number;
  totalMs: number;
  meanMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
}

export interface PerformanceProfile {
  repoMapFiles: number;
  productionRepoMapFiles: number;
  productionColdBudgetMs: number;
  workerHistoryRows: number;
  sessionHistoryMessages: number;
  sessionAppendBatchSize: number;
  samples: number;
}

export interface PerformanceBenchmarkResult {
  schemaVersion: 1;
  profile: keyof typeof PERFORMANCE_PROFILES;
  generatedAt: string;
  runtime: {
    node: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  config: PerformanceProfile;
  repoMap: {
    lightweight: {
      files: number;
      cold: TimingSummary;
      warm: TimingSummary;
      coldOutputBytes: number;
      warmOutputBytes: number;
    };
    productionColdBudget: {
      files: number;
      configuredMs: number;
      observedMs: number;
      returnedBeforePrewarm: boolean;
      firstOutputBytes: number;
      afterPrewarmOutputBytes: number;
    };
  };
  sqliteWorkerQueue: {
    historyRows: number;
    historyRowsVerified: number;
    operations: {
      enqueue: TimingSummary;
      claim: TimingSummary;
      get: TimingSummary;
    };
    semantics: {
      enqueued: number;
      claimed: number;
      uniqueClaims: number;
      pointReadId: string;
      pointReadStatus: WorkerJob["status"];
    };
  };
  sqliteSession: {
    historyMessages: number;
    appendBatchSize: number;
    operations: {
      appendMany: TimingSummary;
      getMeta: TimingSummary;
      updateMeta: TimingSummary;
    };
    semantics: {
      expectedMessages: number;
      verifiedMessages: number;
      pointReadId: string;
      finalTitle: string;
      metadataUpdateAvoidedTranscriptRewrite: boolean;
    };
  };
}

export const PERFORMANCE_PROFILES = {
  smoke: {
    repoMapFiles: 24,
    productionRepoMapFiles: 80,
    productionColdBudgetMs: 25,
    workerHistoryRows: 100,
    sessionHistoryMessages: 80,
    sessionAppendBatchSize: 3,
    samples: 3,
  },
  standard: {
    repoMapFiles: 160,
    productionRepoMapFiles: 1_200,
    productionColdBudgetMs: 25,
    workerHistoryRows: 5_000,
    sessionHistoryMessages: 2_000,
    sessionAppendBatchSize: 8,
    samples: 20,
  },
} as const satisfies Record<string, PerformanceProfile>;

function round(value: number): number {
  return Number(value.toFixed(3));
}

function summarize(durations: number[]): TimingSummary {
  if (durations.length === 0) throw new Error("A timing summary requires at least one sample");
  const sorted = [...durations].sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const percentile = (fraction: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
    return sorted[index]!;
  };
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    samples: sorted.length,
    totalMs: round(total),
    meanMs: round(total / sorted.length),
    medianMs: round(median),
    p95Ms: round(percentile(0.95)),
    minMs: round(sorted[0]!),
    maxMs: round(sorted.at(-1)!),
  };
}

async function measure(
  samples: number,
  operation: (sample: number) => Promise<void>,
): Promise<TimingSummary> {
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample++) {
    const startedAt = performance.now();
    await operation(sample);
    durations.push(performance.now() - startedAt);
  }
  return summarize(durations);
}

async function writeInBatches(
  inputs: Array<{ file: string; content: string }>,
  batchSize = 64,
): Promise<void> {
  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    await Promise.all(
      inputs
        .slice(offset, offset + batchSize)
        .map(({ file, content }) => writeFile(file, content, "utf8")),
    );
  }
}

async function createRepoFixture(root: string, files: number): Promise<void> {
  const directories = Math.ceil(files / 40);
  await Promise.all(
    Array.from({ length: directories }, (_, index) =>
      mkdir(path.join(root, `module-${String(index).padStart(3, "0")}`), { recursive: true }),
    ),
  );
  const inputs = Array.from({ length: files }, (_, index) => {
    const suffix = String(index).padStart(4, "0");
    const previous = String(Math.max(0, index - 1)).padStart(4, "0");
    return {
      file: path.join(
        root,
        `module-${String(Math.floor(index / 40)).padStart(3, "0")}`,
        `file-${suffix}.ts`,
      ),
      content: [
        `export interface Entity${suffix} { value: number; label: string }`,
        `export function compute${suffix}(input: Entity${suffix}): number {`,
        `  return input.value + ${index};`,
        `}`,
        `export const dependency${suffix} = "compute${previous}";`,
        "",
      ].join("\n"),
    };
  });
  await writeInBatches(inputs);
}

async function benchmarkRepoMap(
  temporaryRoot: string,
  config: PerformanceProfile,
): Promise<PerformanceBenchmarkResult["repoMap"]> {
  const lightweightRoot = path.join(temporaryRoot, "repo-map-lightweight");
  const productionRoot = path.join(temporaryRoot, "repo-map-production");
  await Promise.all([
    createRepoFixture(lightweightRoot, config.repoMapFiles),
    createRepoFixture(productionRoot, config.productionRepoMapFiles),
  ]);

  let coldOutput = "";
  const cold = await measure(1, async () => {
    coldOutput = await gatherRepoMap(lightweightRoot, {
      maxFiles: config.repoMapFiles,
      maxStaleMs: 0,
      query: "compute dependency",
    });
  });
  let warmOutput = "";
  const warm = await measure(config.samples, async (sample) => {
    warmOutput = await gatherRepoMap(lightweightRoot, {
      maxFiles: config.repoMapFiles,
      maxStaleMs: 30_000,
      query: `compute dependency ${sample}`,
    });
  });
  // A warm request schedules a refresh after rendering. Join it before removing the fixture.
  await prewarmRepoMap(lightweightRoot, { maxFiles: config.repoMapFiles });

  const productionStartedAt = performance.now();
  const productionFirstOutput = await gatherRepoMap(productionRoot, {
    maxFiles: config.productionRepoMapFiles,
    maxStaleMs: 0,
    coldStartTimeoutMs: config.productionColdBudgetMs,
    query: "production startup",
  });
  const productionElapsed = performance.now() - productionStartedAt;
  // Whether the bounded call completed or deferred, the already-started generation must become
  // available to the following request.
  await prewarmRepoMap(productionRoot, { maxFiles: config.productionRepoMapFiles });
  const productionReadyOutput = await gatherRepoMap(productionRoot, {
    maxFiles: config.productionRepoMapFiles,
    maxStaleMs: 30_000,
    coldStartTimeoutMs: config.productionColdBudgetMs,
    query: "production startup",
  });
  await prewarmRepoMap(productionRoot, { maxFiles: config.productionRepoMapFiles });

  if (!coldOutput || !warmOutput || !productionReadyOutput) {
    throw new Error("Repo-map benchmark fixture did not produce a map");
  }
  return {
    lightweight: {
      files: config.repoMapFiles,
      cold,
      warm,
      coldOutputBytes: Buffer.byteLength(coldOutput),
      warmOutputBytes: Buffer.byteLength(warmOutput),
    },
    productionColdBudget: {
      files: config.productionRepoMapFiles,
      configuredMs: config.productionColdBudgetMs,
      observedMs: round(productionElapsed),
      returnedBeforePrewarm: productionFirstOutput.length > 0,
      firstOutputBytes: Buffer.byteLength(productionFirstOutput),
      afterPrewarmOutputBytes: Buffer.byteLength(productionReadyOutput),
    },
  };
}

function workerJob(
  id: string,
  type: string,
  status: WorkerJob["status"],
  timestamp: string,
): WorkerJob {
  return {
    id,
    type,
    payload: { benchmark: true, id },
    status,
    idempotencyKey: `idempotency-${id}`,
    attempts: status === "succeeded" ? 1 : 0,
    maxAttempts: 3,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function message(index: number): ChatMessage {
  return {
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `benchmark-message-${index}` }],
  };
}

async function benchmarkSqlite(
  temporaryRoot: string,
  config: PerformanceProfile,
): Promise<{
  worker: PerformanceBenchmarkResult["sqliteWorkerQueue"];
  session: PerformanceBenchmarkResult["sqliteSession"];
}> {
  const database = new SqliteRuntimeDatabase(path.join(temporaryRoot, "performance.sqlite"));
  try {
    const worker = new SqliteWorkerQueueStore(database);
    const timestamp = new Date().toISOString();
    await worker.transact((jobs) => {
      for (let index = 0; index < config.workerHistoryRows; index++) {
        jobs.push(
          workerJob(`history-${String(index).padStart(6, "0")}`, "history", "succeeded", timestamp),
        );
      }
    });
    const historyRowsVerified = await database.run((db) => {
      const row = db
        .prepare("SELECT COUNT(*) AS count FROM worker_jobs WHERE type = 'history'")
        .get() as { count: number | bigint };
      return Number(row.count);
    });

    let pointRead: WorkerJob | undefined;
    const get = await measure(config.samples, async () => {
      pointRead = await worker.get("history-000000");
    });

    const enqueuedIds: string[] = [];
    const enqueue = await measure(config.samples, async (sample) => {
      const id = `queued-${String(sample).padStart(6, "0")}`;
      const enqueued = await worker.enqueueJob(workerJob(id, "benchmark", "queued", timestamp));
      enqueuedIds.push(enqueued.id);
    });

    const claimedJobs: WorkerJob[] = [];
    const claim = await measure(config.samples, async () => {
      const claimed = await worker.claimJob("benchmark-owner", ["benchmark"], 60_000);
      if (!claimed) throw new Error("SQLite worker benchmark expected a claimable job");
      claimedJobs.push(claimed);
    });
    // Settlement is deliberately outside the claim timer; this metric isolates the indexed row
    // selection and lease transition requested by the benchmark.
    for (const claimed of claimedJobs) {
      await worker.finishJob(
        claimed.id,
        "benchmark-owner",
        { benchmark: true },
        claimed.fencingToken,
      );
    }

    if (!pointRead || pointRead.status !== "succeeded") {
      throw new Error("SQLite worker benchmark point read returned the wrong job");
    }
    const claimedIds = claimedJobs.map((job) => job.id);
    if (
      claimedIds.length !== enqueuedIds.length ||
      claimedIds.some((id) => !enqueuedIds.includes(id))
    ) {
      throw new Error("SQLite worker benchmark did not claim every enqueued job exactly once");
    }

    const sessionStore = new SqliteRuntimeSessionStore(database);
    const sessionId = "performance-session";
    let sessionMeta = await sessionStore.create({
      id: sessionId,
      cwd: temporaryRoot,
      model: "benchmark-model",
      title: "initial",
    });
    await sessionStore.appendMany(
      sessionId,
      Array.from({ length: config.sessionHistoryMessages }, (_, index) => message(index)),
    );

    // A metadata point update must work even when transcript mutation is explicitly forbidden.
    // Inserts remain allowed so appendMany can be timed after this check.
    await database.run((db) => {
      db.exec(`
        CREATE TEMP TRIGGER benchmark_no_message_delete
        BEFORE DELETE ON session_messages
        WHEN OLD.session_id = '${sessionId}'
        BEGIN SELECT RAISE(FAIL, 'metadata update rewrote transcript'); END;
        CREATE TEMP TRIGGER benchmark_no_message_update
        BEFORE UPDATE ON session_messages
        WHEN OLD.session_id = '${sessionId}'
        BEGIN SELECT RAISE(FAIL, 'metadata update rewrote transcript'); END;
      `);
    });

    let pointReadMeta = await sessionStore.getMeta(sessionId);
    const getMeta = await measure(config.samples, async () => {
      pointReadMeta = await sessionStore.getMeta(sessionId);
    });

    const updateMeta = await measure(config.samples, async (sample) => {
      sessionMeta = await sessionStore.updateMeta({
        ...sessionMeta,
        title: `benchmark-title-${sample}`,
      });
    });

    let nextMessageIndex = config.sessionHistoryMessages;
    const appendMany = await measure(config.samples, async () => {
      const batch = Array.from({ length: config.sessionAppendBatchSize }, () =>
        message(nextMessageIndex++),
      );
      await sessionStore.appendMany(sessionId, batch);
    });

    const loaded = await sessionStore.load(sessionId);
    const expectedMessages =
      config.sessionHistoryMessages + config.samples * config.sessionAppendBatchSize;
    const finalMeta = await sessionStore.getMeta(sessionId);
    if (!pointReadMeta || pointReadMeta.id !== sessionId) {
      throw new Error("SQLite session benchmark metadata point read returned the wrong session");
    }
    if (loaded.messages.length !== expectedMessages || finalMeta?.title !== sessionMeta.title) {
      throw new Error("SQLite session benchmark persistence verification failed");
    }

    return {
      worker: {
        historyRows: config.workerHistoryRows,
        historyRowsVerified,
        operations: { enqueue, claim, get },
        semantics: {
          enqueued: enqueuedIds.length,
          claimed: claimedIds.length,
          uniqueClaims: new Set(claimedIds).size,
          pointReadId: pointRead.id,
          pointReadStatus: pointRead.status,
        },
      },
      session: {
        historyMessages: config.sessionHistoryMessages,
        appendBatchSize: config.sessionAppendBatchSize,
        operations: { appendMany, getMeta, updateMeta },
        semantics: {
          expectedMessages,
          verifiedMessages: loaded.messages.length,
          pointReadId: pointReadMeta.id,
          finalTitle: finalMeta.title ?? "",
          metadataUpdateAvoidedTranscriptRewrite: true,
        },
      },
    };
  } finally {
    await database.close();
  }
}

export async function runPerformanceBenchmark(
  profile: keyof typeof PERFORMANCE_PROFILES = "standard",
): Promise<PerformanceBenchmarkResult> {
  const config = { ...PERFORMANCE_PROFILES[profile] };
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "anicode-performance-"));
  try {
    const repoMap = await benchmarkRepoMap(temporaryRoot, config);
    const sqlite = await benchmarkSqlite(temporaryRoot, config);
    return {
      schemaVersion: 1,
      profile,
      generatedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      config,
      repoMap,
      sqliteWorkerQueue: sqlite.worker,
      sqliteSession: sqlite.session,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export function renderPerformanceSummary(result: PerformanceBenchmarkResult): string {
  const metric = (timing: TimingSummary): string =>
    `median ${timing.medianMs.toFixed(3)}ms / p95 ${timing.p95Ms.toFixed(3)}ms`;
  const coldBudget = result.repoMap.productionColdBudget;
  const coldOutcome = coldBudget.returnedBeforePrewarm ? "ready" : "deferred";
  return [
    `anicode core performance (${result.profile})`,
    `repo-map ${result.repoMap.lightweight.files} files: cold ${result.repoMap.lightweight.cold.medianMs.toFixed(3)}ms; warm ${metric(result.repoMap.lightweight.warm)}`,
    `repo-map production cold ${coldBudget.files} files: ${coldBudget.observedMs.toFixed(3)}ms / ${coldBudget.configuredMs}ms configured (${coldOutcome}, prewarmed ${coldBudget.afterPrewarmOutputBytes} bytes)`,
    `SQLite worker ${result.sqliteWorkerQueue.historyRows} history rows: get ${metric(result.sqliteWorkerQueue.operations.get)}; enqueue ${metric(result.sqliteWorkerQueue.operations.enqueue)}; claim ${metric(result.sqliteWorkerQueue.operations.claim)}`,
    `SQLite session ${result.sqliteSession.historyMessages} history messages: getMeta ${metric(result.sqliteSession.operations.getMeta)}; updateMeta ${metric(result.sqliteSession.operations.updateMeta)}; appendMany(${result.sqliteSession.appendBatchSize}) ${metric(result.sqliteSession.operations.appendMany)}`,
  ].join("\n");
}

function parseProfile(argv: string[]): keyof typeof PERFORMANCE_PROFILES {
  const inline = argv
    .find((argument) => argument.startsWith("--profile="))
    ?.slice("--profile=".length);
  const separateIndex = argv.indexOf("--profile");
  const requested =
    inline ?? (separateIndex >= 0 ? argv[separateIndex + 1] : undefined) ?? "standard";
  if (!(requested in PERFORMANCE_PROFILES)) {
    throw new Error(
      `Unknown performance profile ${JSON.stringify(requested)}; use smoke or standard`,
    );
  }
  return requested as keyof typeof PERFORMANCE_PROFILES;
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isDirectExecution()) {
  try {
    const result = await runPerformanceBenchmark(parseProfile(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!process.argv.includes("--json-only")) {
      process.stderr.write(`${renderPerformanceSummary(result)}\n`);
    }
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
