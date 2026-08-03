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
  private readonly ignored: Set<string>;
  private readonly maxFiles: number;
  private readonly maxChangedBytes: number;

  constructor(
    private readonly delegate: ExecutionRuntime,
    options: TransactionalExecutionRuntimeOptions = {},
  ) {
    this.ignored = new Set(options.ignoredTopLevel ?? DEFAULT_IGNORED);
    const maxFiles = options.maxFiles ?? 200_000;
    const maxChangedBytes = options.maxChangedBytes ?? 100 * 1024 * 1024;
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
      throw new Error("Transactional shell maxFiles must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxChangedBytes) || maxChangedBytes < 1_024) {
      throw new Error("Transactional shell maxChangedBytes must be a safe integer >= 1024");
    }
    this.maxFiles = maxFiles;
    this.maxChangedBytes = maxChangedBytes;
  }

  prepare(request: IsolatedRunRequest): PreparedIsolatedCommand {
    if (request.policy === "workspace-write") {
      throw new Error(
        "Background workspace-write shell is disabled because its writes cannot be committed atomically",
      );
    }
    if (!this.delegate.prepare)
      throw new Error("Execution runtime does not support background shell");
    return this.delegate.prepare(request);
  }

  async run(request: IsolatedRunRequest): Promise<IsolatedRunResult> {
    if (request.policy !== "workspace-write") return this.delegate.run(request);
    const root = canonical(request.cwd);
    const patchsets = new PatchSetService(root, { directCommit: "trusted-local" });
    await patchsets.recoverIncomplete();
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-shell-transaction-"));
    const staged = path.join(temporary, "workspace");
    try {
      await cloneTree(root, staged, this.maxFiles);
      const [baseline, sourceBefore] = await Promise.all([
        snapshotTree(staged, this.ignored, this.maxFiles),
        snapshotTree(root, this.ignored, this.maxFiles),
      ]);
      const stagingConflicts = snapshotConflicts(baseline, sourceBefore);
      if (stagingConflicts.length) {
        throw new PatchSetConflictError(stagingConflicts);
      }
      const result = await this.delegate.run({ ...request, cwd: staged });
      request.signal?.throwIfAborted();
      if (result.exitCode !== 0 || result.timedOut) return result;

      const after = await snapshotTree(staged, this.ignored, this.maxFiles);
      const changedPaths = snapshotConflicts(baseline, after);
      if (changedPaths.length === 0) return result;
      request.signal?.throwIfAborted();
      const sourceNow = await snapshotTree(root, this.ignored, this.maxFiles);
      const concurrent = changedPaths.filter(
        (relative) => !snapshotEntryEqual(baseline.get(relative), sourceNow.get(relative)),
      );
      if (concurrent.length) throw new PatchSetConflictError(concurrent);

      const changes: PatchSetChangeInput[] = [];
      let changedBytes = 0;
      for (const relative of changedPaths) {
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
      const suffix = `\n[PatchSet ${patchset.id} committed]\n${patchsets.preview(patchset)}`;
      return { ...result, output: `${result.output}${suffix}` };
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
}

async function cloneTree(source: string, target: string, maxFiles: number): Promise<void> {
  let files = 0;
  const copy = async (from: string, to: string, relative: string): Promise<void> => {
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
): Promise<Map<string, SnapshotEntry>> {
  const snapshot = new Map<string, SnapshotEntry>();
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const name of await fs.readdir(directory)) {
      if (!relativeDirectory && ignored.has(name)) continue;
      const relative = path.join(relativeDirectory, name);
      const absolute = path.join(directory, name);
      const stat = await fs.lstat(absolute);
      if (stat.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (snapshot.size >= maxFiles) {
        throw new Error(`Transactional shell workspace exceeds ${maxFiles} files`);
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
        const content = await fs.readFile(absolute);
        snapshot.set(relative, {
          kind: "file",
          mode: stat.mode & 0o777,
          hash: hash(content),
          size: content.byteLength,
        });
      }
    }
  };
  await walk(root, "");
  return snapshot;
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
