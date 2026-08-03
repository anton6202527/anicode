/** Secure local daemon bearer-token generation and runtime-file persistence. */

import { constants as fsConstants, promises as fs } from "node:fs";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { defaultDaemonSocketPath, isWindowsNamedPipePath } from "./socket-path.js";

const MAX_DAEMON_AUTH_TOKEN_BYTES = 4 * 1024;
const MIN_DAEMON_AUTH_TOKEN_BYTES = 32;
/** Kept separate from the built-in CLI Proxy provider on 8317. */
export const DEFAULT_HTTP_DAEMON_PORT = 8327;

export interface ProvisionDaemonAuthTokenOptions {
  /** Unix socket used to derive an adjacent runtime token file. */
  socketPath?: string;
  /** Explicit private runtime file; its parent must already be private or be creatable as 0700. */
  tokenFile?: string;
  /** Caller-supplied token. Omit to generate 256 bits of entropy. */
  token?: string;
}

export interface ProvisionedDaemonAuthToken {
  token: string;
  tokenFile: string;
}

/** Generate a URL-safe bearer token without padding (256 bits by default). */
export function generateDaemonAuthToken(bytes = 32): string {
  if (!Number.isSafeInteger(bytes) || bytes < 32) {
    throw new Error("Daemon auth tokens require at least 32 random bytes");
  }
  return randomBytes(bytes).toString("base64url");
}

/**
 * Derive a discoverable token file next to a Unix socket. Named pipes have no parent directory, so
 * Windows receives a per-user temp path keyed by the pipe name instead.
 */
export function defaultDaemonAuthTokenPath(socketPath = defaultDaemonSocketPath()): string {
  if (!isWindowsNamedPipePath(socketPath)) return `${socketPath}.token`;
  const account =
    typeof process.getuid === "function" ? String(process.getuid()) : os.userInfo().username;
  return windowsDaemonAuthTokenPath(socketPath, os.tmpdir(), account);
}

/** @internal Deterministic Windows path derivation, exported for cross-platform security tests. */
export function windowsDaemonAuthTokenPath(
  socketPath: string,
  temporaryDirectory: string,
  account: string,
): string {
  // DOMAIN\\user and localized account names must never become path components themselves.
  const accountKey = createHash("sha256").update(account).digest("hex").slice(0, 16);
  const key = createHash("sha256").update(socketPath).digest("hex").slice(0, 16);
  return path.join(temporaryDirectory, `anicode-${accountKey}`, `daemon-${key}.token`);
}

/** Discoverable private token path shared by `anicode serve` and local HTTP clients. */
export function defaultHttpDaemonAuthTokenPath(port = DEFAULT_HTTP_DAEMON_PORT): string {
  // Port 0 is valid for test/ephemeral listeners. Its token file is discoverable
  // only through serve's startup output because the kernel-selected port differs.
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid HTTP daemon port: ${port}`);
  }
  return defaultDaemonAuthTokenPath(`${defaultDaemonSocketPath()}.http-${port}`);
}

/** Validate caller-supplied daemon credentials at every server/client persistence boundary. */
export function validateDaemonAuthToken(token: string): string {
  if (typeof token !== "string" || token !== token.trim() || /[\u0000-\u001f\u007f]/.test(token)) {
    throw new Error(
      "Daemon auth token must not contain surrounding whitespace or control characters",
    );
  }
  const bytes = Buffer.byteLength(token, "utf8");
  if (bytes < MIN_DAEMON_AUTH_TOKEN_BYTES) {
    throw new Error(`Daemon auth token must contain at least ${MIN_DAEMON_AUTH_TOKEN_BYTES} bytes`);
  }
  if (bytes > MAX_DAEMON_AUTH_TOKEN_BYTES) {
    throw new Error(`Daemon auth token exceeds ${MAX_DAEMON_AUTH_TOKEN_BYTES} bytes`);
  }
  return token;
}

async function ensurePrivateParent(directory: string): Promise<void> {
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Daemon auth token parent is not a real directory: ${directory}`);
  }
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`Daemon auth token parent is not owned by the current user: ${directory}`);
    }
    if (created) await fs.chmod(directory, 0o700);
    else if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `Daemon auth token parent must not be accessible by group or others: ${directory}`,
      );
    }
  }
}

async function validatePrivateFileHandle(
  handle: Awaited<ReturnType<typeof fs.open>>,
  tokenFile: string,
): Promise<void> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new Error(`Daemon auth token path is not a regular file: ${tokenFile}`);
  if (stat.size > MAX_DAEMON_AUTH_TOKEN_BYTES + 1) {
    throw new Error(`Daemon auth token file exceeds ${MAX_DAEMON_AUTH_TOKEN_BYTES} bytes`);
  }
  if (process.platform !== "win32") {
    const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
    if (uid !== undefined && stat.uid !== uid) {
      throw new Error(`Daemon auth token file is not owned by the current user: ${tokenFile}`);
    }
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(`Daemon auth token file permissions must be 0600: ${tokenFile}`);
    }
  }
}

/** Atomically create/replace a private runtime token file and return the token for the server. */
export async function provisionDaemonAuthToken(
  options: ProvisionDaemonAuthTokenOptions = {},
): Promise<ProvisionedDaemonAuthToken> {
  const tokenFile = path.resolve(
    options.tokenFile ??
      defaultDaemonAuthTokenPath(options.socketPath ?? defaultDaemonSocketPath()),
  );
  const token = validateDaemonAuthToken(options.token ?? generateDaemonAuthToken());
  const directory = path.dirname(tokenFile);
  await ensurePrivateParent(directory);

  try {
    const existing = await fs.lstat(tokenFile);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing to replace non-regular daemon auth token path: ${tokenFile}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = path.join(
    directory,
    `.${path.basename(tokenFile)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${token}\n`, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, tokenFile);
    if (process.platform !== "win32") await fs.chmod(tokenFile, 0o600);
    if (process.platform !== "win32") {
      const directoryHandle = await fs.open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return { token, tokenFile };
}

/** Read a private runtime token without following a symlink. */
export async function readDaemonAuthToken(tokenFile: string): Promise<string> {
  const flags =
    process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(tokenFile, flags);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing to follow daemon auth token symlink: ${tokenFile}`, {
        cause: error,
      });
    }
    throw error;
  }
  try {
    await validatePrivateFileHandle(handle, tokenFile);
    const buffer = Buffer.alloc(MAX_DAEMON_AUTH_TOKEN_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    return validateDaemonAuthToken(
      buffer.subarray(0, bytesRead).toString("utf8").replace(/\n$/, ""),
    );
  } finally {
    await handle.close();
  }
}
