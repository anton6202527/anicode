# Changesets

本目录记录待发布的变更。发布的 npm 包只有 `anicode`（CLI）——它用 esbuild 把
`@anicode/core` / `tui` / `shared` 一并打进产物，因此其余包标记为 private 且在
`config.json` 的 `ignore` 里，不单独发版。

## 加一条变更

```bash
npm run changeset
```

按提示选 `anicode`、选 semver 级别（patch/minor/major）、写一句面向用户的说明。
会在本目录生成一个 markdown 文件，随代码一起提交。

## 发布流程

合并到 `main` 后，CI 的 release 工作流用 changesets/action 打开一个「Version
Packages」PR（累计变更 + 更新 CHANGELOG + 升版本号）；合并该 PR 即触发
隔离的 npm Trusted Publishing job。该 job 使用 GitHub OIDC 短期身份和 provenance，
不 checkout 或执行仓库代码；需先在 npm 包设置中绑定本仓库的 release workflow。
本地 `npm run release` 与 `npm publish` 默认 fail closed，不能代替上述不可变产物链路。

VSCode 扩展（`.vsix`）与 Electron 安装包不走 npm：

- `.vsix` 在发布 GitHub Release 时由 release 工作流构建并作为产物上传。
- Electron 安装包在 GitHub Release 时由 CI 构建；macOS 强制签名与公证，Windows 强制签名，
  缺少受保护的发布凭证会让 release job 失败。
