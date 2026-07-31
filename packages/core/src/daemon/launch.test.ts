import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  daemonHelpText,
  parseDaemonArgs,
  prepareSocketDirectory,
  removeStaleSocket,
} from "./launch.js";
import { defaultDaemonSocketPath, isWindowsNamedPipePath } from "./socket-path.js";

test("daemon socket: default endpoint is isolated per user and portable", () => {
  assert.equal(
    defaultDaemonSocketPath({
      platform: "linux",
      tmpdir: "/tmp",
      xdgRuntimeDir: "",
      uid: 1001,
      username: "alice",
    }),
    path.join("/tmp", "anicode-1001", "anicode.sock"),
  );
  assert.equal(
    defaultDaemonSocketPath({
      platform: "linux",
      tmpdir: "/tmp",
      xdgRuntimeDir: "/run/user/1001",
      uid: 1001,
      username: "alice",
    }),
    path.join("/run/user/1001", "anicode", "anicode.sock"),
  );
  assert.equal(
    defaultDaemonSocketPath({ platform: "win32", username: "Alice Smith" }),
    "\\\\.\\pipe\\anicode-Alice_Smith",
  );
  assert.equal(isWindowsNamedPipePath("\\\\.\\pipe\\anicode-alice"), true);
  assert.equal(
    defaultDaemonSocketPath({
      platform: "linux",
      tmpdir: "/tmp",
      xdgRuntimeDir: "relative/runtime",
      uid: 1001,
      username: "alice",
    }),
    path.join("/tmp", "anicode-1001", "anicode.sock"),
  );
});

test("daemon socket: dedicated runtime directory is mode 0700", async () => {
  if (process.platform === "win32") return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-dir-"));
  const socketPath = path.join(root, "runtime", "anicode.sock");
  try {
    await prepareSocketDirectory(socketPath, true);
    assert.equal((await fs.stat(path.dirname(socketPath))).mode & 0o777, 0o700);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("daemon CLI: 严格解析路径、权限与帮助参数", () => {
  const args = parseDaemonArgs([
    "--socket",
    "./tmp/anicode.sock",
    "--sessions",
    "./tmp/sessions",
    "--accept-edits",
  ]);
  assert.match(args.socketPath, /tmp\/anicode\.sock$/);
  assert.match(args.sessionsDir, /tmp\/sessions$/);
  assert.equal(args.permissionMode, "acceptEdits");
  assert.match(daemonHelpText(), /anicode-daemon 0\.0\.1/);

  assert.throws(() => parseDaemonArgs(["--socket"]), /需要一个值/);
  assert.throws(() => parseDaemonArgs(["--wat"]), /未知参数/);
  assert.throws(() => parseDaemonArgs(["--auto", "--accept-edits"]), /不能同时使用/);
  assert.throws(() => parseDaemonArgs(["--sessions", "one", "--sessions", "two"]), /不能重复/);
  assert.equal(
    parseDaemonArgs(["--socket", "\\\\.\\pipe\\anicode-test"]).socketPath,
    "\\\\.\\pipe\\anicode-test",
  );
});

test("daemon CLI: 不会把正在监听的 socket 当作陈旧文件删除", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-launch-"));
  const socketPath = path.join(dir, "active.sock");
  const server = net.createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  await assert.rejects(removeStaleSocket(socketPath), /daemon 已在监听/);
  assert.equal((await fs.lstat(socketPath)).isSocket(), true);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(dir, { recursive: true, force: true });
});
