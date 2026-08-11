import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildAuthUrl,
  challengeFromVerifier,
  parseCallbackCode,
  parseTokenResponse,
  exchangeCode,
  refreshTokens,
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE,
  type OAuthTokens,
} from "./oauth.js";
import { AuthStore, AuthStorePersistenceError } from "./store.js";
import { AnthropicOAuthTokenSource } from "./token-source.js";
import type { SyncSecretBackend } from "../security/secret-backends.js";

class FakeAuthSecretBackend implements SyncSecretBackend {
  readonly kind: string;
  readonly values = new Map<string, string>();
  readonly getCalls: string[] = [];
  readonly putCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  listCalls = 0;

  constructor(kind = "fake-keychain") {
    this.kind = kind;
  }

  getSync(key: string): string | undefined {
    this.getCalls.push(key);
    return this.values.get(key);
  }

  putSync(key: string, value: string): void {
    this.putCalls.push(key);
    this.values.set(key, value);
  }

  deleteSync(key: string): boolean {
    this.deleteCalls.push(key);
    return this.values.delete(key);
  }

  listSync(): string[] {
    this.listCalls++;
    throw new Error("bulk credential enumeration must not be called");
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
    this.listCalls++;
    throw new Error("bulk credential enumeration must not be called");
  }

  resetCalls(): void {
    this.getCalls.length = 0;
    this.putCalls.length = 0;
    this.deleteCalls.length = 0;
    this.listCalls = 0;
  }
}

async function capturedError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected promise to reject");
}

async function assertPrivatePosixFileMode(file: string): Promise<void> {
  // Windows does not expose owner/group/other permissions through POSIX mode bits. The
  // persistence and no-secret behavior remain asserted by the platform-independent checks.
  if (process.platform === "win32") return;
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
}

test("oauth: buildAuthUrl 含 PKCE S256 challenge、client_id、state", () => {
  const { url, verifier, state } = buildAuthUrl({ verifier: "test-verifier", state: "st123" });
  const u = new URL(url);
  assert.equal(u.searchParams.get("client_id"), ANTHROPIC_CLIENT_ID);
  assert.equal(u.searchParams.get("code_challenge_method"), "S256");
  assert.equal(u.searchParams.get("code_challenge"), challengeFromVerifier("test-verifier"));
  assert.equal(u.searchParams.get("state"), "st123");
  assert.equal(verifier, "test-verifier");
  assert.equal(state, "st123");
});

test("oauth: parseCallbackCode 拆 code#state，也容忍只有 code", () => {
  assert.deepEqual(parseCallbackCode("abc#xyz"), { code: "abc", state: "xyz" });
  assert.deepEqual(parseCallbackCode("  onlycode  "), { code: "onlycode" });
});

test("oauth: parseTokenResponse 计算绝对过期时间，缺 access 报错", () => {
  const t = parseTokenResponse({ access_token: "a", refresh_token: "r", expires_in: 100 }, 1_000);
  assert.equal(t.access, "a");
  assert.equal(t.refresh, "r");
  assert.equal(t.expiresAt, 1_000 + 100_000);
  assert.throws(() => parseTokenResponse({ refresh_token: "r" }), /缺少 access_token/);
  assert.throws(
    () => parseTokenResponse({ access_token: "a", expires_in: Number.POSITIVE_INFINITY }),
    /expires_in 无效/,
  );
  assert.throws(
    () => parseTokenResponse({ access_token: "a", expires_in: 24 * 60 * 60 + 1 }),
    /expires_in 无效/,
  );
});

test("oauth: exchangeCode 用注入 fetch 组装正确请求并解析", async () => {
  let captured: { url: string; body: any } | null = null;
  const fakeFetch = (async (url: string, init: any) => {
    captured = { url, body: JSON.parse(init.body) };
    return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 });
  }) as unknown as typeof fetch;
  const t = await exchangeCode(
    { code: "c", verifier: "v", state: "s" },
    { fetch: fakeFetch, now: () => 0, allowUnverifiedForTesting: true },
  );
  assert.equal(t.access, "AT");
  assert.equal(captured!.body.grant_type, "authorization_code");
  assert.equal(captured!.body.code_verifier, "v");
  assert.equal(captured!.body.client_id, ANTHROPIC_CLIENT_ID);
});

test("oauth: production token exchange and token source fail closed", async () => {
  const neverFetch = (async () => {
    throw new Error("network must not be reached");
  }) as unknown as typeof fetch;
  await assert.rejects(
    exchangeCode({ code: "c", verifier: "v" }, { fetch: neverFetch }),
    new RegExp(ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE),
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-disabled-"));
  try {
    const store = new AuthStore(path.join(dir, "auth.json"));
    await store.set("anthropic", {
      type: "oauth",
      access: "must-not-be-used",
      refresh: "must-not-be-used",
      expiresAt: Date.now() + 60_000,
    });
    const source = new AnthropicOAuthTokenSource(store, "anthropic");
    await assert.rejects(
      source.getAccessToken(),
      new RegExp(ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("oauth: refreshTokens 沿用旧 refresh（当响应未回传时）", async () => {
  const fakeFetch = (async () =>
    Response.json({ access_token: "AT2", expires_in: 3600 })) as typeof fetch;
  const t = await refreshTokens("OLD_RT", {
    fetch: fakeFetch,
    now: () => 0,
    allowUnverifiedForTesting: true,
  });
  assert.equal(t.access, "AT2");
  assert.equal(t.refresh, "OLD_RT");
});

test("oauth: non-cooperative fetch 仍受硬截止并收到 abort", async () => {
  let requestSignal: AbortSignal | undefined;
  let resolveLate!: (response: Response) => void;
  let lateResponseCancelled = false;
  const stalled = new Promise<Response>((resolve) => {
    resolveLate = resolve;
  });
  const fakeFetch = (async (_url, init) => {
    requestSignal = init?.signal ?? undefined;
    return stalled;
  }) as typeof fetch;
  const started = Date.now();
  await assert.rejects(
    exchangeCode(
      { code: "sensitive-code", verifier: "sensitive-verifier" },
      {
        fetch: fakeFetch,
        requestTimeoutMs: 20,
        allowUnverifiedForTesting: true,
      },
    ),
    /OAuth token exchange timed out after 20ms/,
  );
  assert.equal(requestSignal?.aborted, true);
  assert.ok(Date.now() - started < 500);
  resolveLate(
    new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          lateResponseCancelled = true;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(lateResponseCancelled, true);
});

test("oauth: caller abort 会传播且错误不会泄漏 refresh token 或 abort reason", async () => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  const refresh = "refresh-secret-value";
  const fakeFetch = (async (_url, init) => {
    requestSignal = init?.signal ?? undefined;
    return new Promise<Response>(() => undefined);
  }) as typeof fetch;
  const pending = refreshTokens(refresh, {
    fetch: fakeFetch,
    signal: controller.signal,
    allowUnverifiedForTesting: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error("abort-secret-value"));
  const error = await capturedError(pending);
  assert.match(error.message, /OAuth refresh was cancelled/);
  assert.doesNotMatch(error.stack ?? error.message, /refresh-secret-value|abort-secret-value/);
  assert.equal(requestSignal?.aborted, true);
});

test("oauth: token response is streamed under a byte limit and cancelled on overflow", async () => {
  let cancelled = false;
  const fakeFetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from(JSON.stringify({ access_token: "x".repeat(256) })));
        },
        cancel() {
          cancelled = true;
        },
      }),
    )) as typeof fetch;
  await assert.rejects(
    exchangeCode(
      { code: "code", verifier: "verifier" },
      { fetch: fakeFetch, maxResponseBytes: 64, allowUnverifiedForTesting: true },
    ),
    /response exceeds 64 bytes/,
  );
  assert.equal(cancelled, true);
});

test("token-source: 未过期直接返回，临期自动刷新并回写", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-"));
  try {
    const store = new AuthStore(path.join(dir, "auth.json"));
    let now = 10_000;
    await store.set("anthropic", {
      type: "oauth",
      access: "A1",
      refresh: "R1",
      expiresAt: 100_000,
    });

    let refreshCalls = 0;
    const src = new AnthropicOAuthTokenSource(store, "anthropic", {
      now: () => now,
      allowUnverifiedForTesting: true,
      refresh: async () => {
        refreshCalls++;
        return { access: "A2", refresh: "R2", expiresAt: now + 3_600_000 };
      },
    });

    assert.equal(await src.getAccessToken(), "A1"); // 未过期
    assert.equal(refreshCalls, 0);

    now = 99_999; // 距过期 <60s
    assert.equal(await src.getAccessToken(), "A2"); // 触发刷新
    assert.equal(refreshCalls, 1);
    const persisted = await store.get("anthropic");
    assert.equal(persisted?.type === "oauth" && persisted.access, "A2"); // 已回写
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("token-source: 并发临期请求共享同一次刷新", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-"));
  try {
    const store = new AuthStore(path.join(dir, "auth.json"));
    await store.set("anthropic", { type: "oauth", access: "A1", refresh: "R1", expiresAt: 0 });
    let refreshCalls = 0;
    const src = new AnthropicOAuthTokenSource(store, "anthropic", {
      now: () => 1_000_000,
      allowUnverifiedForTesting: true,
      refresh: async () => {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 10));
        return { access: "A2", refresh: "R2", expiresAt: 5_000_000 };
      },
    });
    const [a, b, c] = await Promise.all([
      src.getAccessToken(),
      src.getAccessToken(),
      src.getAccessToken(),
    ]);
    assert.deepEqual([a, b, c], ["A2", "A2", "A2"]);
    assert.equal(refreshCalls, 1); // 去重
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("token-source: one aborted waiter cannot cancel the shared refresh", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-refresh-abort-"));
  try {
    const store = new AuthStore(path.join(dir, "auth.json"));
    await store.set("anthropic", { type: "oauth", access: "A1", refresh: "R1", expiresAt: 0 });
    let resolveRefresh!: (tokens: OAuthTokens) => void;
    let refreshStarted!: () => void;
    const result = new Promise<OAuthTokens>((resolve) => {
      resolveRefresh = resolve;
    });
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    let refreshCalls = 0;
    let sharedSignal: AbortSignal | undefined;
    const src = new AnthropicOAuthTokenSource(store, "anthropic", {
      now: () => 1_000_000,
      allowUnverifiedForTesting: true,
      requestTimeoutMs: 1_000,
      refresh: async (_token, deps) => {
        refreshCalls++;
        sharedSignal = deps?.signal;
        refreshStarted();
        return result;
      },
    });
    const controller = new AbortController();
    const disconnected = src.getAccessToken(controller.signal);
    const healthy = src.getAccessToken();
    await started;
    controller.abort(new Error("caller-only abort"));
    await assert.rejects(disconnected, /OAuth token refresh was cancelled/);
    assert.equal(sharedSignal?.aborted, false);
    resolveRefresh({ access: "A2", refresh: "R2", expiresAt: 5_000_000 });
    assert.equal(await healthy, "A2");
    assert.equal(await src.getAccessToken(), "A2");
    assert.equal(refreshCalls, 1);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: set/get/getSync/remove/list，文件 0600", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-"));
  try {
    const file = path.join(dir, "auth.json");
    const store = new AuthStore(file);
    await store.set("anthropic", { type: "oauth", access: "A", refresh: "R", expiresAt: 123 });
    assert.equal((await store.get("anthropic"))?.access, "A");
    assert.equal(store.getSync("anthropic")?.access, "A");
    await assertPrivatePosixFileMode(file);
    const list = await store.list();
    assert.deepEqual(list, [{ providerId: "anthropic", type: "oauth", expiresAt: 123 }]);
    assert.equal(await store.remove("anthropic"), true);
    assert.equal(await store.get("anthropic"), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 统一 memory/no-keychain 策略不接触钥匙串或默认 auth 文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-memory-policy-"));
  const file = path.join(dir, "must-not-exist.json");
  try {
    const store = new AuthStore({
      file,
      env: {
        ANICODE_CREDENTIAL_BACKEND: "memory",
        ANICODE_DISABLE_OS_KEYCHAIN: "1",
      },
    });
    await store.set("anthropic", {
      type: "oauth",
      access: "memory-access",
      refresh: "memory-refresh",
      expiresAt: 123,
    });
    assert.equal((await store.get("anthropic"))?.access, "memory-access");
    assert.deepEqual(await store.list(), [
      { providerId: "anthropic", type: "oauth", expiresAt: 123 },
    ]);
    await assert.rejects(() => fs.stat(file), { code: "ENOENT" });
    await assert.rejects(() => fs.stat(`${file}.lock`), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: no-keychain 策略在构造阶段拒绝显式或旧 alias 钥匙串", () => {
  const backend = new FakeAuthSecretBackend("os-keychain");
  assert.throws(
    () =>
      new AuthStore({
        backend,
        env: { ANICODE_DISABLE_OS_KEYCHAIN: "1" },
      }),
    /forbids access to the operating-system credential store/,
  );
  assert.deepEqual(backend.getCalls, []);
  assert.deepEqual(backend.putCalls, []);

  assert.throws(
    () =>
      new AuthStore({
        backend: "keychain",
        env: { ANICODE_DISABLE_OS_KEYCHAIN: "1" },
      }),
    /forbids access to the operating-system credential store/,
  );

  assert.throws(
    () => new AuthStore({ env: { ANICODE_DISABLE_OS_KEYCHAIN: "1" } }),
    /forbids access to the operating-system credential store/,
  );

  assert.throws(
    () =>
      new AuthStore({
        env: {
          ANICODE_AUTH_BACKEND: "keychain",
          ANICODE_CREDENTIAL_BACKEND: "memory",
        },
      }),
    /ANICODE_AUTH_BACKEND=keychain conflicts with ANICODE_CREDENTIAL_BACKEND=memory/,
  );

  assert.throws(
    () =>
      new AuthStore({
        env: {
          ANICODE_AUTH_BACKEND: "keychain",
          ANICODE_CREDENTIAL_BACKEND: "vault",
        },
      }),
    /ANICODE_AUTH_BACKEND=keychain conflicts with ANICODE_CREDENTIAL_BACKEND=vault/,
  );
});

test("auth store: state 是唯一运行时索引，普通 set/list/get/remove 不碰旧 auth-index", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-index-"));
  const backend = new FakeAuthSecretBackend();
  try {
    const store = new AuthStore({ file: path.join(dir, "legacy.json"), backend });
    await store.set("anthropic", {
      type: "oauth",
      access: "highly-sensitive-access-value",
      refresh: "highly-sensitive-refresh-value",
      expiresAt: 456,
    });
    assert.equal(backend.values.has("auth-index:v1"), false);
    assert.deepEqual(backend.getCalls, ["auth:anthropic"]);
    assert.deepEqual(backend.putCalls, ["auth:anthropic"]);
    assert.deepEqual(backend.deleteCalls, []);
    const stateFile = path.join(dir, "legacy.json.state.json");
    const serializedState = await fs.readFile(stateFile, "utf8");
    assert.deepEqual(JSON.parse(serializedState), {
      version: 1,
      providers: {
        anthropic: { mode: "backend-authoritative", type: "oauth", expiresAt: 456 },
      },
    });
    assert.doesNotMatch(serializedState, /"(?:access|refresh)"\s*:/);
    assert.doesNotMatch(serializedState, /highly-sensitive-(?:access|refresh)-value/);
    await assertPrivatePosixFileMode(stateFile);

    backend.resetCalls();
    assert.deepEqual(await store.list(), [
      { providerId: "anthropic", type: "oauth", expiresAt: 456 },
    ]);
    assert.deepEqual(backend.getCalls, []);
    assert.equal(backend.listCalls, 0);
    assert.deepEqual(backend.putCalls, []);
    assert.deepEqual(backend.deleteCalls, []);

    backend.resetCalls();
    assert.equal((await store.get("anthropic"))?.access, "highly-sensitive-access-value");
    assert.deepEqual(backend.getCalls, ["auth:anthropic"]);
    assert.equal(backend.listCalls, 0);

    backend.resetCalls();
    assert.equal(await store.remove("anthropic"), true);
    assert.deepEqual(backend.getCalls, []);
    assert.deepEqual(backend.putCalls, []);
    assert.deepEqual(backend.deleteCalls, ["auth:anthropic"]);
    assert.equal(backend.values.has("auth-index:v1"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 只有显式 migrateLegacy 读取旧 index，且 tombstone 不被复活", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-index-migration-"));
  const file = path.join(dir, "legacy.json");
  const backend = new FakeAuthSecretBackend();
  const anthropic = {
    type: "oauth" as const,
    access: "revoked-access",
    refresh: "revoked-refresh",
    expiresAt: 111,
  };
  const openai = {
    type: "oauth" as const,
    access: "exact-get-access",
    refresh: "exact-get-refresh",
    expiresAt: 222,
  };
  backend.values.set("auth:anthropic", JSON.stringify(anthropic));
  backend.values.set("auth:openai", JSON.stringify(openai));
  backend.values.set(
    "auth-index:v1",
    JSON.stringify({
      version: 1,
      credentials: {
        anthropic: { type: "oauth", expiresAt: anthropic.expiresAt },
        openai: { type: "oauth", expiresAt: openai.expiresAt },
      },
    }),
  );
  try {
    const store = new AuthStore({ file, backend });
    assert.equal(await store.remove("anthropic"), true);
    assert.ok(backend.values.has("auth-index:v1"), "ordinary remove must leave legacy index alone");

    backend.resetCalls();
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(backend.getCalls, []);
    assert.deepEqual(backend.putCalls, []);
    assert.deepEqual(backend.deleteCalls, []);

    assert.equal((await store.get("openai"))?.access, openai.access);
    assert.deepEqual(backend.getCalls, ["auth:openai"], "exact provider get remains compatible");

    backend.resetCalls();
    assert.deepEqual(await store.migrateLegacy(), { migratedProviderIds: ["openai"] });
    assert.deepEqual(backend.getCalls, ["auth-index:v1"]);
    assert.deepEqual(backend.putCalls, []);
    assert.deepEqual(backend.deleteCalls, ["auth-index:v1"]);
    assert.equal(backend.values.has("auth-index:v1"), false);

    const state = JSON.parse(await fs.readFile(`${file}.state.json`, "utf8"));
    assert.deepEqual(state, {
      version: 1,
      providers: {
        anthropic: { mode: "revoked" },
        openai: { mode: "backend-authoritative", type: "oauth", expiresAt: 222 },
      },
    });
    assert.doesNotMatch(JSON.stringify(state), /"(?:access|refresh)"\s*:/);

    backend.resetCalls();
    assert.deepEqual(await store.list(), [{ providerId: "openai", type: "oauth", expiresAt: 222 }]);
    assert.deepEqual(backend.getCalls, []);
    assert.equal(await store.get("anthropic"), undefined);
    assert.deepEqual(backend.getCalls, [], "revoked provider must fail closed before keychain get");

    backend.values.set("auth-index:v1", JSON.stringify({ version: 1, credentials: {} }));
    backend.resetCalls();
    assert.deepEqual(await store.migrateLegacy(), { migratedProviderIds: [] });
    assert.deepEqual(backend.getCalls, ["auth-index:v1"]);
    assert.deepEqual(backend.deleteCalls, ["auth-index:v1"]);
    assert.equal(backend.values.has("auth-index:v1"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 旧 index 迁移的 state 提交不确定时保留源，重试后收敛", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-index-recovery-"));
  const file = path.join(dir, "legacy.json");
  const backend = new FakeAuthSecretBackend();
  backend.values.set(
    "auth-index:v1",
    JSON.stringify({
      version: 1,
      credentials: { openai: { type: "oauth", expiresAt: 333 } },
    }),
  );
  backend.values.set(
    "auth:openai",
    JSON.stringify({
      type: "oauth",
      access: "recovery-access",
      refresh: "recovery-refresh",
      expiresAt: 333,
    }),
  );
  try {
    let failStateRename = true;
    const faulted = new AuthStore({
      file,
      backend,
      faultInjection: {
        afterRename(target) {
          if (target === "state-file" && failStateRename) {
            failStateRename = false;
            throw new Error("injected historical-index state uncertainty");
          }
        },
      },
    });

    const error = await capturedError(faulted.migrateLegacy());
    assert.ok(error instanceof AuthStorePersistenceError);
    assert.equal(error.target, "state-file");
    assert.equal(error.outcome, "indeterminate");
    assert.ok(backend.values.has("auth-index:v1"), "uncertain commit must retain migration source");
    await assert.rejects(() => fs.stat(file), { code: "ENOENT" });

    const recovered = new AuthStore({ file, backend });
    assert.deepEqual(await recovered.migrateLegacy(), { migratedProviderIds: [] });
    assert.equal(backend.values.has("auth-index:v1"), false);
    assert.deepEqual(await recovered.list(), [
      { providerId: "openai", type: "oauth", expiresAt: 333 },
    ]);
    assert.equal((await recovered.get("openai"))?.access, "recovery-access");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 普通 get 对旧 auth.json 只读，显式 migrateLegacy 才迁移", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-explicit-migration-"));
  const file = path.join(dir, "auth.json");
  const backend = new FakeAuthSecretBackend();
  const legacy = {
    anthropic: {
      type: "oauth" as const,
      access: "legacy-access",
      refresh: "legacy-refresh",
      expiresAt: 789,
    },
  };
  try {
    const source = `${JSON.stringify(legacy, null, 2)}\n`;
    await fs.writeFile(file, source, { mode: 0o600 });
    const store = new AuthStore({ file, backend });

    assert.equal((await store.get("anthropic"))?.access, "legacy-access");
    assert.equal(store.getSync("anthropic")?.refresh, "legacy-refresh");
    assert.equal(await fs.readFile(file, "utf8"), source);
    assert.deepEqual(backend.putCalls, []);
    assert.equal(backend.values.size, 0);

    assert.deepEqual(await store.migrateLegacy(), { migratedProviderIds: ["anthropic"] });
    assert.equal(
      JSON.parse(backend.values.get("auth:anthropic") ?? "null").access,
      "legacy-access",
    );
    assert.equal(backend.values.has("auth-index:v1"), false);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 显式迁移遇到冲突时保留源文件且不改后端", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-migration-conflict-"));
  const file = path.join(dir, "auth.json");
  const backend = new FakeAuthSecretBackend();
  const legacy = {
    anthropic: {
      type: "oauth" as const,
      access: "legacy-access",
      refresh: "legacy-refresh",
      expiresAt: 123,
    },
  };
  const existing = {
    type: "oauth" as const,
    access: "backend-access",
    refresh: "backend-refresh",
    expiresAt: 456,
  };
  try {
    const source = `${JSON.stringify(legacy, null, 2)}\n`;
    await fs.writeFile(file, source, { mode: 0o600 });
    backend.values.set("auth:anthropic", JSON.stringify(existing));
    const store = new AuthStore({ file, backend });

    await assert.rejects(() => store.migrateLegacy(), /migration conflict for anthropic/);
    assert.equal(await fs.readFile(file, "utf8"), source);
    assert.deepEqual(JSON.parse(backend.values.get("auth:anthropic") ?? "null"), existing);
    assert.equal(backend.values.has("auth-index:v1"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: set 的 state rename 后报错时保留目标与 legacy，重试可收敛", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-set-indeterminate-"));
  const file = path.join(dir, "auth.json");
  const backend = new FakeAuthSecretBackend();
  const legacy = {
    anthropic: {
      type: "oauth" as const,
      access: "legacy-access",
      refresh: "legacy-refresh",
      expiresAt: 100,
    },
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    let failStateRename = true;
    const faulted = new AuthStore({
      file,
      backend,
      faultInjection: {
        afterRename(target) {
          if (target === "state-file" && failStateRename) {
            failStateRename = false;
            throw new Error("injected post-state-rename failure");
          }
        },
      },
    });
    const replacement = {
      type: "oauth" as const,
      access: "replacement-access",
      refresh: "replacement-refresh",
      expiresAt: 200,
    };

    const error = await capturedError(faulted.set("anthropic", replacement));
    assert.ok(error instanceof AuthStorePersistenceError);
    assert.equal(error.target, "state-file");
    assert.equal(error.outcome, "indeterminate");
    assert.equal(
      JSON.parse(backend.values.get("auth:anthropic") ?? "null").access,
      replacement.access,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), legacy);
    assert.equal((await faulted.get("anthropic"))?.access, replacement.access);

    let failAuthRename = true;
    const cleanupFaulted = new AuthStore({
      file,
      backend,
      faultInjection: {
        afterRename(target) {
          if (target === "auth-file" && failAuthRename) {
            failAuthRename = false;
            throw new Error("injected post-legacy-cleanup rename failure");
          }
        },
      },
    });
    const cleanupError = await capturedError(cleanupFaulted.set("anthropic", replacement));
    assert.ok(cleanupError instanceof AuthStorePersistenceError);
    assert.equal(cleanupError.target, "auth-file");
    assert.equal(cleanupError.outcome, "indeterminate");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {});
    assert.equal((await cleanupFaulted.get("anthropic"))?.access, replacement.access);

    const recovered = new AuthStore({ file, backend });
    await recovered.set("anthropic", replacement);
    assert.equal((await recovered.get("anthropic"))?.access, replacement.access);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: migrate 在 auth.json rename 后报错不回滚目标，恢复后无数据丢失", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-migrate-indeterminate-"));
  const file = path.join(dir, "auth.json");
  const backend = new FakeAuthSecretBackend();
  const legacy = {
    anthropic: {
      type: "oauth" as const,
      access: "migration-access",
      refresh: "migration-refresh",
      expiresAt: 300,
    },
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    let failAuthRename = true;
    const store = new AuthStore({
      file,
      backend,
      faultInjection: {
        afterRename(target) {
          if (target === "auth-file" && failAuthRename) {
            failAuthRename = false;
            throw new Error("injected post-auth-rename failure");
          }
        },
      },
    });

    const error = await capturedError(store.migrateLegacy());
    assert.ok(error instanceof AuthStorePersistenceError);
    assert.equal(error.target, "auth-file");
    assert.equal(error.outcome, "indeterminate");
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {});
    assert.equal(
      JSON.parse(backend.values.get("auth:anthropic") ?? "null").access,
      legacy.anthropic.access,
    );
    assert.equal((await store.get("anthropic"))?.access, legacy.anthropic.access);
    assert.deepEqual(await new AuthStore({ file, backend }).migrateLegacy(), {
      migratedProviderIds: [],
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: remove 先提交无密钥 tombstone，state rename 不确定时旧凭据不会复活", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-remove-tombstone-"));
  const file = path.join(dir, "auth.json");
  const backend = new FakeAuthSecretBackend();
  const legacy = {
    anthropic: {
      type: "oauth" as const,
      access: "legacy-must-stay-revoked",
      refresh: "legacy-refresh-must-stay-revoked",
      expiresAt: 400,
    },
  };
  const backendCredential = {
    type: "oauth" as const,
    access: "backend-must-stay-revoked",
    refresh: "backend-refresh-must-stay-revoked",
    expiresAt: 500,
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(legacy, null, 2)}\n`, { mode: 0o600 });
    backend.values.set("auth:anthropic", JSON.stringify(backendCredential));
    let failStateRename = true;
    const faulted = new AuthStore({
      file,
      backend,
      faultInjection: {
        afterRename(target) {
          if (target === "state-file" && failStateRename) {
            failStateRename = false;
            throw new Error("injected revocation commit uncertainty");
          }
        },
      },
    });

    const error = await capturedError(faulted.remove("anthropic"));
    assert.ok(error instanceof AuthStorePersistenceError);
    assert.equal(error.target, "state-file");
    assert.equal(error.outcome, "indeterminate");
    assert.ok(backend.values.has("auth:anthropic"), "cleanup must not start after uncertain state");
    assert.deepEqual(backend.getCalls, []);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), legacy);
    assert.equal(await faulted.get("anthropic"), undefined);
    assert.equal(faulted.getSync("anthropic"), undefined);

    const stateText = await fs.readFile(`${file}.state.json`, "utf8");
    assert.match(stateText, /"mode": "revoked"/);
    assert.doesNotMatch(stateText, /must-stay-revoked/);

    let failAuthRename = true;
    const cleanupFaulted = new AuthStore({
      file,
      backend,
      faultInjection: {
        afterRename(target) {
          if (target === "auth-file" && failAuthRename) {
            failAuthRename = false;
            throw new Error("injected revoked-source cleanup uncertainty");
          }
        },
      },
    });
    const cleanupError = await capturedError(cleanupFaulted.remove("anthropic"));
    assert.ok(cleanupError instanceof AggregateError);
    assert.match(cleanupError.message, /revoked but physical cleanup is incomplete/);
    assert.equal(backend.values.has("auth:anthropic"), false);
    assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {});
    assert.equal(await cleanupFaulted.get("anthropic"), undefined);

    const recovered = new AuthStore({ file, backend });
    assert.equal(await recovered.remove("anthropic"), false);
    assert.equal(await recovered.get("anthropic"), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 损坏文件 fail-close，不会被下一次 set 静默覆盖", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-corrupt-"));
  const file = path.join(dir, "auth.json");
  try {
    await fs.writeFile(file, "{ definitely-not-json", { mode: 0o600 });
    const store = new AuthStore(file);
    await assert.rejects(() => store.get("anthropic"), /Invalid credential file JSON/);
    assert.throws(() => store.getSync("anthropic"), /Invalid credential file JSON/);
    await assert.rejects(
      () => store.set("anthropic", { type: "oauth", access: "A", refresh: "R", expiresAt: 1 }),
      /Invalid credential file JSON/,
    );
    assert.equal(await fs.readFile(file, "utf8"), "{ definitely-not-json");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 多实例并发更新经文件锁串行，不丢 provider", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-concurrent-"));
  const file = path.join(dir, "auth.json");
  try {
    const stores = [new AuthStore(file), new AuthStore(file)];
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        stores[index % stores.length]!.set(`provider-${index}`, {
          type: "oauth",
          access: `A${index}`,
          refresh: `R${index}`,
          expiresAt: index + 1,
        }),
      ),
    );
    const list = await stores[0]!.list();
    assert.equal(list.length, 40);
    for (let index = 0; index < 40; index++) {
      assert.equal((await stores[1]!.get(`provider-${index}`))?.access, `A${index}`);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 不同 legacy 文件共享同一 durable backend 时由 coordination lock 串行", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-backend-lock-domain-"));
  const backend = new FakeAuthSecretBackend();
  const coordinationFile = path.join(dir, "shared-backend-state.json");
  try {
    const stores = [
      new AuthStore({ file: path.join(dir, "legacy-a.json"), backend, coordinationFile }),
      new AuthStore({ file: path.join(dir, "legacy-b.json"), backend, coordinationFile }),
    ];
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        stores[index % stores.length]!.set(`shared-${index}`, {
          type: "oauth",
          access: `A${index}`,
          refresh: `R${index}`,
          expiresAt: index + 1,
        }),
      ),
    );

    assert.equal(backend.values.has("auth-index:v1"), false);
    assert.equal(
      [...backend.getCalls, ...backend.putCalls, ...backend.deleteCalls].includes("auth-index:v1"),
      false,
    );
    const durableStateText = await fs.readFile(coordinationFile, "utf8");
    assert.doesNotMatch(durableStateText, /"(?:access|refresh)"\s*:/);
    const durableState = JSON.parse(durableStateText) as {
      providers: Record<string, unknown>;
    };
    assert.equal(Object.keys(durableState.providers).length, 20);
    assert.equal((await stores[0]!.list()).length, 20);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: set 在写文件或 keychain 前拒绝无效的运行时凭证", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-invalid-"));
  const file = path.join(dir, "auth.json");
  try {
    const store = new AuthStore(file);
    await assert.rejects(
      () =>
        store.set("anthropic", {
          type: "oauth",
          access: "A",
          refresh: "R",
          expiresAt: Number.NaN,
        }),
      /Invalid credential entry/,
    );
    await assert.rejects(() => fs.stat(file), { code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 不会仅因活跃进程持锁时间较长而抢占锁", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-live-lock-"));
  const file = path.join(dir, "auth.json");
  const lock = `${file}.lock`;
  try {
    await fs.writeFile(
      lock,
      JSON.stringify({ pid: process.pid, token: "live-owner-token-000000000000" }),
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    const started = Date.now();
    const release = setTimeout(() => void fs.rm(lock, { force: true }), 60);
    try {
      await new AuthStore(file).set("anthropic", {
        type: "oauth",
        access: "A",
        refresh: "R",
        expiresAt: 1,
      });
    } finally {
      clearTimeout(release);
    }
    assert.ok(Date.now() - started >= 40, "writer should wait for the live lock owner");
    assert.equal((await new AuthStore(file).get("anthropic"))?.access, "A");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("auth store: 提交后的锁清理错误不改写成功结果，并保留残留锁诊断", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-lock-cleanup-"));
  const file = path.join(dir, "auth.json");
  const lock = `${file}.lock`;
  let warningHandler: ((warning: Error) => void) | undefined;
  try {
    const warning = new Promise<Error>((resolve) => {
      warningHandler = (emitted) => {
        if ((emitted as Error & { code?: string }).code === "ANICODE_AUTH_LOCK_CLEANUP_FAILED") {
          resolve(emitted);
        }
      };
      process.on("warning", warningHandler);
    });
    let damageLock = true;
    const store = new AuthStore({
      file,
      backend: "file",
      faultInjection: {
        async afterRename(target) {
          if (target === "auth-file" && damageLock) {
            damageLock = false;
            await fs.writeFile(lock, "{ damaged-lock-metadata", "utf8");
          }
        },
      },
    });

    await store.set("anthropic", {
      type: "oauth",
      access: "committed-access",
      refresh: "committed-refresh",
      expiresAt: 123,
    });

    const emitted = await warning;
    assert.match(emitted.message, /mutation completed successfully/);
    assert.match(emitted.message, /manually removing the abandoned lock/);
    assert.equal(JSON.parse(await fs.readFile(file, "utf8")).anthropic.access, "committed-access");
    assert.equal(await fs.readFile(lock, "utf8"), "{ damaged-lock-metadata");

    // Manual recovery is deliberately exact and only safe after all writers
    // have stopped; no automatic stale-lock stealing occurs.
    await fs.rm(lock);
    assert.equal((await new AuthStore(file).get("anthropic"))?.access, "committed-access");
  } finally {
    if (warningHandler) process.off("warning", warningHandler);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
