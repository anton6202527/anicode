import { test } from "node:test";
import assert from "node:assert/strict";
import type * as net from "node:net";
import { DaemonServer } from "./server.js";
import type { SessionManager } from "../session-manager.js";

type DaemonServerInternals = {
  server: net.Server;
  conns: Set<net.Socket>;
  isClosing: boolean;
  onConnection(socket: net.Socket): void;
};

function fakeSocket(onDestroy: () => void): net.Socket {
  const socket = {
    destroy() {
      onDestroy();
      return socket;
    },
  } as unknown as net.Socket;
  return socket;
}

test("DaemonServer.close fences a late accept before draining tracked connections", async () => {
  const order: string[] = [];
  const manager = {
    dispose() {
      order.push("manager.dispose");
    },
  } as unknown as SessionManager;
  const daemon = new DaemonServer({ manager, unsafeAllowUnauthenticatedForTests: true });
  const internals = daemon as unknown as DaemonServerInternals;
  const tracked = fakeSocket(() => order.push("tracked.destroy"));
  const late = fakeSocket(() => order.push("late.destroy"));
  internals.conns.add(tracked);

  let finishClose!: (error?: Error) => void;
  const fakeServer = {
    close(callback: (error?: Error) => void) {
      order.push("server.close");
      // Model an IPC connection accepted by the OS before close, whose JavaScript callback is
      // delivered only after listener shutdown starts.
      internals.onConnection(late);
      finishClose = callback;
      return fakeServer;
    },
  } as unknown as net.Server;
  internals.server = fakeServer;

  const firstClose = daemon.close();
  const secondClose = daemon.close();

  assert.strictEqual(secondClose, firstClose, "concurrent close calls must share one drain");
  assert.equal(internals.isClosing, true);
  assert.deepEqual(order, ["server.close", "late.destroy", "tracked.destroy", "manager.dispose"]);
  assert.equal(
    internals.conns.has(tracked),
    true,
    "tracked sockets remain owned until their close/error cleanup runs",
  );
  assert.equal(internals.conns.has(late), false, "a late accept is never installed");

  finishClose();
  await firstClose;
});

test("DaemonServer.close ignores only the idempotent not-running condition", async () => {
  const daemon = new DaemonServer({
    manager: { dispose() {} } as unknown as SessionManager,
    unsafeAllowUnauthenticatedForTests: true,
  });
  const internals = daemon as unknown as DaemonServerInternals;
  internals.server = {
    close(callback: (error?: Error) => void) {
      const error = Object.assign(new Error("not running"), { code: "ERR_SERVER_NOT_RUNNING" });
      queueMicrotask(() => callback(error));
      return this;
    },
  } as unknown as net.Server;

  await daemon.close();
});

test("DaemonServer.close propagates listener shutdown errors", async () => {
  const daemon = new DaemonServer({
    manager: { dispose() {} } as unknown as SessionManager,
    unsafeAllowUnauthenticatedForTests: true,
  });
  const internals = daemon as unknown as DaemonServerInternals;
  internals.server = {
    close(callback: (error?: Error) => void) {
      queueMicrotask(() => callback(new Error("injected close failure")));
      return this;
    },
  } as unknown as net.Server;

  await assert.rejects(daemon.close(), /injected close failure/);
});
