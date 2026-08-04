# @anicode/eval

编辑准确率评测 harness。用**真实的 agent loop**（core 的 Agent + 默认工具 + 权限
bypass）跑一组自带校验的编辑任务，量化：

- **通过率**（校验命令退出码 0 的任务占比；缺工具链跳过的任务不进分母）
- **平均轮数**（模型 loop 轮数）
- **token**（in/out 累计）
- **编辑失败率**（编辑类工具返回 isError 的次数 / 编辑类工具调用次数）
- **Outcome**（command / SWE-bench 的确定性结果，明确区分失败、agent error 与 timeout）
- **Trajectory**（工具顺序、参数/结果哈希、重试、fallback、压缩、授权拒绝、终态完成率）
- **Final response**（是否存在、是否在确定性失败时仍明确宣称完成）
- **多 trial 稳定性**（稳定通过率、flaky 率、trial 间方差、trajectory diversity）

结果 JSON 不保存工具参数、工具输出或最终回答原文，只保存长度与 SHA-256。这样既能
比较执行轨迹，又不会把代码、命令或凭证复制到长期 CI artifact。

核心用途：**证明改动是否真的变好**。改了系统提示词 / 工具 / 编辑策略后再跑一遍，
比对同一模型下的这几项指标——因为「同一模型换 harness，分数摆动 15–20 分」，
没有 eval 就无法判断 scaffolding 改动的好坏。

## 任务矩阵

16 个内置任务：**4 语言 × 4 类型**。

|           | JS (node)                             | TS (node strip-types) | Python (python3)       | Go (go run)                              |
| --------- | ------------------------------------- | --------------------- | ---------------------- | ---------------------------------------- |
| implement | implement-add                         | ts-implement-lru      | py-implement-slugify   | go-implement-reverse / go-wire-titlecase |
| fix       | fix-off-by-one                        | ts-fix-first-defined  | py-fix-mutable-default | go-fix-nil-map                           |
| debug     | js-debug-sort                         | ts-debug-chunk        | py-debug-window-sum    | go-debug-truncate                        |
| refactor  | multi-file-wire / js-refactor-extract | —                     | py-refactor-split      | —                                        |

- **debug 类**要求先运行校验复现失败再定位（驱动 bash→read→edit 完整工具链）。
- **refactor 类**校验既查行为也查源码结构（确实抽走了、确实改成导入了）。
- 缺 `python3`/`go` 时对应任务**跳过**而非失败（`requires` 声明 + PATH 探测）。
- **防作弊**：跑校验前把校验脚本从种子恢复，agent 改 verify 文件不算通过。

## 跑真实评测

```bash
npm run eval -- --model anthropic/claude-opus-4-8
npm run eval -- --model openai/gpt-5.5 --lang go,py --kind debug --json out.json
npm run eval -- --model anthropic/claude-opus-4-8 --repomap --json with-map.json  # A/B repomap
npm run eval -- --model anthropic/claude-opus-4-8 --trials 3 --json eval-result.json
npm run eval -- --model anthropic/claude-opus-4-8 --trials 3 \
  --baseline packages/eval/baseline.json \
  --baseline-manifest packages/eval/baseline.manifest.json                       # 守回归
```

- `--model <provider/model>` 走 core 的 provider registry（需对应凭证）。
- `--tasks id1,id2` / `--lang js,go` / `--kind fix,debug` 按 id/语言/类型筛选。
- `--max-turns N` 单任务轮数上限（默认 30）。
- `--trials N` 每个任务重复运行次数（1–20）；生产 canary 默认跑 3 次。
- `--repomap` 给 Agent 开 repo map，报告标注 `(repomap)`——用于 A/B scaffolding。
- `--json <file>` 导出结构化结果供 A/B 对比。
- `--baseline <file>` 必须同时提供 reviewed `--baseline-manifest <file>`；摘要、profile 或
  SHA-256 不匹配会 fail closed。门禁同时检查 exact task×trial 覆盖、catalog digest、outcome、
  稳定性、trajectory、final response、轮数、token 与编辑失败率。
- 无基线时全通过退出 0，否则 1（便于接门禁）。

## 生成与审核基线

评测命令**不会**把一次真实模型结果直接升级为受信基线，旧的
`--bootstrap-baseline` 已 fail closed。标准流程是：

```bash
# 1. 从固定 revision 跑真实模型；这一步需要真实凭证，不能伪造结果
ANICODE_EVAL_REVISION="$(git rev-parse HEAD)" \
  npm run eval -- --model <provider/model> --trials 3 --json eval-result.json

# 2. 生成未审核 candidate + candidate manifest
npm run eval:baseline --workspace @anicode/eval -- create \
  --result eval-result.json \
  --candidate packages/eval/baseline.candidate.json \
  --manifest packages/eval/baseline.candidate.manifest.json \
  --source-run-url https://github.com/<org>/<repo>/actions/runs/<id>

# 3. 人工检查任务明细、失败、费用和 artifact 后显式批准
npm run eval:baseline --workspace @anicode/eval -- approve \
  --candidate packages/eval/baseline.candidate.json \
  --candidate-manifest packages/eval/baseline.candidate.manifest.json \
  --baseline packages/eval/baseline.json \
  --manifest packages/eval/baseline.manifest.json \
  --reviewer <reviewer-identity> \
  --source-run-url https://github.com/<org>/<repo>/actions/runs/<id> \
  --signing-key-file /secure/path/eval-baseline-ed25519.pem \
  --signing-key-id <externally-trusted-key-id>

# 4. 与 CI 相同的离线完整性校验
ANICODE_EVAL_BASELINE_TRUSTED_KEYS='{"<externally-trusted-key-id>":"<base64-ed25519-spki>"}' \
  npm run eval:baseline --workspace @anicode/eval -- verify \
  --baseline packages/eval/baseline.json \
  --manifest packages/eval/baseline.manifest.json
```

`approve` 需要由离线保存的 Ed25519 私钥签名；CI 从受保护的
`ANICODE_EVAL_BASELINE_TRUSTED_KEYS` repository variable 读取公钥信任根。仅有 reviewer 或 URL
字符串的 manifest 不受信任。manifest 绑定 exact SHA-256、模型、suite、catalog digest、完整
task set、runtime image、trial 数、source revision、Actions run URL、reviewer、时间和签名。
含 skipped trial、本地 revision、汇总值与明细不一致、任务集不完整、或通过结果没有确定性证据的
candidate 都会被拒绝。

## CI 集成

- **PR（离线）**：`npm test` 里的自检不依赖模型，随 CI 每次跑——包括「编辑→校验→指标」
  管线回归、防作弊校验、以及**任务自检**（下节）。
- **Nightly（真模型）**：`.github/workflows/eval-nightly.yml` 每晚跑 3 trials 全矩阵。
  未启用、模型/Vault 配置缺失、baseline/manifest 缺失或校验失败都会红，不再静默跳过。
- **真实仓库**：工作日 40-task × 3 trials canary；周日 280-task × 1 full matrix。不同
  task/trial profile 使用独立的 `baselines/real-<tasks>-t<trials>.{json,manifest.json}`，
  不允许拿不可比基线套用。长期 artifact 只保留 SWE-bench evaluator 输出的长度、分类与 SHA-256，
  不保留原始 stdout/stderr。

## 加任务

往 `src/tasks/{js,ts,python,go}.ts` 对应数组加条目。每个任务必须带 `solution` 参考解，
自检（`tasks.selftest.test.ts`）会自动守两条不变量：

1. **种子原样跑校验必须失败**——任务不能「白给」；
2. **应用参考解后校验必须通过**——任务可解、校验正确。

校验脚本只用对应语言标准库（node / python3 / go），零外部依赖离线可跑。

## 长期锚点

自建任务守**相对回归**，外部基准定**绝对水平**。后续可把
[Terminal-Bench](https://www.tbench.ai/)（Docker 隔离、16 类 89 任务）作为季度性
对外可比分数——两者互补，自建矩阵不追求覆盖它。
