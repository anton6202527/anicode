import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DurableRuntime,
  FileRuntimeSnapshotStore,
  MemoryRuntimeEventStore,
  type RuntimeSnapshot,
  type RuntimeSnapshotStore,
} from "./durable.js";

function snapshot(streamId: string, sequence = 1): RuntimeSnapshot {
  return {
    version: 1,
    streamId,
    sequence,
    phase: "queued",
    activeTools: [],
    events: sequence,
    createdAt: new Date(0).toISOString(),
  };
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("file runtime snapshot: Windows transient rename EPERM is retried", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-runtime-snapshot-"));
  const waits: number[] = [];
  let attempts = 0;
  try {
    const store = new FileRuntimeSnapshotStore(directory, {
      platform: "win32",
      wait(milliseconds) {
        waits.push(milliseconds);
        return Promise.resolve();
      },
      async rename(source, destination) {
        attempts++;
        if (attempts <= 2) throw errno("EPERM");
        await fs.rename(source, destination);
      },
    });

    await store.put(snapshot("stream"));

    assert.equal(attempts, 3);
    assert.deepEqual(waits, [10, 10]);
    assert.equal((await store.get("stream"))?.sequence, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("file runtime snapshot: persistent Windows rename EPERM fails closed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-runtime-snapshot-"));
  const permissionError = errno("EPERM");
  let attempts = 0;
  let waits = 0;
  try {
    const store = new FileRuntimeSnapshotStore(directory, {
      platform: "win32",
      wait() {
        waits++;
        return Promise.resolve();
      },
      rename() {
        attempts++;
        return Promise.reject(permissionError);
      },
    });

    await assert.rejects(
      () => store.put(snapshot("stream")),
      (error) => error === permissionError,
    );
    assert.equal(attempts, 21);
    assert.equal(waits, 20);
    assert.equal(await store.get("stream"), undefined);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("durable runtime: concurrent same-stream snapshots cannot overwrite a newer sequence", async () => {
  let stored: RuntimeSnapshot | undefined;
  let putCalls = 0;
  let releaseFirstPut!: () => void;
  let markFirstPutStarted!: () => void;
  const firstPutStarted = new Promise<void>((resolve) => (markFirstPutStarted = resolve));
  const firstPutGate = new Promise<void>((resolve) => (releaseFirstPut = resolve));
  const snapshots: RuntimeSnapshotStore = {
    async get() {
      return stored;
    },
    async put(next) {
      putCalls++;
      if (putCalls === 1) {
        markFirstPutStarted();
        await firstPutGate;
      }
      stored = next;
    },
    async delete() {
      stored = undefined;
    },
  };
  const runtime = new DurableRuntime(new MemoryRuntimeEventStore(), snapshots, 1);

  const firstRecord = runtime.record({
    streamId: "stream",
    type: "prompt.accepted",
    data: {},
  });
  await firstPutStarted;

  const secondRecord = runtime.record({
    streamId: "stream",
    type: "tool.started",
    data: { id: "tool-1" },
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(putCalls, 1, "the second projection must wait for the first put to settle");
  } finally {
    releaseFirstPut();
    await Promise.all([firstRecord, secondRecord]);
  }

  assert.equal(stored?.sequence, 2);
  assert.equal(stored?.events, 2);
  assert.deepEqual(stored?.activeTools, ["tool-1"]);
});

test("durable runtime: delete waits for a pending snapshot and cannot be resurrected", async () => {
  let stored: RuntimeSnapshot | undefined;
  let deleteCalled = false;
  let releasePut!: () => void;
  let markPutStarted!: () => void;
  const putStarted = new Promise<void>((resolve) => (markPutStarted = resolve));
  const putGate = new Promise<void>((resolve) => (releasePut = resolve));
  const snapshots: RuntimeSnapshotStore = {
    async get() {
      return stored;
    },
    async put(next) {
      markPutStarted();
      await putGate;
      stored = next;
    },
    async delete() {
      deleteCalled = true;
      stored = undefined;
    },
  };
  const events = new MemoryRuntimeEventStore();
  const runtime = new DurableRuntime(events, snapshots, 1);

  const pendingRecord = runtime.record({
    streamId: "stream",
    type: "prompt.accepted",
    data: {},
  });
  await putStarted;

  let deleteSettled = false;
  const pendingDelete = runtime.deleteStream("stream").then(() => {
    deleteSettled = true;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deleteCalled, false, "delete must wait for the pending snapshot write");
    assert.equal(deleteSettled, false);
  } finally {
    releasePut();
    await Promise.all([pendingRecord, pendingDelete]);
  }

  assert.equal(stored, undefined);
  assert.deepEqual(await events.read("stream"), []);
  assert.deepEqual(await runtime.recover("stream"), {
    streamId: "stream",
    sequence: 0,
    phase: "idle",
    activeTools: [],
    events: 0,
  });
});
