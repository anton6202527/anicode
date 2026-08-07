/** 长期密钥后端：OS Keychain、Vault KV v2、AWS KMS envelope 与 OIDC。 */

import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
  type KMSClientConfig,
} from "@aws-sdk/client-kms";
import {
  credentialFetch,
  credentialIoLimit,
  credentialRequestTimeout,
  credentialResponseLimit,
  discardCredentialResponse,
  readCredentialJson,
  safeCredentialError,
  withCredentialDeadline,
  type CredentialIoOptions,
} from "./credential-io.js";

const DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_TOKEN_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_VAULT_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_KMS_RESPONSE_BYTES = 64 * 1024;
const MAX_KMS_PLAINTEXT_BYTES = 4 * 1024;
const MAX_OIDC_TOKEN_BYTES = 128 * 1024;
const MAX_VAULT_TOKEN_LEASE_SECONDS = 24 * 60 * 60;
const DEFAULT_OS_KEYCHAIN_TIMEOUT_MS = 10_000;
const MAX_OS_KEYCHAIN_TIMEOUT_MS = 60_000;
const MAX_OS_KEYCHAIN_SECRET_BYTES = 1024 * 1024;
const MAX_OS_KEYCHAIN_PROTOCOL_BYTES = 8 * 1024 * 1024;
const MAX_OS_KEYCHAIN_MODULE_PATH_BYTES = 4096;

export type OsKeychainMutationFailureReason =
  "cancelled" | "failed" | "invalid-response" | "response-too-large" | "timed-out";

const OS_KEYCHAIN_HELPER_SOURCE = String.raw`
"use strict";
const { createRequire } = require("node:module");
const path = require("node:path");

const MAX_SECRET_BYTES = 1024 * 1024;
const MAX_PROTOCOL_BYTES = 8 * 1024 * 1024;
const MAX_MODULE_PATH_BYTES = 4096;
const SERVICE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function write(response) {
  const output = Buffer.from(JSON.stringify(response), "utf8");
  if (output.byteLength > MAX_PROTOCOL_BYTES) {
    process.stdout.write(JSON.stringify({ version: 1, ok: false, code: "response_too_large" }));
    return;
  }
  process.stdout.write(output);
}

async function readRequest() {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.byteLength;
    if (total > MAX_PROTOCOL_BYTES) throw new Error("invalid request");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks, total).toString("utf8"));
}

function validRequest(request) {
  if (!request || typeof request !== "object" || request.version !== 1) return false;
  if (
    typeof request.service !== "string" ||
    Buffer.byteLength(request.service, "utf8") > 512 ||
    !SERVICE_PATTERN.test(request.service) ||
    typeof request.key !== "string" ||
    !KEY_PATTERN.test(request.key)
  ) return false;
  if (
    typeof request.modulePath !== "string" ||
    Buffer.byteLength(request.modulePath, "utf8") > MAX_MODULE_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(request.modulePath) ||
    !path.isAbsolute(request.modulePath) ||
    ![".cjs", ".js"].includes(path.extname(request.modulePath).toLowerCase())
  ) return false;
  if (!["get", "put", "delete"].includes(request.operation)) return false;
  if (request.operation === "put") {
    return (
      typeof request.value === "string" &&
      request.value.length > 0 &&
      Buffer.byteLength(request.value, "utf8") <= MAX_SECRET_BYTES
    );
  }
  return request.value === undefined;
}

(async () => {
  let request;
  try {
    request = await readRequest();
    if (!validRequest(request)) {
      write({ version: 1, ok: false, code: "invalid_request" });
      return;
    }
    const load = createRequire(request.modulePath);
    const keyring = load(request.modulePath);
    if (!keyring || typeof keyring.Entry !== "function") throw new Error("native backend unavailable");
    const entry = new keyring.Entry(request.service, request.key);
    if (request.operation === "get") {
      const value = entry.getPassword();
      if (value === null || value === undefined) {
        write({ version: 1, ok: true, operation: "get", found: false });
        return;
      }
      if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) {
        write({ version: 1, ok: false, code: "response_too_large" });
        return;
      }
      write({ version: 1, ok: true, operation: "get", found: true, value });
      return;
    }
    if (request.operation === "put") {
      entry.setPassword(request.value);
      request.value = "";
      write({ version: 1, ok: true, operation: "put" });
      return;
    }
    const deleted = entry.deleteCredential();
    write({ version: 1, ok: true, operation: "delete", deleted: deleted === true });
  } catch {
    if (request && typeof request === "object" && "value" in request) request.value = "";
    write({ version: 1, ok: false, code: "operation_failed" });
  }
})().catch(() => {
  write({ version: 1, ok: false, code: "operation_failed" });
});
`;

/**
 * Hard safety switch for tests, hermetic builds and hosts that must never touch the user's
 * operating-system credential store. This is deliberately checked by the backend itself rather
 * than only by composition code: a forgotten test override must fail before a native Keychain API
 * is called.
 */
export const OS_KEYCHAIN_DISABLED_ENV = "ANICODE_DISABLE_OS_KEYCHAIN";

export class OsKeychainDisabledError extends Error {
  constructor() {
    super(`${OS_KEYCHAIN_DISABLED_ENV}=1 forbids access to the operating-system credential store`);
    this.name = "OsKeychainDisabledError";
  }
}

/** A Keychain mutation may have committed even when its isolated helper did not return proof. */
export class OsKeychainMutationError extends Error {
  readonly outcome = "indeterminate" as const;

  constructor(
    readonly operation: "put" | "delete",
    readonly reason: OsKeychainMutationFailureReason,
    timeoutMs: number,
  ) {
    const action = operation === "put" ? "write" : "delete";
    const detail =
      reason === "cancelled"
        ? "was cancelled"
        : reason === "timed-out"
          ? `timed out after ${timeoutMs}ms`
          : "lost completion proof";
    super(`OS Keychain ${action} ${detail}; mutation outcome is indeterminate`);
    this.name = "OsKeychainMutationError";
  }
}

function assertOsKeychainEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (env[OS_KEYCHAIN_DISABLED_ENV] === "1") {
    throw new OsKeychainDisabledError();
  }
}

export interface SecretBackend {
  readonly kind: string;
  /** Stable, non-secret coordination namespace shared by wrappers targeting the same store. */
  readonly credentialNamespace?: string;
  /** Conservative physical-target identity used only for broker coordination, never for I/O. */
  credentialTargetKey?(key: string): string;
  get(key: string, signal?: AbortSignal): Promise<string | undefined>;
  put(key: string, value: string, signal?: AbortSignal): Promise<void>;
  delete(key: string, signal?: AbortSignal): Promise<boolean>;
  list?(signal?: AbortSignal): Promise<string[]>;
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

function throwIfCredentialAborted(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) throw safeCredentialError(`${label} was cancelled`);
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.+$/, "");
  return (
    normalized === "localhost" || normalized === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function normalizedVaultAddress(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Vault address is invalid");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("Vault address must be a credential-free HTTP(S) URL");
  }
  if (url.protocol === "http:" && !isExplicitLoopbackHostname(url.hostname)) {
    throw new Error("Vault address must use HTTPS unless it is an explicit loopback address");
  }
  return url.toString().replace(/\/+$/, "");
}

function vaultPathSegments(value: string, label: string): readonly string[] {
  const normalized = value.replace(/^\/+|\/+$/g, "");
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 4_096) {
    throw new Error(`${label} must be a non-empty path of at most 4096 bytes`);
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment, "utf8") > 255 ||
        /[\u0000-\u001f\u007f]/u.test(segment),
    )
  ) {
    throw new Error(
      `${label} must contain bounded non-empty segments without dot traversal or controls`,
    );
  }
  return Object.freeze(segments);
}

function normalizedVaultNamespace(value: string | undefined): string | undefined {
  return value === undefined ? undefined : vaultPathSegments(value, "Vault namespace").join("/");
}

function boundedCredentialSetting(value: string, label: string, maximumBytes = 4_096): string {
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > maximumBytes ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${label} must be a bounded non-empty string without controls`);
  }
  return value;
}

async function readBoundedFile(
  target: string,
  maximumBytes: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<string> {
  throwIfCredentialAborted(signal, label);
  const handle = await fs.open(target, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} path is not a regular file`);
    if (stat.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    throwIfCredentialAborted(signal, label);
    const data = Buffer.alloc(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < data.byteLength) {
      const item = await handle.read(data, bytesRead, data.byteLength - bytesRead, bytesRead);
      if (item.bytesRead === 0) break;
      bytesRead += item.bytesRead;
      throwIfCredentialAborted(signal, label);
    }
    if (bytesRead > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    throwIfCredentialAborted(signal, label);
    return data.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

type OsKeychainOperation = "get" | "put" | "delete";

interface OsKeychainRequest {
  version: 1;
  operation: OsKeychainOperation;
  modulePath: string;
  service: string;
  key: string;
  value?: string;
}

interface OsKeychainRunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  signal?: AbortSignal;
}

export interface OsKeychainProcessRunner {
  runSync(input: Uint8Array, options: OsKeychainRunOptions): Uint8Array;
  run(input: Uint8Array, options: OsKeychainRunOptions): Promise<Uint8Array>;
}

export interface OsKeychainChildProcessRunnerOptions {
  /** @internal Test-only helper override. Production always uses the audited inline helper. */
  helperSource?: string;
  /** @internal Test-only executable override. */
  executable?: string;
  /** @internal Test-only environment source; only an audited subset is inherited. */
  environment?: NodeJS.ProcessEnv;
  /** @internal Test-only working directory override. */
  workingDirectory?: string;
}

type OsKeychainBoundaryFailure = OsKeychainMutationFailureReason;

class OsKeychainBoundaryError extends Error {
  constructor(readonly failure: OsKeychainBoundaryFailure) {
    super("OS Keychain subprocess boundary failed");
    this.name = "OsKeychainBoundaryError";
  }
}

function osKeychainChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  // Never inherit NODE_OPTIONS, NODE_PATH, application tokens, cloud credentials, or arbitrary
  // preload hooks. These variables are the minimum needed by native credential services and OS
  // user/session discovery across macOS, Linux and Windows.
  for (const name of [
    "APPDATA",
    "ComSpec",
    "DBUS_SESSION_BUS_ADDRESS",
    "DISPLAY",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "WAYLAND_DISPLAY",
    "WINDIR",
    "XDG_RUNTIME_DIR",
  ]) {
    const sourceName =
      source[name] !== undefined
        ? name
        : Object.keys(source).find((candidate) => candidate.toUpperCase() === name.toUpperCase());
    const value = sourceName === undefined ? undefined : source[sourceName];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * Native keyring execution boundary. The audited helper source is process metadata, while service,
 * key and value are sent only through stdin. `SIGKILL` is intentional: spawnSync otherwise waits
 * forever when a timed-out child handles SIGTERM without exiting.
 */
export class OsKeychainChildProcessRunner implements OsKeychainProcessRunner {
  private readonly executable: string;
  private readonly helperSource: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly workingDirectory: string;

  constructor(options: OsKeychainChildProcessRunnerOptions = {}) {
    this.executable = options.executable ?? process.execPath;
    this.helperSource = options.helperSource ?? OS_KEYCHAIN_HELPER_SOURCE;
    this.environment = osKeychainChildEnvironment(options.environment ?? process.env);
    this.workingDirectory = options.workingDirectory ?? path.dirname(this.executable);
  }

  runSync(input: Uint8Array, options: OsKeychainRunOptions): Uint8Array {
    const timeoutMs = osKeychainTimeout(options.timeoutMs);
    const maxOutputBytes = credentialIoLimit(
      options.maxOutputBytes,
      MAX_OS_KEYCHAIN_PROTOCOL_BYTES,
      "OS Keychain helper output limit",
      MAX_OS_KEYCHAIN_PROTOCOL_BYTES,
    );
    if (input.byteLength > MAX_OS_KEYCHAIN_PROTOCOL_BYTES) {
      throw new OsKeychainBoundaryError("response-too-large");
    }
    const result = spawnSync(this.executable, ["--eval", this.helperSource], {
      cwd: this.workingDirectory,
      env: this.environment,
      input,
      encoding: "buffer",
      killSignal: "SIGKILL",
      maxBuffer: maxOutputBytes,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ETIMEDOUT") throw new OsKeychainBoundaryError("timed-out");
    if (code === "ENOBUFS") throw new OsKeychainBoundaryError("response-too-large");
    if (result.error || result.status !== 0 || result.signal) {
      throw new OsKeychainBoundaryError("failed");
    }
    if (!(result.stdout instanceof Uint8Array) || result.stdout.byteLength > maxOutputBytes) {
      throw new OsKeychainBoundaryError("response-too-large");
    }
    return result.stdout;
  }

  run(input: Uint8Array, options: OsKeychainRunOptions): Promise<Uint8Array> {
    const timeoutMs = osKeychainTimeout(options.timeoutMs);
    const maxOutputBytes = credentialIoLimit(
      options.maxOutputBytes,
      MAX_OS_KEYCHAIN_PROTOCOL_BYTES,
      "OS Keychain helper output limit",
      MAX_OS_KEYCHAIN_PROTOCOL_BYTES,
    );
    if (input.byteLength > MAX_OS_KEYCHAIN_PROTOCOL_BYTES) {
      return Promise.reject(new OsKeychainBoundaryError("response-too-large"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new OsKeychainBoundaryError("cancelled"));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const child = spawn(this.executable, ["--eval", this.helperSource], {
        cwd: this.workingDirectory,
        env: this.environment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let failure: OsKeychainBoundaryFailure | undefined;
      let spawnFailed = false;
      let inputFailed = false;
      const fail = (reason: OsKeychainBoundaryFailure) => {
        if (!failure) failure = reason;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close/error event below is still the only completion proof exposed to the caller.
        }
      };
      const onAbort = () => fail("cancelled");
      const timer = setTimeout(() => fail("timed-out"), timeoutMs);
      timer.unref();
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > maxOutputBytes) {
          fail("response-too-large");
          return;
        }
        stdout.push(chunk);
      });
      // Drain but never retain or surface native stderr; it may contain platform diagnostics.
      child.stderr.resume();
      child.stdin.on("error", () => {
        inputFailed = true;
        fail("failed");
      });
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (failure) {
          for (const chunk of stdout) chunk.fill(0);
          reject(new OsKeychainBoundaryError(failure));
        } else if (spawnFailed || inputFailed || code !== 0 || signal) {
          for (const chunk of stdout) chunk.fill(0);
          reject(new OsKeychainBoundaryError("failed"));
        } else {
          const output = Buffer.concat(stdout, stdoutBytes);
          for (const chunk of stdout) chunk.fill(0);
          resolve(output);
        }
      });
      child.stdin.end(input);
    });
  }
}

export interface OsKeychainSecretBackendOptions {
  timeoutMs?: number;
  /**
   * Trusted absolute path to the @napi-rs/keyring JavaScript loader. Packaged hosts should pass
   * their bundled copy explicitly; this value is process metadata and never comes from model or
   * project input.
   */
  modulePath?: string;
  /** @internal Injectable process boundary for protocol-only tests. */
  runner?: OsKeychainProcessRunner;
}

function validKeychainService(service: string): string {
  if (
    !service ||
    Buffer.byteLength(service, "utf8") > 512 ||
    /[\u0000-\u001f\u007f]/u.test(service)
  ) {
    throw new Error("Invalid OS Keychain service name");
  }
  return service;
}

function osKeychainTimeout(value: number | undefined): number {
  return credentialIoLimit(
    value,
    DEFAULT_OS_KEYCHAIN_TIMEOUT_MS,
    "OS Keychain timeout",
    MAX_OS_KEYCHAIN_TIMEOUT_MS,
  );
}

function validOsKeychainModulePath(modulePath: string): string {
  if (
    !path.isAbsolute(modulePath) ||
    Buffer.byteLength(modulePath, "utf8") > MAX_OS_KEYCHAIN_MODULE_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(modulePath) ||
    ![".cjs", ".js"].includes(path.extname(modulePath).toLowerCase())
  ) {
    throw new Error("Invalid OS Keychain module path");
  }
  return path.normalize(modulePath);
}

/** Resolve package metadata only; this does not load the native module or open the Keychain. */
function resolveDefaultOsKeychainModulePath(): string {
  const moduleFilename =
    typeof __filename === "string" && path.isAbsolute(__filename)
      ? __filename
      : path.resolve(process.argv[1] ?? path.join(process.cwd(), "anicode-keyring-resolver.cjs"));
  try {
    return validOsKeychainModulePath(createRequire(moduleFilename).resolve("@napi-rs/keyring"));
  } catch {
    throw safeCredentialError(
      "OS Keychain native backend is unavailable; packaged hosts must provide its module path",
    );
  }
}

function encodeOsKeychainRequest(request: OsKeychainRequest): Buffer {
  const encoded = Buffer.from(JSON.stringify(request), "utf8");
  if (encoded.byteLength > MAX_OS_KEYCHAIN_PROTOCOL_BYTES) {
    encoded.fill(0);
    throw safeCredentialError("OS Keychain request exceeds the subprocess protocol limit");
  }
  return encoded;
}

function decodeOsKeychainResponse(
  operation: OsKeychainOperation,
  output: Uint8Array,
): string | boolean | undefined {
  if (output.byteLength === 0 || output.byteLength > MAX_OS_KEYCHAIN_PROTOCOL_BYTES) {
    throw new OsKeychainBoundaryError("invalid-response");
  }
  let response: unknown;
  try {
    response = JSON.parse(Buffer.from(output).toString("utf8"));
  } catch {
    throw new OsKeychainBoundaryError("invalid-response");
  }
  if (!response || typeof response !== "object") {
    throw new OsKeychainBoundaryError("invalid-response");
  }
  const record = response as Record<string, unknown>;
  if (record["version"] !== 1 || record["ok"] !== true || record["operation"] !== operation) {
    if (record["version"] === 1 && record["ok"] === false) {
      throw new OsKeychainBoundaryError(
        record["code"] === "response_too_large" ? "response-too-large" : "failed",
      );
    }
    throw new OsKeychainBoundaryError("invalid-response");
  }
  if (operation === "get") {
    if (record["found"] === false && record["value"] === undefined) return undefined;
    if (
      record["found"] !== true ||
      typeof record["value"] !== "string" ||
      Buffer.byteLength(record["value"], "utf8") > MAX_OS_KEYCHAIN_SECRET_BYTES
    ) {
      throw new OsKeychainBoundaryError("invalid-response");
    }
    return record["value"];
  }
  if (operation === "put") return undefined;
  if (typeof record["deleted"] !== "boolean") {
    throw new OsKeychainBoundaryError("invalid-response");
  }
  return record["deleted"];
}

function safeOsKeychainFailure(
  error: unknown,
  operation: OsKeychainOperation,
  timeoutMs: number,
): Error {
  const action = operation === "get" ? "read" : operation === "put" ? "write" : "delete";
  if (operation !== "get") {
    return new OsKeychainMutationError(
      operation,
      error instanceof OsKeychainBoundaryError ? error.failure : "failed",
      timeoutMs,
    );
  }
  if (error instanceof OsKeychainBoundaryError) {
    if (error.failure === "cancelled") {
      return safeCredentialError(`OS Keychain ${action} was cancelled`);
    }
    if (error.failure === "timed-out") {
      return safeCredentialError(`OS Keychain ${action} timed out after ${timeoutMs}ms`);
    }
    if (error.failure === "response-too-large") {
      return safeCredentialError("OS Keychain helper response exceeded its size limit");
    }
    if (error.failure === "invalid-response") {
      return safeCredentialError("OS Keychain helper returned an invalid response");
    }
  }
  return safeCredentialError(`OS Keychain ${action} failed`);
}

/** macOS Keychain / Linux Secret Service / Windows Credential Vault。 */
export class OsKeychainSecretBackend implements SyncSecretBackend {
  readonly kind = "os-keychain";
  readonly service: string;
  readonly credentialNamespace: string;
  private readonly timeoutMs: number;
  private readonly runner: OsKeychainProcessRunner;
  private readonly modulePath: string;

  constructor(service = "dev.anicode.credentials", options: OsKeychainSecretBackendOptions = {}) {
    assertOsKeychainEnabled();
    this.service = validKeychainService(service);
    this.credentialNamespace = JSON.stringify([this.kind, this.service]);
    this.timeoutMs = osKeychainTimeout(options.timeoutMs);
    const configuredModulePath = options.modulePath;
    this.modulePath =
      configuredModulePath === undefined
        ? resolveDefaultOsKeychainModulePath()
        : validOsKeychainModulePath(configuredModulePath);
    this.runner = options.runner ?? new OsKeychainChildProcessRunner();
  }

  private request(operation: OsKeychainOperation, key: string, value?: string): Buffer {
    assertOsKeychainEnabled();
    const request: OsKeychainRequest = {
      version: 1,
      operation,
      modulePath: this.modulePath,
      service: this.service,
      key: validKey(key),
      ...(value !== undefined ? { value } : {}),
    };
    return encodeOsKeychainRequest(request);
  }

  private invokeSync(
    operation: OsKeychainOperation,
    key: string,
    value?: string,
  ): string | boolean | undefined {
    const input = this.request(operation, key, value);
    let output: Uint8Array | undefined;
    try {
      output = this.runner.runSync(input, {
        timeoutMs: this.timeoutMs,
        maxOutputBytes: MAX_OS_KEYCHAIN_PROTOCOL_BYTES,
      });
      return decodeOsKeychainResponse(operation, output);
    } catch (error) {
      throw safeOsKeychainFailure(error, operation, this.timeoutMs);
    } finally {
      input.fill(0);
      if (output) Buffer.from(output.buffer, output.byteOffset, output.byteLength).fill(0);
    }
  }

  private async invoke(
    operation: OsKeychainOperation,
    key: string,
    value: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<string | boolean | undefined> {
    const action = operation === "get" ? "read" : operation === "put" ? "write" : "delete";
    throwIfCredentialAborted(signal, `OS Keychain ${action}`);
    const input = this.request(operation, key, value);
    let output: Uint8Array | undefined;
    try {
      output = await this.runner.run(input, {
        timeoutMs: this.timeoutMs,
        maxOutputBytes: MAX_OS_KEYCHAIN_PROTOCOL_BYTES,
        ...(signal ? { signal } : {}),
      });
      return decodeOsKeychainResponse(operation, output);
    } catch (error) {
      throw safeOsKeychainFailure(error, operation, this.timeoutMs);
    } finally {
      input.fill(0);
      if (output) Buffer.from(output.buffer, output.byteOffset, output.byteLength).fill(0);
    }
  }

  getSync(key: string): string | undefined {
    const value = this.invokeSync("get", key);
    return typeof value === "string" ? value : undefined;
  }
  putSync(key: string, value: string): void {
    if (!value) throw new Error("Secret value cannot be empty");
    if (Buffer.byteLength(value, "utf8") > MAX_OS_KEYCHAIN_SECRET_BYTES) {
      throw new Error(`Secret value exceeds ${MAX_OS_KEYCHAIN_SECRET_BYTES} bytes`);
    }
    this.invokeSync("put", key, value);
  }
  deleteSync(key: string): boolean {
    return this.invokeSync("delete", key) === true;
  }
  async get(key: string, signal?: AbortSignal): Promise<string | undefined> {
    const value = await this.invoke("get", key, undefined, signal);
    return typeof value === "string" ? value : undefined;
  }
  async put(key: string, value: string, signal?: AbortSignal): Promise<void> {
    if (!value) throw new Error("Secret value cannot be empty");
    if (Buffer.byteLength(value, "utf8") > MAX_OS_KEYCHAIN_SECRET_BYTES) {
      throw new Error(`Secret value exceeds ${MAX_OS_KEYCHAIN_SECRET_BYTES} bytes`);
    }
    await this.invoke("put", key, value, signal);
  }
  async delete(key: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.invoke("delete", key, undefined, signal)) === true;
  }
}

export type OidcTokenProvider = (audience?: string, signal?: AbortSignal) => Promise<string>;

/** GitHub Actions 的 OIDC request-token 协议；返回短期 id_token，不落盘。 */
export function githubActionsOidcProvider(
  env: NodeJS.ProcessEnv = process.env,
  doFetch: typeof fetch = fetch,
  options: Omit<CredentialIoOptions, "signal"> = {},
): OidcTokenProvider {
  const requestTimeoutMs = credentialRequestTimeout(
    options.requestTimeoutMs,
    DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS,
  );
  const maxResponseBytes = credentialResponseLimit(
    options.maxResponseBytes,
    DEFAULT_TOKEN_RESPONSE_BYTES,
  );
  return async (audience, signal) => {
    const requestUrl = env["ACTIONS_ID_TOKEN_REQUEST_URL"];
    const requestToken = env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
    if (!requestUrl || !requestToken) throw new Error("GitHub Actions OIDC is unavailable");
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      throw safeCredentialError("OIDC token request URL is invalid");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw safeCredentialError("OIDC token request URL must be credential-free HTTPS");
    }
    if (audience) url.searchParams.set("audience", audience);
    return credentialFetch(
      {
        label: "OIDC token request",
        fetch: doFetch,
        input: url,
        init: { headers: { authorization: `Bearer ${requestToken}` } },
        requestTimeoutMs,
        maxResponseBytes,
        ...(signal ? { signal } : {}),
      },
      async (response, requestSignal, maximumBytes) => {
        if (!response.ok) {
          discardCredentialResponse(response, "OIDC token request rejected");
          throw safeCredentialError(`OIDC token request failed: HTTP ${response.status}`);
        }
        const body = await readCredentialJson<{ value?: unknown }>(
          response,
          maximumBytes,
          requestSignal,
          "OIDC token request",
        );
        if (typeof body.value !== "string" || !body.value) {
          throw safeCredentialError("OIDC token response did not contain value");
        }
        if (Buffer.byteLength(body.value, "utf8") > MAX_OIDC_TOKEN_BYTES) {
          throw safeCredentialError(`OIDC token exceeds ${MAX_OIDC_TOKEN_BYTES} bytes`);
        }
        return body.value;
      },
    );
  };
}

/** Kubernetes projected service-account token / generic workload identity token file。 */
export function oidcTokenFileProvider(
  file: string,
  options: { maxTokenBytes?: number } = {},
): OidcTokenProvider {
  const target = path.resolve(file);
  const maxTokenBytes = credentialIoLimit(
    options.maxTokenBytes,
    DEFAULT_TOKEN_RESPONSE_BYTES,
    "OIDC token file size limit",
    4 * 1024 * 1024,
  );
  return async (_audience, signal) => {
    const token = (await readBoundedFile(target, maxTokenBytes, signal, "OIDC token file")).trim();
    if (!token) throw new Error(`OIDC token file is empty: ${target}`);
    return token;
  };
}

export interface VaultTokenProvider {
  token(signal?: AbortSignal): Promise<string>;
}

export class StaticVaultTokenProvider implements VaultTokenProvider {
  constructor(private readonly value: string) {}
  async token(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw safeCredentialError("Vault token request was cancelled");
    if (!this.value) throw new Error("Vault token is empty");
    return this.value;
  }
}

/** Vault JWT/OIDC auth，token 在 TTL 内复用并在过期前刷新。 */
export class VaultJwtTokenProvider implements VaultTokenProvider {
  private cached: { value: string; expiresAt: number } | undefined;
  private refreshing: Promise<string> | undefined;
  private readonly address: string;
  private readonly role: string;
  private readonly oidc: OidcTokenProvider;
  private readonly mountSegments: readonly string[];
  private readonly namespace: string | undefined;
  private readonly audience?: string;
  private readonly doFetch: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(options: {
    address: string;
    role: string;
    oidc: OidcTokenProvider;
    mount?: string;
    namespace?: string;
    audience?: string;
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
  }) {
    this.address = normalizedVaultAddress(options.address);
    this.role = boundedCredentialSetting(options.role, "Vault JWT role");
    this.oidc = options.oidc;
    this.mountSegments = vaultPathSegments(options.mount ?? "jwt", "Vault JWT mount");
    this.namespace = normalizedVaultNamespace(options.namespace);
    if (options.audience !== undefined) {
      this.audience = boundedCredentialSetting(options.audience, "Vault JWT audience");
    }
    this.doFetch = options.fetch ?? fetch;
    this.requestTimeoutMs = credentialRequestTimeout(
      options.requestTimeoutMs,
      DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS,
    );
    this.maxResponseBytes = credentialResponseLimit(
      options.maxResponseBytes,
      DEFAULT_TOKEN_RESPONSE_BYTES,
    );
  }

  async token(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw safeCredentialError("Vault token request was cancelled");
    if (this.cached && this.cached.expiresAt - 30_000 > Date.now()) return this.cached.value;
    const refresh = this.refreshing ?? this.startRefresh(this.requestTimeoutMs);
    // The shared login owns its deadline. A single caller may stop waiting without cancelling the
    // OIDC/Vault operation needed by other concurrent callers.
    return withCredentialDeadline(
      "Vault JWT login",
      this.requestTimeoutMs,
      signal,
      async () => refresh,
    );
  }

  private startRefresh(requestTimeoutMs: number): Promise<string> {
    const refresh = this.refreshToken(requestTimeoutMs).finally(() => {
      if (this.refreshing === refresh) this.refreshing = undefined;
    });
    this.refreshing = refresh;
    return refresh;
  }

  private refreshToken(requestTimeoutMs: number): Promise<string> {
    return withCredentialDeadline(
      "Vault JWT login",
      requestTimeoutMs,
      undefined,
      async (requestSignal) => {
        const jwt = await this.oidc(this.audience, requestSignal);
        return credentialFetch(
          {
            label: "Vault JWT login",
            fetch: this.doFetch,
            input: `${this.address}/v1/auth/${this.mountSegments
              .map((segment) => encodeURIComponent(segment))
              .join("/")}/login`,
            init: {
              method: "POST",
              headers: {
                "content-type": "application/json",
                ...(this.namespace ? { "x-vault-namespace": this.namespace } : {}),
              },
              body: JSON.stringify({ role: this.role, jwt }),
            },
            requestTimeoutMs,
            maxResponseBytes: this.maxResponseBytes,
            signal: requestSignal,
          },
          async (response, responseSignal, maximumBytes) => {
            if (!response.ok) {
              discardCredentialResponse(response, "Vault JWT login rejected");
              throw safeCredentialError(`Vault JWT login failed: HTTP ${response.status}`);
            }
            const body = await readCredentialJson<{
              auth?: { client_token?: unknown; lease_duration?: unknown };
            }>(response, maximumBytes, responseSignal, "Vault JWT login");
            if (typeof body.auth?.client_token !== "string" || !body.auth.client_token) {
              throw safeCredentialError("Vault JWT login returned no client token");
            }
            if (Buffer.byteLength(body.auth.client_token, "utf8") > MAX_OIDC_TOKEN_BYTES) {
              throw safeCredentialError(`Vault client token exceeds ${MAX_OIDC_TOKEN_BYTES} bytes`);
            }
            const leaseDuration = body.auth.lease_duration ?? 300;
            if (
              typeof leaseDuration !== "number" ||
              !Number.isFinite(leaseDuration) ||
              leaseDuration <= 0 ||
              leaseDuration > MAX_VAULT_TOKEN_LEASE_SECONDS
            ) {
              throw safeCredentialError("Vault JWT login returned an invalid lease duration");
            }
            this.cached = {
              value: body.auth.client_token,
              expiresAt: Date.now() + leaseDuration * 1_000,
            };
            return this.cached.value;
          },
        );
      },
    );
  }
}

export class VaultKvV2SecretBackend implements SecretBackend {
  readonly kind = "vault-kv-v2";
  readonly credentialNamespace: string;
  private readonly address: string;
  private readonly mountSegments: readonly string[];
  private readonly prefixSegments: readonly string[];
  private readonly token: (signal?: AbortSignal) => Promise<string>;
  private readonly namespace: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: {
    address: string;
    tokenProvider: VaultTokenProvider;
    mount?: string;
    prefix?: string;
    namespace?: string;
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
    maxResponseBytes?: number;
  }) {
    this.address = normalizedVaultAddress(options.address);
    this.mountSegments = vaultPathSegments(options.mount ?? "secret", "Vault KV mount");
    this.prefixSegments = vaultPathSegments(options.prefix ?? "anicode", "Vault KV prefix");
    this.token = options.tokenProvider.token.bind(options.tokenProvider);
    this.namespace = normalizedVaultNamespace(options.namespace);
    this.credentialNamespace = JSON.stringify([
      this.kind,
      this.address,
      this.mountSegments,
      this.prefixSegments,
      this.namespace ?? "",
    ]);
    this.doFetch = options.fetch ?? fetch;
    this.requestTimeoutMs = credentialRequestTimeout(
      options.requestTimeoutMs,
      DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS,
    );
    this.maxResponseBytes = credentialResponseLimit(
      options.maxResponseBytes,
      DEFAULT_VAULT_RESPONSE_BYTES,
    );
  }

  private target(kind: "data" | "metadata", key = ""): string {
    const segments = [
      ...this.mountSegments,
      kind,
      ...this.prefixSegments,
      ...(key ? [validKey(key)] : []),
    ];
    return `${this.address}/v1/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
  }

  private async request<T>(
    label: string,
    target: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    consume: (response: Response, signal: AbortSignal, maximumBytes: number) => Promise<T>,
  ): Promise<T> {
    return withCredentialDeadline(label, this.requestTimeoutMs, signal, async (requestSignal) => {
      const token = await this.token(requestSignal);
      return credentialFetch(
        {
          label,
          fetch: this.doFetch,
          input: target,
          init: {
            ...init,
            headers: {
              "x-vault-token": token,
              ...(this.namespace ? { "x-vault-namespace": this.namespace } : {}),
              ...init.headers,
            },
          },
          requestTimeoutMs: this.requestTimeoutMs,
          maxResponseBytes: this.maxResponseBytes,
          signal: requestSignal,
        },
        consume,
      );
    });
  }

  async get(key: string, signal?: AbortSignal): Promise<string | undefined> {
    return this.request(
      "Vault secret read",
      this.target("data", key),
      { method: "GET" },
      signal,
      async (response, responseSignal, maximumBytes) => {
        if (response.status === 404) {
          discardCredentialResponse(response, "Vault secret was not found");
          return undefined;
        }
        if (!response.ok) {
          discardCredentialResponse(response, "Vault secret read rejected");
          throw safeCredentialError(`Vault secret read failed: HTTP ${response.status}`);
        }
        const body = await readCredentialJson<{ data?: { data?: { value?: unknown } } }>(
          response,
          maximumBytes,
          responseSignal,
          "Vault secret read",
        );
        const value = body.data?.data?.value;
        return typeof value === "string" ? value : undefined;
      },
    );
  }

  async put(key: string, value: string, signal?: AbortSignal): Promise<void> {
    if (!value) throw new Error("Secret value cannot be empty");
    if (Buffer.byteLength(value, "utf8") > this.maxResponseBytes) {
      throw new Error(`Vault secret value exceeds ${this.maxResponseBytes} bytes`);
    }
    return this.request(
      "Vault secret write",
      this.target("data", key),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { value } }),
      },
      signal,
      async (response) => {
        discardCredentialResponse(response, "Vault secret write response is unused");
        if (!response.ok) {
          throw safeCredentialError(`Vault secret write failed: HTTP ${response.status}`);
        }
      },
    );
  }

  async delete(key: string, signal?: AbortSignal): Promise<boolean> {
    return this.request(
      "Vault secret delete",
      this.target("metadata", key),
      { method: "DELETE" },
      signal,
      async (response) => {
        discardCredentialResponse(response, "Vault secret delete response is unused");
        if (response.status === 404) return false;
        if (!response.ok) {
          throw safeCredentialError(`Vault secret delete failed: HTTP ${response.status}`);
        }
        return true;
      },
    );
  }

  async list(signal?: AbortSignal): Promise<string[]> {
    return this.request(
      "Vault secret list",
      this.target("metadata"),
      { method: "LIST" },
      signal,
      async (response, responseSignal, maximumBytes) => {
        if (response.status === 404) {
          discardCredentialResponse(response, "Vault secret list was not found");
          return [];
        }
        if (!response.ok) {
          discardCredentialResponse(response, "Vault secret list rejected");
          throw safeCredentialError(`Vault secret list failed: HTTP ${response.status}`);
        }
        const body = await readCredentialJson<{ data?: { keys?: unknown } }>(
          response,
          maximumBytes,
          responseSignal,
          "Vault secret list",
        );
        if (!Array.isArray(body.data?.keys)) return [];
        return body.data.keys
          .filter((key): key is string => typeof key === "string" && !key.endsWith("/"))
          .sort();
      },
    );
  }
}

export interface AwsKmsSecretBackendOptions {
  keyId: string;
  directory: string;
  region?: string;
  encryptionContext?: Record<string, string>;
  clientConfig?: KMSClientConfig;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  client?: KmsLikeClient;
}

export interface KmsLikeClient {
  send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown>;
}

/**
 * Resolve every existing path segment so differently-spelled/symlinked directories share one
 * broker target namespace. The final directory need not exist yet; its nearest existing ancestor
 * is canonicalized and the missing suffix is appended without creating anything at construction.
 */
function canonicalCredentialDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  let cursor = resolved;
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync.native(cursor), ...missingSegments.reverse());
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missingSegments.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

/**
 * KMS envelope-at-rest 后端。默认凭据链自动支持 AWS_WEB_IDENTITY_TOKEN_FILE +
 * AWS_ROLE_ARN（OIDC），磁盘只有 CiphertextBlob；明文只在一次 get/put 调用内存在。
 */
export class AwsKmsSecretBackend implements SecretBackend {
  readonly kind = "aws-kms";
  readonly credentialNamespace: string;
  private readonly client: KmsLikeClient;
  private readonly directory: string;
  private readonly keyId: string;
  private readonly encryptionContext: Readonly<Record<string, string>>;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;
  constructor(options: AwsKmsSecretBackendOptions) {
    this.directory = canonicalCredentialDirectory(options.directory);
    // The ciphertext file, not its encryption parameters, is the physical mutation target.
    // backendKey is tracked separately by CredentialBroker inside this directory namespace.
    this.credentialNamespace = JSON.stringify([this.kind, this.directory]);
    this.keyId = boundedCredentialSetting(options.keyId, "AWS KMS keyId");
    const encryptionContext: Record<string, string> = {};
    for (const [name, value] of Object.entries(options.encryptionContext ?? {})) {
      if (name === "service" || name === "credential") {
        throw new Error(`AWS KMS encryption context cannot override reserved field ${name}`);
      }
      encryptionContext[boundedCredentialSetting(name, "AWS KMS context name", 256)] =
        boundedCredentialSetting(value, "AWS KMS context value", 4_096);
    }
    this.encryptionContext = Object.freeze(encryptionContext);
    this.client =
      options.client ??
      new KMSClient({
        ...(options.region ? { region: options.region } : {}),
        ...options.clientConfig,
      });
    this.requestTimeoutMs = credentialRequestTimeout(
      options.requestTimeoutMs,
      DEFAULT_CREDENTIAL_REQUEST_TIMEOUT_MS,
    );
    this.maxResponseBytes = credentialResponseLimit(
      options.maxResponseBytes,
      DEFAULT_KMS_RESPONSE_BYTES,
    );
  }

  private file(key: string): string {
    return path.join(this.directory, `${encodeURIComponent(validKey(key))}.kms.json`);
  }

  credentialTargetKey(key: string): string {
    // Windows and common macOS volumes may collapse filename case. Coordinate conservatively on
    // every platform so a deployment cannot become unsafe when moved to a different filesystem.
    return validKey(key).normalize("NFC").toLowerCase();
  }

  private context(key: string): Record<string, string> {
    return { ...this.encryptionContext, service: "anicode", credential: key };
  }

  private send<T>(label: string, command: unknown, signal?: AbortSignal): Promise<T> {
    return withCredentialDeadline(
      label,
      this.requestTimeoutMs,
      signal,
      async (requestSignal) =>
        this.client.send(command, { abortSignal: requestSignal }) as Promise<T>,
    );
  }

  async get(key: string, signal?: AbortSignal): Promise<string | undefined> {
    let document: { version: 1; ciphertext: string };
    try {
      document = JSON.parse(
        await readBoundedFile(
          this.file(key),
          this.maxResponseBytes,
          signal,
          "KMS ciphertext document",
        ),
      ) as typeof document;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (
      !document ||
      typeof document !== "object" ||
      document.version !== 1 ||
      typeof document.ciphertext !== "string" ||
      !document.ciphertext ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(document.ciphertext)
    ) {
      throw new Error("Invalid KMS ciphertext document");
    }
    const ciphertext = Buffer.from(document.ciphertext, "base64");
    if (ciphertext.byteLength === 0) throw new Error("Invalid KMS ciphertext document");
    if (ciphertext.byteLength > this.maxResponseBytes) {
      throw new Error(`KMS ciphertext exceeds ${this.maxResponseBytes} bytes`);
    }
    const result = await this.send<{ Plaintext?: Uint8Array }>(
      "KMS decrypt",
      new DecryptCommand({
        CiphertextBlob: ciphertext,
        EncryptionContext: this.context(key),
      }),
      signal,
    );
    if (!(result.Plaintext instanceof Uint8Array)) {
      throw new Error("KMS decrypt returned no plaintext");
    }
    if (result.Plaintext.byteLength > MAX_KMS_PLAINTEXT_BYTES) {
      throw new Error(`KMS plaintext exceeds ${MAX_KMS_PLAINTEXT_BYTES} bytes`);
    }
    return Buffer.from(result.Plaintext).toString("utf8");
  }

  async put(key: string, value: string, signal?: AbortSignal): Promise<void> {
    if (!value) throw new Error("Secret value cannot be empty");
    const plaintext = Buffer.from(value, "utf8");
    if (plaintext.byteLength > MAX_KMS_PLAINTEXT_BYTES) {
      throw new Error(`KMS plaintext exceeds ${MAX_KMS_PLAINTEXT_BYTES} bytes`);
    }
    const result = await this.send<{ CiphertextBlob?: Uint8Array }>(
      "KMS encrypt",
      new EncryptCommand({
        KeyId: this.keyId,
        Plaintext: plaintext,
        EncryptionContext: this.context(key),
      }),
      signal,
    );
    if (!(result.CiphertextBlob instanceof Uint8Array)) {
      throw new Error("KMS encrypt returned no ciphertext");
    }
    if (result.CiphertextBlob.byteLength > this.maxResponseBytes) {
      throw new Error(`KMS ciphertext exceeds ${this.maxResponseBytes} bytes`);
    }
    throwIfCredentialAborted(signal, "KMS encrypt");
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

  async delete(key: string, signal?: AbortSignal): Promise<boolean> {
    throwIfCredentialAborted(signal, "KMS secret delete");
    try {
      await fs.unlink(this.file(key));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  async list(signal?: AbortSignal): Promise<string[]> {
    throwIfCredentialAborted(signal, "KMS secret list");
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

function optionalNumber(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name];
  return value === undefined ? undefined : Number(value);
}

/** 统一环境装配；环境只含地址/role/key id，密钥值始终来自 Keychain/Vault/KMS。 */
export async function configuredSecretBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<SecretBackend> {
  const kind = env.ANICODE_CREDENTIAL_BACKEND ?? "keychain";
  if (kind === "keychain") {
    assertOsKeychainEnabled(env);
    return new OsKeychainSecretBackend(env.ANICODE_KEYCHAIN_SERVICE ?? "dev.anicode.credentials");
  }
  if (kind === "vault") {
    const address = env.VAULT_ADDR;
    const role = env.ANICODE_VAULT_ROLE;
    if (!address || !role) throw new Error("VAULT_ADDR and ANICODE_VAULT_ROLE are required");
    const requestTimeoutMs = optionalNumber(env, "ANICODE_CREDENTIAL_REQUEST_TIMEOUT_MS");
    const maxResponseBytes = optionalNumber(env, "ANICODE_CREDENTIAL_MAX_RESPONSE_BYTES");
    const ioOptions = {
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
    };
    const oidc = env.ACTIONS_ID_TOKEN_REQUEST_URL
      ? githubActionsOidcProvider(env, fetch, ioOptions)
      : env.ANICODE_OIDC_TOKEN_FILE
        ? oidcTokenFileProvider(env.ANICODE_OIDC_TOKEN_FILE, {
            ...(maxResponseBytes !== undefined ? { maxTokenBytes: maxResponseBytes } : {}),
          })
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
        ...ioOptions,
        ...(env.VAULT_NAMESPACE ? { namespace: env.VAULT_NAMESPACE } : {}),
      }),
      mount: env.ANICODE_VAULT_KV_MOUNT ?? "secret",
      prefix: env.ANICODE_VAULT_PREFIX ?? "anicode",
      ...ioOptions,
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
    const requestTimeoutMs = optionalNumber(env, "ANICODE_CREDENTIAL_REQUEST_TIMEOUT_MS");
    const maxResponseBytes = optionalNumber(env, "ANICODE_CREDENTIAL_MAX_RESPONSE_BYTES");
    return new AwsKmsSecretBackend({
      keyId,
      directory: env.ANICODE_KMS_DIRECTORY ?? ".anicode/credentials",
      ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
      ...(maxResponseBytes !== undefined ? { maxResponseBytes } : {}),
      ...(env.AWS_REGION ? { region: env.AWS_REGION } : {}),
    });
  }
  throw new Error(`Unsupported ANICODE_CREDENTIAL_BACKEND: ${kind}`);
}
