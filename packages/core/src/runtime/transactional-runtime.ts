/**
 * Shell 写入事务边界：可写命令在临时克隆中运行，成功后把文件差异统一提交为 PatchSet。
 * 构建缓存、依赖目录和 VCS/runtime 私有目录不会回写；它们应作为 Artifact 单独交付。
 */

import { createHash } from "node:crypto";
import { constants, promises as fs, realpathSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExecutionRuntime,
  IsolatedRunRequest,
  IsolatedRunResult,
  PreparedIsolatedCommand,
} from "./isolated-runtime.js";
import { PatchSetConflictError, PatchSetService, type PatchSetChangeInput } from "./patchset.js";
import { resolveSandboxPolicy } from "../tools/sandbox.js";

interface SnapshotEntry {
  kind: "file" | "symlink";
  mode: number;
  hash: string;
  size: number;
}

export interface TransactionalExecutionRuntimeOptions {
  ignoredTopLevel?: string[];
  maxFiles?: number;
  maxChangedBytes?: number;
  /** Maximum bytes inspected/copied from a source workspace. */
  maxSourceBytes?: number;
  /** Maximum size of any one source file; prevents whole-file/OOM hazards in later commit paths. */
  maxFileBytes?: number;
}

const DEFAULT_IGNORED = [
  ".anicode",
  ".git",
  "node_modules",
  ".venv",
  "target",
  "dist",
  "build",
  ".next",
  ".cache",
  "coverage",
];

const TRANSACTIONAL_DELEGATES = new WeakMap<TransactionalExecutionRuntime, ExecutionRuntime>();

function canonical(value: string): string {
  try {
    return realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class TransactionalExecutionRuntime implements ExecutionRuntime {
  get toolModuleEnvironment(): "host" | "container" | "unsupported" {
    return this.delegate.toolModuleEnvironment ?? "unsupported";
  }

  get toolModuleNetworkBoundary(): "scoped-proxy" | "unsupported" {
    return this.delegate.toolModuleNetworkBoundary ?? "unsupported";
  }

  get managedProcessBoundary(): "close-confirmed" | "unsupported" {
    return this.delegate.managedProcessBoundary ?? "unsupported";
  }
  private readonly ignored: Set<string>;
  private readonly maxFiles: number;
  private readonly maxChangedBytes: number;
  private readonly maxSourceBytes: number;
  private readonly maxFileBytes: number;

  constructor(
    private readonly delegate: ExecutionRuntime,
    options: TransactionalExecutionRuntimeOptions = {},
  ) {
    TRANSACTIONAL_DELEGATES.set(this, delegate);
    this.ignored = new Set(options.ignoredTopLevel ?? DEFAULT_IGNORED);
    const maxFiles = options.maxFiles ?? 200_000;
    const maxChangedBytes = options.maxChangedBytes ?? 100 * 1024 * 1024;
    const maxSourceBytes = options.maxSourceBytes ?? 5 * 1024 * 1024 * 1024;
    const maxFileBytes = options.maxFileBytes ?? 512 * 1024 * 1024;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
      throw new Error("Transactional shell maxFiles must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxChangedBytes) || maxChangedBytes < 1_024) {
      throw new Error("Transactional shell maxChangedBytes must be a safe integer >= 1024");
    }
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1_024) {
      throw new Error("Transactional shell maxSourceBytes must be a safe integer >= 1024");
    }
    if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1_024) {
      throw new Error("Transactional shell maxFileBytes must be a safe integer >= 1024");
    }
    this.maxFiles = maxFiles;
    this.maxChangedBytes = maxChangedBytes;
    this.maxSourceBytes = maxSourceBytes;
    this.maxFileBytes = maxFileBytes;
  }

  prepare(request: IsolatedRunRequest): PreparedIsolatedCommand {
    const policy = resolveSandboxPolicy(request.policy);
    if (policy === "workspace-write") {
      throw new Error(
        "Background workspace-write shell is disabled because its writes cannot be committed atomically",
      );
    }
    if (!this.delegate.prepare)
      throw new Error("Execution runtime does not support background shell");
    return this.delegate.prepare({ ...request, policy });
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown?.() ?? Promise.resolve();
  }

  /**
   * Verification boundary: clone exactly once, expose only the clone to evidence commands, and
   * unconditionally delete it. The transactional delegate is deliberately bypassed so a
   * successful check cannot prepare/apply a PatchSet to the caller's workspace.
   */
  async withDiscardedWorkspace<T>(
    cwd: string,
    signal: AbortSignal | undefined,
    callback: (runtime: ExecutionRuntime, stagedCwd: string) => Promise<T>,
  ): Promise<T> {
    return withClonedWorkspace(
      cwd,
      this.maxFiles,
      this.maxSourceBytes,
      this.maxFileBytes,
      signal,
      (stagedCwd) => callback(this.delegate, stagedCwd),
    );
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    const policy = resolveSandboxPolicy(request.policy);
    if (policy !== "workspace-write") return this.delegate.run({ ...request, policy });
    const root = canonical(request.cwd);
    const patchsets = new PatchSetService(root, { directCommit: "trusted-local" });
    await patchsets.recoverIncomplete();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-shell-transaction-"));
    const staged = path.join(temporary, "workspace");
    try {
      await cloneTree(
        root,
        staged,
        this.maxFiles,
        this.maxSourceBytes,
        this.maxFileBytes,
        request.signal,
      );
      const [baseline, sourceBefore] = await Promise.all([
        snapshotTree(
          staged,
          this.ignored,
          this.maxFiles,
          this.maxSourceBytes,
          this.maxFileBytes,
          request.signal,
        ),
        snapshotTree(
          root,
          this.ignored,
          this.maxFiles,
          this.maxSourceBytes,
          this.maxFileBytes,
          request.signal,
        ),
      ]);
      const stagingConflicts = snapshotConflicts(baseline, sourceBefore);
      if (stagingConflicts.length) {
        throw new PatchSetConflictError(stagingConflicts);
      }
      const result = await this.delegate.run({ ...request, cwd: staged, policy });
      request.signal?.throwIfAborted();
      if (result.exitCode !== 0 || result.timedOut) return result;

      const after = await snapshotTree(
        staged,
        this.ignored,
        this.maxFiles,
        this.maxSourceBytes,
        this.maxFileBytes,
        request.signal,
      );
      const changedPaths = snapshotConflicts(baseline, after);
      if (changedPaths.length === 0) return result;
      request.signal?.throwIfAborted();
      const sourceNow = await snapshotTree(
        root,
        this.ignored,
        this.maxFiles,
        this.maxSourceBytes,
        this.maxFileBytes,
        request.signal,
      );
      const concurrent = changedPaths.filter(
        (relative) => !snapshotEntryEqual(baseline.get(relative), sourceNow.get(relative)),
      );
      if (concurrent.length) throw new PatchSetConflictError(concurrent);

      const changes: PatchSetChangeInput[] = [];
      let changedBytes = 0;
      for (const relative of changedPaths) {
        if (protectedMetadataPath(relative)) {
          throw new Error(`Transactional shell cannot commit protected metadata: ${relative}`);
        }
        const entry = after.get(relative);
        if (!entry) {
          changes.push({ path: relative, content: null });
          continue;
        }
        if (entry.kind !== "file") {
          throw new Error(`Transactional shell cannot commit symbolic-link change: ${relative}`);
        }
        changedBytes += entry.size;
        if (changedBytes > this.maxChangedBytes) {
          throw new Error(
            `Transactional shell changed more than ${this.maxChangedBytes} bytes; publish large outputs as Artifacts`,
          );
        }
        changes.push({
          path: relative,
          content: await fs.readFile(path.join(staged, relative)),
          mode: entry.mode,
        });
      }
      request.signal?.throwIfAborted();
      const patchset = await patchsets.prepare(changes);
      request.signal?.throwIfAborted();
      await patchsets.apply(patchset, request.signal ? { signal: request.signal } : {});
      if (request.includeTransactionSummary === false) return result;
      const suffix = `\n[PatchSet ${patchset.id} committed]\n${patchsets.preview(patchset)}`;
      return { ...result, output: `${result.output}${suffix}` };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

/**
 * Production attestation seam. A structural capability string is forgeable; this only unwraps a
 * genuine core TransactionalExecutionRuntime instance registered by its constructor.
 */
export function transactionalExecutionDelegate(
  runtime: ExecutionRuntime,
): ExecutionRuntime | undefined {
  return runtime instanceof TransactionalExecutionRuntime
    ? TRANSACTIONAL_DELEGATES.get(runtime)
    : undefined;
}

/**
 * Fallback for controlled runtimes that do not already provide a transactional clone. One clone
 * is shared by every check in the verification run; all writes disappear when the callback ends.
 */
export async function withDiscardedWorkspace<T>(
  runtime: ExecutionRuntime,
  cwd: string,
  signal: AbortSignal | undefined,
  callback: (runtime: ExecutionRuntime, stagedCwd: string) => Promise<T>,
  maxFiles = 200_000,
  maxSourceBytes = 5 * 1024 * 1024 * 1024,
  maxFileBytes = 512 * 1024 * 1024,
): Promise<T> {
  if (runtime.withDiscardedWorkspace) {
    return runtime.withDiscardedWorkspace(cwd, signal, callback);
  }
  return withClonedWorkspace(cwd, maxFiles, maxSourceBytes, maxFileBytes, signal, (stagedCwd) =>
    callback(runtime, stagedCwd),
  );
}

async function withClonedWorkspace<T>(
  cwd: string,
  maxFiles: number,
  maxSourceBytes: number,
  maxFileBytes: number,
  signal: AbortSignal | undefined,
  callback: (stagedCwd: string) => Promise<T>,
): Promise<T> {
  const root = canonical(cwd);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-evidence-"));
  const staged = path.join(temporary, "workspace");
  try {
    await cloneTree(root, staged, maxFiles, maxSourceBytes, maxFileBytes, signal);
    signal?.throwIfAborted();
    return await callback(staged);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function cloneTree(
  source: string,
  target: string,
  maxFiles: number,
  maxSourceBytes: number,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  let files = 0;
  let sourceBytes = 0;
  const copy = async (from: string, to: string, relative: string): Promise<void> => {
    signal?.throwIfAborted();
    if (relative === ".anicode" || relative.startsWith(`.anicode${path.sep}`)) return;
    const stat = await fs.lstat(from);
    if (stat.isDirectory()) {
      await fs.mkdir(to, { recursive: true, mode: stat.mode & 0o777 });
      for (const name of await fs.readdir(from)) {
        await copy(path.join(from, name), path.join(to, name), path.join(relative, name));
      }
      return;
    }
    files++;
    if (files > maxFiles)
      throw new Error(`Transactional shell workspace exceeds ${maxFiles} files`);
    const entryBytes = stat.isSymbolicLink() ? stat.size : stat.isFile() ? stat.size : 0;
    if (entryBytes > maxFileBytes) {
      throw new Error(`Transactional shell file exceeds ${maxFileBytes} bytes: ${relative}`);
    }
    sourceBytes += entryBytes;
    if (!Number.isSafeInteger(sourceBytes) || sourceBytes > maxSourceBytes) {
      throw new Error(`Transactional shell workspace exceeds ${maxSourceBytes} source bytes`);
    }
    await fs.mkdir(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) {
      await fs.symlink(await fs.readlink(from), to);
      return;
    }
    if (!stat.isFile()) return;
    await fs.copyFile(from, to, constants.COPYFILE_FICLONE);
    await fs.chmod(to, stat.mode & 0o777);
    await fs.utimes(to, stat.atime, stat.mtime);
  };
  await copy(source, target, "");
}

async function snapshotTree(
  root: string,
  ignored: Set<string>,
  maxFiles: number,
  maxSourceBytes: number,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<Map<string, SnapshotEntry>> {
  const snapshot = new Map<string, SnapshotEntry>();
  let sourceBytes = 0;
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const name of await fs.readdir(directory)) {
      signal?.throwIfAborted();
      const relative = path.join(relativeDirectory, name);
      if ((!relativeDirectory && ignored.has(name)) || protectedMetadataPath(relative)) continue;
      const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (snapshot.size >= maxFiles) {
        throw new Error(`Transactional shell workspace exceeds ${maxFiles} files`);
      }
      if (stat.size > maxFileBytes) {
        throw new Error(`Transactional shell file exceeds ${maxFileBytes} bytes: ${relative}`);
      }
      sourceBytes += stat.size;
      if (!Number.isSafeInteger(sourceBytes) || sourceBytes > maxSourceBytes) {
        throw new Error(`Transactional shell workspace exceeds ${maxSourceBytes} source bytes`);
      }
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(absolute);
        snapshot.set(relative, {
          kind: "symlink",
          mode: stat.mode & 0o777,
          hash: hash(target),
          size: Buffer.byteLength(target),
        });
      } else if (stat.isFile()) {
        snapshot.set(relative, {
          kind: "file",
          mode: stat.mode & 0o777,
          hash: await hashFile(absolute, signal),
          size: stat.size,
        });
      }
    }
  };
  await walk(root, "");
  return snapshot;
}

function protectedMetadataPath(relative: string): boolean {
  return relative
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((segment) => {
      const normalized = segment.toLowerCase();
      return normalized === ".git" || normalized === ".anicode";
    });
}

/** Stream hashes in bounded chunks; never materialize an arbitrary workspace file in memory. */
async function hashFile(file: string, signal?: AbortSignal): Promise<string> {
  const digest = createHash("sha256");
  const handle = await fs.open(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

function snapshotEntryEqual(
  left: SnapshotEntry | undefined,
  right: SnapshotEntry | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.kind === right.kind &&
      left.mode === right.mode &&
      left.hash === right.hash)
  );
}

function snapshotConflicts(
  before: Map<string, SnapshotEntry>,
  after: Map<string, SnapshotEntry>,
): string[] {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((relative) => !snapshotEntryEqual(before.get(relative), after.get(relative)))
    .sort();
}
