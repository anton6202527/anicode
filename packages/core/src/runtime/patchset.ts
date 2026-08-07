/** 事务 PatchSet v2：文本/二进制、rename、三方合并、审批链、冲突与崩溃回滚。 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs, realpathSync, type BigIntStats } from "node:fs";
import { hostname } from "node:os";
import * as path from "node:path";

export interface PatchSetChangeInput {
  path: string;
  /** null 删除；Uint8Array 作为二进制；省略时仅可用于 rename。 */
  content?: string | Uint8Array | null;
  /** 将该路径移动到 path；内容默认沿用源文件，可同时覆盖 content。 */
  renameFrom?: string;
  /** POSIX permission bits；省略时保留原文件 mode，新文件默认 0644。 */
  mode?: number;
}

export interface PatchSetChange {
  path: string;
  before: string | null;
  after: string | null;
  encoding: "utf8" | "base64";
  beforeHash: string;
  afterHash: string;
  addedLines: number;
  deletedLines: number;
  operation?: "write" | "update" | "delete" | "rename-source" | "rename-target";
  renameGroup?: string;
  beforeMode?: number;
  afterMode?: number;
}

export type PatchSetStatus =
  | "planned"
  | "pending_approval"
  | "approved"
  | "applying"
  | "applied"
  | "conflict"
  | "rolled_back"
  | "failed";

export interface PatchSetApproval {
  actor: string;
  role: string;
  decision: "approve" | "reject";
  timestamp: string;
  comment?: string;
}

export interface PatchSet {
  version: 2;
  id: string;
  root: string;
  /** Owning conversation. Absent only on legacy/standalone transactional journals. */
  sessionId?: string;
  status: PatchSetStatus;
  createdAt: string;
  updatedAt: string;
  changes: PatchSetChange[];
  requiredApprovals: number;
  requiredRoles: string[];
  approvals: PatchSetApproval[];
  appliedCount: number;
  fencingToken?: number;
  error?: string;
}

export interface ThreeWayMergeResult {
  content: string;
  conflicted: boolean;
  conflicts: number;
}

export interface PatchSetRebaseResult {
  patchset: PatchSet;
  /** 含冲突标记、必须经人工/Verifier 处理的文本文件。 */
  conflictedPaths: string[];
}

export class PatchSetConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`PatchSet conflict: files changed since preview: ${paths.join(", ")}`);
    this.name = "PatchSetConflictError";
  }
}

export class PatchSetSessionOwnershipError extends Error {
  constructor(
    readonly patchsetId: string,
    readonly expectedSessionId: string | undefined,
    readonly actualSessionId: string | undefined,
  ) {
    super(
      expectedSessionId === undefined
        ? `PatchSet ${patchsetId} belongs to session ${actualSessionId ?? "<legacy-unowned>"}`
        : actualSessionId === undefined
          ? `Legacy PatchSet ${patchsetId} has no session owner and cannot be claimed by ${expectedSessionId}`
          : `PatchSet ${patchsetId} belongs to another session`,
    );
    this.name = "PatchSetSessionOwnershipError";
  }
}

function digest(value: Uint8Array | null): string {
  return createHash("sha256")
    .update(
      value === null ? Buffer.from("\0absent") : Buffer.concat([Buffer.from("\0file"), value]),
    )
    .digest("hex");
}

function encode(value: Uint8Array | null, encoding: "utf8" | "base64"): string | null {
  if (value === null) return null;
  return Buffer.from(value).toString(encoding);
}

function decode(value: string | null, encoding: "utf8" | "base64"): Uint8Array | null {
  return value === null ? null : Buffer.from(value, encoding);
}

function inputBytes(value: string | Uint8Array | null): {
  bytes: Uint8Array | null;
  encoding: "utf8" | "base64";
} {
  if (value === null) return { bytes: null, encoding: "utf8" };
  return typeof value === "string"
    ? { bytes: Buffer.from(value, "utf8"), encoding: "utf8" }
    : { bytes: new Uint8Array(value), encoding: "base64" };
}

function isBinary(value: Uint8Array | null): boolean {
  if (!value) return false;
  for (let index = 0; index < Math.min(value.byteLength, 8_192); index++) {
    if (value[index] === 0) return true;
  }
  return false;
}

function lineDelta(
  before: Uint8Array | null,
  after: Uint8Array | null,
  binary: boolean,
): { added: number; deleted: number } {
  if (binary) return { added: 0, deleted: 0 };
  const oldLines =
    before === null || before.byteLength === 0
      ? []
      : Buffer.from(before).toString("utf8").split("\n");
  const newLines =
    after === null || after.byteLength === 0 ? [] : Buffer.from(after).toString("utf8").split("\n");
  let prefix = 0;
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  )
    suffix++;
  return {
    added: Math.max(0, newLines.length - prefix - suffix),
    deleted: Math.max(0, oldLines.length - prefix - suffix),
  };
}

async function readMaybe(file: string): Promise<Uint8Array | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not allow opening directories through this API. The rename itself still has the
  // platform's normal durability semantics there; POSIX hosts explicitly persist directory-entry
  // changes so a reported journal/install/delete cannot disappear after a power loss.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicWrite(
  file: string,
  content: Uint8Array,
  mode = 0o644,
  guard?: (phase: "before-rename" | "after-rename") => Promise<void>,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.anicode-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { flag: "wx", mode });
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(temporary, mode);
    await guard?.("before-rename");
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
    await guard?.("after-rename");
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

function safeRelative(root: string, candidate: string): string {
  const relative = path.normalize(candidate).replace(/^\.([/\\])/, "");
  const absolute = path.isAbsolute(relative)
    ? path.resolve(relative)
    : path.resolve(root, relative);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (absolute !== root && !absolute.startsWith(prefix)) {
    throw new Error(`PatchSet path escapes workspace: ${candidate}`);
  }
  if (!relative || relative === ".") throw new Error("PatchSet path must identify a file");
  return path.relative(root, absolute);
}

function normalizeMode(mode: number): number {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error(`Invalid PatchSet file mode: ${mode}`);
  }
  return mode & 0o777;
}

function protectedWorkspacePath(relative: string): boolean {
  return relative.split(/[\\/]+/).some((segment) => {
    const normalized = segment.toLowerCase();
    return normalized === ".git" || normalized === ".anicode";
  });
}

export interface PatchSetServiceOptions {
  journalDir?: string;
  /** Bind all new journals and every mutating/read operation to one conversation. */
  sessionId?: string;
  writeFile?: (file: string, content: Uint8Array, mode?: number) => Promise<void>;
  /**
   * Direct filesystem commits cannot provide openat-style pathname confinement in Node alone.
   * They are therefore disabled unless the caller explicitly attests that the workspace and all
   * local processes which may rename its directories are trusted. Production control planes must
   * omit this capability and commit through an isolated, privileged committer instead.
   */
  directCommit?: "trusted-local";
  requiredApprovals?: number;
  requiredRoles?: string[];
  onApproval?: (patchset: PatchSet, approval: PatchSetApproval) => void | Promise<void>;
  /** Lock tuning for tests/embedded stores. Production should use the defaults. */
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  lockHeartbeatMs?: number;
  /** @internal fault-injection hook. */
  touchWorkspaceLock?: (lockFile: string) => Promise<void>;
  /** @internal deterministic race-injection hook. */
  beforeWorkspaceInstall?: (file: string) => void | Promise<void>;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface DirectoryIdentity extends FileIdentity {
  path: string;
}

interface WorkspacePathProof {
  file: string;
  parents: DirectoryIdentity[];
  targetExists: boolean;
  target?: FileIdentity;
  missingParent?: boolean;
}

export interface PatchSetWorkspaceLockInfo {
  version: 1;
  ownerToken: string;
  fencingToken: number;
  pid: number;
  host: string;
  acquiredAt: string;
}

interface WorkspaceLease {
  owner: PatchSetWorkspaceLockInfo;
  identity: FileIdentity;
  signal: AbortSignal;
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("PatchSet workspace lease aborted");
}

function combineAbortSignals(signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0)
    return { signal: new AbortController().signal, dispose: () => undefined };
  if (active.length === 1) return { signal: active[0]!, dispose: () => undefined };
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const signal of active) {
    const abort = () => controller.abort(abortError(signal));
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    listeners.set(signal, abort);
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
    },
  };
}

export class PatchSetService {
  readonly root: string;
  private readonly journalDir: string;
  private readonly writeFile: (file: string, content: Uint8Array, mode?: number) => Promise<void>;
  private readonly lockFile: string;
  private readonly fenceFile: string;

  constructor(
    root: string,
    private readonly options: PatchSetServiceOptions = {},
  ) {
    // macOS 上 /var 通常是指向 /private/var 的符号链接。文件工具会返回校验后的
    // canonical path，因此 PatchSet 也必须使用相同根，否则合法目标会被误判为越界。
    const requestedRoot = path.resolve(root);
    this.root = realpathSync.native(requestedRoot);
    if (
      options.sessionId !== undefined &&
      (options.sessionId.trim().length === 0 || options.sessionId.length > 512)
    ) {
      throw new Error("PatchSet sessionId must be a non-empty string of at most 512 characters");
    }
    const requestedJournal = path.resolve(
      options.journalDir ?? path.join(requestedRoot, ".anicode", "patchsets"),
    );
    this.journalDir = path.join(this.root, safeRelative(requestedRoot, requestedJournal));
    this.writeFile = options.writeFile ?? atomicWrite;
    this.lockFile = path.join(this.journalDir, "workspace.lock");
    this.fenceFile = path.join(this.journalDir, "workspace.fence");
  }

  async prepare(inputs: PatchSetChangeInput[]): Promise<PatchSet> {
    if (this.options.sessionId === undefined) return this.prepareUnlocked(inputs);
    return this.withWorkspaceLock(async (lease) => {
      await this.assertSessionJournalActive();
      const patchset = await this.prepareUnlocked(inputs);
      await this.assertLock(lease);
      return patchset;
    });
  }

  private async prepareUnlocked(inputs: PatchSetChangeInput[]): Promise<PatchSet> {
    const expanded: Array<{
      path: string;
      content: string | Uint8Array | null;
      mode?: number;
      operation?: PatchSetChange["operation"];
      renameGroup?: string;
    }> = [];
    for (const input of inputs) {
      if (!input.renameFrom) {
        if (input.content === undefined) throw new Error(`PatchSet content missing: ${input.path}`);
        expanded.push({
          path: input.path,
          content: input.content,
          ...(input.mode !== undefined ? { mode: input.mode } : {}),
        });
        continue;
      }
      const source = safeRelative(this.root, input.renameFrom);
      const sourceFile = await this.workspaceFile(source);
      const sourceBytes = await readMaybe(sourceFile);
      if (sourceBytes === null) throw new Error(`PatchSet rename source does not exist: ${source}`);
      const sourceMode = (await fs.stat(sourceFile)).mode & 0o777;
      const group = `rename_${randomUUID()}`;
      expanded.push({
        path: source,
        content: null,
        operation: "rename-source",
        renameGroup: group,
        mode: sourceMode,
      });
      expanded.push({
        path: input.path,
        content: input.content === undefined ? sourceBytes : input.content,
        mode: input.mode ?? sourceMode,
        operation: "rename-target",
        renameGroup: group,
      });
    }

    const seen = new Set<string>();
    const changes: PatchSetChange[] = [];
    for (const input of expanded) {
      const relative = safeRelative(this.root, input.path);
      if (seen.has(relative)) throw new Error(`Duplicate PatchSet path: ${relative}`);
      seen.add(relative);
      const target = await this.workspaceFile(relative);
      const beforeBytes = await readMaybe(target);
      const beforeMode = beforeBytes === null ? undefined : (await fs.stat(target)).mode & 0o777;
      const requested = inputBytes(input.content);
      const binary =
        requested.encoding === "base64" || isBinary(beforeBytes) || isBinary(requested.bytes);
      const encoding = binary ? "base64" : "utf8";
      const delta = lineDelta(beforeBytes, requested.bytes, binary);
      changes.push({
        path: relative,
        before: encode(beforeBytes, encoding),
        after: encode(requested.bytes, encoding),
        encoding,
        beforeHash: digest(beforeBytes),
        afterHash: digest(requested.bytes),
        addedLines: delta.added,
        deletedLines: delta.deleted,
        operation:
          input.operation ??
          (requested.bytes === null ? "delete" : beforeBytes === null ? "write" : "update"),
        ...(input.renameGroup ? { renameGroup: input.renameGroup } : {}),
        ...(beforeMode !== undefined ? { beforeMode } : {}),
        ...(requested.bytes !== null
          ? { afterMode: normalizeMode(input.mode ?? beforeMode ?? 0o644) }
          : {}),
      });
    }
    const requiredApprovals = Math.max(0, this.options.requiredApprovals ?? 0);
    const now = new Date().toISOString();
    const patchset: PatchSet = {
      version: 2,
      id: `ps_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      root: this.root,
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      status: requiredApprovals > 0 ? "pending_approval" : "planned",
      createdAt: now,
      updatedAt: now,
      changes,
      requiredApprovals,
      requiredRoles: [...(this.options.requiredRoles ?? [])],
      approvals: [],
      appliedCount: 0,
    };
    await this.persist(patchset);
    return patchset;
  }

  preview(patchset: PatchSet): string {
    return patchset.changes
      .map((change) => {
        const op =
          change.operation ??
          (change.before === null ? "write" : change.after === null ? "delete" : "write");
        const size =
          change.encoding === "base64"
            ? ` binary=${decode(change.after, change.encoding)?.byteLength ?? 0}B`
            : ` +${change.addedLines}/-${change.deletedLines}`;
        return `${op} ${change.path} (${size.trim()})`;
      })
      .join("\n");
  }

  async approve(
    idOrPatchSet: string | PatchSet,
    input: Omit<PatchSetApproval, "timestamp">,
  ): Promise<PatchSet> {
    if (this.options.sessionId === undefined) return this.approveUnlocked(idOrPatchSet, input);
    return this.withWorkspaceLock(async (lease) => {
      await this.assertSessionJournalActive();
      const patchset = await this.approveUnlocked(idOrPatchSet, input);
      await this.assertLock(lease);
      return patchset;
    });
  }

  private async approveUnlocked(
    idOrPatchSet: string | PatchSet,
    input: Omit<PatchSetApproval, "timestamp">,
  ): Promise<PatchSet> {
    const patchset = await this.resolve(idOrPatchSet);
    if (!["pending_approval", "approved"].includes(patchset.status)) {
      throw new Error(`PatchSet ${patchset.id} is ${patchset.status}`);
    }
    const approval: PatchSetApproval = { ...input, timestamp: new Date().toISOString() };
    patchset.approvals = patchset.approvals.filter((item) => item.actor !== approval.actor);
    patchset.approvals.push(approval);
    if (approval.decision === "reject") {
      patchset.status = "failed";
      patchset.error = `rejected by ${approval.actor}`;
    } else if (this.approvalSatisfied(patchset)) {
      patchset.status = "approved";
      delete patchset.error;
    }
    patchset.updatedAt = new Date().toISOString();
    await this.persist(patchset);
    await this.options.onApproval?.(patchset, approval);
    return patchset;
  }

  async apply(patchset: PatchSet, options: { signal?: AbortSignal } = {}): Promise<PatchSet> {
    this.assertDirectCommitAuthority();
    this.assertPatchSetOwnership(patchset);
    return this.withWorkspaceLock(async (lease) => {
      await this.assertSessionJournalActive();
      const linked = combineAbortSignals([options.signal, lease.signal]);
      try {
        return await this.applyLocked(patchset, lease, linked.signal);
      } finally {
        linked.dispose();
      }
    });
  }

  private async applyLocked(
    patchset: PatchSet,
    lease: WorkspaceLease,
    signal: AbortSignal,
  ): Promise<PatchSet> {
    signal.throwIfAborted();
    await this.assertLock(lease);
    if (patchset.status === "pending_approval" || !this.approvalSatisfied(patchset)) {
      throw new Error(`PatchSet ${patchset.id} lacks required approvals`);
    }
    if (!["planned", "approved"].includes(patchset.status))
      throw new Error(`PatchSet ${patchset.id} is ${patchset.status}`);
    const conflicts: string[] = [];
    for (const change of patchset.changes) {
      const current = await this.readWorkspace(change.path);
      if (digest(current) !== change.beforeHash) conflicts.push(change.path);
    }
    if (conflicts.length) {
      patchset.status = "conflict";
      patchset.updatedAt = new Date().toISOString();
      patchset.error = `files changed since preview: ${conflicts.join(", ")}`;
      await this.persist(patchset);
      throw new PatchSetConflictError(conflicts);
    }

    patchset.status = "applying";
    patchset.appliedCount = 0;
    patchset.fencingToken = lease.owner.fencingToken;
    patchset.updatedAt = new Date().toISOString();
    await this.persist(patchset);
    await this.assertLock(lease);
    try {
      for (let index = 0; index < patchset.changes.length; index++) {
        signal.throwIfAborted();
        const change = patchset.changes[index]!;
        await this.assertLock(lease);
        // Close the optimistic-lock window between the initial preview check and this install.
        if (digest(await this.readWorkspace(change.path)) !== change.beforeHash) {
          throw new PatchSetConflictError([change.path]);
        }
        // Journal the rollback intent before the atomic install. If the process dies between these
        // operations, recovery treats an unchanged `beforeHash` as an already-safe no-op; if it dies
        // after install, the same durable prefix restores the previous bytes.
        patchset.appliedCount = index + 1;
        patchset.updatedAt = new Date().toISOString();
        await this.persist(patchset);
        signal.throwIfAborted();
        await this.assertLock(lease);
        await this.install(
          change.path,
          decode(change.after, change.encoding),
          change.afterMode,
          lease,
          change.beforeHash,
        );
        signal.throwIfAborted();
        await this.assertLock(lease);
      }
      signal.throwIfAborted();
      await this.assertLock(lease);
      patchset.status = "applied";
      patchset.updatedAt = new Date().toISOString();
      await this.persist(patchset);
      await this.assertLock(lease);
      return patchset;
    } catch (error) {
      const rollbackErrors = await this.rollbackPrefix(patchset, false, lease);
      // A stale owner must never overwrite recovery state written by its successor. The durable
      // write-ahead journal already says `applying` and retains the unresolved prefix.
      const stillOwnsLock = await this.assertLockOwnership(lease)
        .then(() => true)
        .catch(() => false);
      if (stillOwnsLock) {
        patchset.status = rollbackErrors.length ? "applying" : "failed";
        patchset.updatedAt = new Date().toISOString();
        patchset.error = `${error instanceof Error ? error.message : String(error)}${
          rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join("; ")}` : ""
        }`;
        await this.persist(patchset);
        await this.assertLockOwnership(lease);
      }
      throw error;
    }
  }

  async rollback(idOrPatchSet: string | PatchSet, force = false): Promise<PatchSet> {
    this.assertDirectCommitAuthority();
    return this.withWorkspaceLock(async (lease) => {
      await this.assertSessionJournalActive();
      await this.assertLock(lease);
      return this.rollbackLocked(idOrPatchSet, force, lease);
    });
  }

  private async rollbackLocked(
    idOrPatchSet: string | PatchSet,
    force: boolean,
    lease: WorkspaceLease,
  ): Promise<PatchSet> {
    const patchset = await this.resolve(idOrPatchSet);
    if (patchset.status !== "applied")
      throw new Error(`PatchSet ${patchset.id} is ${patchset.status}`);
    if (!force) {
      const conflicts: string[] = [];
      for (const change of patchset.changes) {
        if (digest(await this.readWorkspace(change.path)) !== change.afterHash)
          conflicts.push(change.path);
      }
      if (conflicts.length) throw new PatchSetConflictError(conflicts);
    }
    patchset.fencingToken = lease.owner.fencingToken;
    patchset.appliedCount = patchset.changes.length;
    const errors = await this.rollbackPrefix(patchset, force, lease);
    if (errors.length) throw new Error(`PatchSet rollback failed: ${errors.join("; ")}`);
    await this.assertLock(lease);
    patchset.status = "rolled_back";
    patchset.updatedAt = new Date().toISOString();
    await this.persist(patchset);
    await this.assertLock(lease);
    return patchset;
  }

  /**
   * 把 stale PatchSet 的文本改动三方合并到当前工作区，生成一个新的、尚未应用的事务。
   * base=旧 preview，ours=原 PatchSet 目标，theirs=当前磁盘；二进制、删除冲突与 rename
   * 端点冲突不猜测，直接抛 PatchSetConflictError。文本冲突保留标准 conflict markers，
   * 由审批者/Verifier 处理后再提交新的 PatchSet。
   */
  async rebase(idOrPatchSet: string | PatchSet): Promise<PatchSetRebaseResult> {
    const original = await this.resolve(idOrPatchSet);
    const inputs: PatchSetChangeInput[] = [];
    const unmergeable: string[] = [];
    const conflictedPaths: string[] = [];
    for (const change of original.changes) {
      const current = await this.readWorkspace(change.path);
      const before = decode(change.before, change.encoding);
      const after = decode(change.after, change.encoding);
      if (digest(current) === change.beforeHash) {
        inputs.push({ path: change.path, content: after });
        continue;
      }
      if (
        change.encoding === "base64" ||
        after === null ||
        current === null ||
        change.operation === "rename-source" ||
        change.operation === "rename-target"
      ) {
        unmergeable.push(change.path);
        continue;
      }
      const merged = threeWayMerge(
        before === null ? "" : Buffer.from(before).toString("utf8"),
        Buffer.from(after).toString("utf8"),
        Buffer.from(current).toString("utf8"),
      );
      if (merged.conflicted) conflictedPaths.push(change.path);
      inputs.push({ path: change.path, content: merged.content });
    }
    if (unmergeable.length) throw new PatchSetConflictError(unmergeable);
    const rebasedService = new PatchSetService(this.root, {
      journalDir: this.journalDir,
      writeFile: this.writeFile,
      ...(this.options.directCommit ? { directCommit: this.options.directCommit } : {}),
      ...(this.options.sessionId ? { sessionId: this.options.sessionId } : {}),
      requiredApprovals: original.requiredApprovals,
      requiredRoles: original.requiredRoles,
      ...(this.options.onApproval ? { onApproval: this.options.onApproval } : {}),
    });
    const patchset = await rebasedService.prepare(inputs);
    return { patchset, conflictedPaths };
  }

  async recoverIncomplete(): Promise<PatchSet[]> {
    this.assertDirectCommitAuthority();
    let names: string[];
    try {
      names = await fs.readdir(this.journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const recovered: PatchSet[] = [];
    for (const name of names.filter((value) => /^ps_.*\.json$/.test(value))) {
      const id = name.slice(0, -5);
      const candidate = await this.loadRaw(id);
      if (
        !candidate ||
        candidate.status !== "applying" ||
        !this.belongsToConfiguredOwner(candidate)
      )
        continue;
      this.assertPatchSetOwnership(candidate);
      const patchset = await this.withWorkspaceLock(async (lease) => {
        await this.assertSessionJournalActive();
        // 另一个进程可能在我们等待锁时完成了事务；必须在锁内重读，绝不能把
        // 已成功提交的 PatchSet 当作崩溃残留回滚。
        const current = await this.loadRaw(id);
        if (!current || current.status !== "applying" || !this.belongsToConfiguredOwner(current))
          return undefined;
        this.assertPatchSetOwnership(current);
        current.fencingToken = lease.owner.fencingToken;
        const errors = await this.rollbackPrefix(current, false, lease);
        // Keep a retryable applying journal until every rollback entry is durably restored.
        current.status = errors.length ? "applying" : "rolled_back";
        current.error = errors.length
          ? `crash recovery rollback errors: ${errors.join("; ")}`
          : "recovered incomplete transaction after restart";
        current.updatedAt = new Date().toISOString();
        await this.persist(current);
        await this.assertLockOwnership(lease);
        return current;
      });
      if (patchset) recovered.push(patchset);
    }
    return recovered;
  }

  async load(id: string): Promise<PatchSet | undefined> {
    const patchset = await this.loadRaw(id);
    if (patchset) this.assertPatchSetOwnership(patchset);
    return patchset;
  }

  /**
   * Physically remove journals owned by one deleted conversation. Draft/approved journals are
   * first cancelled into the terminal failed state under the workspace lock. Once this method
   * owns that same lock, an `applying` journal cannot still have a live writer: it is a durable
   * interrupted-apply record and is rolled back before the session tombstone is installed.
   */
  async deleteSession(sessionId: string): Promise<number> {
    this.assertDirectCommitAuthority();
    if (this.options.sessionId !== sessionId) {
      throw new PatchSetSessionOwnershipError("<session-purge>", this.options.sessionId, sessionId);
    }
    return this.withWorkspaceLock(async (lease) => {
      const names = await fs.readdir(this.journalDir);
      const owned: PatchSet[] = [];
      for (const name of names.filter((value) => /^ps_.*\.json$/.test(value))) {
        const patchset = await this.loadRaw(name.slice(0, -5));
        if (!patchset || patchset.sessionId !== sessionId) continue;
        this.assertPatchSetOwnership(patchset);
        owned.push(patchset);
      }
      for (const patchset of owned) {
        await this.assertLock(lease);
        if (patchset.status === "applying") {
          patchset.fencingToken = lease.owner.fencingToken;
          const errors = await this.rollbackPrefix(patchset, false, lease);
          patchset.status = errors.length ? "applying" : "rolled_back";
          patchset.error = errors.length
            ? `session deletion recovery rollback errors: ${errors.join("; ")}`
            : "recovered interrupted transaction because the owning session was deleted";
          patchset.updatedAt = new Date().toISOString();
          await this.persist(patchset);
          await this.assertLockOwnership(lease);
          if (errors.length) {
            throw new Error(
              `Cannot delete session ${sessionId}: PatchSet ${patchset.id} recovery failed: ${errors.join("; ")}`,
            );
          }
        } else if (["planned", "pending_approval", "approved"].includes(patchset.status)) {
          patchset.status = "failed";
          patchset.error = "cancelled because the owning session was deleted";
          patchset.updatedAt = new Date().toISOString();
          await this.persist(patchset);
        } else if (!this.isTerminalPatchSetStatus(patchset.status)) {
          throw new Error(
            `Cannot delete PatchSet ${patchset.id} in unknown state ${patchset.status}`,
          );
        }
      }
      await this.writeSessionDeletionTombstone(sessionId);
      await this.assertLock(lease);
      for (const patchset of owned) {
        await this.assertLock(lease);
        const current = await this.loadRaw(patchset.id);
        if (!current) continue;
        this.assertPatchSetOwnership(current);
        if (!this.isTerminalPatchSetStatus(current.status)) {
          throw new Error(`Cannot delete non-terminal PatchSet ${current.id}`);
        }
        await fs.unlink(path.join(this.journalDir, `${current.id}.json`));
        await this.assertLock(lease);
      }
      await syncDirectory(this.journalDir);
      return owned.length;
    });
  }

  private async loadRaw(id: string): Promise<PatchSet | undefined> {
    if (!/^ps_[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid PatchSet id: ${id}`);
    try {
      return JSON.parse(
        await fs.readFile(path.join(this.journalDir, `${id}.json`), "utf8"),
      ) as PatchSet;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /** Read-only operator aid for an abandoned fail-closed lock. */
  async inspectWorkspaceLock(): Promise<PatchSetWorkspaceLockInfo | undefined> {
    try {
      return await this.readLock();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  /**
   * Explicit same-host recovery for a lock whose recorded PID no longer exists. The exact
   * 256-bit owner token from inspectWorkspaceLock is required. Cross-host locks remain
   * fail-closed because this process cannot prove the remote owner's liveness.
   */
  async recoverAbandonedWorkspaceLock(expectedOwnerToken: string): Promise<boolean> {
    this.assertDirectCommitAuthority();
    if (!/^[a-f0-9]{64}$/.test(expectedOwnerToken)) {
      throw new Error("Invalid PatchSet workspace lock owner token");
    }
    const owner = await this.inspectWorkspaceLock();
    if (!owner) return false;
    if (owner.ownerToken !== expectedOwnerToken) {
      throw new Error("PatchSet workspace lock owner token mismatch");
    }
    if (owner.host !== hostname()) {
      throw new Error("Cannot recover a PatchSet workspace lock owned by another host");
    }
    if (this.processMayBeAlive(owner.pid)) {
      throw new Error(`Cannot recover live PatchSet workspace lock owned by PID ${owner.pid}`);
    }
    const before = await fs.lstat(this.lockFile, { bigint: true });
    const confirmed = await this.readLock();
    const current = await fs.lstat(this.lockFile, { bigint: true });
    if (
      confirmed.ownerToken !== expectedOwnerToken ||
      !sameIdentity({ dev: before.dev, ino: before.ino }, { dev: current.dev, ino: current.ino })
    ) {
      throw new Error("PatchSet workspace lock changed during recovery");
    }
    await fs.unlink(this.lockFile);
    await syncDirectory(this.journalDir);
    return true;
  }

  private belongsToConfiguredOwner(patchset: PatchSet): boolean {
    return patchset.sessionId === this.options.sessionId;
  }

  private assertPatchSetOwnership(patchset: PatchSet): void {
    if (!this.belongsToConfiguredOwner(patchset)) {
      throw new PatchSetSessionOwnershipError(
        patchset.id,
        this.options.sessionId,
        patchset.sessionId,
      );
    }
    let journalRoot: string;
    try {
      journalRoot = realpathSync.native(path.resolve(patchset.root));
    } catch (cause) {
      throw new Error(`Cannot verify PatchSet ${patchset.id} workspace root`, { cause });
    }
    if (journalRoot !== this.root) {
      throw new Error(`PatchSet ${patchset.id} belongs to another workspace`);
    }
  }

  private approvalSatisfied(patchset: PatchSet): boolean {
    if (patchset.requiredApprovals === 0) return true;
    const approved = patchset.approvals.filter((approval) => approval.decision === "approve");
    if (approved.length < patchset.requiredApprovals) return false;
    return patchset.requiredRoles.every((role) =>
      approved.some((approval) => approval.role === role),
    );
  }

  private isTerminalPatchSetStatus(status: PatchSetStatus): boolean {
    return ["applied", "conflict", "rolled_back", "failed"].includes(status);
  }

  private async resolve(value: string | PatchSet): Promise<PatchSet> {
    const patchset = typeof value === "string" ? await this.load(value) : value;
    if (!patchset) throw new Error(`Unknown PatchSet: ${String(value)}`);
    this.assertPatchSetOwnership(patchset);
    return patchset;
  }

  private async rollbackPrefix(
    patchset: PatchSet,
    force = false,
    lease?: WorkspaceLease,
  ): Promise<string[]> {
    const errors: string[] = [];
    for (const change of patchset.changes.slice(0, patchset.appliedCount).reverse()) {
      try {
        if (lease) await this.assertLockOwnership(lease);
        const current = await this.readWorkspace(change.path);
        if (!force) {
          const currentHash = digest(current);
          // Write-ahead journal entries may describe an install that had not begun before a crash.
          // The original content is already the desired rollback state, so recovery is idempotent.
          if (currentHash === change.beforeHash) continue;
          if (currentHash !== change.afterHash) {
            throw new Error("rollback refused because file changed after apply");
          }
        }
        await this.install(
          change.path,
          decode(change.before, change.encoding),
          change.beforeMode,
          lease,
          change.afterHash,
          true,
        );
      } catch (error) {
        errors.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Keep the full write-ahead prefix when any rollback step failed. Earlier entries that were
    // already restored are harmless: a later recovery observes beforeHash and treats them as
    // idempotent no-ops.
    if (errors.length === 0) patchset.appliedCount = 0;
    return errors;
  }

  private async install(
    relative: string,
    content: Uint8Array | null,
    mode?: number,
    lease?: WorkspaceLease,
    expectedHash?: string,
    allowAbortedLease = false,
  ): Promise<void> {
    if (!lease) throw new Error("PatchSet install requires an active workspace lease");
    const proof = await this.captureWorkspacePath(relative, content !== null);
    const current = proof.missingParent ? null : await readMaybe(proof.file);
    if (expectedHash !== undefined && digest(current) !== expectedHash) {
      throw new PatchSetConflictError([relative]);
    }
    if (proof.missingParent && content === null) {
      if (allowAbortedLease) await this.assertLockOwnership(lease);
      else await this.assertLock(lease);
      return;
    }
    const guardBefore = async (): Promise<void> => {
      if (allowAbortedLease) await this.assertLockOwnership(lease);
      else await this.assertLock(lease);
      await this.verifyWorkspacePath(proof, true);
      if (expectedHash !== undefined && digest(await readMaybe(proof.file)) !== expectedHash) {
        throw new PatchSetConflictError([relative]);
      }
    };
    const guardAfter = async (): Promise<void> => {
      if (allowAbortedLease) await this.assertLockOwnership(lease);
      else await this.assertLock(lease);
      await this.verifyWorkspacePath(proof, false);
      const stat = await fs.lstat(proof.file, { bigint: true }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (stat?.isSymbolicLink()) {
        throw new Error(`PatchSet target became a symbolic link: ${relative}`);
      }
    };
    await guardBefore();
    await this.options.beforeWorkspaceInstall?.(proof.file);
    await guardBefore();
    if (content === null) {
      await fs.rm(proof.file, { force: true });
      await syncDirectory(path.dirname(proof.file));
      await guardAfter();
      return;
    }
    const normalizedMode = normalizeMode(mode ?? 0o644);
    if (this.options.writeFile) {
      await this.writeFile(proof.file, content, normalizedMode);
      await guardAfter();
    } else {
      await atomicWrite(proof.file, content, normalizedMode, async (phase) => {
        if (phase === "before-rename") await guardBefore();
        else await guardAfter();
      });
    }
  }

  private async persist(patchset: PatchSet): Promise<void> {
    this.assertPatchSetOwnership(patchset);
    await this.ensureJournalDirectory();
    await this.assertSessionJournalActive();
    await fs.chmod(this.journalDir, 0o700);
    const target = path.join(this.journalDir, `${patchset.id}.json`);
    await atomicWrite(target, Buffer.from(JSON.stringify(patchset, null, 2) + "\n"), 0o600);
  }

  private async readWorkspace(relative: string): Promise<Uint8Array | null> {
    return readMaybe(await this.workspaceFile(relative));
  }

  /** 拒绝最终文件和任一父目录 symlink，避免 PatchSet 通过工作区链接写到边界外。 */
  private async workspaceFile(candidate: string): Promise<string> {
    return (await this.captureWorkspacePath(candidate, false)).file;
  }

  private async captureWorkspacePath(
    candidate: string,
    createParents: boolean,
  ): Promise<WorkspacePathProof> {
    const relative = safeRelative(this.root, candidate);
    if (protectedWorkspacePath(relative)) {
      throw new Error(`PatchSet path is protected runtime state: ${relative}`);
    }
    const segments = relative.split(path.sep).filter(Boolean);
    const parents: DirectoryIdentity[] = [];
    let current = this.root;
    const rootStat = await fs.lstat(current, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error(`PatchSet workspace root is not a real directory: ${this.root}`);
    }
    parents.push({ path: current, dev: rootStat.dev, ino: rootStat.ino });
    for (let index = 0; index < segments.length - 1; index++) {
      current = path.join(current, segments[index]!);
      let stat: BigIntStats | undefined;
      try {
        stat = await fs.lstat(current, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!createParents) {
          return {
            file: path.join(this.root, relative),
            parents,
            targetExists: false,
            missingParent: true,
          };
        }
        // Node does not expose openat/mkdirat. Trusted-local mode creates one component at a time
        // and revalidates the complete identity chain before continuing; untrusted production
        // callers never receive the directCommit capability.
        await this.verifyDirectories(parents);
        await fs.mkdir(current, { mode: 0o755 });
        await syncDirectory(path.dirname(current));
        stat = await fs.lstat(current, { bigint: true });
      }
      if (stat.isSymbolicLink()) {
        throw new Error(`PatchSet path contains a symbolic link: ${relative}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`PatchSet parent is not a directory: ${relative}`);
      }
      parents.push({ path: current, dev: stat.dev, ino: stat.ino });
    }
    await this.verifyDirectories(parents);
    const file = path.join(this.root, relative);
    try {
      const target = await fs.lstat(file, { bigint: true });
      if (target.isSymbolicLink()) {
        throw new Error(`PatchSet path contains a symbolic link: ${relative}`);
      }
      if (!target.isFile()) {
        throw new Error(`PatchSet target is not a regular file: ${relative}`);
      }
      return { file, parents, targetExists: true, target: { dev: target.dev, ino: target.ino } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      return { file, parents, targetExists: false };
    }
  }

  private async verifyDirectories(expected: DirectoryIdentity[]): Promise<void> {
    for (const identity of expected) {
      const current = await fs.lstat(identity.path, { bigint: true });
      if (
        current.isSymbolicLink() ||
        !current.isDirectory() ||
        !sameIdentity(identity, { dev: current.dev, ino: current.ino })
      ) {
        throw new Error(`PatchSet parent directory identity changed: ${identity.path}`);
      }
    }
  }

  private async verifyWorkspacePath(
    proof: WorkspacePathProof,
    verifyTarget: boolean,
  ): Promise<void> {
    await this.verifyDirectories(proof.parents);
    if (!verifyTarget) return;
    try {
      const current = await fs.lstat(proof.file, { bigint: true });
      if (current.isSymbolicLink() || !current.isFile()) {
        throw new Error(`PatchSet target type changed: ${proof.file}`);
      }
      if (!proof.targetExists || !proof.target) {
        throw new Error(`PatchSet target appeared during commit: ${proof.file}`);
      }
      if (!sameIdentity(proof.target, { dev: current.dev, ino: current.ino })) {
        throw new Error(`PatchSet target identity changed during commit: ${proof.file}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (proof.targetExists) {
        throw new Error(`PatchSet target disappeared during commit: ${proof.file}`, {
          cause: error,
        });
      }
    }
  }

  private async ensureJournalDirectory(): Promise<void> {
    const relative = safeRelative(this.root, this.journalDir);
    const segments = relative.split(path.sep).filter(Boolean);
    let current = this.root;
    for (const segment of segments) {
      current = path.join(current, segment);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error(`PatchSet journal path is not a real directory: ${current}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await fs.mkdir(current, { mode: 0o700 });
        await syncDirectory(path.dirname(current));
        const created = await fs.lstat(current);
        if (created.isSymbolicLink() || !created.isDirectory()) {
          throw new Error(`PatchSet journal path race detected: ${current}`, { cause: error });
        }
      }
    }
  }

  private sessionDeletionTombstone(sessionId: string): string {
    const ownerHash = createHash("sha256").update(sessionId).digest("hex");
    return path.join(this.journalDir, `.session-deleted-${ownerHash}.json`);
  }

  private async assertSessionJournalActive(): Promise<void> {
    const sessionId = this.options.sessionId;
    if (sessionId === undefined) return;
    try {
      await fs.access(this.sessionDeletionTombstone(sessionId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    throw new Error(`PatchSet journal for deleted session ${sessionId} is permanently fenced`);
  }

  private async writeSessionDeletionTombstone(sessionId: string): Promise<void> {
    const body = Buffer.from(
      `${JSON.stringify({ version: 1, deletedAt: new Date().toISOString() })}\n`,
    );
    await atomicWrite(this.sessionDeletionTombstone(sessionId), body, 0o600);
  }

  private assertDirectCommitAuthority(): void {
    if (this.options.directCommit !== "trusted-local") {
      throw new Error(
        "PatchSet direct commit is disabled; use an isolated control-plane committer or explicitly attest trusted-local authority",
      );
    }
  }

  private async withWorkspaceLock<T>(work: (lease: WorkspaceLease) => Promise<T>): Promise<T> {
    await this.ensureJournalDirectory();
    const timeoutMs = Math.max(1, this.options.lockTimeoutMs ?? 30_000);
    const retryMs = Math.max(1, this.options.lockRetryMs ?? 25);
    const heartbeatMs = Math.max(1, this.options.lockHeartbeatMs ?? 30_000);
    const deadline = Date.now() + timeoutMs;
    let handle: import("node:fs/promises").FileHandle | undefined;
    for (;;) {
      try {
        handle = await fs.open(this.lockFile, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline)
          throw new Error("PatchSet workspace lock timeout", { cause: error });
        // Never infer abandonment from wall-clock time. A paused live owner is still the owner;
        // abandoned locks require explicit operator recovery outside this transaction path.
        await new Promise((resolve) => setTimeout(resolve, retryMs));
      }
    }
    const controller = new AbortController();
    let lease: WorkspaceLease | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    let heartbeatTask: Promise<void> | undefined;
    try {
      const previous = Number.parseInt(
        await fs.readFile(this.fenceFile, "utf8").catch(() => "0"),
        10,
      );
      const fencingToken = (Number.isSafeInteger(previous) ? previous : 0) + 1;
      await atomicWrite(this.fenceFile, Buffer.from(`${fencingToken}\n`), 0o600);
      const owner: PatchSetWorkspaceLockInfo = {
        version: 1,
        ownerToken: randomBytes(32).toString("hex"),
        fencingToken,
        pid: process.pid,
        host: hostname(),
        acquiredAt: new Date().toISOString(),
      };
      await handle.truncate(0);
      await handle.writeFile(JSON.stringify(owner));
      await handle.sync();
      const stat = await handle.stat({ bigint: true });
      lease = {
        owner,
        identity: { dev: stat.dev, ino: stat.ino },
        signal: controller.signal,
      };
      const refreshHeartbeat = async (): Promise<void> => {
        if (heartbeatTask || controller.signal.aborted || !lease) return heartbeatTask;
        const activeLease = lease;
        heartbeatTask = (async () => {
          try {
            await this.assertLockOwnership(activeLease);
            if (this.options.touchWorkspaceLock) {
              await this.options.touchWorkspaceLock(this.lockFile);
            } else {
              const now = new Date();
              await fs.utimes(this.lockFile, now, now);
            }
            await this.assertLockOwnership(activeLease);
          } catch (error) {
            controller.abort(
              new Error(
                `PatchSet workspace lock heartbeat failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
                { cause: error },
              ),
            );
          }
        })().finally(() => {
          heartbeatTask = undefined;
        });
        return heartbeatTask;
      };
      heartbeat = setInterval(() => void refreshHeartbeat(), heartbeatMs);
      heartbeat.unref?.();
      const result = await work(lease);
      await this.assertLock(lease);
      return result;
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await heartbeatTask;
      if (lease) await this.releaseWorkspaceLock(lease).catch(() => undefined);
      await handle?.close();
    }
  }

  private async assertLock(lease: WorkspaceLease): Promise<void> {
    if (lease.signal.aborted) throw abortError(lease.signal);
    await this.assertLockOwnership(lease);
    if (lease.signal.aborted) throw abortError(lease.signal);
  }

  private async assertLockOwnership(lease: WorkspaceLease): Promise<void> {
    const [owner, stat] = await Promise.all([
      this.readLock(),
      fs.lstat(this.lockFile, { bigint: true }),
    ]);
    if (
      owner.ownerToken !== lease.owner.ownerToken ||
      owner.fencingToken !== lease.owner.fencingToken ||
      owner.pid !== lease.owner.pid ||
      !sameIdentity(lease.identity, { dev: stat.dev, ino: stat.ino })
    ) {
      throw new Error(`Stale PatchSet workspace lease ${lease.owner.fencingToken}`);
    }
  }

  private async releaseWorkspaceLock(lease: WorkspaceLease): Promise<void> {
    const [owner, stat] = await Promise.all([
      this.readLock().catch(() => undefined),
      fs.lstat(this.lockFile, { bigint: true }).catch(() => undefined),
    ]);
    if (
      owner?.ownerToken === lease.owner.ownerToken &&
      owner.fencingToken === lease.owner.fencingToken &&
      stat &&
      sameIdentity(lease.identity, { dev: stat.dev, ino: stat.ino })
    ) {
      await fs.unlink(this.lockFile);
      await syncDirectory(this.journalDir);
    }
  }

  private processMayBeAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private async readLock(): Promise<PatchSetWorkspaceLockInfo> {
    const parsed = JSON.parse(
      await fs.readFile(this.lockFile, "utf8"),
    ) as Partial<PatchSetWorkspaceLockInfo>;
    if (
      parsed.version !== 1 ||
      typeof parsed.ownerToken !== "string" ||
      !/^[a-f0-9]{64}$/.test(parsed.ownerToken) ||
      !Number.isSafeInteger(parsed.fencingToken) ||
      !Number.isSafeInteger(parsed.pid) ||
      typeof parsed.host !== "string" ||
      typeof parsed.acquiredAt !== "string"
    ) {
      throw new Error("Invalid PatchSet workspace lock");
    }
    return parsed as PatchSetWorkspaceLockInfo;
  }
}

/** 保守三方合并：独立同位置改动自动合并，歧义改动生成标准 conflict marker。 */
export function threeWayMerge(base: string, ours: string, theirs: string): ThreeWayMergeResult {
  if (ours === theirs) return { content: ours, conflicted: false, conflicts: 0 };
  if (ours === base) return { content: theirs, conflicted: false, conflicts: 0 };
  if (theirs === base) return { content: ours, conflicted: false, conflicts: 0 };
  const baseLines = base.split("\n");
  const ourLines = ours.split("\n");
  const theirLines = theirs.split("\n");
  if (baseLines.length === ourLines.length && baseLines.length === theirLines.length) {
    const merged: string[] = [];
    let conflicts = 0;
    for (let index = 0; index < baseLines.length; index++) {
      const baseLine = baseLines[index]!;
      const ourLine = ourLines[index]!;
      const theirLine = theirLines[index]!;
      if (ourLine === theirLine) merged.push(ourLine);
      else if (ourLine === baseLine) merged.push(theirLine);
      else if (theirLine === baseLine) merged.push(ourLine);
      else {
        conflicts++;
        merged.push(
          "<<<<<<< ours",
          ourLine,
          "||||||| base",
          baseLine,
          "=======",
          theirLine,
          ">>>>>>> theirs",
        );
      }
    }
    return { content: merged.join("\n"), conflicted: conflicts > 0, conflicts };
  }
  return {
    content: ["<<<<<<< ours", ours, "||||||| base", base, "=======", theirs, ">>>>>>> theirs"].join(
      "\n",
    ),
    conflicted: true,
    conflicts: 1,
  };
}
