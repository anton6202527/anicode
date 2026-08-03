/**
 * 凭证存储 —— ~/.anicode/auth.json（0600），按 provider 存 OAuth token 等敏感凭证。
 *
 * 与 SessionStore 分离：会话历史不含凭证；凭证单独一份、严格权限。core 只读写这一个文件，
 * 不打日志、不进 snapshot。
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  promises as fs,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthTokens } from "./oauth.js";
import { OsKeychainSecretBackend, type SyncSecretBackend } from "../security/secret-backends.js";

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expiresAt: number;
}

export type Credential = OAuthCredential;

type AuthFile = Record<string, Credential>;

interface CredentialLockOwner {
  pid: number;
  token: string;
}

const LOCK_TIMEOUT_MS = 10_000;
const INVALID_LOCK_STALE_MS = 30_000;

function validateCredential(providerId: string, credential: unknown): Credential {
  if (
    !credential ||
    typeof credential !== "object" ||
    (credential as Record<string, unknown>)["type"] !== "oauth" ||
    typeof (credential as Record<string, unknown>)["access"] !== "string" ||
    typeof (credential as Record<string, unknown>)["refresh"] !== "string" ||
    typeof (credential as Record<string, unknown>)["expiresAt"] !== "number" ||
    !Number.isFinite((credential as Record<string, unknown>)["expiresAt"] as number)
  ) {
    throw new Error(`Invalid credential entry for ${providerId}`);
  }
  return credential as Credential;
}

function parseAuthFile(text: string, source: string): AuthFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid credential file JSON: ${source}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid credential file schema: ${source}`);
  }
  for (const [providerId, credential] of Object.entries(value)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
      throw new Error(`Invalid provider id in credential file: ${providerId}`);
    }
    validateCredential(providerId, credential);
  }
  return value as AuthFile;
}

function defaultAuthFile(): string {
  const override = process.env["ANICODE_AUTH_FILE"];
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".anicode", "auth.json");
}

export class AuthStore {
  private readonly file: string;
  private readonly backend?: SyncSecretBackend;
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(file?: string, backend?: SyncSecretBackend) {
    this.file = file ?? defaultAuthFile();
    const forceFile = Boolean(
      file || process.env["ANICODE_AUTH_FILE"] || process.env["ANICODE_AUTH_BACKEND"] === "file",
    );
    if (!forceFile) {
      this.backend =
        backend ??
        new OsKeychainSecretBackend(
          process.env["ANICODE_KEYCHAIN_SERVICE"] ?? "dev.anicode.credentials",
        );
    }
  }

  private backendKey(providerId: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId)) {
      throw new Error(`Invalid provider id: ${providerId}`);
    }
    return `auth:${providerId}`;
  }

  private async readAll(): Promise<AuthFile> {
    try {
      return parseAuthFile(await fs.readFile(this.file, "utf8"), this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(data: AuthFile): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    // 原子写：先 tmp 再 rename，避免并发/崩溃留下半截凭证文件。
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      const handle = await fs.open(tmp, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(tmp, this.file);
      await fs.chmod(this.file, 0o600);
      // Windows does not support opening directories as file handles. The rename
      // is still atomic there; POSIX additionally fsyncs the parent directory so
      // the rename itself survives a sudden power loss.
      if (process.platform !== "win32") {
        const directory = await fs.open(dir, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await fs.rm(tmp, { force: true });
    }
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => undefined).then(() => this.withFileLock(operation));
    this.mutationTail = run;
    return run;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const lock = `${this.file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const owner: CredentialLockOwner = { pid: process.pid, token: randomUUID() };
    let handle: import("node:fs/promises").FileHandle;
    for (;;) {
      try {
        handle = await fs.open(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const current = await readLockOwner(lock);
        if (current.owner) {
          // Age alone is not evidence that a lock is abandoned: a slow writer
          // can legitimately hold it for longer than the stale threshold. Never
          // unlink a lock while its owning process is alive, otherwise that old
          // owner can later remove a replacement lock and admit two writers.
          if (!isProcessAlive(current.owner.pid)) {
            await removeLockIfOwned(lock, current.owner.token);
          }
        } else if (
          current.mtimeMs !== undefined &&
          Date.now() - current.mtimeMs > INVALID_LOCK_STALE_MS
        ) {
          // A creator can briefly leave an empty file between open and write.
          // Only malformed locks older than the grace period are recoverable.
          await removeInvalidLockIfUnchanged(lock, current.mtimeMs);
        }
        if (Date.now() >= deadline) {
          throw new Error(`Credential store lock timeout: ${lock}`, { cause: error });
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
      return await operation();
    } finally {
      await handle.close();
      await removeLockIfOwned(lock, owner.token);
    }
  }

  async get(providerId: string): Promise<Credential | undefined> {
    this.backendKey(providerId);
    if (this.backend) return this.getSync(providerId);
    return (await this.readAll())[providerId];
  }

  /** 同步读取（provider 工厂在构造时判定 OAuth/apiKey 用；文件小、每会话一次）。 */
  getSync(providerId: string): Credential | undefined {
    this.backendKey(providerId);
    if (this.backend) {
      const key = this.backendKey(providerId);
      const stored = this.backend.getSync(key);
      if (stored) {
        return parseAuthFile(`{${JSON.stringify(providerId)}:${stored}}`, "OS keychain")[
          providerId
        ];
      }
      // 首次读取时把旧 auth.json 条目迁入 OS keychain，并从明文文件删除。
      const legacy = this.readLegacySync();
      const credential = legacy[providerId];
      if (!credential) return undefined;
      this.backend.putSync(key, JSON.stringify(credential));
      delete legacy[providerId];
      this.writeLegacySync(legacy);
      return credential;
    }
    try {
      return parseAuthFile(readFileSync(this.file, "utf8"), this.file)[providerId];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async set(providerId: string, cred: Credential): Promise<void> {
    this.backendKey(providerId);
    const validated = validateCredential(providerId, cred);
    if (this.backend) {
      this.backend.putSync(this.backendKey(providerId), JSON.stringify(validated));
      return;
    }
    await this.mutate(async () => {
      const all = await this.readAll();
      all[providerId] = validated;
      await this.writeAll(all);
    });
  }

  async remove(providerId: string): Promise<boolean> {
    this.backendKey(providerId);
    if (this.backend) return this.backend.deleteSync(this.backendKey(providerId));
    return this.mutate(async () => {
      const all = await this.readAll();
      if (!(providerId in all)) return false;
      delete all[providerId];
      await this.writeAll(all);
      return true;
    });
  }

  async list(): Promise<{ providerId: string; type: Credential["type"]; expiresAt?: number }[]> {
    if (this.backend?.listSync) {
      return this.backend
        .listSync()
        .filter((key) => key.startsWith("auth:"))
        .flatMap((key) => {
          const providerId = key.slice(5);
          const stored = this.backend!.getSync(key);
          if (!stored) return [];
          const credential = parseAuthFile(
            `{${JSON.stringify(providerId)}:${stored}}`,
            "OS keychain",
          )[providerId]!;
          return [
            {
              providerId,
              type: credential.type,
              ...(credential.type === "oauth" ? { expiresAt: credential.expiresAt } : {}),
            },
          ];
        });
    }
    const all = await this.readAll();
    return Object.entries(all).map(([providerId, c]) => ({
      providerId,
      type: c.type,
      ...(c.type === "oauth" ? { expiresAt: c.expiresAt } : {}),
    }));
  }

  fromTokens(tokens: OAuthTokens): OAuthCredential {
    return {
      type: "oauth",
      access: tokens.access,
      refresh: tokens.refresh,
      expiresAt: tokens.expiresAt,
    };
  }

  private readLegacySync(): AuthFile {
    try {
      return parseAuthFile(readFileSync(this.file, "utf8"), this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private writeLegacySync(data: AuthFile): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.migrate.tmp`;
    let fileDescriptor: number | undefined;
    let directoryDescriptor: number | undefined;
    try {
      writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      fileDescriptor = openSync(temporary, "r");
      fsyncSync(fileDescriptor);
      closeSync(fileDescriptor);
      fileDescriptor = undefined;
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
      if (process.platform !== "win32") {
        directoryDescriptor = openSync(dir, "r");
        fsyncSync(directoryDescriptor);
      }
    } finally {
      if (fileDescriptor !== undefined) closeSync(fileDescriptor);
      if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
      rmSync(temporary, { force: true });
    }
  }
}

async function readLockOwner(
  lock: string,
): Promise<{ owner?: CredentialLockOwner; mtimeMs?: number }> {
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
    // The owner may still be between exclusive create and its first write.
  }
  return { mtimeMs: stat.mtimeMs };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function removeLockIfOwned(lock: string, token: string): Promise<void> {
  const current = await readLockOwner(lock);
  if (current.owner?.token === token) await fs.rm(lock, { force: true });
}

async function removeInvalidLockIfUnchanged(lock: string, mtimeMs: number): Promise<void> {
  const current = await readLockOwner(lock);
  if (!current.owner && current.mtimeMs === mtimeMs) await fs.rm(lock, { force: true });
}
