/**
 * 凭证存储 —— ~/.anicode/auth.json（0600），按 provider 存 OAuth token 等敏感凭证。
 *
 * 与 SessionStore 分离：会话历史不含凭证；凭证单独一份、严格权限。core 只读写这一个文件，
 * 不打日志、不进 snapshot。
 */

import {
  chmodSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
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

function defaultAuthFile(): string {
  const override = process.env["ANICODE_AUTH_FILE"];
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".anicode", "auth.json");
}

export class AuthStore {
  private readonly file: string;
  private readonly backend?: SyncSecretBackend;

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
      const text = await fs.readFile(this.file, "utf8");
      const obj = JSON.parse(text) as unknown;
      return obj && typeof obj === "object" ? (obj as AuthFile) : {};
    } catch {
      return {};
    }
  }

  private async writeAll(data: AuthFile): Promise<void> {
    const dir = path.dirname(this.file);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    // 原子写：先 tmp 再 rename，避免并发/崩溃留下半截凭证文件。
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, this.file);
    await fs.chmod(this.file, 0o600).catch(() => {});
  }

  async get(providerId: string): Promise<Credential | undefined> {
    if (this.backend) return this.getSync(providerId);
    return (await this.readAll())[providerId];
  }

  /** 同步读取（provider 工厂在构造时判定 OAuth/apiKey 用；文件小、每会话一次）。 */
  getSync(providerId: string): Credential | undefined {
    if (this.backend) {
      const key = this.backendKey(providerId);
      const stored = this.backend.getSync(key);
      if (stored) {
        try {
          return JSON.parse(stored) as Credential;
        } catch {
          return undefined;
        }
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
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!obj || typeof obj !== "object") return undefined;
      return (obj as AuthFile)[providerId];
    } catch {
      return undefined;
    }
  }

  async set(providerId: string, cred: Credential): Promise<void> {
    if (this.backend) {
      this.backend.putSync(this.backendKey(providerId), JSON.stringify(cred));
      return;
    }
    const all = await this.readAll();
    all[providerId] = cred;
    await this.writeAll(all);
  }

  async remove(providerId: string): Promise<boolean> {
    if (this.backend) return this.backend.deleteSync(this.backendKey(providerId));
    const all = await this.readAll();
    if (!(providerId in all)) return false;
    delete all[providerId];
    await this.writeAll(all);
    return true;
  }

  async list(): Promise<{ providerId: string; type: Credential["type"]; expiresAt?: number }[]> {
    if (this.backend?.listSync) {
      return this.backend
        .listSync()
        .filter((key) => key.startsWith("auth:"))
        .flatMap((key) => {
          try {
            const credential = JSON.parse(
              this.backend!.getSync(key) ?? "null",
            ) as Credential | null;
            if (!credential) return [];
            return [
              {
                providerId: key.slice(5),
                type: credential.type,
                ...(credential.type === "oauth" ? { expiresAt: credential.expiresAt } : {}),
              },
            ];
          } catch {
            return [];
          }
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
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as AuthFile) : {};
    } catch {
      return {};
    }
  }

  private writeLegacySync(data: AuthFile): void {
    const dir = path.dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const temporary = `${this.file}.${process.pid}.migrate.tmp`;
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
