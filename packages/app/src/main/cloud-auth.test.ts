import { test } from "node:test";
import assert from "node:assert/strict";
import { CredentialBroker, type SecretBackend } from "@anicode/core";
import { CloudAuthError, CloudAuthService } from "./cloud-auth.js";

const PROJECT_URL = "https://fixture.supabase.co";
const GATEWAY_URL = `${PROJECT_URL}/functions/v1/anicode-chat/v1/chat/completions`;
const STORAGE_KEY = "auth:supabase-refresh";

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

function createService(backend: MemorySecretBackend, fetchImpl: typeof fetch): CloudAuthService {
  return new CloudAuthService({
    backend,
    projectUrl: PROJECT_URL,
    publishableKey: "sb_publishable_cloud_auth_test",
    fetch: fetchImpl,
  });
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
