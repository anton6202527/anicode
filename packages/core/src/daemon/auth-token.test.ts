import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_HTTP_DAEMON_PORT,
  defaultDaemonAuthTokenPath,
  defaultHttpDaemonAuthTokenPath,
  generateDaemonAuthToken,
  provisionDaemonAuthToken,
  readDaemonAuthToken,
  validateDaemonAuthToken,
  windowsDaemonAuthTokenPath,
} from "./auth-token.js";

test("daemon auth token: generated values have at least 256 bits and are URL-safe", () => {
  const first = generateDaemonAuthToken();
  const second = generateDaemonAuthToken();
  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => generateDaemonAuthToken(31), /at least 32/);
  assert.equal(DEFAULT_HTTP_DAEMON_PORT, 8327);
  const httpTokenPath = defaultHttpDaemonAuthTokenPath(DEFAULT_HTTP_DAEMON_PORT);
  assert.match(httpTokenPath, /\.token$/);
  assert.equal(defaultHttpDaemonAuthTokenPath(), httpTokenPath);
  assert.match(defaultHttpDaemonAuthTokenPath(0), /\.token$/);
  assert.throws(() => defaultHttpDaemonAuthTokenPath(-1), /Invalid HTTP daemon port/);
  assert.throws(() => validateDaemonAuthToken("too-short"), /at least 32 bytes/);
  assert.throws(() => validateDaemonAuthToken(`x${"a".repeat(31)}\t`), /control characters/);
  assert.throws(() => validateDaemonAuthToken(` ${"a".repeat(32)}`), /surrounding whitespace/);
});

test("daemon auth token: Windows account names are hashed, never embedded as path segments", () => {
  const socketPath = "\\\\.\\pipe\\anicode-DOMAIN_user";
  const first = windowsDaemonAuthTokenPath(socketPath, "C:\\Temp", "DOMAIN\\alice/admin");
  const second = windowsDaemonAuthTokenPath(socketPath, "C:\\Temp", "DOMAIN\\alice/admin");
  assert.equal(first, second);
  assert.doesNotMatch(first, /DOMAIN|alice|admin/);
  assert.match(first, /anicode-[0-9a-f]{16}/);
});

test("daemon auth token: Unix socket path gets an adjacent 0600 runtime file", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-token-"));
  const socketPath = path.join(root, "anicode.sock");
  try {
    assert.equal(defaultDaemonAuthTokenPath(socketPath), `${socketPath}.token`);
    const provisioned = await provisionDaemonAuthToken({ socketPath });
    assert.equal(provisioned.tokenFile, `${socketPath}.token`);
    assert.equal(await readDaemonAuthToken(provisioned.tokenFile), provisioned.token);
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(provisioned.tokenFile)).mode & 0o777, 0o600);
    }

    const rotated = await provisionDaemonAuthToken({
      socketPath,
      token: "replacement-token-without-newlines",
    });
    assert.equal(await readDaemonAuthToken(rotated.tokenFile), rotated.token);
    const maximum = await provisionDaemonAuthToken({ socketPath, token: "x".repeat(4 * 1024) });
    assert.equal(await readDaemonAuthToken(maximum.tokenFile), maximum.token);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon auth token: unsafe files and symlink replacement fail closed", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode and symlink semantics");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-auth-token-"));
  try {
    const openFile = path.join(root, "open.token");
    await fs.writeFile(openFile, "secret\n", { mode: 0o644 });
    await assert.rejects(() => readDaemonAuthToken(openFile), /permissions must be 0600/);

    const realFile = path.join(root, "real.token");
    const linkedFile = path.join(root, "linked.token");
    await fs.writeFile(realFile, "original\n", { mode: 0o600 });
    await fs.symlink(realFile, linkedFile);
    await assert.rejects(
      () => provisionDaemonAuthToken({ tokenFile: linkedFile }),
      /Refusing to replace non-regular/,
    );
    assert.equal(await fs.readFile(realFile, "utf8"), "original\n");
    await assert.rejects(() => readDaemonAuthToken(linkedFile), /symlink/);

    const oversized = path.join(root, "oversized.token");
    await fs.writeFile(oversized, "x".repeat(4 * 1024 + 1), { mode: 0o600 });
    await assert.rejects(() => readDaemonAuthToken(oversized), /exceeds 4096 bytes/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
