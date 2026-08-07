/** Fail-closed boundaries for network and SDK calls that carry credentials. */

const MAX_CREDENTIAL_TIMEOUT_MS = 15 * 60_000;
const MAX_CREDENTIAL_RESPONSE_BYTES = 64 * 1024 * 1024;
const SAFE_ERROR = Symbol("anicode.credential-io.safe-error");

export interface CredentialIoOptions {
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export type CredentialFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface CredentialFetchOptions extends CredentialIoOptions {
  label: string;
  fetch: CredentialFetchLike;
  input: string | URL | Request;
  init?: RequestInit;
}

type SafeCredentialError = Error & { [SAFE_ERROR]?: true };

export function credentialIoLimit(
  value: number | undefined,
  fallback: number,
  name: string,
  maximum: number,
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < 1 || candidate > maximum) {
    throw new TypeError(`${name} must be an integer between 1 and ${maximum}`);
  }
  return candidate;
}

export function credentialRequestTimeout(value: number | undefined, fallback = 30_000): number {
  return credentialIoLimit(
    value,
    fallback,
    "credential request timeout",
    MAX_CREDENTIAL_TIMEOUT_MS,
  );
}

export function credentialResponseLimit(value: number | undefined, fallback = 1024 * 1024): number {
  return credentialIoLimit(
    value,
    fallback,
    "credential response size limit",
    MAX_CREDENTIAL_RESPONSE_BYTES,
  );
}

/**
 * Mark an error as safe to cross the credential boundary. Never attach a credential-bearing
 * original error as `cause`: structured loggers commonly serialize causes and stacks.
 */
export function safeCredentialError(message: string): Error {
  const error = new Error(message) as SafeCredentialError;
  Object.defineProperty(error, SAFE_ERROR, { value: true });
  return error;
}

export function isSafeCredentialError(error: unknown): error is Error {
  return error instanceof Error && (error as SafeCredentialError)[SAFE_ERROR] === true;
}

function abortSignalFrom(
  input: string | URL | Request,
  init: RequestInit | undefined,
  signal: AbortSignal | undefined,
) {
  const initSignal = init?.signal ?? undefined;
  const inputSignal = input instanceof Request ? input.signal : undefined;
  const signals = [...new Set([inputSignal, initSignal, signal].filter(Boolean))] as AbortSignal[];
  if (signals.length > 1) return AbortSignal.any(signals);
  return signals[0];
}

/**
 * A hard wall-clock deadline. The race rejects even when an injected fetch/SDK ignores abort.
 * Unknown errors are replaced rather than wrapped so request bodies, headers, and tokens cannot
 * escape through messages, stacks, causes, or SDK metadata.
 */
export async function withCredentialDeadline<T>(
  label: string,
  requestTimeoutMs: number,
  signal: AbortSignal | undefined,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeoutMs = credentialRequestTimeout(requestTimeoutMs);
  const controller = new AbortController();
  let timedOut = false;
  let callerAborted = false;
  const onAbort = () => {
    callerAborted = true;
    controller.abort(safeCredentialError(`${label} was cancelled`));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(safeCredentialError(`${label} timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  timer.unref();
  const aborted = new Promise<never>((_resolve, reject) => {
    const fail = () =>
      reject(
        controller.signal.reason instanceof Error
          ? controller.signal.reason
          : safeCredentialError(`${label} was cancelled`),
      );
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener("abort", fail, { once: true });
  });

  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return operation(controller.signal);
      }),
      aborted,
    ]);
  } catch (error) {
    if (timedOut) throw safeCredentialError(`${label} timed out after ${timeoutMs}ms`);
    if (callerAborted) throw safeCredentialError(`${label} was cancelled`);
    if (isSafeCredentialError(error)) throw error;
    throw safeCredentialError(`${label} failed`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Run a credential-bearing fetch and consume its response inside one absolute deadline. */
export async function credentialFetch<T>(
  options: CredentialFetchOptions,
  consume: (response: Response, signal: AbortSignal, maximumBytes: number) => Promise<T>,
): Promise<T> {
  const timeoutMs = credentialRequestTimeout(options.requestTimeoutMs);
  const maximumBytes = credentialResponseLimit(options.maxResponseBytes);
  const parentSignal = abortSignalFrom(options.input, options.init, options.signal);
  const requestedUrl = credentialRequestUrl(options.input);
  return withCredentialDeadline(options.label, timeoutMs, parentSignal, async (signal) => {
    signal.throwIfAborted();
    let response: Response | undefined;
    const pending = Promise.resolve().then(() =>
      // Credential-bearing headers and bodies must never follow either same-origin or cross-origin
      // redirects. This override is intentional even when an injected Request/init says otherwise.
      options.fetch(options.input, { ...options.init, redirect: "error", signal }),
    );
    // A non-cooperative fetch may resolve after the hard race has rejected. Release that late
    // response instead of leaving a pooled socket occupied indefinitely.
    void pending.then(
      (late) => {
        if (signal.aborted) discardCredentialResponse(late, "credential request expired");
      },
      () => undefined,
    );
    try {
      response = await pending;
      if (signal.aborted) {
        discardCredentialResponse(response, "credential request expired");
        signal.throwIfAborted();
      }
      if (!credentialResponseMatchesRequest(response, requestedUrl)) {
        discardCredentialResponse(response, "credential redirect or origin mismatch");
        throw safeCredentialError(`${options.label} rejected a redirected response`);
      }
      return await consume(response, signal, maximumBytes);
    } catch (error) {
      if (response) discardCredentialResponse(response, "credential response rejected");
      throw error;
    }
  });
}

function credentialRequestUrl(input: string | URL | Request): URL | undefined {
  try {
    return new URL(input instanceof Request ? input.url : input);
  } catch {
    return undefined;
  }
}

function credentialResponseMatchesRequest(response: Response, requested: URL | undefined): boolean {
  if (response.redirected || response.type === "opaqueredirect") return false;
  // Standards-compliant fetch populates Response.url. Test adapters commonly construct a bare
  // Response with an empty URL; redirect:"error" is still asserted at their call boundary.
  if (!requested || !response.url) return true;
  try {
    return new URL(response.url).origin === requested.origin;
  } catch {
    return false;
  }
}

export function discardCredentialResponse(response: Response, reason: string): void {
  void response.body?.cancel(reason).catch(() => undefined);
}

export async function readCredentialJson<T>(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  label: string,
): Promise<T> {
  const bytes = await readCredentialBytes(response, maximumBytes, signal, label);
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as T;
  } catch {
    throw safeCredentialError(`${label} returned invalid JSON`);
  }
}

export async function readCredentialBytes(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
  label: string,
): Promise<Uint8Array> {
  const limit = credentialResponseLimit(maximumBytes);
  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > limit) {
    discardCredentialResponse(response, "credential response size limit reached");
    throw safeCredentialError(`${label} response exceeds ${limit} bytes`);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  const cancel = () => void reader.cancel("credential request cancelled").catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) {
        complete = true;
        break;
      }
      total += item.value.byteLength;
      if (total > limit) {
        cancel();
        throw safeCredentialError(`${label} response exceeds ${limit} bytes`);
      }
      chunks.push(item.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!complete) cancel();
    reader.releaseLock();
  }
  signal.throwIfAborted();
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}
