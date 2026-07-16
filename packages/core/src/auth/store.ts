/**
 * 凭证存储 —— ~/.anicode/auth.json（0600），按 provider 存 OAuth token 等敏感凭证。
 *
 * 与 SessionStore 分离：会话历史不含凭证；凭证单独一份、严格权限。core 只读写这一个文件，
 * 不打日志、不进 snapshot。
 */

import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthTokens } from "./oauth.js";

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

  constructor(file?: string) {
    this.file = file ?? defaultAuthFile();
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
    return (await this.readAll())[providerId];
  }

  /** 同步读取（provider 工厂在构造时判定 OAuth/apiKey 用；文件小、每会话一次）。 */
  getSync(providerId: string): Credential | undefined {
    try {
      const obj = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!obj || typeof obj !== "object") return undefined;
      return (obj as AuthFile)[providerId];
    } catch {
      return undefined;
    }
  }

  async set(providerId: string, cred: Credential): Promise<void> {
    const all = await this.readAll();
    all[providerId] = cred;
    await this.writeAll(all);
  }

  async remove(providerId: string): Promise<boolean> {
    const all = await this.readAll();
    if (!(providerId in all)) return false;
    delete all[providerId];
    await this.writeAll(all);
    return true;
  }

  async list(): Promise<{ providerId: string; type: Credential["type"]; expiresAt?: number }[]> {
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
}
