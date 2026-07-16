import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { SnapshotStore } from "./snapshot.js";

async function tempRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "anicode-snap-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return dir;
}

test("snapshot: 非 git 目录 take 返回 null，不报错", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-nogit-"));
  try {
    const store = new SnapshotStore(dir);
    assert.equal(await store.isAvailable(), false);
    assert.equal(await store.take("x"), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("snapshot: take→改动→restore 精确还原（改/删/增/被忽略文件）", async () => {
  const dir = await tempRepo();
  const w = (f: string, c: string) => fs.writeFile(path.join(dir, f), c);
  const exists = async (f: string) =>
    fs.access(path.join(dir, f)).then(
      () => true,
      () => false,
    );
  const read = (f: string) => fs.readFile(path.join(dir, f), "utf8");
  try {
    await w("keep.txt", "v1\n");
    await w("mod.txt", "original\n");
    await fs.mkdir(path.join(dir, "sub"), { recursive: true });
    await w("sub/del-later.txt", "x\n");
    await w(".gitignore", "ignored/\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
    await fs.mkdir(path.join(dir, "ignored"), { recursive: true });
    await w("ignored/big.bin", "DO NOT TOUCH\n");

    // 快照点状态：改 mod、删 sub/del-later、增 addedBefore
    await w("mod.txt", "at-snap\n");
    await fs.rm(path.join(dir, "sub/del-later.txt"));
    await w("addedBefore.txt", "in snapshot\n");
    const store = new SnapshotStore(dir);
    const snap = await store.take("状态A");
    assert.ok(snap, "git 仓库应能生成快照");

    // 快照后继续乱改
    await w("mod.txt", "MESSED\n");
    await fs.rm(path.join(dir, "keep.txt"));
    await w("addedAfter.txt", "remove me\n");
    await w("sub/del-later.txt", "resurrected\n");

    const res = await store.restore(snap!);
    assert.ok(res.restored >= 3);

    assert.equal(await read("mod.txt"), "at-snap\n");
    assert.equal(await read("keep.txt"), "v1\n"); // 快照后删的，恢复回来
    assert.equal(await exists("addedBefore.txt"), true);
    assert.equal(await exists("addedAfter.txt"), false); // 快照后增的，被删掉
    assert.equal(await exists("sub/del-later.txt"), false); // 快照时已删，复活的要清掉
    // .gitignore 忽略的文件不受任何影响
    assert.equal(await exists("ignored/big.bin"), true);
    assert.equal(await read("ignored/big.bin"), "DO NOT TOUCH\n");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("snapshot: 空仓库（无 HEAD）也能 take 与 restore", async () => {
  const dir = await tempRepo();
  const exists = async (f: string) =>
    fs.access(path.join(dir, f)).then(
      () => true,
      () => false,
    );
  try {
    await fs.writeFile(path.join(dir, "a.txt"), "hello\n");
    const store = new SnapshotStore(dir);
    const snap = await store.take("初始");
    assert.ok(snap);
    await fs.writeFile(path.join(dir, "b.txt"), "added after\n");
    await store.restore(snap!);
    assert.equal(await exists("a.txt"), true);
    assert.equal(await exists("b.txt"), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
