import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expandFileMentions } from "./mentions.js";

test("mentions: 展开 @文件，拼接内容并标注缺失", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-at-"));
  await fs.writeFile(path.join(dir, "a.txt"), "hello");
  const { text, missing } = await expandFileMentions("看看 @a.txt 和 @nope.txt", dir);
  assert.match(text, /看看 @a.txt 和 @nope.txt/); // 原文保留
  assert.match(text, /=== a.txt ===\nhello/); // 追加内容
  assert.deepEqual(missing, ["nope.txt"]);
  await fs.rm(dir, { recursive: true, force: true });
});

test("mentions: 无 @ 时原样返回；拒绝逃逸 cwd", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-at-"));
  const r1 = await expandFileMentions("普通消息 no mention", dir);
  assert.equal(r1.text, "普通消息 no mention");
  assert.deepEqual(r1.missing, []);
  const r2 = await expandFileMentions("@../../etc/hosts", dir);
  assert.deepEqual(r2.missing, ["../../etc/hosts"]); // 逃逸被判为 missing
  assert.equal(r2.text, "@../../etc/hosts"); // 不追加内容
  await fs.rm(dir, { recursive: true, force: true });
});

test("mentions: 拒绝通过工作区内符号链接读取外部文件", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-at-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-at-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "outside-secret", "utf8");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "escape.txt"));
  try {
    const result = await expandFileMentions("inspect @escape.txt", dir);
    assert.equal(result.text, "inspect @escape.txt");
    assert.deepEqual(result.missing, ["escape.txt"]);
    assert.doesNotMatch(result.text, /outside-secret/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
