import { createHash } from "node:crypto";
import { chmodSync, lstatSync, promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_LOCK_TIMEOUT_MS = 40_000;
const LOCK_RETRY_MS = 15;

export interface CloudAuthLockOptions {
  signal?: AbortSignal;
}

/** A secret-free coordination primitive shared by every process using one Cloud auth backend. */
export interface CloudAuthExclusiveLock {
  runExclusive<T>(operation: () => Promise<T>, options?: CloudAuthLockOptions): Promise<T>;
}

export class CloudAuthLockError extends Error {
  constructor(
    readonly reason: "cancelled" | "invalid-lock" | "permission-denied" | "timed-out",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CloudAuthLockError";
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CloudAuthLockError("cancelled", "AniCode Cloud coordination was cancelled");
  }
}

function wait(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new CloudAuthLockError("cancelled", "AniCode Cloud coordination was cancelled"));
    };
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function settleOnAbort<T>(
  task: Promise<T>,
  signal: AbortSignal | undefined,
  operationStarted: () => boolean,
): Promise<T> {
  if (!signal) return task;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      if (operationStarted()) return;
      finish(() =>
        reject(new CloudAuthLockError("cancelled", "AniCode Cloud coordination was cancelled")),
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void task.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function assertOwnedByCurrentUser(stat: Awaited<ReturnType<typeof fs.lstat>>, label: string): void {
  const expectedUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const actualUid = stat.uid;
  if (
    expectedUid !== undefined &&
    actualUid !== (typeof actualUid === "bigint" ? BigInt(expectedUid) : expectedUid)
  ) {
    throw new CloudAuthLockError(
      "permission-denied",
      `${label} is owned by another operating-system user`,
    );
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new CloudAuthLockError(
      "invalid-lock",
      "AniCode Cloud coordination directory must be a real directory",
    );
  }
  assertOwnedByCurrentUser(stat, "AniCode Cloud coordination directory");
  if (process.platform !== "win32") {
    await fs.chmod(directory, 0o700);
    const secured = await fs.lstat(directory);
    if ((secured.mode & 0o077) !== 0) {
      throw new CloudAuthLockError(
        "permission-denied",
        "AniCode Cloud coordination directory permissions are not private",
      );
    }
  }
}

function inspectAndSecureCoordinationFile(file: string): void {
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CloudAuthLockError(
      "invalid-lock",
      "AniCode Cloud coordination database must be a regular file",
    );
  }
  assertOwnedByCurrentUser(stat, "AniCode Cloud coordination database");
  if (process.platform === "win32") return;

  // The containing directory is already 0700. Tightening an owned regular file also recovers a
  // creator that died after SQLite created the empty database but before chmod completed.
  chmodSync(file, 0o600);
  const secured = lstatSync(file, { bigint: true });
  if (
    !secured.isFile() ||
    secured.isSymbolicLink() ||
    secured.dev !== stat.dev ||
    secured.ino !== stat.ino
  ) {
    throw new CloudAuthLockError(
      "invalid-lock",
      "AniCode Cloud coordination database changed during validation",
    );
  }
  assertOwnedByCurrentUser(secured, "AniCode Cloud coordination database");
  if ((secured.mode & 0o077n) !== 0n) {
    throw new CloudAuthLockError(
      "permission-denied",
      "AniCode Cloud coordination database permissions are not private",
    );
  }
}

function initializePrivateCoordinationFile(file: string): void {
  let database: DatabaseSync | undefined;
  let failed = false;
  let failure: unknown;
  try {
    try {
      inspectAndSecureCoordinationFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // DatabaseSync creates an absent database synchronously. Its own VFS manages same-process
    // descriptor lifetimes; unlike a raw fs.open/fs.readFile close, this cannot tear down another
    // SQLite connection's POSIX advisory lock.
    database = new DatabaseSync(file);
    database.prepare("PRAGMA schema_version").get();
  } catch (error) {
    failed = true;
    failure = error instanceof CloudAuthLockError ? error : coordinationDatabaseError(error);
  } finally {
    try {
      database?.close();
    } catch (error) {
      // Preserve a validation failure over its secondary close failure.
      if (!failed) {
        failed = true;
        failure = coordinationDatabaseError(error);
      }
    }
  }
  if (failed) throw failure;
  inspectAndSecureCoordinationFile(file);
}

const INITIALIZATION_REGISTRY = Symbol.for("dev.anicode.cloud-auth-lock.initializations");
const processGlobal = globalThis as typeof globalThis & {
  [INITIALIZATION_REGISTRY]?: Map<string, Promise<void>>;
};
const fileInitializations = (processGlobal[INITIALIZATION_REGISTRY] ??= new Map());

async function ensurePrivateCoordinationFile(file: string): Promise<void> {
  const existing = fileInitializations.get(file);
  if (existing) return existing;
  const initialization = Promise.resolve()
    .then(() => initializePrivateCoordinationFile(file))
    .catch((error: unknown) => {
      if (fileInitializations.get(file) === initialization) fileInitializations.delete(file);
      throw error;
    });
  fileInitializations.set(file, initialization);
  return initialization;
}

function isSqliteContention(error: unknown): boolean {
  const errcode = (error as { errcode?: unknown }).errcode;
  if (typeof errcode !== "number") return false;
  const primaryCode = errcode & 0xff;
  return primaryCode === 5 || primaryCode === 6; // SQLITE_BUSY / SQLITE_LOCKED
}

function coordinationDatabaseError(error: unknown): CloudAuthLockError {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    return new CloudAuthLockError(
      "permission-denied",
      "AniCode Cloud coordination database could not be opened securely",
      { cause: error },
    );
  }

  return new CloudAuthLockError("invalid-lock", "AniCode Cloud coordination database is invalid", {
    cause: error,
  });
}

function openCoordinationDatabase(file: string): DatabaseSync {
  const database = new DatabaseSync(file);
  try {
    database.exec("PRAGMA busy_timeout = 0");
    return database;
  } catch (error) {
    try {
      database.close();
    } catch {
      // Preserve the opening error; close is only a best-effort cleanup before ownership exists.
    }
    throw error;
  }
}

export class FileCloudAuthExclusiveLock implements CloudAuthExclusiveLock {
  readonly file: string;
  private readonly timeoutMs: number;

  constructor(
    file: string,
    options: {
      timeoutMs?: number;
    } = {},
  ) {
    if (!path.isAbsolute(file) || Buffer.byteLength(file, "utf8") > 4_096 || file.includes("\0")) {
      throw new TypeError("AniCode Cloud coordination lock path must be an absolute safe path");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
      throw new TypeError("AniCode Cloud coordination lock timeout is invalid");
    }
    this.file = path.normalize(file);
    this.timeoutMs = timeoutMs;
  }

  async runExclusive<T>(
    operation: () => Promise<T>,
    options: CloudAuthLockOptions = {},
  ): Promise<T> {
    throwIfAborted(options.signal);
    await ensurePrivateDirectory(path.dirname(this.file));
    await ensurePrivateCoordinationFile(this.file);
    const deadline = Date.now() + this.timeoutMs;
    let database: DatabaseSync;
    try {
      database = openCoordinationDatabase(this.file);
    } catch (error) {
      throw coordinationDatabaseError(error);
    }
    let transactionStarted = false;
    let completed = false;
    let result: T | undefined;
    let failure: unknown;

    try {
      for (;;) {
        throwIfAborted(options.signal);
        try {
          // A write transaction is an OS-backed, process-scoped exclusive lease. SQLite releases
          // it when the connection closes or the process dies, so acquisition has no stale-owner
          // reclaimer and no observe-then-unlink race with a successor.
          database.exec("BEGIN IMMEDIATE");
          transactionStarted = true;
          break;
        } catch (error) {
          if (!isSqliteContention(error)) throw coordinationDatabaseError(error);
          if (Date.now() >= deadline) {
            throw new CloudAuthLockError(
              "timed-out",
              "Timed out acquiring AniCode Cloud coordination lock",
              { cause: error },
            );
          }
          await wait(Math.min(LOCK_RETRY_MS, Math.max(1, deadline - Date.now())), options.signal);
        }
      }

      throwIfAborted(options.signal);
      result = await operation();
      completed = true;
    } catch (error) {
      failure = error;
    } finally {
      let cleanupError: unknown;
      if (transactionStarted) {
        try {
          database.exec("ROLLBACK");
          transactionStarted = false;
        } catch (error) {
          cleanupError = error;
        }
      }
      try {
        // close() also rolls back an active transaction if ROLLBACK itself failed.
        database.close();
      } catch (error) {
        cleanupError ??= error;
      }
      // Do not mask an operation failure with a secondary cleanup failure. A successful operation
      // must still report failure if releasing its cross-process lease could not be confirmed.
      if (completed && cleanupError) {
        completed = false;
        failure = coordinationDatabaseError(cleanupError);
      }
    }

    if (!completed) throw failure;
    return result as T;
  }
}

export function cloudAuthLockFileForNamespace(
  namespace: string,
  homeDirectory = os.homedir(),
): string {
  if (!namespace || Buffer.byteLength(namespace, "utf8") > 8_192) {
    throw new TypeError("AniCode Cloud credential namespace is invalid");
  }
  const digest = createHash("sha256")
    .update("anicode-cloud-refresh-lock\0", "utf8")
    .update(namespace, "utf8")
    .digest("hex");
  return path.join(path.resolve(homeDirectory), ".anicode", "cloud-auth-locks", `${digest}.lock`);
}

export function createCloudAuthExclusiveLock(namespace: string): CloudAuthExclusiveLock {
  return new FileCloudAuthExclusiveLock(cloudAuthLockFileForNamespace(namespace));
}

class LocalCloudAuthExclusiveLock implements CloudAuthExclusiveLock {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(operation: () => Promise<T>, options: CloudAuthLockOptions = {}): Promise<T> {
    let started = false;
    const task = this.tail.then(async () => {
      started = true;
      throwIfAborted(options.signal);
      return operation();
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    // Cancellation may skip queued work immediately. Once work starts, its caller must finish or
    // cooperatively abort before the mutex advances; releasing around a late mutation is unsafe.
    return settleOnAbort(task, options.signal, () => started);
  }
}

const localLocks = new WeakMap<object, CloudAuthExclusiveLock>();

/** @internal Backends without a durable namespace coordinate only among wrappers in this process. */
export function cloudAuthExclusiveLockForBackend(backend: {
  credentialNamespace?: string;
}): CloudAuthExclusiveLock {
  if (backend.credentialNamespace) return createCloudAuthExclusiveLock(backend.credentialNamespace);
  const existing = localLocks.get(backend);
  if (existing) return existing;
  const created = new LocalCloudAuthExclusiveLock();
  localLocks.set(backend, created);
  return created;
}
