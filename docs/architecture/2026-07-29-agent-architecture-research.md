# AniCode 竞品与 Agent 底层架构研究归档

> 本页保留最初调研与实施路线；最终落点、生产不变量和真实环境验收边界见 [Production Agent Runtime closure](./2026-07-30-production-runtime-closure.md)。

归档日期：2026-07-29
适用仓库：AniCode 0.1.x
性质：上一轮实时调研、架构判断、差距矩阵与实施路线的仓库内版本。

## 一、结论

AniCode 已不是“模型外面套一层工具调用”的玩具：它已有统一消息模型、Provider 抽象、带工具并发与权限门的 Agent loop、`SessionHost` 传输边界、会话恢复、上下文压缩、repo map、子 Agent/worktree、hooks、沙箱和真实 eval。

下一阶段不应继续横向堆模型或工具数量，而应升级为可恢复、可验证、可治理、可被多种客户端复用的 Agent Runtime。目标架构是：

```text
TUI / Desktop / IDE / Web / CI
              │
       ACP / OpenAPI / SDK
              │
    Session & Artifact Service
              │
      Durable Runtime / Event Log
              │
 Planner ─ Context Compiler ─ Scheduler
              │
    Model Gateway / Subagents / Tools
              │
 Policy / Capability / Credential Broker
              │
 Isolated Runtime / FS / Shell / MCP / Browser
              │
         Verifier / Reviewer
              │
      Done / Retry / Human Review

横向：OpenTelemetry / Eval / Security Policy
```

核心原则：聊天记录不是运行时事实源；“模型说完成”也不是完成条件。事件日志、Artifact、确定性验证和策略裁决必须是一等公民。

## 二、优秀竞品的长处与 AniCode 应追赶的点

### Claude Code

长处：

- 子 Agent 有独立上下文、模型、工具、权限、skills、MCP、memory 与 worktree；后台运行与团队直接通信已形成完整工作方式。
- hooks 生命周期广，扩展点覆盖输入、工具、权限、压缩、子 Agent 与停止阶段。
- 文件系统和网络沙箱是统一安全边界，保护敏感路径，并能采用 fail-close。
- 权限、规则、项目记忆与工具 UX 成熟，长任务过程反馈清晰。

AniCode 差距：子 Agent 仍偏“任务工具”，缺共享任务图、租约、心跳、worker 恢复和 agent-to-agent 通信；沙箱在不支持平台/缺二进制时仍有 fail-open 路径；网络与凭证还没有独立治理面。

### OpenAI Codex

长处：

- App Server 是多客户端共享的正式运行时，而不只是 CLI 旁路。
- SDK、headless JSONL、结构化输出、IDE/App/CLI/cloud 共享同一线程与能力模型。
- worktree、subagent inspect/switch、scheduled tasks、skills、plugins、hooks、MCP 等被统一在同一个产品面。
- 对沙箱、审批与外部协议边界的定义清晰。

AniCode 差距：`SessionHost` 已有正确方向，但还需稳定公共协议、耐久事件、Artifact、结构化 headless 输出与更完整的 SDK；Provider 仍以 OpenAI Chat Completions 兼容层为主，需增加各家原生协议能力路由。

### Google Antigravity CLI（Gemini CLI 后继）

长处：

- CLI 与其他客户端共享 server-side harness。
- 异步多 Agent 后台执行，计划、diff、报告、截图/录制等 Artifact 是主要交付方式。
- 多根项目与大型仓库工作流更成熟。
- 旧 Gemini CLI 在 sandbox 变体、policy engine 与 OpenTelemetry 指标方面积累很深。

AniCode 差距：Artifact 还未成为资源模型；缺多根 workspace、worker scheduler、任务状态恢复和完整 OTel 指标面。

### Cursor

长处：

- 后台 Agent 运行于隔离远程 VM，可并行处理长任务。
- 语义索引、Merkle 文件哈希与路径级规则提高大仓上下文命中率。
- apply/reapply/diff 的编辑体验强，用户能清楚看到并控制改动。

AniCode 差距：repo map 仍是轻量正则与全局词频；缺增量索引、符号图/引用图、混合检索、PatchSet 冲突模型和远程执行控制面。

### GitHub Copilot Coding Agent / CLI

长处：

- issue → branch → Actions runtime → PR → review 是完整软件交付闭环。
- code review 能利用仓库上下文、MCP、skills 与企业策略。
- 企业权限、审计、组织级策略和 GitHub 原生协作入口强。

AniCode 差距：尚缺 GitHub/CI 控制面、PR Artifact、reviewer/critic 阶段、组织策略分发和审计导出。

### OpenCode

长处：

- TUI 是 HTTP server 的客户端；OpenAPI 3.1 与生成 SDK 把服务端契约作为单一事实源。
- 多客户端、插件、MCP、权限模型的边界清楚。

AniCode 差距：现有 HTTP/SSE/OpenAPI/SDK 雏形方向正确，需继续消除手写路由、OpenAPI 与 SDK 三者漂移，并补资源版本、幂等、分页、错误 schema 与兼容策略。

### Aider

长处：

- repo map 使用依赖/引用图和严格 token 预算，不只是罗列文件。
- architect/editor 双模型拆分思考与编辑；编辑格式按模型优化。
- 自动 lint/test 和 benchmark 是核心闭环；prompt cache 布局成熟。

AniCode 差距：Context Compiler 需从静态拼接升级为查询相关、预算化、可追溯编译；编辑需引入 PatchSet/事务/冲突检测；Verifier 应成为完成门槛。

### Cline

长处：

- shadow git checkpoint 在工具动作后持续建立恢复点，文件和任务可分别恢复。
- conditional rules 和 SDK 包边界清楚。

AniCode 差距：已有 checkpoint/rewind，但运行事件、Artifact、对话、文件状态还不是同一个一致性模型，崩溃恢复仍需补齐。

### OpenHands / SWE-agent

长处：

- OpenHands 将 event stream、controller 与 Docker runtime 分离，天然支持远程执行与回放。
- SWE-agent 强调 Agent-Computer Interface：工具形状、反馈质量和编辑成功率往往比单纯换大模型更重要。

AniCode 差距：需要隔离 Runtime 接口、结构化 command/file/browser observation，以及按 ACI 维度量化工具错误和返修成本。

说明：Roo Code 已于 2026-05-15 归档/停止，不宜作为未来路线的主要追赶对象。

## 三、AI Agent 底层架构技术与主要原理

### 1. Agent Loop

```text
accept command
  → compile context
  → call model (stream)
  → persist assistant message
  → if tool calls:
       policy → permission → schedule → isolated execute
       → persist observations → continue
  → deterministic verify
  → pass: complete
  → fail: return evidence to model and retry / escalate
```

必须保持的状态机不变量：

- 每个 tool call 必须恰好对应一个 tool result，即使中断/崩溃也要补合成错误结果。
- 副作用调用在稳定顺序下执行；只有证明无冲突的调用才并行。
- 用户中断后不得再启动新副作用。
- 持久化成功后才向调用者确认 command accepted/completed。
- 完成由状态机与 Verifier 判断，不由自然语言判断。

### 2. Model Gateway

统一处理 provider 原生协议、流式事件、工具 schema、reasoning、图像、缓存、重试、fallback、限流、成本和能力发现。抽象层应保留最高表达力，provider adapter 负责降维，不能让某个兼容协议限制整个核心模型。

### 3. Context Compiler

上下文来源包括 system policy、环境、项目记忆、代码索引、当前任务、历史、工具观察、skills、MCP resource 与长期记忆。编译器负责：

- 去重、来源标记与可信度分层。
- 必选上下文优先；其余按 priority/relevance/freshness/cost 排序。
- 严格 token 预算和 head/tail/结构化截断。
- 查询相关的混合检索：词法 + embedding + symbol/reference graph + 最近编辑/会话信号。
- 输出 manifest/digest，支持复现“模型当时看到了什么”。

可采用的排序骨架：

```text
score = w1 * lexical
      + w2 * semantic
      + w3 * graph-centrality
      + w4 * recency
      + w5 * explicit-priority
      - w6 * token-cost
```

### 4. Memory

至少区分：项目规则、会话工作记忆、用户偏好、任务事实、可检索历史。长期记忆必须有来源、作用域、更新时间、冲突/失效规则与删除能力；摘要不能取代原始事实源。

### 5. Tool / ACI

工具接口除 name/schema/run 外，还应描述：

- effect：read / write / process / network / credential。
- concurrency safety 与资源锁。
- 幂等键、超时、取消和重试语义。
- observation 的大小、结构、Artifact 引用。
- capability 需求与审计字段。

工具返回应结构化、短而可操作；大输出落 Artifact，模型只收到摘要和 URI。

### 6. Security

建议采用分层防御：

```text
Security Policy（组织/项目硬规则）
  → Capability Token（主体、audience、scope、resource、TTL）
  → Permission（用户交互裁决）
  → Isolated Runtime（文件/进程边界）
  → Network Proxy（DNS/域名/IP/端口/重定向）
  → Credential Broker（目标绑定、短租约、按需注入）
  → Audit / Redaction
```

deny 必须压过 bypass/hook/user approval；密钥不能进入 prompt、模型可见环境、事件正文或 Artifact。MCP token 需要 audience binding，不能透明 passthrough。

### 7. Execution Runtime

统一接口应覆盖本机 Seatbelt/bubblewrap、容器、远程 VM 与云 worker。核心参数包括 workspace roots、read-only paths、network policy、resource limits、environment allowlist、credential leases、timeout 和 cleanup。策略无法执行时，高安全档位应 fail-close。

### 8. Edit Engine / PatchSet

把编辑表示为一等 PatchSet：base hash、目标文件、hunks、preconditions、结果 hash、冲突、apply/rollback。模型只提出 patch；编辑引擎原子验证与应用。这样可支持 preview、reapply、review、分支合并和可重复验证。

### 9. Verifier

验证由策略声明、非 shell 自由文本：typecheck、unit/integration test、lint、build、browser smoke、security scan、diff policy。每项有 required、超时、适用文件、依赖和输出上限；报告落 Artifact。失败证据回灌模型，超过返修预算进入人工复核。

### 10. Multi-Agent Scheduler

把多 Agent 表示为 task DAG，而不是自由 swarm。节点包含依赖、priority、model、tool/capability、workspace/worktree、资源锁、deadline、retry、lease、heartbeat、result Artifact。worker 崩溃后任务可重新租赁；写任务必须有 ownership/merge 策略。

### 11. Durable Runtime

append-only Runtime Event 是事实源，snapshot 是加速投影。建议事件字段：

```json
{
  "id": "rte_...",
  "version": 2,
  "streamId": "session-id",
  "sequence": 42,
  "timestamp": "...",
  "type": "tool.completed",
  "data": {},
  "correlationId": "...",
  "causationId": "...",
  "idempotencyKey": "...",
  "traceId": "...",
  "spanId": "..."
}
```

写入要有每 stream 顺序、乐观并发、幂等、fsync/事务和尾行损坏恢复。敏感正文不应默认写事件。

### 12. OpenTelemetry

关键 span：session command、context compile、model stream、tool authorize/execute、scheduler task、verification、artifact write、MCP/network。关键 attributes/metrics：model/provider、token/cache/cost、turns、tool errors、permission latency、queue wait、verification pass、retries、sandbox/proxy decision。跨 HTTP/MCP/worker 传播 W3C trace context。

### 13. 协议

- ACP：IDE/client ↔ agent；v1 当前稳定，v2 截至归档日仍为 Draft。
- OpenAPI/SDK：Web/App/CI 的资源和事件接口，契约应单一来源生成。
- MCP：agent ↔ tools/resources/prompts；认证必须守 audience/resource 边界。
- A2A：agent ↔ agent 的任务、Artifact、生命周期与流式协作；在内部 task DAG 稳定后再引入。

## 四、差距优先级

### P0

- Durable Runtime：command/event/idempotency/recovery。
- `SessionHost` 的公共 ACP/OpenAPI/SDK 协议面。
- Context Compiler 与混合索引的可演进边界。
- Security Policy、capability、隔离 Runtime、网络与凭证治理。
- Verifier 完成门槛与验证 Artifact。
- OpenTelemetry 全链路与安全脱敏。

### P1

- PatchSet/事务编辑。
- task DAG、worker lease/heartbeat、write ownership。
- 分层记忆与增量索引。
- 浏览器可复现验证、录制 Artifact。
- GitHub/CI/cloud runtime。

### P2

- 企业 RBAC/SSO/审计留存/组织策略。
- 插件签名、兼容矩阵与市场。
- A2A 与跨 Agent 生态。

## 五、建议实施路线

### 0—6 周：可信单 Agent Runtime

- Runtime Event v2 + command 状态机 + crash recovery。
- VerificationPolicy + 验证 Artifact + “验证通过才完成”。
- OpenTelemetry spans/metrics 与 credential redaction。
- Security Policy + fail-close capability；把网络、密钥从普通工具参数中移出。
- OpenAPI/SDK 对 runtime event、Artifact 和错误模型补齐。

### 6—12 周：上下文与编辑质量

- Context Engine 2：增量索引、symbol/reference graph、lexical+semantic 混合召回、context manifest。
- PatchSet：base hash、原子 apply、冲突、preview、rollback。
- Provider 原生接口：Responses/Anthropic/Gemini 等能力路由与 prompt cache。
- eval 扩到 100—300 个内部任务，按语言/仓库规模/任务类型分层。

### 3—6 个月：并行执行与交付闭环

- task DAG + scheduler + worker lease/heartbeat/retry。
- worktree ownership、合并与冲突处理。
- ACP 正式兼容测试；IDE/App/TUI/CI 共享同一 runtime。
- GitHub issue/PR/review/Actions 与 remote isolated runtime。

### 6—12 个月：企业与生态

- 组织策略、RBAC、SSO、审计留存、数据地域与成本配额。
- 插件签名/权限清单/兼容矩阵/市场。
- A2A gateway、跨 Agent Artifact 与任务生命周期。

## 六、评测体系

- L1：协议、策略、工具、恢复、上下文编译的单元/性质测试。
- L2：100—300 个真实仓库内部任务，统计 pass、turn、token、cost、edit/tool error、verification retry。
- L3：Terminal-Bench、SWE-bench 等公开集；不把单榜当唯一目标。
- L4：生产 canary，比较完成率、人工接管率、回滚率、敏感操作拦截率和单位成功成本。

门禁至少同时守：通过率、以前通过的任务是否回归、平均轮数、平均输入 token、编辑失败率；安全与数据泄漏用独立硬门禁，不能拿“总体通过率提高”抵消。

## 七、不要做的事

- 不先追 provider 数量；先修 runtime、context、verification 与 security。
- 不做没有 DAG/ownership/recovery 的自由 swarm。
- 不把纯向量检索当 Context Engine。
- 不让 LLM 充当安全策略引擎或最终 verifier。
- 不让摘要成为事实源，也不默认把密钥/命令正文写入事件。
- 不只跑 SWE-bench，不追逐已经归档的竞品路线。

## 八、主要一手资料

- ACP：[Architecture](https://agentclientprotocol.com/get-started/architecture)、[v1 Initialization](https://agentclientprotocol.com/protocol/v1/initialization)、[v1 Session Setup](https://agentclientprotocol.com/protocol/v1/session-setup)、[v1 Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)
- Claude Code：[Subagents](https://code.claude.com/docs/en/sub-agents)、[Hooks](https://code.claude.com/docs/en/hooks-guide)、[Sandboxing](https://code.claude.com/docs/en/sandboxing)、[Security](https://code.claude.com/docs/en/security)
- OpenAI Codex：[App Server](https://learn.chatgpt.com/docs/app-server.md)、[SDK](https://learn.chatgpt.com/docs/codex-sdk.md)、[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents.md)、[Sandboxing](https://learn.chatgpt.com/docs/sandboxing.md)
- Antigravity：[CLI Subagents](https://antigravity.google/docs/cli-subagents)、[Artifacts](https://antigravity.google/docs/artifacts)、[Projects](https://antigravity.google/docs/projects?app=cli)
- Cursor：[Background Agent](https://docs.cursor.com/background-agent)、[Rules](https://docs.cursor.com/context/rules)、[Security](https://www.cursor.com/security)
- GitHub Copilot：[Coding Agent](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents)、[Code Review](https://docs.github.com/en/copilot/concepts/agents/code-review)、[Hooks](https://docs.github.com/en/copilot/reference/hooks-reference)
- OpenCode：[Server](https://dev.opencode.ai/docs/server/)、[Agents](https://opencode.ai/docs/agents/)、[Config](https://opencode.ai/docs/config/)
- Aider：[Repo Map](https://aider.chat/docs/repomap.html)、[Modes](https://aider.chat/docs/usage/modes.html)、[Lint/Test](https://aider.chat/docs/usage/lint-test.html)
- OpenHands：[Runtime Architecture](https://docs.openhands.dev/openhands/usage/architecture/runtime)
- Terminal-Bench 2.0：[paper](https://arxiv.org/abs/2601.11868)
- OpenTelemetry JS：[Instrumentation](https://opentelemetry.io/docs/languages/js/instrumentation/)
- MCP：[Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
- A2A：[Specification](https://a2a-protocol.org/latest/specification)
