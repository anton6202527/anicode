import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDaemonManagerComposition,
  daemonHelpText,
  parseDaemonArgs,
  prepareSocketDirectory,
  removeStaleSocket,
} from "./launch.js";
import { defaultDaemonSocketPath, isWindowsNamedPipePath } from "./socket-path.js";
import { createLocalRuntimeStack } from "../runtime/local-stack.js";
import { DisabledExecutionRuntime } from "../runtime/isolated-runtime.js";
import { noTelemetry } from "../runtime/telemetry.js";
import type { Provider, StreamEvent, StreamRequest } from "../types.js";

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

test("daemon socket: custom shared or symlink parents fail closed", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX ownership and mode semantics");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-private-parent-"));
  const shared = path.join(root, "shared");
  const actual = path.join(root, "actual");
  const linked = path.join(root, "linked");
  try {
    await fs.mkdir(shared, { mode: 0o755 });
    await fs.chmod(shared, 0o755);
    await assert.rejects(
      prepareSocketDirectory(path.join(shared, "daemon.sock")),
      /must have mode 0700/,
    );
    await fs.mkdir(actual, { mode: 0o700 });
    await fs.symlink(actual, linked);
    await assert.rejects(
      prepareSocketDirectory(path.join(linked, "daemon.sock")),
      /not a real directory/,
    );
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
    "--cwd",
    "./workspace",
    "--accept-edits",
  ]);
  assert.match(args.socketPath, /tmp\/anicode\.sock$/);
  assert.match(args.sessionsDir, /tmp\/sessions$/);
  assert.equal(args.cwd, path.resolve("./workspace"));
  assert.equal(args.permissionMode, "acceptEdits");
  assert.match(daemonHelpText(), /anicode-daemon 0\.0\.1/);

  assert.throws(() => parseDaemonArgs(["--socket"]), /需要一个值/);
  assert.throws(() => parseDaemonArgs(["--wat"]), /未知参数/);
  assert.throws(() => parseDaemonArgs(["--auto", "--accept-edits"]), /不能同时使用/);
  assert.throws(() => parseDaemonArgs(["--sessions", "one", "--sessions", "two"]), /不能重复/);
  assert.throws(() => parseDaemonArgs(["--cwd", "one", "--cwd", "two"]), /不能重复/);
  assert.equal(parseDaemonArgs([]).cwd, path.resolve(process.cwd()));
  assert.equal(
    parseDaemonArgs(["--socket", "\\\\.\\pipe\\anicode-test"]).socketPath,
    "\\\\.\\pipe\\anicode-test",
  );
});

test("daemon composition: Windows restricted runtime does not expose process tools", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-daemon-composition-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const stack = createLocalRuntimeStack(root, { ANICODE_CREDENTIAL_BACKEND: "memory" });
  const requests: StreamRequest[] = [];
  const provider: Provider = {
    name: "capture-daemon-windows",
    async *stream(request): AsyncIterable<StreamEvent> {
      requests.push(request);
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
  const composition = createDaemonManagerComposition({
    cwd: workspace,
    sessionsDir: path.join(root, "sessions"),
    permissionMode: "default",
    runtimeStack: {
      ...stack,
      executionMode: "restricted",
      isolatedRuntime: new DisabledExecutionRuntime("Windows native execution disabled"),
    },
    telemetry: noTelemetry,
    resolveProvider: () => ({ provider, model: "capture" }),
    workspaceTrust: async () => ({
      trusted: false,
      reason: "not-trusted",
      executionSources: [],
      storeFile: path.join(root, "trust.json"),
      assessedAt: new Date().toISOString(),
    }),
  });
  try {
    const session = await composition.manager.createSession({ cwd: workspace, model: "capture" });
    await composition.manager.send(session.id, "safe inspection");
    const schema = (requests[0]?.tools ?? []).map((tool) => tool.name);
    assert.equal(schema.includes("bash"), false);
    assert.equal(schema.includes("bash_output"), false);
    assert.equal(schema.includes("kill_shell"), false);
  } finally {
    await composition.dispose();
    await stack.artifacts.close?.();
    await stack.networkProxy.close();
    await stack.database.close();
    await fs.rm(root, { recursive: true, force: true });
  }
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
