import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { gatherEnv } from "../env.js";
import { SnapshotStore } from "../snapshot.js";
import { workspaceRevisionDigest } from "./workspace-revision.js";
import { trustedGitExecutable, validateGitRepository } from "./git-control.js";

const execFileP = promisify(execFile);

const POSIX_GIT_HOOKS_ONLY = {
  skip: process.platform === "win32" ? "the hostile Git hook fixtures are POSIX scripts" : false,
};

async function repository(): Promise<string> {
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "anicode-safe-git-")));
  const git = await trustedGitExecutable();
  await execFileP(git, ["init", "-q", cwd]);
  await execFileP(git, ["-C", cwd, "config", "user.email", "test@example.invalid"]);
  await execFileP(git, ["-C", cwd, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(cwd, "tracked.txt"), "safe\n");
  await execFileP(git, ["-C", cwd, "add", "tracked.txt"]);
  await execFileP(git, ["-C", cwd, "commit", "-qm", "initial"]);
  return cwd;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

test("git control: trusted executable ignores a PATH replacement", async () => {
  const fakeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-fake-git-"));
  const marker = path.join(fakeRoot, "executed");
  const fakeGit = path.join(fakeRoot, process.platform === "win32" ? "git.cmd" : "git");
  await fs.writeFile(
    fakeGit,
    process.platform === "win32"
      ? `@echo executed>"${marker}"\r\n@exit /b 99\r\n`
      : `#!/bin/sh\ntouch '${marker}'\nexit 99\n`,
    { mode: 0o755 },
  );
  const previous = process.env["PATH"];
  process.env["PATH"] = `${fakeRoot}${path.delimiter}${previous ?? ""}`;
  const cwd = await repository();
  try {
    const trusted = await trustedGitExecutable();
    assert.equal(path.isAbsolute(trusted), true);
    assert.equal(
      path.basename(trusted).toLowerCase(),
      process.platform === "win32" ? "git.exe" : "git",
    );
    assert.equal(path.dirname(trusted).startsWith(fakeRoot), false);
    const output = await gatherEnv(cwd);
    assert.match(output, /git repo.*yes|git 仓库.*是/i);
    assert.equal(await exists(marker), false);
  } finally {
    if (previous === undefined) delete process.env["PATH"];
    else process.env["PATH"] = previous;
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(fakeRoot, { recursive: true, force: true });
  }
});

test(
  "git control: automatic status/evidence disable repository fsmonitor",
  POSIX_GIT_HOOKS_ONLY,
  async () => {
    const cwd = await repository();
    const git = await trustedGitExecutable();
    const marker = path.join(cwd, "fsmonitor-executed");
    const hook = path.join(cwd, "evil-fsmonitor.sh");
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\nprintf '\\n'\n`, { mode: 0o755 });
    await execFileP(git, ["-C", cwd, "config", "core.fsmonitor", hook]);
    try {
      await gatherEnv(cwd);
      await workspaceRevisionDigest(cwd);
      assert.equal(await exists(marker), false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "git control: snapshot take/restore cannot execute clean, smudge, or process filters",
  POSIX_GIT_HOOKS_ONLY,
  async () => {
    const cwd = await repository();
    const git = await trustedGitExecutable();
    const marker = path.join(cwd, "filter-executed");
    const filter = path.join(cwd, "evil-filter.sh");
    await fs.writeFile(filter, `#!/bin/sh\ntouch '${marker}'\n/bin/cat\n`, { mode: 0o755 });
    await fs.writeFile(path.join(cwd, ".gitattributes"), "payload.txt filter=evil\n");
    await fs.writeFile(path.join(cwd, "payload.txt"), "snapshot value\n");
    for (const key of ["clean", "smudge", "process"]) {
      await execFileP(git, ["-C", cwd, "config", `filter.evil.${key}`, filter]);
    }
    await execFileP(git, ["-C", cwd, "config", "filter.evil.required", "true"]);
    try {
      await gatherEnv(cwd);
      await workspaceRevisionDigest(cwd);
      assert.equal(await exists(marker), false);
      const snapshot = await new SnapshotStore(cwd).take("filter regression");
      assert.ok(snapshot);
      assert.equal(await exists(marker), false);
      await fs.writeFile(path.join(cwd, "payload.txt"), "changed\n");
      await new SnapshotStore(cwd).restore(snapshot!);
      assert.equal(await fs.readFile(path.join(cwd, "payload.txt"), "utf8"), "snapshot value\n");
      assert.equal(await exists(marker), false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  },
);

test("git control: unrelated external gitdir pointer is rejected before Git is spawned", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-gitdir-project-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-gitdir-outside-"));
  await fs.mkdir(path.join(outside, "objects"));
  await fs.writeFile(path.join(cwd, ".git"), `gitdir: ${outside}\n`);
  try {
    await assert.rejects(() => validateGitRepository(cwd), /gitdir|backlink/i);
    const output = await gatherEnv(cwd);
    assert.match(output, /git repo.*no|git 仓库.*否/i);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
