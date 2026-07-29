/** 事务 PatchSet v2：文本/二进制、rename、三方合并、审批链、冲突与崩溃回滚。 */

import { createHash, randomUUID } from "node:crypto";
import { promises as fs, realpathSync } from "node:fs";
import * as path from "node:path";

export interface PatchSetChangeInput {
  path: string;
  /** null 删除；Uint8Array 作为二进制；省略时仅可用于 rename。 */
  content?: string | Uint8Array | null;
  /** 将该路径移动到 path；内容默认沿用源文件，可同时覆盖 content。 */
  renameFrom?: string;
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
  status: PatchSetStatus;
  createdAt: string;
  updatedAt: string;
  changes: PatchSetChange[];
  requiredApprovals: number;
  requiredRoles: string[];
  approvals: PatchSetApproval[];
  appliedCount: number;
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

async function atomicWrite(file: string, content: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.anicode-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { flag: "wx" });
    const handle = await fs.open(temporary, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
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

export interface PatchSetServiceOptions {
  journalDir?: string;
  writeFile?: (file: string, content: Uint8Array) => Promise<void>;
  requiredApprovals?: number;
  requiredRoles?: string[];
  onApproval?: (patchset: PatchSet, approval: PatchSetApproval) => void | Promise<void>;
}

export class PatchSetService {
  readonly root: string;
  private readonly journalDir: string;
  private readonly writeFile: (file: string, content: Uint8Array) => Promise<void>;

  constructor(
    root: string,
    private readonly options: PatchSetServiceOptions = {},
  ) {
    // macOS 上 /var 通常是指向 /private/var 的符号链接。文件工具会返回校验后的
    // canonical path，因此 PatchSet 也必须使用相同根，否则合法目标会被误判为越界。
    this.root = realpathSync.native(path.resolve(root));
    this.journalDir = options.journalDir ?? path.join(this.root, ".anicode", "patchsets");
    this.writeFile = options.writeFile ?? atomicWrite;
  }

  async prepare(inputs: PatchSetChangeInput[]): Promise<PatchSet> {
    const expanded: Array<{
      path: string;
      content: string | Uint8Array | null;
      operation?: PatchSetChange["operation"];
      renameGroup?: string;
    }> = [];
    for (const input of inputs) {
      if (!input.renameFrom) {
        if (input.content === undefined) throw new Error(`PatchSet content missing: ${input.path}`);
        expanded.push({ path: input.path, content: input.content });
        continue;
      }
      const source = safeRelative(this.root, input.renameFrom);
      const sourceBytes = await readMaybe(path.join(this.root, source));
      if (sourceBytes === null) throw new Error(`PatchSet rename source does not exist: ${source}`);
      const group = `rename_${randomUUID()}`;
      expanded.push({
        path: source,
        content: null,
        operation: "rename-source",
        renameGroup: group,
      });
      expanded.push({
        path: input.path,
        content: input.content === undefined ? sourceBytes : input.content,
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
      const beforeBytes = await readMaybe(path.join(this.root, relative));
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
      });
    }
    const requiredApprovals = Math.max(0, this.options.requiredApprovals ?? 0);
    const now = new Date().toISOString();
    const patchset: PatchSet = {
      version: 2,
      id: `ps_${Date.now().toString(36)}_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      root: this.root,
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

  async apply(patchset: PatchSet): Promise<PatchSet> {
    if (patchset.status === "pending_approval" || !this.approvalSatisfied(patchset)) {
      throw new Error(`PatchSet ${patchset.id} lacks required approvals`);
    }
    if (!["planned", "approved"].includes(patchset.status))
      throw new Error(`PatchSet ${patchset.id} is ${patchset.status}`);
    const conflicts: string[] = [];
    for (const change of patchset.changes) {
      const current = await readMaybe(path.join(this.root, change.path));
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
    patchset.updatedAt = new Date().toISOString();
    await this.persist(patchset);
    try {
      for (let index = 0; index < patchset.changes.length; index++) {
        const change = patchset.changes[index]!;
        await this.install(change.path, decode(change.after, change.encoding));
        patchset.appliedCount = index + 1;
        patchset.updatedAt = new Date().toISOString();
        // 每步推进 journal；SIGKILL 后 recoverIncomplete 可精确回滚已提交前缀。
        await this.persist(patchset);
      }
      patchset.status = "applied";
      patchset.updatedAt = new Date().toISOString();
      await this.persist(patchset);
      return patchset;
    } catch (error) {
      const rollbackErrors = await this.rollbackPrefix(patchset);
      patchset.status = "failed";
      patchset.updatedAt = new Date().toISOString();
      patchset.error = `${error instanceof Error ? error.message : String(error)}${
        rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join("; ")}` : ""
      }`;
      await this.persist(patchset);
      throw error;
    }
  }

  async rollback(idOrPatchSet: string | PatchSet, force = false): Promise<PatchSet> {
    const patchset = await this.resolve(idOrPatchSet);
    if (patchset.status !== "applied")
      throw new Error(`PatchSet ${patchset.id} is ${patchset.status}`);
    if (!force) {
      const conflicts: string[] = [];
      for (const change of patchset.changes) {
        if (digest(await readMaybe(path.join(this.root, change.path))) !== change.afterHash)
          conflicts.push(change.path);
      }
      if (conflicts.length) throw new PatchSetConflictError(conflicts);
    }
    patchset.appliedCount = patchset.changes.length;
    const errors = await this.rollbackPrefix(patchset);
    if (errors.length) throw new Error(`PatchSet rollback failed: ${errors.join("; ")}`);
    patchset.status = "rolled_back";
    patchset.updatedAt = new Date().toISOString();
    await this.persist(patchset);
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
      const current = await readMaybe(path.join(this.root, change.path));
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
      requiredApprovals: original.requiredApprovals,
      requiredRoles: original.requiredRoles,
      ...(this.options.onApproval ? { onApproval: this.options.onApproval } : {}),
    });
    const patchset = await rebasedService.prepare(inputs);
    return { patchset, conflictedPaths };
  }

  async recoverIncomplete(): Promise<PatchSet[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.journalDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const recovered: PatchSet[] = [];
    for (const name of names.filter((value) => /^ps_.*\.json$/.test(value))) {
      const patchset = await this.load(name.slice(0, -5));
      if (!patchset || patchset.status !== "applying") continue;
      const errors = await this.rollbackPrefix(patchset);
      patchset.status = errors.length ? "failed" : "rolled_back";
      patchset.error = errors.length
        ? `crash recovery rollback errors: ${errors.join("; ")}`
        : "recovered incomplete transaction after restart";
      patchset.updatedAt = new Date().toISOString();
      await this.persist(patchset);
      recovered.push(patchset);
    }
    return recovered;
  }

  async load(id: string): Promise<PatchSet | undefined> {
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

  private approvalSatisfied(patchset: PatchSet): boolean {
    if (patchset.requiredApprovals === 0) return true;
    const approved = patchset.approvals.filter((approval) => approval.decision === "approve");
    if (approved.length < patchset.requiredApprovals) return false;
    return patchset.requiredRoles.every((role) =>
      approved.some((approval) => approval.role === role),
    );
  }

  private async resolve(value: string | PatchSet): Promise<PatchSet> {
    const patchset = typeof value === "string" ? await this.load(value) : value;
    if (!patchset) throw new Error(`Unknown PatchSet: ${String(value)}`);
    return patchset;
  }

  private async rollbackPrefix(patchset: PatchSet): Promise<string[]> {
    const errors: string[] = [];
    for (const change of patchset.changes.slice(0, patchset.appliedCount).reverse()) {
      try {
        await this.install(change.path, decode(change.before, change.encoding));
      } catch (error) {
        errors.push(`${change.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    patchset.appliedCount = 0;
    return errors;
  }

  private async install(relative: string, content: Uint8Array | null): Promise<void> {
    const file = path.join(this.root, safeRelative(this.root, relative));
    if (content === null) await fs.rm(file, { force: true });
    else await this.writeFile(file, content);
  }

  private async persist(patchset: PatchSet): Promise<void> {
    await fs.mkdir(this.journalDir, { recursive: true, mode: 0o700 });
    await fs.chmod(this.journalDir, 0o700);
    const target = path.join(this.journalDir, `${patchset.id}.json`);
    await atomicWrite(target, Buffer.from(JSON.stringify(patchset, null, 2) + "\n"));
    await fs.chmod(target, 0o600);
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
