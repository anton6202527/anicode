# anicode

## 0.3.1

### Patch Changes

- 2a968ed: Fix global CLI startup by preserving the built-in `custom` provider, defaulting new sessions to DeepSeek, and adding secure AniCode Cloud login so the shared provider key stays on the Supabase gateway.

## 0.3.0

### Minor Changes

- 1981e6a: 将 AniCode 升级为通用型 Agent CLI，并重点强化软件工程与生产级终端体验：

  - 升级到 Ink 7 / React 19，加入多行 Unicode 编辑、外部编辑器、可配置快捷键、工具输出展开、连接恢复与有界 UI 缓存。
  - 改进权限弹层、模型与会话选择器、终端文本安全、Markdown 渲染、原生框选复制及 macOS IME 绝对光标定位；修复反复调整终端尺寸时旧帧、Logo 和输入框残影。
  - 受信任的本地交互 TUI 默认使用最高权限并自动批准；Shift+Tab 在普通、自动接受编辑与跳过授权之间全局轮换，不再暴露计划档，并以宿主快照同步真实权限状态。显式 deny/ask、Workspace Trust、sandbox、网络策略与 workspace scope 仍是硬边界；未信任、远端和无头入口保持保守。
  - 完善本地零后端运行、HTTP host、SQLite/PostgreSQL 持久化、进程隔离工具执行、provider 诊断、缓存用量展示和安全调试日志；JSONL 明确保留为单进程 fallback/迁移格式。
  - 收紧联网核心：统一受控出口、SSRF/重定向校验、硬超时与有界重试；生产会话按 Broker 元数据惰性装配 Tavily/Brave `web_search`，并通过 `/tools`/`/status` 显示安全的可用性原因。专用工具不可用时不再静默回退 curl/wget；原生沙箱的 shell 强制断网，只有具备整工作负载销毁证明的容器才开放逐次显式确认、不可记住的前台联网，后台联网 shell 直接拒绝。全程不修改系统代理、DNS、路由或其他 App 的网络配置。
  - 重构凭据边界：环境密钥进入进程内 Broker 后即清理，Keychain/Vault/KMS 按精确引用惰性读取；测试、构建和 metadata-only 浏览强制禁止访问 OS Keychain。
  - 修正实时模型发现的三态诊断、DeepSeek V4 选择及并发竞态；端点不可查询不再误报为模型不存在，未信任项目会明确提示 `.env` 未加载。
  - 将 CLI 运行时基线提升到 Node.js 22.15，并覆盖 Node 22 LTS、Node 24 LTS 与最新稳定主版本；校验所有外置运行时依赖均已在发布包中声明。
  - 加固 npm 发布链：完整 release gate、四文件最小 tarball、OIDC trusted publishing、provenance、完整性比对及隔离的发布权限；本地直发入口默认拒绝，并修复发布审计发现的 `js-yaml` 高危漏洞。

## 0.2.0

### Minor Changes

- 33fe1b8: 内置浏览器验证、权限模式轮盘、TUI/i18n 与工程基建增强：

  - **内置浏览器验证工具（browser）**：写完前端后用真实的 headless 浏览器（自动探测本机 Chrome/Chromium/Edge，零依赖、不下载浏览器）打开页面验证——报告 console 错误、未捕获异常、失败请求与标题，并回传截图。默认开启、只读、权限预授权（无需逐次授权）；`anicode.json` 的 `browser` 可指定浏览器路径/视口或关闭。系统提示会引导模型在改动前端后主动开页验证。
  - **Shift+Tab 权限模式轮盘**：受信任的本地交互 TUI 默认使用最高权限并自动批准，可在 默认 → 自动接受编辑 → 跳过所有授权 之间循环切换；不再暴露用户可选的计划档。授权卡片/选择器打开时快捷键仍生效，状态行与宿主真实模式保持同步。显式 `deny` / `ask`、Workspace Trust、sandbox、网络策略与 workspace scope 仍是硬边界；未信任、远端和无头入口保持保守。
  - **命令补全菜单**：输入 `/` 前缀即在输入框上方弹出可滚动的命令菜单（↑/↓ 选择、Tab 补全、Enter 执行），并平铺整屏宽。
  - **弹框自适应**：随终端变窄而缩小，超窄时横向滚动；始终显示 logo（窄屏只裁两侧）。
  - **中英双语**：全线人机界面文案与发给模型的提示词均支持中英切换（`/lang <en|zh>`、`ANICODE_LANG`、系统 locale 自动判定），默认英文。
  - **工程基建**：新增 GitHub Actions CI（format/lint/typecheck/test/build）、ESLint + Prettier、changesets 发布流程；Electron renderer 使用浏览器安全的 i18n 子路径并纳入生产构建门禁。
