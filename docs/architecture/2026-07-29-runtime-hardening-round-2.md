# Agent Runtime 第二轮补齐归档

> 后续九项生产化工作已归档到[第三轮生产化归档](./2026-07-29-runtime-hardening-round-3.md)；本页“下一阶段”保留为当时的差距快照。

归档日期：2026-07-29
前置研究：[竞品与 Agent 底层架构研究](./2026-07-29-agent-architecture-research.md)
上一轮复盘：[Runtime 架构补齐与路线复盘](./2026-07-29-runtime-implementation-review.md)

## 一、结论

本轮已把上一轮列出的八个优先项做成可运行、可测试并接入 TUI/Desktop/VS Code/daemon 主链路的实现。这里的“完成”是本地单机生产基线或远程客户端基线；分布式控制面、企业密钥服务和大规模 runner fleet 仍属于下一阶段。

```text
ACP / OpenAPI 3.1.1 / Generated SDK / Artifacts
                         │
Command Inbox → Durable Runtime + Snapshot → Transactional Outbox
                         │
Context Compiler + Incremental Symbol/Reference/Hybrid Index
                         │
Scheduler → Persistent Worker + Lease/Heartbeat + Worktree Owner
                         │
PatchSet Transaction → Verifier → Artifact / OpenTelemetry
                         │
Security Policy → Credential Broker → Network Proxy
                         │
              Local Isolated / Remote Runtime
                         │
             GitHub branch / draft PR / Actions
```

## 二、本轮交付矩阵

| 项目                                   | 已交付                                                                                                                                                                                            | 关键不变量 / 验收                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Command inbox/outbox 与崩溃续跑        | command 独立持久化、幂等键、claim lease、heartbeat、启动扫描；outbox 先落盘再发布；事件快照与增量恢复；悬空 tool 自动封口                                                                         | 原 prompt 不写 runtime event；过期 lease 可续租；恢复不重复 user prompt；command 终态前事件已冲刷 |
| 强制网络与 Credential Broker           | 环境密钥导入 Broker 后从宿主环境删除；provider/MCP stdio/shell 定向注入；HTTP/CONNECT 代理执行域名、端口、DNS/私网、重定向检查；联网 shell 无代理 fail-close                                      | 普通 shell 不继承 API key；默认断网；凭证受 audience/host/tool/TTL/max-use 约束；日志输出脱敏     |
| PatchSet                               | prepare、preview、base SHA-256 precondition、原子 apply、跨文件失败自动恢复、显式 rollback、0600 journal                                                                                          | 冲突发生在写入前；批次不能半应用；外部改动后拒绝盲回滚                                            |
| 增量 symbol/reference graph            | mtime/size/hash 增量复用、符号与 identifier 图、lexical + graph + 可选 embedding cosine 混合排序、持久索引                                                                                        | 未变文件不重建；查询、引用热度与语义信号共同决定 repo map                                         |
| OpenAPI codegen / ACP                  | OpenAPI 3.1.1、唯一 operationId、path/response 校验；SDK route table 与 contract SHA 自动生成并在 CI 防漂移；ACP v1 初始化门、JSON-RPC 参数、会话、prompt、cancel、update、permission conformance | 契约漂移使 `codegen:check` 失败；未 initialize 的 ACP 请求拒绝；消息 id 单调唯一                  |
| Persistent worker / worktree ownership | 文件持久队列、跨进程锁、lease/heartbeat、过期重租、retry、cancel、幂等；worktree 独占租约接入 subagent                                                                                            | 普通 worker 不会误领 ownership 行；非所有者不能 heartbeat/settle/release                          |
| Eval 100–300                           | 112 个离线确定性任务；覆盖 JS/TS/Python/Go 与 implement/fix/debug/refactor；每题 seed 必失败、reference solution 必通过；质量门覆盖通过率、回归、turn/token/edit failure                          | 任务数不得低于 100；verify 脚本会在评分前从 seed 恢复，防止 agent 篡改评分器                      |
| Remote Runtime / GitHub CI             | Remote Runtime 客户端幂等提交、轮询、取消、Broker 鉴权、受控代理；GitHub branch/file/draft PR/workflow dispatch；独立 Actions workflow 运行 codegen/typecheck/test 并归档 evidence                | 远程请求不直接绕过代理；GitHub token 只以短租约注入；默认创建 draft PR                            |
| TUI 授权浮层                           | 授权卡片紧贴输入框上方、占满可用宽度；上下/左右键循环选择、Enter 确认；y/a/p/n 快捷键与鼠标/滚轮保留                                                                                              | 输入框始终可见；多待决请求显示计数；重连 pending permission 可恢复                                |

## 三、对照上一轮“建议实施路线”

### 已从路线中移出的项目

1. command inbox/outbox、runtime snapshot、启动恢复与悬空 tool 修复。
2. PatchSet 事务编辑与冲突/回滚。
3. 增量索引、symbol/reference graph 与混合召回基线。
4. OpenAPI codegen 防漂移与 ACP v1 核心 conformance。
5. worker lease/heartbeat、重租与 worktree ownership。
6. 100+ 离线 eval 完整性矩阵与质量门。
7. Remote Runtime 客户端和 GitHub/Actions 交付链。
8. 本地受控网络、Broker 装配和各前端主链路接入。

### 下一阶段仍需优化和补齐

#### P0：从单机耐久升级为多进程事务控制面

- 将 JSON/JSONL + 文件锁迁移到 SQLite/PostgreSQL，使 command、event、snapshot、outbox 和 worker claim 共享数据库事务与 fencing token。
- 为副作用工具引入显式 idempotency contract/receipt；崩溃发生在“远端已成功、本地未记账”窗口时，通过查询或补偿而非盲重试。
- 增加 runtime schema migration、snapshot 压缩/GC、死信队列、operator replay/skip/resume 命令和灾难恢复演练。

#### P0：真正不可绕过的全执行面网络与密钥治理

- 当前本地高安全路径在缺 proxy URL 时会 fail-close，内置 fetch/Remote/GitHub 走受控代理；下一步要由宿主自动管理本地 proxy daemon，并强制 browser、HTTP MCP、provider SDK、git/npm 等全部只连该出口。
- 接入 macOS Keychain、Linux Secret Service、Vault/KMS/OIDC，替代环境变量作为长期密钥来源；加入轮换、撤销传播、审计和统一 redaction middleware。
- 用容器/VM 的 network namespace、egress firewall 和 DNS pinning 阻断恶意二进制忽略 `HTTP_PROXY` 后直连。

#### P1：编辑与上下文引擎深化

- 所有 write/edit/notebook/refactor 工具统一输出 PatchSet；支持 rename、binary、大文件、格式化后 rebase、三方 merge、review comments 和 Artifact lineage。
- 用 tree-sitter/LSP 建精确 AST/类型引用图，加入 commit/diff/history graph；接真实 embedding 服务、向量库、reranker，并对 context manifest 做可复现实验。
- 建多语言均衡任务集。目前 112 题达到数量门槛，但 JS 占多数；应补齐真实开源仓库切片、跨文件任务、依赖升级和长上下文任务。

#### P1：远程运行和 GitHub 闭环生产化

- 当前实现是 Remote Runtime 客户端契约；仍需服务端 control plane、ephemeral runner/VM 池、镜像签名、资源配额、租户隔离、日志/Artifact 流和区域调度。
- GitHub 增加 check-run/status 回写、review webhook、Actions 结果等待、失败自动修复轮、branch protection、merge queue 与 provenance/SBOM/签名。
- worker 增加 deadline、优先级老化、资源配额、fencing token、跨节点取消、worktree merge/reviewer/critic 阶段。

#### P1：协议与质量工程

- 跑官方 ACP 测试套件并补齐 capability negotiation、terminal/fs 扩展和协议版本矩阵；为 OpenAPI 增加统一错误 schema、pagination、versioning 和 breaking-change diff。
- Eval 扩到 200–300 个真实任务并做 nightly real-model baseline、故障注入、安全越权、恢复重复副作用、flaky 检测、成本/延迟分位数和生产 canary。
- OpenTelemetry 补 metrics/logs，并把 trace context 贯穿 HTTP/ACP/MCP/worker/remote/GitHub；实现采样、敏感属性治理和 SLO 告警。

#### P2：企业与生态

- RBAC/SSO、组织策略签名与分发、审计留存/导出、数据地域、预算/配额、插件 manifest/签名/供应链扫描、A2A gateway。

## 四、下一阶段验收门槛

- kill -9 注入覆盖每个 tool/remote/GitHub 边界，重复副作用为 0，或者由明确补偿完成闭环。
- 安全模式下即使工具忽略 proxy 环境变量，也无法建立未经策略授权的 socket。
- 任何密钥都无法从 prompt、event、snapshot、PatchSet journal、Artifact、log、trace 或子进程环境读出。
- 远程 runner 为一次性身份和一次性工作区；任务完成后销毁，服务端可证明镜像、commit 和输出 provenance。
- 200–300 真实任务按语言/规模/风险分层，主分支同时守住成功率、回归、P95 延迟、token 成本和安全硬门。
