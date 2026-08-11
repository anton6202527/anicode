import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";

const WINDOWS_EPERM_RETRY_LIMIT = 20;
const WINDOWS_EPERM_RETRY_DELAY_MS = 10;

export interface ExclusiveLockFileOpenOptions {
  /** @internal Injectable operating system for deterministic portability tests. */
  platform?: NodeJS.Platform;
  /** @internal Injectable exclusive-open operation for deterministic fault tests. */
  open?: (file: string, flags: "wx", mode: number) => Promise<FileHandle>;
  /** @internal Injectable delay for deterministic fault tests. */
  wait?: (milliseconds: number) => Promise<void>;
}

/**
 * Create a lock file exclusively while tolerating the short sharing violation Windows may report
 * as EPERM when another process concurrently closes and unlinks the previous lock inode.
 *
 * The retry is deliberately Windows-only, EPERM-only, and short. A persistent ACL/permission
 * failure is returned unchanged after the bounded retry window; callers continue to handle
 * EEXIST as ordinary lock contention.
 */
export async function openExclusiveLockFile(
  file: string,
  mode: number,
  options: ExclusiveLockFileOpenOptions = {},
): Promise<FileHandle> {
  const platform = options.platform ?? process.platform;
  const open = options.open ?? fs.open;
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let epermRetries = 0;

  for (;;) {
    try {
      return await open(file, "wx", mode);
    } catch (error) {
      if (
        platform !== "win32" ||
        (error as NodeJS.ErrnoException).code !== "EPERM" ||
        epermRetries >= WINDOWS_EPERM_RETRY_LIMIT
      ) {
        throw error;
      }
      epermRetries++;
      await wait(WINDOWS_EPERM_RETRY_DELAY_MS);
    }
  }
}
