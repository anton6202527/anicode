/**
 * Anthropic OAuth（Claude Pro/Max 订阅登录）—— PKCE 授权码流。
 *
 * 让用户用已有的 Claude 订阅直接跑 agent，无需去控制台建 API key（对齐 opencode 的
 * `auth login`，降低采用门槛）。流程：
 *   1. buildAuthUrl() 生成授权 URL + PKCE verifier + state；用户在浏览器授权；
 *   2. 回调页展示 `code#state`，用户粘回；exchangeCode() 换取 access/refresh token；
 *   3. token 存 AuthStore；请求时带 `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`；
 *   4. 临期用 refreshTokens() 续期。
 *
 * 纯函数（PKCE / URL / 响应解析）无 I/O、可离线测试；网络交换用注入式 fetch 便于测试。
 */

import { createHash, randomBytes } from "node:crypto";
import { t } from "../i18n.js";

/** Claude Code 公开的 OAuth client_id（公共标识，非机密）。 */
export const ANTHROPIC_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
export const ANTHROPIC_AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
export const ANTHROPIC_TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
export const ANTHROPIC_REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
export const ANTHROPIC_SCOPES = "org:create_api_key user:profile user:inference";
/** OAuth 访问需带的 beta 头，标识订阅令牌路径。 */
export const ANTHROPIC_OAUTH_BETA = "oauth-2025-04-20";

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
  const expiresIn = typeof o["expires_in"] === "number" ? (o["expires_in"] as number) : 3600;
  if (!access)
    throw new Error(t("OAuth response is missing access_token", "OAuth 响应缺少 access_token"));
  return { access, refresh, expiresAt: now + Math.max(0, expiresIn) * 1000 };
}

type FetchLike = typeof fetch;

/** 用授权码换取 token。 */
export async function exchangeCode(
  input: { code: string; verifier: string; state?: string },
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<OAuthTokens> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(ANTHROPIC_TOKEN_URL, {
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
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(
      t(
        `OAuth token exchange failed (HTTP ${res.status}): ${detail}`,
        `OAuth 令牌交换失败（HTTP ${res.status}）: ${detail}`,
      ),
    );
  }
  return parseTokenResponse(await res.json(), (deps.now ?? Date.now)());
}

/** 用 refresh_token 续期。 */
export async function refreshTokens(
  refresh: string,
  deps: { fetch?: FetchLike; now?: () => number } = {},
): Promise<OAuthTokens> {
  const doFetch = deps.fetch ?? fetch;
  const res = await doFetch(ANTHROPIC_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: ANTHROPIC_CLIENT_ID,
    }),
  });
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(
      t(
        `OAuth refresh failed (HTTP ${res.status}): ${detail}`,
        `OAuth 续期失败（HTTP ${res.status}）: ${detail}`,
      ),
    );
  }
  const tokens = parseTokenResponse(await res.json(), (deps.now ?? Date.now)());
  // 部分实现续期不回传 refresh_token；沿用旧的，避免丢失续期能力。
  if (!tokens.refresh) tokens.refresh = refresh;
  return tokens;
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
