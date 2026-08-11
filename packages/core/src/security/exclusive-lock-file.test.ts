import { test } from "node:test";
import assert from "node:assert/strict";
import type { FileHandle } from "node:fs/promises";
import { openExclusiveLockFile } from "./exclusive-lock-file.js";

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

test("exclusive lock file: Windows transient EPERM is retried before success", async () => {
  const handle = {} as FileHandle;
  const opens: Array<[string, string, number]> = [];
  const waits: number[] = [];
  let attempts = 0;

  const opened = await openExclusiveLockFile("test.lock", 0o600, {
    platform: "win32",
    async open(file, flags, mode) {
      opens.push([file, flags, mode]);
      attempts++;
      if (attempts <= 2) throw errno("EPERM");
      return handle;
    },
    wait(milliseconds) {
      waits.push(milliseconds);
      return Promise.resolve();
    },
  });

  assert.equal(opened, handle);
  assert.equal(attempts, 3);
  assert.deepEqual(opens, [
    ["test.lock", "wx", 0o600],
    ["test.lock", "wx", 0o600],
    ["test.lock", "wx", 0o600],
  ]);
  assert.deepEqual(waits, [10, 10]);
});

test("exclusive lock file: persistent Windows EPERM fails closed after a bounded retry", async () => {
  const permissionError = errno("EPERM");
  let attempts = 0;
  let waits = 0;

  await assert.rejects(
    () =>
      openExclusiveLockFile("test.lock", 0o600, {
        platform: "win32",
        async open() {
          attempts++;
          throw permissionError;
        },
        wait() {
          waits++;
          return Promise.resolve();
        },
      }),
    (error) => error === permissionError,
  );

  assert.equal(attempts, 21);
  assert.equal(waits, 20);
});

test("exclusive lock file: Windows EEXIST remains ordinary lock contention", async () => {
  const contentionError = errno("EEXIST");
  let attempts = 0;

  await assert.rejects(
    () =>
      openExclusiveLockFile("test.lock", 0o600, {
        platform: "win32",
        async open() {
          attempts++;
          throw contentionError;
        },
        wait() {
          assert.fail("EEXIST must remain the caller's lock-contention signal");
        },
      }),
    (error) => error === contentionError,
  );

  assert.equal(attempts, 1);
});

test("exclusive lock file: EPERM is not retried outside Windows", async () => {
  const permissionError = errno("EPERM");
  let attempts = 0;

  await assert.rejects(
    () =>
      openExclusiveLockFile("test.lock", 0o600, {
        platform: "linux",
        async open() {
          attempts++;
          throw permissionError;
        },
        wait() {
          assert.fail("non-Windows EPERM must not be retried");
        },
      }),
    (error) => error === permissionError,
  );

  assert.equal(attempts, 1);
});

test("exclusive lock file: non-EPERM Windows permission failures are not retried", async () => {
  const permissionError = errno("EACCES");
  let attempts = 0;

  await assert.rejects(
    () =>
      openExclusiveLockFile("test.lock", 0o600, {
        platform: "win32",
        async open() {
          attempts++;
          throw permissionError;
        },
        wait() {
          assert.fail("EACCES must not be retried");
        },
      }),
    (error) => error === permissionError,
  );

  assert.equal(attempts, 1);
});
