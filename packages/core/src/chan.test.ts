import { test } from "node:test";
import assert from "node:assert/strict";
import { Chan } from "./chan.js";

test("Chan: 消费迭代器建立前 push 的缓冲值，并在 close 后结束", async () => {
  const chan = new Chan<number>();
  chan.push(1);
  chan.push(2);
  chan.close();
  chan.push(3); // close 后静默忽略

  const values: number[] = [];
  for await (const value of chan) values.push(value);

  assert.deepEqual(values, [1, 2]);
});

test("Chan: 等待中的 reader 会被 push 和 close 唤醒", async () => {
  const chan = new Chan<string>();
  const iterator = chan[Symbol.asyncIterator]();

  const first = iterator.next();
  queueMicrotask(() => chan.push("ready"));
  assert.deepEqual(await first, { value: "ready", done: false });

  const end = iterator.next();
  queueMicrotask(() => chan.close());
  assert.deepEqual(await end, { value: undefined, done: true });
});

test("Chan: 大批缓冲事件保持顺序且全部 drain", async () => {
  const chan = new Chan<number>();
  const count = 20_000;
  for (let index = 0; index < count; index++) chan.push(index);
  chan.close();

  const received: number[] = [];
  for await (const value of chan) received.push(value);
  assert.equal(received.length, count);
  assert.equal(received[0], 0);
  assert.equal(received[count - 1], count - 1);
});
