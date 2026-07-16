/**
 * 内置任务子集（Aider-polyglot 精神的最小离线版）。
 *
 * 每个任务都自带 `verify.mjs` 校验脚本，只用 node 标准库断言，零依赖、可离线跑。
 * 增补任务只需往这个数组里加条目——harness 与报告自动覆盖。
 */
import type { EvalTask } from "../task.js";

export const BUILTIN_TASKS: EvalTask[] = [
  {
    id: "implement-add",
    title: "实现一个求和函数使测试通过",
    prompt:
      "文件 math.mjs 里的 add(a, b) 还没实现。请把它实现为返回两数之和。改完后 `node verify.mjs` 应当通过。",
    files: {
      "math.mjs": "export function add(a, b) {\n  // TODO: 实现\n}\n",
      "verify.mjs":
        "import { add } from './math.mjs';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(add(2, 3), 5);\n" +
        "assert.equal(add(-1, 1), 0);\n" +
        "assert.equal(add(0, 0), 0);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
  },
  {
    id: "fix-off-by-one",
    title: "修复一个 off-by-one 缺陷",
    prompt:
      "sum.mjs 里的 sumTo(n) 应返回 1..n 的和，但结果偏小。请修复它，使 `node verify.mjs` 通过。",
    files: {
      "sum.mjs":
        "export function sumTo(n) {\n" +
        "  let s = 0;\n" +
        "  for (let i = 1; i < n; i++) s += i;\n" +
        "  return s;\n" +
        "}\n",
      "verify.mjs":
        "import { sumTo } from './sum.mjs';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(sumTo(1), 1);\n" +
        "assert.equal(sumTo(5), 15);\n" +
        "assert.equal(sumTo(10), 55);\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
  },
  {
    id: "multi-file-wire",
    title: "跨两个文件接线一个导出",
    prompt:
      "index.mjs 需要从 ./slug.mjs 导入并重新导出一个 slugify(s) 函数，但 slug.mjs 还是空的。" +
      "请在 slug.mjs 实现 slugify（小写、非字母数字转连字符、去掉首尾连字符），并在 index.mjs 里导出它，" +
      "使 `node verify.mjs` 通过。",
    files: {
      "slug.mjs": "// 在这里实现并导出 slugify\n",
      "index.mjs": "// 从 ./slug.mjs 重新导出 slugify\n",
      "verify.mjs":
        "import { slugify } from './index.mjs';\n" +
        "import assert from 'node:assert/strict';\n" +
        "assert.equal(slugify('Hello World'), 'hello-world');\n" +
        "assert.equal(slugify('  A_B c '), 'a-b-c');\n" +
        "console.log('ok');\n",
    },
    verify: { cmd: "node", args: ["verify.mjs"] },
  },
];
