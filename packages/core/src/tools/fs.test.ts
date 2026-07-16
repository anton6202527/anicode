/**
 * 沙箱边界测试 —— 这是安全护栏，必须用测试钉死：
 *   - ../ 目录穿越被拒
 *   - cwd 内指向外部的符号链接被拒（纯字符串检查挡不住的那类逃逸）
 *   - 经 symlink 目录写新文件也被拒
 *   - 正常读写不受影响
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTool, writeTool, editTool, applyEdit } from "./fs.js";

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sbx-"));
  const root = path.join(base, "root"); // 沙箱 cwd
  const outside = path.join(base, "outside"); // 沙箱外
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "机密内容");
  await fs.writeFile(path.join(root, "ok.txt"), "正常内容");
  return { base, root, outside };
}

test("沙箱: ../ 穿越被拒", async () => {
  const { base, root } = await setup();
  await assert.rejects(
    () => readTool.run({ path: "../outside/secret.txt" }, ctx(root)),
    /路径越界/,
  );
  await fs.rm(base, { recursive: true, force: true });
});

test("沙箱: 符号链接文件逃逸被拒（读）", async () => {
  const { base, root, outside } = await setup();
  // cwd 内创建一个指向外部机密文件的 symlink —— 字面路径在 cwd 内，真实落点在外
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "innocent.txt"));
  await assert.rejects(
    () => readTool.run({ path: "innocent.txt" }, ctx(root)),
    /符号链接|路径越界/,
  );
  await fs.rm(base, { recursive: true, force: true });
});

test("沙箱: 经符号链接目录写新文件被拒（写）", async () => {
  const { base, root, outside } = await setup();
  await fs.symlink(outside, path.join(root, "linkdir"));
  await assert.rejects(
    () => writeTool.run({ path: "linkdir/evil.txt", content: "x" }, ctx(root)),
    /符号链接|路径越界/,
  );
  // 确认外部没被写入
  await assert.rejects(() => fs.access(path.join(outside, "evil.txt")));
  await fs.rm(base, { recursive: true, force: true });
});

test("沙箱: 符号链接逃逸对 edit 同样生效", async () => {
  const { base, root, outside } = await setup();
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "innocent.txt"));
  await assert.rejects(
    () => editTool.run({ path: "innocent.txt", old_string: "机密", new_string: "改" }, ctx(root)),
    /符号链接|路径越界/,
  );
  assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "机密内容");
  await fs.rm(base, { recursive: true, force: true });
});

test("沙箱: 正常读写/新建子目录文件不受影响", async () => {
  const { base, root } = await setup();
  const read = await readTool.run({ path: "ok.txt" }, ctx(root));
  assert.match(read, /正常内容/);

  await writeTool.run({ path: "sub/dir/new.txt", content: "深层新文件" }, ctx(root));
  assert.equal(await fs.readFile(path.join(root, "sub", "dir", "new.txt"), "utf8"), "深层新文件");

  await editTool.run({ path: "ok.txt", old_string: "正常", new_string: "编辑后" }, ctx(root));
  assert.equal(await fs.readFile(path.join(root, "ok.txt"), "utf8"), "编辑后内容");

  await fs.rm(base, { recursive: true, force: true });
});

test("applyEdit: 精确唯一匹配", () => {
  const r = applyEdit("a\nfoo\nb", "foo", "bar", false);
  assert.equal(r.mode, "exact");
  assert.equal(r.replaced, 1);
  assert.equal(r.updated, "a\nbar\nb");
});

test("applyEdit: 精确多处不唯一时报错，replace_all 全替换", () => {
  assert.throws(() => applyEdit("x\nx", "x", "y", false), /不唯一/);
  const r = applyEdit("x\nx", "x", "y", true);
  assert.equal(r.replaced, 2);
  assert.equal(r.updated, "y\ny");
});

test("applyEdit: 精确失败时按行空白容差模糊匹配", () => {
  // 文件里是 4 空格缩进，模型给的 old_string 缩进不同 → 精确失败、模糊命中。
  const content = "function f() {\n    return 1\n}";
  const r = applyEdit(
    content,
    "function f() {\nreturn 1\n}",
    "function f() {\n    return 2\n}",
    false,
  );
  assert.equal(r.mode, "fuzzy");
  assert.equal(r.updated, "function f() {\n    return 2\n}");
});

test("applyEdit: 全都匹配不上时抛反射式错误，附最接近片段", () => {
  const content = "line one\nline two\nline three";
  try {
    applyEdit(content, "line tvvo", "x", false);
    assert.fail("应抛错");
  } catch (err) {
    const msg = String((err as Error).message);
    assert.match(msg, /未找到 old_string/);
    // 反射：把文件里最接近的片段展示出来供模型自我纠正
    assert.match(msg, /最接近的片段/);
  }
});
