# Agent Runtime 架构补齐与路线复盘

> 本页是 2026-07-29 的阶段差距快照；其中“仍需完成”项已由 [Production Agent Runtime closure](./2026-07-30-production-runtime-closure.md) 承接并逐项收口。

复盘日期：2026-07-29
依据：[竞品与 Agent 底层架构研究归档](./2026-07-29-agent-architecture-research.md)
范围：本轮要求的上层、中层、下层和横向能力。

## 一、本轮交付结论

本轮已经补齐四层架构的可运行基线，并接入 AniCode 主链路，而不是只增加空接口：

```text
TUI / Desktop / VS Code / CI
              │
       ACP / OpenAPI / SDK
              │
        Artifact Service
              │
 Durable Runtime / Context Compiler
       Scheduler / Verifier
              │
 Security Policy / Capability
 Credential Broker / Network Proxy
              │
        Isolated Runtime

横向：OpenTelemetry / Eval Quality Gate
```

这里的“补齐”指已经形成可测试、可接入、可演进的架构基线。它不等于分布式、企业级和跨平台生产形态已经全部完成；尚欠的部分列在后文。

## 二、完成矩阵

| 能力 | 本轮状态 | 已进入主链路的内容 | 继续生产化所欠 |
| --- | --- | --- | --- |
| ACP | 基线完成 | ACP v1 初始化、会话、prompt、cancel、update、permission 与 stdio JSON-RPC | 官方 schema/conformance、完整能力协商、ACP v2 稳定后适配 |
| OpenAPI | 基线完成 | Artifact、Runtime Event/State、verification event 与动态 path 参数 | 契约生成路由/SDK、统一错误 schema、分页、资源版本和幂等 header |
| SDK | 基线完成 | Artifact 与 Runtime API 的类型化客户端 | 从 OpenAPI 自动生成、版本兼容测试、重试/幂等/流式重连 |
| Artifacts | 基线完成 | 内存/文件存储、内容哈希、原子元数据、API/SDK、验证报告自动归档 | 大对象流式上传、引用计数/GC、ACL、远程对象存储、lineage |
| Durable Runtime | 基线完成 | Event v2、每流顺序、乐观并发、幂等、fsync、损坏尾恢复、状态投影 | 数据库事务/outbox、snapshot、command inbox、真正的进程崩溃续跑 |
| Context Compiler | 基线完成 | 来源分层、必选项、去重、相关性/新鲜度/优先级、预算、manifest/digest | 增量索引、embedding、symbol/reference graph、历史事实检索 |
| Scheduler | 基线完成 | DAG、依赖、优先级、并发、读写资源锁、retry、cancel、失败跳过 | worker lease/heartbeat、持久队列、deadline、worktree ownership/merge |
| Verifier | 基线完成 | 自动发现 typecheck/test/lint、确定性执行、并行验证、报告、失败回灌修复 | 变更感知、browser/security/diff policy、flaky test 管理、缓存 |
| Isolated Runtime | 基线完成 | macOS Seatbelt/Linux bubblewrap、fail-close、路径/环境/超时/输出控制 | 容器/远程 VM、CPU/内存/磁盘配额、Windows 后端、镜像供应链 |
| Network Proxy | 组件完成 | 域名/协议/端口、DNS/IP 与 SSRF、重定向复核、跨域凭证剥离、审计 fetch | 本地 CONNECT/HTTP 强制出口；当前 shell 只有配置外部代理时才注入代理环境 |
| Credential Broker | 组件完成 | scope/audience/host/tool、TTL/次数租约、按需 env/header 注入、撤销和脱敏 | OS Keychain/Vault、provider/MCP 全面迁移、轮换、持久审计 |
| OpenTelemetry | 基线完成 | session/context/model/tool/verifier spans、W3C traceparent、OTLP/HTTP 导出 | metrics/logs、跨 ACP/HTTP/MCP/worker 传播、采样与统一敏感属性治理 |
| Eval | 基线完成 | 多指标质量门：通过率、历史回归、turn、token、edit failure | 100—300 任务分层集、恢复/安全/故障注入、生产 canary |
| Security Policy | 基线完成 | 确定性 deny/ask/allow、deny 优先、工作区硬边界、HMAC capability | 组织策略分发、RBAC/SSO、策略版本/签名、不可抵赖审计、数据地域 |

## 三、对照“第五节建议实施路线”

### 0—6 周：可信单 Agent Runtime

已经形成端到端基线：Runtime Event v2、恢复投影、VerificationPolicy、验证 Artifact、OTel traces、Security Policy、fail-close Isolated Runtime、Network Proxy、Credential Broker，以及 Runtime/Artifact OpenAPI 和 SDK。

仍应继续完成的 P0：

1. 把“写入事件”和“对外确认 command accepted”做成同一事务语义，引入 command inbox/outbox。
2. 为长会话增加 snapshot；启动时扫描未完成 command，真正恢复或确定性终止未闭合 tool call。
3. 将所有 provider、MCP、browser 和 shell 出网统一迁入强制 Network Proxy；拒绝可绕过出口的高安全模式。
4. 将现有环境变量密钥迁入 Credential Broker，事件、Artifact、日志和 telemetry 共用一个 redaction pipeline。
5. 从一份 OpenAPI 契约生成 server routing 类型和 SDK，停止三份手写定义继续漂移。

### 6—12 周：上下文与编辑质量

Context Compiler 的预算化编译边界已经落地，但本阶段其余内容仍是下一优先级：

1. 增量代码索引：tree-sitter/LSP symbol、reference graph、Merkle 文件哈希、lexical + embedding 混合召回。
2. PatchSet/事务编辑：base hash、precondition、preview、原子 apply、冲突、rollback 和 Artifact lineage。
3. Provider 原生能力路由，避免最低公分母 OpenAI-compatible 协议限制 reasoning、cache、structured output 和 multimodal。
4. 把内部 eval 从当前小样本扩展到 100—300 个任务，并按语言、仓库规模、任务类型和风险分层。

### 3—6 个月：并行执行与交付闭环

Scheduler 已有单进程 DAG 核心，ACP 已有 v1 adapter；但本阶段仍未完成：

1. 持久 worker queue、lease、heartbeat、重租赁、deadline 和跨进程取消。
2. worktree 写所有权、PatchSet 合并、冲突处理和 reviewer/critic 阶段。
3. ACP 官方兼容测试，并让 IDE/App/TUI/CI 全部只通过公共 runtime 契约工作。
4. GitHub issue → isolated runtime → branch/PR → review/Actions 闭环及远程执行面。

### 6—12 个月：企业与生态

本轮只留下了可承载企业能力的 policy/capability/telemetry 边界。RBAC、SSO、组织策略、审计留存、数据地域、成本配额、插件签名/权限清单/市场、A2A gateway 均尚未开始，不应提前包装成已经完成。

## 四、下一轮建议顺序

按风险收益比，建议继续依次补齐：

1. **Durable command recovery**：command inbox/outbox、snapshot、未闭合 tool call 修复和崩溃回归测试。
2. **强制网络与密钥边界**：本地 proxy daemon、全执行面接入 Broker、统一 redaction；这是当前最重要的安全缺口。
3. **PatchSet**：把修改从“工具直接写文件”升级为可预览、可冲突检测、可回滚的事务资源。
4. **Context Engine 2**：增量 symbol/reference graph 与混合召回，并用 context manifest 做可复现实验。
5. **契约单一事实源**：OpenAPI codegen + ACP conformance，所有客户端围绕同一 runtime。
6. **Scheduler 生产化**：持久 worker、lease/heartbeat、worktree ownership 与 reviewer。
7. **Eval 扩容**：真实任务集、故障注入、安全硬门禁和生产 canary。
8. **Remote Runtime + GitHub/CI**：在本地可信闭环稳定后再扩到远程交付。

## 五、验收标准

下一阶段不以“类和接口存在”为完成标准，而以这些系统不变量验收：

- 进程在任意 tool 边界被杀死后，会话可以恢复，且不会重复不可幂等副作用。
- 高安全模式下，命令不能绕过网络出口，密钥不会出现在 prompt/event/artifact/log/trace。
- 模型声称完成但 Verifier 失败时，会话不能进入成功终态。
- 同一 command 的 context manifest、event stream、Artifact 和 trace 可以互相定位与复放。
- OpenAPI 兼容检查失败时 SDK/服务端不得发布。
- eval 中安全失败与历史任务回归是硬失败，不能被平均通过率抵消。
