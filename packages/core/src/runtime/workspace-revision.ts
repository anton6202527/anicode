/** Revision evidence for deterministic verification. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import { terminateProcessTree } from "./isolated-runtime.js";
import {
  hardenedGitArguments,
  hardenedGitEnvironment,
  trustedGitExecutable,
  validateGitRepository,
} from "./git-control.js";

const MAX_EVIDENCE_FILES = 200_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const GIT_DEADLINE_MS = 15_000;

/**
 * Hash every tracked and non-ignored untracked path plus paths explicitly reported by the tool
 * layer. Thus tracked build outputs remain evidence, while dependency/cache trees ignored by Git
 * do not make every verification O(node_modules). Non-Git workspaces fail over to a bounded walk.
 */
export async function workspaceRevisionDigest(
  rootValue: string,
  changedFiles: readonly string[] = [],
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const root = await canonical(rootValue);
  signal?.throwIfAborted();
  const gitPaths = await listGitEvidencePaths(root, signal);
  const paths = new Set<string>(gitPaths ?? (await walkFallback(root, signal)));
  for (const value of changedFiles) paths.add(normalizeRelative(root, value));

  const hash = createHash("sha256");
  let files = 0;
  for (const relative of [...paths].sort()) {
    signal?.throwIfAborted();
    files = await hashPath(root, relative, hash, files, signal);
    if (files > MAX_EVIDENCE_FILES) {
      throw new Error(`Workspace revision exceeds ${MAX_EVIDENCE_FILES} files`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

async function hashPath(
  root: string,
  relative: string,
  hash: ReturnType<typeof createHash>,
  files: number,
  signal?: AbortSignal,
): Promise<number> {
  signal?.throwIfAborted();
  const absolute = path.join(root, relative);
  let stat;
  try {
    stat = await fs.lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      hash.update(relative).update("\0missing\0");
      return files + 1;
    }
    throw error;
  }
  hash
    .update(relative)
    .update("\0")
    .update(String(stat.mode & 0o777))
    .update("\0");
  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(absolute);
    const resolved = path.resolve(path.dirname(absolute), target);
    if (!isWithin(root, resolved)) {
      throw new Error(`Workspace evidence symlink escapes the workspace: ${relative}`);
    }
    hash.update("l\0").update(target).update("\0");
    return files + 1;
  }
  if (stat.isDirectory()) {
    hash.update("d\0");
    for (const name of (await fs.readdir(absolute)).sort()) {
      if (name === ".git" || name === ".anicode" || name === "node_modules") continue;
      files = await hashPath(root, path.join(relative, name), hash, files, signal);
      if (files > MAX_EVIDENCE_FILES) return files;
    }
    return files;
  }
  if (!stat.isFile()) {
    hash.update("other\0");
    return files + 1;
  }
  hash.update("f\0").update(String(stat.size)).update("\0");
  for await (const chunk of createReadStream(absolute)) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  hash.update("\0");
  return files + 1;
}

async function walkFallback(root: string, signal?: AbortSignal): Promise<string[]> {
  const output: string[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const name of (await fs.readdir(directory)).sort()) {
      signal?.throwIfAborted();
      if (name === ".git" || name === ".anicode" || name === "node_modules") continue;
      const relative = path.join(relativeDirectory, name);
      const stat = await fs.lstat(path.join(directory, name));
      if (stat.isDirectory()) await walk(path.join(directory, name), relative);
      else output.push(relative);
      if (output.length > MAX_EVIDENCE_FILES) {
        throw new Error(`Workspace revision exceeds ${MAX_EVIDENCE_FILES} files`);
      }
    }
  };
  await walk(root, "");
  return output;
}

async function listGitEvidencePaths(root: string, signal?: AbortSignal): Promise<string[] | null> {
  const result = await runGit(
    root,
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    signal,
  );
  if (!result) return null;
  return result
    .split("\0")
    .filter(Boolean)
    .map((value) => normalizeRelative(root, value));
}

function runGit(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Workspace revision aborted"));
      return;
    }
    void (async () => {
      await validateGitRepository(cwd);
      const executable = await trustedGitExecutable();
      const child = spawn(executable, hardenedGitArguments(args, cwd), {
        cwd,
        env: hardenedGitEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let boundaryError: Error | undefined;
      let termination: Promise<void> | undefined;
      let settled = false;
      const terminate = (error: Error) => {
        boundaryError ??= error;
        if (child.pid) termination ??= terminateProcessTree(child);
      };
      const timer = setTimeout(
        () => terminate(new Error(`git ${args[0] ?? "command"} timed out`)),
        GIT_DEADLINE_MS,
      );
      const abort = () =>
        terminate(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error(String(signal?.reason ?? "Workspace revision aborted")),
        );
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout?.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_GIT_OUTPUT_BYTES) {
          terminate(new Error(`git evidence output exceeds ${MAX_GIT_OUTPUT_BYTES} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      child.stderr?.resume();
      child.on("error", (error) => {
        boundaryError ??= error;
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        void (async () => {
          if (!termination && process.platform !== "win32") {
            termination = terminateProcessTree(child);
          }
          await termination;
          if (boundaryError) throw boundaryError;
          if (code !== 0) return null;
          return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
        })().then(resolve, reject);
      });
    })().catch(() => resolve(null));
  });
}

async function canonical(value: string): Promise<string> {
  try {
    return await fs.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function normalizeRelative(root: string, value: string): string {
  const candidate = path.isAbsolute(value) ? path.relative(root, value) : path.normalize(value);
  if (!candidate || candidate === ".") return ".";
  if (candidate === ".." || candidate.startsWith(`..${path.sep}`) || path.isAbsolute(candidate)) {
    throw new Error(`Workspace evidence path escapes the workspace: ${value}`);
  }
  return candidate;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
