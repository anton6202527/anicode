# AniCode 免费 DeepSeek 网关与安装实例配额

日期：2026-08-17

## 决策

AniCode Cloud 为已登录用户默认提供 `deepseek-v4-flash`，用户不需要配置 DeepSeek Key；
`deepseek-v4-pro` 不进入免费目录，只允许后续付费 entitlement 或用户自带 Key（BYOK）。采购的
`DEEPSEEK_API_KEY` 只保存在 Supabase Edge Function 的服务端 Secret 中。

免费层按“受保护的安装实例”计量，而不宣称不可绕过的物理设备指纹：宿主首次调用网关时生成
256-bit 随机凭证并保存到 OS Keychain，服务端只保存它的 HMAC-SHA256 pseudonym。MAC 地址、磁盘
序列号、邮箱和原始安装凭证均不进入配额表，也不发送给 DeepSeek。

当前 Supabase 项目还承载 `anime-armory`。免费入口要求 AniCode 正式账号登录，不在该共享项目中开启
匿名登录。Supabase 匿名用户同样使用 `authenticated` PostgreSQL role；若未来要做无账号试用，应迁入
独立项目，先审计所有 RLS，再增加 IP/ASN、注册频率、设备轮换和滥用风控。

共享项目中的“已认证”不等于拥有 AniCode 产品权限。独立的私有 entitlement 表默认拒绝所有已有及新增
账号；只有服务端 `service_role`/数据库管理员可以通过 grant/revoke RPC 改变授权，普通
`authenticated` 用户既不能调用这些 RPC，也不能直接写表。模型目录和聊天接口在读取设备身份或接触采购
Key 之前都必须通过该授权检查，授权存储或 RPC 故障时 fail closed。

Edge 平台层暂时保持 `verify_jwt=false`，由函数内 `auth.getClaims(accessToken)` 对当前项目的 ES256
签名和过期时间做权威验证，再严格校验项目 `iss`、`authenticated` audience/role 与 UUID `sub`。Auth
client 在 warm isolate 内复用，以保留 SDK 的 JWKS 内存缓存并避免 `auth.getUser` 成为每请求网络热路径。
只有在同项目 canary 证明 Supabase 平台预检兼容这些 ES256 token 后，才考虑把 `verify_jwt` 作为额外纵深
防御打开；函数内验证不能随之删除。

登出会撤销 refresh token/session，但已签发 access JWT 按 Supabase 语义仍有效到 `exp`，这不因
`getClaims` 改变。AniCode 的即时产品撤权由每请求 entitlement 检查和预占事务内复查保证；签名密钥紧急
撤销还需考虑 JWKS 的边缘与 SDK 缓存窗口，事故时应先关闭 `gateway_enabled`。

当前客户端只有 email/password `signIn`，没有公开 `signUp`、magic link 或 device-code onboarding。
因此正式对外发布前还必须提供一个经过邮件验证和注册限速的建号入口；在此之前，该免费能力只适合已
开通 AniCode 账号的用户，不能宣传成“无账号即用”。

本次客户端接入覆盖 CLI/TUI 与 Electron；VS Code 扩展目前没有复用 CloudAuth 生命周期，不能宣称已经
获得相同的零 Key 默认体验。它应在后续接入同一个宿主侧 Keychain、固定网关和模型选择逻辑，不能在扩展
进程另造一套设备 ID 或配额实现。

## 请求路径

```text
CLI / Electron trusted host
  ├─ Supabase access token（短期，内存 Broker）
  └─ installation token（256-bit，OS Keychain）
             │ fixed HTTPS origin
             ▼
Supabase Edge Function
  1. auth.getClaims 验签并校验 iss/aud/role/sub
  2. Edge 先校验服务端 AniCode Cloud entitlement（默认拒绝）
  3. HMAC(installation token) 得到 device_subject
  4. 独立事务回收超时 reservation（若有）
  5. PostgreSQL 锁定 entitlement，并原子预占 device + user + global 配额
  6. 注入服务端 DEEPSEEK_API_KEY 与无 PII 的 user_id
             │
             ▼
DeepSeek POST /chat/completions (SSE + include_usage)
             │
             ▼
最终 usage.total_tokens 原子结算；缺失 usage/中断则保守扣预占值
```

OpenCode 值得复用的是“网关持有供应商 Key、无 Key 时只展示零成本模型”的边界，而不是把真实 Key
写入客户端。AniCode 还额外区分确定性的每日额度耗尽和瞬时限流，避免客户端对每日额度 429 反复退避。

DeepSeek V4 默认进入 thinking mode，但当前 OpenAI-compatible 会话层尚未在工具轮之间持久化
`reasoning_content`。免费网关与官方直连默认都显式使用 non-thinking，避免第二轮工具调用 400；未来若完整
支持 reasoning block，再以独立能力标记和成本策略开放。

## 配额策略

PostgreSQL 是配额的唯一权威。Redis 若以后引入，只用于 IP/nonce/分钟级预过滤和 policy cache；Redis
不可用时回落 PostgreSQL，不能形成第二套可独立放行的计数器。

首发默认值如下，均由 `private.anicode_llm_policy` 单例行调整，无需重新部署 Edge Function：

| 维度                 |     默认值 | 作用                                |
| -------------------- | ---------: | ----------------------------------- |
| 每安装实例每日 token |    200,000 | 免费层产品额度，北京时间 00:00 重置 |
| 每安装实例每日请求   |        100 | 抑制大量极短请求                    |
| 每安装实例每分钟启动 |          8 | 突发保护                            |
| 每安装实例并发       |          2 | 防止单机占满共享连接                |
| 每账号每日 token     |  1,000,000 | 防止轮换安装凭证绕过设备额度        |
| 全局每日 token       | 10,000,000 | 采购余额/成本熔断                   |

同一 policy 行还提供 `gateway_enabled` 运维熔断；关闭后新预占立即 fail closed，已在流式传输中的请求仍完成
结算。它不依赖 DeepSeek 余额接口，也不需要等待 Edge 重新部署。

Edge 的前置 entitlement 检查只用于尽早返回清晰的 403；真正授权边界是数据库中的
`reserve_anicode_llm_entitled_request_v2`。它对 entitlement 行持有 share lock 直到配额预占事务结束，撤权
提交后不会再有使用旧检查结果的新预占。运行时 `service_role` 无权调用旧 v1/v2 reserve RPC，数据库
owner 仅作为 break-glass 管理边界保留直接执行能力。

预占值采用 `UTF-8 request bytes + max_output_tokens`，保证高熵代码/CJK 输入也不会在并发窗口下少预占。
请求完成后使用 DeepSeek 最终 `usage.total_tokens` 结算并释放差额。provider 报告的实际值可以超过预占值；
此时必须记录 `reservation_overrun`、扣实际值并告警，不能用 `min(actual, reserved)` 静默掩盖成本。

配额事务采用固定锁序和请求账本，保证并发下不会先放行再异步超扣。保留中的请求跨零点仍暂时占用新一
天额度；超过 5 分钟的孤儿 reservation 由独立 RPC 先提交回收，再执行新预占，避免“新请求被拒绝”把清理
本身也回滚并永久锁死设备。stale 估算值归属原请求 quota day；迟到的 provider 最终 usage 可对估算值做
一次幂等差额校正，随后重复 settle 不再改变账本。

## 错误与重试契约

Edge Function 返回 OpenAI-compatible JSON error，并用 `x-anicode-retryable` 明确重试语义：

| code                                                  | HTTP | 可重试                              |
| ----------------------------------------------------- | ---: | ----------------------------------- |
| `gateway_disabled`                                    |  503 | 否，运维熔断                        |
| `device_daily_token_limit`                            |  429 | 否，等待 `Retry-After` 指向次日重置 |
| `device_daily_request_limit`                          |  429 | 否                                  |
| `device_minute_rate_limit`                            |  429 | 是，有限退避                        |
| `device_concurrency_limit`                            |  429 | 是，有限退避                        |
| `user_daily_*_limit` / `global_daily_*_limit`         |  429 | 否                                  |
| `user_minute_rate_limit` / `global_minute_rate_limit` |  429 | 是                                  |
| `user_concurrency_limit` / `global_concurrency_limit` |  429 | 是                                  |
| `upstream_rate_limited`                               |  429 | 是，有限退避                        |
| `upstream_balance_exhausted`                          |  503 | 否，通知运营充值/切换 Key           |
| `quota_unavailable`                                   |  503 | 是；数据库故障时 fail closed        |
| `cloud_entitlement_required`                          |  403 | 否；账号未获 AniCode Cloud 授权     |
| `entitlement_unavailable`                             |  503 | 是；授权存储故障时 fail closed      |

客户端优先尊重 `x-anicode-retryable:false`，并保留对稳定 hard-quota code 的兼容判断。每日额度耗尽绝不
自动重放；DeepSeek 上游 429/5xx 才进入有上限的指数退避。

## 成本与可观测性

token 数量不是精确成本：DeepSeek 区分缓存命中/未命中、输入/输出和峰谷时段。因此免费层只开放
Flash，同时在请求账本记录 prompt、completion、cache hit、cache miss、reasoning 和 model。运营侧应按
官方当前价格计算 micro-USD，并配置独立的采购余额告警；Pro 不能与 Flash 共用同一个免费 token 限额。
按 2026-08-17 官方 Flash 峰时最高的输出价 `$1.32 / 1M token` 做保守上界，200k token 约为
`$0.264 / 安装实例 / 日`，10M 全局 token 约为 `$13.20 / 日`；这只是预算上界，价格变化后必须重新计算。

最低告警项：

- 全局日 token 使用率 70% / 85% / 95%；
- reservation overrun 非零；
- 缺失最终 usage 的完成请求；
- 设备凭证轮换异常、单账号设备 fan-out；
- DeepSeek 429、5xx、首 token 延迟和结算失败；
- PostgreSQL stale reservation 回收数量。

日志只写 request ID、HMAC subject、model、计量和稳定错误码，不写 prompt、access token、安装凭证或
DeepSeek Key。

## 上线步骤

1. 在一次性/隔离环境依次执行全部 additive migration，并用 PostgreSQL 16 跑 SQL 契约测试。每份
   migration 必须作为一个事务整体执行，严格按“先 DB、后 Edge”滚动，不能逐句执行造成函数权限窗口。
2. 生成至少 32-byte 的 `ANICODE_DEVICE_PSEUDONYM_KEY`，和已采购的 `DEEPSEEK_API_KEY` 一起写入
   Supabase Secrets；不得放进 `.env` 提交、桌面包或 CLI 包。
3. 通过服务端 grant RPC 只给内测/发布 cohort 写入 AniCode Cloud entitlement，再部署
   `anicode-chat`；默认不要设置包含 Pro 的 `ANICODE_DEEPSEEK_MODELS`。回滚到未检查 entitlement 的旧
   Edge 版本会因旧 reserve RPC 已撤权而 fail closed；回滚期间仍应先关闭 `gateway_enabled`，不得恢复旧
   RPC 权限来强行运行。
4. 先给内部账号/1% 用户开放，核对 DeepSeek 控制台账单与本地 `usage` 聚合，再逐步扩大。
5. 用 `gateway_enabled=false` 演练 kill switch；不要依赖 DeepSeek 余额查询来做每设备配额。若要动态调整
   现有全局上限，应先把旧 migration 中的硬编码值迁入 policy 表。

示例（不要把真实 secret 写入 shell history）：

```bash
supabase db query --linked --file supabase/migrations/202608110001_anicode_llm_gateway.sql
supabase db query --linked --file supabase/migrations/202608170001_anicode_device_quota.sql
supabase db query --linked --file supabase/migrations/202608190001_anicode_policy_linearization.sql
supabase db query --linked --file supabase/migrations/202608190002_anicode_cloud_entitlements.sql
supabase db query --linked --file supabase/checks/anicode_llm_gateway_preflight.sql
supabase secrets set --env-file <private-gateway-secrets.env>
node --env-file=<private-supabase-admin.env> scripts/preflight-anicode-gateway-rest.mjs
supabase functions deploy anicode-chat --no-verify-jwt
```

调整免费安装实例额度：

```sql
update private.anicode_llm_policy
set gateway_enabled = true,
    policy_version = policy_version + 1,
    device_day_token_limit = 200000,
    device_day_request_limit = 100,
    device_minute_request_limit = 8,
    device_active_request_limit = 2,
    updated_at = statement_timestamp()
where singleton = true;
```

紧急停止新的免费调用：

```sql
update private.anicode_llm_policy
set gateway_enabled = false,
    policy_version = policy_version + 1,
    updated_at = statement_timestamp()
where singleton = true;
```

## 验收清单

- 新账号默认不能访问模型目录或聊天；只有服务端显式 grant 后可用，普通用户不能自助 grant/写表；
- 同一 installation token 的并发预占最多只放行 policy 允许的数量；
- 同账号不同 installation、同 installation 不同账号以及跨账号全局上限均单独覆盖；
- 北京时间零点、跨零点未结算请求、重复 settle、客户端中断和 stale reaper 均有测试；
- `actual > reserved` 会完整扣账并留下 overrun；
- hard quota 只调用 provider 一次，瞬时 429 才重试；
- 客户端包、IPC DTO、日志和数据库均不存在 DeepSeek Key 或原始 installation token；
- 明确配置的模型优先于 Cloud 默认；已登录且没有显式选择时才默认免费 Flash。

## 官方依据

- [DeepSeek Chat Completions 与 usage](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek 当前模型与价格](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek 402 / 429 / 5xx 错误语义](https://api-docs.deepseek.com/quick_start/error_codes/)
- [DeepSeek 账户并发与 user_id 隔离](https://api-docs.deepseek.com/quick_start/rate_limit/)
- [DeepSeek Open Platform Key 安全条款](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)
- [OpenCode 无 Key 时只保留零成本模型的实现](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/provider/provider.ts#L166-L185)
- [Supabase anonymous user 的 authenticated role 语义](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase getClaims 的 JWKS 验证与缓存语义](https://supabase.com/docs/reference/javascript/auth-getclaims)
- [Supabase 登出后 access JWT 仍有效到 exp](https://supabase.com/docs/guides/auth/signout)
- [Supabase signing key 与 JWKS 缓存窗口](https://supabase.com/docs/guides/auth/signing-keys)
