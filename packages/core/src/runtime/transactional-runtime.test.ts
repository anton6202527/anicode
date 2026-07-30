import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionRuntime } from "./isolated-runtime.js";
import { TransactionalExecutionRuntime } from "./transactional-runtime.js";

test("TransactionalExecutionRuntime: successful shell changes commit through PatchSet", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-transaction-runtime-"));
  await fs.writeFile(path.join(root, "old.txt"), "old");
  const delegate: ExecutionRuntime = {
    async run(request) {
      await fs.writeFile(path.join(request.cwd, "old.txt"), "new");
      await fs.writeFile(path.join(request.cwd, "added.sh"), "#!/bin/sh\ntrue\n", { mode: 0o700 });
      return { exitCode: 0, output: "done", timedOut: false, sandboxed: true, durationMs: 1 };
    },
  };
  try {
    const result = await new TransactionalExecutionRuntime(delegate).run({
      command: "change",
      cwd: root,
      policy: "workspace-write",
    });
    assert.equal(await fs.readFile(path.join(root, "old.txt"), "utf8"), "new");
    assert.equal((await fs.stat(path.join(root, "added.sh"))).mode & 0o777, 0o700);
    assert.match(result.output, /PatchSet ps_/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("TransactionalExecutionRuntime: failed shell discards staged writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-transaction-fail-"));
  await fs.writeFile(path.join(root, "file.txt"), "before");
  const delegate: ExecutionRuntime = {
    async run(request) {
      await fs.writeFile(path.join(request.cwd, "file.txt"), "must-not-commit");
      return { exitCode: 1, output: "failed", timedOut: false, sandboxed: true, durationMs: 1 };
    },
  };
  try {
    await new TransactionalExecutionRuntime(delegate).run({
      command: "fail",
      cwd: root,
      policy: "workspace-write",
    });
    assert.equal(await fs.readFile(path.join(root, "file.txt"), "utf8"), "before");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
