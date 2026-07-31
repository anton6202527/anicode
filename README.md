# anicode

[Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[Production operations](docs/operations/production-readiness.md) · [MIT license](LICENSE)

一个 TypeScript 编写、前端无关的通用型 AI Agent：调研、分析、写作、规划、数据与工具协作都是一等能力，软件工程是重点强化的核心长项。当前仓库包含：

```text
packages/
  core/     Provider、Agent loop、工具、权限、会话与 daemon
  eval/     真实 agent loop 的可校验编辑任务与质量指标
  shared/   前端共享的纯逻辑：transcript 重建、Markdown 解析、行级 diff
  tui/      基于 Ink 的终端界面
  app/      基于 Electron 的桌面应用（ChatGPT 风格 UI + 插件市场）
  vscode/   VSCode 扩展（侧边栏对话，anicode-vscode）
```

三种前端（TUI / Electron / VSCode）都只依赖 core 的 `SessionHost` 契约；本地进程内、daemon socket、
Electron IPC、VSCode webview postMessage 只是同一契约的不同「传输」实现，可互换。transcript / Markdown /
diff 等前端无关的纯逻辑集中在 `@anicode/shared`，三端共用、单独测试。

全仓类型检查与离线测试由 CI 在 Node 22/24、Linux、macOS、Windows 和 PostgreSQL 16
矩阵中执行。默认测试不需要真实 API key；280 个真实仓库任务的 catalog/runner 契约离线验证，
真实模型回归只允许使用已审核、已提交的基线，缺少运行环境或基线会明确失败。

## 先本地调试 TUI

最短路径：

```bash
npm install
npm run dev:tui
```

启动时会自动读取项目根目录的 `.env.local` / `.env`，并使用 `anicode.json` 或
`.anicode/anicode.json` 指定的默认模型；若没有可用云端凭证则回退到零网络的 `debug/demo`。

CLI 默认就是独立本地应用：`SessionManager` 与工具运行在同一进程，会话存在内置 SQLite，凭证存在本机 OS Keychain，不需要 AniCode 后端服务、PostgreSQL 或单独启动 daemon。`--daemon`、`--http`、PostgreSQL、Vault/KMS、S3 和 Remote Runtime 都是显式可选的团队/远程能力。使用云端模型时仍需对应 provider 的 API key 或官方支持的企业凭证；这不是 AniCode 自身的后端依赖。

开发数据隔离到：

```text
.anicode-dev/
  sessions/       旧 JSONL 会话迁移源/备份
  runtime.db      SQLite WAL 会话与运行时事实主库
  tui.jsonl       调试日志
```

普通文本会收到流式 echo。下面四条指令可以覆盖真实工具链路：

```text
!todo       todo_write 与任务进度
!write      写入 .anicode-debug.txt，并触发权限确认
!bash       执行无害 printf，并触发权限确认
!parallel   并行执行 glob + read 两个只读工具
```

如需强制使用确定性的离线调试模型：

```bash
npm run dev:tui:demo
```

高安全联网模式先启动本地出口，再把 browser/联网命令绑定到它；provider 与 HTTP MCP 本身会直接复用同一策略代理：

```bash
# 终端 1
HOST=127.0.0.1 PORT=8787 ANICODE_NETWORK_ALLOW_DOMAINS=api.github.com,github.com \
  npm run network-proxy --workspace @anicode/core

# 终端 2
ANICODE_NETWORK_PROXY_URL=http://127.0.0.1:8787 npm run dev:tui
```

默认长期凭证后端是 OS Keychain；也可设置 `ANICODE_CREDENTIAL_BACKEND=vault|kms`，通过 OIDC/workload identity 读取后端中的 `env:NAME`。完整配置、Remote Runtime 与验收边界见[第三轮生产化归档](docs/architecture/2026-07-29-runtime-hardening-round-3.md)。

TUI 内可用命令：

```text
/help
/status
/usage                    # 输入/输出/cache create/cache read/成本
/providers
/model                    # 打开内置模型选择器（↑/↓ 选择 · Enter 新建 · Esc 取消）
/model <provider/model>   # 直接用目标模型新建会话，不热改旧会话
/sessions
/resume <sessionId>
/new [标题]
/undo                     # 撤销上一轮文件改动（对话不回滚）
/plan [on|off]            # 只读规划模式
/tool [id]                # 展开/收起完整工具输出（Ctrl+O）
/editor                   # 用 $EDITOR 编辑多行提示词（Ctrl+G）
/reconnect                # 重连远端事件流（Ctrl+R）
/lang <en|zh>             # 运行时切换中英文
/exit
```

运行中按 Enter 可追加 steering 指令，按 Esc 中断。Shift/Ctrl+Enter 插入换行；bracketed paste
保留多行且绝不自动提交。授权卡片固定在输入框上方，支持方向键/Enter、`y/a/p/n`，高风险默认选中拒绝，
永久授权需二次确认。默认不接管终端鼠标，搜索结果与回答可直接拖拽框选/复制；若需点击和滚轮导航，用 `--mouse` 启动或在 TUI 中执行 `/mouse on`，用 `/mouse off` 随时恢复原生框选。快捷键可在 `anicode.json` 的 `tui.keybindings` 中覆盖。

安装 workspace 后也可以直接检查 CLI：

```bash
npm exec -- anicode --version
npm exec -- anicode --list-providers
```

## 桌面应用（Electron）

`packages/app` 是一个向 ChatGPT app 看齐的桌面客户端：左侧会话列表 + 新对话、中间气泡式
对话与流式输出、底部输入框（Enter 发送 / Shift+Enter 换行）、可搜索的模型选择器、插件市场与设置页。

架构上主进程内跑 core 的 `SessionManager`，经 `contextBridge`（`window.anicode`）把 `SessionHost`
暴露给渲染进程——和 daemon 是同构的传输层。默认模型来自项目配置或已就绪的云端凭证，
没有可用凭证时回退到零网络的 `debug/demo`。

```bash
npm run dev:app      # 开发模式（electron-vite，热更新）
npm run build:app    # 打包 main/preload/renderer 到 packages/app/out
```

功能亮点：

- **对话与流式渲染**：气泡式界面，助手消息经内置轻量 Markdown 渲染（围栏代码块带复制按钮、
  行内代码 / 粗体 / 链接 / 列表 / 标题），且绝不注入原始 HTML（无 XSS）。
- **自动标题**：新会话发出首条消息后，用首句自动命名（离线、无需额外模型调用），事务写入会话数据库。
- **模型选择器**：复用内置免费 / 开源目录，主进程算好凭证就绪状态；可用的排前并标 ✔。
- **自定义模型**：设置页可为任意已有 provider 追加模型（持久化到 `userData/models.json`），
  立即出现在选择器里——回答了「模型是否只能写死在代码里」。
- **会话管理**：侧边栏悬停即可删除会话（删除当前会话会自动切到最近一个或新建）。

**插件市场 → 真实工具链**：插件统一抽象为可挂到 agent 的能力来源——内建工具（文件 / Bash / 任务清单）、
MCP 服务（Web 搜索 / GitHub / Playwright）、技能。开关会真正改变 agent 拿到的工具集：停用内建工具组会
从工具集移除对应工具；启用 MCP 且 Broker 凭证就绪时连接 server 并注入其工具（`<name>__<tool>`），stdio 插件进程由隔离运行时启动，联网插件强制复用策略代理，市场卡片显示连接
状态。改动对新建会话生效，状态持久化到 `userData/plugins.json`。

**打包分发**（electron-builder，主进程已把 core 与 SDK 依赖打进 bundle，产物自包含）：

```bash
npm run --workspace @anicode/app pack   # 快速产出未签名 .app（release/）
npm run --workspace @anicode/app dist   # 产出安装包（dmg / nsis / AppImage）
```

## VSCode 扩展

`packages/vscode`（`anicode-vscode`）把 agent 放进 VSCode 侧边栏，形态对齐 Claude 的编辑器扩展，
功能对齐 TUI 主线：流式对话、工具调用、任务清单、内联授权（允许 / 允许并记住 / 拒绝）、Markdown 渲染。
扩展主机进程内跑 core 的 `SessionManager`，webview 经 postMessage 通信——同一 `SessionHost` 契约的又一种传输。

VSCode 味的取舍：模型选择与会话恢复/删除走**原生 QuickPick**（恢复列表带 🗑 删除按钮），**工作区目录即
agent 的 cwd**，状态栏显示当前模型，首条消息后自动命名会话。开箱即用 `debug/demo`（零网络）。

**文件改动 diff 预览**：agent 用 `write` / `edit` 改文件后，主机从会话消息里取工具参数算出行级 diff，
在对话内以红绿行内联展示（带 +/- 统计与「打开文件」按钮，点开即在编辑器里查看）。

```bash
npm run build:vscode                       # esbuild 打包 out/extension.js 与 out/webview.js
npm run package --workspace anicode-vscode  # 产出可安装的 anicode.vsix
```

Tree-sitter 与 OS Keychain 含原生 N-API 模块，本地 `.vsix` 对应当前 OS/CPU；Release workflow 会分别产出 Linux x64/arm64、macOS arm64/x64 与 Windows x64 安装包。

在 VSCode 里以该目录为「扩展开发宿主」按 F5 即可调试。

## Provider 与模型

anicode 现在使用数据驱动 registry，模型字符串格式为 `provider/model`。首个 `/` 后面的内容会完整保留，因此 OpenRouter 这类带组织前缀的模型 id 可以直接使用。

内置 canonical provider：

| Provider     | 协议/用途                     | 凭证或端点变量                                          |
| ------------ | ----------------------------- | ------------------------------------------------------- |
| `anthropic`  | Anthropic Messages            | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`               |
| `openai`     | OpenAI Chat Completions       | `OPENAI_API_KEY`, `OPENAI_BASE_URL`                     |
| `openrouter` | OpenAI-compatible             | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`             |
| `deepseek`   | OpenAI-compatible             | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`                 |
| `gemini`     | Gemini OpenAI compatibility   | `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`, `GEMINI_BASE_URL` |
| `xai`        | OpenAI-compatible             | `XAI_API_KEY`, `XAI_BASE_URL`                           |
| `groq`       | OpenAI-compatible             | `GROQ_API_KEY`, `GROQ_BASE_URL`                         |
| `mistral`    | OpenAI-compatible             | `MISTRAL_API_KEY`, `MISTRAL_BASE_URL`                   |
| `together`   | OpenAI-compatible             | `TOGETHER_API_KEY`, `TOGETHER_BASE_URL`                 |
| `fireworks`  | OpenAI-compatible             | `FIREWORKS_API_KEY`, `FIREWORKS_BASE_URL`               |
| `cerebras`   | OpenAI-compatible             | `CEREBRAS_API_KEY`, `CEREBRAS_BASE_URL`                 |
| `ollama`     | 本地 OpenAI compatibility     | `OLLAMA_BASE_URL`，默认 `127.0.0.1:11434/v1`            |
| `lmstudio`   | 本地 OpenAI compatibility     | `LMSTUDIO_BASE_URL`，默认 `127.0.0.1:1234/v1`           |
| `vllm`       | 本地 OpenAI compatibility     | `VLLM_BASE_URL`，默认 `127.0.0.1:8000/v1`               |
| `llamacpp`   | 本地 OpenAI compatibility     | `LLAMACPP_BASE_URL`，默认 `127.0.0.1:8080/v1`           |
| `custom`     | 自定义 OpenAI-compatible 服务 | `CUSTOM_OPENAI_BASE_URL`, `CUSTOM_OPENAI_API_KEY`       |
| `debug`      | 零网络调试                    | 无                                                      |

别名包括 `demo`、`lm-studio`、`llama.cpp`。

### 内置免费 / 开源模型（供调试）

registry 自带一份可直接选用的模型目录，重点收录**免费额度或本地推理的开放权重模型**，
方便零成本调试 agent loop。在 TUI 里输入 `/model`（不带参数）即弹出选择器：可用（本地/免 key/已配置凭证）的排在前面并标 `✔`，缺凭证的标 `✖` 并提示需要设置的环境变量。

- **零网络**：`debug/demo` —— 永远可用，离线流式 echo，支持 `!todo/!write/!bash/!parallel` 驱动真实工具链路。
- **免费云端额度**：Google AI 免费层（Gemini 3.5 Flash、3.1 Flash-Lite、2.5 Flash-Lite）、OpenRouter `:free` 变体（DeepSeek R1、Llama 3.3 70B、Qwen2.5 72B、Gemma 2、Mistral 7B）、Groq（Llama 3.3 70B / 3.1 8B、DeepSeek R1 Distill、Gemma 2）、Cerebras（Llama 3.3 70B / 3.1 8B）。
- **本地推理**：Ollama（`qwen2.5-coder`、`llama3.2`、`deepseek-r1`，需先 `ollama pull`）。
- **开放权重直连**：DeepSeek 官方（`deepseek-v4-flash` / `deepseek-v4-pro`，API 按量计费，赠送余额优先抵扣）。

命令行查看完整目录：

```bash
npm run start --workspace @anicode/tui -- --list-models
```

查看本机可用配置：

```bash
npm run start --workspace @anicode/tui -- --list-providers
```

真实模型示例：

```bash
# Anthropic
export ANTHROPIC_API_KEY=...
npm run start --workspace @anicode/tui -- --model anthropic/<model-id>

# OpenRouter：model id 中的 slash 会保留
export OPENROUTER_API_KEY=...
npm run start --workspace @anicode/tui -- --model openrouter/anthropic/<model-id>

# Ollama
npm run start --workspace @anicode/tui -- --model ollama/qwen3

# 任意自建 OpenAI-compatible endpoint
export CUSTOM_OPENAI_BASE_URL=http://127.0.0.1:9000/v1
export CUSTOM_OPENAI_API_KEY=...
npm run start --workspace @anicode/tui -- --model custom/<model-id>
```

云端 provider 缺少自己的 key 时会在进入 TUI 前给出明确诊断。第三方兼容端点不会回退或继承 OpenAI SDK 的 API/admin key、组织、项目及环境自定义 header。

### 自定义兼容 Provider

上层配置或插件可以程序化注册：

```ts
import { registerOpenAICompatibleProvider } from "@anicode/core";

registerOpenAICompatibleProvider({
  id: "my-gateway",
  name: "My Gateway",
  baseURL: "https://gateway.example/v1",
  apiKeyEnv: "MY_GATEWAY_API_KEY",
  maxTokensField: "max_tokens",
  streamUsage: false,
  reasoningEffort: false,
  capabilities: { tools: true, reasoning: false },
});
```

不同兼容端点可以分别配置 `max_tokens` / `max_completion_tokens`、`stream_options`、`reasoning_effort`、headers、能力和上下文限制。Provider SDK 的内部重试默认关闭，统一由 Agent 层处理，避免一次失败被两层重试放大。

### 与 OpenCode 的范围差异

当前架构已经能接入原生 Anthropic、主流 OpenAI-compatible 云端和本地模型，并可继续注册自定义端点；但还不是 OpenCode 所使用的完整 AI SDK + Models.dev 生态。自动模型目录、动态能力发现、OpenAI Responses API，以及少数 provider 的专有协议仍属于后续阶段。参考：[OpenCode Providers](https://opencode.ai/docs/providers/)、[Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)、[OpenRouter API](https://openrouter.ai/docs/api/reference/overview)。

## Core 已具备的能力

- 统一内容块消息与流式事件协议，支持文本、thinking、图片、并行工具调用和 usage。
- Agent loop：工具执行、steering、重试、hooks、skills、subagents、todo 与中断。
- **工程化系统提示**：内置对齐 Claude Code/Codex 的行为准则——先探后改、工具路由（检索走 grep/glob、改文件走 edit、独立只读调用并行批处理）、代码规范（融入现有风格、最小改动、不擅自提交）、改完自验证、简洁收尾与安全边界。见 `agent.ts` 的 `DEFAULT_SYSTEM`。
- **环境接地**：会话开始时快照 `<env>`（cwd/平台/系统/日期/是否 git 仓库/当前分支）+ `<git-status>`（工作区改动与最近提交）注入 system，缓存友好，让模型不再盲飞。见 `env.ts`。
- 模型能力驱动请求：按 profile 控制 tools、reasoning、输出上限和 compaction 阈值；未知兼容模型不会被强塞 16k 输出参数。
- 子 agent 的 `provider/model` override 会重新解析 provider，不再错误复用父 provider。
- 默认工具：`read / write / edit / apply_patch / glob / grep / bash / bash_output / kill_shell / webfetch / todo_write / task / skill`；配置 LSP 后追加 `diagnostics`。
- **多 agent 编排**（对齐 Claude Code 的 Agent/SendMessage/TaskOutput/TaskStop 收敛形态）：
  - `task` 委派子任务（内置 `general`/`explore` + 文件/配置自定义类型）；只读型可并行 fan-out；`orchestrator` 型可嵌套下派（深度硬顶）。
  - `task(background=true)` 后台运行：立即返回任务 id，父 agent 继续干活；完成时 `<task-notification>` 在 turn 边界注入（运行中）或由 SessionManager 自动发起一次 drive（空闲时）——主 agent 不用轮询。
  - `task_send` 给既有子 agent 发后续消息（上下文完整保留，追问/迭代）；`task_output` 查状态/活动/结论；`task_stop` 终止。
  - `task(isolation="worktree")` 在 detached git worktree 副本中运行：多个写任务并行互不冲突；无改动自动清理，有改动保留路径由父 agent 合并。
  - 硬性上限（防失控）：嵌套深度、单会话 spawn 总量、后台并发；子 agent 结论过滤通知信封标记（防伪装宿主控制信息）。agent 间 peer 通信刻意不做（对齐 opencode not-planned / Claude Code 实验 flag 的取舍）。
- **后台长时命令**：`bash(run_in_background)` 立即返回 shell id 不阻塞，`bash_output` 增量读取新输出（可选正则 filter），`kill_shell` 停止 —— dev server / watch 构建 / 日志跟随不再被 120s 超时打死。增量读取（读过即清）、有界缓冲、自动回收、宿主退出收尸，且**不主动往上下文塞提醒**，规避 Claude Code 后台任务刷爆上下文的已知坑。后台与前台共用同一套 OS 沙箱，绝非绕过通道。见 `tools/shells.ts`。
- **多模态 read**：`read` 可读图片（png/jpg/gif/webp），模型支持视觉时经 `ctx.attachImage` 把图片本体附在本轮 tool_result 之后送入同一条 user 消息；不支持视觉/超 3.7MB 时如实降级为文本说明。两端 provider 映射（Anthropic `image` 块 / OpenAI `image_url`）已实测通过，无需改 provider。见 `tools/fs.ts`、`tools/tool.ts` 的 `ToolContext.attachImage`。
- **类型化 repo map**：Tree-sitter/ast-grep 覆盖 JS/TS/Python/Go/Rust/Java，可选 LSP enrich，维护增量 symbol/reference graph，并以 lexical + graph + SQLite/pgvector 混合检索减少盲目定位。
- **事务化 PatchSet**：`write` / `edit` / `apply_patch` 统一走预览、base hash 冲突检测、审批、原子 journal、崩溃恢复与回滚；支持 rename、binary 和三方 merge。
- **ripgrep 后端检索**：检测到 `rg` 时 grep/glob 走 ripgrep（尊重 .gitignore、跳过二进制、按 mtime 排序），无 rg 自动回退纯 JS。grep 支持 `output_mode`（content/files_with_matches/count）、`ignore_case`、`context` 前后行、`path`/`glob` 限定。
- **read 加固**：NUL 字节识别二进制（不返回乱码）、超长单行截断（防炸上下文）。
- **重试尊重 `Retry-After`**：429/503 带该头时按服务端节流等待（与指数退避取较大值，封顶 60s）。
- 权限模式：`default / acceptEdits / auto / bypass / plan`，支持 allow/ask/deny glob 规则和运行时记忆；`plan` 只放行只读工具。
- 每轮可创建 git 工作区快照，TUI 用 `/undo` 恢复文件；macOS Seatbelt 与 Linux bubblewrap 可为 Bash 提供 OS 级沙箱。
- 项目记忆：向上发现 `AGENTS.md` / `CLAUDE.md`，止于 `.git` 边界。
- 两级 compaction：先清理旧工具输出，再在安全边界生成摘要，保持 tool call/result 配对。
- SQLite WAL 会话持久化、resume、最近活跃排序、悬空工具调用自愈；旧 JSONL 首次访问时幂等迁移，数据库较新时不回灌。
- `SessionHost` 抽象与 daemon pub/sub：本地 TUI 和远程客户端使用同一接口，多客户端可观察、接管和裁决权限。
- MCP：stdio（规范的换行分隔 JSON-RPC）+ Streamable HTTP 客户端；HTTP 强制受控出口，敏感 header/env 只能由 Credential Broker 短租约注入；stdio 可由同一 OS 隔离运行时启动。`anicode mcp` 也可把自身暴露为 MCP server。
- Notification hook（turn_done / permission_request）+ TUI 授权响铃：配合 anicode.json 命令 hook 可外接桌面通知（对齐 Codex notify）。
- 插件目录：`~/.anicode/plugins/<name>/` 与项目 `.anicode/plugins/<name>/` 下的 agents/skills/commands 子目录自动并入发现器（Claude Code plugins 的精简形态）。
- TUI：`/diff`（工作区改动）、`/review`（uncommitted/branch/commit/自定义 四模式审查）、`/tasks`（后台任务一览）、`/status` 显示上下文占用（tokens/窗口/百分比）。

## TUI 参数

```text
--demo
--model <provider/model>
--cwd <dir>
--sessions <dir>
--resume <sessionId>
--auto
--accept-edits
--daemon [socket]
--debug-log [file]
--trace-content
--plain
--no-color
--mouse
--no-mouse
--no-alt-screen
--list-providers
--help
--version
```

无头/CI 用法（默认 JSONL；默认拒绝需要交互的权限）：

```bash
anicode exec --demo --prompt "summarize this repository"
anicode exec --model openai/<model> --auto --jsonl --prompt "run tests and fix failures"
printf 'review the current diff' | anicode exec --text
```

`NO_COLOR`、`INK_SCREEN_READER=true` 与非备用屏模式均受支持。交互命令在 stdin/stdout 不是 TTY 时会明确失败，
避免把 ANSI 控制序列写入管道；管道/CI 应使用 `anicode exec`。

参数解析是严格的：未知参数、缺值、重复和互斥组合会直接报错。`--sessions` 与权限模式属于本地进程，daemon 客户端不能覆盖 daemon 的配置。

`--debug-log` 写权限为 `0600` 的 JSONL 文件，不向 stdout 输出日志以免破坏 Ink。默认只记录事件类型、耗时和内容长度，不记录 prompt、工具参数、错误原文或输出；只有显式传 `--trace-content` 才记录内容，凭证样式仍会脱敏。

## Daemon

```bash
# 终端 1
npm run daemon --workspace @anicode/core -- --accept-edits

# 终端 2
npm run start --workspace @anicode/tui -- --daemon --model openai/<model-id>

# 恢复共享会话
npm run start --workspace @anicode/tui -- --daemon --resume <sessionId>
```

权限请求和裁决会广播给所有观察者；一个客户端处理后，其他 TUI 会同步清除提示。`open` 会先交付 snapshot，再按序回放响应飞行期间的事件。长 snapshot 会按受限 NDJSON 帧传输；非法/过大的客户端帧只关闭对应连接，不会击穿 daemon。

## 验证

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build:cli
npm run build:app
npm run build:vscode
```

测试覆盖 provider 映射和本地 SSE/HTTP header fixture、工具调用、重试（含 `Retry-After`
解析）、权限与 Plan 模式、hooks、skills、并行只读子代理、compaction、类型化代码图、PatchSet、
SQLite/PostgreSQL 契约、fencing/worker、Remote Runtime、GitHub delivery、OpenTelemetry、
macOS/Linux 沙箱、后台 shell、多模态 read、会话竞态、daemon 多客户端、OpenAPI/SDK，以及三端
UI 交互。本地未配置 PostgreSQL URL 时，相关集成用例会明确跳过。

`@anicode/eval` 还提供带自校验的真实编辑任务，可汇总通过率、轮数、token 与编辑失败率：

```bash
npm run eval --workspace @anicode/eval -- --model <provider/model>
npm run eval --workspace @anicode/eval -- --model <provider/model> --json out.json
```

## 采各家之所长（对标 Claude Code / Codex / opencode / Aider·Cline 的增强）

- **小模型路由（Claude Code）**：摘要压缩等杂活自动走便宜快速模型（`SessionManagerOptions.smallModel: true` 按 provider 推导，如 anthropic→haiku、groq→llama-3.1-8b），解析失败静默回退主模型。省这类调用 70–80% 成本。见 `provider/registry.ts` 的 `defaultSmallModel`、`agent.ts` 的 `streamText`。
- **编辑自愈 + 反射（Aider/Cline）**：`edit` 精确匹配失败时退到「按行去空白」的模糊匹配；全都匹配不上则抛出附「文件中最接近片段」的反射式错误，让模型据此自我纠正（Aider 经验：关掉自愈编辑错误率数倍上升）。见 `tools/fs.ts` 的 `applyEdit`。
- **跨平台 OS 沙箱（Codex/Claude Code）**：bash 可选用 macOS Seatbelt 或 Linux bubblewrap 包裹——只放行「工作区 + 临时目录」写入，可禁网，并把 `.git` 收紧为只读。见 `tools/sandbox.ts`。
- **通用任务路由 + 工程能力强化（Claude Code/Codex）**：默认 system 先识别调研、写作、分析、规划或工程任务，不因运行在仓库里就假定用户要改代码；真正进入软件工程时，再强制「先探后改、最小改动、改完自验证」。见 `agent.ts`、`env.ts`。
- **ripgrep 检索后端（Claude Code）**：grep/glob 优先走 ripgrep（尊重 .gitignore、跳过二进制、mtime 排序），支持输出模式/上下文行/大小写；无 rg 回退 JS。检索更快、结果更规整。见 `tools/ripgrep.ts`、`tools/fs.ts`。
- **后台长时命令（Claude Code 的 run_in_background/BashOutput/KillShell）**：dev server / watch 构建 / 日志跟随不再被 120s 超时打死。并**针对性规避该功能的已知坑**：读取严格增量（读过即清，不会同一段日志反复进上下文）、缓冲有界、结束即回收、上限满时淘汰已结束者（不会假装"kill 一下就能腾位"）、filter 略过的行数如实回报（不静默吞掉 dev server 打印的端口号），且**从不主动往历史塞后台提醒**。后台与前台共用同一套沙箱。见 `tools/shells.ts`。
- **多模态 read（Claude Code）**：`read` 可直接看截图/设计稿/图表。工具经 `ctx.attachImage` 回传图片（沿用既有 emit/addUsage 回调范式，`run()` 仍返回纯文本，既有工具零改动），Agent 把图片排在本轮 tool_result 之后送入同一条 user 消息 —— 两端 provider 的映射本就支持独立 image 块，**实测无需改 provider**。魔数校验防「后缀是图但内容不是」拖垮整轮请求；无视觉能力或超限则如实降级为文本。见 `tools/fs.ts`、`tools/tool.ts`。

## 生产 Runtime 与后续验收

“建议实施路线”的仓库内能力已经完成收口：Durable Runtime、command inbox/outbox、snapshot/crash recovery、PatchSet、Context Engine 2、OpenAPI codegen、ACP conformance、持久 worker、Remote Runtime、GitHub/CI、Credential Broker、受控网络出口、Artifacts、OpenTelemetry 与 280-task real-repo catalog 均已进入代码、测试或交付清单。详细的不变量、配置和实施映射见 [Production Agent Runtime closure](docs/architecture/2026-07-30-production-runtime-closure.md)。

剩余事项属于真实基础设施验收，不能由本地单测代替：

1. 在目标 Kubernetes CNI 上执行 `deploy/remote-runtime/verify-isolation.sh`，验证 IPv4/IPv6、DNS、metadata、私网与未认证代理访问都无法绕过出口。
2. 对生产 PostgreSQL 做 kill、网络分区、主备切换、备份恢复和 migration 演练，验证 fencing token 在故障下仍阻止 stale worker 提交。
3. 使用组织 Vault/KMS/OIDC 演练轮换与撤销，并审计 prompt、event、Artifact、PatchSet、日志、trace 和子进程环境无明文密钥。
4. 在真实 GitHub App、branch protection、merge queue 与 ARC runner 集群上跑 analysis/repair/merge-group 闭环，并验证短生命周期身份和工作区销毁。
5. 替换部署中的 image digest placeholder，验证 SBOM、provenance、attestation、admission policy，并跑满 200–300 个真实 repo task 建立 SLO/成本基线。

此后的结构演进主要是企业 SSO/RBAC、审计留存与地域策略、预算/配额、插件签名/兼容矩阵、A2A gateway 和跨区域调度；Landlock 等可作为 Linux 纵深防御继续增强。
