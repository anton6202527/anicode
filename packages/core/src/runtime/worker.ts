/** 持久 worker queue：lease/heartbeat/重试，以及 worktree 独占所有权。 */

import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";
import { noTelemetry, parseTraceparent, type SpanContext, type Telemetry } from "./telemetry.js";

export type WorkerJobStatus =
  "queued" | "leased" | "cancellation_requested" | "succeeded" | "failed" | "cancelled";

export type WorkerCancellationResult = "cancellation_requested" | "cancelled" | "not_cancellable";

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

export interface WorkerEnqueueQuota {
  tenantId: string;
  actor: string;
  maxOutstandingPerTenant: number;
  maxQueuedPerActor: number;
}

export class WorkerQueueQuotaError extends Error {
  constructor(
    readonly code: "tenant_quota_exceeded" | "actor_queue_full",
    message: string,
  ) {
    super(message);
    this.name = "WorkerQueueQuotaError";
  }
}

interface WorkerDocument {
  version: 1;
  jobs: WorkerJob[];
}

export interface WorkerQueueStore {
  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T>;
  enqueueJob?(job: WorkerJob): Promise<WorkerJob>;
  enqueueJobWithQuota?(job: WorkerJob, quota: WorkerEnqueueQuota): Promise<WorkerJob>;
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
  requestCancellationJob?(jobId: string): Promise<WorkerCancellationResult>;
  acknowledgeCancellationJob?(jobId: string, owner: string, fencingToken?: number): Promise<void>;
  /** @deprecated Implement the two-phase cancellation methods above. */
  cancelJob?(jobId: string): Promise<boolean>;
  listJobs?(): Promise<WorkerJob[]>;
  get?(jobId: string): Promise<WorkerJob | undefined>;
  acquireWorktree?(worktree: string, owner: string, leaseMs: number): Promise<WorktreeLease>;
  heartbeatWorktree?(
    worktree: string,
    owner: string,
    leaseMs: number,
    fencingToken?: number,
  ): Promise<void>;
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

export interface FileWorkerQueueStoreOptions {
  /** Lock tuning for tests/embedded stores. Production should use the defaults. */
  lockTimeoutMs?: number;
  lockRetryMs?: number;
}

interface QueueFileLockOwner {
  version: 1;
  ownerToken: string;
  pid: number;
  host: string;
  acquiredAt: string;
}

interface QueueFileLock {
  handle: import("node:fs/promises").FileHandle;
  owner: QueueFileLockOwner;
  dev: bigint;
  ino: bigint;
}

export class FileWorkerQueueStore implements WorkerQueueStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly options: FileWorkerQueueStoreOptions = {},
  ) {}

  transact<T>(fn: (jobs: WorkerJob[]) => T | Promise<T>): Promise<T> {
    const run = this.tail
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const lock = `${this.file}.lock`;
        const lease = await this.acquire(lock);
        try {
          const document = await this.read();
          const result = await fn(document.jobs);
          await this.write(document);
          return result;
        } finally {
          await this.release(lock, lease).catch(() => undefined);
          await lease.handle.close();
        }
      });
    this.tail = run;
    return run;
  }

  private async acquire(lock: string): Promise<QueueFileLock> {
    const deadline = Date.now() + Math.max(1, this.options.lockTimeoutMs ?? 10_000);
    const retryMs = Math.max(1, this.options.lockRetryMs ?? 10);
    for (;;) {
      try {
        const handle = await fs.open(lock, "wx", 0o600);
        const owner: QueueFileLockOwner = {
          version: 1,
          ownerToken: randomBytes(32).toString("hex"),
          pid: process.pid,
          host: hostname(),
          acquiredAt: new Date().toISOString(),
        };
        try {
          await handle.writeFile(JSON.stringify(owner));
          await handle.sync();
          const stat = await handle.stat({ bigint: true });
          return { handle, owner, dev: stat.dev, ino: stat.ino };
        } catch (error) {
          await handle.close().catch(() => undefined);
          // If durable owner publication fails, leave the exclusive inode in place. Removing an
          // incompletely published lock without a verifiable token could delete a replacement.
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error(`Worker queue lock timeout: ${lock}`, { cause: error });
        // A suspended transaction remains authoritative regardless of mtime. Recovery is an
        // explicit operator action; this hot path never guesses that an owner is dead.
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
  }

  private async release(lock: string, lease: QueueFileLock): Promise<void> {
    const [owner, stat] = await Promise.all([
      this.readLockOwner(lock).catch(() => undefined),
      fs.lstat(lock, { bigint: true }).catch(() => undefined),
    ]);
    if (
      owner?.ownerToken === lease.owner.ownerToken &&
      owner.pid === lease.owner.pid &&
      stat?.dev === lease.dev &&
      stat.ino === lease.ino
    ) {
      await fs.unlink(lock);
    }
  }

  private async readLockOwner(lock: string): Promise<QueueFileLockOwner> {
    const owner = JSON.parse(await fs.readFile(lock, "utf8")) as Partial<QueueFileLockOwner>;
    if (
      owner.version !== 1 ||
      typeof owner.ownerToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(owner.ownerToken) ||
      !Number.isSafeInteger(owner.pid) ||
      typeof owner.host !== "string" ||
      typeof owner.acquiredAt !== "string"
    ) {
      throw new Error(`Invalid worker queue lock: ${lock}`);
    }
    return owner as QueueFileLockOwner;
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
      // Windows requires write access on a handle passed to FlushFileBuffers/FileHandle.sync.
      const handle = await fs.open(temporary, "r+");
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
    options: { idempotencyKey?: string; maxAttempts?: number; quota?: WorkerEnqueueQuota } = {},
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
    if (options.quota && this.store.enqueueJobWithQuota) {
      return this.store.enqueueJobWithQuota(proposed, options.quota) as Promise<WorkerJob<T>>;
    }
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
      for (const candidate of jobs) {
        if (
          candidate.status === "cancellation_requested" &&
          (!candidate.leaseExpiresAt || Date.parse(candidate.leaseExpiresAt) <= now)
        ) {
          candidate.status = "failed";
          candidate.error =
            "cancellation acknowledgement lease expired; execution outcome indeterminate";
          candidate.updatedAt = new Date().toISOString();
          delete candidate.leaseOwner;
          delete candidate.leaseExpiresAt;
        }
      }
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

  async cancel(jobId: string): Promise<boolean> {
    return (await this.requestCancellation(jobId)) !== "not_cancellable";
  }

  requestCancellation(jobId: string): Promise<WorkerCancellationResult> {
    if (this.store.requestCancellationJob) return this.store.requestCancellationJob(jobId);
    return this.store.transact(async (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || ["succeeded", "failed"].includes(job.status)) return "not_cancellable";
      if (job.status === "cancelled") return "cancelled";
      if (job.status === "cancellation_requested") return "cancellation_requested";
      if (job.status === "leased") {
        job.status = "cancellation_requested";
        job.updatedAt = new Date().toISOString();
        return "cancellation_requested";
      }
      job.status = "cancelled";
      job.updatedAt = new Date().toISOString();
      delete job.leaseOwner;
      delete job.leaseExpiresAt;
      return "cancelled";
    });
  }

  acknowledgeCancellation(jobId: string, owner: string, fencingToken?: number): Promise<void> {
    if (this.store.acknowledgeCancellationJob) {
      return this.store.acknowledgeCancellationJob(jobId, owner, fencingToken);
    }
    return this.store.transact(async (jobs) => {
      const job = jobs.find((candidate) => candidate.id === jobId);
      if (!job || job.status !== "cancellation_requested" || job.leaseOwner !== owner) {
        throw new Error(`Cannot acknowledge unowned worker job cancellation ${jobId}`);
      }
      if (fencingToken !== undefined && job.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for worker job ${jobId}`);
      }
      job.status = "cancelled";
      job.updatedAt = new Date().toISOString();
      delete job.leaseOwner;
      delete job.leaseExpiresAt;
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

function linkedAbortController(parent: AbortSignal): {
  controller: AbortController;
  dispose: () => void;
} {
  const controller = new AbortController();
  const abort = () => controller.abort(parent.reason ?? new Error("Worker stopped"));
  if (parent.aborted) abort();
  else parent.addEventListener("abort", abort, { once: true });
  return { controller, dispose: () => parent.removeEventListener("abort", abort) };
}

function ownsLease(job: WorkerJob | undefined, owner: string, fencingToken?: number): boolean {
  return Boolean(
    job &&
    job.status === "leased" &&
    job.leaseOwner === owner &&
    (fencingToken === undefined || job.fencingToken === fencingToken),
  );
}

export class PersistentWorker {
  private stopped = false;
  private readonly active = new Set<AbortController>();

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
    const linked = linkedAbortController(signal);
    this.active.add(linked.controller);
    const heartbeat = setInterval(
      () => {
        if (linked.controller.signal.aborted) return;
        void this.queue
          .heartbeat(job.id, this.id, this.leaseMs, job.fencingToken)
          .catch((error) => linked.controller.abort(error));
      },
      Math.max(500, Math.floor(this.leaseMs / 3)),
    );
    let checkingCancellation = false;
    const cancellationPoll = setInterval(
      () => {
        if (checkingCancellation || linked.controller.signal.aborted) return;
        checkingCancellation = true;
        void this.queue
          .get(job.id)
          .then((current) => {
            if (
              current?.status === "cancellation_requested" &&
              current.leaseOwner === this.id &&
              current.fencingToken === job.fencingToken
            ) {
              linked.controller.abort(new Error(`Worker job ${job.id} cancellation requested`));
            }
          })
          .catch((error) => linked.controller.abort(error))
          .finally(() => {
            checkingCancellation = false;
          });
      },
      Math.max(100, Math.min(1_000, Math.floor(this.leaseMs / 10))),
    );
    const stopLeaseMaintenance = () => {
      clearInterval(heartbeat);
      clearInterval(cancellationPoll);
    };
    linked.controller.signal.addEventListener("abort", stopLeaseMaintenance, { once: true });
    if (linked.controller.signal.aborted) stopLeaseMaintenance();
    try {
      const result = await this.handlers[job.type]!(
        job.payload,
        linked.controller.signal,
        span.context(),
      );
      linked.controller.signal.throwIfAborted();
      await this.queue.finish(job.id, this.id, result, job.fencingToken);
      span.setStatus({ code: "ok" });
    } catch (error) {
      const current = await this.queue.get(job.id).catch(() => undefined);
      if (
        current?.status === "cancellation_requested" &&
        current.leaseOwner === this.id &&
        current.fencingToken === job.fencingToken
      ) {
        await this.queue
          .acknowledgeCancellation(job.id, this.id, job.fencingToken)
          .catch(() => undefined);
      } else if (ownsLease(current, this.id, job.fencingToken)) {
        await this.queue
          .fail(
            job.id,
            this.id,
            error instanceof Error ? error.message : String(error),
            true,
            job.fencingToken,
          )
          .catch(() => undefined);
      }
      span.recordException(error).setStatus({ code: "error" });
    } finally {
      stopLeaseMaintenance();
      linked.controller.signal.removeEventListener("abort", stopLeaseMaintenance);
      linked.dispose();
      this.active.delete(linked.controller);
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
    for (const controller of this.active) controller.abort(new Error("Worker stopped"));
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

  async heartbeat(
    worktree: string,
    owner: string,
    leaseMs = 60_000,
    fencingToken?: number,
  ): Promise<void> {
    const resolved = path.resolve(worktree);
    if (this.store.heartbeatWorktree) {
      await this.store.heartbeatWorktree(resolved, owner, leaseMs, fencingToken);
      return;
    }
    await this.store.transact(async (rows) => {
      const type = `__worktree__:${resolved}`;
      const row = rows.find((job) => job.type === type);
      if (
        !row ||
        row.status !== "leased" ||
        row.leaseOwner !== owner ||
        !row.leaseExpiresAt ||
        Date.parse(row.leaseExpiresAt) <= Date.now()
      ) {
        throw new Error(`Cannot heartbeat unowned worktree: ${worktree}`);
      }
      if (fencingToken !== undefined && row.fencingToken !== fencingToken) {
        throw new Error(`Stale fencing token for worktree: ${worktree}`);
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
