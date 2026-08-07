# anicode

前端无关的通用型 AI Agent 终端界面（TUI），调研、写作、分析、规划和工具协作都是一等能力，软件工程是重点强化的核心长项。支持多 provider、工具调用、权限门、会话持久化、守护进程与 MCP。

默认以本地单进程模式运行，会话使用内置 SQLite；安装和启动不需要 AniCode 后端、PostgreSQL 或 daemon。远端 host、daemon、Vault/KMS、S3 和 Remote Runtime 均为显式可选项。云端模型本身可能需要对应 provider 的凭证；`debug/demo` 可完全离线启动。

## 安装

```bash
npm install -g anicode
```

装好后命令名是 `anicode`：

```bash
anicode --version
anicode --list-providers       # 查看内置 provider 与凭证状态
anicode --list-models          # 查看随版本发布的静态模型目录（不代表在线）
OPENAI_API_KEY='...' anicode credentials import OPENAI_API_KEY
ANICODE_CREDENTIAL_KEYS=OPENAI_API_KEY anicode --model openai/gpt-5
anicode credentials list       # 只列显式引用名，不读取 Keychain/Vault/KMS
anicode credentials remove OPENAI_API_KEY
```

普通启动不会枚举 OS Keychain，也不会把 `.env` 或 shell 中的密钥自动持久化。环境密钥只在当前进程
Broker 中使用；长期保存必须通过 `credentials import` 明确执行，运行时再用
`ANICODE_CREDENTIAL_KEYS` 指定允许按需读取的精确名称。provider 诊断、默认模型选择和会话
create/open/resume 都是 metadata-only；懒加载引用直到该会话首次实际 `send/stream` 才读取，失败后可在
解锁或修复凭据后重试，且失败时不会继续打开其他 fallback Keychain 条目。`credentials list`、
`auth list` 和只浏览模型元数据不会打开 Keychain。
已物化的 SDK/provider client 可能继续持有凭据副本；`credentials remove` 或外部轮换后，应重启已使用
该凭据的常驻 AniCode 进程以可靠应用变更。

仍会访问 Keychain 的动作是精确且显式的：首次实际使用某个懒加载 provider、最终选择模型后的鉴权目录
校验、连接显式启用且需要凭据的 MCP/控制平面，以及 `credentials import/remove`、
`auth logout/migrate` 或轮换等写删/迁移动作。原生调用位于有硬截止的 helper 子进程，凭据请求仅经
bounded stdin 传递；无法证明写入/删除是否完成时会报告 `indeterminate`，不会盲目回滚。测试/密闭
构建应同时设置 `ANICODE_CREDENTIAL_BACKEND=memory ANICODE_DISABLE_OS_KEYCHAIN=1`，将任何意外系统
凭据库访问变成原生 API 调用前错误。

## 使用

```bash
# 零网络调试（无需 API key，离线流式 echo + 真实工具链路）
anicode --model debug/demo

# Gemini
export GEMINI_API_KEY=...
anicode --model gemini/<model-id>

# 任意 OpenAI 兼容端点
export CUSTOM_OPENAI_BASE_URL=http://127.0.0.1:9000/v1
anicode --model custom/<model-id>
```

TUI 内命令:`/model` 选模型 · `/sessions` 列会话 · `/resume <id>` 续接 · `/new [标题]` · `/help`。
受信任的本地交互 TUI 默认使用最高权限并自动批准（首次用 `anicode trust grant --cwd "$PWD"` 授信）；该默认仍服从显式 `deny` / `ask`、sandbox、网络策略与 workspace scope。`Shift+Tab` 可在普通、自动接受编辑、跳过授权之间循环（不含计划档），弹框打开时也有效。未信任、远端与无头入口保持保守。运行中 Enter 追加指令、Esc 中断；若仍有授权提示，可用 `y` 允许 / `a` 允许并记住 / `n` 拒绝。
默认保留终端原生鼠标框选/复制与备用屏滚轮回看；需要鼠标点击弹框时用 `anicode --mouse`，或在运行中用 `/mouse on|off` 切换。
POSIX 终端中 `Ctrl+Z` 挂起、`fg` 恢复，默认 `Ctrl+Q` 退出。
`/model` 打开、搜索、滚动或按 Esc 关闭时只展示静态 metadata，不读取凭据；按 Enter/Tab 确认后只对
所选 provider 做一次鉴权目录校验，所选模型必须在本次返回中且兼容文本/工具调用。直接指定模型和
`once` 也不能绕过所选 provider 的实时目录校验；目录请求不会逐模型发起计费推理探测。

## 说明

本包是自包含产物:core / shared / TUI 的源码已打包进单个 `dist/cli.js`,
所有外置运行时依赖均在 `package.json` 中声明并由发布门禁校验。需要 Node >= 22.15.0；CI 会持续
验证最低版本、发布用 Node 24 LTS 和 Node `current` 最新稳定版。npm 包内含 MIT LICENSE。

源码与完整文档:https://github.com/anton6202527/anicode
