import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __setWorkspaceTrustInspectionHooksForTests,
  WorkspaceTrustStore,
  canonicalWorkspaceIdentity,
  workspaceExecutionFingerprint,
} from "./workspace-trust.js";

async function fixture(): Promise<{
  root: string;
  cwd: string;
  store: WorkspaceTrustStore;
  file: string;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-workspace-trust-"));
  const cwd = path.join(root, "project");
  const file = path.join(root, "user-config", "anicode", "trust", "workspaces.json");
  await fs.mkdir(cwd, { recursive: true });
  return {
    root,
    cwd,
    store: new WorkspaceTrustStore({ file }),
    file,
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

test("workspace trust: grant 持久化到私有用户存储，revoke 立即失效", async () => {
  const { cwd, store, file, cleanup } = await fixture();
  try {
    const before = await store.assess(cwd);
    assert.equal(before.trusted, false);
    assert.equal(before.reason, "not-trusted");

    const granted = await store.grant(cwd);
    assert.equal(granted.trusted, true);
    const reopened = new WorkspaceTrustStore({ file });
    assert.equal((await reopened.assess(cwd)).trusted, true);

    if (process.platform !== "win32") {
      assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }

    assert.equal(await reopened.revoke(cwd), true);
    assert.equal((await reopened.assess(cwd)).reason, "not-trusted");
    assert.equal(await reopened.revoke(cwd), false);
  } finally {
    await cleanup();
  }
});

test("workspace trust: realpath 使符号链接别名共享身份", async (t) => {
  if (process.platform === "win32") t.skip("Windows symlink privileges vary by host policy");
  const { root, cwd, store, cleanup } = await fixture();
  try {
    const alias = path.join(root, "project-alias");
    await fs.symlink(cwd, alias, "dir");
    const [direct, linked] = await Promise.all([
      canonicalWorkspaceIdentity(cwd),
      canonicalWorkspaceIdentity(alias),
    ]);
    assert.deepEqual(linked, direct);
    await store.grant(cwd);
    assert.equal((await store.assess(alias)).trusted, true);
  } finally {
    await cleanup();
  }
});

test("workspace trust: 安全偏好变化不失效，执行配置变化必须重新授信", async () => {
  const { cwd, store, cleanup } = await fixture();
  try {
    const config = path.join(cwd, "anicode.json");
    await fs.writeFile(
      config,
      JSON.stringify({ model: "deepseek/v1", mcp: { local: { command: "server-v1" } } }),
    );
    const granted = await store.grant(cwd);

    await fs.writeFile(
      config,
      JSON.stringify({ model: "deepseek/v2", mcp: { local: { command: "server-v1" } } }),
    );
    const safeChange = await store.assess(cwd);
    assert.equal(safeChange.trusted, true);
    assert.equal(safeChange.executionHash, granted.executionHash);

    await fs.writeFile(
      config,
      JSON.stringify({ model: "deepseek/v2", mcp: { local: { command: "server-v2" } } }),
    );
    const executionChange = await store.assess(cwd);
    assert.equal(executionChange.trusted, false);
    assert.equal(executionChange.reason, "execution-config-changed");
    assert.notEqual(executionChange.executionHash, granted.executionHash);
  } finally {
    await cleanup();
  }
});

test("workspace trust: 项目环境文件新增或变化必须重新授信", async () => {
  const { cwd, store, cleanup } = await fixture();
  try {
    await store.grant(cwd);
    const envFile = path.join(cwd, ".env.local");
    await fs.writeFile(envFile, "DEEPSEEK_API_KEY=one\n");
    assert.equal((await store.assess(cwd)).reason, "execution-config-changed");

    await store.grant(cwd);
    await fs.writeFile(envFile, "DEEPSEEK_API_KEY=two\n");
    assert.equal((await store.assess(cwd)).reason, "execution-config-changed");
  } finally {
    await cleanup();
  }
});

test("workspace trust: Git 执行配置、attributes 与 hooks 变化必须重新授信", async () => {
  const { cwd, store, cleanup } = await fixture();
  try {
    await fs.mkdir(path.join(cwd, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(cwd, ".git", "info"), { recursive: true });
    const config = path.join(cwd, ".git", "config");
    const attributes = path.join(cwd, ".gitattributes");
    const infoAttributes = path.join(cwd, ".git", "info", "attributes");
    const hook = path.join(cwd, ".git", "hooks", "post-checkout");
    await fs.writeFile(config, "[core]\n\tfsmonitor = false\n");
    await fs.writeFile(attributes, "*.txt -filter\n");
    await fs.writeFile(infoAttributes, "*.md -filter\n");
    await fs.writeFile(hook, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    for (const [file, changed] of [
      [config, "[core]\n\tfsmonitor = ./evil\n"],
      [attributes, "*.txt filter=evil\n"],
      [infoAttributes, "*.md filter=evil\n"],
      [hook, "#!/bin/sh\nexec ./evil\n"],
    ] as const) {
      await store.grant(cwd);
      await fs.writeFile(file, changed);
      assert.equal((await store.assess(cwd)).reason, "execution-config-changed");
    }
  } finally {
    await cleanup();
  }
});

test("workspace trust: 确认期间执行面变化不会授信未展示的内容", async () => {
  const { cwd, store, cleanup } = await fixture();
  try {
    const preview = await store.assess(cwd);
    assert.ok(preview.identity && preview.executionHash);
    await fs.writeFile(path.join(cwd, ".env"), "MODEL_API_KEY=changed\n");
    await assert.rejects(
      () =>
        store.grant(cwd, {
          identityKey: preview.identity!.key,
          executionHash: preview.executionHash!,
        }),
      /changed while awaiting trust confirmation/,
    );
    assert.equal((await store.assess(cwd)).trusted, false);
  } finally {
    await cleanup();
  }
});

test("workspace trust: AGENTS.md/CLAUDE.md 项目记忆变化必须重新授信", async () => {
  const { cwd, store, cleanup } = await fixture();
  try {
    await fs.mkdir(path.join(cwd, ".git"));
    const memory = path.join(cwd, "AGENTS.md");
    await fs.writeFile(memory, "version one\n");
    await store.grant(cwd);
    await fs.writeFile(memory, "version two\n");
    assert.equal((await store.assess(cwd)).reason, "execution-config-changed");
  } finally {
    await cleanup();
  }
});

test("workspace trust: 项目 plugin/skill 内容的新增和修改进入 execution hash", async () => {
  const { cwd, store, cleanup } = await fixture();
  try {
    await store.grant(cwd);
    const skillDir = path.join(cwd, ".anicode", "plugins", "demo", "skills", "review");
    await fs.mkdir(skillDir, { recursive: true });
    const skill = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skill, "---\nname: review\n---\nversion one\n");
    assert.equal((await store.assess(cwd)).reason, "execution-config-changed");

    await store.grant(cwd);
    await fs.writeFile(skill, "---\nname: review\n---\nversion two\n");
    assert.equal((await store.assess(cwd)).reason, "execution-config-changed");
  } finally {
    await cleanup();
  }
});

test("workspace trust: 同一路径替换目录不能继承旧 trust", async () => {
  const { root, cwd, store, cleanup } = await fixture();
  try {
    const original = await workspaceExecutionFingerprint(cwd);
    await store.grant(cwd);
    await fs.rename(cwd, path.join(root, "old-project"));
    await fs.mkdir(cwd);
    const replacement = await workspaceExecutionFingerprint(cwd);
    assert.notEqual(replacement.identity.key, original.identity.key);
    const assessed = await store.assess(cwd);
    assert.equal(assessed.trusted, false);
    assert.equal(assessed.reason, "workspace-identity-changed");
  } finally {
    await cleanup();
  }
});

test("workspace trust: 损坏或过宽权限的 store 始终 fail closed", async () => {
  const { cwd, store, file, cleanup } = await fixture();
  try {
    await store.grant(cwd);
    await fs.writeFile(file, "{ broken", { mode: 0o600 });
    if (process.platform !== "win32") await fs.chmod(file, 0o600);
    const corrupt = await store.assess(cwd);
    assert.equal(corrupt.trusted, false);
    assert.equal(corrupt.reason, "inspection-failed");
    assert.match(corrupt.error ?? "", /valid JSON/);

    await fs.writeFile(file, JSON.stringify({ version: 1, workspaces: [] }));
    if (process.platform !== "win32") {
      await fs.chmod(file, 0o644);
      const exposed = await store.assess(cwd);
      assert.equal(exposed.reason, "inspection-failed");
      assert.match(exposed.error ?? "", /0600/);
    }
  } finally {
    await cleanup();
  }
});

test("workspace trust: execution tree 内 symlink 被拒绝而非跟随到工作区外", async (t) => {
  if (process.platform === "win32") t.skip("Windows symlink privileges vary by host policy");
  const { root, cwd, store, cleanup } = await fixture();
  try {
    const outside = path.join(root, "outside-skills");
    await fs.mkdir(outside);
    await fs.mkdir(path.join(cwd, ".claude"));
    await fs.symlink(outside, path.join(cwd, ".claude", "skills"), "dir");
    const assessed = await store.assess(cwd);
    assert.equal(assessed.reason, "inspection-failed");
    assert.match(assessed.error ?? "", /securely open|stable real directory/);
    await assert.rejects(() => store.grant(cwd), /securely open|stable real directory/);
  } finally {
    await cleanup();
  }
});

test("workspace trust: execution file symlink 被 O_NOFOLLOW 拒绝", async (t) => {
  if (process.platform === "win32") t.skip("Windows symlink privileges vary by host policy");
  const { root, cwd, store, cleanup } = await fixture();
  try {
    const outside = path.join(root, "outside.env");
    await fs.writeFile(outside, "MODEL_API_KEY=outside\n");
    await fs.symlink(outside, path.join(cwd, ".env"));
    const assessed = await store.assess(cwd);
    assert.equal(assessed.reason, "inspection-failed");
    assert.match(assessed.error ?? "", /securely open|stable real file/);
  } finally {
    await cleanup();
  }
});

test("workspace trust: 文件在 open 后被替换时从同一 fd 检测并 fail closed", async (t) => {
  if (process.platform === "win32") t.skip("Windows symlink privileges vary by host policy");
  const { root, cwd, store, cleanup } = await fixture();
  const canonicalCwd = await fs.realpath(cwd);
  const source = path.join(canonicalCwd, ".env");
  const backup = path.join(canonicalCwd, ".env.before-race");
  const outside = path.join(root, "outside-race.env");
  let raced = false;
  try {
    await fs.writeFile(source, "MODEL_API_KEY=trusted-candidate\n");
    await fs.writeFile(outside, "MODEL_API_KEY=attacker\n");
    __setWorkspaceTrustInspectionHooksForTests({
      afterFileOpen: async (file) => {
        if (!raced && path.resolve(file) === source) {
          raced = true;
          await fs.rename(source, backup);
          await fs.symlink(outside, source);
        }
      },
    });
    const assessed = await store.assess(cwd);
    assert.equal(raced, true);
    assert.equal(assessed.reason, "inspection-failed");
    assert.match(assessed.error ?? "", /stable real file|changed during inspection/);
  } finally {
    __setWorkspaceTrustInspectionHooksForTests(undefined);
    if (raced) {
      await fs.rm(source, { force: true });
      await fs.rename(backup, source);
    }
    await cleanup();
  }
});

test("workspace trust: 目录枚举期间路径被替换时 fail closed", async (t) => {
  if (process.platform === "win32") t.skip("Windows symlink privileges vary by host policy");
  const { root, cwd, store, cleanup } = await fixture();
  const canonicalCwd = await fs.realpath(cwd);
  const directory = path.join(canonicalCwd, ".anicode", "plugins");
  const backup = path.join(canonicalCwd, ".anicode", "plugins.before-race");
  const outside = path.join(root, "outside-plugins");
  let raced = false;
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "safe.txt"), "safe\n");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "outside.txt"), "outside\n");
    __setWorkspaceTrustInspectionHooksForTests({
      beforeDirectoryEnumeration: async (openedPath) => {
        if (!raced && path.resolve(openedPath) === directory) {
          raced = true;
          await fs.rename(directory, backup);
          await fs.symlink(outside, directory, "dir");
        }
      },
    });
    const assessed = await store.assess(cwd);
    assert.equal(raced, true);
    assert.equal(assessed.reason, "inspection-failed");
    assert.match(assessed.error ?? "", /stable real directory|changed during inspection/);
  } finally {
    __setWorkspaceTrustInspectionHooksForTests(undefined);
    if (raced) {
      await fs.rm(directory, { recursive: true, force: true });
      await fs.rename(backup, directory);
    }
    await cleanup();
  }
});

test("workspace trust: 并发 grant 不丢失其他 workspace 记录", async () => {
  const { root, store, file, cleanup } = await fixture();
  try {
    const workspaces = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const directory = path.join(root, `workspace-${index}`);
        await fs.mkdir(directory);
        return directory;
      }),
    );
    await Promise.all(workspaces.map((workspace) => store.grant(workspace)));
    const reopened = new WorkspaceTrustStore({ file });
    const statuses = await Promise.all(workspaces.map((workspace) => reopened.assess(workspace)));
    assert.ok(statuses.every((status) => status.trusted));
  } finally {
    await cleanup();
  }
});

test("workspace trust: 不会仅因活跃进程持锁时间较长而抢占 trust lock", async () => {
  const { cwd, store, file, cleanup } = await fixture();
  const lock = `${file}.lock`;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      lock,
      JSON.stringify({ pid: process.pid, token: "live-owner-token-000000000000" }),
      { mode: 0o600 },
    );
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(lock, old, old);
    const started = Date.now();
    const release = setTimeout(() => {
      void fs.rm(lock, { force: true }).catch(() => {});
    }, 60);
    try {
      await store.grant(cwd);
    } finally {
      clearTimeout(release);
    }
    assert.ok(Date.now() - started >= 40, "grant should wait for the live lock owner");
    assert.equal((await store.assess(cwd)).trusted, true);
  } finally {
    await cleanup();
  }
});
