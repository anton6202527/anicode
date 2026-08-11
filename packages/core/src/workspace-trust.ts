/**
 * Workspace Trust boundary.
 *
 * A project directory is attacker-controlled until the user explicitly grants trust. Trust is
 * bound to the canonical directory identity and to a digest of project-owned configuration that
 * can execute code, change permissions, or inject agent instructions. Changing that execution
 * surface invalidates the grant without trusting any file inside the workspace as authority.
 */

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, type BigIntStats } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { openExclusiveLockFile } from "./security/exclusive-lock-file.js";

const TRUST_DOCUMENT_VERSION = 1;
const FINGERPRINT_VERSION = 1;
const MAX_CONFIG_BYTES = 4 * 1024 * 1024;
const MAX_EXTENSION_FILES = 4_096;
const MAX_EXTENSION_BYTES = 32 * 1024 * 1024;
const MAX_TRUST_FILE_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

const PROJECT_CONFIG_FILES = [
  "anicode.json",
  path.join(".anicode", "anicode.json"),
  path.join(".anicode", "settings.local.json"),
] as const;

/** Plain-text project environment files are inert while untrusted, but active after a grant. */
const PROJECT_ENV_FILES = [".env.local", ".env"] as const;
const PROJECT_MEMORY_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const PROJECT_GIT_EXECUTION_FILES = [
  ".gitattributes",
  path.join(".git", "config"),
  path.join(".git", "config.worktree"),
  path.join(".git", "info", "attributes"),
] as const;

/** Project-owned files that may inject prompts, tools, commands, or executable configuration. */
const PROJECT_EXECUTION_ROOTS = [
  path.join(".anicode", "plugins"),
  path.join(".anicode", "agents"),
  path.join(".anicode", "command"),
  path.join(".claude", "agents"),
  path.join(".claude", "skills"),
] as const;

const EXECUTION_CONFIG_KEYS = [
  "mcp",
  "agents",
  "lsp",
  "browser",
  "instructions",
  "hooks",
  "permissions",
  "permissionProfile",
  "permissionProfiles",
] as const;

export interface WorkspaceIdentity {
  /** realpath of the workspace root; symlink aliases resolve to the same identity. */
  canonicalRoot: string;
  /** Filesystem identity prevents a replacement directory at the same path inheriting trust. */
  device: string;
  inode: string;
  /** Non-secret lookup key derived from canonicalRoot/device/inode. */
  key: string;
}

export type WorkspaceTrustReason =
  | "trusted"
  | "not-trusted"
  | "execution-config-changed"
  | "workspace-identity-changed"
  | "inspection-failed";

export interface WorkspaceTrustAssessment {
  trusted: boolean;
  reason: WorkspaceTrustReason;
  identity?: WorkspaceIdentity;
  /** SHA-256 of execution-sensitive project configuration and extension files. */
  executionHash?: string;
  /** Existing project execution sources included in executionHash; values never contain secrets. */
  executionSources: string[];
  storeFile: string;
  assessedAt: string;
  /** Safe diagnostic for a fail-closed inspection/store error. */
  error?: string;
}

interface TrustRecord {
  identity: WorkspaceIdentity;
  executionHash: string;
  trustedAt: string;
}

interface TrustDocument {
  version: 1;
  workspaces: TrustRecord[];
}

interface TrustLockOwner {
  pid: number;
  token: string;
}

const TRUST_LOCK_TIMEOUT_MS = 5_000;
const INVALID_TRUST_LOCK_STALE_MS = 30_000;

export interface WorkspaceTrustStoreOptions {
  /** Defaults to ~/.config/anicode/trust/workspaces.json (or XDG_CONFIG_HOME). */
  file?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface WorkspaceTrustGrantExpectation {
  identityKey: string;
  executionHash: string;
}

interface ExecutionInspection {
  identity: WorkspaceIdentity;
  executionHash: string;
  executionSources: string[];
}

interface WorkspaceTrustInspectionTestHooks {
  afterFileOpen?: (file: string) => Promise<void>;
  beforeDirectoryEnumeration?: (directory: string) => Promise<void>;
}

let inspectionTestHooks: WorkspaceTrustInspectionTestHooks | undefined;

/** @internal Deterministic race injection for security regression tests. */
export function __setWorkspaceTrustInspectionHooksForTests(
  hooks: WorkspaceTrustInspectionTestHooks | undefined,
): void {
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new WorkspaceTrustError("Workspace trust inspection hooks are test-only");
  }
  inspectionTestHooks = hooks;
}

class WorkspaceTrustError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceTrustError";
  }
}

export function defaultWorkspaceTrustFile(
  home = os.homedir(),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configRoot = env["XDG_CONFIG_HOME"]?.trim();
  const base = configRoot && path.isAbsolute(configRoot) ? configRoot : path.join(home, ".config");
  return path.join(base, "anicode", "trust", "workspaces.json");
}

export async function canonicalWorkspaceIdentity(cwd: string): Promise<WorkspaceIdentity> {
  const canonicalRoot = await fs.realpath(path.resolve(cwd));
  const stat = await fs.stat(canonicalRoot, { bigint: true });
  if (!stat.isDirectory()) throw new WorkspaceTrustError(`Workspace is not a directory: ${cwd}`);
  const normalizedRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const device = stat.dev.toString();
  const inode = stat.ino.toString();
  const key = createHash("sha256")
    .update(`anicode-workspace-v1\0${process.platform}\0${normalizedRoot}\0${device}\0${inode}`)
    .digest("hex");
  return { canonicalRoot, device, inode, key };
}

/**
 * Extract only project configuration capable of execution, prompt injection, or permission
 * changes. Safe display/model preferences do not force users to re-grant trust.
 */
export function workspaceExecutionConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of EXECUTION_CONFIG_KEYS) {
    if (Object.hasOwn(source, key)) projected[key] = source[key];
  }
  const profiles = source["profiles"];
  if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
    const projectedProfiles: Record<string, unknown> = {};
    for (const name of Object.keys(profiles as Record<string, unknown>).sort()) {
      const profile = workspaceExecutionConfig((profiles as Record<string, unknown>)[name]);
      if (Object.keys(profile).length > 0) projectedProfiles[name] = profile;
    }
    if (Object.keys(projectedProfiles).length > 0) projected["profiles"] = projectedProfiles;
  }
  return projected;
}

export async function workspaceExecutionFingerprint(cwd: string): Promise<{
  identity: WorkspaceIdentity;
  executionHash: string;
  executionSources: string[];
}> {
  const inspection = await inspectWorkspaceExecution(cwd);
  return {
    identity: inspection.identity,
    executionHash: inspection.executionHash,
    executionSources: [...inspection.executionSources],
  };
}

/** Re-check a previously returned assessment immediately before consuming project configuration. */
export async function revalidateWorkspaceTrust(
  cwd: string,
  assessment: WorkspaceTrustAssessment,
): Promise<WorkspaceTrustAssessment> {
  if (!assessment.trusted || !assessment.identity || !assessment.executionHash) return assessment;
  try {
    const current = await inspectWorkspaceExecution(cwd);
    if (current.identity.key !== assessment.identity.key) {
      return assessmentFromInspection(current, assessment.storeFile, "workspace-identity-changed");
    }
    if (current.executionHash !== assessment.executionHash) {
      return assessmentFromInspection(current, assessment.storeFile, "execution-config-changed");
    }
    return {
      ...assessment,
      identity: current.identity,
      executionHash: current.executionHash,
      executionSources: current.executionSources,
      assessedAt: new Date().toISOString(),
    };
  } catch (error) {
    return failedAssessment(assessment.storeFile, error);
  }
}

export class WorkspaceTrustStore {
  readonly file: string;
  private readonly now: () => Date;

  constructor(options: WorkspaceTrustStoreOptions = {}) {
    this.file = path.resolve(
      options.file ??
        defaultWorkspaceTrustFile(options.home ?? os.homedir(), options.env ?? process.env),
    );
    this.now = options.now ?? (() => new Date());
  }

  /** Query current trust. Any filesystem/store anomaly is represented as fail-closed untrusted. */
  async assess(cwd: string): Promise<WorkspaceTrustAssessment> {
    try {
      const inspection = await inspectWorkspaceExecution(cwd);
      const document = await this.readDocument();
      const exact = document.workspaces.find(
        (record) => record.identity.key === inspection.identity.key,
      );
      if (exact?.executionHash === inspection.executionHash) {
        return assessmentFromInspection(inspection, this.file, "trusted", this.now());
      }
      if (exact) {
        return assessmentFromInspection(
          inspection,
          this.file,
          "execution-config-changed",
          this.now(),
        );
      }
      if (
        document.workspaces.some(
          (record) => record.identity.canonicalRoot === inspection.identity.canonicalRoot,
        )
      ) {
        return assessmentFromInspection(
          inspection,
          this.file,
          "workspace-identity-changed",
          this.now(),
        );
      }
      return assessmentFromInspection(inspection, this.file, "not-trusted", this.now());
    } catch (error) {
      return failedAssessment(this.file, error, this.now());
    }
  }

  /** Persist a grant for the exact current execution surface. */
  async grant(
    cwd: string,
    expected?: WorkspaceTrustGrantExpectation,
  ): Promise<WorkspaceTrustAssessment> {
    const inspection = await inspectWorkspaceExecution(cwd);
    if (
      expected &&
      (expected.identityKey !== inspection.identity.key ||
        expected.executionHash !== inspection.executionHash)
    ) {
      throw new WorkspaceTrustError(
        "Workspace execution surface changed while awaiting trust confirmation; inspect it again",
      );
    }
    const trustedAt = this.now().toISOString();
    await this.withLock(async () => {
      const document = await this.readDocument();
      document.workspaces = document.workspaces.filter(
        (record) =>
          record.identity.key !== inspection.identity.key &&
          record.identity.canonicalRoot !== inspection.identity.canonicalRoot,
      );
      document.workspaces.push({
        identity: inspection.identity,
        executionHash: inspection.executionHash,
        trustedAt,
      });
      document.workspaces.sort((a, b) =>
        a.identity.canonicalRoot.localeCompare(b.identity.canonicalRoot),
      );
      await this.writeDocument(document);
    });
    return assessmentFromInspection(inspection, this.file, "trusted", this.now());
  }

  /** Revoke the current path, including stale identities previously trusted at that path. */
  async revoke(cwd: string): Promise<boolean> {
    const canonicalRoot = await fs.realpath(path.resolve(cwd));
    return this.withLock(async () => {
      const document = await this.readDocument();
      const before = document.workspaces.length;
      document.workspaces = document.workspaces.filter(
        (record) => record.identity.canonicalRoot !== canonicalRoot,
      );
      if (document.workspaces.length === before) return false;
      await this.writeDocument(document);
      return true;
    });
  }

  private async readDocument(): Promise<TrustDocument> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: TRUST_DOCUMENT_VERSION, workspaces: [] };
      }
      throw new WorkspaceTrustError("Cannot inspect workspace trust store", { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new WorkspaceTrustError("Workspace trust store must be a regular file, not a symlink");
    }
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new WorkspaceTrustError("Workspace trust store is owned by another user");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new WorkspaceTrustError("Workspace trust store permissions must be 0600");
    }
    if (stat.size > MAX_TRUST_FILE_BYTES) {
      throw new WorkspaceTrustError("Workspace trust store exceeds its size limit");
    }
    let parsed: unknown;
    try {
      // Read through the already-open descriptor and verify that it is the exact file inspected
      // above. This prevents a same-user helper process from swapping in a symlink between lstat
      // and readFile while the CLI is making a trust decision.
      const readFlags =
        process.platform === "win32"
          ? fsConstants.O_RDONLY
          : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
      const handle = await fs.open(this.file, readFlags);
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== stat.dev ||
          opened.ino !== stat.ino ||
          opened.size !== stat.size
        ) {
          throw new WorkspaceTrustError("Workspace trust store changed during inspection");
        }
        if (opened.size > MAX_TRUST_FILE_BYTES) {
          throw new WorkspaceTrustError("Workspace trust store exceeds its size limit");
        }
        const raw = (
          await readHandleBounded(
            handle,
            MAX_TRUST_FILE_BYTES,
            "Workspace trust store exceeds its size limit",
          )
        ).toString("utf8");
        const after = await handle.stat();
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs
        ) {
          throw new WorkspaceTrustError("Workspace trust store changed while being read");
        }
        parsed = JSON.parse(raw);
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (error instanceof WorkspaceTrustError) throw error;
      throw new WorkspaceTrustError("Workspace trust store is not valid JSON", { cause: error });
    }
    if (!isTrustDocument(parsed)) {
      throw new WorkspaceTrustError("Workspace trust store has an unsupported or invalid schema");
    }
    return structuredClone(parsed);
  }

  private async writeDocument(document: TrustDocument): Promise<void> {
    const directory = path.dirname(this.file);
    await ensurePrivateDirectory(directory);
    const temporary = path.join(directory, `.workspaces-${process.pid}-${randomUUID()}.tmp`);
    try {
      const handle = await fs.open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, this.file);
      if (process.platform !== "win32") await fs.chmod(this.file, 0o600);
      await syncDirectory(directory);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    const directory = path.dirname(this.file);
    await ensurePrivateDirectory(directory);
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + TRUST_LOCK_TIMEOUT_MS;
    const owner: TrustLockOwner = { pid: process.pid, token: randomUUID() };
    let handle: import("node:fs/promises").FileHandle | undefined;
    for (;;) {
      try {
        handle = await openExclusiveLockFile(lock, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = await readTrustLockOwner(lock);
        if (current.owner) {
          if (!isTrustLockOwnerAlive(current.owner.pid)) {
            await removeTrustLockIfOwned(lock, current.owner.token);
          }
        } else if (
          current.mtimeMs !== undefined &&
          Date.now() - current.mtimeMs > INVALID_TRUST_LOCK_STALE_MS
        ) {
          await removeInvalidTrustLockIfUnchanged(lock, current.mtimeMs);
        }
        if (Date.now() >= deadline) {
          throw new WorkspaceTrustError("Timed out acquiring workspace trust store lock", {
            cause: error,
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      try {
        await handle.writeFile(JSON.stringify(owner), "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(lock, { force: true }).catch(() => {});
        throw error;
      }
      break;
    }
    try {
      return await work();
    } finally {
      await handle!.close();
      await removeTrustLockIfOwned(lock, owner.token);
    }
  }
}

async function inspectWorkspaceExecution(cwd: string): Promise<ExecutionInspection> {
  const identity = await canonicalWorkspaceIdentity(cwd);
  const hash = createHash("sha256");
  const sources: string[] = [];
  let files = 0;
  let bytes = 0;
  let directoryEntries = 0;
  addHashField(hash, "fingerprint-version", String(FINGERPRINT_VERSION));
  addHashField(hash, "workspace-key", identity.key);

  const accountFile = (content: Buffer, label: string): void => {
    files++;
    bytes += content.byteLength;
    if (files > MAX_EXTENSION_FILES || bytes > MAX_EXTENSION_BYTES) {
      throw new WorkspaceTrustError(
        `Workspace execution surface exceeds ${MAX_EXTENSION_FILES} files or ${MAX_EXTENSION_BYTES} bytes: ${label}`,
      );
    }
  };

  for (const relative of PROJECT_CONFIG_FILES) {
    const file = path.join(identity.canonicalRoot, relative);
    const opened = await readOptionalStableRegularFile(file, relative, MAX_CONFIG_BYTES);
    if (!opened) {
      addHashField(hash, `config:${portable(relative)}`, "missing");
      continue;
    }
    accountFile(opened.content, relative);
    const execution = executionProjectionBytes(opened.content);
    addHashField(hash, `config:${portable(relative)}`, execution);
    sources.push(relative);
  }

  for (const relative of PROJECT_ENV_FILES) {
    const file = path.join(identity.canonicalRoot, relative);
    const opened = await readOptionalStableRegularFile(file, relative, MAX_CONFIG_BYTES);
    if (!opened) {
      addHashField(hash, `env:${portable(relative)}`, "missing");
      continue;
    }
    accountFile(opened.content, relative);
    addHashField(hash, `env:${portable(relative)}`, opened.content);
    sources.push(relative);
  }

  const rootGitMarker = path.join(identity.canonicalRoot, ".git");
  const rootGitStat = await safeLstat(rootGitMarker, ".git");
  if (rootGitStat?.isSymbolicLink()) {
    throw new WorkspaceTrustError("Workspace .git marker may not be a symlink");
  }
  if (rootGitStat && !rootGitStat.isDirectory() && !rootGitStat.isFile()) {
    throw new WorkspaceTrustError("Workspace .git marker must be a directory or regular file");
  }
  if (rootGitStat?.isFile()) {
    const opened = await readOptionalStableRegularFile(rootGitMarker, ".git", 4096);
    if (!opened) throw new WorkspaceTrustError("Workspace .git marker changed during inspection");
    accountFile(opened.content, ".git");
    addHashField(hash, "git-execution:.git", opened.content);
    sources.push(".git");
  } else {
    addHashField(hash, "git-execution:.git", rootGitStat ? "directory" : "missing");
  }
  for (const relative of PROJECT_GIT_EXECUTION_FILES) {
    if (relative.startsWith(`.git${path.sep}`) && !rootGitStat?.isDirectory()) {
      addHashField(hash, `git-execution:${portable(relative)}`, "unavailable");
      continue;
    }
    const opened = await readOptionalStableRegularFile(
      path.join(identity.canonicalRoot, relative),
      relative,
      MAX_CONFIG_BYTES,
    );
    if (!opened) {
      addHashField(hash, `git-execution:${portable(relative)}`, "missing");
      continue;
    }
    accountFile(opened.content, relative);
    addHashField(hash, `git-execution:${portable(relative)}`, opened.content);
    sources.push(relative);
  }

  // Agent project memory walks from cwd towards the filesystem root and stops at the first .git
  // marker. Fingerprint the same search surface (including missing boundary markers), otherwise an
  // AGENTS.md edit after a grant could silently replace the system instructions.
  let memoryDirectory = identity.canonicalRoot;
  while (true) {
    for (const name of PROJECT_MEMORY_FILES) {
      const file = path.join(memoryDirectory, name);
      const label = portable(path.relative(identity.canonicalRoot, file) || name);
      const opened = await readOptionalStableRegularFile(file, label, MAX_CONFIG_BYTES);
      if (!opened) {
        addHashField(hash, `memory:${label}`, "missing");
        continue;
      }
      accountFile(opened.content, label);
      addHashField(hash, `memory:${label}`, opened.content);
      sources.push(label);
    }

    const gitMarker = path.join(memoryDirectory, ".git");
    const gitLabel = portable(path.relative(identity.canonicalRoot, gitMarker) || ".git");
    const gitStat = await safeLstat(gitMarker, gitLabel);
    addHashField(hash, `memory-boundary:${gitLabel}`, gitStat ? "present" : "missing");
    const parent = path.dirname(memoryDirectory);
    if (gitStat || parent === memoryDirectory) break;
    memoryDirectory = parent;
  }

  const executionRoots = rootGitStat?.isDirectory()
    ? [...PROJECT_EXECUTION_ROOTS, path.join(".git", "hooks")]
    : [...PROJECT_EXECUTION_ROOTS];
  for (const relativeRoot of executionRoots) {
    const absoluteRoot = path.join(identity.canonicalRoot, relativeRoot);
    const walk = async (
      directory: string,
      relativeDirectory: string,
      root: boolean,
    ): Promise<boolean> =>
      withOptionalStableDirectory(
        directory,
        relativeDirectory,
        MAX_EXTENSION_FILES - directoryEntries,
        async (entries, directoryStat) => {
          if (root) {
            addHashField(hash, `tree:${portable(relativeDirectory)}`, "present");
          } else {
            addHashField(
              hash,
              `dir:${portable(relativeDirectory)}`,
              String(Number(directoryStat.mode & 0o777n)),
            );
          }
          for (const name of entries) {
            directoryEntries++;
            if (directoryEntries > MAX_EXTENSION_FILES) {
              throw new WorkspaceTrustError(
                `Workspace execution surface exceeds ${MAX_EXTENSION_FILES} directory entries`,
              );
            }
            const absolute = path.join(directory, name);
            const relative = path.join(relativeDirectory, name);
            const stat = await safeLstat(absolute, relative);
            if (!stat) {
              throw new WorkspaceTrustError(
                `Workspace execution tree changed during inspection: ${relative}`,
              );
            }
            if (stat.isSymbolicLink()) {
              throw new WorkspaceTrustError(
                `Workspace execution tree contains symlink: ${relative}`,
              );
            }
            if (stat.isDirectory()) {
              if (!(await walk(absolute, relative, false))) {
                throw new WorkspaceTrustError(
                  `Workspace execution tree changed during inspection: ${relative}`,
                );
              }
              continue;
            }
            if (!stat.isFile()) {
              throw new WorkspaceTrustError(
                `Workspace execution source must be a regular file: ${relative}`,
              );
            }
            if (files >= MAX_EXTENSION_FILES || bytes >= MAX_EXTENSION_BYTES) {
              throw new WorkspaceTrustError(
                `Workspace execution surface exceeds ${MAX_EXTENSION_FILES} files or ${MAX_EXTENSION_BYTES} bytes`,
              );
            }
            const opened = await readOptionalStableRegularFile(
              absolute,
              relative,
              MAX_EXTENSION_BYTES - bytes,
            );
            if (!opened) {
              throw new WorkspaceTrustError(
                `Workspace execution tree changed during inspection: ${relative}`,
              );
            }
            accountFile(opened.content, relative);
            addHashField(
              hash,
              `file:${portable(relative)}:${Number(opened.stat.mode & 0o777n)}`,
              opened.content,
            );
          }
        },
      );

    const exists = await walk(absoluteRoot, relativeRoot, true);
    if (!exists) {
      addHashField(hash, `tree:${portable(relativeRoot)}`, "missing");
      continue;
    }
    sources.push(relativeRoot);
  }

  return {
    identity,
    executionHash: hash.digest("hex"),
    executionSources: sources.map(portable).sort(),
  };
}

async function safeLstat(
  file: string,
  label: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WorkspaceTrustError(`Cannot inspect workspace execution source: ${label}`, {
      cause: error,
    });
  }
}

interface StableRegularFile {
  content: Buffer;
  stat: BigIntStats;
}

async function readOptionalStableRegularFile(
  file: string,
  label: string,
  maxBytes: number,
): Promise<StableRegularFile | undefined> {
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(file, secureOpenFlags("file"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw secureInspectionError(`Cannot securely open workspace execution source: ${label}`, error);
  }
  try {
    await inspectionTestHooks?.afterFileOpen?.(file);
    const before = await handle.stat({ bigint: true });
    const pathBefore = await securePathStat(file, label);
    assertStablePathType(before, pathBefore, "file", label);
    if (before.size > BigInt(maxBytes)) {
      throw new WorkspaceTrustError(
        `Workspace execution source exceeds ${maxBytes} bytes: ${label}`,
      );
    }
    const content = await readHandleBounded(
      handle,
      maxBytes,
      `Workspace execution source exceeds ${maxBytes} bytes: ${label}`,
    );
    const after = await handle.stat({ bigint: true });
    const pathAfter = await securePathStat(file, label);
    assertStablePathType(after, pathAfter, "file", label);
    if (!sameStableMetadata(before, after) || !sameStableMetadata(before, pathAfter)) {
      throw new WorkspaceTrustError(
        `Workspace execution source changed during inspection: ${label}`,
      );
    }
    return { content, stat: before };
  } finally {
    await handle.close();
  }
}

async function withOptionalStableDirectory(
  directory: string,
  label: string,
  maxEntries: number,
  visit: (entries: string[], stat: BigIntStats) => Promise<void>,
): Promise<boolean> {
  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(directory, secureOpenFlags("directory"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw secureInspectionError(
      `Cannot securely open workspace execution directory: ${label}`,
      error,
    );
  }
  try {
    const before = await handle.stat({ bigint: true });
    const pathBefore = await securePathStat(directory, label);
    assertStablePathType(before, pathBefore, "directory", label);
    await inspectionTestHooks?.beforeDirectoryEnumeration?.(directory);
    const entries: string[] = [];
    let opened: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    try {
      opened = await fs.opendir(directory);
      for await (const entry of opened) {
        entries.push(entry.name);
        if (entries.length > maxEntries) {
          throw new WorkspaceTrustError(
            `Workspace execution surface exceeds ${MAX_EXTENSION_FILES} directory entries`,
          );
        }
      }
    } catch (error) {
      if (error instanceof WorkspaceTrustError) throw error;
      throw secureInspectionError(
        `Cannot securely enumerate workspace execution directory: ${label}`,
        error,
      );
    } finally {
      await opened?.close().catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ERR_DIR_CLOSED") throw error;
      });
    }
    entries.sort();
    // Validate the pinned directory before consuming any names. If the path was swapped while
    // opendir/readdir ran, do not resolve a child through the attacker-controlled replacement.
    await assertDirectoryStillStable(handle, directory, label, before);
    await visit(entries, before);
    await assertDirectoryStillStable(handle, directory, label, before);
    return true;
  } finally {
    await handle.close();
  }
}

async function assertDirectoryStillStable(
  handle: import("node:fs/promises").FileHandle,
  directory: string,
  label: string,
  before: BigIntStats,
): Promise<void> {
  const after = await handle.stat({ bigint: true });
  const pathAfter = await securePathStat(directory, label);
  assertStablePathType(after, pathAfter, "directory", label);
  if (!sameStableMetadata(before, after) || !sameStableMetadata(before, pathAfter)) {
    throw new WorkspaceTrustError(
      `Workspace execution directory changed during inspection: ${label}`,
    );
  }
}

function secureOpenFlags(kind: "file" | "directory"): number {
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NONBLOCK === "number") flags |= fsConstants.O_NONBLOCK;
  // O_NOFOLLOW is effective on POSIX. On platforms that expose it as zero/undefined, the path
  // lstat-to-fstat identity checks below provide the compatible fail-closed fallback.
  if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  if (kind === "directory" && typeof fsConstants.O_DIRECTORY === "number") {
    flags |= fsConstants.O_DIRECTORY;
  }
  return flags;
}

async function securePathStat(file: string, label: string): Promise<BigIntStats> {
  try {
    return await fs.lstat(file, { bigint: true });
  } catch (error) {
    throw secureInspectionError(`Cannot verify workspace execution source: ${label}`, error);
  }
}

function assertStablePathType(
  opened: BigIntStats,
  pathStat: BigIntStats,
  kind: "file" | "directory",
  label: string,
): void {
  const correctType = kind === "file" ? opened.isFile() : opened.isDirectory();
  const correctPathType = kind === "file" ? pathStat.isFile() : pathStat.isDirectory();
  if (
    !correctType ||
    !correctPathType ||
    pathStat.isSymbolicLink() ||
    opened.dev !== pathStat.dev ||
    opened.ino !== pathStat.ino
  ) {
    throw new WorkspaceTrustError(
      `Workspace execution source must be a stable real ${kind}: ${label}`,
    );
  }
}

function sameStableMetadata(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

async function readHandleBounded(
  handle: import("node:fs/promises").FileHandle,
  maxBytes: number,
  exceedsMessage: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, total);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) {
    throw new WorkspaceTrustError(exceedsMessage);
  }
  return Buffer.concat(chunks, total);
}

function secureInspectionError(message: string, cause: unknown): WorkspaceTrustError {
  return cause instanceof WorkspaceTrustError ? cause : new WorkspaceTrustError(message, { cause });
}

function executionProjectionBytes(raw: Buffer): Buffer {
  try {
    const parsed = JSON.parse(raw.toString("utf8")) as unknown;
    return Buffer.from(stableJson(workspaceExecutionConfig(parsed)), "utf8");
  } catch {
    // Invalid configuration is not executed, but changing/fixing it must invalidate an old grant.
    return Buffer.from(`invalid-json:${createHash("sha256").update(raw).digest("hex")}`, "utf8");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function addHashField(
  hash: ReturnType<typeof createHash>,
  label: string,
  value: string | Buffer,
): void {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(`${Buffer.byteLength(label, "utf8")}:`);
  hash.update(label);
  hash.update(`${bytes.byteLength}:`);
  hash.update(bytes);
}

function portable(value: string): string {
  return value.split(path.sep).join("/");
}

function assessmentFromInspection(
  inspection: ExecutionInspection,
  storeFile: string,
  reason: Exclude<WorkspaceTrustReason, "inspection-failed">,
  now = new Date(),
): WorkspaceTrustAssessment {
  return {
    trusted: reason === "trusted",
    reason,
    identity: inspection.identity,
    executionHash: inspection.executionHash,
    executionSources: [...inspection.executionSources],
    storeFile,
    assessedAt: now.toISOString(),
  };
}

function failedAssessment(
  storeFile: string,
  error: unknown,
  now = new Date(),
): WorkspaceTrustAssessment {
  return {
    trusted: false,
    reason: "inspection-failed",
    executionSources: [],
    storeFile,
    assessedAt: now.toISOString(),
    error: error instanceof Error ? error.message : String(error),
  };
}

function isTrustDocument(value: unknown): value is TrustDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as { version?: unknown; workspaces?: unknown };
  if (document.version !== TRUST_DOCUMENT_VERSION || !Array.isArray(document.workspaces))
    return false;
  return document.workspaces.every((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const record = candidate as Partial<TrustRecord>;
    const identity = record.identity;
    return (
      Boolean(identity) &&
      typeof identity?.canonicalRoot === "string" &&
      path.isAbsolute(identity.canonicalRoot) &&
      typeof identity.device === "string" &&
      typeof identity.inode === "string" &&
      /^[a-f0-9]{64}$/.test(identity.key) &&
      typeof record.executionHash === "string" &&
      /^[a-f0-9]{64}$/.test(record.executionHash) &&
      typeof record.trustedAt === "string" &&
      Number.isFinite(Date.parse(record.trustedAt))
    );
  });
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new WorkspaceTrustError("Workspace trust directory must be a real directory");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new WorkspaceTrustError("Workspace trust directory is owned by another user");
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readTrustLockOwner(
  lock: string,
): Promise<{ owner?: TrustLockOwner; mtimeMs?: number }> {
  const stat = await fs.stat(lock).catch(() => undefined);
  if (!stat) return {};
  try {
    const value = JSON.parse(await fs.readFile(lock, "utf8")) as Record<string, unknown>;
    if (
      Number.isSafeInteger(value["pid"]) &&
      (value["pid"] as number) > 0 &&
      typeof value["token"] === "string" &&
      value["token"].length >= 16
    ) {
      return {
        owner: { pid: value["pid"] as number, token: value["token"] },
        mtimeMs: stat.mtimeMs,
      };
    }
  } catch {
    // An exclusive creator may still be writing the owner record.
  }
  return { mtimeMs: stat.mtimeMs };
}

function isTrustLockOwnerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeTrustLockIfOwned(lock: string, token: string): Promise<void> {
  const current = await readTrustLockOwner(lock);
  if (current.owner?.token === token) await fs.rm(lock, { force: true });
}

async function removeInvalidTrustLockIfUnchanged(lock: string, mtimeMs: number): Promise<void> {
  const current = await readTrustLockOwner(lock);
  if (!current.owner && current.mtimeMs === mtimeMs) await fs.rm(lock, { force: true });
}
