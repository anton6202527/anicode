import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PatchSetConflictError, PatchSetService, threeWayMerge } from "./patchset.js";

test("PatchSet: preview、乐观冲突检测与显式回滚", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "old\n");
    const service = new PatchSetService(root);
    const stale = await service.prepare([{ path: "a.txt", content: "new\n" }]);
    assert.match(service.preview(stale), /update a\.txt \(\+1\/-1\)/);
    await fs.writeFile(path.join(root, "a.txt"), "concurrent\n");
    await assert.rejects(() => service.apply(stale), PatchSetConflictError);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "concurrent\n");

    const next = await service.prepare([
      { path: "a.txt", content: "new\n" },
      { path: "b.txt", content: "added\n" },
    ]);
    await service.apply(next);
    assert.equal((await service.load(next.id))?.status, "applied");
    await service.rollback(next.id);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "concurrent\n");
    await assert.rejects(() => fs.access(path.join(root, "b.txt")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: 第二个文件 IO 失败时自动恢复第一个文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "a0");
    await fs.writeFile(path.join(root, "b.txt"), "b0");
    let writes = 0;
    const service = new PatchSetService(root, {
      journalDir: path.join(root, ".journal"),
      writeFile: async (file, content) => {
        writes++;
        if (writes === 2) throw new Error("injected disk failure");
        await fs.writeFile(file, content);
      },
    });
    const patchset = await service.prepare([
      { path: "a.txt", content: "a1" },
      { path: "b.txt", content: "b1" },
    ]);
    await assert.rejects(() => service.apply(patchset), /injected disk failure/);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "a0");
    assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "b0");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: rename、binary、审批角色与回滚形成一个事务", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-v2-"));
  try {
    await fs.writeFile(path.join(root, "old.txt"), "source\n");
    await fs.writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2]));
    const service = new PatchSetService(root, {
      requiredApprovals: 2,
      requiredRoles: ["reviewer", "security"],
    });
    const patchset = await service.prepare([
      { path: "new.txt", renameFrom: "old.txt" },
      { path: "image.bin", content: new Uint8Array([0, 9, 8, 7]) },
    ]);
    assert.equal(patchset.status, "pending_approval");
    assert.match(service.preview(patchset), /rename-target new\.txt/);
    assert.match(service.preview(patchset), /binary=4B/);
    await service.approve(patchset, { actor: "alice", role: "reviewer", decision: "approve" });
    await assert.rejects(() => service.apply(patchset), /lacks required approvals/);
    await service.approve(patchset, { actor: "sec-bot", role: "security", decision: "approve" });
    await service.apply(patchset);
    await assert.rejects(() => fs.access(path.join(root, "old.txt")));
    assert.equal(await fs.readFile(path.join(root, "new.txt"), "utf8"), "source\n");
    assert.deepEqual([...(await fs.readFile(path.join(root, "image.bin")))], [0, 9, 8, 7]);
    await service.rollback(patchset);
    assert.equal(await fs.readFile(path.join(root, "old.txt"), "utf8"), "source\n");
    await assert.rejects(() => fs.access(path.join(root, "new.txt")));
    assert.deepEqual([...(await fs.readFile(path.join(root, "image.bin")))], [0, 1, 2]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: 三方合并自动合并独立行，并标记同一行冲突", () => {
  const clean = threeWayMerge("a\nb\nc", "A\nb\nc", "a\nb\nC");
  assert.equal(clean.conflicted, false);
  assert.equal(clean.content, "A\nb\nC");
  const conflict = threeWayMerge("a\nb", "a\nours", "a\ntheirs");
  assert.equal(conflict.conflicted, true);
  assert.match(conflict.content, /<<<<<<< ours/);
  assert.match(conflict.content, />>>>>>> theirs/);
});

test("PatchSet: stale 文本事务可 rebase 到并发改动后再原子提交", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-rebase-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nthree");
    const service = new PatchSetService(root);
    const stale = await service.prepare([{ path: "a.txt", content: "ONE\ntwo\nthree" }]);
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nTHREE");
    await assert.rejects(() => service.apply(stale), PatchSetConflictError);
    const rebased = await service.rebase(stale);
    assert.deepEqual(rebased.conflictedPaths, []);
    assert.match(service.preview(rebased.patchset), /update a\.txt/);
    await service.apply(rebased.patchset);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "ONE\ntwo\nTHREE");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: 拒绝 symlink 与运行时状态路径，且保留可执行权限", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-boundary-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-outside-"));
  try {
    await fs.mkdir(path.join(root, ".anicode"));
    await fs.symlink(outside, path.join(root, "escape"));
    await fs.writeFile(path.join(root, "run.sh"), "#!/bin/sh\necho old\n", { mode: 0o755 });
    const service = new PatchSetService(root);
    await assert.rejects(
      () => service.prepare([{ path: "escape/pwned", content: "no" }]),
      /symbolic link/,
    );
    await assert.rejects(
      () => service.prepare([{ path: ".anicode/patchsets/forged.json", content: "no" }]),
      /protected runtime state/,
    );
    const patchset = await service.prepare([
      { path: "run.sh", content: "#!/bin/sh\necho new\n" },
      { path: "private.sh", content: "#!/bin/sh\ntrue\n", mode: 0o700 },
    ]);
    await service.apply(patchset);
    assert.equal((await fs.stat(path.join(root, "run.sh"))).mode & 0o777, 0o755);
    assert.equal((await fs.stat(path.join(root, "private.sh"))).mode & 0o777, 0o700);
    await service.rollback(patchset);
    assert.equal((await fs.stat(path.join(root, "run.sh"))).mode & 0o777, 0o755);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("PatchSet: workspace lock serializes concurrent apply and rejects stale preview", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-lock-"));
  try {
    await fs.writeFile(path.join(root, "shared.txt"), "base");
    const firstService = new PatchSetService(root);
    const secondService = new PatchSetService(root);
    const first = await firstService.prepare([{ path: "shared.txt", content: "first" }]);
    const second = await secondService.prepare([{ path: "shared.txt", content: "second" }]);
    const results = await Promise.allSettled([
      firstService.apply(first),
      secondService.apply(second),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof PatchSetConflictError);
    assert.ok(
      ["first", "second"].includes(await fs.readFile(path.join(root, "shared.txt"), "utf8")),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: recovery 等锁后重读状态，不回滚另一个进程刚完成的事务", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-recovery-race-"));
  try {
    await fs.writeFile(path.join(root, "shared.txt"), "base");
    let started!: () => void;
    let release!: () => void;
    const writeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = new PatchSetService(root, {
      writeFile: async (file, content, mode) => {
        started();
        await gate;
        await fs.writeFile(file, content, { mode });
      },
    });
    const recovery = new PatchSetService(root);
    const patchset = await writer.prepare([{ path: "shared.txt", content: "committed" }]);
    const applying = writer.apply(patchset);
    await writeStarted;
    const recovering = recovery.recoverIncomplete();
    await new Promise((resolve) => setTimeout(resolve, 25));
    release();
    await applying;
    assert.deepEqual(await recovering, []);
    assert.equal(await fs.readFile(path.join(root, "shared.txt"), "utf8"), "committed");
    assert.equal((await recovery.load(patchset.id))?.status, "applied");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
