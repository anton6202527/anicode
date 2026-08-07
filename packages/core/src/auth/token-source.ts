/**
 * 测试隔离的 OAuth 令牌源；生产入口始终 fail closed。
 *
 * 仅显式测试开关可验证临期续期/并发去重兼容逻辑，第三方生产客户端不得消费订阅令牌。
 */

import { t } from "../i18n.js";
import {
  credentialRequestTimeout,
  safeCredentialError,
  withCredentialDeadline,
} from "../security/credential-io.js";
import type { AuthStore, OAuthCredential } from "./store.js";
import {
  ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE,
  refreshTokens,
  type OAuthTokens,
} from "./oauth.js";

export interface TokenSource {
  getAccessToken(signal?: AbortSignal): Promise<string>;
}

/** 距过期不足这么多毫秒就提前续期（默认 60s），避免请求途中失效。 */
const REFRESH_BUFFER_MS = 60_000;

export interface AnthropicTokenSourceDeps {
  now?: () => number;
  refresh?: typeof refreshTokens;
  allowUnverifiedForTesting?: boolean;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

export class AnthropicOAuthTokenSource implements TokenSource {
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly store: AuthStore,
    private readonly providerId: string,
    private readonly deps: AnthropicTokenSourceDeps = {},
  ) {}

  async getAccessToken(signal?: AbortSignal): Promise<string> {
    if (!this.deps.allowUnverifiedForTesting) {
      throw new Error(ANTHROPIC_SUBSCRIPTION_OAUTH_DISABLED_MESSAGE);
    }
    if (signal?.aborted) throw safeCredentialError("OAuth token refresh was cancelled");
    const now = (this.deps.now ?? Date.now)();
    const cred = await this.store.get(this.providerId);
    if (signal?.aborted) throw safeCredentialError("OAuth token refresh was cancelled");
    if (!cred || cred.type !== "oauth") {
      throw new Error(
        t(
          `${this.providerId} is not logged in via OAuth; run auth login first`,
          `${this.providerId} 未登录 OAuth，请先运行 auth login`,
        ),
      );
    }
    if (cred.expiresAt - now > REFRESH_BUFFER_MS) return cred.access;
    const timeoutMs = credentialRequestTimeout(this.deps.requestTimeoutMs, 30_000);
    const refresh = this.refreshing ?? this.startRefresh(cred, timeoutMs);
    // 刷新操作自身有硬截止；单个 caller 取消时只停止等待，不影响其他共享 waiter。
    return withCredentialDeadline("OAuth token refresh", timeoutMs, signal, async () => refresh);
  }

  private startRefresh(cred: OAuthCredential, timeoutMs: number): Promise<string> {
    const refresh = withCredentialDeadline("OAuth token refresh", timeoutMs, undefined, (signal) =>
      this.doRefresh(cred, signal),
    ).finally(() => {
      if (this.refreshing === refresh) this.refreshing = null;
    });
    this.refreshing = refresh;
    return refresh;
  }

  private async doRefresh(cred: OAuthCredential, signal?: AbortSignal): Promise<string> {
    if (!cred.refresh)
      throw safeCredentialError(
        t(
          `${this.providerId} is missing refresh_token; please re-run auth login`,
          `${this.providerId} 缺少 refresh_token，请重新 auth login`,
        ),
      );
    const refresh = this.deps.refresh ?? refreshTokens;
    const tokens: OAuthTokens = await refresh(cred.refresh, {
      ...(this.deps.now ? { now: this.deps.now } : {}),
      ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}),
      ...(this.deps.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.deps.requestTimeoutMs }
        : {}),
      ...(this.deps.maxResponseBytes !== undefined
        ? { maxResponseBytes: this.deps.maxResponseBytes }
        : {}),
      ...(signal ? { signal } : {}),
      allowUnverifiedForTesting: true,
    });
    if (signal?.aborted) throw safeCredentialError("OAuth token refresh was cancelled");
    await this.store.set(this.providerId, this.store.fromTokens(tokens));
    return tokens.access;
  }
}
