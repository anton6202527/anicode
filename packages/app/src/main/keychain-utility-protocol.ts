import { createRequire } from "node:module";
import * as path from "node:path";

export const ELECTRON_KEYCHAIN_PROTOCOL_VERSION = 1 as const;
export const ELECTRON_KEYCHAIN_MAX_SECRET_BYTES = 1024 * 1024;
export const ELECTRON_KEYCHAIN_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const ELECTRON_KEYCHAIN_MAX_MODULE_PATH_BYTES = 4096;

const SERVICE_PATTERN = /^[^\u0000-\u001f\u007f]{1,512}$/u;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export type ElectronKeychainOperation = "get" | "put" | "delete";

export interface ElectronKeychainRequest {
  version: typeof ELECTRON_KEYCHAIN_PROTOCOL_VERSION;
  operation: ElectronKeychainOperation;
  modulePath: string;
  service: string;
  key: string;
  value?: string;
}

export type ElectronKeychainResponse =
  | { version: 1; ok: true; operation: "get"; found: false }
  | { version: 1; ok: true; operation: "get"; found: true; value: string }
  | { version: 1; ok: true; operation: "put" }
  | { version: 1; ok: true; operation: "delete"; deleted: boolean }
  | {
      version: 1;
      ok: false;
      code: "invalid_request" | "operation_failed" | "response_too_large";
    };

export function validElectronKeychainRequest(value: unknown): value is ElectronKeychainRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  if (request["version"] !== ELECTRON_KEYCHAIN_PROTOCOL_VERSION) return false;
  if (
    typeof request["service"] !== "string" ||
    Buffer.byteLength(request["service"], "utf8") > 512 ||
    !SERVICE_PATTERN.test(request["service"]) ||
    typeof request["key"] !== "string" ||
    !KEY_PATTERN.test(request["key"])
  ) {
    return false;
  }
  const modulePath = request["modulePath"];
  if (
    typeof modulePath !== "string" ||
    !path.isAbsolute(modulePath) ||
    Buffer.byteLength(modulePath, "utf8") > ELECTRON_KEYCHAIN_MAX_MODULE_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(modulePath) ||
    ![".cjs", ".js"].includes(path.extname(modulePath).toLowerCase())
  ) {
    return false;
  }
  if (!(["get", "put", "delete"] as const).includes(request["operation"] as never)) {
    return false;
  }
  if (request["operation"] === "put") {
    return (
      typeof request["value"] === "string" &&
      request["value"].length > 0 &&
      Buffer.byteLength(request["value"], "utf8") <= ELECTRON_KEYCHAIN_MAX_SECRET_BYTES
    );
  }
  return request["value"] === undefined;
}

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(value: string): void;
  deleteCredential(): boolean;
}

interface KeyringModule {
  Entry: new (service: string, key: string) => KeyringEntry;
}

export type ElectronKeyringLoader = (modulePath: string) => unknown;

function defaultKeyringLoader(modulePath: string): unknown {
  return createRequire(modulePath)(modulePath);
}

/** Runs only in the Electron utility process. It never logs request or native error details. */
export function executeElectronKeychainRequest(
  input: unknown,
  load: ElectronKeyringLoader = defaultKeyringLoader,
): ElectronKeychainResponse {
  if (!validElectronKeychainRequest(input)) {
    return { version: 1, ok: false, code: "invalid_request" };
  }
  const request = input;
  try {
    const keyring = load(request.modulePath) as Partial<KeyringModule> | undefined;
    if (!keyring || typeof keyring.Entry !== "function") {
      return { version: 1, ok: false, code: "operation_failed" };
    }
    const entry = new keyring.Entry(request.service, request.key);
    if (request.operation === "get") {
      const value = entry.getPassword();
      if (value === null || value === undefined) {
        return { version: 1, ok: true, operation: "get", found: false };
      }
      if (
        typeof value !== "string" ||
        Buffer.byteLength(value, "utf8") > ELECTRON_KEYCHAIN_MAX_SECRET_BYTES
      ) {
        return { version: 1, ok: false, code: "response_too_large" };
      }
      return { version: 1, ok: true, operation: "get", found: true, value };
    }
    if (request.operation === "put") {
      entry.setPassword(request.value!);
      request.value = "";
      return { version: 1, ok: true, operation: "put" };
    }
    return {
      version: 1,
      ok: true,
      operation: "delete",
      deleted: entry.deleteCredential() === true,
    };
  } catch {
    if (request.value !== undefined) request.value = "";
    return { version: 1, ok: false, code: "operation_failed" };
  }
}
