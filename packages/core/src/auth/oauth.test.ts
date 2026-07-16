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
} from "./oauth.js";
import { AuthStore } from "./store.js";
import { AnthropicOAuthTokenSource } from "./token-source.js";

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
});

test("oauth: exchangeCode 用注入 fetch 组装正确请求并解析", async () => {
  let captured: { url: string; body: any } | null = null;
  const fakeFetch = (async (url: string, init: any) => {
    captured = { url, body: JSON.parse(init.body) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }),
    };
  }) as unknown as typeof fetch;
  const t = await exchangeCode(
    { code: "c", verifier: "v", state: "s" },
    { fetch: fakeFetch, now: () => 0 },
  );
  assert.equal(t.access, "AT");
  assert.equal(captured!.body.grant_type, "authorization_code");
  assert.equal(captured!.body.code_verifier, "v");
  assert.equal(captured!.body.client_id, ANTHROPIC_CLIENT_ID);
});

test("oauth: refreshTokens 沿用旧 refresh（当响应未回传时）", async () => {
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "AT2", expires_in: 3600 }),
  })) as unknown as typeof fetch;
  const t = await refreshTokens("OLD_RT", { fetch: fakeFetch, now: () => 0 });
  assert.equal(t.access, "AT2");
  assert.equal(t.refresh, "OLD_RT");
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

test("auth store: set/get/getSync/remove/list，文件 0600", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-"));
  try {
    const file = path.join(dir, "auth.json");
    const store = new AuthStore(file);
    await store.set("anthropic", { type: "oauth", access: "A", refresh: "R", expiresAt: 123 });
    assert.equal((await store.get("anthropic"))?.access, "A");
    assert.equal(store.getSync("anthropic")?.access, "A");
    const stat = await fs.stat(file);
    assert.equal(stat.mode & 0o777, 0o600);
    const list = await store.list();
    assert.deepEqual(list, [{ providerId: "anthropic", type: "oauth", expiresAt: 123 }]);
    assert.equal(await store.remove("anthropic"), true);
    assert.equal(await store.get("anthropic"), undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
