/**
 * OAuth credential store with explicit file, memory or OS-keychain selection.
 *
 * It is separate from SessionStore, never logged or snapshotted. auth.json is
 * retained as a 0600 compatibility/migration source; ordinary reads never
 * persist a migration into the operating-system credential store.
 */

import { promises as fs, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { OAuthTokens } from "./oauth.js";
import {
  OS_KEYCHAIN_DISABLED_ENV,
  OsKeychainDisabledError,
  OsKeychainSecretBackend,
  type SyncSecretBackend,
} from "../security/secret-backends.js";
import { openExclusiveLockFile } from "../security/exclusive-lock-file.js";

export interface OAuthCredential {
  type: "oauth";
  access: string;
  refresh: string;
  expiresAt: number;
}

export type Credential = OAuthCredential;

type AuthFile = Record<string, Credential>;

interface AuthIndexEntry {
  type: Credential["type"];
  expiresAt?: number;
}

interface AuthIndex {
  version: 1;
  credentials: Record<string, AuthIndexEntry>;
}

type AuthProviderState =
  | { mode: "backend-authoritative"; type: Credential["type"]; expiresAt: number }
  | { mode: "revoked" };

interface AuthState {
  version: 1;
  providers: Record<string, AuthProviderState>;
}

export type AuthStoreCommitOutcome = "not-committed" | "indeterminate";

export class AuthStorePersistenceError extends Error {
  readonly name = "AuthStorePersistenceError";

  constructor(
    readonly target: "auth-file" | "state-file",
    readonly outcome: AuthStoreCommitOutcome,
    cause: unknown,
  ) {
    super(
      `${target} write ${outcome === "indeterminate" ? "has an indeterminate outcome" : "did not commit"}`,
      {
        cause,
      },
    );
  }
}

export type AuthStoreBackendKind = "file" | "memory" | "keychain";

export interface AuthStoreOptions {
  /** Legacy plaintext store location and the default state/lock coordination directory. */
  file?: string;
  /** Explicit storage selection or an injected synchronous backend. */
  backend?: AuthStoreBackendKind | SyncSecretBackend;
  /** Injectable environment snapshot; primarily useful to enforce policy in tests. */
  env?: NodeJS.ProcessEnv;
  keychainService?: string;
  /** Stable state/lock path for an injected durable backend shared by multiple stores. */
  coordinationFile?: string;
  /** @internal Deterministic persistence fault injection for crash-consistency tests. */
  faultInjection?: {
    afterRename?: (target: "auth-file" | "state-file") => void | Promise<void>;
  };
}

interface CredentialLockOwner {
  pid: number;
  token: string;
}

const LOCK_TIMEOUT_MS = 10_000;
const AUTH_INDEX_KEY = "auth-index:v1";

class MemoryAuthSecretBackend implements SyncSecretBackend {
  readonly kind = "memory";
  private readonly values = new Map<string, string>();

  getSync(key: string): string | undefined {
    return this.values.get(key);
  }

  putSync(key: string, value: string): void {
    this.values.set(key, value);
  }

  deleteSync(key: string): boolean {
    return this.values.delete(key);
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
}

function isValidProviderId(providerId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(providerId);
}

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
  const value = credential as Record<string, unknown>;
  return {
    type: "oauth",
    access: value["access"] as string,
    refresh: value["refresh"] as string,
    expiresAt: value["expiresAt"] as number,
  };
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
  const parsed: AuthFile = {};
  for (const [providerId, credential] of Object.entries(value)) {
    if (!isValidProviderId(providerId)) {
      throw new Error(`Invalid provider id in credential file: ${providerId}`);
    }
    parsed[providerId] = validateCredential(providerId, credential);
  }
  return parsed;
}

function parseStoredCredential(providerId: string, text: string, source: string): Credential {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid credential JSON for ${providerId}: ${source}`, { cause: error });
  }
  return validateCredential(providerId, value);
}

function parseAuthIndex(text: string, source: string): AuthIndex {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid auth credential index JSON: ${source}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid auth credential index schema: ${source}`);
  }
  const record = value as Record<string, unknown>;
  const credentials = record["credentials"];
  if (
    record["version"] !== 1 ||
    !credentials ||
    typeof credentials !== "object" ||
    Array.isArray(credentials)
  ) {
    throw new Error(`Invalid auth credential index schema: ${source}`);
  }
  if (Object.keys(record).some((key) => key !== "version" && key !== "credentials")) {
    throw new Error(`Invalid auth credential index schema: ${source}`);
  }
  const parsedCredentials: Record<string, AuthIndexEntry> = {};
  for (const [providerId, metadata] of Object.entries(credentials)) {
    if (!isValidProviderId(providerId)) {
      throw new Error(`Invalid provider id in auth credential index: ${providerId}`);
    }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      throw new Error(`Invalid auth credential index entry for ${providerId}`);
    }
    const entry = metadata as Record<string, unknown>;
    if (
      entry["type"] !== "oauth" ||
      typeof entry["expiresAt"] !== "number" ||
      !Number.isFinite(entry["expiresAt"]) ||
      Object.keys(entry).some((key) => key !== "type" && key !== "expiresAt")
    ) {
      throw new Error(`Invalid auth credential index entry for ${providerId}`);
    }
    parsedCredentials[providerId] = { type: "oauth", expiresAt: entry["expiresAt"] };
  }
  return { version: 1, credentials: parsedCredentials };
}

function parseAuthState(text: string, source: string): AuthState {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid auth state JSON: ${source}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid auth state schema: ${source}`);
  }
  const record = value as Record<string, unknown>;
  const providers = record["providers"];
  if (
    record["version"] !== 1 ||
    !providers ||
    typeof providers !== "object" ||
    Array.isArray(providers) ||
    Object.keys(record).some((key) => key !== "version" && key !== "providers")
  ) {
    throw new Error(`Invalid auth state schema: ${source}`);
  }

  const parsedProviders: Record<string, AuthProviderState> = {};
  for (const [providerId, providerState] of Object.entries(providers)) {
    if (
      !isValidProviderId(providerId) ||
      !providerState ||
      typeof providerState !== "object" ||
      Array.isArray(providerState)
    ) {
      throw new Error(`Invalid auth state entry for ${providerId}`);
    }
    const entry = providerState as Record<string, unknown>;
    if (entry["mode"] === "revoked") {
      if (Object.keys(entry).some((key) => key !== "mode")) {
        throw new Error(`Invalid auth state entry for ${providerId}`);
      }
      parsedProviders[providerId] = { mode: "revoked" };
      continue;
    }
    if (
      entry["mode"] !== "backend-authoritative" ||
      entry["type"] !== "oauth" ||
      typeof entry["expiresAt"] !== "number" ||
      !Number.isFinite(entry["expiresAt"]) ||
      Object.keys(entry).some((key) => key !== "mode" && key !== "type" && key !== "expiresAt")
    ) {
      throw new Error(`Invalid auth state entry for ${providerId}`);
    }
    parsedProviders[providerId] = {
      mode: "backend-authoritative",
      type: "oauth",
      expiresAt: entry["expiresAt"],
    };
  }
  return { version: 1, providers: parsedProviders };
}

function indexEntry(credential: Credential): AuthIndexEntry {
  return {
    type: credential.type,
    ...(credential.type === "oauth" ? { expiresAt: credential.expiresAt } : {}),
  };
}

function defaultAuthFile(env: NodeJS.ProcessEnv): string {
  const override = env["ANICODE_AUTH_FILE"];
  if (override && override.trim()) return override;
  return path.join(os.homedir(), ".anicode", "auth.json");
}

function keychainCoordinationFile(service: string): string {
  const namespace = createHash("sha256").update(service, "utf8").digest("hex").slice(0, 32);
  return path.join(os.homedir(), ".anicode", "auth-state", `${namespace}.json`);
}

function isOsKeychainBackend(backend: SyncSecretBackend): boolean {
  return backend.kind === "os-keychain" || backend.kind === "keychain";
}

function assertAuthKeychainAllowed(env: NodeJS.ProcessEnv): void {
  if (env[OS_KEYCHAIN_DISABLED_ENV] === "1") throw new OsKeychainDisabledError();
  if (env["ANICODE_CREDENTIAL_BACKEND"] === "memory") {
    throw new Error("ANICODE_CREDENTIAL_BACKEND=memory forbids OS keychain access");
  }
}

function resolveBackendKind(
  options: AuthStoreOptions,
  explicitlyProvidedFile: boolean,
): AuthStoreBackendKind {
  if (typeof options.backend === "string") return options.backend;
  if (explicitlyProvidedFile) return "file";

  const legacy = options.env?.["ANICODE_AUTH_BACKEND"];
  const unified = options.env?.["ANICODE_CREDENTIAL_BACKEND"];
  if (unified !== undefined) {
    if (legacy !== undefined && legacy !== unified) {
      throw new Error(
        `ANICODE_AUTH_BACKEND=${legacy} conflicts with ANICODE_CREDENTIAL_BACKEND=${unified}`,
      );
    }
    if (unified === "keychain" || unified === "memory") return unified;
    throw new Error(
      `AuthStore requires a synchronous backend; ANICODE_CREDENTIAL_BACKEND=${unified} must be injected explicitly`,
    );
  }

  if (options.env?.["ANICODE_AUTH_FILE"]) return "file";
  if (legacy !== undefined) {
    if (legacy === "file" || legacy === "memory" || legacy === "keychain") return legacy;
    throw new Error(`Unsupported ANICODE_AUTH_BACKEND: ${legacy}`);
  }
  return "keychain";
}

export class AuthStore {
  private readonly file: string;
  private readonly backend: SyncSecretBackend | undefined;
  private readonly legacyReadFallback: boolean;
  private readonly stateFile: string;
  private readonly lockFile: string;
  private readonly faultInjection?: AuthStoreOptions["faultInjection"];
  private readonly memoryState: AuthState = { version: 1, providers: {} };
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor();
  constructor(file: string, backend?: SyncSecretBackend);
  constructor(options: AuthStoreOptions);
  constructor(fileOrOptions?: string | AuthStoreOptions, legacyBackend?: SyncSecretBackend) {
    const explicitlyProvidedFile = typeof fileOrOptions === "string";
    const options: AuthStoreOptions =
      typeof fileOrOptions === "string"
        ? { file: fileOrOptions, ...(legacyBackend ? { backend: legacyBackend } : {}) }
        : { ...(fileOrOptions ?? {}) };
    const env = options.env ?? process.env;
    options.env = env;
    this.file = path.resolve(options.file ?? defaultAuthFile(env));
    if (options.faultInjection) this.faultInjection = options.faultInjection;

    let backend: SyncSecretBackend | undefined;
    let legacyReadFallback = false;

    if (options.backend && typeof options.backend !== "string") {
      if (isOsKeychainBackend(options.backend)) assertAuthKeychainAllowed(env);
      backend = options.backend;
      legacyReadFallback = options.backend.kind !== "memory";
    } else {
      const kind = resolveBackendKind(options, explicitlyProvidedFile);
      if (kind === "memory") backend = new MemoryAuthSecretBackend();
      else if (kind === "keychain") {
        assertAuthKeychainAllowed(env);
        backend = new OsKeychainSecretBackend(
          options.keychainService ?? env["ANICODE_KEYCHAIN_SERVICE"] ?? "dev.anicode.credentials",
        );
        legacyReadFallback = true;
      }
    }

    this.backend = backend;
    this.legacyReadFallback = legacyReadFallback;
    const canonicalStateFile =
      backend instanceof OsKeychainSecretBackend
        ? keychainCoordinationFile(backend.service)
        : `${this.file}.state.json`;
    this.stateFile = path.resolve(options.coordinationFile ?? canonicalStateFile);
    if (backend && this.stateFile === this.file) {
      throw new Error("Auth coordination file must be distinct from the legacy credential file");
    }
    this.lockFile = backend ? `${this.stateFile}.lock` : `${this.file}.lock`;
  }

  /**
   * List secret-free auth metadata without constructing or reading a credential backend. This is
   * the safe path for startup/status commands: legacy auth.json contributes only parsed metadata,
   * while a keychain deployment's coordination file is the authoritative non-secret index.
   */
  static async listMetadata(
    options: AuthStoreOptions = {},
  ): Promise<{ providerId: string; type: Credential["type"]; expiresAt?: number }[]> {
    if (options.backend && typeof options.backend !== "string") {
      throw new TypeError("Auth metadata listing does not accept a credential backend instance");
    }
    const env = options.env ?? process.env;
    const resolvedOptions = { ...options, env };
    const kind = resolveBackendKind(resolvedOptions, options.file !== undefined);
    if (kind === "memory") return [];

    const file = path.resolve(options.file ?? defaultAuthFile(env));
    let legacy: AuthFile;
    try {
      legacy = parseAuthFile(await fs.readFile(file, "utf8"), file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") legacy = {};
      else throw error;
    }
    if (kind === "file") {
      return Object.entries(legacy).map(([providerId, credential]) => ({
        providerId,
        ...indexEntry(credential),
      }));
    }

    const service =
      options.keychainService ?? env["ANICODE_KEYCHAIN_SERVICE"] ?? "dev.anicode.credentials";
    const stateFile = path.resolve(options.coordinationFile ?? keychainCoordinationFile(service));
    let state: AuthState;
    try {
      state = parseAuthState(await fs.readFile(stateFile, "utf8"), stateFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        state = { version: 1, providers: {} };
      } else {
        throw error;
      }
    }

    const merged: Record<string, AuthIndexEntry> = {};
    for (const [providerId, credential] of Object.entries(legacy)) {
      merged[providerId] = indexEntry(credential);
    }
    for (const [providerId, providerState] of Object.entries(state.providers)) {
      if (providerState.mode === "revoked") delete merged[providerId];
      else {
        merged[providerId] = {
          type: providerState.type,
          expiresAt: providerState.expiresAt,
        };
      }
    }
    return Object.entries(merged)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([providerId, metadata]) => ({ providerId, ...metadata }));
  }

  private backendKey(providerId: string): string {
    if (!isValidProviderId(providerId)) {
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

  private async readState(): Promise<AuthState> {
    try {
      return parseAuthState(await fs.readFile(this.stateFile, "utf8"), this.stateFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, providers: {} };
      }
      throw error;
    }
  }

  private readStateSync(): AuthState {
    try {
      return parseAuthState(readFileSync(this.stateFile, "utf8"), this.stateFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, providers: {} };
      }
      throw error;
    }
  }

  private async writeAtomic(
    target: string,
    data: string,
    label: "auth-file" | "state-file",
  ): Promise<void> {
    const dir = path.dirname(target);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let renameAttempted = false;
    try {
      await fs.writeFile(tmp, data, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      // FileHandle.sync() maps to FlushFileBuffers on Windows, which rejects read-only handles.
      const handle = await fs.open(tmp, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
      // The temporary is already 0600. Do every operation that can safely be
      // performed before the commit point before attempting rename.
      await fs.chmod(tmp, 0o600);
      renameAttempted = true;
      await fs.rename(tmp, target);
      await this.faultInjection?.afterRename?.(label);
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
    } catch (error) {
      throw new AuthStorePersistenceError(
        label,
        renameAttempted ? "indeterminate" : "not-committed",
        error,
      );
    } finally {
      // A stale temporary is recoverable and must not turn a committed rename
      // into a false rollback signal.
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private writeAll(data: AuthFile): Promise<void> {
    return this.writeAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, "auth-file");
  }

  private writeState(state: AuthState): Promise<void> {
    return this.writeAtomic(this.stateFile, `${JSON.stringify(state, null, 2)}\n`, "state-file");
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.catch(() => undefined).then(() => this.withFileLock(operation));
    this.mutationTail = run;
    return run;
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = this.lockFile;
    const dir = path.dirname(lock);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    const owner: CredentialLockOwner = { pid: process.pid, token: randomUUID() };
    let handle: import("node:fs/promises").FileHandle;
    for (;;) {
      try {
        handle = await openExclusiveLockFile(lock, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) {
          throw new Error(
            `Credential store lock timeout: ${lock}. Stop all writers before manually removing an abandoned lock`,
            { cause: error },
          );
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
    let operationCompleted = false;
    try {
      const result = await operation();
      operationCompleted = true;
      return result;
    } finally {
      // Lock release happens after the mutation's own commit protocol. A close
      // or unlink failure must not turn a successful commit into a false
      // failure (which would encourage unsafe retries), nor hide the original
      // operation error. Always attempt both cleanup steps and surface a
      // process warning; a lock left behind will also produce the explicit
      // abandoned-lock timeout diagnostic on the next writer.
      const cleanupErrors: unknown[] = [];
      try {
        await handle.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await removeLockIfOwned(lock, owner.token);
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) {
        reportLockCleanupFailure(lock, operationCompleted, cleanupErrors.length);
      }
    }
  }

  private readBackendCredential(providerId: string): Credential | undefined {
    if (!this.backend) return undefined;
    const stored = this.backend.getSync(this.backendKey(providerId));
    return stored
      ? parseStoredCredential(providerId, stored, `${this.backend.kind} credential backend`)
      : undefined;
  }

  private parseBackendIndex(stored: string | undefined): AuthIndex {
    return stored
      ? parseAuthIndex(stored, `${this.backend?.kind ?? "unknown"} credential backend`)
      : { version: 1, credentials: {} };
  }

  private restoreBackendValue(key: string, previous: string | undefined): void {
    if (!this.backend) return;
    if (previous === undefined) this.backend.deleteSync(key);
    else this.backend.putSync(key, previous);
  }

  private async mutateBackend<T>(operation: () => Promise<T>): Promise<T> {
    // A process-local backend has no cross-process state and must not create a
    // lock (or even touch ~/.anicode) in no-keychain test mode.
    if (this.backend?.kind === "memory") return operation();
    return this.mutate(operation);
  }

  private rethrowWithRollback(error: unknown, rollbackErrors: unknown[]): never {
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Auth credential mutation failed and could not be fully rolled back",
      );
    }
    throw error;
  }

  async get(providerId: string): Promise<Credential | undefined> {
    this.backendKey(providerId);
    if (this.backend) {
      const providerState =
        this.backend.kind === "memory" ? undefined : (await this.readState()).providers[providerId];
      if (providerState?.mode === "revoked") return undefined;
      const stored = this.readBackendCredential(providerId);
      if (stored || !this.legacyReadFallback) return stored;
      if (providerState?.mode === "backend-authoritative") return undefined;
      // Compatibility is deliberately read-only. Persistence requires an
      // explicit migrateLegacy() call, so an ordinary provider lookup cannot
      // unexpectedly open a write prompt or delete the legacy source.
      return (await this.readAll())[providerId];
    }
    return (await this.readAll())[providerId];
  }

  /** 同步读取（provider 工厂在构造时判定 OAuth/apiKey 用；文件小、每会话一次）。 */
  getSync(providerId: string): Credential | undefined {
    this.backendKey(providerId);
    if (this.backend) {
      const providerState =
        this.backend.kind === "memory" ? undefined : this.readStateSync().providers[providerId];
      if (providerState?.mode === "revoked") return undefined;
      const stored = this.readBackendCredential(providerId);
      if (stored || !this.legacyReadFallback) return stored;
      if (providerState?.mode === "backend-authoritative") return undefined;
      return this.readLegacySync()[providerId];
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
      await this.mutateBackend(async () => {
        const key = this.backendKey(providerId);
        const previousCredential = this.backend!.getSync(key);
        const legacy = this.legacyReadFallback ? await this.readAll() : {};
        const state = this.backend!.kind === "memory" ? this.memoryState : await this.readState();
        let destinationMustBeRetained = false;
        try {
          this.backend!.putSync(key, JSON.stringify(validated));
          state.providers[providerId] = {
            mode: "backend-authoritative",
            type: validated.type,
            expiresAt: validated.expiresAt,
          };
          if (this.backend!.kind !== "memory") {
            try {
              await this.writeState(state);
              destinationMustBeRetained = true;
            } catch (error) {
              if (
                error instanceof AuthStorePersistenceError &&
                error.target === "state-file" &&
                error.outcome === "indeterminate"
              ) {
                destinationMustBeRetained = true;
              }
              throw error;
            }
          } else {
            destinationMustBeRetained = true;
          }
          if (providerId in legacy) {
            delete legacy[providerId];
            await this.writeAll(legacy);
          }
        } catch (error) {
          if (destinationMustBeRetained) throw error;
          const rollbackErrors: unknown[] = [];
          try {
            this.restoreBackendValue(key, previousCredential);
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
          this.rethrowWithRollback(error, rollbackErrors);
        }
      });
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
    if (this.backend) {
      if (this.backend.kind === "memory") {
        return this.mutateBackend(async () => {
          const key = this.backendKey(providerId);
          const removed = this.backend!.deleteSync(key);
          delete this.memoryState.providers[providerId];
          return removed;
        });
      }
      return this.mutateBackend(async () => {
        const key = this.backendKey(providerId);
        const legacy = this.legacyReadFallback ? await this.readAll() : {};
        const hadLegacy = providerId in legacy;
        const state = await this.readState();
        const wasLogicallyPresent =
          hadLegacy || state.providers[providerId]?.mode === "backend-authoritative";

        // This is the linearization point for revocation. Once durable, every
        // reader fails closed even if the process dies during physical cleanup.
        state.providers[providerId] = { mode: "revoked" };
        await this.writeState(state);

        const cleanupErrors: unknown[] = [];
        let removedFromBackend = false;
        try {
          removedFromBackend = this.backend!.deleteSync(key);
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (hadLegacy) {
          try {
            delete legacy[providerId];
            await this.writeAll(legacy);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            cleanupErrors,
            `Credential ${providerId} is revoked but physical cleanup is incomplete`,
          );
        }
        return wasLogicallyPresent || removedFromBackend;
      });
    }
    return this.mutate(async () => {
      const all = await this.readAll();
      if (!(providerId in all)) return false;
      delete all[providerId];
      await this.writeAll(all);
      return true;
    });
  }

  async list(): Promise<{ providerId: string; type: Credential["type"]; expiresAt?: number }[]> {
    if (this.backend) {
      // The local secret-free state is the sole runtime index. Listing must not
      // open the OS keychain at all, even for the historical auth-index:v1 key.
      const merged: Record<string, AuthIndexEntry> = {};
      if (this.legacyReadFallback) {
        const legacy = await this.readAll();
        for (const [providerId, credential] of Object.entries(legacy)) {
          merged[providerId] ??= indexEntry(credential);
        }
      }
      const state = this.backend.kind === "memory" ? this.memoryState : await this.readState();
      for (const [providerId, providerState] of Object.entries(state.providers)) {
        if (providerState.mode === "revoked") delete merged[providerId];
        else {
          merged[providerId] = {
            type: providerState.type,
            expiresAt: providerState.expiresAt,
          };
        }
      }
      return Object.entries(merged)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([providerId, metadata]) => ({ providerId, ...metadata }));
    }
    const all = await this.readAll();
    return Object.entries(all).map(([providerId, c]) => ({
      providerId,
      type: c.type,
      ...(c.type === "oauth" ? { expiresAt: c.expiresAt } : {}),
    }));
  }

  /**
   * Explicitly migrate every legacy auth.json entry and the historical
   * auth-index:v1 metadata into the selected durable backend/state. Ordinary
   * get/getSync/list/set/remove calls never touch the historical index.
   *
   * Existing identical backend values are retained. A conflicting value aborts
   * before either source is modified. Existing state (especially a revoked
   * tombstone) always wins over historical index metadata.
   */
  async migrateLegacy(): Promise<{ migratedProviderIds: string[] }> {
    if (!this.backend) throw new Error("Legacy migration requires a non-file auth backend");
    if (this.backend.kind === "memory") {
      throw new Error("Legacy credentials cannot be migrated into a non-durable memory backend");
    }
    return this.mutateBackend(async () => {
      const legacy = await this.readAll();
      const previousIndex = this.backend!.getSync(AUTH_INDEX_KEY);
      const historicalIndex = this.parseBackendIndex(previousIndex);
      const legacyProviderIds = Object.keys(legacy).sort();
      const historicalProviderIds = Object.keys(historicalIndex.credentials).sort();
      if (legacyProviderIds.length === 0 && previousIndex === undefined) {
        return { migratedProviderIds: [] };
      }

      const state = await this.readState();
      const previousCredentials = new Map<string, string | undefined>();
      for (const providerId of legacyProviderIds) {
        // A tombstone is a durable revocation decision. Legacy metadata or a
        // leftover auth.json entry must never silently revive it.
        if (state.providers[providerId]?.mode === "revoked") continue;
        const previous = this.backend!.getSync(this.backendKey(providerId));
        previousCredentials.set(providerId, previous);
        if (previous !== undefined) {
          const stored = parseStoredCredential(
            providerId,
            previous,
            `${this.backend!.kind} credential backend`,
          );
          const source = legacy[providerId]!;
          if (
            stored.type !== source.type ||
            stored.access !== source.access ||
            stored.refresh !== source.refresh ||
            stored.expiresAt !== source.expiresAt
          ) {
            throw new Error(`Credential migration conflict for ${providerId}`);
          }
        }
      }

      const migratedProviderIds = new Set<string>();
      let destinationMustBeRetained = false;
      try {
        for (const providerId of historicalProviderIds) {
          if (state.providers[providerId] !== undefined) continue;
          const metadata = historicalIndex.credentials[providerId]!;
          state.providers[providerId] = {
            mode: "backend-authoritative",
            type: metadata.type,
            expiresAt: metadata.expiresAt!,
          };
          migratedProviderIds.add(providerId);
        }
        for (const providerId of legacyProviderIds) {
          if (state.providers[providerId]?.mode === "revoked") continue;
          const credential = legacy[providerId]!;
          if (previousCredentials.get(providerId) === undefined) {
            this.backend!.putSync(this.backendKey(providerId), JSON.stringify(credential));
          }
          state.providers[providerId] = {
            mode: "backend-authoritative",
            type: credential.type,
            expiresAt: credential.expiresAt,
          };
          migratedProviderIds.add(providerId);
        }
        try {
          await this.writeState(state);
          destinationMustBeRetained = true;
        } catch (error) {
          if (
            error instanceof AuthStorePersistenceError &&
            error.target === "state-file" &&
            error.outcome === "indeterminate"
          ) {
            destinationMustBeRetained = true;
          }
          throw error;
        }
        if (legacyProviderIds.length > 0) await this.writeAll({});
        if (previousIndex !== undefined) this.backend!.deleteSync(AUTH_INDEX_KEY);
      } catch (error) {
        if (destinationMustBeRetained) throw error;
        const rollbackErrors: unknown[] = [];
        for (const providerId of legacyProviderIds) {
          if (!previousCredentials.has(providerId)) continue;
          try {
            this.restoreBackendValue(
              this.backendKey(providerId),
              previousCredentials.get(providerId),
            );
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        this.rethrowWithRollback(error, rollbackErrors);
      }
      return { migratedProviderIds: [...migratedProviderIds].sort() };
    });
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
}

async function readLockOwner(lock: string): Promise<CredentialLockOwner | undefined> {
  let serialized: string;
  try {
    serialized = await fs.readFile(lock, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new Error(`Credential store lock metadata is invalid: ${lock}`, { cause: error });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Credential store lock metadata is invalid: ${lock}`);
  }
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record["pid"]) ||
    (record["pid"] as number) <= 0 ||
    typeof record["token"] !== "string" ||
    record["token"].length < 16 ||
    Object.keys(record).some((key) => key !== "pid" && key !== "token")
  ) {
    throw new Error(`Credential store lock metadata is invalid: ${lock}`);
  }
  return { pid: record["pid"] as number, token: record["token"] };
}

async function removeLockIfOwned(lock: string, token: string): Promise<void> {
  const current = await readLockOwner(lock);
  if (current?.token === token) await fs.rm(lock, { force: true });
}

function reportLockCleanupFailure(
  lock: string,
  operationCompleted: boolean,
  failureCount: number,
): void {
  const status = operationCompleted
    ? "Credential store mutation completed successfully"
    : "Credential store mutation failed";
  try {
    process.emitWarning(
      `${status}, but ${failureCount} lock cleanup step(s) failed: ${lock}. ` +
        "Future writers may time out; stop all writers before manually removing the abandoned lock",
      {
        type: "AuthStoreLockCleanupWarning",
        code: "ANICODE_AUTH_LOCK_CLEANUP_FAILED",
      },
    );
  } catch {
    // Diagnostics must never alter the already-determined mutation outcome.
  }
}
