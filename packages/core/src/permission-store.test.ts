import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { hostname, tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { appendLocalAllowRules, localSettingsPath } from "./permission-store.js";

async function temporaryWorkspace(): Promise<{
  cwd: string;
  cleanup: () => Promise<void>;
}> {
  const cwd = await fs.mkdtemp(path.join(tmpdir(), "anicode-permissions-"));
  return { cwd, cleanup: () => fs.rm(cwd, { recursive: true, force: true }) };
}

test("permission-store: concurrent read-modify-write operations do not lose rules", async () => {
  const { cwd, cleanup } = await temporaryWorkspace();
  try {
    const rules = Array.from({ length: 32 }, (_, index) => `bash(command-${index})`);
    await Promise.all(rules.map((rule) => appendLocalAllowRules(cwd, [rule])));

    const document = JSON.parse(await fs.readFile(localSettingsPath(cwd), "utf8")) as {
      permissions: { allow: string[] };
    };
    assert.deepEqual([...document.permissions.allow].sort(), [...rules].sort());
  } finally {
    await cleanup();
  }
});

test("permission-store: creates private durable files without leftover staging files", async (t) => {
  const { cwd, cleanup } = await temporaryWorkspace();
  try {
    await appendLocalAllowRules(cwd, ["bash(git status)"]);
    const directory = path.join(cwd, ".anicode");
    const file = localSettingsPath(cwd);
    const entries = await fs.readdir(directory);
    assert.deepEqual(entries, ["settings.local.json"]);

    if (process.platform === "win32") {
      t.diagnostic("POSIX permission bits are not available on Windows");
      return;
    }
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await cleanup();
  }
});

test("permission-store: malformed and oversized settings fail closed without replacement", async () => {
  const { cwd, cleanup } = await temporaryWorkspace();
  const file = localSettingsPath(cwd);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    for (const invalid of [
      Buffer.from("{ broken"),
      Buffer.from("[]"),
      Buffer.from('{"permissions":{"allow":["valid",42]}}'),
      Buffer.from('{"permissions":null}'),
    ]) {
      await fs.writeFile(file, invalid);
      assert.equal(await appendLocalAllowRules(cwd, ["bash(git status)"]), false);
      assert.deepEqual(await fs.readFile(file), invalid);
    }

    const oversized = Buffer.from(`{"padding":"${"x".repeat(256)}"}`);
    await fs.writeFile(file, oversized);
    assert.equal(
      await appendLocalAllowRules(cwd, ["bash(git status)"], { maxFileBytes: 64 }),
      false,
    );
    assert.deepEqual(await fs.readFile(file), oversized);

    const valid = Buffer.from('{"custom":"keep"}');
    await fs.writeFile(file, valid);
    assert.equal(
      await appendLocalAllowRules(cwd, [`bash(${"x".repeat(256)})`], { maxFileBytes: 128 }),
      false,
    );
    assert.deepEqual(await fs.readFile(file), valid);
  } finally {
    await cleanup();
  }
});

test("permission-store: live locks are never stolen based on age and acquisition is bounded", async () => {
  const { cwd, cleanup } = await temporaryWorkspace();
  const file = localSettingsPath(cwd);
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const owner = {
    version: 1,
    pid: process.pid,
    host: hostname(),
    token: randomBytes(32).toString("hex"),
  };
  const serialized = `${JSON.stringify(owner)}\n`;
  await fs.writeFile(lock, serialized, { mode: 0o600 });
  await fs.utimes(lock, new Date(0), new Date(0));

  try {
    const started = performance.now();
    await assert.rejects(
      appendLocalAllowRules(cwd, ["bash(git status)"], {
        lockTimeoutMs: 40,
        lockRetryMs: 5,
      }),
      /Permission store lock timeout/,
    );
    assert.ok(performance.now() - started < 1_000);
    assert.equal(await fs.readFile(lock, "utf8"), serialized);
    await assert.rejects(fs.access(file), { code: "ENOENT" });
  } finally {
    await cleanup();
  }
});

test("permission-store: a verifiably dead same-host owner lock is recovered", async (t) => {
  const deadPid = 2_147_483_647;
  try {
    process.kill(deadPid, 0);
    t.skip("chosen PID unexpectedly exists");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      t.skip("platform cannot verify that the chosen PID is absent");
      return;
    }
  }

  const { cwd, cleanup } = await temporaryWorkspace();
  const file = localSettingsPath(cwd);
  const lock = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    lock,
    `${JSON.stringify({
      version: 1,
      pid: deadPid,
      host: hostname(),
      token: randomBytes(32).toString("hex"),
    })}\n`,
    { mode: 0o600 },
  );

  try {
    assert.equal(await appendLocalAllowRules(cwd, ["bash(git status)"]), true);
    const document = JSON.parse(await fs.readFile(file, "utf8")) as {
      permissions: { allow: string[] };
    };
    assert.deepEqual(document.permissions.allow, ["bash(git status)"]);
    await assert.rejects(fs.access(lock), { code: "ENOENT" });
  } finally {
    await cleanup();
  }
});
