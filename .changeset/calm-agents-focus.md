---
"anicode": minor
---

将 AniCode 升级为通用型 Agent CLI，并重点强化软件工程与生产级终端体验：

- 升级到 Ink 7 / React 19，加入多行 Unicode 编辑、外部编辑器、可配置快捷键、工具输出展开、连接恢复与有界 UI 缓存。
- 改进权限弹层、模型与会话选择器、终端文本安全、Markdown 渲染、原生框选复制及 macOS IME 绝对光标定位。
- 受信任的本地交互 TUI 默认使用最高权限并自动批准；Shift+Tab 在普通、自动接受编辑与跳过授权之间全局轮换，不再暴露计划档，并以宿主快照同步真实权限状态。显式 deny/ask、Workspace Trust、sandbox、网络策略与 workspace scope 仍是硬边界；未信任、远端和无头入口保持保守。
- 完善本地零后端运行、HTTP host、provider 诊断、缓存用量展示和安全调试日志。
- 将 CLI 运行时基线提升到 Node.js 22.14，并校验所有外置运行时依赖均已在发布包中声明。
