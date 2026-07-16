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
`npm publish`（需仓库配置 `NPM_TOKEN`）。

VSCode 扩展（`.vsix`）与 Electron 安装包不走 npm：
- `.vsix` 在发布 GitHub Release 时由 release 工作流构建并作为产物上传。
- Electron 安装包用 `npm run --workspace @anicode/app dist` 本地/按需构建（多平台签名不在 CI）。
