# anicode

前端无关的通用型 AI Agent 终端界面（TUI），调研、写作、分析、规划和工具协作都是一等能力，软件工程是重点强化的核心长项。支持多 provider、工具调用、权限门、会话持久化、守护进程与 MCP。

默认以本地单进程模式运行，会话使用内置 SQLite；安装和启动不需要 AniCode 后端、PostgreSQL 或 daemon。远端 host、daemon、Vault/KMS、S3 和 Remote Runtime 均为显式可选项。云端模型本身可能需要对应 provider 的凭证；`debug/demo` 可完全离线启动。

## 安装

```bash
npm install -g anicode
```

装好后命令名是 `anicode`(也提供别名 `anicode`):

```bash
anicode --version
anicode --list-providers       # 查看内置 provider 与凭证状态
anicode --list-models          # 查看内置模型目录（含免费/本地）
```

## 使用

```bash
# 零网络调试（无需 API key，离线流式 echo + 真实工具链路）
anicode --model debug/demo

# Anthropic
export ANTHROPIC_API_KEY=...
anicode --model anthropic/<model-id>

# 任意 OpenAI 兼容端点 / 本地模型
anicode --model openai/<model-id>
anicode --model ollama/qwen3
```

TUI 内命令:`/model` 选模型 · `/sessions` 列会话 · `/resume <id>` 续接 · `/new [标题]` · `/help`。
运行中 Enter 追加指令、Esc 中断;授权提示 `y` 允许 / `a` 允许并记住 / `n` 拒绝。
默认保留终端原生鼠标框选/复制；需要点击和滚轮导航时用 `anicode --mouse`，或在运行中用 `/mouse on|off` 切换。

## 说明

本包是自包含产物:core / shared / TUI 的源码已打包进单个 `dist/cli.js`,
运行时仅依赖 `ink` / `react` / `@anthropic-ai/sdk` / `openai`。需要 Node ≥ 22.14。

源码与完整文档:https://github.com/anton6202527/anicode
