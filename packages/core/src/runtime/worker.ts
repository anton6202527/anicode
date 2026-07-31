/** 持久 worker queue：lease/heartbeat/重试，以及 worktree 独占所有权。 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { noTelemetry, parseTraceparent, type SpanContext, type Telemetry } from "./telemetry.js";

export type WorkerJobStatus = "queued" | "leased" | "succeeded" | "failed" | "cancelled";

export interface WorkerJob<T = unknown, R = unknown> {
  id: string;
  type: string;
  payload: T;
  status: WorkerJobStatus;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  /** claim 时递增的 fencing token，拒绝过期 worker 的迟到提交。 */
  fencingToken?: number;
  result?: R;
  error?: string;
}

interface WorkerDocument {
  version: 1;
  jobs: WorkerJob[];
}

export interface WorkerQueueStore {
  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T>;
  enqueueJob?(job: WorkerJob): Promise<WorkerJob>;
  claimJob?(
    owner: string,
    types: string[] | undefined,
    leaseMs: number,
  ): Promise<WorkerJob | undefined>;
  heartbeatJob?(
    jobId: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void>;
  finishJob?(jobId: string, owner: string, result: unknown, fencingToken?: number): Promise<void>;
  failJob?(
    jobId: string,
    owner: string,
    error: string,
    retry: boolean,
    fencingToken?: number,
  ): Promise<void>;
  cancelJob?(jobId: string): Promise<boolean>;
  listJobs?(): Promise<WorkerJob[]>;
  get?(jobId: string): Promise<WorkerJob | undefined>;
  acquireWorktree?(worktree: string, owner: string, leaseMs: number): Promise<WorktreeLease>;
  heartbeatWorktree?(worktree: string, owner: string, leaseMs: number): Promise<void>;
  releaseWorktree?(worktree: string, owner: string, fencingToken?: number): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryWorkerQueueStore implements WorkerQueueStore {
  private jobs: WorkerJob[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T> {
    const run = this.tail.catch(() => undefined).then(async () => fn(this.jobs));
    this.tail = run;
    return run;
  }
}

export class FileWorkerQueueStore implements WorkerQueueStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(readonly file: string) {}

  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T> {
    const run = this.tail
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const lock = `${this.file}.lock`;
        const handle = await this.acquire(lock);
        try {
          const document = await this.read();
          const result = await fn(document.jobs);
          await this.write(document);
          return result;
        } finally {
          await handle.close();
          await fs.rm(lock, { force: true });
        }
      });
    this.tail = run;
    return run;
  }

  private async acquire(lock: string): Promise<import("node:fs/promises").FileHandle> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        return await fs.open(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stat = await fs.stat(lock).catch(() => undefined);
        if (stat && Date.now() - stat.mtimeMs > 30_000) await fs.rm(lock, { force: true });
        if (Date.now() >= deadline)
          throw new Error(`Worker queue lock timeout: ${lock}`, { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }

  private async read(): Promise<WorkerDocument> {
    try {
      const value = JSON.parse(await fs.readFile(this.file, "utf8")) as WorkerDocument;
      return value.version === 1 && Array.isArray(value.jobs) ? value : { version: 1, jobs: [] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
      throw error;
    }
  }

  private async write(document: WorkerDocument): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(document, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      const handle = await fs.open(temporary, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.file);
      await fs.chmod(this.file, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

export class DurableWorkerQueue {
  constructor(readonly store: WorkerQueueStore = new MemoryWorkerQueueStore()) {}

  enqueue<T>(
    type: string,
    payload: T,
    options: { idempotencyKey?: string; maxAttempts?: number } = {},
  ) {
    const key = options.idempotencyKey ?? `job:${randomUUID()}`;
    const now = new Date().toISOString();
    const proposed: WorkerJob<T> = {
      id: `job_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      type,
      payload,
      status: "queued",
      idempotencyKey: key,
      attempts: 0,
      maxAttempts: Math.max(1, options.maxAttempts ?? 3),
      createdAt: now,
      updatedAt: now,
    };
    if (this.store.enqueueJob) {
      return this.store.enqueueJob(proposed) as Promise<WorkerJob<T>>;
    }
    return this.store.transact(async (jobs) => {
      const duplicate = jobs.find((job) => job.idempotencyKey === key);
      if (duplicate) return clone(duplicate as WorkerJob<T>);
      jobs.push(proposed);
      return clone(proposed);
    });
  }

  claim(owner: string, types?: string[], leaseMs = 60_000): Promise<WorkerJob | undefined> {
    if (this.store.claimJob) return this.store.claimJob(owner, types, leaseMs);
    return this.store.transact(async (jobs) => {
      const now = Date.now();
      const job = jobs.find(
        (candidate) =>
          !candidate.type.startsWith("__worktree__:") &&
          (!types || types.includes(candidate.type)) &&
          (candidate.status === "queued" ||
            (candidate.status === "leased" &&
              (!candidate.leaseExpiresAt || Date.parse(candidate.leaseExpiresAt) <= now))),
      );
      if (!job) return undefined;
      if (job.attempts >= job.maxAttempts) {
        job.status = "failed";
        job.error = "lease expired after maximum attempts";
        job.updatedAt = new Date().toISOString();
        return undefined;
      }
      job.status = "leased";
      job.attempts++;
      job.fencingToken = (job.fencingToken ?? 0) + 1;
      job.leaseOwner = owner;
      job.leaseExpiresAt = new Date(now + Math.max(1_000, leaseMs)).toISOString();
      job.updatedAt = new Date().toISOString();
      return clone(job);
    });
  }

  heartbeat(jobId: string, owner: string, leaseMs = 60_000, fencingToken?: number): Promise<void> {
    if (this.store.heartbeatJob) {
      return this.store.heartbeatJob(jobId, owner, leaseMs, fencingToken);
    }
    return this.store.transact(async (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "leased" || job.leaseOwner !== owner)
        throw new Error(`Cannot heartbeat unowned worker job ${jobId}`);
      if (fencingToken !== undefined && job.fencingToken !== fencingToken)
        throw new Error(`Stale fencing token for worker job ${jobId}`);
      job.leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
      job.updatedAt = new Date().toISOString();
    });
  }

  finish(jobId: string, owner: string, result: unknown, fencingToken?: number): Promise<void> {
    if (this.store.finishJob) return this.store.finishJob(jobId, owner, result, fencingToken);
    return this.settle(jobId, owner, "succeeded", result, fencingToken);
  }

  fail(
    jobId: string,
    owner: string,
    error: string,
    retry = true,
    fencingToken?: number,
  ): Promise<void> {
    if (this.store.failJob) {
      return this.store.failJob(jobId, owner, error, retry, fencingToken);
    }
    return this.store.transact(async (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "leased" || job.leaseOwner !== owner)
        throw new Error(`Cannot fail unowned worker job ${jobId}`);
      if (fencingToken !== undefined && job.fencingToken !== fencingToken)
        throw new Error(`Stale fencing token for worker job ${jobId}`);
      job.status = retry && job.attempts < job.maxAttempts ? "queued" : "failed";
      job.error = error;
      job.updatedAt = new Date().toISOString();
      delete job.leaseOwner;
      delete job.leaseExpiresAt;
    });
  }

  cancel(jobId: string): Promise<boolean> {
    if (this.store.cancelJob) return this.store.cancelJob(jobId);
    return this.store.transact(async (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || ["succeeded", "failed", "cancelled"].includes(job.status)) return false;
      job.status = "cancelled";
      job.updatedAt = new Date().toISOString();
      delete job.leaseOwner;
      delete job.leaseExpiresAt;
      return true;
    });
  }

  list(): Promise<WorkerJob[]> {
    if (this.store.listJobs) return this.store.listJobs();
    return this.store.transact(async (jobs) => clone(jobs));
  }

  get(jobId: string): Promise<WorkerJob | undefined> {
    if (this.store.get) return this.store.get(jobId);
    return this.store.transact(async (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);
      return job ? clone(job) : undefined;
    });
  }

  private settle(
    jobId: string,
    owner: string,
    status: "succeeded",
    result: unknown,
    fencingToken?: number,
  ): Promise<void> {
    return this.store.transact(async (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "leased" || job.leaseOwner !== owner)
        throw new Error(`Cannot settle unowned worker job ${jobId}`);
      if (fencingToken !== undefined && job.fencingToken !== fencingToken)
        throw new Error(`Stale fencing token for worker job ${jobId}`);
      job.status = status;
      job.result = result;
      job.updatedAt = new Date().toISOString();
      delete job.leaseOwner;
      delete job.leaseExpiresAt;
    });
  }
}

export type WorkerHandler = (
  payload: unknown,
  signal: AbortSignal,
  context?: SpanContext,
) => Promise<unknown>;

export class PersistentWorker {
  private stopped = false;

  constructor(
    readonly id: string,
    readonly queue: DurableWorkerQueue,
    readonly handlers: Record<string, WorkerHandler>,
    readonly leaseMs = 60_000,
    readonly telemetry: Telemetry = noTelemetry,
  ) {}

  async runOnce(signal = new AbortController().signal): Promise<boolean> {
    const job = await this.queue.claim(this.id, Object.keys(this.handlers), this.leaseMs);
    if (!job) return false;
    const trace =
      job.payload && typeof job.payload === "object"
        ? parseTraceparent(String((job.payload as Record<string, unknown>)["traceparent"] ?? ""))
        : undefined;
    const span = this.telemetry.startSpan(
      "anicode.worker.execute",
      {
        "anicode.worker.id": this.id,
        "anicode.worker.job.id": job.id,
        "anicode.worker.job.type": job.type,
        "anicode.worker.attempt": job.attempts,
        "anicode.worker.fencing_token": job.fencingToken ?? 0,
      },
      trace,
    );
    const heartbeat = setInterval(
      () =>
        void this.queue
          .heartbeat(job.id, this.id, this.leaseMs, job.fencingToken)
          .catch(() => undefined),
      Math.max(500, Math.floor(this.leaseMs / 3)),
    );
    try {
      const result = await this.handlers[job.type]!(job.payload, signal, span.context());
      await this.queue.finish(job.id, this.id, result, job.fencingToken);
      span.setStatus({ code: "ok" });
    } catch (error) {
      await this.queue.fail(
        job.id,
        this.id,
        error instanceof Error ? error.message : String(error),
        true,
        job.fencingToken,
      );
      span.recordException(error).setStatus({ code: "error" });
    } finally {
      clearInterval(heartbeat);
      span.end();
    }
    return true;
  }

  async run(options: { pollMs?: number; signal?: AbortSignal } = {}): Promise<void> {
    this.stopped = false;
    while (!this.stopped && !options.signal?.aborted) {
      if (!(await this.runOnce(options.signal)))
        await new Promise((resolve) => setTimeout(resolve, Math.max(10, options.pollMs ?? 250)));
    }
  }

  stop(): void {
    this.stopped = true;
  }
}

export interface WorktreeLease {
  worktree: string;
  owner: string;
  expiresAt: string;
  fencingToken: number;
}

export class WorktreeOwnership {
  constructor(private readonly store: WorkerQueueStore = new MemoryWorkerQueueStore()) {}

  acquire(worktree: string, owner: string, leaseMs = 60_000): Promise<WorktreeLease> {
    const resolved = path.resolve(worktree);
    if (this.store.acquireWorktree) {
      return this.store.acquireWorktree(resolved, owner, leaseMs);
    }
    return this.store.transact(async (rows) => {
      // 复用 store 的 JSON 事务能力，ownership 记录用保留 job type 编码。
      const type = `__worktree__:${path.resolve(worktree)}`;
      const now = Date.now();
      const row = rows.find((job) => job.type === type);
      if (
        row?.status === "leased" &&
        row.leaseOwner !== owner &&
        row.leaseExpiresAt &&
        Date.parse(row.leaseExpiresAt) > now
      )
        throw new Error(`Worktree is owned by ${row.leaseOwner}: ${worktree}`);
      const expiresAt = new Date(now + Math.max(1_000, leaseMs)).toISOString();
      const fencingToken = (row?.fencingToken ?? 0) + 1;
      if (row) {
        row.status = "leased";
        row.leaseOwner = owner;
        row.leaseExpiresAt = expiresAt;
        row.fencingToken = fencingToken;
        row.updatedAt = new Date().toISOString();
      } else {
        const createdAt = new Date().toISOString();
        rows.push({
          id: `wt_${randomUUID().replace(/-/g, "")}`,
          type,
          payload: { worktree: path.resolve(worktree) },
          status: "leased",
          idempotencyKey: type,
          attempts: 1,
          maxAttempts: Number.MAX_SAFE_INTEGER,
          createdAt,
          updatedAt: createdAt,
          leaseOwner: owner,
          leaseExpiresAt: expiresAt,
          fencingToken,
        });
      }
      return { worktree: path.resolve(worktree), owner, expiresAt, fencingToken };
    });
  }

  async heartbeat(worktree: string, owner: string, leaseMs = 60_000): Promise<void> {
    const resolved = path.resolve(worktree);
    if (this.store.heartbeatWorktree) {
      await this.store.heartbeatWorktree(resolved, owner, leaseMs);
      return;
    }
    await this.store.transact(async (rows) => {
      const type = `__worktree__:${resolved}`;
      const row = rows.find((job) => job.type === type);
      if (!row || row.status !== "leased" || row.leaseOwner !== owner) {
        throw new Error(`Cannot heartbeat unowned worktree: ${worktree}`);
      }
      row.leaseExpiresAt = new Date(Date.now() + Math.max(1_000, leaseMs)).toISOString();
      row.updatedAt = new Date().toISOString();
    });
  }

  release(worktree: string, owner: string, fencingToken?: number): Promise<void> {
    const resolved = path.resolve(worktree);
    if (this.store.releaseWorktree) {
      return this.store.releaseWorktree(resolved, owner, fencingToken);
    }
    return this.store.transact(async (rows) => {
      const type = `__worktree__:${resolved}`;
      const row = rows.find((job) => job.type === type);
      if (!row || row.leaseOwner !== owner)
        throw new Error(`Cannot release unowned worktree: ${worktree}`);
      if (fencingToken !== undefined && row.fencingToken !== fencingToken)
        throw new Error(`Stale fencing token for worktree: ${worktree}`);
      row.status = "succeeded";
      row.updatedAt = new Date().toISOString();
      delete row.leaseOwner;
      delete row.leaseExpiresAt;
    });
  }
}
