# Production Agent Runtime closure — 2026-07-30

本归档承接 2026-07-29 的架构调研与三轮 Runtime hardening，记录“建议实施顺序”在仓库内的最终落点、生产不变量、部署配置和仍需在真实基础设施完成的验收。这里的“完成”表示代码、协议、清单和自动化门禁已具备；不代表本地工作站替组织创建了 PostgreSQL、Vault、GitHub App、ARC 或 Kubernetes 集群。

## 1. 最终分层

| 层         | 已落地能力                                                                                                       | 关键不变量                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 接入层     | ACP v1 官方 SDK wire conformance、OpenAPI 3.1.1、生成式 TypeScript SDK、流式 Artifact                            | 协议版本显式协商；请求/错误有单一契约；SDK 不手写 HTTP method/path                    |
| Runtime    | Durable event/snapshot、command inbox/outbox、DAG scheduler、Verifier、Context Compiler                          | command 幂等；snapshot 可恢复；required verifier 未通过不得报告完成                   |
| 并发控制   | PostgreSQL 规范化表、`SKIP LOCKED`、lease/heartbeat、fencing token、worktree ownership                           | 过期 worker 即使恢复执行也不能提交副作用                                              |
| 编辑       | PatchSet v2 text/binary/delete/rename、base hash、审批链、预览、三方合并、事务 apply/rollback                    | 写入先 journal；冲突不静默覆盖；shell 变更也收口成 PatchSet                           |
| 执行隔离   | 本地 sandbox、container runtime、Kubernetes ephemeral Job、默认拒绝 NetworkPolicy                                | runner 无长期身份、无 SA token、只读 rootfs；远端写入从临时副本经 PatchSet 提交       |
| 凭据       | OS Keychain、Vault KV/OIDC、AWS KMS、Credential Broker、轮换/审计                                                | 长期密钥不进入 prompt/event/artifact/trace/子进程环境；读取受 audience/host/tool 限域 |
| 代码上下文 | Tree-sitter 多语言 AST、LSP definition、typed reference edges、SQLite/pgvector 混合检索                          | 增量缓存由 ns mtime + ctime + inode 防陈旧；目标变更会失效依赖 LSP 边                 |
| 交付       | GitHub App installation token、webhook、Check Run、repair/merge-group worker、ARC workflow、原子 Git Data commit | GitHub 私钥/secret 只经 Broker；单次 repair 使用短生命周期 runner 与幂等分支          |
| 供应链     | 多架构 OCI、SBOM、BuildKit provenance、GitHub OIDC artifact attestation、digest pin gate                         | 部署只接受 digest-pinned image；证明绑定 commit、镜像 digest 与 workflow identity     |
| 质量       | 真实 repo catalog、分片/合并、Wilson CI、按语言矩阵、nightly 200–300 task gate                                   | 不用单一均值掩盖回归；安全门禁不能由总体通过率抵消                                    |
| 可观测性   | W3C trace context、ACP/MCP/worker/remote/GitHub spans、OTLP batch/retry/backpressure/shutdown                    | trace ID 按 OTLP bytes 编码；失败批次保留；敏感属性和 Broker 已知值脱敏               |

## 2. 本轮新增的生产闭环

### 2.1 PostgreSQL 与 crash recovery

- command、outbox、worker job、worktree lease 均使用规范化行表，不再把文档 JSON 当共享事务边界。
- worker claim 使用行锁、lease、heartbeat 和单调 fencing token；ack/fail/renew 必须携带当前 fence。
- durable runtime 从 event + snapshot 恢复；启动扫描未闭合 command，由幂等键继续或确定性终止。
- Kubernetes `workspace-write` 在 Pod 的 `emptyDir` 副本执行，成功后才以 PatchSet 锁、base hash 和 fencing journal 提交回 PVC；失败/超时不污染工作区，禁用临时副本时写请求 fail-close。
- CI 使用 PostgreSQL 16 service 跑竞争/租约 integration test；本地未配置测试 URL 时测试明确 skip，而不是伪装通过。

### 2.2 网络与密钥

- `NetworkProxyServer` 对 HTTP/CONNECT 都做 client credential、DNS pin、私网/端口/域名策略、请求/响应/隧道字节和时长限制。
- Kubernetes runner egress 只允许到 proxy Pod，禁止 DNS、metadata、公网和其他 Pod；外部二进制忽略 `HTTP_PROXY` 也没有直接出口。
- Credential Broker 支持同步 Keychain 与异步 Vault/KMS reference；GitHub App key、webhook secret、数据库 URL、proxy token、provider key 和 OTLP token均按独立 audience 读取并审计。
- Artifact S3 只允许 workload identity/default provider chain；发现静态 `AWS_ACCESS_KEY_ID` 等环境密钥即拒绝启动。

### 2.3 Artifact 与 OpenTelemetry

- 本地默认 Artifact 使用 SQLite；`ANICODE_ARTIFACT_BACKEND=s3` 切换到 content-addressed S3。
- 大对象先流入权限 `0600` 的临时文件并同步计算 SHA-256；S3 blob 按 digest 去重，metadata 按 session 隔离，KMS server-side encryption 为生产必填。
- HTTP 新增 Artifact 原始内容流，带 `content-length`、`content-digest`、ETag 与 `nosniff`；SDK 可直接消费 stream，也可下载后验证 SHA-256。
- OTLP exporter 有有界队列、周期 batch、超时、指数退避、失败批次重入队、健康统计、优雅 shutdown 和敏感字段脱敏。Collector credential 每次发送时从 Broker 动态读取，支持后端轮换；出口代理也在每条新请求/隧道认证时重读 Broker reference，无需重启即可换 client token。

### 2.4 OpenAPI、SDK 与 ACP

- `ROUTES` 仍为 HTTP 单一事实源，但现在同时驱动 OpenAPI、服务端轻量 JSON Schema validation 与 SDK codegen。
- OpenAPI 为每个 operation 生成 request/response schema、统一 `ApiError`、API version、request ID、默认错误响应、分页和 Idempotency-Key。
- SDK 生成 operation contract，不再重复写 method/path；请求本地预检，只对 GET/DELETE 或带 Idempotency-Key 的 mutation 重试，并保留结构化 `code/requestId/details`。
- ACP adapter 使用 `@agentclientprotocol/sdk` v1 常量与真实 NDJSON client conformance test，覆盖 initialize、capability negotiation、mode、prompt、permission、cancel、load/resume 和 pagination；不支持的动态 MCP/directory 能力 fail-close。

### 2.5 类型代码图

- AST 覆盖 JavaScript/TypeScript/TSX/Python/Go/Rust/Java；LSP 补充 symbol kind 与精确 definition。
- reference edge 区分 `call/import/type/inheritance/reference`，检索同时利用出边与反向 caller。
- cache v4 记录 nanosecond mtime、ctime、inode 与内容 hash；同尺寸且人为恢复 mtime 的写入仍会重新解析。
- changed/removed target 会清理复用 caller 的旧 LSP edge，再用 heuristic + LSP 重建；embedding 按批调用并校验数量、维度和有限值。

### 2.6 GitHub 与 OCI

- GitHub App 使用 Broker-held RS256 key 签 JWT，再换 repository/permission-scoped installation token；不接受长期 `GITHUB_TOKEN`。
- delivery 使用 Git database blob/tree/commit/ref 原子发布，不再逐文件 Contents API 造成半提交；branch 是重试幂等边界。
- webhook 校验 HMAC、repository、installation 和 head SHA，三类 job（analysis/repair/merge-group）都由 durable worker 消费并回写 Check Run。
- `github-agent.yml` 运行在 ARC ephemeral runner scale set，Vault 走 GitHub OIDC；repair 分支使用 force-with-lease，PR 去重。
- `agent-runtime.yml` 构建 control-plane/runner 两个 multi-arch target，生成 SBOM/provenance 并对 registry digest 做 GitHub OIDC attestation。

## 3. 关键配置

### Artifact S3

```bash
ANICODE_ARTIFACT_BACKEND=s3
ANICODE_ARTIFACT_S3_BUCKET=org-anicode-artifacts
ANICODE_ARTIFACT_KMS_KEY_ID=alias/anicode-artifacts
ANICODE_ARTIFACT_S3_PREFIX=anicode/artifacts/v1
AWS_REGION=ap-southeast-1
```

使用 IRSA、EKS Pod Identity、EC2 role 或同等 workload identity。不要设置静态 AWS access key 环境变量。

### OTLP

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel-collector.example
OTEL_SERVICE_NAME=anicode
OTEL_RESOURCE_ATTRIBUTES=deployment.environment.name=production,service.namespace=agent-platform
ANICODE_OTEL_CREDENTIAL_ID=otel-collector
```

敏感 header 不允许放入 `OTEL_EXPORTER_OTLP_HEADERS`。对应 credential scope 必须允许 `audience=telemetry:otlp` 和 Collector hostname。

### Remote Runtime

```bash
ANICODE_CREDENTIAL_BACKEND=vault
ANICODE_REMOTE_EXECUTION=kubernetes
ANICODE_RUNTIME_IMAGE='ghcr.io/OWNER/anicode-runner@sha256:<digest>'
ANICODE_RUNTIME_NAMESPACE=anicode-runtime
ANICODE_WORKSPACE_PVC=anicode-workspaces
ANICODE_OIDC_ISSUER=https://issuer.example
ANICODE_OIDC_AUDIENCE=anicode-runtime
npm run remote --workspace @anicode/core
```

### GitHub control plane

```bash
ANICODE_CREDENTIAL_BACKEND=vault
ANICODE_GITHUB_OWNER=OWNER
ANICODE_GITHUB_REPO=REPO
ANICODE_GITHUB_APP_ID=<app-id>
ANICODE_GITHUB_INSTALLATION_ID=<installation-id>
npm run github-control --workspace @anicode/core
```

Vault/KMS 中至少提供 `runtime:DATABASE_URL`、`github:APP_PRIVATE_KEY` 和 `github:WEBHOOK_SECRET`，或用对应 `*_CREDENTIAL_KEY` 改名。

## 4. 自动化门禁

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm run codegen:check`
- `npm test`
- `npm audit --omit=dev --audit-level=high`
- PostgreSQL integration test（CI service）
- Workflow/Kubernetes YAML parse、shell syntax、digest pin/isolation acceptance script
- CLI、Electron、VS Code bundle build

完整 `npm audit` 截至归档日仍报告 19 个 high，均来自 ESLint/Electron Builder 的开发/打包依赖及其 `minimatch -> brace-expansion` 链；生产依赖审计为 0。npm 当前提供的自动修复会不兼容地降级 Electron Builder或跨主版本替换工具链，因此没有执行 `--force`。CI 已强制 production audit，Dependabot 会持续提交上游兼容修复。

## 5. 真实环境验收，不得用本地单测替代

1. 在目标 CNI 上运行 `deploy/remote-runtime/verify-isolation.sh`，覆盖 direct IPv4/IPv6、DNS tunnel、metadata、私网 SSRF、未认证 CONNECT 和无关 Pod 访问。
2. 对 PostgreSQL 做 kill -9、网络分区、主备切换、备份恢复和 migration 演练，证明 stale fence 无法 ack/commit。
3. 用真实 Vault/KMS/OIDC 做轮换和撤销演练，检查 prompt/event/snapshot/PatchSet/Artifact/log/trace/子进程均无明文。
4. 在组织 GitHub App、branch protection、merge queue 与 ARC 集群上跑 analysis/repair/merge-group 全闭环，并验证 runner/job 完成后身份和工作区销毁。
5. 替换所有 image digest placeholder，验证 SBOM、provenance、attestation 与 admission policy。
6. 跑满 200–300 个真实 repo task，建立语言、仓库规模、风险类型、P95 延迟、token/cost、人工接管率和回滚率基线。

## 6. 后续不是“补一个类”，而是平台运营

仓库内建议路线的底层能力已闭合。之后的工作主要依赖组织基础设施：企业 SSO/RBAC 映射、审计留存和地域策略、预算/配额、插件签名与兼容矩阵、A2A gateway、跨区域调度，以及真实 SLO/告警/canary。这些不能在没有身份提供商、集群、仓库策略和成本目标时由本地代码诚实宣称完成。
