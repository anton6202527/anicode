# anicode 架构 v2：Agent 核心解耦设计案

> 状态：**已实施（2026-07-26）**。§1–§8 为原设计案（保留供追溯）；实施记录与
> 实时调研验证见 §9。每步迁移均保持 `typecheck + lint + 全部离线测试` 绿。
>
> 目标读者：core 维护者。前置阅读：`packages/core/src/agent.ts`、`context.ts`、`tools/tool.ts`、`types.ts`。

---

## 0. 为什么要动，动到什么程度

现状 core 已与 Codex / Claude Code 近乎功能对齐，绝大多数「剩余项」是磨料而非结构。本次重构**不新增任何功能、不改任何外部行为**，只做一件事：

> 把 `Agent`（`agent.ts`，1744 行、`AgentOptions` 约 40 字段）这个神类，按 Codex-rs / Claude Code 的思路拆成**若干单一职责的协作对象**，`Agent` 退化为一个 ~350 行的薄编排器。

**为什么值得做**：`Agent` 现在同时扛着 7 类责任（见 §1）。任何一类的改动都要在 1744 行里穿针引线，且这些责任通过一组隐式状态标志（`running` / `acceptingQueuedInput` / `noticeQueue` / `queued` / `pendingTaskNotices`）耦合成一台「只在注释里存在」的状态机。拆开后每类责任可独立测试、独立演进，新增上下文源 / 新的重试策略 / 新的工具调度规则都不再需要编辑神方法。

**硬约束（本次不碰）**：
- 对外契约 100% 不变：`AgentEvent` 事件联合、`AgentOptions` 字段、`send/queue/clearQueue/compactNow/rewindConversation/setPermissionMode/setPermissionProfile/snapshot/stopBackgroundTasks` 及全部只读 getter。`session-manager.ts:817` 的构造点一字不改即可编译通过。
- `SessionManager` / `SessionHost` / daemon / 三端前端：零改动。
- Provider 抽象、Tool 契约、权限引擎、MCP、子 agent 语义：零改动（它们本就干净，是被 `Agent` 编排的协作方，不是被重构对象）。
- 全部 107 个测试文件不改断言（只有极少数直接 new 私有辅助的白盒测试可能改 import 路径，见 §6）。

**非目标**（明确不做，避免范围蔓延）：
- 不引入依赖注入容器 / 事件总线框架。协作对象用**普通构造函数注入**即可。
- 不改 `ChatMessage` 内容块模型、不改持久化格式（JSONL）。
- 不做 async-generator → 回调/Observable 的范式切换。事件流仍是 `AsyncGenerator<AgentEvent>`。

---

## 1. 现状：Agent 的 7 类责任（责务地图）

| # | 责任 | 现在落在 agent.ts 的哪里 | 关键状态 |
|---|------|--------------------------|----------|
| R1 | **驱动循环编排**（turn 循环、maxTurns、done/error 收尾、checkpoint 触发） | `drive()` 821–1006 | `running` |
| R2 | **模型轮 + 瞬时错误重试 + 降级链 + 小模型摘要流** | `runModelTurn()` 1070、`nextFallback()` 1115、`streamOnce()` 1135、`streamText()` 1486、模块级 `isTransientError/retryAfterMs/sleep` 1679–1742 | `provider/model`（per-drive 临时改）、`fallbackQueue` |
| R3 | **工具执行调度**（并行批 / 串行、权限门、Pre/PostToolUse hook、图片附带、结果截断） | `runTools()` 1191、`isParallelSafe()` 1222、`runToolBatch()` 1236、`runToolSafe()` 1284、`runTool()` 1302、`truncateToolResult()` 1667 | `parallelInputsStable` |
| R4 | **上下文组装**（env / 项目记忆 / repo map / skills 清单 / SessionStart hook / browser 用法 → 一次性 compose 进 system） | `ensureMemory()` 1516–1584、`context.ts:composeSystem` | `system`、`memoryLoaded` |
| R5 | **Compaction 判定与执行**（触发线、PreCompact/PostCompact hook、`compactNow`、rewritePersist） | `drive()` 内 862–889、`compactNow()` 635、`resolveCompaction()` 1456、`context.ts:maybeCompact` | `lastInputTokens` |
| R6 | **Steering + 后台任务通知的三方向状态机** | `queue()` 805、`clearQueue()` 812、`deliverTaskNotice()` 564、`drainNotices()` 1042、`drainQueued()` 1053、`send()` finally 785–797 | `queued`、`noticeQueue`、`pendingTaskNotices`、`acceptingQueuedInput`、`onTaskNoticeCb` |
| R7 | **历史 + 持久化 + 用量/成本记账** | `history` 数组直接操作、`flushPersist()` 1586、`rewritePersist()` 1594、`accumulate()` 1600、`repairHistory()` 228、`rewindConversation()` 673、`estimatedCostUSD` 598、`context.ts:findSafeCutoff/estimateTokens` | `history`、`persistedCount`、`cumulative`、`lastInputTokens` |

**核心观察**：R1 是「编排」，R2–R7 是「机制」。神类的问题是把编排和 6 类机制写在同一个 `this` 上，靠共享可变字段通信。v2 让 `Agent` 只保留 R1，R2–R7 各成一个协作对象。

---

## 2. 目标模块分解

```
                       ┌─────────────────────────────────────┐
                       │            Agent (~350 行)           │
                       │  R1 编排：drive 循环 / send / queue    │
                       │  持有并织合下列协作对象，转发事件流       │
                       └───┬───────┬────────┬────────┬────────┘
             ┌─────────────┘       │        │        └──────────────┐
             ▼                     ▼        ▼                       ▼
   ┌──────────────────┐  ┌────────────────┐ ┌──────────────┐ ┌──────────────────┐
   │ ContextAssembler │  │   TurnRunner   │ │ ToolExecutor │ │  SteeringInbox   │
   │      (R4)        │  │     (R2)       │ │    (R3)      │ │      (R6)        │
   │ ContextProvider[]│  │ provider.stream│ │ 并行批调度     │ │ steering+通知     │
   │ →compose system  │  │ +retry+fallback│ │ +perm+hooks  │ │ 三方向状态机       │
   │                  │  │ +small-model   │ │ +图片+截断     │ │                  │
   └──────────────────┘  └────────────────┘ └──────────────┘ └──────────────────┘
             │                                     │                   
             └──────────────┬──────────────────────┘                   
                            ▼                                          
                 ┌────────────────────────┐                           
                 │      Conversation       │  (R5 + R7)                
                 │ 持有 ChatMessage[] 与全部  │                           
                 │ 不变量：repair/safe-cutoff│                           
                 │ /fold/token 估算/compact  │                           
                 │ + 持久化 flush/rewrite     │                           
                 │ + 用量记账/成本            │                           
                 └────────────────────────┘                           
```

依赖方向：`Agent` → 各协作对象；协作对象之间**不横向依赖**（`ToolExecutor` 不认识 `TurnRunner`）。`Conversation` 是最底层的被共享状态，其余协作对象通过参数拿到它需要的切片（如 `TurnRunner.stream(messages, system)` 只收数组，不持有 `Conversation`），保持可单测。

---

### 2.1 `Conversation`（R5 + R7）—— 历史值对象

**职责**：拥有 `ChatMessage[]` 及其全部结构不变量，成为「唯一能改历史的地方」。今天散在 `agent.ts` 和 `context.ts` 的历史操作全部收拢到这里。

**接口草图**（新文件 `packages/core/src/conversation.ts`）：
```ts
export class Conversation {
  constructor(opts: { persistence?: PersistenceConfig; resumeMessages?: ChatMessage[] });

  get messages(): readonly ChatMessage[];
  get length(): number;

  // 追加（内部维护 persistedCount）
  pushUser(text: string, opts?: { internal?: boolean; additionalContext?: string }): void;
  pushAssistant(message: ChatMessage): void;
  pushToolResults(results: ToolResultPart[], images: ImagePart[]): void;

  // 不变量操作（今天分散在各处）
  repair(): boolean;                        // ← repairHistory (agent.ts:228)
  rewind(messageCount: number): number;     // ← rewindConversation (agent.ts:673)

  // compaction（策略见 §2.5，Conversation 只负责应用结果并保持配对不变量）
  applyCompaction(result: CompactionResult): void;

  // 持久化（今天的 flushPersist/rewritePersist）
  flush(): Promise<void>;
  rewritePersist(): Promise<void>;

  // 记账
  accumulate(usage: Usage): void;
  get cumulative(): Usage;
  estimatedCostUSD(cost?: ModelCost): number | undefined;   // ← agent.ts:598
  get lastInputTokens(): number;
  noteRealInput(usage: Usage): void;       // outcome.usage → lastInputTokens (agent.ts:917)
}
```

**从别处搬来的纯函数**（保留在 `context.ts`，`Conversation` 调用它们，**不重写**）：`estimateTokens`、`findSafeCutoff`、`microcompact`、`maybeCompact`、`compactionPending`。这些已经是无状态、已单测，v2 一行不改，只是调用点从 `Agent` 移到 `Conversation`。

**不变量（必须原样保住，见 §4）**：role 交替、tool_call/tool_result 配对、compaction 安全切割点、折叠幂等、`persistedCount` 与 `history.length` 的一致性。

---

### 2.2 `ContextAssembler` + `ContextProvider[]`（R4）—— 可组合上下文

**职责**：把「一次性注入 system 的静态上下文」从命令式 `sections.push()` 变成有序的 provider 管线。

**接口草图**（新文件 `packages/core/src/context-assembler.ts`）：
```ts
export interface ContextProvider {
  readonly id: string;                 // "env" | "project-memory" | "repo-map" | "skills" | ...
  /** 返回要拼进 system 的一段；返回 null 表示本次无贡献。失败应内部吞掉返回 null。 */
  contribute(ctx: { cwd: string; tools: ToolRegistry }): Promise<string | null>;
}

export class ContextAssembler {
  constructor(providers: ContextProvider[]);
  /** 顺序执行全部 provider，compose 到 baseSystem 之后，返回最终 system。只跑一次。 */
  assemble(baseSystem: string, ctx: {...}): Promise<string>;
}
```

**内置 provider**（把 `ensureMemory()` 1516–1584 的分支各拆一个，逻辑照搬）：
- `EnvProvider` ← `gatherEnv` (env.ts)
- `ProjectMemoryProvider` ← `loadProjectMemory` (context.ts)
- `RepoMapProvider` ← `gatherRepoMap` (repomap.ts)
- `SkillsProvider` ← `discoverSkills` + `skillListPrompt`（**注意副作用**：它还 `tools.register(skillTool)` 且 `perm.addReadOnlyTools`，见 §4-I）
- `BrowserUsageProvider` ← 现 1556–1563 的用法指引
- `SessionStartHookProvider` ← SessionStart hook 的 additionalContext

**收益**：新增上下文源 = 新增一个 `ContextProvider` 实现 + 一行注册，不再编辑 `ensureMemory`。每个 provider 可独立单测（今天要跑整个 Agent 才能测到 env 注入）。

**顺序保证**：provider 数组顺序 = 现在 `sections.push` 的顺序（env → memory → repoMap → skills → browser → sessionStart），保证 system 逐字节不变（缓存友好，见 §4-C）。

---

### 2.3 `TurnRunner`（R2）—— 模型轮 + 韧性

**职责**：把「一次模型补全」连同重试、降级链、Retry-After、小模型摘要流全部封起来。`Agent` 只调 `runTurn()` 拿 `TurnOutcome` + 事件流。

**接口草图**（新文件 `packages/core/src/turn-runner.ts`）：
```ts
export class TurnRunner {
  constructor(opts: {
    provider: Provider; model: string;
    small: { provider: Provider; model: string };
    resolveModel?: (spec: string) => AgentResolvedModel;
    fallbackModels: string[];
    retry: Required<RetryConfig> | null;
    modelInfo?: AgentModelInfo;
    maxTokens?: number; effort?: Effort;
  });

  /** 当前生效的 provider/model（per-prompt override / fallback 会改；send 结束还原） */
  setActiveModel(m: AgentResolvedModel | { provider; model; ... }): void;
  resetFallbackQueue(): void;         // 每次 drive 重置（agent.ts:753）

  /** 跑一轮（含重试/降级），yield retry/turn_reset/model_fallback 事件，返回 TurnOutcome */
  runTurn(req: { system: string; messages: ChatMessage[]; tools?: ToolDefinition[]; signal }):
    AsyncGenerator<AgentEvent, TurnOutcome>;

  /** 摘要用的纯文本流（小模型优先，失败回退主模型）—— 供 Conversation/compaction 注入 */
  streamText(messages: ChatMessage[], system: string): AsyncIterable<{type; text?}>;
}
```

**搬入**：`runModelTurn` 1070、`nextFallback` 1115、`streamOnce` 1135、`streamText` 1486，以及模块级 `isTransientError`/`retryAfterMs`/`sleep`。`TurnOutcome` 类型移到这里 export。

**关键**：per-prompt 模型覆盖与降级切换今天靠临时改 `this.provider/model/supportsTools/supportsImages` 再在 `send` finally 还原（agent.ts:746–797）。v2 把「active model」状态收进 `TurnRunner`，`Agent.send` 只调 `setActiveModel` / `resetFallbackQueue`，还原逻辑对称留在 `Agent.send` finally（因为 override 是「本次 send」的语义，属编排层）。

---

### 2.4 `ToolExecutor`（R3）—— 工具调度

**职责**：给定一批 `ToolCall`，按「连续只读并行、副作用串行」调度，逐个过 PreToolUse hook → 权限门 → 执行（进度回流）→ PostToolUse hook，产出事件流并回填 `{results, images}`。

**接口草图**（新文件 `packages/core/src/tool-executor.ts`）：
```ts
export class ToolExecutor {
  constructor(opts: {
    tools: ToolRegistry; perm: PermissionEngine; hooks: HookRunner;
    cwd: string; sandbox?: Sandbox; maxToolResultChars: number;
    parallelInputsStable: boolean;
    supportsImages: () => boolean;         // 随 active model 变，用 getter 注入
    addUsage: (u: Usage) => void;          // 汇入 Conversation.accumulate
  });

  run(calls: ToolCall[], signal: AbortSignal):
    AsyncGenerator<AgentEvent, { results: ToolResultPart[]; images: ImagePart[] }>;
}
```

**搬入**：`runTools` 1191、`isParallelSafe` 1222、`runToolBatch` 1236、`runToolSafe` 1284、`runTool` 1302、`truncateToolResult` 1667、`errResult` 1612。`ToolCall` 类型移到这里或 `tools/tool.ts`。

**注意事项**：`runTool` 里对 deferred 工具的自动激活（1316）、confirm 改写 input 后的二次 deny/ask 校验（1367–1380）、图片仅在工具成功时并入（1450）、PostToolUse 对成功/失败都跑（1428）—— 这些微妙分支逐行搬，不重写（§4-F/G/H）。

---

### 2.5 `SteeringInbox`（R6）—— steering + 通知状态机

**职责**：把今天靠 5 个字段隐式表达的状态机显式化。它管三条输入通道：用户 steering（`queue`）、后台任务完成通知（运行中→turn 边界；空闲→回调；兜底→next send），以及它们与 `acceptingQueuedInput` 窗口的交互。

**接口草图**（新文件 `packages/core/src/steering.ts`）：
```ts
export class SteeringInbox {
  // 窗口
  openSteering(): void;            // drive 中主输入进历史后
  closeSteering(): void;           // done/error/中断
  get accepting(): boolean;

  // steering
  enqueue(text: string): boolean;  // ← queue() 805；窗口关时返回 false
  clear(): number;                 // ← clearQueue() 812
  hasQueued(): boolean;
  takeQueued(): string[];          // drainQueued 消费

  // 任务通知（三方向投递）
  deliverNotice(text: string, running: boolean, onIdle?: (t: string) => void): void; // ← deliverTaskNotice 564
  hasNotices(): boolean;
  takeNotices(): string[];         // drainNotices 消费
  drainPendingIntoNotices(): void; // 下次 send 开头，pendingTaskNotices → noticeQueue
  flushLeftoverOnClose(onIdle?): void; // send finally，未赶上 turn 边界的通知转空闲投递（agent.ts:793）
}
```

**为什么值得单独抽**：这是全类最难懂、最易出竞态 bug 的部分（`clearQueue` 先关窗再清、Stop hook await 期间再查 steering、finally 的 leftover 转投递……）。抽成独立对象后可以针对「窗口开关时序」写专门的单测，而不必驱动整个 Agent。`Agent.drive` 里对 `drainQueued`/`drainNotices` 的调用点（yield 事件）仍留在 `Agent`（因为要 yield `user_message`/`task_notice` 事件，属编排），`SteeringInbox` 只做「谁该被消费、窗口是否开」的判定。

---

### 2.6 `Agent`（R1）—— 薄编排器

重构后 `Agent` 只剩：
- 构造：归一化 `AgentOptions` → 组装上述 5 个协作对象 + `PermissionEngine` + `HookRunner` + `TaskRegistry`（子 agent 注册逻辑 `registerTaskTool` 保留在 Agent，因为它要闭合 `makeAgent: o => new Agent(o)` 自引用）。
- `send()` / `drive()`：turn 循环骨架 —— 每轮 `Conversation.maybeCompact` → `TurnRunner.runTurn` → push assistant → 判断 stopReason → `ToolExecutor.run` → push results → 在 turn 边界问 `SteeringInbox` 要不要注入。约 150 行。
- 生命周期 getter/命令：`compactNow`/`rewindConversation`/`setPermissionMode/Profile`/`snapshot`/`stopBackgroundTasks` —— 多为一行委派。

预计 `agent.ts` 从 1744 → ~350 行；新增 5 个文件各 100–250 行；净行数基本持平（是**搬迁+边界**，不是新增逻辑）。

---

## 3. 依赖图与文件清单

| 新文件 | 行数估 | 搬自 agent.ts / context.ts 的内容 | 依赖 |
|--------|--------|-----------------------------------|------|
| `conversation.ts` | ~230 | history 操作、flush/rewrite、accumulate、repairHistory、rewind、cost；调用 context.ts 的 compaction 纯函数 | types, session, context, snapshot |
| `context-assembler.ts` + `context-providers.ts` | ~200 | `ensureMemory` 各分支 | env, context(memory), repomap, skills, hooks |
| `turn-runner.ts` | ~250 | runModelTurn/nextFallback/streamOnce/streamText + isTransientError/retryAfterMs/sleep | types, provider |
| `tool-executor.ts` | ~250 | runTools/isParallelSafe/runToolBatch/runToolSafe/runTool/truncate/errResult | tools/tool, permission, hooks, chan |
| `steering.ts` | ~120 | queue/clearQueue/deliverTaskNotice + 三方向状态 | （无 core 内依赖） |
| `agent.ts`（改写） | ~350 | 只留 R1 + 构造装配 | 上述全部 |

`index.ts` 导出面：默认**不新增导出**（协作对象是内部实现细节）。若后续想让 SDK 用户自定义 `ContextProvider`，再单独导出——本次不做（YAGNI）。

---

## 4. 必须原样保住的不变量（重构红线）

这些是 `Agent` 里靠注释维系、极易在搬迁中被「顺手改好看」而破坏的点。每一条都在 §6 有对应测试兜底。

- **A. tool_result 排序**：图片必须排在本轮**全部** tool_result 之后（Anthropic 硬要求）。`runTools` 用 `imageSlots` 按调用顺序落位（1244–1280）。→ `agent.image.test.ts` 的排序不变量。
- **B. 并发资格判定时机**：分组发生在执行前；只要 PreToolUse 或 ask-confirm 可能改写入参，就 `parallelInputsStable=false` 保守串行（agent.ts:524）。搬进 `ToolExecutor` 后此标志由构造参数传入，判定逻辑不变。
- **C. system 一次成型 + 字节稳定**：`ensureMemory` 只跑一次，此后 system 不再变（prompt cache 命中的前提）。provider 顺序必须与现状逐字节一致。→ `agent.features.test.ts`（env/repoMap/memory 注入）。
- **D. compaction 用原始旧历史做摘要**：`maybeCompact` 里 `older = original.slice(0, cutoff)` 用未折叠版，`recent` 用折叠版（context.ts:272）。这条在 context.ts 内，本次不动它，只保证 `Conversation` 传进去的仍是同一份数组语义。→ `context.test.ts`。
- **E. 历史自愈引用相等语义**：`repairHistory` 无需修复时**返回原数组引用**，调用方据此判断是否发生修复（agent.ts:228 注释）。`Conversation.repair()` 返回 boolean 保留该语义。
- **F. confirm 改写 input 的二次校验**：`allow + updatedInput` 必须重新过 `validateUpdatedInput`（deny/ask 不可绕过），且校验用 updated 的 ruleKey/ruleParts（agent.ts:1367–1380）。逐行搬进 `ToolExecutor`。
- **G. PostToolUse 对成功和失败都执行**；失败工具的图片丢弃（agent.ts:1428、1450）。
- **H. deferred 工具直呼自动激活**（agent.ts:1316）。
- **I. SkillsProvider 的副作用顺序**：discoverSkills 后要 `tools.register(skillTool)` **且** `perm.addReadOnlyTools([name])` **且** push 清单，三者缺一不可（agent.ts:1549–1552）。`SkillsProvider.contribute` 需能拿到 `tools` 与 `perm` 引用——因此 provider 的 `ctx` 参数要带上它们（见 §2.2 接口的 `tools`，perm 同理补入）。这是 ContextProvider 抽象里唯一「有副作用」的 provider，需在接口注释里显式说明。
- **J. steering 窗口时序**：`clearQueue` 先关窗再清队列（interrupt 后到达的消息必须进下一 drive，agent.ts:812–819）；Stop hook await 期间再查一次 steering（950–957）；send finally 的 leftover 通知转空闲投递（793–796）。全部搬进 `SteeringInbox` 并配时序单测。
- **K. 中断闸门**：provider 可能忽略 signal 仍返回工具调用；`Agent` 是最后一道闸——`signal.aborted` 时绝不 push 进 history、绝不执行工具（agent.ts:904、984）。此闸留在 `Agent.drive`（编排层职责）。
- **L. lastInputTokens 口径**：`realInput = input + cacheRead + cacheWrite`（agent.ts:917），驱动 compaction 触发。搬进 `Conversation.noteRealInput`。

---

## 5. 分步迁移计划（每步一个 PR，独立可合、测试全绿）

顺序按「风险从低到高、依赖从底到顶」。每步结束跑：`npm run typecheck && npm run lint && npm test`（core 400+ / 全仓 500+ 离线测试）。

| PR | 内容 | 风险 | 依据测试 |
|----|------|------|----------|
| **PR-0** | 落地本设计文档（本文件），无代码改动 | 无 | — |
| **PR-1** | 抽 `Conversation`（R7 历史+持久化+记账+repair+rewind+cost）。`Agent` 内 `this.history` 全部改走 `this.conv`。compaction 纯函数仍在 context.ts。 | 低（纯搬迁，接口窄） | checkpoint/snapshot/retry/features 全套 |
| **PR-2** | 抽 `ToolExecutor`（R3）。`Agent.runTools*` → `this.executor.run()`。`supportsImages` 用 getter 注入。 | 中（微妙分支多，§4-F/G/H） | tools-wiring / image / parallel-subagent / permission |
| **PR-3** | 抽 `TurnRunner`（R2）。active-model 状态迁入；`Agent.send` 只调 setActiveModel/reset。 | 中（per-prompt override + fallback 时序） | retry / fallback / per-prompt-model / small-model |
| **PR-4** | 抽 `ContextAssembler` + providers（R4）。`ensureMemory` → `assembler.assemble()`。SkillsProvider 副作用按 §4-I 处理。 | 中（system 字节稳定，§4-C/I） | features（env/repoMap/memory）/ skills |
| **PR-5** | 抽 `SteeringInbox`（R6）。5 个字段收进对象，drive 调用点改问 inbox。 | 中高（竞态时序，§4-J） | background-task / subagent.background / hooks-lifecycle |
| **PR-6** | `Agent` 收尾瘦身：删除已搬空的私有方法，`drive()` 只剩编排骨架；补协作对象各自的独立单测（这是重构的净收益兑现）。 | 低 | 全套 + 新增单测 |

**回滚粒度**：任一 PR 若在真实模型上暴露行为漂移，单独 revert 该 PR 即可，不影响其余（因为每步都保持外部契约不变）。

**验证增量**：PR-1..5 只搬迁不改行为，理论上测试断言零改动即应通过；若某断言需改，说明触碰了白盒内部结构（见 §6），需在 PR 描述里显式列出并解释为何等价。

---

## 6. 测试影响面

现有 107 个测试文件里，**绝大多数是黑盒**（构造 `Agent` → `send` → 断言事件流），对本次重构透明。需要留意的白盒/半白盒：

- 直接 import 模块级函数的：`retryAfterMs`（agent.ts export，`agent.retry.test.ts` 用）→ PR-3 后从 `turn-runner.ts` re-export 或保持 agent.ts re-export，**保证 import 路径不破**。
- `repairHistory`（agent.ts export）→ PR-1 后 `Conversation` 内部用，但 agent.ts 继续 `export { repairHistory }`（薄转发），避免改测试 import。
- context.ts 的 `maybeCompact/microcompact/findSafeCutoff/estimateTokens/compactionPending` → **完全不动**，`context.test.ts` 不受影响。

**净新增测试**（PR-6，兑现重构价值）：
- `steering.test.ts`：窗口开关时序、三方向通知投递、clearQueue 关窗竞态。
- `tool-executor.test.ts`：并行批分组、confirm 改写二次校验、图片成功才附带。
- `context-assembler.test.ts`：provider 顺序、单 provider 失败不影响其余、SkillsProvider 副作用。
- `turn-runner.test.ts`：fallback 队列消耗、Retry-After 优先级、小模型回退主模型。

这些是今天**无法在不驱动整个 Agent 的情况下测到**的路径——重构后它们变成廉价的单元测试。

---

## 7. 借鉴对照（Codex / Claude Code → anicode v2）

| 他山之石 | anicode v2 对应 |
|----------|-----------------|
| Codex-rs 把 `Session`/turn 循环与 model client、tool router、history 分离 | `Agent`(loop) / `TurnRunner`(model) / `ToolExecutor`(router) / `Conversation`(history) |
| Codex 的 context items 有序拼装 | `ContextProvider[]` 有序管线 |
| Claude Code 的 microcompaction「先卸载旧工具输出再摘要」 | **已实现**（context.ts:microcompact），v2 只是把调用点收进 `Conversation` |
| Claude Code 的 steering / turn-boundary 注入 | **已实现**，v2 把隐式状态机显式成 `SteeringInbox` |
| Claude Code 小模型跑杂活 | **已实现**（smallModel），v2 收进 `TurnRunner.streamText` |

结论：v2 **不是追功能**（功能已对齐），而是**把已经正确的行为，重排成他们那样的模块边界**，让后续每一类演进都不再穿过神类。

---

## 8. 评审问题清单（给评审者）

1. 模块切分是否认同？特别是「`Conversation` 同时扛 R5+R7」——要不要把 compaction（R5）再单拆一个 `Compactor`？（倾向不拆：compaction 纯函数已在 context.ts，`Conversation` 只是调用方，再拆一层收益低。）
2. `SteeringInbox` 是否值得独立文件？（它无 core 内依赖、最难测，倾向独立。）
3. PR 顺序是否接受？是否要把 PR-1（Conversation）与 PR-2（ToolExecutor）合并以减少中间态？（倾向不合并：单独 revert 粒度更安全。）
4. 是否需要在 `index.ts` 导出 `ContextProvider` 以便 SDK 用户扩展？（倾向本次不导出，YAGNI。）

---

## 9. 实施记录（2026-07-26）

按 §5 的 PR-1..6 顺序落地完毕；`agent.ts` 1744 → 1105 行（其中约 270 行是保留的
`AgentOptions`/事件类型定义与默认系统提示词，类本体已如目标瘦成编排器）。评审问题
按倾向执行：不拆 `Compactor`、`SteeringInbox` 独立、PR 不合并、内部类型不进 `index.ts`
（`repairHistory`/`PersistenceConfig`/`retryAfterMs` 经 agent.ts re-export，既有 import 路径零破坏）。

**落地文件**：`conversation.ts`（R7+R5 历史侧）、`tool-executor.ts`（R3）、
`turn-runner.ts`（R2，active-model 状态迁入）、`context-assembler.ts`（R4，6 个
provider）、`steering.ts`（R6）。新增单测 4 份 21 个（steering 9 / assembler 4 /
turn-runner 4 / tool-executor 4），全仓 537 测试通过、lint 0、typecheck 干净。

**实时调研验证（GitHub 实取 codex-rs main + opencode dev 文件树）**：五个切面全部
有直接对应边界 —— Conversation ↔ codex `context_manager/history.rs` / opencode
`message-v2.ts`；TurnRunner ↔ codex `session/turn.rs` / opencode `processor.ts`+`retry.ts`；
ToolExecutor ↔ codex `tools/{router,registry,orchestrator,parallel}`；ContextAssembler ↔
codex `context/`（拆得更碎）；SteeringInbox ↔ codex `session/input_queue.rs`+`inject.rs`。
方向确认正确。

**调研发现的后续候选边界（本轮刻意不做，防范围蔓延）**：
1. **TurnContext**（codex `session/turn_context.rs`）：每轮不可变配置快照，隔离运行中
   改配置对进行中 turn 的污染。anicode 的 per-drive override 已由 TurnRunner 的
   active/base 分离覆盖大半，剩余价值在权限/cwd 的轮内快照。
2. **SessionTask 抽象**（codex `tasks/`）：turn 之上的可中断工作单元（普通对话/压缩/
   review 同一 trait）。anicode 的 compaction 目前内嵌 drive 循环 —— 若未来要做
   「压缩也可被打断/汇报进度」，再抬这层。
3. **ModelClient 再切一刀**（codex `client.rs`；opencode `session/llm/`）：把「provider
   流客户端 + 传输层重试」从 TurnRunner 再分出去。当前 TurnRunner 250 行内含两层，
   规模尚不构成痛点。
4. 权限判定独立于工具分发（codex `approvals.rs`+`safety.rs`）：anicode 的
   PermissionEngine 本就是独立模块，ToolExecutor 仅是调用方 —— 已满足。
