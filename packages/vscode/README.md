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

Tree-sitter 与 OS Keychain 使用 N-API，因此本地命令生成的是当前平台 VSIX。Release workflow 会在 Linux x64/arm64、macOS arm64/x64 和 Windows x64 runner 上分别执行 `vsce --target`，产出带平台后缀的安装包，避免把某一平台的 `.node` 文件误发给全部用户。

默认使用项目配置或已就绪凭证对应的模型，并自动读取工作区根目录的 `.env.local` / `.env`；
没有可用云端凭证时回退到零网络的 `debug/demo`。
