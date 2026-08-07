---
"anicode": minor
---

将 AniCode 升级为通用型 Agent CLI，并重点强化软件工程与生产级终端体验：

- 升级到 Ink 7 / React 19，加入多行 Unicode 编辑、外部编辑器、可配置快捷键、工具输出展开、连接恢复与有界 UI 缓存。
- 改进权限弹层、模型与会话选择器、终端文本安全、Markdown 渲染、原生框选复制及 macOS IME 绝对光标定位。
- 受信任的本地交互 TUI 默认使用最高权限并自动批准；Shift+Tab 在普通、自动接受编辑与跳过授权之间全局轮换，不再暴露计划档，并以宿主快照同步真实权限状态。显式 deny/ask、Workspace Trust、sandbox、网络策略与 workspace scope 仍是硬边界；未信任、远端和无头入口保持保守。
- 完善本地零后端运行、HTTP host、SQLite/PostgreSQL 持久化、进程隔离工具执行、provider 诊断、缓存用量展示和安全调试日志；JSONL 明确保留为单进程 fallback/迁移格式。
- 收紧联网核心：统一受控出口、SSRF/重定向校验、硬超时与有界重试，且不修改系统代理、DNS、路由或其他 App 的网络配置。
- 重构凭据边界：环境密钥进入进程内 Broker 后即清理，Keychain/Vault/KMS 按精确引用惰性读取；测试、构建和 metadata-only 浏览强制禁止访问 OS Keychain。
- 修正实时模型发现的三态诊断、DeepSeek V4 选择及并发竞态；端点不可查询不再误报为模型不存在，未信任项目会明确提示 `.env` 未加载。
- 将 CLI 运行时基线提升到 Node.js 22.15，并覆盖 Node 22 LTS、Node 24 LTS 与最新稳定主版本；校验所有外置运行时依赖均已在发布包中声明。
- 加固 npm 发布链：完整 release gate、四文件最小 tarball、OIDC trusted publishing、provenance、完整性比对及隔离的发布权限。
