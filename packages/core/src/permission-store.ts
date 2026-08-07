/**
 * 项目本地权限清单持久化 —— 对齐 Claude Code 的 .claude/settings.local.json。
 *
 * 文件：<cwd>/.anicode/settings.local.json，形如
 *   { "permissions": { "allow": ["bash(git status)", ...] } }
 *
 * 该文件同时是 loadConfig 的一个配置源（优先级最高），所以这里写入的
 * allow 规则下次会话自动生效。持久化使用跨进程互斥的读-改-写，并在同一目录
 * 内完成 fsync + rename + 目录 fsync；不会修改系统级权限或网络配置。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { performance } from "node:perf_hooks";
import { promises as fs, type BigIntStats } from "node:fs";
import * as path from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_RETRY_MS = 10;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_LOCK_BYTES = 4 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export function localSettingsPath(cwd: string): string {
  return path.join(cwd, ".anicode", "settings.local.json");
}

interface PermissionSection {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  [key: string]: unknown;
}

interface LocalSettings {
  permissions?: PermissionSection;
  [key: string]: unknown;
}

interface PermissionStoreOptions {
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  maxFileBytes?: number;
}

interface PermissionLockOwner {
  version: 1;
  pid: number;
  host: string;
  token: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface PermissionLockLease {
  lock: string;
  owner: PermissionLockOwner;
  identity: FileIdentity;
}

interface LockSnapshot {
  identity?: FileIdentity;
  owner?: PermissionLockOwner;
}

/**
 * 把规则追加进本地设置的 permissions.allow（去重）。
 * 文件不存在则创建；内容损坏或 schema 非法时不覆盖用户文件，直接返回 false。
 */
export async function appendLocalAllowRules(
  cwd: string,
  rules: string[],
  options: PermissionStoreOptions = {},
): Promise<boolean> {
  if (rules.length === 0) return true;
  if (!rules.every((rule) => typeof rule === "string")) return false;

  const file = localSettingsPath(cwd);
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  const lease = await acquirePermissionLock(file, options);
  try {
    const maxFileBytes = positiveInteger(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES);
    const settings = await readSettings(file, maxFileBytes);
    if (!settings) return false;

    const permissions = settings.permissions ?? {};
    const allow = [...(permissions.allow ?? [])];
    const known = new Set(allow);
    for (const rule of rules) {
      if (!known.has(rule)) {
        known.add(rule);
        allow.push(rule);
      }
    }

    if (allow.length === (permissions.allow?.length ?? 0)) {
      return true;
    }

    const next: LocalSettings = {
      ...settings,
      permissions: { ...permissions, allow },
    };
    const serialized = serializeSettings(next, maxFileBytes);
    if (!serialized) return false;
    await writeSettings(file, serialized);
    return true;
  } finally {
    await releasePermissionLock(lease);
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Permission store directory must be a real directory: ${directory}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Permission store directory is owned by another user: ${directory}`);
  }
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
}

async function readSettings(file: string, maxBytes: number): Promise<LocalSettings | undefined> {
  let before: BigIntStats;
  try {
    before = await fs.lstat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) return undefined;
  if (typeof process.getuid === "function" && before.uid !== BigInt(process.getuid())) {
    return undefined;
  }

  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    let opened = await handle.stat({ bigint: true });
    if (
      !sameFile(before, opened) ||
      !opened.isFile() ||
      (typeof process.getuid === "function" && opened.uid !== BigInt(process.getuid()))
    ) {
      return undefined;
    }
    // Tighten an existing file through the verified descriptor, avoiding a path-based chmod race.
    if (process.platform !== "win32" && (opened.mode & 0o777n) !== 0o600n) {
      await handle.chmod(0o600);
      await handle.sync();
      opened = await handle.stat({ bigint: true });
    }
    if (opened.size > BigInt(maxBytes)) return undefined;
    const raw = await readHandleBounded(handle, maxBytes);
    if (!raw) return undefined;
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshot(opened, after)) return undefined;
    return parseSettings(raw.toString("utf8"));
  } finally {
    await handle.close();
  }
}

function parseSettings(text: string): LocalSettings | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const settings = value as LocalSettings;
  if (settings.permissions !== undefined) {
    const permissions = settings.permissions;
    if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
      return undefined;
    }
    for (const key of ["allow", "deny", "ask"] as const) {
      const rules = permissions[key];
      if (
        rules !== undefined &&
        (!Array.isArray(rules) || !rules.every((rule) => typeof rule === "string"))
      ) {
        return undefined;
      }
    }
  }
  return settings;
}

function serializeSettings(settings: LocalSettings, maxBytes: number): string | undefined {
  try {
    const serialized = `${JSON.stringify(settings, null, 2)}\n`;
    return Buffer.byteLength(serialized) <= maxBytes ? serialized : undefined;
  } catch {
    return undefined;
  }
}

async function writeSettings(file: string, serialized: string): Promise<void> {
  const directory = path.dirname(file);
  const temporary = path.join(directory, `.settings.local-${process.pid}-${randomUUID()}.tmp`);
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    if (process.platform !== "win32") await fs.chmod(file, 0o600);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function acquirePermissionLock(
  file: string,
  options: PermissionStoreOptions,
): Promise<PermissionLockLease> {
  const lock = `${file}.lock`;
  const timeoutMs = positiveInteger(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
  const retryMs = positiveInteger(options.lockRetryMs, DEFAULT_LOCK_RETRY_MS);
  const deadline = performance.now() + timeoutMs;
  const owner: PermissionLockOwner = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    token: randomBytes(32).toString("hex"),
  };

  // Publish a fully written lock atomically. Unlike open(lock, "wx") followed by write(),
  // contenders can never mistake a paused live creator's temporarily empty file for stale state.
  const candidate = `${lock}.${process.pid}.${randomUUID()}.candidate`;
  const handle = await fs.open(candidate, "wx", 0o600);
  let published = false;
  try {
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    await handle.close();

    for (;;) {
      try {
        await fs.link(candidate, lock);
        published = true;
        return { lock, owner, identity: identityOf(stat) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await recoverDeadLock(lock);
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          throw new Error(`Permission store lock timeout: ${lock}`, { cause: error });
        }
        await delay(Math.min(retryMs, remaining));
      }
    }
  } finally {
    if (!published) await handle.close().catch(() => undefined);
    await fs.rm(candidate, { force: true }).catch(() => undefined);
  }
}

async function recoverDeadLock(lock: string): Promise<void> {
  const snapshot = await readLockSnapshot(lock);
  if (!snapshot.owner || !snapshot.identity) return;
  // A lock from another host or an owner whose liveness cannot be disproved is authoritative.
  // Wall-clock age is intentionally never used as evidence of abandonment.
  if (snapshot.owner.host !== hostname() || isProcessAlive(snapshot.owner.pid)) return;
  await removeLockIfUnchanged(lock, snapshot);
}

async function releasePermissionLock(lease: PermissionLockLease): Promise<void> {
  const snapshot = await readLockSnapshot(lease.lock);
  if (
    snapshot.owner?.token === lease.owner.token &&
    snapshot.identity &&
    sameIdentity(snapshot.identity, lease.identity)
  ) {
    await fs.unlink(lease.lock).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function removeLockIfUnchanged(lock: string, expected: LockSnapshot): Promise<void> {
  const current = await readLockSnapshot(lock);
  if (
    current.owner?.token === expected.owner?.token &&
    current.identity &&
    expected.identity &&
    sameIdentity(current.identity, expected.identity)
  ) {
    await fs.unlink(lock).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function readLockSnapshot(lock: string): Promise<LockSnapshot> {
  let before: BigIntStats;
  try {
    before = await fs.lstat(lock, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const identity = identityOf(before);
  if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_LOCK_BYTES)) {
    return { identity };
  }

  let handle: import("node:fs/promises").FileHandle;
  try {
    handle = await fs.open(lock, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened) || opened.size > BigInt(MAX_LOCK_BYTES)) return { identity };
    const raw = await readHandleBounded(handle, MAX_LOCK_BYTES);
    if (!raw) return { identity };
    const after = await handle.stat({ bigint: true });
    if (!sameSnapshot(opened, after)) return { identity };
    const owner = parseLockOwner(raw.toString("utf8"));
    return owner ? { identity: identityOf(opened), owner } : { identity: identityOf(opened) };
  } finally {
    await handle.close();
  }
}

function parseLockOwner(text: string): PermissionLockOwner | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      value["version"] === 1 &&
      Number.isSafeInteger(value["pid"]) &&
      (value["pid"] as number) > 0 &&
      typeof value["host"] === "string" &&
      value["host"].length > 0 &&
      typeof value["token"] === "string" &&
      /^[a-f0-9]{64}$/.test(value["token"])
    ) {
      return value as unknown as PermissionLockOwner;
    }
  } catch {
    // Invalid owner data is fail-closed and never auto-removed.
  }
  return undefined;
}

async function readHandleBounded(
  handle: import("node:fs/promises").FileHandle,
  maxBytes: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const capacity = Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total);
    if (capacity <= 0) return undefined;
    const buffer = Buffer.allocUnsafe(capacity);
    const { bytesRead } = await handle.read(buffer, 0, capacity, total);
    if (bytesRead === 0) return Buffer.concat(chunks, total);
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
    if (total > maxBytes) return undefined;
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFile(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function identityOf(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
