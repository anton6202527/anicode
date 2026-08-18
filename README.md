# anicode

[Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) ·
[Production operations](docs/operations/production-readiness.md) · [MIT license](LICENSE)

最新的 Core/TUI 生产审查、已落地控制与外部验收边界见
[2026-07-31 production-readiness audit](docs/architecture/2026-07-31-core-tui-production-audit.md)。
免费 DeepSeek 网关、安装实例配额、成本熔断与上线步骤见
[2026-08-17 free DeepSeek device quota](docs/architecture/2026-08-17-free-deepseek-device-quota.md)。

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

全仓类型检查与离线测试由 CI 在最低支持版本 Node 22.15.0、发布用 Node 24 LTS，以及自动跟随官方
最新稳定版的 Node `current` 上执行；平台矩阵覆盖 Linux、macOS、Windows 和 PostgreSQL 16。
默认测试不需要真实 API key；280 个真实仓库任务的 catalog/runner 契约离线验证，
真实模型回归只允许使用已审核、已提交的基线，缺少运行环境或基线会明确失败。

## 先本地调试 TUI

最短路径：

```bash
nvm install
nvm use
npm install
npm run dev:tui
```

`dev:tui` 是源码仓库专用入口：它只从仓库根 `.env` 提取唯一的 `DEEPSEEK_API_KEY`，固定直连
`deepseek/deepseek-v4-flash`，并使用进程内凭证 Broker；不会恢复 AniCode Cloud 登录，也不会打开
OS Keychain。wrapper 本身不会导入 `.env` 的其它变量；已授信工作区仍保留原有项目环境加载规则，但固定
的 DeepSeek 模型与官方 endpoint 不会被它改写。`.env` 不会进入 Git 或构建产物，Workspace Trust 仍
照常控制项目配置、hooks、MCP 与工具权限。`dev:tui:demo` 完全不读取 `.env`，继续使用离线 demo 模型。

`.nvmrc` 固定 Node 24 LTS，保证日常开发和发布构建可复现。运行时与已发布 CLI 使用仅含最低门槛的
Node `>=22.15.0` 声明，不会因为新的 Node 主版本产生误报；CI 会持续验证最低版本、发布 LTS 和
`current` 最新稳定版。已经 EOL 的 Node 主版本不作为正式支持基线。日常开发与 CI 要求 npm
`>=10.9.2`，不设置未来主版本上限；为保证发布供应链可复现，release gate 仍固定 npm
`>=11.5.1 <12`。

启动时会先评估 Workspace Trust。已信任工作区会读取项目根目录的 `.env.local` / `.env` 和
`anicode.json` / `.anicode/anicode.json`；未信任工作区不加载项目环境或可执行配置，只保留模型与
TUI 偏好。项目或宿主环境中的密钥只进入当前进程 Credential Broker，随后从该进程环境移除；普通
启动不会把它们持久化到全局 Keychain，因此不同工作区不会通过自动迁移覆盖或复用彼此的 `.env`
凭据。普通 provider 诊断以及会话的 create/open/resume 只检查进程内元数据；其中“已配置”只表示存在
精确的懒加载引用，不代表后端值已经验证。CLI 会额外读取专用的 AniCode Cloud Keychain 条目来恢复
Supabase 登录：已登录时默认使用 `anicode-cloud/deepseek-v4-flash`，否则默认直连
`deepseek/deepseek-v4-flash`；缺少本地 DeepSeek 凭证会明确提示先运行 `anicode auth login`、配置自己的
Key，或显式使用 `--demo`。真正使用普通云端 provider 时，会在该会话首次实际 `send/stream` 才解析
精确凭据，失败则 fail closed，不会继续打开其他 fallback Keychain 条目。

CLI 默认就是独立本地应用：`SessionManager` 与工具运行在同一进程，会话存在内置 SQLite；当前环境
凭证只在进程内使用，明确导入的长期凭证才进入本机 OS Keychain。Supabase 登录的 refresh token 与随机
安装凭证使用独立 Keychain 命名空间；安装凭证只用于每日免费额度且退出登录后继续保留，共享 DeepSeek Key
始终只存在于服务端 gateway，不会下载到客户端。免费 Cloud 目录只公开 Flash，Pro 需要后续付费
entitlement 或用户自带 Key。CLI 的
SessionManager、工具和 SQLite 仍完全在本机运行，不需要 PostgreSQL 或单独启动 daemon。`--daemon`、
`--http`、PostgreSQL、Vault/KMS、S3 和 Remote Runtime 都是显式可选的团队/远程能力。

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

### 工作区信任与默认权限

首次打开、工作区目录被替换或项目执行配置发生变化时，AniCode 会进入 restricted mode。在交互式
`default` 入口中，这不是“只读模式”，也不会强制进入内部严格只读策略：内置
`read / glob / grep / write / edit / apply_patch / bash / todo_write` 以及后台 shell 生命周期工具
`bash_output / write_stdin / list_shells / kill_shell` 仍会提供给 Agent。每次写入、启动命令或向后台进程
写 stdin 都必须由用户明确授权；受限 `bash` 固定使用 workspace-write sandbox，且没有联网参数。

如果原因是 `inspection-failed`（例如 trust store、realpath 或执行面检查失败），AniCode 无法证明上述边界，
因此会进一步 fail closed 到严格只读安全边界：只保留 `read / glob / grep`，不提供写入或 shell。应先修复检查错误，
再重新评估工作区，而不是把检查失败当成普通的“尚未授信”。

restricted mode 仍会禁用项目环境与执行配置、MCP、hooks、skills、联网扩展，以及会话级
PatchSet prepare/apply/recovery 工作流；这里的内置 `apply_patch` 是受逐项权限控制的文件修改工具，
不是对会话级 PatchSet 工作流的绕过。`--auto`、`--accept-edits` 或运行时权限模式切换都不能扩大这条
未信任边界；非 `default` 的高权限请求会退回严格只读工具面。无头入口没有授权 UI，会对未决权限请求
fail closed。

```bash
npm run dev:trust:status                     # 仓库源码调试快捷命令
npm run dev:trust                            # 交互式逐字确认，不会由 dev:tui 自动执行
anicode trust status --cwd "$PWD"          # 查看真实路径、原因与执行来源；可加 --json
anicode trust grant --cwd "$PWD"           # 交互式逐字确认 canonical path
anicode trust revoke --cwd "$PWD"
```

Workspace Trust 只决定能否加载已审查的项目能力，本身不是 shell sandbox 或批准规则。受信任的本地交互
TUI 采用明确的宿主默认：以最高权限启动并自动批准；它仍服从显式 `deny` / `ask` 规则、权限引擎、
sandbox、网络策略与 workspace scope。`Shift+Tab` 可在普通、自动接受编辑与跳过授权之间轮换，不包含
用户可选的计划档。无头 `exec`、daemon/HTTP 或远端客户端以及未信任工作区继续保持保守默认值。

高安全联网模式先启动本地出口，再把 browser/联网命令绑定到它；provider 与 HTTP MCP 本身会直接复用同一策略代理：

```bash
# 终端 1
HOST=127.0.0.1 PORT=8787 ANICODE_NETWORK_ALLOW_DOMAINS=api.github.com,github.com \
  npm run network-proxy --workspace @anicode/core

# 终端 2
ANICODE_NETWORK_PROXY_URL=http://127.0.0.1:8787 npm run dev:tui
```

受信任工作区配置 `TAVILY_API_KEY` 或 `BRAVE_SEARCH_API_KEY` 后，生产会话会按 Tavily、Brave
的顺序选择首个已配置引用并注册 `web_search`；搜索后端选择、会话 create/open/resume、`/status`
和 `/tools` 都只检查 Broker 内存元数据，不会解析懒加载引用或打开 Keychain，首次真实搜索才通过受控 `NetworkProxy` 解析精确引用。
`webfetch` 用于读取已知 HTTP(S) URL，无需搜索服务密钥。两者在 restricted workspace 中均禁用。

若专用联网工具不可用，Agent 必须说明原因，不会静默改用 `curl`、`wget` 或其他 shell HTTP
客户端。只有能证明整项工作负载随调用销毁的 OCI/container 运行时才暴露 shell 联网；原生沙箱的 `bash`
从 schema 到执行层均强制断网，避免 `setsid`/double-fork 逃离原进程组。容器内所有前台 `bash network:true`
请求即使在 auto/bypass 模式、hook 放行或已有 allow 规则下也必须逐次由用户明确确认；无交互入口直接拒绝，
联网批准不能记住或持久化。后台联网 shell 被拒绝，避免一次批准后经 stdin 复用长期联网进程。该链路只设置受隔离子进程的
进程级代理，不修改系统代理、DNS 或路由。

### Windows 的安全执行模式

AniCode 目前只为 macOS 和 Linux 提供原生 OS sandbox。原生 Windows 不会静默回退到裸 PowerShell/
`cmd.exe`：生产装配会进入 host restricted mode，从模型 schema 移除 `bash` 及后台 shell、LSP 和本地
browser，并关闭项目命令 hooks、自动 verifier、git checkpoint 与 worktree subagent。生产本地宿主只连接
HTTP MCP；LSP 还必须由能兑现 `managedProcessBoundary=close-confirmed` 的 cgroup/sidecar/Job Object
后端托管，`prepare()` 本身不是清理证明。当前生产 runtime 不声明该能力，HTTP MCP 和文件工具仍可用。

Windows 需要执行命令时，请启用 Docker/Podman OCI 后端并使用固定 digest 的镜像：

```powershell
$env:ANICODE_EXECUTION_BACKEND = "container"
$env:ANICODE_RUNTIME_IMAGE = "ghcr.io/OWNER/anicode-runner@sha256:<digest>"
$env:ANICODE_CONTAINER_ENGINE_ENDPOINT = "npipe:////./pipe/docker_engine"
# 仅在 Docker/Podman 不位于受信任的固定安装路径时设置：
# $env:ANICODE_CONTAINER_ENGINE_BIN = "C:\Program Files\Docker\Docker\resources\bin\docker.exe"
npm run dev:tui
```

OCI 模式当前支持前台 `bash`，并可把项目命令 hook 作为单次、按容器 ID 证明清理的 OCI 任务执行；后台
shell、stdio MCP、LSP 和本地 Chrome 仍保持关闭。详细边界见[本轮 P0/P1 闭环](docs/architecture/2026-08-03-p0-p1-closure.md#windows-与非原生隔离宿主)。

默认长期凭证后端是 OS Keychain，但普通启动不会执行全量枚举或自动写入。环境值优先作为当前进程凭证；
持久化必须显式执行精确 key 的导入，并通过 `ANICODE_CREDENTIAL_KEYS` 声明允许按需读取的名称：

```bash
# 单次显式导入；命令不会显示凭证值，也不会枚举 Keychain
OPENAI_API_KEY='...' anicode credentials import OPENAI_API_KEY

# 运行时只为精确名称注册懒加载引用；首次实际 send/stream 才读取
ANICODE_CREDENTIAL_KEYS=OPENAI_API_KEY anicode --model openai/gpt-5

anicode credentials list                    # 仅列 allowlist 元数据，不读取后端
anicode credentials remove OPENAI_API_KEY   # 精确删除；重启已使用它的常驻进程可立即清除内存缓存
```

既有 Keychain 条目无需重新导入，只需把对应名称加入 `ANICODE_CREDENTIAL_KEYS`。也可设置
`ANICODE_CREDENTIAL_BACKEND=vault|kms`，通过 OIDC/workload identity 精确读取后端中的 `env:NAME`；
这些后端同样要求 `ANICODE_CREDENTIAL_KEYS`，不会在启动时自动 list。同步/异步引用的成功读取
在 Broker 内默认有界缓存 1 小时（最长可配置为 24 小时），后续重新解析会在 TTL 到期后观察外部删除。
已经物化的 SDK/provider client 可能持有独立副本，不会被 Broker TTL 强制刷新；可靠地应用撤销或轮换需
回收这些 client，当前应重启已使用该凭据的常驻进程。

仍会打开 OS Keychain 的边界都是精确且有意触发的：CLI 在没有权威非 Cloud 模型、明确选择 Cloud、
恢复未知会话或启动动态 HTTP host 时，只读取 AniCode Cloud 专用命名空间中的单个 refresh 记录；
`auth login/status/logout` 也只操作这一条记录。普通 provider 则仅在首次实际使用懒加载凭证、最终选择
模型后的鉴权目录校验、连接显式启用且需要凭据的 MCP/控制平面，以及 `credentials import/remove`、
`auth migrate` 或轮换时访问后端。普通 provider 诊断、`credentials list`、`auth list` 和仅浏览静态模型
元数据不会枚举或读取 Keychain。

原生 Keychain 调用运行在有硬截止的 helper 子进程；CLI/VSIX 使用 bounded stdin/stdout，Electron 在
保持 `RunAsNode` fuse 关闭时使用一次性 `utilityProcess` 的 bounded `parentPort`。凭据不进入 argv、继承
环境、临时文件或日志。写入/删除若超时、取消或丢失完成证明会报告 `indeterminate`，不会盲目回滚或
删除。测试、密闭构建或不允许访问系统凭据库的宿主应同时设置
`ANICODE_CREDENTIAL_BACKEND=memory ANICODE_DISABLE_OS_KEYCHAIN=1`：前者使用进程内后端，后者让任何
误触在原生 API 调用前失败。轮换的 single-flight、quarantine 和 pending candidate 仅为进程内状态，
并非 crash-safe；多副本或跨重启部署必须使用单 active rotator、外部 CAS/分布式 lease 及幂等或持久化
reconciliation。轮换管理器会快照策略、在发行前后检查 registration generation，并让发行与写入共享
绝对截止；忽略取消但晚返回的 candidate 会进入显式 reconciliation，不会丢失或覆盖人工恢复。完整配置、轮换与跨进程协调边界见
[生产运维契约](docs/operations/production-readiness.md)。

自动化浏览器是独立于业务凭据后端的另一条宿主凭据路径：macOS Chrome 即使使用新 profile，也可能初始化
“Chrome Safe Storage”。AniCode 启动的 Chrome 现在只使用权限为 `0700` 的一次性 profile，macOS 强制
`--use-mock-keychain`，Linux 强制 `--password-store=basic`，并拒绝附加参数覆盖 profile、密码存储或
仅回环 CDP 监听。内置 Chrome DevTools MCP 同样固定 `--isolated` 与这两类平台参数；显式连接用户已有
浏览器仍属于用户主动授权的外部边界。上述参数只约束 AniCode 的子进程，不修改系统钥匙串、代理、DNS、
路由或证书配置。

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
/tool [id]                # 展开/收起完整工具输出（Ctrl+O）
/editor                   # 用 $EDITOR 编辑多行提示词（Ctrl+G）
/reconnect                # 重连远端事件流（Ctrl+R）
/lang <en|zh>             # 运行时切换中英文
/exit
```

运行中按 Enter 可追加 steering 指令，按 Esc 中断。`Shift+Tab` 在普通、自动接受编辑与跳过授权之间全局轮换；Shift/Ctrl+Enter 插入换行；bracketed paste
保留多行且绝不自动提交。授权卡片固定在输入框上方，支持方向键/Enter、`y/a/p/n`，高风险默认选中拒绝，
永久授权只需一次确认。默认关闭完整鼠标跟踪，可直接拖拽选择和复制文字；备用屏滚轮以及 `PageUp`/`PageDown` 都能回看固定输入框上方的结果。只有需要鼠标点击弹框时才用 `--mouse` 或 `/mouse on` 开启完整跟踪；`/mouse off` 随时恢复原生框选。短会话或输入框已有内容时，`↑`/`↓` 浏览已提交的 prompt 历史；长会话的空输入框中，方向键与滚轮一起回看结果。POSIX 终端中 `Ctrl+Z` 会正确挂起并在 `fg` 后恢复，默认 `Ctrl+Q` 退出；快捷键可在 `anicode.json` 的 `tui.keybindings` 中覆盖。

打开、搜索、滚动或按 Esc 关闭 `/model` 都只使用静态模型 metadata，不读取凭据。按 Enter/Tab 确认后
只查询所选 provider 的鉴权目录；目标模型必须在本次返回中，且兼容文本/工具调用。
`/model <provider/model>` 与 `once` 同样必须通过所选 provider 的最新目录校验，因此可以显式使用服务端
新增且尚未进入静态目录的模型。目录请求不发送推理 prompt，不产生批量推理费用；临时的 429、5xx 或
超时也不会被写回静态目录当成永久下线。

安装 workspace 后也可以直接检查 CLI：

```bash
npm exec -- anicode --version
npm exec -- anicode --list-providers
```

### 开发编程 MCP

AniCode 内置一组经过筛选的开发 MCP 目录，默认全部关闭，按项目安装到被 gitignore 的
`.anicode/settings.local.json`；也可以用 `--global` 写入 `~/.config/anicode/anicode.json`：

```bash
anicode mcp list
anicode mcp add context7
anicode mcp add github --global       # 需 GITHUB_TOKEN
anicode mcp add playwright
anicode mcp add chrome-devtools
anicode mcp add sentry                # 需 SENTRY_ACCESS_TOKEN
anicode mcp add firebase
anicode mcp remove context7
```

本地 npm MCP 使用目录中审核过的精确版本；GitHub、Context7、Sentry 使用各厂商官方 Streamable HTTP
端点。敏感凭证只保存为 Credential Broker 引用，不写入 JSON。安装后重启 AniCode，通过 `/mcp` 查看连接、
工具、资源与 prompts。`anicode mcp serve`（兼容旧的无参数 `anicode mcp`）则把 AniCode 自身暴露为 MCP server；
无交互 MCP 入口在未信任工作区不会获得隐式写权限，需要确认的写入或命令会 fail closed。

## 桌面应用（Electron）

`packages/app` 是一个向 ChatGPT app 看齐的桌面客户端：左侧会话列表 + 新对话、中间气泡式
对话与流式输出、底部输入框（Enter 发送 / Shift+Enter 换行）、可搜索的模型选择器、插件市场与设置页。

架构上主进程内跑 core 的 `SessionManager`，经 `contextBridge`（`window.anicode`）把 `SessionHost`
暴露给渲染进程——和 daemon 是同构的传输层。已登录 AniCode Cloud 时默认使用云端 DeepSeek gateway；
否则默认模型来自项目配置或进程内凭据 metadata，没有已配置云端凭据时回退到 `debug/demo`。
原生 Keychain 模块不会加载进 Electron 主进程：应用保持 `RunAsNode` 安全 fuse 关闭，只在一次明确的
凭据操作时启动一次性 `utilityProcess`，通过有大小/超时限制的 `parentPort` 传输，并在卡死时强制终止
该精确子进程。凭据不会进入 argv、继承环境、临时文件或日志；启动时只为恢复 AniCode Cloud 登录读取
它自己的单一 refresh-token 条目，普通 provider 的会话恢复和模型浏览仍不会枚举或读取 Keychain。

```bash
npm run dev:app      # 开发模式：根 .env + 直连 DeepSeek，不恢复 Cloud/Keychain
npm run build:app    # 打包 main/preload/renderer 到 packages/app/out
```

`dev:app` 与 `dev:tui` 使用同一条本地调试边界：本地开发进程把仓库根 `.env` 中的 Key 导入
memory Broker（不持久化），默认模型固定为直连 DeepSeek。打包后的桌面应用不读取这条开发变量，仍按
用户登录态使用 AniCode Cloud。

功能亮点：

- **对话与流式渲染**：气泡式界面，助手消息经内置轻量 Markdown 渲染（围栏代码块带复制按钮、
  行内代码 / 粗体 / 链接 / 列表 / 标题），且绝不注入原始 HTML（无 XSS）。
- **自动标题**：新会话发出首条消息后，用首句自动命名（离线、无需额外模型调用），事务写入会话数据库。
- **模型选择器**：复用内置免费 / 开源目录，主进程只计算凭据可用/已配置 metadata；标 ✔ 的懒加载引用
  仍要在首次实际发送时验证。
- **自定义模型**：设置页可为任意已有 provider 追加模型（持久化到 `userData/models.json`），
  立即出现在选择器里——回答了「模型是否只能写死在代码里」。
- **会话管理**：侧边栏悬停即可删除会话（删除当前会话会自动切到最近一个或新建）。

**插件市场 → 真实工具链**：插件统一抽象为可挂到 agent 的能力来源——内建工具（文件 / Bash / 任务清单）、
MCP 服务（Context7 / GitHub / Playwright / Chrome DevTools / Sentry / Firebase）、技能。开关会真正改变 agent 拿到的工具集：停用内建工具组会
从工具集移除对应工具；启用 HTTP MCP 且 Broker 凭证就绪时连接 server 并注入其工具（`<name>__<tool>`），联网插件强制复用策略代理，市场卡片显示连接
状态。生产宿主会在启动进程前拒绝 stdio MCP；普通子进程无法对主动脱离进程组的第三方 server 提供强制终止证明。改动对新建会话生效，状态持久化到 `userData/plugins.json`。

**打包分发**（electron-builder，主进程已把 core 与 SDK 依赖打进 bundle，产物自包含）：

```bash
npm run --workspace @anicode/app pack   # 快速产出未签名 .app（release/）
npm run --workspace @anicode/app dist   # 产出安装包（dmg / nsis / AppImage）
```

本地 `pack`/`dist` 包装器会清除继承的签名/公证凭据、关闭证书自动发现，并强制使用内存业务凭据后端及
OS Keychain 禁用哨兵。发布签名只在隔离的 release step 中显式启用，且不会启用 AniCode 业务 Keychain。

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

VSIX 包装器在一次性临时 HOME 中强制使用 `VSCE_STORE=file`，清除 publisher token 与常见密钥环境变量，
并启用内存凭据后端和 OS Keychain 禁用哨兵；打包结束后删除该临时目录。

Tree-sitter 与 OS Keychain 含原生 N-API 模块，本地 `.vsix` 对应当前 OS/CPU；Release workflow 会分别产出 Linux x64/arm64、macOS arm64/x64 与 Windows x64 安装包。

在 VSCode 里以该目录为「扩展开发宿主」按 F5 即可调试。

## Provider 与模型

anicode 使用数据驱动 registry，模型字符串格式为 `provider/model`；首个 `/` 后面的模型 id 会完整保留。
`/model` 先从当前权威 host 读取不含凭据且已过滤适配器能力的静态 metadata；只有确认一个候选后才请求
该 provider 的鉴权 `/models` 目录。若目标模型未返回、鉴权失败或超时，本次选择 fail closed；不会为
浏览选择器而批量解析其他 provider 的凭据。服务端新增模型可通过 `/model <provider/model>` 显式选择并
实时校验，但仍受当前 provider adapter 的实际能力边界约束。

内置 canonical provider：

| Provider        | 协议/用途                     | 凭证或端点变量                                          |
| --------------- | ----------------------------- | ------------------------------------------------------- |
| `anicode-cloud` | AniCode 托管 DeepSeek gateway | `anicode auth login`；共享 provider key 始终留在服务端  |
| `deepseek`      | OpenAI-compatible             | `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`                 |
| `gemini`        | Gemini OpenAI compatibility   | `GEMINI_API_KEY` 或 `GOOGLE_API_KEY`, `GEMINI_BASE_URL` |
| `cliproxy`      | 本地 CLI Proxy API            | `CLIPROXY_API_KEY`, `CLIPROXY_BASE_URL`                 |
| `custom`        | 自定义 OpenAI-compatible 服务 | `CUSTOM_OPENAI_BASE_URL`, `CUSTOM_OPENAI_API_KEY`       |
| `debug`         | 零网络调试                    | 无；别名 `demo`                                         |

`debug/demo` 永远可用，适合离线验证 agent loop。`--list-models` 只输出随版本发布的静态诊断目录，不代表模型当前在线；交互选择和直接执行仍以 host 的实时目录校验为准。

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
# Gemini
export GEMINI_API_KEY=...
npm run start --workspace @anicode/tui -- --model gemini/<model-id>

# 本机 CLI Proxy API
export CLIPROXY_API_KEY=...
npm run start --workspace @anicode/tui -- --model cliproxy/<model-id>

# 任意自建 OpenAI-compatible endpoint
export CUSTOM_OPENAI_BASE_URL=http://127.0.0.1:9000/v1
export CUSTOM_OPENAI_API_KEY=...
npm run start --workspace @anicode/tui -- --model custom/<model-id>
```

云端 provider 缺少自己的 key 时会在进入 TUI 前给出明确诊断。第三方兼容端点不会回退或继承其他 provider 的 key、组织、项目及环境自定义 header。

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

当前内置适配器聚焦 DeepSeek、Gemini、CLI Proxy 和自定义 OpenAI-compatible 端点，并支持由宿主实时发现其模型目录；但还不是 OpenCode 所使用的完整 AI SDK + Models.dev 生态。跨协议能力发现、OpenAI Responses API，以及更多 provider 的专有协议仍属于后续阶段。参考：[OpenCode Providers](https://opencode.ai/docs/providers/)、[Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)。

## Core 已具备的能力

- 统一内容块消息与流式事件协议，支持文本、thinking、图片、并行工具调用和 usage。
- Agent loop：工具执行、steering、重试、hooks、skills、subagents、todo 与中断。
- **工程化系统提示**：内置对齐 Claude Code/Codex 的行为准则——先探后改、工具路由（检索走 grep/glob、改文件走 edit、独立只读调用并行批处理）、代码规范（融入现有风格、最小改动、不擅自提交）、改完自验证、简洁收尾与安全边界。见 `agent.ts` 的 `DEFAULT_SYSTEM`。
- **环境接地**：会话开始时快照 `<env>`（cwd/平台/系统/日期/是否 git 仓库/当前分支）+ `<git-status>`（工作区改动与最近提交）注入 system，缓存友好，让模型不再盲飞。见 `env.ts`。
- 模型能力驱动请求：按 profile 控制 tools、reasoning、输出上限和 compaction 阈值；未知兼容模型不会被强塞 16k 输出参数。
- 子 agent 的 `provider/model` override 会重新解析 provider，不再错误复用父 provider。
- 默认工具：`read / write / edit / apply_patch / glob / grep / bash / bash_output / write_stdin / list_shells / kill_shell / webfetch / todo_write / task / skill`；Broker 中配置 Tavily/Brave 搜索引用后追加 `web_search`，配置 LSP 后追加 `diagnostics`。
- **多 agent 编排**（对齐 Claude Code 的 Agent/SendMessage/TaskOutput/TaskStop 收敛形态）：
  - `task` 委派子任务（内置 `general`/`explore` + 文件/配置自定义类型）；只读型可并行 fan-out；`orchestrator` 型可嵌套下派（深度硬顶）。
  - `task(background=true)` 后台运行：立即返回任务 id，父 agent 继续干活；完成时 `<task-notification>` 在 turn 边界注入（运行中）或由 SessionManager 自动发起一次 drive（空闲时）——主 agent 不用轮询。
  - `task_send` 给既有子 agent 发后续消息（上下文完整保留，追问/迭代）；`task_output` 查状态/活动/结论；`task_stop` 终止。
  - `task(isolation="worktree")` 在 detached git worktree 副本中运行：多个写任务并行互不冲突；无改动自动清理，有改动保留路径由父 agent 合并。
  - 硬性上限（防失控）：嵌套深度、单会话 spawn 总量、后台并发；子 agent 结论过滤通知信封标记（防伪装宿主控制信息）。agent 间 peer 通信刻意不做（对齐 opencode not-planned / Claude Code 实验 flag 的取舍）。
- **后台长时命令**：`bash(run_in_background)` 立即返回 shell id 不阻塞，`bash_output` 增量读取新输出（可选正则 filter），`kill_shell` 停止 —— dev server / watch 构建 / 日志跟随不再被 120s 超时打死。增量读取（读过即清）、有界缓冲、自动回收、宿主退出收尸，且**不主动往上下文塞提醒**，规避 Claude Code 后台任务刷爆上下文的已知坑。后台与前台共用同一套 OS 沙箱，绝非绕过通道。见 `tools/shells.ts`。
- **多模态 read**：`read` 可读图片（png/jpg/gif/webp），模型支持视觉时经 `ctx.attachImage` 把图片本体附在本轮 tool_result 之后送入同一条 user 消息；不支持视觉/超 3.7MB 时如实降级为文本说明。两端 provider 映射（Anthropic `image` 块 / OpenAI `image_url`）已实测通过，无需改 provider。见 `tools/fs.ts`、`tools/tool.ts` 的 `ToolContext.attachImage`。
- **类型化 repo map**：Tree-sitter/ast-grep 覆盖 JS/TS/Python/Go/Rust/Java，可选 LSP enrich，维护增量 symbol/reference graph，并以 lexical + graph + SQLite/pgvector 混合检索减少盲目定位。
- **事务化 PatchSet**：会话级 prepare/approve/apply 流程提供 base hash 冲突检测、原子 journal、崩溃恢复与回滚，支持 rename、binary 和三方 merge。内置 `write` / `edit` / `apply_patch` 是独立的权限受控开发工具；未信任工作区可逐项批准这些工具，但不会启用会话级 PatchSet API 或 journal 恢复。
- **ripgrep 后端检索**：检测到 `rg` 时 grep/glob 走 ripgrep（尊重 .gitignore、跳过二进制、按 mtime 排序），无 rg 自动回退纯 JS。grep 支持 `output_mode`（content/files_with_matches/count）、`ignore_case`、`context` 前后行、`path`/`glob` 限定。
- **read 加固**：NUL 字节识别二进制（不返回乱码）、超长单行截断（防炸上下文）。
- **重试尊重 `Retry-After`**：429/503 带该头时按服务端节流等待（与指数退避取较大值，封顶 60s）。
- Core/宿主协议兼容 `default / acceptEdits / auto / bypass / plan` 权限状态，并支持 allow/ask/deny glob 规则和运行时记忆；内部 `plan` 只放行只读工具，用于安全降级与兼容，不作为 TUI 的用户可选档位。
- 每轮可创建 git 工作区快照，TUI 用 `/undo` 恢复文件；macOS Seatbelt 与 Linux bubblewrap 可为 Bash 提供 OS 级沙箱。
- 项目记忆：向上发现 `AGENTS.md` / `CLAUDE.md`，止于 `.git` 边界。
- 两级 compaction：先清理旧工具输出，再在安全边界生成摘要，保持 tool call/result 配对。
- SQLite WAL 会话持久化、resume、最近活跃排序、悬空工具调用自愈；旧 JSONL 首次访问时幂等迁移，数据库较新时不回灌。
- `SessionHost` 抽象与 daemon pub/sub：本地 TUI 和远程客户端使用同一接口，多客户端可观察、接管和裁决权限。
- MCP：保留 stdio（规范的换行分隔 JSON-RPC）与 Streamable HTTP 客户端；生产工具注册只开放受控出口的 HTTP，敏感 header/env 只能由 Credential Broker 短租约注入。stdio 仅供非生产兼容/测试，直到它由可证明清理的 cgroup、OCI sidecar 或 Windows Job Object 托管。`anicode mcp serve` 可把自身暴露为 MCP server。
- Notification hook（turn_done / permission_request）+ TUI 授权响铃：配合 anicode.json 命令 hook 可外接桌面通知（对齐 Codex notify）。
- 插件目录：`~/.anicode/plugins/<name>/` 与项目 `.anicode/plugins/<name>/` 下的 agents/skills/commands 子目录自动并入发现器（Claude Code plugins 的精简形态）。
- TUI：`/diff`（工作区改动）、`/review`（uncommitted/branch/commit/自定义 四模式审查）、`/tasks`（后台任务一览）、`/status` 显示上下文占用与联网工具摘要、`/tools` 显示 `web_search` / `webfetch` 的实际装配状态及安全的禁用原因。

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

未信任工作区中的 `anicode exec` 仍隐藏项目能力；由于无头模式无法显示授权卡片，写入和命令权限会被
拒绝，显式 `--auto` / `--accept-edits` 也不能绕过 Workspace Trust。

`NO_COLOR`、`INK_SCREEN_READER=true` 与非备用屏模式均受支持。交互命令在 stdin/stdout 不是 TTY 时会明确失败，
避免把 ANSI 控制序列写入管道；管道/CI 应使用 `anicode exec`。

参数解析是严格的：未知参数、缺值、重复和互斥组合会直接报错。`--sessions` 与权限模式属于本地进程，daemon 客户端不能覆盖 daemon 的配置。

`--debug-log` 写权限为 `0600` 的 JSONL 文件，不向 stdout 输出日志以免破坏 Ink。日志在后台批量写入并限制待写队列，慢磁盘不会阻塞按键/流式渲染。默认只记录事件类型、耗时和内容长度，不记录 prompt、工具参数、错误原文或输出；只有显式传 `--trace-content` 才记录内容，凭证样式仍会脱敏。

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
