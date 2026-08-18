import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ANICODE_CLOUD_CONFIG,
  bindProviderRegistry,
  type CloudAuthExclusiveLock,
  CredentialBroker,
  type SecretBackend,
} from "@anicode/core";
import { CloudAuthError, CloudAuthService } from "./cloud-auth.js";
import { registerAnicodeCloudProvider } from "./cloud-provider.js";

const PROJECT_URL = "https://fixture.supabase.co";
const GATEWAY_URL = `${PROJECT_URL}/functions/v1/anicode-chat/v1/chat/completions`;
const STORAGE_KEY = "auth:supabase-refresh";
const INSTALLATION_TOKEN_KEY = "device:installation-token-v1";
const INSTALLATION_TOKEN_HEADER = "x-anicode-installation-token";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class MemorySecretBackend implements SecretBackend {
  readonly kind = "cloud-auth-memory-test";
  readonly values = new Map<string, string>();
  readonly puts: Array<{ key: string; value: string }> = [];
  readonly deletes: string[] = [];
  onPut?: (key: string, value: string) => Promise<void>;

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async put(key: string, value: string): Promise<void> {
    this.puts.push({ key, value });
    await this.onPut?.(key, value);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    this.deletes.push(key);
    return this.values.delete(key);
  }
}

function session(label: string, expiresIn = 3_600) {
  return {
    access_token: `access-${label}-${"a".repeat(20)}`,
    refresh_token: `refresh-${label}-${"r".repeat(20)}`,
    expires_in: expiresIn,
    user: { id: `user-${label}`, email: `${label}@example.test` },
  };
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
}

function requestHeaders(input: string | URL | Request, init?: RequestInit): Headers {
  return input instanceof Request ? input.headers : new Headers(init?.headers);
}

function requestJson(init?: RequestInit): Record<string, unknown> {
  const body = init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON string request body");
  return JSON.parse(body) as Record<string, unknown>;
}

function createService(
  backend: MemorySecretBackend,
  fetchImpl: typeof fetch,
  coordinationLock?: CloudAuthExclusiveLock,
): CloudAuthService {
  return new CloudAuthService({
    backend,
    projectUrl: PROJECT_URL,
    publishableKey: "sb_publishable_cloud_auth_test",
    fetch: fetchImpl,
    ...(coordinationLock ? { coordinationLock } : {}),
  });
}

class SharedTestLock implements CloudAuthExclusiveLock {
  private tail: Promise<void> = Promise.resolve();
  active = 0;
  maximumActive = 0;

  runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      this.active++;
      this.maximumActive = Math.max(this.maximumActive, this.active);
      try {
        return await operation();
      } finally {
        this.active--;
      }
    });
    this.tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

test("cloud auth: persists refresh token only and status DTO never exposes session tokens", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("initial");
  const rotated = session("rotated");
  const refreshBodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.searchParams.get("grant_type") === "refresh_token") {
      refreshBodies.push(requestJson(init));
      return Response.json(rotated);
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;

  const first = createService(backend, fetchImpl);
  const signedIn = await first.signIn("Initial@Example.test", "password123");
  const serialized = JSON.stringify(signedIn);
  assert.equal(signedIn.state, "signed_in");
  assert.doesNotMatch(serialized, /accessToken|refreshToken|access_token|refresh_token/u);
  assert.doesNotMatch(serialized, new RegExp(initial.access_token, "u"));
  assert.doesNotMatch(serialized, new RegExp(initial.refresh_token, "u"));
  assert.deepEqual(JSON.parse(backend.values.get(STORAGE_KEY) ?? "null"), {
    version: 1,
    refreshToken: initial.refresh_token,
  });
  assert.ok(backend.puts.every(({ value }) => !value.includes(initial.access_token)));
  await first.close();

  const restoredService = createService(backend, fetchImpl);
  const restored = await restoredService.restore();
  assert.equal(restored.state, "signed_in");
  assert.deepEqual(refreshBodies, [{ refresh_token: initial.refresh_token }]);
  assert.deepEqual(JSON.parse(backend.values.get(STORAGE_KEY) ?? "null"), {
    version: 1,
    refreshToken: rotated.refresh_token,
  });
  const restoredDto = JSON.stringify(restored);
  assert.doesNotMatch(restoredDto, /accessToken|refreshToken|access_token|refresh_token/u);
  assert.doesNotMatch(restoredDto, new RegExp(rotated.access_token, "u"));
  assert.doesNotMatch(restoredDto, new RegExp(rotated.refresh_token, "u"));
  assert.ok(backend.puts.every(({ value }) => !value.includes(rotated.access_token)));
  await restoredService.close();
});

test("cloud auth: two services rotate only the latest persisted token under their shared lock", async () => {
  const backend = new MemorySecretBackend();
  const lock = new SharedTestLock();
  const initial = session("process-old");
  const firstRotation = session("process-first");
  const secondRotation = session("process-second");
  backend.values.set(
    STORAGE_KEY,
    JSON.stringify({ version: 1, refreshToken: initial.refresh_token }),
  );
  const refreshTokens: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    assert.equal(url.searchParams.get("grant_type"), "refresh_token");
    const refreshToken = requestJson(init)["refresh_token"];
    refreshTokens.push(refreshToken);
    if (refreshToken === initial.refresh_token) return Response.json(firstRotation);
    if (refreshToken === firstRotation.refresh_token) return Response.json(secondRotation);
    throw new Error("a stale or unknown refresh token was used");
  }) as typeof fetch;
  const first = createService(backend, fetchImpl, lock);
  const second = createService(backend, fetchImpl, lock);

  const statuses = await Promise.all([first.restore(), second.restore()]);

  assert.ok(statuses.every(({ signedIn }) => signedIn));
  assert.equal(lock.maximumActive, 1);
  assert.deepEqual(refreshTokens, [initial.refresh_token, firstRotation.refresh_token]);
  assert.deepEqual(JSON.parse(backend.values.get(STORAGE_KEY) ?? "null"), {
    version: 1,
    refreshToken: secondRotation.refresh_token,
  });
  await Promise.all([first.close(), second.close()]);
});

test("cloud auth: a second service logout is the durable final writer after an in-flight refresh", async () => {
  const backend = new MemorySecretBackend();
  const lock = new SharedTestLock();
  const initial = session("process-race-old");
  const rotated = session("process-race-new");
  backend.values.set(
    STORAGE_KEY,
    JSON.stringify({ version: 1, refreshToken: initial.refresh_token }),
  );
  const refreshStarted = deferred<void>();
  const refreshReply = deferred<Response>();
  let refreshCalls = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    assert.equal(url.searchParams.get("grant_type"), "refresh_token");
    assert.equal(requestJson(init)["refresh_token"], initial.refresh_token);
    refreshCalls++;
    refreshStarted.resolve(undefined);
    return refreshReply.promise;
  }) as typeof fetch;
  const refreshingService = createService(backend, fetchImpl, lock);
  const logoutService = createService(backend, fetchImpl, lock);

  const restoring = refreshingService.restore();
  await refreshStarted.promise;
  const logout = logoutService.signOut();
  await Promise.resolve();
  assert.equal(backend.puts.length, 0, "logout must wait behind the locked refresh");
  refreshReply.resolve(Response.json(rotated));

  assert.equal((await restoring).signedIn, true);
  assert.deepEqual(await logout, { state: "signed_out", signedIn: false });
  assert.equal(lock.maximumActive, 1);
  assert.equal(refreshCalls, 1);
  assert.equal(backend.values.has(STORAGE_KEY), false);
  assert.deepEqual(
    backend.puts.map(({ value }) => JSON.parse(value)),
    [
      { version: 1, refreshToken: rotated.refresh_token },
      { version: 1, revoked: true },
    ],
  );
  await Promise.all([refreshingService.close(), logoutService.close()]);
});

test("cloud auth: aborting a non-cooperative restore read never triggers a late refresh", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("cancelled-read-old");
  const rotated = session("cancelled-read-new");
  backend.values.set(
    STORAGE_KEY,
    JSON.stringify({ version: 1, refreshToken: initial.refresh_token }),
  );
  const readStarted = deferred<void>();
  const lateRead = deferred<string | undefined>();
  const ordinaryGet = backend.get.bind(backend);
  let reads = 0;
  backend.get = async (key: string) => {
    reads++;
    if (reads !== 1) return ordinaryGet(key);
    readStarted.resolve(undefined);
    return lateRead.promise;
  };
  let refreshCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    assert.equal(url.searchParams.get("grant_type"), "refresh_token");
    refreshCalls++;
    return Response.json(rotated);
  }) as typeof fetch;
  const service = createService(backend, fetchImpl, new SharedTestLock());
  const controller = new AbortController();
  const restoring = service.restore({ signal: controller.signal });
  await readStarted.promise;
  controller.abort();

  await assert.rejects(
    restoring,
    (error) => error instanceof CloudAuthError && error.code === "temporarily_unavailable",
  );
  assert.deepEqual(service.status(), { state: "signed_out", signedIn: false });
  assert.equal(refreshCalls, 0);
  assert.equal(backend.puts.length, 0);
  lateRead.resolve(backend.values.get(STORAGE_KEY));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(refreshCalls, 0, "the late read result must be discarded");

  assert.equal((await service.restore()).signedIn, true);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(JSON.parse(backend.values.get(STORAGE_KEY) ?? "null"), {
    version: 1,
    refreshToken: rotated.refresh_token,
  });
  await service.close();
});

test("cloud auth: bound provider registries never cross-route another runtime's session", async () => {
  const observed: Array<{ service: string; authorization: string | null }> = [];
  const createBoundService = async (label: string) => {
    const backend = new MemorySecretBackend();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.searchParams.get("grant_type") === "password") {
        return Response.json(session(label));
      }
      if (url.pathname.endsWith("/models")) {
        observed.push({
          service: label,
          authorization: requestHeaders(input, init).get("authorization"),
        });
        return Response.json({ data: [{ id: `model-${label}` }] });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const service = new CloudAuthService({
      backend,
      projectUrl: ANICODE_CLOUD_CONFIG.projectUrl,
      publishableKey: "sb_publishable_cloud_provider_test",
      fetch: fetchImpl,
    });
    const broker = new CredentialBroker();
    service.attachBroker(broker);
    await service.signIn(`${label}@example.test`, "password123");
    registerAnicodeCloudProvider(service);
    return {
      service,
      registry: bindProviderRegistry({ broker, environment: {}, allowEnvironmentFallback: false }),
    };
  };

  const first = await createBoundService("first");
  const second = await createBoundService("second");
  try {
    // The second global descriptor registration must not change the first bound runtime's auth.
    assert.deepEqual(await first.registry.discoverModels("anicode-cloud"), ["model-first"]);
    assert.deepEqual(await second.registry.discoverModels("anicode-cloud"), ["model-second"]);
    assert.deepEqual(
      observed.map(({ service }) => service),
      ["first", "second"],
    );
    assert.equal(observed[0]?.authorization, `Bearer ${session("first").access_token}`);
    assert.equal(observed[1]?.authorization, `Bearer ${session("second").access_token}`);
  } finally {
    await Promise.all([first.service.close(), second.service.close()]);
  }
});

test("cloud auth: password sign-in fences an old-session refresh from replacing the account", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("sign-in-fence-old", 1);
  const replacement = session("sign-in-fence-new");
  const replacementStarted = deferred<void>();
  const replacementReply = deferred<Response>();
  let passwordCalls = 0;
  let refreshCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") {
      passwordCalls++;
      if (passwordCalls === 1) return Response.json(initial);
      replacementStarted.resolve(undefined);
      return replacementReply.promise;
    }
    if (url.searchParams.get("grant_type") === "refresh_token") {
      refreshCalls++;
      return Response.json(session("sign-in-fence-stale"));
    }
    if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const service = createService(backend, fetchImpl);
  service.attachBroker(new CredentialBroker());
  await service.signIn("old@example.test", "password123");

  const replacing = service.signIn("new@example.test", "password123");
  await replacementStarted.promise;
  await assert.rejects(
    service.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" }),
    (error) => error instanceof CloudAuthError && error.code === "temporarily_unavailable",
  );
  assert.equal(refreshCalls, 0);
  replacementReply.resolve(Response.json(replacement));
  const status = await replacing;

  assert.equal(status.user?.id, replacement.user.id);
  assert.equal(service.status().user?.id, replacement.user.id);
  assert.deepEqual(JSON.parse(backend.values.get(STORAGE_KEY) ?? "null"), {
    version: 1,
    refreshToken: replacement.refresh_token,
  });
  await service.close();
});

test("cloud auth: sign-out awaits bounded remote revocation before command teardown", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("awaited-logout");
  const logoutStarted = deferred<void>();
  const logoutReply = deferred<Response>();
  let logoutAuthorization: string | null = null;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.pathname === "/auth/v1/logout") {
      logoutAuthorization = requestHeaders(input, init).get("authorization");
      logoutStarted.resolve(undefined);
      return logoutReply.promise;
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const service = createService(backend, fetchImpl);
  await service.signIn("logout@example.test", "password123");

  let settled = false;
  const signingOut = service.signOut().then((status) => {
    settled = true;
    return status;
  });
  await logoutStarted.promise;
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(backend.values.has(STORAGE_KEY), false, "local logout must complete first");
  assert.equal(logoutAuthorization, `Bearer ${initial.access_token}`);
  logoutReply.resolve(new Response(null, { status: 204 }));

  assert.deepEqual(await signingOut, { state: "signed_out", signedIn: false });
  await service.close();
});

test("cloud auth: concurrent expired-session requests share one refresh", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("single-flight-old", 1);
  const rotated = session("single-flight-new");
  const refreshReply = deferred<Response>();
  const refreshStarted = deferred<void>();
  let refreshCalls = 0;
  let gatewayCalls = 0;
  const gatewayAuthorizations: Array<string | null> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.searchParams.get("grant_type") === "refresh_token") {
      refreshCalls++;
      refreshStarted.resolve(undefined);
      return refreshReply.promise;
    }
    if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
      gatewayCalls++;
      gatewayAuthorizations.push(requestHeaders(input, init).get("authorization"));
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const service = createService(backend, fetchImpl);
  service.attachBroker(new CredentialBroker());
  await service.signIn("single-flight@example.test", "password123");

  const requests = Array.from({ length: 6 }, () =>
    service.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" }),
  );
  await refreshStarted.promise;
  await Promise.resolve();
  assert.equal(refreshCalls, 1);
  refreshReply.resolve(Response.json(rotated));
  const responses = await Promise.all(requests);

  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(refreshCalls, 1);
  assert.equal(gatewayCalls, 6);
  assert.deepEqual(new Set(gatewayAuthorizations), new Set([`Bearer ${rotated.access_token}`]));
  await service.close();
});

test("cloud auth: host injects one persistent installation token and overrides caller spoofing", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("device-token");
  const observed: Array<string | null> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
      observed.push(requestHeaders(input, init).get(INSTALLATION_TOKEN_HEADER));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;

  const first = createService(backend, fetchImpl);
  first.attachBroker(new CredentialBroker());
  await first.signIn("device-token@example.test", "password123");
  await Promise.all([
    first.gatewayFetch(GATEWAY_URL, {
      method: "POST",
      headers: { [INSTALLATION_TOKEN_HEADER]: "caller-controlled-value" },
      body: "{}",
    }),
    first.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" }),
  ]);
  const persisted = backend.values.get(INSTALLATION_TOKEN_KEY);
  assert.match(persisted ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(observed, [persisted, persisted]);
  await first.signOut();
  assert.equal(
    backend.values.get(INSTALLATION_TOKEN_KEY),
    persisted,
    "sign-out must not reset today's installation quota identity",
  );
  await first.close();

  const restored = createService(backend, fetchImpl);
  restored.attachBroker(new CredentialBroker());
  await restored.signIn("device-token@example.test", "password123");
  await restored.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" });
  assert.equal(observed.at(-1), persisted, "a new process must retain the same device quota key");
  await restored.close();
});

test("cloud auth: staggered 401s for one access revision refresh only once", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("staggered-old");
  const rotated = session("staggered-new");
  const bothOldRequestsStarted = deferred<void>();
  const releaseSecond401 = deferred<void>();
  let oldRequests = 0;
  let refreshCalls = 0;
  let gatewayCalls = 0;
  const gatewayAuthorizations: Array<string | null> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.searchParams.get("grant_type") === "refresh_token") {
      refreshCalls++;
      return Response.json(rotated);
    }
    if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
      gatewayCalls++;
      const headers = requestHeaders(input, init);
      const authorization = headers.get("authorization");
      gatewayAuthorizations.push(authorization);
      if (authorization === `Bearer ${initial.access_token}`) {
        oldRequests++;
        if (oldRequests === 2) bothOldRequestsStarted.resolve(undefined);
        await bothOldRequestsStarted.promise;
        if (headers.get("x-request-id") === "second") await releaseSecond401.promise;
        return new Response("unauthorized", { status: 401 });
      }
      assert.equal(authorization, `Bearer ${rotated.access_token}`);
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const service = createService(backend, fetchImpl);
  service.attachBroker(new CredentialBroker());
  await service.signIn("staggered@example.test", "password123");

  const first = service.gatewayFetch(GATEWAY_URL, {
    method: "POST",
    headers: { "x-request-id": "first" },
    body: "{}",
  });
  const second = service.gatewayFetch(GATEWAY_URL, {
    method: "POST",
    headers: { "x-request-id": "second" },
    body: "{}",
  });
  await bothOldRequestsStarted.promise;
  const firstResponse = await first;
  assert.equal(firstResponse.status, 200);
  assert.equal(refreshCalls, 1);
  releaseSecond401.resolve(undefined);
  const secondResponse = await second;

  assert.equal(secondResponse.status, 200);
  assert.equal(refreshCalls, 1);
  assert.equal(gatewayCalls, 4);
  assert.deepEqual(gatewayAuthorizations, [
    `Bearer ${initial.access_token}`,
    `Bearer ${initial.access_token}`,
    `Bearer ${rotated.access_token}`,
    `Bearer ${rotated.access_token}`,
  ]);
  await Promise.all([firstResponse.body?.cancel(), secondResponse.body?.cancel()]);
  await service.close();
});

test("cloud auth: a gateway 401 refreshes and retries exactly once", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("retry-old");
  const rotated = session("retry-new");
  let refreshCalls = 0;
  let gatewayCalls = 0;
  const gatewayAuthorizations: Array<string | null> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.searchParams.get("grant_type") === "refresh_token") {
      refreshCalls++;
      return Response.json(rotated);
    }
    if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
      gatewayCalls++;
      gatewayAuthorizations.push(requestHeaders(input, init).get("authorization"));
      return new Response("unauthorized", { status: 401 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const service = createService(backend, fetchImpl);
  service.attachBroker(new CredentialBroker());
  await service.signIn("retry@example.test", "password123");

  const response = await service.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" });
  assert.equal(response.status, 401);
  assert.equal(gatewayCalls, 2);
  assert.equal(refreshCalls, 1);
  assert.deepEqual(gatewayAuthorizations, [
    `Bearer ${initial.access_token}`,
    `Bearer ${rotated.access_token}`,
  ]);
  await response.body?.cancel();
  await service.close();
});

test("cloud auth: logout fences an in-flight refresh Keychain write", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("race-old", 1);
  const rotated = session("race-new");
  const refreshWriteStarted = deferred<void>();
  const releaseRefreshWrite = deferred<void>();
  let gatewayCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.searchParams.get("grant_type") === "refresh_token") return Response.json(rotated);
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
      gatewayCalls++;
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const broker = new CredentialBroker();
  const service = createService(backend, fetchImpl);
  service.attachBroker(broker);
  await service.signIn("race@example.test", "password123");
  backend.onPut = async (key, value) => {
    if (key !== STORAGE_KEY) return;
    const stored = JSON.parse(value) as { refreshToken?: string };
    if (stored.refreshToken !== rotated.refresh_token) return;
    refreshWriteStarted.resolve(undefined);
    await releaseRefreshWrite.promise;
  };

  const gateway = service.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" });
  await refreshWriteStarted.promise;
  const logout = service.signOut();
  releaseRefreshWrite.resolve(undefined);

  const logoutStatus = await logout;
  await assert.rejects(
    gateway,
    (error) => error instanceof CloudAuthError && error.code === "sign_in_required",
  );
  assert.deepEqual(logoutStatus, { state: "signed_out", signedIn: false });
  assert.deepEqual(service.status(), { state: "signed_out", signedIn: false });
  assert.equal(backend.values.has(STORAGE_KEY), false);
  assert.ok(backend.deletes.includes(STORAGE_KEY));
  assert.equal(broker.has("gateway:supabase-access"), false);
  assert.equal(gatewayCalls, 0);
  await service.close();
});

test("cloud auth: a 401 released during logout cannot refresh or retry", async () => {
  const backend = new MemorySecretBackend();
  const initial = session("logout-401");
  const gatewayStarted = deferred<void>();
  const releaseGateway = deferred<void>();
  const tombstoneStarted = deferred<void>();
  const releaseTombstone = deferred<void>();
  let refreshCalls = 0;
  let gatewayCalls = 0;
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = requestUrl(input);
    if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
    if (url.searchParams.get("grant_type") === "refresh_token") {
      refreshCalls++;
      return Response.json(session("logout-401-unexpected"));
    }
    if (url.pathname === "/auth/v1/logout") return new Response(null, { status: 204 });
    if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
      gatewayCalls++;
      gatewayStarted.resolve(undefined);
      await releaseGateway.promise;
      return new Response("unauthorized", { status: 401 });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const service = createService(backend, fetchImpl);
  service.attachBroker(new CredentialBroker());
  await service.signIn("logout-401@example.test", "password123");
  backend.onPut = async (key, value) => {
    if (key !== STORAGE_KEY) return;
    const stored = JSON.parse(value) as { revoked?: boolean };
    if (stored.revoked !== true) return;
    tombstoneStarted.resolve(undefined);
    await releaseTombstone.promise;
  };

  const gateway = service.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" });
  await gatewayStarted.promise;
  const logout = service.signOut();
  await tombstoneStarted.promise;
  releaseGateway.resolve(undefined);
  await Promise.resolve();
  releaseTombstone.resolve(undefined);

  await assert.rejects(
    gateway,
    (error) => error instanceof CloudAuthError && error.code === "sign_in_required",
  );
  assert.deepEqual(await logout, { state: "signed_out", signedIn: false });
  assert.deepEqual(service.status(), { state: "signed_out", signedIn: false });
  assert.equal(refreshCalls, 0);
  assert.equal(gatewayCalls, 1);
  assert.equal(backend.values.has(STORAGE_KEY), false);
  await service.close();
});

test("cloud auth: refresh invalid-grant clears persisted and in-memory credentials", async () => {
  for (const status of [400, 401]) {
    const backend = new MemorySecretBackend();
    const initial = session(`invalid-grant-${status}`, 1);
    let gatewayCalls = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
      if (url.searchParams.get("grant_type") === "refresh_token") {
        return new Response("invalid refresh token", { status });
      }
      if (url.pathname.startsWith("/functions/v1/anicode-chat/")) {
        gatewayCalls++;
        return Response.json({ ok: true });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const broker = new CredentialBroker();
    const service = createService(backend, fetchImpl);
    service.attachBroker(broker);
    await service.signIn(`invalid-grant-${status}@example.test`, "password123");
    assert.equal(broker.has("gateway:supabase-access"), true);

    await assert.rejects(
      service.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" }),
      (error) => error instanceof CloudAuthError && error.code === "sign_in_required",
    );
    assert.deepEqual(service.status(), { state: "signed_out", signedIn: false });
    assert.equal(backend.values.has(STORAGE_KEY), false);
    assert.equal(broker.has("gateway:supabase-access"), false);
    assert.equal(gatewayCalls, 0);
    assert.ok(
      backend.puts.some(({ value }) => value === JSON.stringify({ version: 1, revoked: true })),
    );
    await service.close();
  }
});

test("cloud auth: transient refresh failures stay configured without unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const failure of ["network", "server"] as const) {
      const backend = new MemorySecretBackend();
      const stored = session(`transient-${failure}`).refresh_token;
      backend.values.set(STORAGE_KEY, JSON.stringify({ version: 1, refreshToken: stored }));
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = requestUrl(input);
        assert.equal(url.searchParams.get("grant_type"), "refresh_token");
        if (failure === "network") throw new Error("offline");
        return new Response("temporarily unavailable", { status: 503 });
      }) as typeof fetch;
      const service = createService(backend, fetchImpl);

      assert.deepEqual(await service.restore(), { state: "configured", signedIn: false });
      assert.deepEqual(service.status(), { state: "configured", signedIn: false });
      assert.deepEqual(JSON.parse(backend.values.get(STORAGE_KEY) ?? "null"), {
        version: 1,
        refreshToken: stored,
      });
      assert.equal(backend.deletes.length, 0);
      await service.close();
    }

    const backend = new MemorySecretBackend();
    const initial = session("transient-existing-session", 1);
    const broker = new CredentialBroker();
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = requestUrl(input);
      if (url.searchParams.get("grant_type") === "password") return Response.json(initial);
      if (url.searchParams.get("grant_type") === "refresh_token") {
        return new Response("temporarily unavailable", { status: 503 });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const service = createService(backend, fetchImpl);
    service.attachBroker(broker);
    await service.signIn("transient-existing-session@example.test", "password123");
    await assert.rejects(
      service.gatewayFetch(GATEWAY_URL, { method: "POST", body: "{}" }),
      (error) => error instanceof CloudAuthError && error.code === "temporarily_unavailable",
    );
    assert.deepEqual(service.status(), { state: "configured", signedIn: false });
    assert.deepEqual(JSON.parse(backend.values.get(STORAGE_KEY) ?? "null"), {
      version: 1,
      refreshToken: initial.refresh_token,
    });
    assert.equal(broker.has("gateway:supabase-access"), false);
    assert.equal(backend.deletes.length, 0);
    await service.close();

    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
