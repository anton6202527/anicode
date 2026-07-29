/** 长期密钥后端：OS Keychain、Vault KV v2、AWS KMS envelope 与 OIDC。 */

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { Entry, findCredentials } from "@napi-rs/keyring";
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";

export interface SecretBackend {
  readonly kind: string;
  get(key: string): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<boolean>;
  list?(): Promise<string[]>;
}

export interface SyncSecretBackend extends SecretBackend {
  getSync(key: string): string | undefined;
  putSync(key: string, value: string): void;
  deleteSync(key: string): boolean;
  listSync?(): string[];
}

function validKey(key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(key)) {
    throw new Error(`Invalid secret key: ${JSON.stringify(key)}`);
  }
  return key;
}

/** macOS Keychain / Linux Secret Service / Windows Credential Vault。 */
export class OsKeychainSecretBackend implements SyncSecretBackend {
  readonly kind = "os-keychain";
  constructor(readonly service = "dev.anicode.credentials") {}

  getSync(key: string): string | undefined {
    return new Entry(this.service, validKey(key)).getPassword() ?? undefined;
  }
  putSync(key: string, value: string): void {
    if (!value) throw new Error("Secret value cannot be empty");
    new Entry(this.service, validKey(key)).setPassword(value);
  }
  deleteSync(key: string): boolean {
    return new Entry(this.service, validKey(key)).deleteCredential();
  }
  listSync(): string[] {
    return findCredentials(this.service)
      .map((credential) => credential.account)
      .filter((account) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(account))
      .sort();
  }
  async get(key: string): Promise<string | undefined> {
    return this.getSync(key);
  }
  async put(key: string, value: string): Promise<void> {
    this.putSync(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.deleteSync(key);
  }
  async list(): Promise<string[]> {
    return this.listSync();
  }
}

export type OidcTokenProvider = (audience?: string) => Promise<string>;

/** GitHub Actions 的 OIDC request-token 协议；返回短期 id_token，不落盘。 */
export function githubActionsOidcProvider(
  env: NodeJS.ProcessEnv = process.env,
  doFetch: typeof fetch = fetch,
): OidcTokenProvider {
  return async (audience) => {
    const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    if (!requestUrl || !requestToken) throw new Error("GitHub Actions OIDC is unavailable");
    const url = new URL(requestUrl);
    if (audience) url.searchParams.set("audience", audience);
    const response = await doFetch(url, {
      headers: { authorization: `Bearer ${requestToken}` },
    });
    if (!response.ok) throw new Error(`OIDC token request failed: HTTP ${response.status}`);
    const body = (await response.json()) as { value?: string };
    if (!body.value) throw new Error("OIDC token response did not contain value");
    return body.value;
  };
}

/** Kubernetes projected service-account token / generic workload identity token file。 */
export function oidcTokenFileProvider(file: string): OidcTokenProvider {
  const target = path.resolve(file);
  return async () => {
    const token = (await fs.readFile(target, "utf8")).trim();
    if (!token) throw new Error(`OIDC token file is empty: ${target}`);
    return token;
  };
}

export interface VaultTokenProvider {
  token(): Promise<string>;
}

export class StaticVaultTokenProvider implements VaultTokenProvider {
  constructor(private readonly value: string) {}
  async token(): Promise<string> {
    if (!this.value) throw new Error("Vault token is empty");
    return this.value;
  }
}

/** Vault JWT/OIDC auth，token 在 TTL 内复用并在过期前刷新。 */
export class VaultJwtTokenProvider implements VaultTokenProvider {
  private cached: { value: string; expiresAt: number } | undefined;
  constructor(
    private readonly options: {
      address: string;
      role: string;
      oidc: OidcTokenProvider;
      mount?: string;
      namespace?: string;
      audience?: string;
      fetch?: typeof fetch;
    },
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 30_000 > Date.now()) return this.cached.value;
    const jwt = await this.options.oidc(this.options.audience);
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.address.replace(/\/+$/, "")}/v1/auth/${encodeURIComponent(
        this.options.mount ?? "jwt",
      )}/login`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.options.namespace ? { "x-vault-namespace": this.options.namespace } : {}),
        },
        body: JSON.stringify({ role: this.options.role, jwt }),
      },
    );
    if (!response.ok) throw new Error(`Vault JWT login failed: HTTP ${response.status}`);
    const body = (await response.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };
    if (!body.auth?.client_token) throw new Error("Vault JWT login returned no client token");
    this.cached = {
      value: body.auth.client_token,
      expiresAt: Date.now() + Math.max(60, body.auth.lease_duration ?? 300) * 1_000,
    };
    return this.cached.value;
  }
}

export class VaultKvV2SecretBackend implements SecretBackend {
  readonly kind = "vault-kv-v2";
  private readonly address: string;
  private readonly mount: string;
  private readonly prefix: string;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly options: {
      address: string;
      tokenProvider: VaultTokenProvider;
      mount?: string;
      prefix?: string;
      namespace?: string;
      fetch?: typeof fetch;
    },
  ) {
    this.address = options.address.replace(/\/+$/, "");
    this.mount = options.mount ?? "secret";
    this.prefix = (options.prefix ?? "anicode").replace(/^\/+|\/+$/g, "");
    this.doFetch = options.fetch ?? fetch;
  }

  private target(kind: "data" | "metadata", key = ""): string {
    const suffix = [this.prefix, key && encodeURIComponent(validKey(key))]
      .filter(Boolean)
      .join("/");
    return `${this.address}/v1/${encodeURIComponent(this.mount)}/${kind}/${suffix}`;
  }

  private async request(target: string, init: RequestInit): Promise<Response> {
    return this.doFetch(target, {
      ...init,
      headers: {
        "x-vault-token": await this.options.tokenProvider.token(),
        ...(this.options.namespace ? { "x-vault-namespace": this.options.namespace } : {}),
        ...init.headers,
      },
    });
  }

  async get(key: string): Promise<string | undefined> {
    const response = await this.request(this.target("data", key), { method: "GET" });
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Vault secret read failed: HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { data?: { value?: string } } };
    return body.data?.data?.value;
  }

  async put(key: string, value: string): Promise<void> {
    const response = await this.request(this.target("data", key), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ data: { value } }),
    });
    if (!response.ok) throw new Error(`Vault secret write failed: HTTP ${response.status}`);
  }

  async delete(key: string): Promise<boolean> {
    const response = await this.request(this.target("metadata", key), { method: "DELETE" });
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`Vault secret delete failed: HTTP ${response.status}`);
    return true;
  }

  async list(): Promise<string[]> {
    const response = await this.request(this.target("metadata"), { method: "LIST" });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`Vault secret list failed: HTTP ${response.status}`);
    const body = (await response.json()) as { data?: { keys?: string[] } };
    return (body.data?.keys ?? []).filter((key) => !key.endsWith("/")).sort();
  }
}

export interface AwsKmsSecretBackendOptions {
  keyId: string;
  directory: string;
  region?: string;
  encryptionContext?: Record<string, string>;
  clientConfig?: KMSClientConfig;
}

/**
 * KMS envelope-at-rest 后端。默认凭据链自动支持 AWS_WEB_IDENTITY_TOKEN_FILE +
 * AWS_ROLE_ARN（OIDC），磁盘只有 CiphertextBlob；明文只在一次 get/put 调用内存在。
 */
export class AwsKmsSecretBackend implements SecretBackend {
  readonly kind = "aws-kms";
  private readonly client: KMSClient;
  private readonly directory: string;
  constructor(private readonly options: AwsKmsSecretBackendOptions) {
    this.directory = path.resolve(options.directory);
    this.client = new KMSClient({
      ...(options.region ? { region: options.region } : {}),
      ...options.clientConfig,
    });
  }

  private file(key: string): string {
    return path.join(this.directory, `${encodeURIComponent(validKey(key))}.kms.json`);
  }

  private context(key: string): Record<string, string> {
    return { service: "anicode", credential: key, ...this.options.encryptionContext };
  }

  async get(key: string): Promise<string | undefined> {
    let document: { version: 1; ciphertext: string };
    try {
      document = JSON.parse(await fs.readFile(this.file(key), "utf8")) as typeof document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const result = await this.client.send(
      new DecryptCommand({
        CiphertextBlob: Buffer.from(document.ciphertext, "base64"),
        EncryptionContext: this.context(key),
      }),
    );
    if (!result.Plaintext) throw new Error("KMS decrypt returned no plaintext");
    return Buffer.from(result.Plaintext).toString("utf8");
  }

  async put(key: string, value: string): Promise<void> {
    const result = await this.client.send(
      new EncryptCommand({
        KeyId: this.options.keyId,
        Plaintext: Buffer.from(value, "utf8"),
        EncryptionContext: this.context(key),
      }),
    );
    if (!result.CiphertextBlob) throw new Error("KMS encrypt returned no ciphertext");
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.file(key);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(
        temporary,
        JSON.stringify({
          version: 1,
          ciphertext: Buffer.from(result.CiphertextBlob).toString("base64"),
        }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      await fs.rename(temporary, target);
      await fs.chmod(target, 0o600);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }

  async delete(key: string): Promise<boolean> {
    try {
      await fs.unlink(this.file(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      return (await fs.readdir(this.directory))
        .filter((name) => name.endsWith(".kms.json"))
        .map((name) => decodeURIComponent(name.slice(0, -9)))
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}

/** 统一环境装配；环境只含地址/role/key id，密钥值始终来自 Keychain/Vault/KMS。 */
export async function configuredSecretBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecretBackend> {
  const kind = env.ANICODE_CREDENTIAL_BACKEND ?? "keychain";
  if (kind === "keychain") {
    return new OsKeychainSecretBackend(env.ANICODE_KEYCHAIN_SERVICE ?? "dev.anicode.credentials");
  }
  if (kind === "vault") {
    const address = env.VAULT_ADDR;
    const role = env.ANICODE_VAULT_ROLE;
    if (!address || !role) throw new Error("VAULT_ADDR and ANICODE_VAULT_ROLE are required");
    const oidc = env.ACTIONS_ID_TOKEN_REQUEST_URL
      ? githubActionsOidcProvider(env)
      : env.ANICODE_OIDC_TOKEN_FILE
        ? oidcTokenFileProvider(env.ANICODE_OIDC_TOKEN_FILE)
        : undefined;
    if (!oidc)
      throw new Error("Vault backend requires GitHub Actions OIDC or ANICODE_OIDC_TOKEN_FILE");
    return new VaultKvV2SecretBackend({
      address,
      tokenProvider: new VaultJwtTokenProvider({
        address,
        role,
        oidc,
        mount: env.ANICODE_VAULT_AUTH_MOUNT ?? "jwt",
        audience: env.ANICODE_VAULT_AUDIENCE ?? "vault",
        ...(env.VAULT_NAMESPACE ? { namespace: env.VAULT_NAMESPACE } : {}),
      }),
      mount: env.ANICODE_VAULT_KV_MOUNT ?? "secret",
      prefix: env.ANICODE_VAULT_PREFIX ?? "anicode",
      ...(env.VAULT_NAMESPACE ? { namespace: env.VAULT_NAMESPACE } : {}),
    });
  }
  if (kind === "kms") {
    const keyId = env.ANICODE_KMS_KEY_ID;
    if (!keyId) throw new Error("ANICODE_KMS_KEY_ID is required");
    const staticAwsCredential = [
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ].find((name) => env[name]);
    if (staticAwsCredential) {
      throw new Error(
        `${staticAwsCredential} is forbidden for KMS; use workload identity/instance role or AWS_WEB_IDENTITY_TOKEN_FILE + AWS_ROLE_ARN`,
      );
    }
    return new AwsKmsSecretBackend({
      keyId,
      directory: env.ANICODE_KMS_DIRECTORY ?? ".anicode/credentials",
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
    });
  }
  throw new Error(`Unsupported ANICODE_CREDENTIAL_BACKEND: ${kind}`);
}
