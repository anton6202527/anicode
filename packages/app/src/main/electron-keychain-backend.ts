import * as path from "node:path";
import {
  OS_KEYCHAIN_DISABLED_ENV,
  OsKeychainDisabledError,
  OsKeychainMutationError,
  type SecretBackend,
} from "@anicode/core";
import {
  ELECTRON_KEYCHAIN_MAX_MESSAGE_BYTES,
  ELECTRON_KEYCHAIN_MAX_MODULE_PATH_BYTES,
  ELECTRON_KEYCHAIN_MAX_SECRET_BYTES,
  type ElectronKeychainOperation,
  type ElectronKeychainRequest,
} from "./keychain-utility-protocol.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

type UtilityEvent = "error" | "exit" | "message" | "spawn";
type UtilityListener = (...args: unknown[]) => void;

export interface ElectronKeychainUtilityProcess {
  readonly pid?: number;
  postMessage(message: unknown): void;
  kill(): boolean;
  once(event: UtilityEvent, listener: UtilityListener): unknown;
  removeListener(event: UtilityEvent, listener: UtilityListener): unknown;
}

export interface ElectronKeychainUtilityFactory {
  fork(
    modulePath: string,
    args: readonly string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      execArgv: readonly string[];
      serviceName: string;
      stdio: "ignore";
    },
  ): ElectronKeychainUtilityProcess;
}

export interface ElectronUtilityKeychainBackendOptions {
  service?: string;
  /** Trusted absolute path to the bundled one-shot utility entry. */
  helperPath: string;
  /** Trusted absolute path to the packaged @napi-rs/keyring JavaScript loader. */
  modulePath: string;
  utilityFactory: ElectronKeychainUtilityFactory;
  /** Real filesystem directory; ASAR virtual directories cannot be used as a child cwd. */
  workingDirectory?: string;
  timeoutMs?: number;
  environment?: NodeJS.ProcessEnv;
  /** @internal Prevents unit tests from sending a signal to a real PID. */
  forceKill?: (child: ElectronKeychainUtilityProcess) => void;
}

class ElectronKeychainBoundaryError extends Error {
  constructor(
    readonly reason:
      "cancelled" | "failed" | "invalid-response" | "response-too-large" | "timed-out",
  ) {
    super("Electron OS Keychain utility boundary failed");
    this.name = "ElectronKeychainBoundaryError";
  }
}

export class ElectronKeychainReadError extends Error {
  constructor(reason: ElectronKeychainBoundaryError["reason"], timeoutMs: number) {
    super(
      reason === "cancelled"
        ? "OS Keychain read was cancelled"
        : reason === "timed-out"
          ? `OS Keychain read timed out after ${timeoutMs}ms`
          : reason === "response-too-large"
            ? "OS Keychain helper response exceeded its size limit"
            : reason === "invalid-response"
              ? "OS Keychain helper returned an invalid response"
              : "OS Keychain read failed",
    );
    this.name = "ElectronKeychainReadError";
  }
}

function validTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new RangeError(`OS Keychain timeout must be an integer from 1 to ${MAX_TIMEOUT_MS}ms`);
  }
  return timeout;
}

function validService(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("Invalid OS Keychain service name");
  }
  return value;
}

function validKey(value: string): string {
  if (!KEY_PATTERN.test(value)) throw new Error("Invalid OS Keychain credential key");
  return value;
}

function validModulePath(value: string, label: string): string {
  if (
    !path.isAbsolute(value) ||
    Buffer.byteLength(value, "utf8") > ELECTRON_KEYCHAIN_MAX_MODULE_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    ![".cjs", ".js"].includes(path.extname(value).toLowerCase())
  ) {
    throw new Error(`Invalid ${label} path`);
  }
  return path.normalize(value);
}

function validWorkingDirectory(value: string): string {
  if (
    !path.isAbsolute(value) ||
    Buffer.byteLength(value, "utf8") > ELECTRON_KEYCHAIN_MAX_MODULE_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split(path.sep).some((segment) => segment.toLowerCase() === "app.asar")
  ) {
    throw new Error("Invalid OS Keychain utility working directory");
  }
  return path.normalize(value);
}

export function electronKeychainUtilityEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
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

function hardKillUtility(child: ElectronKeychainUtilityProcess): void {
  const pid = child.pid;
  if (pid !== undefined && child.pid === pid) {
    try {
      process.kill(pid, "SIGKILL");
      return;
    } catch {
      // The process may already have exited; let Electron reap or terminate its known child.
    }
  }
  try {
    child.kill();
  } catch {
    // Best effort after a boundary failure. The operation still fails closed.
  }
}

function encodedMessageSize(value: unknown): number {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  const size = encoded.byteLength;
  encoded.fill(0);
  return size;
}

/**
 * Electron-only asynchronous Keychain backend. Every explicit operation gets a fresh utility
 * process, so a native module that ignores cancellation can be force-terminated without enabling
 * the Electron RunAsNode fuse or loading the N-API module in the browser process.
 */
export class ElectronUtilityKeychainBackend implements SecretBackend {
  readonly kind = "os-keychain";
  readonly service: string;
  readonly credentialNamespace: string;
  private readonly helperPath: string;
  private readonly modulePath: string;
  private readonly utilityFactory: ElectronKeychainUtilityFactory;
  private readonly workingDirectory: string;
  private readonly timeoutMs: number;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly forceKill: (child: ElectronKeychainUtilityProcess) => void;
  private readonly active = new Map<ElectronKeychainUtilityProcess, () => void>();
  private closed = false;

  constructor(options: ElectronUtilityKeychainBackendOptions) {
    if (process.env[OS_KEYCHAIN_DISABLED_ENV] === "1") throw new OsKeychainDisabledError();
    this.service = validService(options.service ?? "dev.anicode.credentials");
    this.credentialNamespace = JSON.stringify([this.kind, this.service]);
    this.helperPath = validModulePath(options.helperPath, "OS Keychain utility helper");
    this.modulePath = validModulePath(options.modulePath, "OS Keychain module");
    this.utilityFactory = options.utilityFactory;
    this.workingDirectory = validWorkingDirectory(
      options.workingDirectory ?? path.dirname(process.execPath),
    );
    this.timeoutMs = validTimeout(options.timeoutMs);
    this.environment = electronKeychainUtilityEnvironment(options.environment ?? process.env);
    this.forceKill = options.forceKill ?? hardKillUtility;
  }

  async get(key: string, signal?: AbortSignal): Promise<string | undefined> {
    this.assertEnabled();
    try {
      const response = await this.invoke("get", key, undefined, signal);
      if (response["found"] === false && response["value"] === undefined) return undefined;
      if (
        response["found"] !== true ||
        typeof response["value"] !== "string" ||
        Buffer.byteLength(response["value"], "utf8") > ELECTRON_KEYCHAIN_MAX_SECRET_BYTES
      ) {
        throw new ElectronKeychainBoundaryError("invalid-response");
      }
      return response["value"];
    } catch (error) {
      throw new ElectronKeychainReadError(
        error instanceof ElectronKeychainBoundaryError ? error.reason : "failed",
        this.timeoutMs,
      );
    }
  }

  async put(key: string, value: string, signal?: AbortSignal): Promise<void> {
    this.assertEnabled();
    if (!value) throw new Error("Secret value cannot be empty");
    if (Buffer.byteLength(value, "utf8") > ELECTRON_KEYCHAIN_MAX_SECRET_BYTES) {
      throw new Error(`Secret value exceeds ${ELECTRON_KEYCHAIN_MAX_SECRET_BYTES} bytes`);
    }
    try {
      await this.invoke("put", key, value, signal);
    } catch (error) {
      throw new OsKeychainMutationError(
        "put",
        error instanceof ElectronKeychainBoundaryError ? error.reason : "failed",
        this.timeoutMs,
      );
    }
  }

  async delete(key: string, signal?: AbortSignal): Promise<boolean> {
    this.assertEnabled();
    try {
      const response = await this.invoke("delete", key, undefined, signal);
      if (typeof response["deleted"] !== "boolean") {
        throw new ElectronKeychainBoundaryError("invalid-response");
      }
      return response["deleted"];
    } catch (error) {
      throw new OsKeychainMutationError(
        "delete",
        error instanceof ElectronKeychainBoundaryError ? error.reason : "failed",
        this.timeoutMs,
      );
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of this.active.values()) cancel();
    this.active.clear();
  }

  private assertEnabled(): void {
    if (process.env[OS_KEYCHAIN_DISABLED_ENV] === "1") throw new OsKeychainDisabledError();
  }

  private invoke(
    operation: ElectronKeychainOperation,
    key: string,
    value: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new ElectronKeychainBoundaryError("failed"));
    if (process.env[OS_KEYCHAIN_DISABLED_ENV] === "1") {
      return Promise.reject(new OsKeychainDisabledError());
    }
    if (signal?.aborted) return Promise.reject(new ElectronKeychainBoundaryError("cancelled"));

    const request: ElectronKeychainRequest = {
      version: 1,
      operation,
      modulePath: this.modulePath,
      service: this.service,
      key: validKey(key),
      ...(value !== undefined ? { value } : {}),
    };
    if (encodedMessageSize(request) > ELECTRON_KEYCHAIN_MAX_MESSAGE_BYTES) {
      if (request.value !== undefined) request.value = "";
      return Promise.reject(new ElectronKeychainBoundaryError("response-too-large"));
    }

    let child: ElectronKeychainUtilityProcess;
    try {
      child = this.utilityFactory.fork(this.helperPath, [], {
        cwd: this.workingDirectory,
        env: this.environment,
        execArgv: [],
        serviceName: "AniCode OS Keychain boundary",
        stdio: "ignore",
      });
    } catch {
      if (request.value !== undefined) request.value = "";
      return Promise.reject(new ElectronKeychainBoundaryError("failed"));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.removeListener("spawn", onSpawn);
        child.removeListener("message", onMessage);
        child.removeListener("error", onFailure);
        child.removeListener("exit", onFailure);
        this.active.delete(child);
        if (request.value !== undefined) request.value = "";
      };
      const finish = (
        error: ElectronKeychainBoundaryError | undefined,
        response?: Record<string, unknown>,
        hardKill = false,
      ) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (hardKill) this.forceKill(child);
        else {
          try {
            child.kill();
          } catch {
            // Response already proves completion; process reaping is best effort.
          }
        }
        if (error) reject(error);
        else resolve(response!);
      };
      const onSpawn: UtilityListener = () => {
        try {
          child.postMessage(request);
          if (request.value !== undefined) request.value = "";
        } catch {
          finish(new ElectronKeychainBoundaryError("failed"), undefined, true);
        }
      };
      const onMessage: UtilityListener = (message) => {
        try {
          if (encodedMessageSize(message) > ELECTRON_KEYCHAIN_MAX_MESSAGE_BYTES) {
            finish(new ElectronKeychainBoundaryError("response-too-large"), undefined, true);
            return;
          }
        } catch {
          finish(new ElectronKeychainBoundaryError("invalid-response"), undefined, true);
          return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
          finish(new ElectronKeychainBoundaryError("invalid-response"), undefined, true);
          return;
        }
        const response = message as Record<string, unknown>;
        if (response["version"] !== 1 || response["ok"] !== true) {
          finish(
            new ElectronKeychainBoundaryError(
              response["code"] === "response_too_large" ? "response-too-large" : "failed",
            ),
            undefined,
            true,
          );
          return;
        }
        if (response["operation"] !== operation) {
          finish(new ElectronKeychainBoundaryError("invalid-response"), undefined, true);
          return;
        }
        finish(undefined, response);
      };
      const onFailure: UtilityListener = () =>
        finish(new ElectronKeychainBoundaryError("failed"), undefined, true);
      const onAbort = () => finish(new ElectronKeychainBoundaryError("cancelled"), undefined, true);
      const timer = setTimeout(
        () => finish(new ElectronKeychainBoundaryError("timed-out"), undefined, true),
        this.timeoutMs,
      );
      // This timer is the utility call's final fail-closed completion source when the host has no
      // other active handles. Keep it referenced until finish() clears it so short-lived Node 22
      // and packaged hosts cannot exit with an indeterminate Keychain operation still pending.
      child.once("spawn", onSpawn);
      child.once("message", onMessage);
      child.once("error", onFailure);
      child.once("exit", onFailure);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.active.set(child, () =>
        finish(new ElectronKeychainBoundaryError("cancelled"), undefined, true),
      );
    });
  }
}
