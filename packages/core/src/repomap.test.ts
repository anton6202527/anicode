import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import {
  extractSymbols,
  buildRepoMap,
  gatherRepoMap,
  prewarmRepoMap,
  type SourceFile,
} from "./repomap.js";

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

test("repomap: 自然语言 query 无标识符命中时仍返回稳定代码骨架", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-query-"));
  try {
    await fs.writeFile(path.join(dir, "core.ts"), "export function dispatchRequest() {}\n");
    await fs.writeFile(
      path.join(dir, "caller.ts"),
      "export function run() { return dispatchRequest(); }\n",
    );

    const map = await gatherRepoMap(dir, { query: "优化响应速度" });
    assert.match(map, /core\.ts:/);
    assert.match(map, /dispatchRequest/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("repomap: 暖 generation 立即返回并在后台刷新，显式预热等待同一刷新", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-swr-"));
  try {
    const source = path.join(dir, "service.ts");
    await fs.writeFile(source, "export function cachedGeneration() {}\n");
    const opts = { query: "generation", maxStaleMs: 60_000 };
    const initial = await gatherRepoMap(dir, opts);
    assert.match(initial, /cachedGeneration/);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(source, "export function refreshedGenerationWithLongerName() {}\n");

    // A warm request renders the already adopted generation before scheduling filesystem I/O.
    const stale = await gatherRepoMap(dir, opts);
    assert.match(stale, /cachedGeneration/);
    assert.doesNotMatch(stale, /refreshedGenerationWithLongerName/);

    // Prewarm joins the in-flight refresh instead of starting duplicate traversal work.
    await prewarmRepoMap(dir, opts);
    const fresh = await gatherRepoMap(dir, opts);
    assert.match(fresh, /refreshedGenerationWithLongerName/);
    assert.doesNotMatch(fresh, /cachedGeneration/);
    await prewarmRepoMap(dir, opts);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("repomap: production cold-start budget skips an unfinished optional map", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-cold-budget-"));
  try {
    await fs.writeFile(path.join(dir, "cold.ts"), "export function availableAfterPrewarm() {}\n");
    const opts = { maxStaleMs: 60_000, coldStartTimeoutMs: 0 };

    assert.equal(await gatherRepoMap(dir, opts), "");
    await prewarmRepoMap(dir, opts);
    assert.match(await gatherRepoMap(dir, opts), /availableAfterPrewarm/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("repomap: cold-start budget yields during CPU-heavy indexing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-cpu-budget-"));
  const fileCount = 64;
  const fileBytes = 250 * 1024;
  const budgetMs = 25;
  const schedulingToleranceMs = 75;
  try {
    await Promise.all(
      Array.from({ length: fileCount }, (_, index) => {
        const prefix = `export function cpuBudgetSymbol${index}() { return cpuBudgetDependency; }\n`;
        const repeated = "const cpuBudgetIdentifier = cpuBudgetDependency;\n";
        const content = (prefix + repeated.repeat(Math.ceil(fileBytes / repeated.length))).slice(
          0,
          fileBytes,
        );
        return fs.writeFile(path.join(dir, `cpu-${String(index).padStart(3, "0")}.ts`), content);
      }),
    );

    const options = {
      maxFiles: fileCount,
      maxFileBytes: 256 * 1024,
      maxTotalSourceBytes: 16 * 1024 * 1024,
      maxStaleMs: 0,
      coldStartTimeoutMs: budgetMs,
      query: "cpu budget",
    };
    const startedAt = performance.now();
    const first = await gatherRepoMap(dir, options);
    const elapsedMs = performance.now() - startedAt;

    assert.equal(first, "", "CPU-heavy cold generation should remain optional at the deadline");
    assert.ok(
      elapsedMs <= budgetMs + schedulingToleranceMs,
      `cold repo-map took ${elapsedMs.toFixed(1)}ms for a ${budgetMs}ms budget`,
    );

    await prewarmRepoMap(dir, options);
    const ready = await gatherRepoMap(dir, {
      maxFiles: fileCount,
      maxFileBytes: 256 * 1024,
      maxTotalSourceBytes: 16 * 1024 * 1024,
      maxStaleMs: 0,
      query: "cpu budget",
    });
    assert.match(ready, /cpuBudgetSymbol/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("repomap: missing workspace root degrades to an empty optional contribution", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-missing-root-"));
  try {
    assert.equal(await gatherRepoMap(path.join(parent, "does-not-exist")), "");
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("repomap: 同路径工作区被替换时不得复用旧 inode 的 generation", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-identity-"));
  const root = path.join(parent, "workspace");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "main.ts"), "export function oldWorkspaceSymbol() {}\n");
    const oldMap = await gatherRepoMap(root, { maxStaleMs: 60_000 });
    assert.match(oldMap, /oldWorkspaceSymbol/);

    await fs.rename(root, path.join(parent, "replaced-workspace"));
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "main.ts"), "export function newWorkspaceSymbol() {}\n");
    const newMap = await gatherRepoMap(root, { maxStaleMs: 60_000 });
    assert.match(newMap, /newWorkspaceSymbol/);
    assert.doesNotMatch(newMap, /oldWorkspaceSymbol/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});

test("repomap: maxStaleMs=0 保持请求内强制刷新语义", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-blocking-"));
  try {
    const source = path.join(dir, "service.ts");
    await fs.writeFile(source, "export function beforeBlockingRefresh() {}\n");
    await gatherRepoMap(dir, { maxStaleMs: 60_000 });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(source, "export function afterBlockingRefreshWithLongerName() {}\n");
    const refreshed = await gatherRepoMap(dir, { maxStaleMs: 0 });
    assert.match(refreshed, /afterBlockingRefreshWithLongerName/);
    assert.doesNotMatch(refreshed, /beforeBlockingRefresh/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("repomap: 重型图缓存超限时快速降级为轻量代码骨架", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-fallback-"));
  try {
    await fs.writeFile(path.join(dir, "keep.ts"), "export function keepWorking() {}\n");
    const map = await gatherRepoMap(dir, {
      incremental: true,
      maxCacheBytes: 1,
      query: "keep",
    });
    assert.match(map, /keep\.ts:/);
    assert.match(map, /keepWorking/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("repomap: .anicode symlink 不得把派生索引写入宿主目标", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-boundary-"));
  const host = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-repomap-host-"));
  await fs.writeFile(path.join(dir, "keep.ts"), "export function keep() {}\n");
  await fs.writeFile(path.join(host, "HOST_CANARY"), "unchanged\n");
  await fs.symlink(host, path.join(dir, ".anicode"));

  const map = await gatherRepoMap(dir);
  assert.match(map, /keep\.ts:/);
  assert.deepEqual(await fs.readdir(host), ["HOST_CANARY"]);
  assert.equal(await fs.readFile(path.join(host, "HOST_CANARY"), "utf8"), "unchanged\n");

  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(host, { recursive: true, force: true });
});
