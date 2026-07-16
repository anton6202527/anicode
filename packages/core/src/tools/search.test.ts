import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { grepTool, globTool, readTool } from "./fs.js";
import type { ToolContext } from "./tool.js";

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

async function scratch(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("grep content 模式返回 文件:行号:内容", async () => {
  const dir = await scratch("anicode-grep-content-");
  await fs.writeFile(path.join(dir, "a.ts"), "const x = 1\nfunction foo() {}\nconst y = 2\n");
  const out = await grepTool.run({ pattern: "function foo" }, ctx(dir));
  assert.match(out, /a\.ts:2:function foo/);
});

test("grep files_with_matches 只列命中文件", async () => {
  const dir = await scratch("anicode-grep-files-");
  await fs.writeFile(path.join(dir, "a.ts"), "needle here\nmore\n");
  await fs.writeFile(path.join(dir, "b.ts"), "nothing\n");
  const out = await grepTool.run(
    { pattern: "needle", output_mode: "files_with_matches" },
    ctx(dir),
  );
  assert.match(out, /a\.ts/);
  assert.doesNotMatch(out, /b\.ts/);
  assert.doesNotMatch(out, /:\d+:/); // 不含行号:内容
});

test("grep count 模式返回每文件命中数", async () => {
  const dir = await scratch("anicode-grep-count-");
  await fs.writeFile(path.join(dir, "a.ts"), "hit\nhit\nmiss\nhit\n");
  const out = await grepTool.run({ pattern: "hit", output_mode: "count" }, ctx(dir));
  assert.match(out, /a\.ts:3/);
});

test("grep ignore_case 忽略大小写", async () => {
  const dir = await scratch("anicode-grep-ci-");
  await fs.writeFile(path.join(dir, "a.ts"), "HELLO world\n");
  const hit = await grepTool.run({ pattern: "hello", ignore_case: true }, ctx(dir));
  assert.match(hit, /a\.ts:1/);
  const miss = await grepTool.run({ pattern: "hello" }, ctx(dir));
  assert.match(miss, /无匹配/);
});

test("grep context 附带前后行", async () => {
  const dir = await scratch("anicode-grep-ctx-");
  await fs.writeFile(path.join(dir, "a.ts"), "line1\nline2\nTARGET\nline4\nline5\n");
  const out = await grepTool.run({ pattern: "TARGET", context: 1 }, ctx(dir));
  assert.match(out, /line2/);
  assert.match(out, /TARGET/);
  assert.match(out, /line4/);
});

test("grep glob 限定文件类型", async () => {
  const dir = await scratch("anicode-grep-glob-");
  await fs.writeFile(path.join(dir, "a.ts"), "target\n");
  await fs.writeFile(path.join(dir, "a.md"), "target\n");
  const out = await grepTool.run({ pattern: "target", glob: "*.ts" }, ctx(dir));
  assert.match(out, /a\.ts/);
  assert.doesNotMatch(out, /a\.md/);
});

test("grep 空结果给出明确提示", async () => {
  const dir = await scratch("anicode-grep-empty-");
  await fs.writeFile(path.join(dir, "a.ts"), "nothing\n");
  const out = await grepTool.run({ pattern: "zzzznope" }, ctx(dir));
  assert.match(out, /无匹配/);
});

test("glob 匹配文件并按需返回相对路径", async () => {
  const dir = await scratch("anicode-glob-");
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "a.ts"), "x");
  await fs.writeFile(path.join(dir, "src", "b.js"), "x");
  const out = await globTool.run({ pattern: "**/*.ts" }, ctx(dir));
  assert.match(out, /src\/a\.ts/);
  assert.doesNotMatch(out, /b\.js/);
});

test("read 识别二进制文件而非返回乱码", async () => {
  const dir = await scratch("anicode-read-bin-");
  await fs.writeFile(path.join(dir, "bin"), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]));
  const out = await readTool.run({ path: "bin" }, ctx(dir));
  assert.match(out, /二进制/);
});

test("read 截断超长单行", async () => {
  const dir = await scratch("anicode-read-longline-");
  await fs.writeFile(path.join(dir, "big.txt"), "a".repeat(5000) + "\n");
  const out = await readTool.run({ path: "big.txt" }, ctx(dir));
  assert.match(out, /已截断/);
  assert.ok(out.length < 5000, "超长行应被截断");
});
