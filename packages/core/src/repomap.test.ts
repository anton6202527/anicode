import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractSymbols, buildRepoMap, gatherRepoMap, type SourceFile } from "./repomap.js";

test("repomap: 按语言抽取顶层符号签名", () => {
  const ts = [
    "import x from 'y';",
    "export function foo(a: number): number {",
    "  return a;",
    "}",
    "export class Bar {}",
    "export interface Baz { a: number }",
    "export type Qux = string;",
    "const internal = 1;", // 非 export 的 const 不算顶层 export，但普通 function 算
    "function helper() {}",
  ].join("\n");
  const syms = extractSymbols("a.ts", ts).map((s) => s.name);
  assert.deepEqual(syms.sort(), ["Bar", "Baz", "Qux", "foo", "helper"].sort());

  const py = "def hello():\n    pass\nclass Widget:\n    pass\n";
  assert.deepEqual(
    extractSymbols("a.py", py)
      .map((s) => s.name)
      .sort(),
    ["Widget", "hello"],
  );

  // 未知扩展名 → 空
  assert.equal(extractSymbols("a.txt", "def x").length, 0);
});

test("repomap: 被引用更多的文件/符号排在前，预算截断并标注省略", () => {
  const files: SourceFile[] = [
    // core 被 a、b 都引用 → 重要度高，应排在前
    { path: "core.ts", content: "export function core() {}" },
    { path: "a.ts", content: "export function a() {\n  core();\n}" },
    { path: "b.ts", content: "export function b() {\n  core();\n}" },
  ];
  const map = buildRepoMap(files, { tokenBudget: 1000 });
  assert.match(map, /^<repo-map>/);
  assert.match(map, /<\/repo-map>$/);
  // core.ts 出现在 a.ts / b.ts 之前（引用更多）
  assert.ok(map.indexOf("core.ts:") < map.indexOf("a.ts:"), "core.ts 应排在前");
  // 极小预算 → 只画第一个文件并标注省略
  const tiny = buildRepoMap(files, { tokenBudget: 8 });
  assert.match(tiny, /more files/);
});

test("repomap: gatherRepoMap 跳过 node_modules 等目录，只收源文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-"));
  await fs.writeFile(path.join(dir, "keep.ts"), "export function keep() {}\n");
  await fs.mkdir(path.join(dir, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "node_modules", "pkg", "index.ts"),
    "export function nope() {}\n",
  );
  await fs.mkdir(path.join(dir, "dist"), { recursive: true });
  await fs.writeFile(path.join(dir, "dist", "bundle.js"), "export function alsoNope() {}\n");

  const map = await gatherRepoMap(dir);
  assert.match(map, /keep\.ts:/);
  assert.doesNotMatch(map, /nope/);
  assert.doesNotMatch(map, /bundle\.js/);

  await fs.rm(dir, { recursive: true, force: true });
});
