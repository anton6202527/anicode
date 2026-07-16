/**
 * OAuth 令牌源 —— 给 provider 一个「随取随用、临期自动续期」的 access token。
 *
 * provider 每次请求前调用 getAccessToken()：若 token 距过期不足 buffer，就用 refresh_token
 * 续期并回写 AuthStore；并发请求共享同一次续期 Promise，避免重复刷新。
 */

import { t } from "../i18n.js";
import type { AuthStore, OAuthCredential } from "./store.js";
import { refreshTokens, type OAuthTokens } from "./oauth.js";

export interface TokenSource {
  getAccessToken(): Promise<string>;
}

/** 距过期不足这么多毫秒就提前续期（默认 60s），避免请求途中失效。 */
const REFRESH_BUFFER_MS = 60_000;

export interface AnthropicTokenSourceDeps {
  now?: () => number;
  refresh?: typeof refreshTokens;
}

export class AnthropicOAuthTokenSource implements TokenSource {
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly store: AuthStore,
    private readonly providerId: string,
    private readonly deps: AnthropicTokenSourceDeps = {},
  ) {}

  async getAccessToken(): Promise<string> {
    const now = (this.deps.now ?? Date.now)();
    const cred = await this.store.get(this.providerId);
    if (!cred || cred.type !== "oauth") {
      throw new Error(
        t(
          `${this.providerId} is not logged in via OAuth; run auth login first`,
          `${this.providerId} 未登录 OAuth，请先运行 auth login`,
        ),
      );
    }
    if (cred.expiresAt - now > REFRESH_BUFFER_MS) return cred.access;
    // 并发续期去重：所有等待者共享同一次刷新。
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(cred).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async doRefresh(cred: OAuthCredential): Promise<string> {
    if (!cred.refresh)
      throw new Error(
        t(
          `${this.providerId} is missing refresh_token; please re-run auth login`,
          `${this.providerId} 缺少 refresh_token，请重新 auth login`,
        ),
      );
    const refresh = this.deps.refresh ?? refreshTokens;
    const tokens: OAuthTokens = await refresh(cred.refresh, {
      ...(this.deps.now ? { now: this.deps.now } : {}),
    });
    await this.store.set(this.providerId, this.store.fromTokens(tokens));
    return tokens.access;
  }
}
