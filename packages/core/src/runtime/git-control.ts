/** Hardened control-plane Git invocation.
 *
 * Repository content and configuration are attacker controlled. Automatic Git calls must never
 * resolve an executable through PATH or inherit user/system configuration, hooks, pagers,
 * external diff helpers, credential prompts, or fsmonitor processes.
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizedShellEnv } from "../tools/shell-spawn.js";

const UNIX_GIT_CANDIDATES = ["/usr/bin/git", "/bin/git"] as const;
const WINDOWS_GIT_ROOTS = ["C:\\Program Files", "C:\\Program Files (x86)"] as const;
let cachedGit: Promise<string> | undefined;

/** Resolve a fixed, administrator-owned Git executable. PATH is deliberately never consulted. */
export function trustedGitExecutable(): Promise<string> {
  cachedGit ??= resolveTrustedGitExecutable();
  return cachedGit;
}

async function resolveTrustedGitExecutable(): Promise<string> {
  const candidates =
    process.platform === "win32" ? windowsGitCandidates() : [...UNIX_GIT_CANDIDATES];
  for (const candidate of candidates) {
    try {
      const real = await fs.realpath(candidate);
      const stat = await fs.stat(real);
      if (!stat.isFile()) continue;
      if (process.platform !== "win32" && (stat.uid !== 0 || (stat.mode & 0o022) !== 0)) continue;
      if (!isInTrustedInstallRoot(real)) continue;
      return real;
    } catch {
      // Try the next fixed install location.
    }
  }
  throw new Error("No trusted system Git executable is available");
}

function windowsGitCandidates(): string[] {
  return WINDOWS_GIT_ROOTS.map((root) => path.join(root, "Git", "cmd", "git.exe"));
}

function isInTrustedInstallRoot(candidate: string): boolean {
  if (process.platform === "win32") {
    const roots = WINDOWS_GIT_ROOTS.map((value) => path.resolve(value).toLowerCase());
    const lower = path.resolve(candidate).toLowerCase();
    return roots.some((root) => lower === root || lower.startsWith(`${root}${path.sep}`));
  }
  return ["/usr/bin", "/bin"].some((root) => {
    const relative = path.relative(root, candidate);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

/** Arguments which make every automatic invocation non-interactive and disable executable config. */
export function hardenedGitArguments(args: readonly string[], workTree?: string): string[] {
  return [
    "--no-pager",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.untrackedCache=false",
    "-c",
    "core.bare=false",
    ...(workTree ? ["-c", `core.worktree=${path.resolve(workTree)}`] : []),
    "-c",
    "core.pager=cat",
    "-c",
    "pager.status=false",
    "-c",
    "log.showSignature=false",
    "-c",
    "diff.external=",
    ...args,
  ];
}

/** Environment paired with hardenedGitArguments. Extra values are narrow plumbing variables. */
export function hardenedGitEnvironment(
  extra: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...sanitizedShellEnv(source),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: nullDevice(),
    GIT_CONFIG_GLOBAL: nullDevice(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: nullDevice(),
    GIT_PAGER: "cat",
    GIT_EXTERNAL_DIFF: "",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_OPTIONAL_LOCKS: "0",
    ...extra,
  };
}

export function nullDevice(): string {
  return process.platform === "win32" ? "NUL" : "/dev/null";
}

export interface ValidatedGitRepository {
  workTree: string;
  gitDir: string;
  commonDir: string;
  objectDir: string;
  linkedWorktree: boolean;
}

/**
 * Validate repository control paths without asking Git to follow an attacker-provided gitdir.
 * A linked-worktree pointer is accepted only when Git's private backlink points to this exact
 * .git file. This rejects a project which merely points `.git` at an unrelated outside repo.
 */
export async function validateGitRepository(cwdValue: string): Promise<ValidatedGitRepository> {
  const workTree = await fs.realpath(path.resolve(cwdValue));
  const marker = path.join(workTree, ".git");
  const markerStat = await fs.lstat(marker);
  if (markerStat.isSymbolicLink()) throw new Error("Git control marker may not be a symlink");

  let gitDir: string;
  let linkedWorktree = false;
  if (markerStat.isDirectory()) {
    gitDir = await fs.realpath(marker);
    if (!isWithin(workTree, gitDir)) throw new Error("Git directory escapes the workspace");
  } else if (markerStat.isFile() && markerStat.size <= 4096) {
    linkedWorktree = true;
    const pointer = (await fs.readFile(marker, "utf8")).trim();
    const match = /^gitdir:\s*(.+)$/i.exec(pointer);
    if (!match?.[1]) throw new Error("Invalid linked-worktree .git marker");
    const lexical = path.resolve(workTree, match[1]);
    gitDir = await fs.realpath(lexical);
    if (gitDir !== lexical) throw new Error("Linked-worktree gitdir may not traverse symlinks");
    const gitDirStat = await fs.lstat(gitDir);
    if (!gitDirStat.isDirectory() || gitDirStat.isSymbolicLink()) {
      throw new Error("Invalid linked-worktree gitdir");
    }
    const backlinkFile = path.join(gitDir, "gitdir");
    const backlinkStat = await fs.lstat(backlinkFile);
    if (!backlinkStat.isFile() || backlinkStat.isSymbolicLink() || backlinkStat.size > 4096) {
      throw new Error("Invalid linked-worktree backlink");
    }
    const backlinkText = (await fs.readFile(backlinkFile, "utf8")).trim();
    const backlink = path.resolve(gitDir, backlinkText);
    const [markerReal, backlinkReal] = await Promise.all([
      fs.realpath(marker),
      fs.realpath(backlink),
    ]);
    if (markerReal !== backlinkReal) throw new Error("Linked-worktree backlink mismatch");
  } else {
    throw new Error("Workspace .git marker is not a directory or bounded regular file");
  }

  const commonFile = path.join(gitDir, "commondir");
  let commonDir = gitDir;
  try {
    const stat = await fs.lstat(commonFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
      throw new Error("Invalid Git commondir marker");
    }
    const relative = (await fs.readFile(commonFile, "utf8")).trim();
    const lexical = path.resolve(gitDir, relative);
    commonDir = await fs.realpath(lexical);
    if (commonDir !== lexical) throw new Error("Git commondir may not traverse symlinks");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const commonStat = await fs.lstat(commonDir);
  if (!commonStat.isDirectory() || commonStat.isSymbolicLink()) {
    throw new Error("Invalid Git common directory");
  }
  const objectPath = path.join(commonDir, "objects");
  const objectPathStat = await fs.lstat(objectPath);
  if (!objectPathStat.isDirectory() || objectPathStat.isSymbolicLink()) {
    throw new Error("Invalid Git object directory");
  }
  const objectDir = await fs.realpath(objectPath);
  return { workTree, gitDir, commonDir, objectDir, linkedWorktree };
}

export interface IsolatedGitPlumbing {
  repository: ValidatedGitRepository;
  gitDir: string;
  indexFile: string;
  environment: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}

/**
 * Create a config-free Git control directory sharing only the repository object database.
 * add/checkout-index therefore cannot see repository filter drivers, hooks, fsmonitor or aliases.
 */
export async function createIsolatedGitPlumbing(
  cwd: string,
  indexFile?: string,
): Promise<IsolatedGitPlumbing> {
  const repository = await validateGitRepository(cwd);
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-git-control-"));
  const gitDir = path.join(temporaryRoot, "git");
  await fs.mkdir(gitDir, { mode: 0o700 });
  await fs.mkdir(path.join(gitDir, "refs", "heads"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/anicode-control\n", {
    mode: 0o600,
  });
  const resolvedIndex = indexFile ?? path.join(temporaryRoot, "index");
  const environment = hardenedGitEnvironment({
    GIT_DIR: gitDir,
    GIT_WORK_TREE: repository.workTree,
    GIT_OBJECT_DIRECTORY: repository.objectDir,
    GIT_INDEX_FILE: resolvedIndex,
    GIT_AUTHOR_NAME: "anicode",
    GIT_AUTHOR_EMAIL: "anicode@localhost.invalid",
    GIT_COMMITTER_NAME: "anicode",
    GIT_COMMITTER_EMAIL: "anicode@localhost.invalid",
  });
  return {
    repository,
    gitDir,
    indexFile: resolvedIndex,
    environment,
    cleanup: () => fs.rm(temporaryRoot, { recursive: true, force: true }),
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
