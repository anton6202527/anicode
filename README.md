# anicode

一个 TypeScript 编写、前端无关的 AI coding agent。当前仓库包含：

```text
packages/
  core/     Provider、Agent loop、工具、权限、会话与 daemon
  shared/   前端共享的纯逻辑：transcript 重建、Markdown 解析、行级 diff
  tui/      基于 Ink 的终端界面
  app/      基于 Electron 的桌面应用（ChatGPT 风格 UI + 插件市场）
  vscode/   VSCode 扩展（侧边栏对话，anicode-vscode）
```

三种前端（TUI / Electron / VSCode）都只依赖 core 的 `SessionHost` 契约；本地进程内、daemon socket、
Electron IPC、VSCode webview postMessage 只是同一契约的不同「传输」实现，可互换。transcript / Markdown /
diff 等前端无关的纯逻辑集中在 `@anicode/shared`，三端共用、单独测试。

当前全仓类型检查通过，离线测试 **core 166 + shared 6 + TUI 32 + app 16 + vscode 8，共 228 个**。测试不需要真实 API key。

## 先本地调试 TUI

最短路径：

```bash
npm install
npm run dev:tui
```

这个命令使用正式的 `debug/demo` provider，不访问网络、不需要 API key，并把开发数据隔离到：

```text
.anicode-dev/
  sessions/       调试会话
  tui.jsonl       调试日志
```

普通文本会收到流式 echo。下面四条指令可以覆盖真实工具链路：

```text
!todo       todo_write 与任务进度
!write      写入 .anicode-debug.txt，并触发权限确认
!bash       执行无害 printf，并触发权限确认
!parallel   并行执行 glob + read 两个只读工具
```

TUI 内可用命令：

```text
/help
/status
/providers
/model                    # 打开内置模型选择器（↑/↓ 选择 · Enter 新建 · Esc 取消）
/model <provider/model>   # 直接用目标模型新建会话，不热改旧会话
/sessions
/resume <sessionId>
/new [标题]
/exit
```

运行中按 Enter 可追加 steering 指令，按 Esc 中断。授权提示支持 `y` 允许、`a` 允许并记住、`n` 拒绝。

安装 workspace 后也可以直接检查 CLI：

```bash
npm exec -- anicode --version
npm exec -- anicode --list-providers
```

## 桌面应用（Electron）

`packages/app` 是一个向 ChatGPT app 看齐的桌面客户端：左侧会话列表 + 新对话、中间气泡式
对话与流式输出、底部输入框（Enter 发送 / Shift+Enter 换行）、可搜索的模型选择器、插件市场与设置页。

架构上主进程内跑 core 的 `SessionManager`，经 `contextBridge`（`window.anicode`）把 `SessionHost`
暴露给渲染进程——和 daemon 是同构的传输层。开箱即用默认零网络的 `debug/demo` 模型。

```bash
npm run dev:app      # 开发模式（electron-vite，热更新）
npm run build:app    # 打包 main/preload/renderer 到 packages/app/out
```

功能亮点：

- **对话与流式渲染**：气泡式界面，助手消息经内置轻量 Markdown 渲染（围栏代码块带复制按钮、
  行内代码 / 粗体 / 链接 / 列表 / 标题），且绝不注入原始 HTML（无 XSS）。
- **自动标题**：新会话发出首条消息后，用首句自动命名（离线、无需额外模型调用），持久化到会话文件。
- **模型选择器**：复用内置免费 / 开源目录，主进程算好凭证就绪状态；可用的排前并标 ✔。
- **自定义模型**：设置页可为任意已有 provider 追加模型（持久化到 `userData/models.json`），
  立即出现在选择器里——回答了「模型是否只能写死在代码里」。
- **会话管理**：侧边栏悬停即可删除会话（删除当前会话会自动切到最近一个或新建）。

**插件市场 → 真实工具链**：插件统一抽象为可挂到 agent 的能力来源——内建工具（文件 / Bash / 任务清单）、
MCP 服务（Web 搜索 / GitHub / Playwright）、技能。开关会真正改变 agent 拿到的工具集：停用内建工具组会
从工具集移除对应工具；启用 MCP 且凭证就绪时连接 server 并注入其工具（`<name>__<tool>`），市场卡片显示连接
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

在 VSCode 里以该目录为「扩展开发宿主」按 F5 即可调试。

## Provider 与模型

anicode 现在使用数据驱动 registry，模型字符串格式为 `provider/model`。首个 `/` 后面的内容会完整保留，因此 OpenRouter 这类带组织前缀的模型 id 可以直接使用。

内置 canonical provider：

| Provider | 协议/用途 | 凭证或端点变量 |
|---|---|---|
| `anthropic` | Anthropic Messages | `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` |
| `openai` | OpenAI Chat Completions | `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| `openrouter` | OpenAI-compatible | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` |
| `deepseek` | OpenAI-compatible | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL` |
| `gemini` | Gemini OpenAI compatibility | `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`, `GEMINI_BASE_URL` |
| `xai` | OpenAI-compatible | `XAI_API_KEY`, `XAI_BASE_URL` |
| `groq` | OpenAI-compatible | `GROQ_API_KEY`, `GROQ_BASE_URL` |
| `mistral` | OpenAI-compatible | `MISTRAL_API_KEY`, `MISTRAL_BASE_URL` |
| `together` | OpenAI-compatible | `TOGETHER_API_KEY`, `TOGETHER_BASE_URL` |
| `fireworks` | OpenAI-compatible | `FIREWORKS_API_KEY`, `FIREWORKS_BASE_URL` |
| `cerebras` | OpenAI-compatible | `CEREBRAS_API_KEY`, `CEREBRAS_BASE_URL` |
| `ollama` | 本地 OpenAI compatibility | `OLLAMA_BASE_URL`，默认 `127.0.0.1:11434/v1` |
| `lmstudio` | 本地 OpenAI compatibility | `LMSTUDIO_BASE_URL`，默认 `127.0.0.1:1234/v1` |
| `vllm` | 本地 OpenAI compatibility | `VLLM_BASE_URL`，默认 `127.0.0.1:8000/v1` |
| `llamacpp` | 本地 OpenAI compatibility | `LLAMACPP_BASE_URL`，默认 `127.0.0.1:8080/v1` |
| `custom` | 自定义 OpenAI-compatible 服务 | `CUSTOM_OPENAI_BASE_URL`, `CUSTOM_OPENAI_API_KEY` |
| `debug` | 零网络调试 | 无 |

别名包括 `demo`、`lm-studio`、`llama.cpp`。

### 内置免费 / 开源模型（供调试）

registry 自带一份可直接选用的模型目录，重点收录**免费额度或本地推理的开放权重模型**，
方便零成本调试 agent loop。在 TUI 里输入 `/model`（不带参数）即弹出选择器：可用（本地/免 key/已配置凭证）的排在前面并标 `✔`，缺凭证的标 `✖` 并提示需要设置的环境变量。

- **零网络**：`debug/demo` —— 永远可用，离线流式 echo，支持 `!todo/!write/!bash/!parallel` 驱动真实工具链路。
- **免费云端额度**：OpenRouter `:free` 变体（DeepSeek R1、Llama 3.3 70B、Qwen2.5 72B、Gemma 2、Mistral 7B）、Groq（Llama 3.3 70B / 3.1 8B、DeepSeek R1 Distill、Gemma 2）、Cerebras（Llama 3.3 70B / 3.1 8B）。
- **本地推理**：Ollama（`qwen2.5-coder`、`llama3.2`、`deepseek-r1`，需先 `ollama pull`）。
- **开放权重直连**：DeepSeek 官方（`deepseek-chat` / `deepseek-reasoner`）。

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
- 默认工具：`read / write / edit / glob / grep / bash / webfetch / todo_write / task / skill`。
- **ripgrep 后端检索**：检测到 `rg` 时 grep/glob 走 ripgrep（尊重 .gitignore、跳过二进制、按 mtime 排序），无 rg 自动回退纯 JS。grep 支持 `output_mode`（content/files_with_matches/count）、`ignore_case`、`context` 前后行、`path`/`glob` 限定。
- **read 加固**：NUL 字节识别二进制（不返回乱码）、超长单行截断（防炸上下文）。
- **重试尊重 `Retry-After`**：429/503 带该头时按服务端节流等待（与指数退避取较大值，封顶 60s）。
- 权限模式：`default / acceptEdits / auto / bypass`，支持 allow/ask/deny glob 规则和运行时记忆。
- 项目记忆：向上发现 `AGENTS.md` / `CLAUDE.md`，止于 `.git` 边界。
- 两级 compaction：先清理旧工具输出，再在安全边界生成摘要，保持 tool call/result 配对。
- JSONL 会话持久化、resume、最近活跃排序、悬空工具调用自愈。
- `SessionHost` 抽象与 daemon pub/sub：本地 TUI 和远程客户端使用同一接口，多客户端可观察、接管和裁决权限。
- 最小 MCP stdio 客户端。

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
--list-providers
--help
--version
```

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
npm run typecheck
npm test
```

当前覆盖 228 个离线测试，包括 provider 映射和真实本地 SSE/HTTP header fixture、工具调用、重试（含 `Retry-After` 解析）、权限、hooks、skills、subagents、compaction、沙箱路径检查、环境接地渲染、ripgrep/JS 双后端检索（grep 各输出模式、read 二进制/长行加固）、私有会话权限、会话竞态、daemon 多客户端与大快照，以及 Ink TUI 交互。

## 采各家之所长（对标 Claude Code / Codex / opencode / Aider·Cline 的增强）

- **小模型路由（Claude Code）**：摘要压缩等杂活自动走便宜快速模型（`SessionManagerOptions.smallModel: true` 按 provider 推导，如 anthropic→haiku、groq→llama-3.1-8b），解析失败静默回退主模型。省这类调用 70–80% 成本。见 `provider/registry.ts` 的 `defaultSmallModel`、`agent.ts` 的 `streamText`。
- **编辑自愈 + 反射（Aider/Cline）**：`edit` 精确匹配失败时退到「按行去空白」的模糊匹配；全都匹配不上则抛出附「文件中最接近片段」的反射式错误，让模型据此自我纠正（Aider 经验：关掉自愈编辑错误率数倍上升）。见 `tools/fs.ts` 的 `applyEdit`。
- **macOS 沙箱第一阶段（Codex/Claude Code）**：bash 可选用 Seatbelt `sandbox-exec` 包裹——只放行「工作区 + 临时目录」写入、默认断网，纵深防御 prompt 注入。opt-in：`AGENTX_BASH_SANDBOX=workspace-write`（或 `SessionManagerOptions.sandbox`）。非 macOS 自动裸跑。见 `tools/sandbox.ts`。已实测：越界写被拒、出网被拒、工作区内写正常。
- **工程化系统提示 + 环境接地（Claude Code/Codex）**：把「先探后改、工具路由、并行批处理、最小改动、改完自验证」写进默认系统提示，并在会话开始注入 `<env>` + `<git-status>` 快照。这是把通用模型行为收敛到「优秀 coding agent」的最大杠杆，且缓存友好。见 `agent.ts`、`env.ts`。
- **ripgrep 检索后端（Claude Code）**：grep/glob 优先走 ripgrep（尊重 .gitignore、跳过二进制、mtime 排序），支持输出模式/上下文行/大小写；无 rg 回退 JS。检索更快、结果更规整。见 `tools/ripgrep.ts`、`tools/fs.ts`。

## 安全边界与下一步

路径工具会阻止 `..` 和符号链接逃逸；shell 权限会保守解析复合命令；macOS 上可开启 Seatbelt 沙箱（见上）。后续：Linux bubblewrap/Landlock、以及「先沙箱后询问、撞墙才升级」的 Codex 双轴审批闭环。

后续优先级（据架构评审，均为需要动结构的较大项，故单独列出）：

1. **多模态 read**：工具结果目前只回文本；让 `read` 能返回图片内容块（截图/图表），配合已支持 image 的 provider，是多模态 agent 的关键缺口。
2. **结构化编辑**：引入 `multi_edit` 或 Codex 风格 `apply_patch`（一次原子多处改动 + 统一 diff 格式），减少多次 edit 往返。
3. OS 沙箱补齐 Linux（bubblewrap/Landlock）+ 双轴审批（sandbox-first, approve-on-failure）。
4. 工作区检查点（shadow-git undo）/ Plan 模式。
5. daemon 升级为 HTTP+SSE + OpenAPI 生成 SDK；结构化 headless 输出、延迟工具加载（ToolSearch）。
