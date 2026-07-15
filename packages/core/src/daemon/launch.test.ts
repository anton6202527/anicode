import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { daemonHelpText, parseDaemonArgs, removeStaleSocket } from "./launch.js";

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
