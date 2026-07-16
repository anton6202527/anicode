# @anicode/eval

编辑准确率评测 harness。用**真实的 agent loop**（core 的 Agent + 默认工具 + 权限
bypass）跑一组自带校验的编辑任务，量化：

- **通过率**（校验命令退出码 0 的任务占比）
- **平均轮数**（模型 loop 轮数）
- **token**（in/out 累计）
- **编辑失败率**（编辑类工具返回 isError 的次数 / 编辑类工具调用次数）

核心用途：**证明改动是否真的变好**。改了系统提示词 / 工具 / 编辑策略后再跑一遍，
比对同一模型下的这几项指标——因为「同一模型换 harness，分数摆动 15–20 分」，
没有 eval 就无法判断 scaffolding 改动的好坏。

## 跑真实评测

```bash
npm run eval -- --model anthropic/claude-opus-4-8
npm run eval -- --model openai/gpt-5.5 --tasks implement-add,fix-off-by-one --json out.json
```

- `--model <provider/model>` 走 core 的 provider registry（需对应凭证）。
- `--tasks id1,id2` 只跑子集；缺省跑全部内置任务。
- `--max-turns N` 单任务轮数上限（默认 30）。
- `--json <file>` 导出结构化结果供 A/B 对比。
- 全通过退出 0，否则 1（便于接门禁）。

## 加任务

往 `src/tasks/builtin.ts` 的数组加条目即可。每个任务自带 `verify.mjs`（只用 node
标准库断言，零依赖离线可跑），退出码 0 视为通过。

## 离线自测

`npm test` 用脚本化 provider 驱动真实 loop，验证「编辑 → 校验 → 指标」管线本身正确，
且能区分正确编辑 / 错误编辑 / 不编辑三种情况——无需真实模型，随 CI 一起跑。
