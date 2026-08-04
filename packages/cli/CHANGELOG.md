# anicode

## 0.2.0

### Minor Changes

- 33fe1b8: 内置浏览器验证、权限模式轮盘、TUI/i18n 与工程基建增强：

  - **内置浏览器验证工具（browser）**：写完前端后用真实的 headless 浏览器（自动探测本机 Chrome/Chromium/Edge，零依赖、不下载浏览器）打开页面验证——报告 console 错误、未捕获异常、失败请求与标题，并回传截图。默认开启、只读、权限预授权（无需逐次授权）；`anicode.json` 的 `browser` 可指定浏览器路径/视口或关闭。系统提示会引导模型在改动前端后主动开页验证。
  - **Shift+Tab 权限模式轮盘**：受信任的本地交互 TUI 默认使用最高权限并自动批准，可在 默认 → 自动接受编辑 → 跳过所有授权 之间循环切换；不再暴露用户可选的计划档。授权卡片/选择器打开时快捷键仍生效，状态行与宿主真实模式保持同步。显式 `deny` / `ask`、Workspace Trust、sandbox、网络策略与 workspace scope 仍是硬边界；未信任、远端和无头入口保持保守。
  - **命令补全菜单**：输入 `/` 前缀即在输入框上方弹出可滚动的命令菜单（↑/↓ 选择、Tab 补全、Enter 执行），并平铺整屏宽。
  - **弹框自适应**：随终端变窄而缩小，超窄时横向滚动；始终显示 logo（窄屏只裁两侧）。
  - **中英双语**：全线人机界面文案与发给模型的提示词均支持中英切换（`/lang <en|zh>`、`ANICODE_LANG`、系统 locale 自动判定），默认英文。
  - **工程基建**：新增 GitHub Actions CI（format/lint/typecheck/test/build）、ESLint + Prettier、changesets 发布流程；Electron renderer 使用浏览器安全的 i18n 子路径并纳入生产构建门禁。
