# anicode for VSCode

在 VSCode 侧边栏里使用 anicode 通用型 Agent，并在工程场景中发挥强化的代码理解、编辑与验证能力。扩展主机进程内
运行 `@anicode/core` 的 `SessionManager`，webview 只负责渲染——与 daemon / Electron app
是同一套 `SessionHost` 契约的不同传输实现。

## 功能

- 侧边栏对话面板：流式回复、工具调用、任务清单，Markdown 渲染（代码块带复制、无 XSS）。
- 内联授权：工具触发权限时在对话里以「允许 / 允许并记住 / 拒绝」按钮裁决。
- 原生 QuickPick 选择模型（复用内置免费/开源目录，标注凭证就绪）与恢复历史会话。
- 工作区目录即 agent 的 cwd；状态栏显示当前模型。
- 首条消息后自动命名会话。

## 开发

```bash
npm run build --workspace anicode-vscode    # 用 esbuild 打包 out/extension.js 与 out/webview.js
npm run watch --workspace anicode-vscode    # 监听重建
```

在 VSCode 里按 F5（以本目录为扩展开发宿主）即可调试。打包为 `.vsix`：

```bash
npm run package --workspace anicode-vscode
```

桌面与 Remote Extension Host 的最低支持版本为 VS Code 1.101（Node 22.15.1）。扩展把
`@anicode/core` 的 `node:sqlite` 运行时打入主机 bundle，因此旧版 Node 20 Extension Host 不受支持。
构建和 VSIX 预发布会运行静态兼容性检查：manifest、最低版本 API 类型、esbuild target，以及 bundle
中的每一个 `node:` builtin 必须与这条基线一致。

Tree-sitter 与 OS Keychain 使用 N-API，因此本地命令生成的是当前平台 VSIX。构建会显式复制最小
Keychain JS loader 和当前平台 binding 到 `out/keyring`，扩展宿主把该绝对路径交给隔离 helper；不会
依赖 CJS 中不可用的 `import.meta` 或残留的 hashed native 文件。Release workflow 会在 Linux x64/arm64、
macOS arm64/x64 和 Windows x64 runner 上分别执行 `vsce --target`，产出带平台后缀的安装包，避免把某一
平台的 `.node` 文件误发给全部用户。

默认使用项目配置或已就绪凭证对应的模型，并自动读取工作区根目录的 `.env.local` / `.env`；其中的
密钥只进入当前扩展宿主进程，不会写入全局 OS Keychain。长期凭证必须由用户显式导入，并由宿主级
`ANICODE_CREDENTIAL_KEYS` 精确允许后才会按需读取；启动和模型目录展示不会全量枚举 Keychain。
没有可用云端凭证时回退到零网络的 `debug/demo`。
