# anicode

前端无关的 AI coding agent,终端界面(TUI)。多 provider、工具调用、权限门、会话持久化与守护进程,可接入 MCP。

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

## 说明

本包是自包含产物:core / shared / TUI 的源码已打包进单个 `dist/cli.js`,
运行时仅依赖 `ink` / `react` / `@anthropic-ai/sdk` / `openai`。需要 Node ≥ 18。

源码与完整文档:https://github.com/anton6202527/anicode
