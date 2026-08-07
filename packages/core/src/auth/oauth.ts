/**
 * Anthropic 订阅 OAuth 的隔离实现。
 *
 * 第三方客户端在获得 Anthropic 明确书面授权前不得走这条生产路径。授权 URL、PKCE 与
 * 响应解析保留为离线兼容测试；所有会产生网络请求或消费令牌的入口默认 fail closed，
 * 仅允许显式的测试依赖开启。
 */

import { createHash, randomBytes } from "node:crypto";
import { t } from "../i18n.js";
import {
  credentialFetch,
  discardCredentialResponse,
  readCredentialJson,
  safeCredentialError,
} from "../security/credential-io.js";

/** Claude Code 公开的 OAuth client_id（公共标识，非机密）。 */
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference";
/** OAuth 访问需带的 beta 头，标识订阅令牌路径。 */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";
const MAX_OAUTH_ACCESS_TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface OAuthTokens {
  access: string;
  refresh: string;
  /** 绝对过期时间（epoch ms）。 */
  expiresAt: number;
}

export interface AuthorizationRequest {
  url: string;
  verifier: string;
  state: string;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 生成 PKCE code_verifier（高熵、URL 安全）。 */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

/** 由 verifier 派生 S256 challenge。 */
export function challengeFromVerifier(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** 构造授权 URL 与配套 PKCE 材料。传入随机源便于测试确定化。 */
export function buildAuthUrl(
  gen: { verifier?: string; state?: string } = {},
): AuthorizationRequest {
  const verifier = gen.verifier ?? createVerifier();
  const state = gen.state ?? base64url(randomBytes(16));
  const params = new URLSearchParams({
    code: "true",
    client_id: ANTHROPIC_CLIENT_ID,
    response_type: "code",
    redirect_uri: ANTHROPIC_REDIRECT_URI,
    scope: ANTHROPIC_SCOPES,
    code_challenge: challengeFromVerifier(verifier),
    code_challenge_method: "S256",
    state,
  });
  return { url: `${ANTHROPIC_AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

/**
 * 回调页展示的值形如 `code#state`（也容忍用户只粘 code）。拆出 code 与 state。
 */
export function parseCallbackCode(pasted: string): { code: string; state?: string } {
  const trimmed = pasted.trim();
  const hash = trimmed.indexOf("#");
  if (hash < 0) return { code: trimmed };
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}

/** 把 token endpoint 的 JSON 响应解析成 OAuthTokens（纯函数，便于测试）。 */
export function parseTokenResponse(json: unknown, now: number = Date.now()): OAuthTokens {
  const o = (json ?? {}) as Record<string, unknown>;
  const access = typeof o["access_token"] === "string" ? (o["access_token"] as string) : "";
  const refresh = typeof o["refresh_token"] === "string" ? (o["refresh_token"] as string) : "";
  const expiresIn = o["expires_in"] === undefined ? 3600 : o["expires_in"];
  if (!access.trim())
    throw safeCredentialError(
      t("OAuth response is missing access_token", "OAuth 响应缺少 access_token"),
    );
  if (
    typeof expiresIn !== "number" ||
    !Number.isFinite(expiresIn) ||
    expiresIn < 0 ||
    expiresIn > MAX_OAUTH_ACCESS_TOKEN_TTL_SECONDS
  ) {
    throw safeCredentialError(
      t("OAuth response has invalid expires_in", "OAuth 响应 expires_in 无效"),
    );
  }
  const expiresAt = now + expiresIn * 1_000;
  if (!Number.isFinite(now) || !Number.isFinite(expiresAt)) {
    throw safeCredentialError(t("OAuth response expiry is out of range", "OAuth 响应过期时间越界"));
  }
  return { access, refresh, expiresAt };
}

type FetchLike = typeof fetch;

export interface OAuthRequestDeps {
  fetch?: FetchLike;
  now?: () => number;
  allowUnverifiedForTesting?: boolean;
  /** Absolute fetch + response-consumption deadline. Default: 30 seconds. */
  requestTimeoutMs?: number;
  /** Maximum token endpoint response size. Default: 256 KiB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export const ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE =
  "Anthropic subscription OAuth is disabled pending explicit written authorization for third-party clients; use an Anthropic API key or an officially supported enterprise provider";

function requireTestOnlyOAuth(allowed: boolean | undefined): void {
  if (!allowed) throw new Error(ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE);
}

/** 用授权码换取 token。 */
export async function exchangeCode(
  input: { code: string; verifier: string; state?: string },
  deps: OAuthRequestDeps = {},
): Promise<OAuthTokens> {
  requireTestOnlyOAuth(deps.allowUnverifiedForTesting);
  if (!input.code.trim() || !input.verifier.trim()) {
    throw new Error("OAuth authorization code and verifier are required");
  }
  return credentialFetch(
    {
      label: "OAuth token exchange",
      fetch: deps.fetch ?? fetch,
      input: ANTHROPIC_TOKEN_URL,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code: input.code,
          ...(input.state ? { state: input.state } : {}),
          client_id: ANTHROPIC_CLIENT_ID,
          redirect_uri: ANTHROPIC_REDIRECT_URI,
          code_verifier: input.verifier,
        }),
      },
      requestTimeoutMs: deps.requestTimeoutMs ?? 30_000,
      maxResponseBytes: deps.maxResponseBytes ?? 256 * 1024,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    async (response, signal, maximumBytes) => {
      if (!response.ok) {
        discardCredentialResponse(response, "OAuth token exchange rejected");
        throw safeCredentialError(
          t(
            `OAuth token exchange failed (HTTP ${response.status})`,
            `OAuth 令牌交换失败（HTTP ${response.status}）`,
          ),
        );
      }
      const body = await readCredentialJson<unknown>(
        response,
        maximumBytes,
        signal,
        "OAuth token exchange",
      );
      return parseTokenResponse(body, (deps.now ?? Date.now)());
    },
  );
}

/** 用 refresh_token 续期。 */
export async function refreshTokens(
  refresh: string,
  deps: OAuthRequestDeps = {},
): Promise<OAuthTokens> {
  requireTestOnlyOAuth(deps.allowUnverifiedForTesting);
  if (!refresh.trim()) throw new Error("OAuth refresh token is required");
  return credentialFetch(
    {
      label: "OAuth refresh",
      fetch: deps.fetch ?? fetch,
      input: ANTHROPIC_TOKEN_URL,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refresh,
          client_id: ANTHROPIC_CLIENT_ID,
        }),
      },
      requestTimeoutMs: deps.requestTimeoutMs ?? 30_000,
      maxResponseBytes: deps.maxResponseBytes ?? 256 * 1024,
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    async (response, signal, maximumBytes) => {
      if (!response.ok) {
        discardCredentialResponse(response, "OAuth refresh rejected");
        throw safeCredentialError(
          t(
            `OAuth refresh failed (HTTP ${response.status})`,
            `OAuth 续期失败（HTTP ${response.status}）`,
          ),
        );
      }
      const body = await readCredentialJson<unknown>(
        response,
        maximumBytes,
        signal,
        "OAuth refresh",
      );
      const tokens = parseTokenResponse(body, (deps.now ?? Date.now)());
      // 部分实现续期不回传 refresh_token；沿用旧的，避免丢失续期能力。
      if (!tokens.refresh) tokens.refresh = refresh;
      return tokens;
    },
  );
}
