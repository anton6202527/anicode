# TUI Production Readiness：P0 / P1 / P2 收口归档

归档日期：2026-07-30

## 结论

本轮按 P0 → P1 → P2 顺序收口 TUI；生产默认路径使用 Ink 7 / React 19 的原生输入、窗口尺寸、
incremental rendering 与 alternate-screen 生命周期。旧的全局 `stdout.write` 帧合成器只保留在
`ANICODE_EXPERIMENTAL_TUI_OVERLAY=1`，默认不再 monkeypatch 进程 stdout。

## P0：安全与正确性

- 所有模型、工具、错误、授权字段在进入终端前删除 CSI、OSC（含 OSC 52）、DCS/APC/PM/SOS、C0/C1 与 bidi spoofing 控制符。
- SIGINT/SIGTERM/SIGHUP、异常、普通退出都幂等恢复 raw mode、光标、bracketed paste、鼠标、配色与备用屏。
- 发布 CLI 要求 Node `>=22.15.0 <25`；构建会拒绝 bundle 中未声明的 runtime external，npm tarball 做 clean-room 启动验证。
- OpenAI-compatible usage 将普通 input 与 cache read 分离，避免总量重复计费。
- 授权卡片展示结构化 cwd/risk/network/file mutation/完整操作/脱敏参数；高风险默认拒绝，永久规则二次确认。
- debug wrapper 保留 `send` options、undo mode 与所有可选 `SessionHost` 方法。

## P1：终端与长会话可靠性

- `usePaste` 接管 bracketed paste：保留内部换行，尾随换行不提交，128 KiB 上限且按 grapheme 安全截断。
- 光标、左右移动、Backspace/Delete、Ctrl+W、列宽裁切按 `Intl.Segmenter` + `string-width` 处理；覆盖 ZWJ emoji、组合音标、旗帜、肤色与 Indic conjunct。
- 多行 composer 最多显示五个逻辑行，活动行始终在窗口内；Home/End 与上下行移动保持显示列。
- `useWindowSize` 响应 resize；1–16 列、4–6 行仍保证帧不越界。
- `--plain / --no-color / --mouse / --no-mouse / --no-alt-screen`、`NO_COLOR`、screen-reader 与非 TTY fail-fast 已接线。交互式 CLI 默认接收滚轮；iTerm2 可按 Option 拖选，`--no-mouse`/`/mouse off` 可恢复无修饰键原生框选。
- transcript UI cache 限 5,000 条，live text/thinking 与单条渲染均有上限；完整事实仍在 durable session store。
- `OpenHandle.closed` 把 HTTP SSE / daemon 断连显式上报；TUI 指数退避五次并支持 `/reconnect` / Ctrl+R。
- React error boundary 保留可退出的安全画面，并把脱敏诊断写入显式 debug log。

## P2：使用体验与自动化接口

- 默认 system 定位为通用型 Agent，以任务目标路由调研、写作、分析、规划、数据或工程流程；不用身份标签/“作为……”开场，编程作为重点强化能力而非默认限定。
- 助手输出支持安全 Markdown：标题、列表、引用、粗体/斜体、链接、行内代码与 fenced code。
- 工具结果默认单行摘要，`/tool [id]` 或 Ctrl+O 展开完整输出。
- PatchSet/edit 授权卡片显示有界、脱敏、按增删着色的 diff preview。
- `/editor` / Ctrl+G 通过 Ink `suspendTerminal` 安全交接 `$VISUAL/$EDITOR`，不经 shell 解析命令。
- `tui.keybindings` 可覆盖 command palette、editor、reconnect、tool output、permission cycle、quit。
- `/usage` 与状态栏分别展示 input/output、cache read/cache write 和成本，不重复计算 cached input。
- `anicode exec` 提供无 TTY 的 JSONL/text 单次执行、timeout、幂等键、事件流、最终 usage 与 fail-closed 权限处理。
- 鼠标跟踪只由真实 CLI TTY 控制，embedding/test 不改终端；默认关闭，`--mouse` 显式开启，`/mouse off` 可在运行中恢复原生框选。

## 验证边界

仓库测试覆盖终端注入、Unicode、粘贴分块、窄/矮窗口、授权、断线重连、错误边界、JSONL exec、
信号清理与发布 tarball。发布前仍应在 macOS Terminal/iTerm2、VS Code Terminal、kitty/WezTerm、
Windows Terminal + WSL 运行人工矩阵，并在真实 SSH/tmux、IME、screen reader 与网络抖动环境做验收；
这些属于目标部署环境验证，不能由离线单元测试替代。
