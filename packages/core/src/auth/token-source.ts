/**
 * 测试隔离的 OAuth 令牌源；生产入口始终 fail closed。
 *
 * 仅显式测试开关可验证临期续期/并发去重兼容逻辑，第三方生产客户端不得消费订阅令牌。
 */

import { t } from "../i18n.js";
import type { AuthStore, OAuthCredential } from "./store.js";
import {
  ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE,
  refreshTokens,
  type OAuthTokens,
} from "./oauth.js";

export interface TokenSource {
  getAccessToken(): Promise<string>;
}

/** 距过期不足这么多毫秒就提前续期（默认 60s），避免请求途中失效。 */
const REFRESH_BUFFER_MS = 60_000;

export interface AnthropicTokenSourceDeps {
  now?: () => number;
  refresh?: typeof refreshTokens;
  allowUnverifiedForTesting?: boolean;
}

export class AnthropicOAuthTokenSource implements TokenSource {
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly store: AuthStore,
    private readonly providerId: string,
    private readonly deps: AnthropicTokenSourceDeps = {},
  ) {}

  async getAccessToken(): Promise<string> {
    if (!this.deps.allowUnverifiedForTesting) {
      throw new Error(ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE);
    }
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
      allowUnverifiedForTesting: true,
    });
    await this.store.set(this.providerId, this.store.fromTokens(tokens));
    return tokens.access;
  }
}
