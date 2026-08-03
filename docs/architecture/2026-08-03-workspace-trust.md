# Workspace Trust 边界

日期：2026-08-03

## 目标与威胁模型

仓库内容在用户明确授权前一律视为不可信。攻击者可能控制克隆下来的项目配置、环境文件、MCP/LSP 命令、hook、agent/skill/command 提示，以及指向工作区外的符号链接；但不假设攻击者已经控制当前用户的主目录或 anicode 进程。

Workspace Trust 负责阻止“不打开文件也会自动执行”的攻击面。它不是 shell sandbox、网络隔离或权限引擎的替代品；无论是否授信，内置写入和命令执行都必须经过 PermissionEngine 与运行时隔离。

## 信任绑定

`WorkspaceTrustStore` 将一次授权同时绑定到：

1. 工作区真实路径（`realpath`）以及文件系统 `device/inode`。同一目录的符号链接别名共享授权，但同路径被替换为另一目录时不能继承授权。
2. 执行面 SHA-256 指纹。以下内容的新增、删除或修改会自动失效：
   - `anicode.json`、`.anicode/anicode.json`、`.anicode/settings.local.json` 中的 MCP、agent、LSP、browser、instructions、hooks、permissions 与 profile 执行字段；
   - `.env.local`、`.env`；
   - 从 cwd 向上到首个 `.git` 边界的 `AGENTS.md`、`CLAUDE.md`；
   - `.anicode/plugins`、`.anicode/agents`、`.anicode/command`、`.claude/agents`、`.claude/skills` 下的项目扩展内容。

仅修改 `model`、`smallModel`、`fallbackModels` 或 TUI 键位不会要求重新授权，因为这些字段不会在本机执行代码或注入系统提示。

信任记录默认保存在 `~/.config/anicode/trust/workspaces.json`（尊重绝对路径形式的 `XDG_CONFIG_HOME`）。目录强制为 `0700`，文件强制为 `0600`；所有权、权限、schema、大小、symlink 或并发读取异常均 fail closed。写入采用跨进程锁、临时文件、原子 rename 与 fsync。

## 未信任状态

`loadConfig` 未收到有效 `WorkspaceTrustAssessment` 时，项目配置只保留模型与 TUI 偏好；项目 MCP、agent、LSP、browser、instructions、hooks、permissions 和 profiles 不生效。全局用户配置仍可加载，但“已加载”不等于“可执行”：SessionManager restricted mode 会进一步关闭 user/project skill、自定义工具及权限档位等扩展面；交互式 `default` 入口同时保留受内置权限策略约束的开发工具。

`loadProjectEnv` 在未信任状态下不向进程环境写入任何项目变量。即使项目已授信，以下控制面/loader 变量仍永久禁止从项目 env 注入：

- `ANICODE_*`、`AGENTX_*`、`LD_*`、`DYLD_*`；
- `NODE_OPTIONS`、`NODE_PATH`、`PATH`、`SHELL`、`BASH_ENV`、`ENV`、`ZDOTDIR`；
- `ELECTRON_RUN_AS_NODE`、`PYTHONPATH`、`PYTHONHOME`、`RUBYOPT`、`PERL5OPT`。

配置和 env 都在读取前后重新计算执行面指纹。只有第二次校验仍匹配时，内存中的项目执行配置才会被激活，以关闭检查与读取之间的换文件窗口。

## Core API 与 CLI 接入

CLI、HTTP serve、Desktop 与 VS Code 已在读取项目 env、发现项目
plugins/skills/agents/commands 之前查询信任：

```ts
const trustStore = new WorkspaceTrustStore();
let workspaceTrust = await trustStore.assess(cwd);

// 只可在用户看清 canonicalRoot 与 executionSources 并明确确认后执行；
// confirmation 期间 identity/hash 改变时 grant fail closed：
if (!workspaceTrust.identity || !workspaceTrust.executionHash) {
  throw new Error("workspace inspection failed");
}
workspaceTrust = await trustStore.grant(cwd, {
  identityKey: workspaceTrust.identity.key,
  executionHash: workspaceTrust.executionHash,
});

await loadProjectEnv({ cwd, workspaceTrust, onBlocked });
const loaded = await loadConfig({ cwd, profile, workspaceTrust });
workspaceTrust = loaded.workspaceTrust ?? workspaceTrust;
```

查询型宿主也可使用 `loadConfigWithWorkspaceTrust({ cwd, profile })`，它会读取用户级 trust store 并返回最终 assessment。撤销使用 `trustStore.revoke(cwd)`。

真实 CLI 命令如下：

```bash
anicode trust status --cwd "$PWD"          # 可加 --json
anicode trust grant --cwd "$PWD"           # 必须交互输入 canonical path
anicode trust revoke --cwd "$PWD"          # 可加 --json
```

`trust grant` 不接受 `--json`、管道输入或非 TTY 自动化；模型、hook、MCP 和项目文件都不能
代替用户确认。授信时会把预览 assessment 的 identity/hash 作为乐观并发条件，确认期间若执行面改变，
本次 grant 会拒绝而不是授权新内容。

CLI/TUI 已执行以下门禁，新的宿主接入也必须遵守：

- 仅当 `workspaceTrust.trusted === true` 时，把项目级 `.anicode/plugins`、`.anicode/command`、`.anicode/agents`、`.claude/agents`、`.claude/skills` 交给发现器；用户主目录不是项目来源，但 restricted SessionManager 仍会抑制其中可执行的 skill/custom tool，避免借全局装配绕过受控内置工具集。
- `execution-config-changed`、`workspace-identity-changed`、`inspection-failed` 都按未信任处理；不得提供“继续一次”的隐式绕过。
- 授信必须由真实用户动作触发，模型、hook、MCP 或项目文件不能自行调用 `grant`。
- UI 展示 canonical path 和失效原因，不展示 env 值或配置中的 secret。
- 在授信对话框打开期间若执行面改变，`grant` 后仍应使用返回的 assessment，再由配置加载器二次校验。

Core discovery API 均保留兼容默认值（包含项目），但提供显式门禁：

```ts
const includeProject = workspaceTrust.trusted;
const plugins = await discoverPlugins(cwd, home, { includeProject });
const skills = await discoverSkills(cwd, plugins.skills, { includeProject });
const agents = await discoverSubagents(cwd, plugins.agents, { includeProject });
const commands = await loadCommands({
  cwd,
  home,
  extraDirs: plugins.commands,
  includeProject,
});
const memory = await loadProjectMemory(cwd, { includeProject });
```

`extraDirs` 是宿主明确提供的目录，不会被 discovery API 擅自过滤；未信任宿主只能把上述已门禁的 `plugins.*` 或可信用户目录放入其中。Agent 的 `skills` 与 `subagents` 对象形态也支持 `includeProject: false`。

## SessionManager / daemon / HTTP 强制边界

daemon 与 HTTP 能为每个请求创建不同 cwd，不能复用 CLI 启动时的一次静态判断。生产宿主必须给 `SessionManager` 配置 `workspaceTrust`，可直接传 `WorkspaceTrustStore`，也可传异步 resolver：

```ts
const manager = new SessionManager({
  // ...store / resolveProvider / other options
  workspaceTrust: new WorkspaceTrustStore(),
});

// 等价的多租户/远程 resolver：
const manager = new SessionManager({
  // ...
  workspaceTrust: async (cwd) => trustService.assess(cwd),
});
```

SessionManager 在 `createSession`、cold `resume/open/send`（经 `ensureLive`）以及 fork 时按会话 cwd 评估。resolver 抛错或返回无效 trusted assessment 时按 `inspection-failed` fail closed，最终 assessment 可从 `SessionSnapshot.workspaceTrust` 读取。

未信任会话由 core 强制降级，而非依赖前端自律：

- 对可验证的未信任状态（如 `not-trusted`、`execution-config-changed`），交互式普通入口使用 `default` 逐项授权，而非锁定 `plan`。工具 registry 保留内置 `read`、`glob`、`grep`、`write`、`edit`、`apply_patch`、`bash`、`todo_write`，以及 `bash_output`、`write_stdin`、`list_shells`、`kill_shell` 等 shell 生命周期工具；写入、启动命令和写 shell stdin 必须逐项确认。受限 `bash` 固定使用 workspace-write sandbox，且移除联网参数；
- `inspection-failed` 表示 core 无法证明 workspace identity、配置或 trust store 边界，必须严格 fail closed：即使请求 `default` 也只提供 plan 模式下的 `read`、`glob`、`grep`，不提供写入或 shell；
- 关闭 project memory、repo map、project/user skill 装配、subagent、hooks、browser、checkpoint、LSP、web search、workspace network proxy 与自定义/MCP 工具；
- 关闭 `persistPermissions` 和启动 permission profile；显式 `--auto` / `--accept-edits` 会退回严格只读工具面，运行时 mode/profile 切换也不能扩大 restricted policy，profile 列表为空。无头 CLI 与无交互 MCP 入口无法完成逐项确认时 fail closed；
- 会话级 PatchSet prepare/read/approve/apply/rollback/rebase 全部拒绝，且不执行工作区 patch journal 恢复。内置 `apply_patch` 只是受 PermissionEngine 逐项控制的文件工具，不授予会话级 PatchSet 能力。

未配置 `workspaceTrust` 时保留旧版宿主行为，避免 core API 突然破坏嵌入方；这只是兼容模式，daemon/HTTP 等可接收外部 cwd 的生产入口不得省略该配置。

## 验证与剩余边界

Core 回归覆盖持久化/撤销、私有权限、symlink alias、同路径目录替换、配置/env/项目记忆/插件变化失效、损坏 store fail closed、扩展树 symlink 拒绝及并发 grant 不丢记录。discovery 与 SessionManager 回归另外验证 `includeProject: false`、每 cwd/cold resume 重新评估、resolver 异常 fail closed、受控内置工具集合、逐项权限和 PatchSet 防逃逸。

CLI 交互授权、项目发现器门禁、TUI restricted 状态、Desktop/VS Code 入口，以及本地/HTTP host 的
`workspaceScope` 已接线。仍需由 PermissionEngine、sandbox 与 network policy 控制授信后的实际执行能力。
任何新增的项目级自动加载目录或可执行配置字段，都必须同时加入
`workspaceExecutionFingerprint` 与未信任配置过滤器，并添加失效测试。完整 P0/P1 边界与运维验收见
[Core / TUI / CLI P0/P1 生产化闭环](./2026-08-03-p0-p1-closure.md)。
