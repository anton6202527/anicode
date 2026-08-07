import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PatchSetConflictError, PatchSetService, threeWayMerge } from "./patchset.js";

function trustedPatchSetService(
  root: string,
  options: ConstructorParameters<typeof PatchSetService>[1] = {},
): PatchSetService {
  return new PatchSetService(root, { ...options, directCommit: "trusted-local" });
}

test("PatchSet: direct filesystem commit is fail-closed without explicit trusted authority", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-authority-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    const service = new PatchSetService(root);
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    await assert.rejects(() => service.apply(patchset), /direct commit is disabled/);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: session-bound services reject foreign and legacy journals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-owner-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    const alice = trustedPatchSetService(root, { sessionId: "session-alice" });
    const bob = trustedPatchSetService(root, { sessionId: "session-bob" });
    const standalone = trustedPatchSetService(root);
    const owned = await alice.prepare([{ path: "a.txt", content: "alice" }]);
    assert.equal(owned.sessionId, "session-alice");
    await assert.rejects(() => bob.load(owned.id), /another session/);
    await assert.rejects(() => bob.apply(owned), /another session/);
    await assert.rejects(() => standalone.load(owned.id), /belongs to session/);

    const legacy = await standalone.prepare([{ path: "a.txt", content: "legacy" }]);
    assert.equal(legacy.sessionId, undefined);
    await assert.rejects(() => alice.load(legacy.id), /Legacy PatchSet.*no session owner/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: rebase preserves its session owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-rebase-owner-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nthree");
    const service = trustedPatchSetService(root, { sessionId: "session-owner" });
    const stale = await service.prepare([{ path: "a.txt", content: "ONE\ntwo\nthree" }]);
    await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\nTHREE");
    const rebased = await service.rebase(stale);
    assert.equal(rebased.patchset.sessionId, "session-owner");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: deleteSession removes only owned quiescent journals and their private content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-session-delete-"));
  try {
    const alice = trustedPatchSetService(root, { sessionId: "session-alice" });
    const bob = trustedPatchSetService(root, { sessionId: "session-bob" });
    const alicePatch = await alice.prepare([
      { path: "private.txt", content: "ALICE_PATCH_PRIVATE_CANARY" },
    ]);
    const bobPatch = await bob.prepare([{ path: "other.txt", content: "BOB_PATCH_CANARY" }]);
    const journalDir = path.join(root, ".anicode", "patchsets");
    assert.match(
      await fs.readFile(path.join(journalDir, `${alicePatch.id}.json`), "utf8"),
      /ALICE_PATCH_PRIVATE_CANARY/,
    );

    assert.equal(await alice.deleteSession("session-alice"), 1);
    await assert.rejects(() => fs.access(path.join(journalDir, `${alicePatch.id}.json`)));
    const restartedAlice = trustedPatchSetService(root, { sessionId: "session-alice" });
    await assert.rejects(
      () => restartedAlice.prepare([{ path: "recreated.txt", content: "must-not-return" }]),
      /permanently fenced/,
    );
    await assert.rejects(() => fs.access(path.join(root, "recreated.txt")));
    assert.equal((await bob.load(bobPatch.id))?.sessionId, "session-bob");
    const remaining = await Promise.all(
      (await fs.readdir(journalDir))
        .filter((name) => name.endsWith(".json"))
        .map((name) => fs.readFile(path.join(journalDir, name), "utf8")),
    );
    assert.doesNotMatch(remaining.join("\n"), /ALICE_PATCH_PRIVATE_CANARY/);
    assert.doesNotMatch(remaining.join("\n"), /session-alice/);
    assert.match(remaining.join("\n"), /BOB_PATCH_CANARY/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: a deleted session cannot roll back a retained applied journal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-session-fence-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    const service = trustedPatchSetService(root, { sessionId: "session-fenced" });
    const applied = await service.prepare([{ path: "a.txt", content: "after" }]);
    await service.apply(applied);
    assert.equal(await service.deleteSession("session-fenced"), 1);

    await assert.rejects(() => service.rollback(applied), /permanently fenced/);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "after");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: deleteSession recovers an interrupted apply and never touches another session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-session-delete-busy-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    await fs.writeFile(path.join(root, "bob.txt"), "bob-before");
    const service = trustedPatchSetService(root, { sessionId: "session-busy" });
    const bob = trustedPatchSetService(root, { sessionId: "session-bob" });
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    const bobPatch = await bob.prepare([{ path: "bob.txt", content: "bob-after" }]);

    // Model a process interruption after the first atomic install but before terminalizing the
    // write-ahead journal. deleteSession owns the workspace lock, so no live apply can coexist.
    await fs.writeFile(path.join(root, "a.txt"), "after");
    patchset.status = "applying";
    patchset.appliedCount = 1;
    const journalFile = path.join(root, ".anicode", "patchsets", `${patchset.id}.json`);
    await fs.writeFile(journalFile, JSON.stringify(patchset));

    assert.equal(await service.deleteSession("session-busy"), 1);
    await assert.rejects(() => fs.access(journalFile));
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "before");
    assert.equal(await fs.readFile(path.join(root, "bob.txt"), "utf8"), "bob-before");
    assert.equal((await bob.load(bobPatch.id))?.status, "planned");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: deleteSession keeps a conflicting interrupted apply retryable", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-session-delete-conflict-"));
  try {
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "before");
    const service = trustedPatchSetService(root, { sessionId: "session-busy" });
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    patchset.status = "applying";
    patchset.appliedCount = 1;
    const journalFile = path.join(root, ".anicode", "patchsets", `${patchset.id}.json`);
    await fs.writeFile(journalFile, JSON.stringify(patchset));

    await fs.writeFile(file, "third-party-change");
    await assert.rejects(() => service.deleteSession("session-busy"), /recovery failed/);
    assert.equal((await service.load(patchset.id))?.status, "applying");
    await fs.access(journalFile);

    // Once the external conflict is repaired, the same deletion attempt is idempotently
    // recoverable and may install the permanent session tombstone.
    await fs.writeFile(file, "after");
    assert.equal(await service.deleteSession("session-busy"), 1);
    assert.equal(await fs.readFile(file, "utf8"), "before");
    await assert.rejects(() => fs.access(journalFile));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: bound recovery skips legacy journals; standalone recovery remains compatible", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-legacy-recovery-"));
  try {
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "before");
    const standalone = trustedPatchSetService(root);
    const legacy = await standalone.prepare([{ path: "a.txt", content: "after" }]);
    await fs.writeFile(file, "after");
    legacy.status = "applying";
    legacy.appliedCount = 1;
    await fs.writeFile(
      path.join(root, ".anicode", "patchsets", `${legacy.id}.json`),
      JSON.stringify(legacy),
    );

    const bound = trustedPatchSetService(root, { sessionId: "new-session" });
    assert.deepEqual(await bound.recoverIncomplete(), []);
    assert.equal(await fs.readFile(file, "utf8"), "after");
    assert.equal((await standalone.recoverIncomplete())[0]?.status, "rolled_back");
    assert.equal(await fs.readFile(file, "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: preview、乐观冲突检测与显式回滚", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "old\n");
    const service = trustedPatchSetService(root);
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
    const service = trustedPatchSetService(root, {
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

test("PatchSet: lease cancellation racing an installed file rolls back the full prefix", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-cancel-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "a0");
    await fs.writeFile(path.join(root, "b.txt"), "b0");
    const controller = new AbortController();
    let writes = 0;
    const service = trustedPatchSetService(root, {
      journalDir: path.join(root, ".journal"),
      writeFile: async (file, content) => {
        await fs.writeFile(file, content);
        if (++writes === 1) controller.abort(new Error("execution lease lost"));
      },
    });
    const patchset = await service.prepare([
      { path: "a.txt", content: "a1" },
      { path: "b.txt", content: "b1" },
    ]);
    await assert.rejects(
      () => service.apply(patchset, { signal: controller.signal }),
      /execution lease lost/,
    );
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "a0");
    assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "b0");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: write-ahead journal crash before install recovers as an idempotent no-op", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-write-ahead-"));
  try {
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "before");
    const service = trustedPatchSetService(root);
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    patchset.status = "applying";
    patchset.appliedCount = 1;
    const journal = path.join(root, ".anicode", "patchsets");
    await fs.mkdir(journal, { recursive: true });
    await fs.writeFile(path.join(journal, `${patchset.id}.json`), JSON.stringify(patchset));

    const recovered = await service.recoverIncomplete();
    assert.equal(recovered[0]?.status, "rolled_back");
    assert.doesNotMatch(recovered[0]?.error ?? "", /rollback errors/);
    assert.equal(await fs.readFile(file, "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: failed crash rollback keeps a retryable applying journal", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-recovery-retry-"));
  try {
    const file = path.join(root, "a.txt");
    await fs.writeFile(file, "before");
    let failRollback = true;
    const service = trustedPatchSetService(root, {
      writeFile: async (target, content, mode) => {
        if (failRollback) {
          failRollback = false;
          throw new Error("transient rollback IO failure");
        }
        await fs.writeFile(target, content, { mode });
      },
    });
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    await fs.writeFile(file, "after");
    patchset.status = "applying";
    patchset.appliedCount = 1;
    await fs.writeFile(
      path.join(root, ".anicode", "patchsets", `${patchset.id}.json`),
      JSON.stringify(patchset),
    );

    assert.equal((await service.recoverIncomplete())[0]?.status, "applying");
    assert.equal((await service.load(patchset.id))?.appliedCount, 1);
    assert.equal((await service.recoverIncomplete())[0]?.status, "rolled_back");
    assert.equal(await fs.readFile(file, "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: rename、binary、审批角色与回滚形成一个事务", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-v2-"));
  try {
    await fs.writeFile(path.join(root, "old.txt"), "source\n");
    await fs.writeFile(path.join(root, "image.bin"), Buffer.from([0, 1, 2]));
    const service = trustedPatchSetService(root, {
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
    const service = trustedPatchSetService(root);
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
    const service = trustedPatchSetService(root);
    await assert.rejects(
      () => service.prepare([{ path: "escape/pwned", content: "no" }]),
      /symbolic link/,
    );
    await assert.rejects(
      () => service.prepare([{ path: ".anicode/patchsets/forged.json", content: "no" }]),
      /protected runtime state/,
    );
    await assert.rejects(
      () => service.prepare([{ path: "packages/child/.git/config", content: "no" }]),
      /protected runtime state/,
    );
    await assert.rejects(
      () => service.prepare([{ path: "packages/child/.anicode/state.json", content: "no" }]),
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
    const firstService = trustedPatchSetService(root);
    const secondService = trustedPatchSetService(root);
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

test("PatchSet: an old lock is never stolen based on mtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-old-lock-"));
  try {
    const journalDir = path.join(root, ".journal");
    const service = trustedPatchSetService(root, {
      journalDir,
      lockTimeoutMs: 40,
      lockRetryMs: 5,
    });
    await fs.writeFile(path.join(root, "a.txt"), "before");
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    const lockFile = path.join(journalDir, "workspace.lock");
    const owner = {
      version: 1,
      ownerToken: "a".repeat(64),
      fencingToken: 99,
      pid: process.pid,
      host: "test-host",
      acquiredAt: new Date(0).toISOString(),
    };
    await fs.writeFile(lockFile, JSON.stringify(owner), { mode: 0o600 });
    await fs.utimes(lockFile, new Date(0), new Date(0));

    await assert.rejects(() => service.apply(patchset), /workspace lock timeout/);
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, "utf8")), owner);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: abandoned-lock recovery is explicit, token-bound, and refuses live PID", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-lock-recovery-"));
  try {
    const journalDir = path.join(root, ".journal");
    const service = trustedPatchSetService(root, { journalDir });
    await service.prepare([{ path: "a.txt", content: "planned" }]);
    const lockFile = path.join(journalDir, "workspace.lock");
    const live = {
      version: 1,
      ownerToken: "e".repeat(64),
      fencingToken: 1,
      pid: process.pid,
      host: os.hostname(),
      acquiredAt: new Date().toISOString(),
    };
    await fs.writeFile(lockFile, JSON.stringify(live), { mode: 0o600 });
    await assert.rejects(
      () => service.recoverAbandonedWorkspaceLock(live.ownerToken),
      /live PatchSet workspace lock/,
    );
    await assert.rejects(
      () => service.recoverAbandonedWorkspaceLock("f".repeat(64)),
      /owner token mismatch/,
    );

    const abandoned = { ...live, ownerToken: "f".repeat(64), pid: 2_147_483_647 };
    await fs.writeFile(lockFile, JSON.stringify(abandoned), { mode: 0o600 });
    assert.deepEqual(await service.inspectWorkspaceLock(), abandoned);
    assert.equal(await service.recoverAbandonedWorkspaceLock(abandoned.ownerToken), true);
    assert.equal(await service.inspectWorkspaceLock(), undefined);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: heartbeat failure aborts an in-flight commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-heartbeat-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    let heartbeatAttempts = 0;
    const service = trustedPatchSetService(root, {
      journalDir: path.join(root, ".journal"),
      lockHeartbeatMs: 5,
      touchWorkspaceLock: async () => {
        heartbeatAttempts++;
        throw new Error("injected heartbeat failure");
      },
      writeFile: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    });
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    await assert.rejects(() => service.apply(patchset), /workspace lock heartbeat failed/);
    assert.ok(heartbeatAttempts > 0);
    assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: release never removes a lock whose owner token changed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-lock-token-"));
  try {
    await fs.writeFile(path.join(root, "a.txt"), "before");
    const journalDir = path.join(root, ".journal");
    const lockFile = path.join(journalDir, "workspace.lock");
    const replacement = {
      version: 1,
      ownerToken: "b".repeat(64),
      fencingToken: 500,
      pid: process.pid,
      host: "replacement",
      acquiredAt: new Date().toISOString(),
    };
    const service = trustedPatchSetService(root, {
      journalDir,
      lockHeartbeatMs: 60_000,
      writeFile: async () => {
        await fs.writeFile(lockFile, JSON.stringify(replacement));
        throw new Error("injected writer failure");
      },
    });
    const patchset = await service.prepare([{ path: "a.txt", content: "after" }]);
    await assert.rejects(() => service.apply(patchset), /injected writer failure/);
    assert.deepEqual(JSON.parse(await fs.readFile(lockFile, "utf8")), replacement);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PatchSet: parent-directory symlink swap is detected before atomic install", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-parent-race-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ps-parent-outside-"));
  const parent = path.join(root, "src");
  const parked = path.join(root, "src-parked");
  try {
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "a.txt"), "before");
    let swapped = false;
    const service = trustedPatchSetService(root, {
      beforeWorkspaceInstall: async () => {
        if (swapped) return;
        swapped = true;
        await fs.rename(parent, parked);
        await fs.symlink(outside, parent);
      },
    });
    const patchset = await service.prepare([{ path: "src/a.txt", content: "after" }]);
    await assert.rejects(() => service.apply(patchset), /symbolic link|identity changed/);
    await assert.rejects(() => fs.access(path.join(outside, "a.txt")));
    assert.equal(await fs.readFile(path.join(parked, "a.txt"), "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
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
    const writer = trustedPatchSetService(root, {
      writeFile: async (file, content, mode) => {
        started();
        await gate;
        await fs.writeFile(file, content, { mode });
      },
    });
    const recovery = trustedPatchSetService(root);
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
