/**
 * 内置任务集：JS/TS/Python/Go × 实现/修复/调试/重构 的任务矩阵。
 *
 * 每个任务自带校验脚本（node / python3 / go 标准工具链，零外部依赖），并附
 * solution 参考解供离线自检（见 tasks.selftest.test.ts）。缺工具链的任务运行时跳过。
 * 增补任务只需往对应语言文件里加条目——harness、自检与报告自动覆盖。
 */
import type { EvalTask } from "../task.js";
import { JS_TASKS } from "./js.js";
import { TS_TASKS } from "./ts.js";
import { PY_TASKS } from "./python.js";
import { GO_TASKS } from "./go.js";
import { SCALED_TASKS } from "./scaled.js";

export const BUILTIN_TASKS: EvalTask[] = [
  ...JS_TASKS,
  ...TS_TASKS,
  ...PY_TASKS,
  ...GO_TASKS,
  ...SCALED_TASKS,
];
