import * as os from "node:os";
import * as path from "node:path";

export interface DaemonSocketPathOptions {
  platform?: NodeJS.Platform;
  tmpdir?: string;
  xdgRuntimeDir?: string;
  uid?: number;
  username?: string;
}

function safeUserSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96);
  return safe || "user";
}

function currentUsername(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "user";
  }
}

/** Windows IPC uses named pipes; filesystem socket hardening does not apply to these paths. */
export function isWindowsNamedPipePath(socketPath: string): boolean {
  return /^\\\\\.\\pipe\\/i.test(socketPath);
}

/**
 * Return a per-user daemon endpoint.
 *
 * A shared /tmp/anicode.sock lets another local account race or impersonate the daemon. Prefer the
 * user's XDG runtime directory and otherwise create a UID-scoped directory under the OS temp root.
 */
export function defaultDaemonSocketPath(options: DaemonSocketPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const username = safeUserSegment(options.username ?? currentUsername());
  if (platform === "win32") return `\\\\.\\pipe\\anicode-${username}`;

  const uid = options.uid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
  const configuredRuntimeDir = options.xdgRuntimeDir ?? process.env.XDG_RUNTIME_DIR?.trim();
  // XDG_RUNTIME_DIR must be absolute. Ignore malformed inherited values instead of placing the
  // endpoint relative to whichever cwd happened to launch the process.
  const runtimeDir =
    configuredRuntimeDir && path.isAbsolute(configuredRuntimeDir)
      ? configuredRuntimeDir
      : undefined;
  const parent = runtimeDir
    ? path.join(runtimeDir, "anicode")
    : path.join(options.tmpdir ?? os.tmpdir(), `anicode-${uid ?? username}`);
  return path.join(parent, "anicode.sock");
}
