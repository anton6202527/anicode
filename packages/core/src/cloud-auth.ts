import type { CredentialBroker } from "./security/credentials.js";
import type { SecretBackend } from "./security/secret-backends.js";
import { NetworkProxy } from "./runtime/network-proxy.js";
import {
  CloudAuthLockError,
  cloudAuthExclusiveLockForBackend,
  type CloudAuthExclusiveLock,
} from "./security/cloud-auth-lock.js";

const REFRESH_STORAGE_KEY = "auth:supabase-refresh";
const ACCESS_CREDENTIAL_ID = "gateway:supabase-access";
const ACCESS_REFRESH_SKEW_MS = 60_000;
const AUTH_TIMEOUT_MS = 30_000;
const LOGOUT_TIMEOUT_MS = 5_000;
const MAX_AUTH_RESPONSE_BYTES = 1024 * 1024;
const MAX_GATEWAY_REQUEST_BYTES = 512 * 1024;

type AuthState = "signed_out" | "configured" | "refreshing" | "signed_in";

export interface CloudAuthStatus {
  state: AuthState;
  signedIn: boolean;
  user?: { id: string; email?: string };
  expiresAt?: string;
}

interface CloudSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  user: { id: string; email?: string };
}

interface StoredRefreshToken {
  version: 1;
  refreshToken?: string;
  revoked?: true;
}

interface AuthResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
  user?: { id?: unknown; email?: unknown };
}

interface GatewayAttempt {
  response: Response;
  accessRevision: number;
}

export class CloudAuthError extends Error {
  constructor(
    readonly code:
      | "invalid_credentials"
      | "sign_in_required"
      | "temporarily_unavailable"
      | "storage_unavailable"
      | "invalid_response",
    message: string,
  ) {
    super(message);
    this.name = "CloudAuthError";
  }
}

export interface CloudAuthServiceOptions {
  backend: SecretBackend & { close?(): void | Promise<void> };
  projectUrl: string;
  publishableKey: string;
  /** @internal Injectable coordination domain for hermetic concurrency tests. */
  coordinationLock?: CloudAuthExclusiveLock;
  /** Test seam. Production always uses a DNS-pinned, HTTPS-only NetworkProxy. */
  fetch?: typeof fetch;
}

export interface CloudAuthRestoreOptions {
  /** Cancels only this restore attempt; the service remains available for a later lazy refresh. */
  signal?: AbortSignal;
}

function validProjectUrl(value: string): URL {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    !/^[a-z0-9]+\.supabase\.co$/u.test(parsed.hostname)
  ) {
    throw new Error("AniCode Cloud requires a fixed Supabase HTTPS project URL");
  }
  return parsed;
}

function safeStatus(session: CloudSession | undefined, state: AuthState): CloudAuthStatus {
  if (!session) return { state, signedIn: false };
  return {
    state,
    signedIn: true,
    user: { ...session.user },
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function validateEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
    throw new CloudAuthError("invalid_credentials", "请输入有效的邮箱地址");
  }
  return email;
}

function validatePassword(value: string): string {
  if (value.length < 6 || value.length > 1024) {
    throw new CloudAuthError("invalid_credentials", "密码长度不正确");
  }
  return value;
}

function cancelledAuthError(): CloudAuthError {
  return new CloudAuthError("temporarily_unavailable", "恢复 AniCode Cloud 登录已取消");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledAuthError();
}

/**
 * Settle immediately even when an injected backend ignores AbortSignal. The underlying operation
 * is still observed, while its caller must check the same signal before performing any mutation.
 */
function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return operation;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(cancelledAuthError()));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function storedRefresh(value: string | undefined): StoredRefreshToken | undefined {
  if (!value || value.length > 128 * 1024) return undefined;
  try {
    const parsed = JSON.parse(value) as StoredRefreshToken;
    if (parsed.version !== 1) return undefined;
    if (parsed.revoked === true) return { version: 1, revoked: true };
    if (
      typeof parsed.refreshToken !== "string" ||
      parsed.refreshToken.length < 16 ||
      parsed.refreshToken.length > 64 * 1024
    ) {
      return undefined;
    }
    return { version: 1, refreshToken: parsed.refreshToken };
  } catch {
    return undefined;
  }
}

function sessionFromResponse(value: unknown): CloudSession {
  const response = value as AuthResponse;
  if (
    typeof response?.access_token !== "string" ||
    response.access_token.length < 16 ||
    response.access_token.length > 128 * 1024 ||
    typeof response.refresh_token !== "string" ||
    response.refresh_token.length < 16 ||
    response.refresh_token.length > 64 * 1024 ||
    typeof response.user?.id !== "string" ||
    response.user.id.length < 1 ||
    response.user.id.length > 256
  ) {
    throw new CloudAuthError("invalid_response", "登录服务返回了无效响应");
  }
  const expiresAtSeconds = Number(response.expires_at);
  const expiresInSeconds = Number(response.expires_in);
  const expiresAt = Number.isFinite(expiresAtSeconds)
    ? expiresAtSeconds * 1000
    : Date.now() + (Number.isFinite(expiresInSeconds) ? expiresInSeconds : 3600) * 1000;
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new CloudAuthError("invalid_response", "登录会话已经过期");
  }
  const email = typeof response.user.email === "string" ? response.user.email.slice(0, 320) : "";
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt,
    user: { id: response.user.id, ...(email ? { email } : {}) },
  };
}

export class CloudAuthService {
  private readonly backend: CloudAuthServiceOptions["backend"];
  private readonly coordinationLock: CloudAuthExclusiveLock;
  private readonly project: URL;
  private readonly publishableKey: string;
  private readonly authProxy: NetworkProxy | undefined;
  private readonly testFetch: typeof fetch | undefined;
  private gatewayProxy: NetworkProxy | undefined;
  private broker: CredentialBroker | undefined;
  private readonly brokerAttachmentListeners = new Set<(broker: CredentialBroker) => void>();
  private session: CloudSession | undefined;
  private configured = false;
  private refreshing = false;
  private signingOut = false;
  /** A failed durable logout must not let this process silently authenticate again. */
  private revokedLocally = false;
  /** Fences gateway refresh while a password login is selecting a possibly different account. */
  private signInGeneration: number | undefined;
  private refreshTask: Promise<CloudSession> | undefined;
  private refreshController: AbortController | undefined;
  /** Serialize Keychain reads and mutations so logout's tombstone is ordered after stale writes. */
  private storageTail: Promise<void> = Promise.resolve();
  private readonly lifecycleController = new AbortController();
  private generation = 0;
  /** Monotonic identity for the access credential actually leased by a gateway request. */
  private accessRevision = 0;
  private closed = false;

  constructor(options: CloudAuthServiceOptions) {
    this.backend = options.backend;
    this.coordinationLock =
      options.coordinationLock ?? cloudAuthExclusiveLockForBackend(options.backend);
    this.project = validProjectUrl(options.projectUrl);
    if (!options.publishableKey || options.publishableKey.length > 8 * 1024) {
      throw new Error("AniCode Cloud publishable key is unavailable");
    }
    this.publishableKey = options.publishableKey;
    this.testFetch = options.fetch;
    this.authProxy = options.fetch
      ? undefined
      : new NetworkProxy({
          policy: {
            allowDomains: [this.project.hostname],
            allowPorts: [443],
            protocols: ["https:"],
            allowPrivateAddresses: false,
            maxRedirects: 0,
          },
          maxResponseBytes: MAX_AUTH_RESPONSE_BYTES,
        });
  }

  attachBroker(broker: CredentialBroker): void {
    if (this.closed) throw new Error("AniCode Cloud auth is closed");
    if (this.broker && this.broker !== broker) throw new Error("AniCode Cloud broker is immutable");
    this.broker = broker;
    if (!this.testFetch && !this.gatewayProxy) {
      this.gatewayProxy = new NetworkProxy({
        broker,
        policy: {
          allowDomains: [this.project.hostname],
          allowPorts: [443],
          protocols: ["https:"],
          allowPrivateAddresses: false,
          maxRedirects: 0,
        },
        maxResponseBytes: 32 * 1024 * 1024,
      });
    }
    for (const listener of this.brokerAttachmentListeners) listener(broker);
    if (this.session) this.registerAccessCredential(this.session);
  }

  /** @internal Register a host-owned provider route without exposing credentials or global state. */
  onBrokerAttached(listener: (broker: CredentialBroker) => void): void {
    if (this.closed) throw new Error("AniCode Cloud auth is closed");
    this.brokerAttachmentListeners.add(listener);
    if (this.broker) listener(this.broker);
  }

  /** @internal Host-owned provider routing must never reuse this service with another Broker. */
  isAttachedToBroker(broker: CredentialBroker): boolean {
    return !this.closed && this.broker === broker;
  }

  status(): CloudAuthStatus {
    if (this.signingOut) return safeStatus(undefined, "signed_out");
    if (this.refreshing) return safeStatus(this.session, "refreshing");
    if (this.session) return safeStatus(this.session, "signed_in");
    return safeStatus(undefined, this.configured ? "configured" : "signed_out");
  }

  async restore(options: CloudAuthRestoreOptions = {}): Promise<CloudAuthStatus> {
    this.assertOpen();
    if (this.revokedLocally) return this.status();
    const generation = this.generation;
    const signal = this.operationSignal(options.signal);
    throwIfAborted(signal);
    try {
      await abortable(this.refreshWith(generation, signal), signal);
    } catch (error) {
      if (signal.aborted) {
        this.cancelRefresh();
        throw cancelledAuthError();
      }
      if (error instanceof CloudAuthError && error.code === "storage_unavailable") throw error;
      // Transient startup failures keep the refresh token; invalid-grant already revoked it.
    }
    return this.status();
  }

  async signIn(emailValue: string, passwordValue: string): Promise<CloudAuthStatus> {
    this.assertOpen();
    const email = validateEmail(emailValue);
    const password = validatePassword(passwordValue);
    const generation = ++this.generation;
    this.cancelRefresh();
    this.signInGeneration = generation;
    const signal = this.operationSignal();
    try {
      const response = await this.authRequest(
        "/auth/v1/token?grant_type=password",
        {
          email,
          password,
        },
        signal,
      );
      const session = sessionFromResponse(response);
      if (generation !== this.generation)
        throw new CloudAuthError("sign_in_required", "登录已取消");
      await this.persistSession(session, generation, signal);
      if (generation !== this.generation)
        throw new CloudAuthError("sign_in_required", "登录已取消");
      this.installSession(session);
      return this.status();
    } finally {
      // A superseding login/logout owns the newer fence and must not be cleared by this operation.
      if (this.signInGeneration === generation) this.signInGeneration = undefined;
    }
  }

  async signOut(): Promise<CloudAuthStatus> {
    this.assertOpen();
    const accessToken = this.session?.accessToken;
    ++this.generation;
    this.cancelRefresh();
    this.signingOut = true;
    this.revokedLocally = true;
    this.signInGeneration = undefined;
    this.session = undefined;
    this.configured = false;
    ++this.accessRevision;
    this.broker?.revoke(ACCESS_CREDENTIAL_ID);
    try {
      await this.revokeStoredRefresh();
    } catch {
      throw new CloudAuthError("storage_unavailable", "无法安全清除本机登录状态");
    } finally {
      this.signingOut = false;
    }

    if (accessToken) {
      // Local revocation is authoritative and already complete above. Await the bounded remote
      // revocation so a command-scoped service is not closed while the request is still in flight.
      try {
        const response = await this.rawRequest("/auth/v1/logout?scope=local", {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(LOGOUT_TIMEOUT_MS),
        });
        await response.body?.cancel().catch(() => undefined);
      } catch {
        // Offline logout remains fail-closed locally; never expose a token-bearing network cause.
      }
    }
    return this.status();
  }

  async gatewayFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    this.assertOpen();
    const request = new Request(input, init);
    const url = new URL(request.url);
    const gatewayPrefix = `/functions/v1/anicode-chat/`;
    if (
      url.protocol !== "https:" ||
      url.origin !== this.project.origin ||
      !url.pathname.startsWith(gatewayPrefix) ||
      url.username ||
      url.password
    ) {
      throw new CloudAuthError("temporarily_unavailable", "拒绝未知的模型网关地址");
    }
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : new Uint8Array(await request.arrayBuffer());
    if (body && body.byteLength > MAX_GATEWAY_REQUEST_BYTES) {
      throw new CloudAuthError("temporarily_unavailable", "模型请求超过网关大小限制");
    }
    const requestInit: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: request.signal,
      ...(body ? { body } : {}),
    };

    await this.ensureFreshAccess(false);
    const firstAttempt = await this.authorizedGatewayRequest(url, requestInit);
    if (firstAttempt.response.status !== 401) return firstAttempt.response;
    await firstAttempt.response.body?.cancel().catch(() => undefined);
    if (firstAttempt.accessRevision === this.accessRevision) {
      await this.ensureFreshAccess(true);
    } else {
      // Another request already rotated the rejected credential; retry that revision directly.
      await this.ensureFreshAccess(false);
    }
    return (await this.authorizedGatewayRequest(url, requestInit)).response;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    ++this.generation;
    this.lifecycleController.abort();
    this.cancelRefresh();
    this.signInGeneration = undefined;
    this.session = undefined;
    ++this.accessRevision;
    this.broker?.revoke(ACCESS_CREDENTIAL_ID);
    this.brokerAttachmentListeners.clear();
    await this.storageTail;
    await Promise.allSettled([
      this.authProxy?.close() ?? Promise.resolve(),
      this.gatewayProxy?.close() ?? Promise.resolve(),
      Promise.resolve(this.backend.close?.()),
    ]);
  }

  private async ensureFreshAccess(force: boolean): Promise<CloudSession> {
    this.assertOpen();
    if (this.signingOut) {
      throw new CloudAuthError("sign_in_required", "登录状态正在退出");
    }
    if (this.revokedLocally) {
      throw new CloudAuthError("sign_in_required", "登录状态已经退出");
    }
    if (this.signInGeneration !== undefined) {
      throw new CloudAuthError("temporarily_unavailable", "登录正在进行，请稍后重试");
    }
    const generation = this.generation;
    const current = this.session;
    if (!force && current && current.expiresAt - Date.now() > ACCESS_REFRESH_SKEW_MS)
      return current;
    return this.refreshWith(generation);
  }

  private refreshWith(generation: number, callerSignal?: AbortSignal): Promise<CloudSession> {
    this.assertGeneration(generation);
    if (this.signInGeneration === generation) {
      throw new CloudAuthError("temporarily_unavailable", "登录正在进行，请稍后重试");
    }
    if (this.refreshTask) return abortable(this.refreshTask, callerSignal);
    this.refreshing = true;
    const controller = new AbortController();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, controller.signal, this.lifecycleController.signal])
      : AbortSignal.any([controller.signal, this.lifecycleController.signal]);
    const task = this.refreshUnderCoordinationLock(generation, signal);
    this.refreshTask = task;
    this.refreshController = controller;
    const cleanup = () => {
      if (this.refreshTask !== task) return;
      this.refreshTask = undefined;
      this.refreshController = undefined;
      this.refreshing = false;
    };
    // Handle both outcomes directly; `void task.finally(...)` would create an unobserved rejection.
    void task.then(cleanup, cleanup);
    return abortable(task, callerSignal);
  }

  private async refreshUnderCoordinationLock(
    generation: number,
    signal: AbortSignal,
  ): Promise<CloudSession> {
    try {
      return await this.enqueueStorage(() =>
        this.coordinationLock.runExclusive(
          async () => {
            this.assertGeneration(generation);
            throwIfAborted(signal);
            const stored = storedRefresh(
              await abortable(this.backend.get(REFRESH_STORAGE_KEY, signal), signal),
            );
            this.assertGeneration(generation);
            throwIfAborted(signal);
            if (!stored?.refreshToken || stored.revoked) {
              this.clearMissingRefreshSession(generation);
              throw new CloudAuthError("sign_in_required", "请先登录 AniCode Cloud");
            }
            this.configured = true;

            let response: unknown;
            try {
              response = await abortable(
                this.authRequest(
                  "/auth/v1/token?grant_type=refresh_token",
                  { refresh_token: stored.refreshToken },
                  signal,
                ),
                signal,
              );
              this.assertGeneration(generation);
              throwIfAborted(signal);
            } catch (error) {
              this.assertGeneration(generation);
              throwIfAborted(signal);
              if (error instanceof CloudAuthError && error.code === "invalid_credentials") {
                await this.revokeStoredRefreshUnlocked();
                this.invalidateRefreshSessionInMemory(generation);
                throw new CloudAuthError("sign_in_required", "登录状态已失效，请重新登录");
              }
              if (error instanceof CloudAuthError && error.code === "temporarily_unavailable") {
                this.retainConfiguredAfterRefreshFailure(generation);
              }
              throw error;
            }

            const next = sessionFromResponse(response);
            this.assertGeneration(generation);
            throwIfAborted(signal);
            await this.putRefreshTokenUnlocked(next.refreshToken, signal);
            this.assertGeneration(generation);
            throwIfAborted(signal);
            this.configured = true;
            this.revokedLocally = false;
            this.installSession(next);
            return next;
          },
          { signal },
        ),
      );
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      if (signal.aborted || (error instanceof CloudAuthLockError && error.reason === "cancelled")) {
        throw cancelledAuthError();
      }
      throw new CloudAuthError("storage_unavailable", "无法安全协调系统凭证存储");
    }
  }

  private async persistSession(
    session: CloudSession,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.enqueueStorage(() =>
        this.coordinationLock.runExclusive(
          async () => {
            this.assertGeneration(generation);
            throwIfAborted(signal);
            await this.putRefreshTokenUnlocked(session.refreshToken, signal);
            this.assertGeneration(generation);
            throwIfAborted(signal);
            this.configured = true;
            this.revokedLocally = false;
          },
          { signal },
        ),
      );
    } catch (error) {
      if (error instanceof CloudAuthError) throw error;
      throw new CloudAuthError("storage_unavailable", "无法保存登录状态到系统凭证存储");
    }
  }

  private enqueueStorage<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.storageTail.then(operation);
    this.storageTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private revokeStoredRefresh(): Promise<void> {
    return this.enqueueStorage(() =>
      this.coordinationLock.runExclusive(() => this.revokeStoredRefreshUnlocked()),
    );
  }

  private async revokeStoredRefreshUnlocked(): Promise<void> {
    await this.backend.put(
      REFRESH_STORAGE_KEY,
      JSON.stringify({ version: 1, revoked: true } satisfies StoredRefreshToken),
    );
    // A failed delete leaves a fail-closed tombstone behind rather than the previous token.
    await this.backend.delete(REFRESH_STORAGE_KEY).catch(() => false);
  }

  private putRefreshTokenUnlocked(refreshToken: string, signal?: AbortSignal): Promise<void> {
    return this.backend.put(
      REFRESH_STORAGE_KEY,
      JSON.stringify({ version: 1, refreshToken } satisfies StoredRefreshToken),
      signal,
    );
  }

  private invalidateRefreshSessionInMemory(generation: number): void {
    this.assertGeneration(generation);
    ++this.generation;
    this.cancelRefresh();
    this.signInGeneration = undefined;
    this.session = undefined;
    this.configured = false;
    this.revokedLocally = true;
    ++this.accessRevision;
    this.broker?.revoke(ACCESS_CREDENTIAL_ID);
  }

  private clearMissingRefreshSession(generation: number): void {
    this.assertGeneration(generation);
    this.session = undefined;
    this.configured = false;
    ++this.accessRevision;
    this.broker?.revoke(ACCESS_CREDENTIAL_ID);
  }

  private retainConfiguredAfterRefreshFailure(generation: number): void {
    this.assertGeneration(generation);
    this.session = undefined;
    this.configured = true;
    ++this.accessRevision;
    this.broker?.revoke(ACCESS_CREDENTIAL_ID);
  }

  private cancelRefresh(): void {
    this.refreshController?.abort();
    this.refreshController = undefined;
    this.refreshTask = undefined;
    this.refreshing = false;
  }

  private operationSignal(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.lifecycleController.signal])
      : this.lifecycleController.signal;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation) {
      throw new CloudAuthError("sign_in_required", "登录状态已经退出");
    }
  }

  private installSession(session: CloudSession): void {
    this.session = session;
    ++this.accessRevision;
    this.registerAccessCredential(session);
  }

  private registerAccessCredential(session: CloudSession): void {
    this.broker?.register({
      id: ACCESS_CREDENTIAL_ID,
      value: session.accessToken,
      expiresAt: new Date(session.expiresAt).toISOString(),
      scopes: [
        {
          audiences: ["provider:anicode-cloud"],
          hosts: [this.project.hostname],
          header: "authorization",
          headerPrefix: "Bearer ",
        },
      ],
    });
  }

  private async authorizedGatewayRequest(url: URL, init: RequestInit): Promise<GatewayAttempt> {
    const broker = this.broker;
    if (!broker) throw new CloudAuthError("temporarily_unavailable", "模型网关尚未初始化");
    const headers = new Headers(init.headers);
    headers.set("apikey", this.publishableKey);
    const lease = broker.lease({
      credentialId: ACCESS_CREDENTIAL_ID,
      audience: "provider:anicode-cloud",
      host: this.project.hostname,
      ttlMs: 30_000,
      maxUses: 1,
    });
    const accessRevision = this.accessRevision;
    if (this.testFetch) {
      const injected = await broker.injectHeadersAsync(lease, headers);
      return {
        response: await this.testFetch(url, { ...init, headers: injected, redirect: "error" }),
        accessRevision,
      };
    }
    if (!this.gatewayProxy) throw new Error("AniCode Cloud gateway proxy is unavailable");
    return {
      response: await this.gatewayProxy.fetch(url, {
        ...init,
        headers,
        redirect: "error",
        credentialLease: lease,
      }),
      accessRevision,
    };
  }

  private async authRequest(
    path: string,
    body: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.rawRequest(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    }).catch(() => {
      throw new CloudAuthError("temporarily_unavailable", "登录服务暂时不可用");
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new CloudAuthError(
        response.status === 400 || response.status === 401
          ? "invalid_credentials"
          : "temporarily_unavailable",
        response.status === 400 || response.status === 401
          ? "邮箱或密码不正确"
          : "登录服务暂时不可用",
      );
    }
    try {
      return await response.json();
    } catch {
      throw new CloudAuthError("invalid_response", "登录服务返回了无效响应");
    }
  }

  private rawRequest(path: string, init: RequestInit): Promise<Response> {
    const url = new URL(path, this.project);
    if (url.origin !== this.project.origin) {
      throw new CloudAuthError("temporarily_unavailable", "拒绝未知的登录服务地址");
    }
    const headers = new Headers(init.headers);
    headers.set("apikey", this.publishableKey);
    const requestInit = {
      ...init,
      headers,
      redirect: "error" as const,
      signal: AbortSignal.any([
        init.signal ?? new AbortController().signal,
        AbortSignal.timeout(AUTH_TIMEOUT_MS),
      ]),
    };
    return this.testFetch
      ? this.testFetch(url, requestInit)
      : this.authProxy!.fetch(url, requestInit);
  }

  private assertOpen(): void {
    if (this.closed) throw new CloudAuthError("temporarily_unavailable", "登录服务已经关闭");
  }
}
