import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parsePatch, applyHunks, patchPaths, applyPatchTool } from "./apply-patch.js";

const ctx = (cwd: string) => ({ cwd, signal: new AbortController().signal });

test("apply_patch: parsePatch 识别 Add/Update/Delete", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: a.txt",
    "+hello",
    "+world",
    "*** Update File: b.ts",
    "@@",
    " keep",
    "-old",
    "+new",
    "*** Delete File: c.txt",
    "*** End Patch",
  ].join("\n");
  const ops = parsePatch(patch);
  assert.equal(ops.length, 3);
  assert.deepEqual(ops[0], { kind: "add", path: "a.txt", lines: ["hello", "world"] });
  assert.equal(ops[1]!.kind, "update");
  assert.deepEqual(patchPaths(patch), ["a.txt", "b.ts", "c.txt"]);
});

test("apply_patch: applyHunks 精确定位替换", () => {
  const content = "line1\nold\nline3\n";
  const [op] = parsePatch(
    [
      "*** Begin Patch",
      "*** Update File: x",
      "@@",
      " line1",
      "-old",
      "+new",
      " line3",
      "*** End Patch",
    ].join("\n"),
  );
  const updated = applyHunks(content, (op as any).hunks);
  assert.equal(updated, "line1\nnew\nline3\n");
});

test("apply_patch: applyHunks 前后空白容差模糊定位（缩进不一致也能命中）", () => {
  const content = "def f():\n        return 1\n"; // 文件缩进 8 空格
  const [op] = parsePatch(
    [
      "*** Begin Patch",
      "*** Update File: x",
      "@@",
      "-    return 1",
      "+    return 2",
      "*** End Patch",
    ].join("\n"),
  );
  // 补丁写 4 空格缩进，靠按行去首尾空白匹配上（内部空白仍需一致）。
  const updated = applyHunks(content, (op as any).hunks);
  assert.match(updated, /return 2/);
});

test("apply_patch: 定位失败抛反射式错误", () => {
  const content = "totally different\n";
  const [op] = parsePatch(
    [
      "*** Begin Patch",
      "*** Update File: x",
      "@@",
      "-nonexistent line",
      "+z",
      "*** End Patch",
    ].join("\n"),
  );
  assert.throws(() => applyHunks(content, (op as any).hunks), /定位失败/);
});

test("apply_patch: 缺 Begin/End 头尾报错", () => {
  assert.throws(() => parsePatch("*** Add File: a\n+x"), /Begin Patch/);
  assert.throws(() => parsePatch("*** Begin Patch\n*** Add File: a\n+x"), /End Patch/);
});

test("apply_patch: 工具端到端 增/改/删 + 越界拒绝", async () => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "anicode-patch-")));
  try {
    await fs.writeFile(path.join(dir, "b.ts"), "keep\nold\ntail\n");
    await fs.writeFile(path.join(dir, "c.txt"), "bye\n");
    const patch = [
      "*** Begin Patch",
      "*** Add File: sub/a.txt",
      "+new file",
      "*** Update File: b.ts",
      "@@",
      " keep",
      "-old",
      "+brand new",
      "*** Delete File: c.txt",
      "*** End Patch",
    ].join("\n");
    const out = await applyPatchTool.run({ patch }, ctx(dir));
    assert.match(out, /新增 sub\/a\.txt/);
    assert.match(out, /修改 b\.ts/);
    assert.match(out, /删除 c\.txt/);
    assert.equal(await fs.readFile(path.join(dir, "sub/a.txt"), "utf8"), "new file");
    assert.equal(await fs.readFile(path.join(dir, "b.ts"), "utf8"), "keep\nbrand new\ntail\n");
    assert.equal(
      await fs.access(path.join(dir, "c.txt")).then(
        () => true,
        () => false,
      ),
      false,
    );

    // 越界路径被拒绝
    const bad = ["*** Begin Patch", "*** Add File: ../escape.txt", "+x", "*** End Patch"].join(
      "\n",
    );
    await assert.rejects(() => applyPatchTool.run({ patch: bad }, ctx(dir)), /越界/);

    // Add 已存在文件被拒绝
    const dup = ["*** Begin Patch", "*** Add File: b.ts", "+x", "*** End Patch"].join("\n");
    await assert.rejects(() => applyPatchTool.run({ patch: dup }, ctx(dir)), /已存在/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
