---
"anicode": minor
---

TUI、i18n 与工程基建增强：

- **命令补全菜单**：输入 `/` 前缀即在输入框上方弹出可滚动的命令菜单（↑/↓ 选择、Tab 补全、Enter 执行）。
- **弹框自适应**：随终端变窄而缩小，超窄时横向滚动；始终显示 logo（窄屏只裁两侧）。
- **中英双语**：全线人机界面文案与发给模型的提示词均支持中英切换（`/lang <en|zh>`、`ANICODE_LANG`、系统 locale 自动判定），默认英文。
- **工程基建**：新增 GitHub Actions CI（format/lint/typecheck/test/build）、ESLint + Prettier、changesets 发布流程。
