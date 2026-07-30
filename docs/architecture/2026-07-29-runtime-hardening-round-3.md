# Agent Runtime 第三轮生产化归档

> 2026-07-30 的最终收口、配置与真实环境验收边界见[Production Agent Runtime closure](./2026-07-30-production-runtime-closure.md)。本页保留为第三轮完成时的快照。

归档日期：2026-07-29
上一轮：[Agent Runtime 第二轮补齐归档](./2026-07-29-runtime-hardening-round-2.md)

## 一、结论

本轮把第二轮留下的九项生产化缺口落成代码、测试、CI 与部署清单。默认单机控制面与会话历史使用 SQLite WAL；旧 JSONL 会话首次访问时幂等迁移，之后只以数据库为准。共享控制面使用 PostgreSQL `SERIALIZABLE` 事务；远程执行使用一次一 Job 的 Kubernetes runner。安全边界从“工具自觉使用代理”提升为“runner namespace 默认无出口，只能到策略代理”，密钥长期保存则可选择 OS Keychain、Vault + OIDC 或 AWS KMS + workload identity。

```text
ACP / MCP / OpenAPI / Generated SDK / Artifacts
                         │ traceparent
Command Inbox → Durable Runtime → Snapshot / Transactional Outbox
                         │
Context Compiler → Tree-sitter + LSP → Symbol/Reference Graph
                         │                         │
Scheduler → Persistent Worker                 SQLite / pgvector
     │ lease + heartbeat + fencing                 │
PatchSet → Approval → 3-way merge → Verifier → Artifact
     │
Security Policy → Credential Broker → Network Proxy
     │                    │
OS sandbox / OCI namespace / ephemeral Kubernetes Job
                         │
GitHub Webhook → Check Run → Repair Worker → Merge Queue → Provenance
```

## 二、九项交付对照

| 项目                          | 已完成                                                                                                                                                                                                                                                                 | 强制不变量                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite / PostgreSQL           | SQLite WAL + `BEGIN IMMEDIATE`；PostgreSQL `SERIALIZABLE` 自动重试与 advisory/row locks；session/message、event、snapshot、command、outbox、worker、artifact、audit 统一后端；JSONL 会话带迁移门                                                                       | 幂等键唯一；会话追加与元数据更新时间同事务；claim/heartbeat/finish 都校验 owner + fencing token；旧 worker 不能提交结果                                         |
| Keychain / Vault / KMS / OIDC | OS Keychain 同步引用；Vault KV v2 经 GitHub Actions OIDC 或 projected token JWT 登录；KMS ciphertext-at-rest；后端发现 `env:*`；轮换管理器撤销旧 lease；SQLite 审计                                                                                                    | 长期密钥不写 JSON/JSONL；provider/MCP/OTLP/shell 只在受信边界读取或短租约注入；桌面插件只传 Broker credential reference；静态敏感 MCP/OTLP header 与 env 被拒绝 |
| 强制出口                      | 内建 fetch、provider SDK、HTTP/stdio MCP、真实 Eval 模型请求、Remote Runtime、GitHub 都经 `NetworkProxy`；DNS 授权结果固定到 socket；Chrome 强制 proxy、禁直接 DNS；macOS Seatbelt 仅放行代理；OCI `--internal`/`--network none`；Kubernetes runner 无 DNS/公网 egress | 无代理时联网调用 fail-close；任意 runner 二进制即便忽略 `HTTP_PROXY` 也无法直连公网                                                                             |
| PatchSet                      | `write`、`edit`、`apply_patch` 全部转 PatchSet；text/binary、rename、预览、base hash、角色审批、原子 journal、崩溃恢复、rollback、三方 merge；SessionManager、OpenAPI 与生成 SDK 暴露 prepare/get/approve/apply/rebase/rollback                                        | 冲突在写前发现；批次不能半提交；外部改动后不盲回滚；`.git`/`.anicode` 保持保护                                                                                  |
| 类型化代码图                  | ast-grep/Tree-sitter 覆盖 JS/TS/TSX/Python/Go/Rust/Java；可选 LSP enrich；增量文件复用；定义/引用解析；lexical + graph + vector 混合检索                                                                                                                               | 未变文件不重解析；文件删除同步清理向量；本地 SQLite exact 与共享 pgvector HNSW 使用同一接口                                                                     |
| Remote Runtime                | OIDC 认证控制面、幂等 API、PostgreSQL/SQLite durable queue、fencing/heartbeat/cancel；OCI 后端；Kubernetes 每命令临时 Job、只读源工作区复制到 `emptyDir`、资源限额与自动销毁                                                                                           | 客户端不发送宿主绝对 cwd；镜像必须 digest pin；runner 无 SA token、non-root、seccomp、drop capabilities、只读根                                                 |
| 真实 Eval                     | 固定生成 280 个 SWE-bench Verified/Multilingual 仓库切片；Python 40，Go/Rust/Java 各 39，并覆盖 Ruby/PHP/C/C++/JS/TS；真实 agent 修改后交官方 Docker harness；nightly workflow                                                                                         | catalog 不携带 reference patch/test patch；commit 固定；任务唯一；按语言与 repo 分层；结果进入质量门                                                            |
| GitHub 闭环                   | HMAC webhook、delivery 幂等、真实 `pull_requests[]` 载荷归一化、durable repair queue、Check Run、可注入 repair/verifier、GraphQL merge queue、merge-group CI、GitHub OIDC provenance attestation                                                                       | webhook 未验签不入队；重投不重复副作用；只有 repair + verifier 成功才可入 merge queue；控制面不伪造未签名 attestation                                           |
| OpenTelemetry                 | W3C `traceparent` 与父子 span 贯穿 ACP、MCP、persistent worker、Remote client/server、GitHub webhook/delivery；OTLP/HTTP exporter 复用策略出口，并按 flush 从 Broker 读取 collector credential                                                                         | trace 属性与 OTLP payload 不放密钥；跨队列 payload 只携 trace context；静态敏感 exporter header fail-close；错误与 fencing/queue/HTTP 状态可关联                |

## 三、关键实现位置

- 数据库、会话迁移与 fencing：`packages/core/src/runtime/sqlite.ts`、`postgres.ts`、`packages/core/src/session.ts`、`commands.ts`、`worker.ts`
- 密钥：`packages/core/src/security/secret-backends.ts`、`credentials.ts`、`rotation.ts`
- 网络隔离：`packages/core/src/runtime/network-proxy.ts`、`container-runtime.ts`、`kubernetes-runtime.ts`、`packages/core/src/tools/sandbox.ts`
- PatchSet：`packages/core/src/runtime/patchset.ts` 与 `tools/fs.ts`、`tools/apply-patch.ts`
- 代码图：`packages/core/src/runtime/typed-code-graph.ts`、`vector-store.ts`
- Remote Runtime：`remote-server.ts`、`remote-auth.ts`、`remote-launch.ts`、`deploy/remote-runtime/`
- Eval：`packages/eval/scripts/sync-real-repo-catalog.ts`、`src/real-repo.ts`、`src/tasks/real-repo.generated.ts`
- GitHub：`github-webhook.ts`、`github-delivery.ts`、`.github/workflows/agent-runtime.yml`
- Trace：`packages/core/src/runtime/telemetry.ts`、`local-stack.ts`、`acp.ts`、`mcp.ts`

## 四、运行方式

### 本地开发

```bash
npm install
npm run dev:tui:demo
```

真实 provider 默认把环境里的 API key 迁入 OS Keychain，再从原进程环境删除：

```bash
ANICODE_CREDENTIAL_BACKEND=keychain npm run dev:tui
```

TUI、daemon、Electron 与 VSCode 的新会话以同一目录下的 `runtime.db` 为主存储；检测到旧 `sessions/*.jsonl` 时会在首次访问时事务导入。旧文件保留作恢复备份，但数据库已有更新时不会被旧数据覆盖，删除会话也会同时删除迁移源，避免下次启动“复活”。

需要 browser 或联网外部命令时，先启动受控出口；macOS Seatbelt 只允许进程连接这个 loopback 地址：

```bash
# terminal 1
HOST=127.0.0.1 PORT=8787 \
ANICODE_NETWORK_ALLOW_DOMAINS=api.github.com,github.com,registry.npmjs.org \
npm run network-proxy --workspace @anicode/core

# terminal 2
ANICODE_NETWORK_PROXY_URL=http://127.0.0.1:8787 npm run dev:tui
```

Linux 的联网任意二进制必须选择容器后端；普通本地 sandbox 会拒绝降级成可绕过代理的网络：

```bash
ANICODE_EXECUTION_BACKEND=container \
ANICODE_RUNTIME_IMAGE='ghcr.io/OWNER/anicode-runner@sha256:<digest>' \
ANICODE_CONTAINER_NETWORK=anicode-egress-internal \
ANICODE_CONTAINER_PROXY_URL=http://anicode-egress-proxy:8080 \
npm run dev:tui
```

Vault/KMS 后端中的 key 使用 `env:OPENAI_API_KEY` 这类名称；无法 list 时显式给出要水合的名字：

```bash
ANICODE_CREDENTIAL_BACKEND=vault \
ANICODE_CREDENTIAL_KEYS=OPENAI_API_KEY,GITHUB_TOKEN \
VAULT_ADDR=https://vault.example \
ANICODE_VAULT_ROLE=anicode \
ANICODE_OIDC_TOKEN_FILE=/var/run/secrets/tokens/anicode \
npm run dev:tui
```

HTTP MCP 不再接受写死的 Authorization。配置示例：

```json
{
  "mcp": {
    "github": {
      "url": "https://mcp.example/mcp",
      "credential": {
        "id": "env:GITHUB_TOKEN",
        "scheme": "Bearer"
      }
    }
  }
}
```

OTLP collector 需要鉴权时同样只配置 Broker 引用，不把 token 写进 `OTEL_EXPORTER_OTLP_HEADERS`：

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=https://otel.example:4318 \
ANICODE_OTEL_CREDENTIAL_ID=env:OTEL_API_TOKEN \
ANICODE_OTEL_CREDENTIAL_HEADER=authorization \
ANICODE_OTEL_CREDENTIAL_SCHEME=Bearer \
ANICODE_NETWORK_ALLOW_DOMAINS=otel.example,api.openai.com \
npm run dev:tui
```

### Remote Runtime

```bash
docker build -f deploy/remote-runtime/Dockerfile -t <registry>/anicode-control-plane:<tag> .
# 签名并取得 digest，替换 kubernetes.yaml 中两个占位值，再创建配置 Secret：
kubectl apply -f deploy/remote-runtime/kubernetes.yaml
```

直接运行控制面：

```bash
ANICODE_CREDENTIAL_BACKEND=vault \
VAULT_ADDR=https://vault.example \
ANICODE_VAULT_ROLE=anicode-runtime \
ANICODE_OIDC_TOKEN_FILE=/var/run/secrets/anicode-oidc/token \
ANICODE_DATABASE_CREDENTIAL_KEY=runtime:DATABASE_URL \
ANICODE_OIDC_ISSUER=https://issuer.example \
ANICODE_OIDC_AUDIENCE=anicode-runtime \
ANICODE_OIDC_JWKS_URI=https://issuer.example/.well-known/jwks.json \
ANICODE_RUNTIME_IMAGE='ghcr.io/OWNER/anicode-runner@sha256:<digest>' \
ANICODE_WORKSPACE_PVC=anicode-workspaces \
npm run remote --workspace @anicode/core
```

### 真实评测与验证

```bash
npm run codegen:check
npm run typecheck
npm test
ANICODE_NETWORK_ALLOW_DOMAINS=api.openai.com \
npm run eval -- --suite real --model <provider/model> --limit 40 --json real-eval.json
```

真实评测要求 Docker、`swebench` Python harness、模型凭证与联网仓库克隆；真实 suite 必须显式配置模型端点域名白名单，provider 使用与本地宿主相同的 Broker、审计库、DNS-pinned NetworkProxy 和 telemetry。CI 的 full matrix 可将 `--limit` 调到 280；nightly 还需配置 `ANICODE_CREDENTIAL_KEYS` 与 `ANICODE_EVAL_NETWORK_ALLOW_DOMAINS` repository variables。仓库 clone 与官方 harness 容器本身运行在短生命周期 self-hosted runner，其 OS/CNI 出口策略仍由 runner 集群负责。

### 发布与 provenance

`release.yml` 已移除长期 `NPM_TOKEN`，使用 npm trusted publishing 的 GitHub OIDC，并开启 npm provenance；`agent-runtime.yml` 对运行时证据包生成 GitHub artifact attestation。仓库外仍需在 npm package settings 中把该 workflow 配成 trusted publisher，且实际发布 job 必须保留 `id-token: write`。

## 五、本地验收记录

- `npm test`：591/591 通过（core 470、eval 9、SDK 5、shared 6、TUI 74、Electron 19、VSCode 8）。
- `format:check`、ESLint、全 workspace TypeScript、OpenAPI SDK codegen check 通过。
- CLI、Electron、VSCode bundle 均构建通过；Electron `--dir` 打包确认 Keychain/Tree-sitter N-API 文件进入 `app.asar.unpacked`，VSIX 确认携带当前平台的两个原生模块。
- `npm audit --omit=dev`：生产依赖 0 个已知漏洞。
- 完整 audit 尚有 19 个 high，均位于 ESLint/Electron Builder 的开发与打包依赖链；npm 当前只给出不兼容的主版本升级或降级方案，因此未用 `--force` 篡改已验证的工具链，也不影响随产品交付的运行时依赖。
- Workflow 与 Kubernetes YAML 已完成本地语法解析。
- 当前工作站没有可连接的 Docker daemon，且 `kubectl` 未配置 current-context，因此本次不能诚实声称镜像已构建、清单已部署或做过 CNI 逃逸验收；280 个真实模型任务也未在本地付费运行。

## 六、部署边界与下一步

本轮仓库内已经提供服务端、worker、协议、Kubernetes/Actions 清单和测试，但未替用户创建真实 PostgreSQL、Vault、KMS、GitHub App、Kubernetes 集群，也没有替换镜像 digest。部署前必须做以下环境验收：

1. 用真实 CNI 运行 direct socket、DNS tunnel、私网 SSRF 与 proxy redirect 逃逸测试。
2. 为 PostgreSQL 做备份恢复、连接池压力、故障切换和 migration 演练；高吞吐时把当前严格串行的 document queue 进一步规范化成逐行表。
3. 在组织 GitHub App 中接入实际 repair callback/runner，并验证 branch protection、merge queue 和 Check Run 权限；当前 core 已提供 durable worker 闭环，具体修复策略仍由宿主注入。
4. 首次跑完 280 个真实任务后生成基线；当前提交的是固定 catalog、runner 与 nightly 门，不虚构昂贵模型运行结果。
5. 将 Collector、告警、trace sampling、审计留存、密钥轮换周期与 SLO 接到实际平台运维系统。
6. 在 npm 后台启用 trusted publisher，并在目标仓库/组织开启 artifact attestations、OIDC、GitHub App 与 merge queue 所需权限。
