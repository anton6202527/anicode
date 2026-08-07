import { test } from "node:test";
import assert from "node:assert/strict";
import { SteeringInbox } from "./steering.js";

test("SteeringInbox: 窗口关着时 enqueue 返回 false，开窗后入队", () => {
  const inbox = new SteeringInbox();
  assert.equal(inbox.enqueue("a"), false);
  inbox.open(true);
  assert.equal(inbox.enqueue("b"), true);
  assert.equal(inbox.hasQueued(), true);
  assert.equal(inbox.shiftQueued(), "b");
  assert.equal(inbox.hasQueued(), false);
});

test("SteeringInbox: open(false) 不开窗（中断已发生时 closing 不得回到 active）", () => {
  const inbox = new SteeringInbox();
  inbox.open(false);
  assert.equal(inbox.isAccepting, false);
  assert.equal(inbox.enqueue("x"), false);
});

test("SteeringInbox: clear 先关窗再清队列 —— 清空后同步到达的消息进不了本轮", () => {
  const inbox = new SteeringInbox();
  inbox.open(true);
  inbox.enqueue("a");
  inbox.enqueue("b");
  assert.equal(inbox.clear(), 2);
  assert.equal(inbox.isAccepting, false);
  // interrupt 的 abort 回调同步再投递：必须被拒（排到下一 drive），不能塞回本轮
  assert.equal(inbox.enqueue("c"), false);
  assert.equal(inbox.hasQueued(), false);
});

test("SteeringInbox: input count and UTF-8 bytes are hard bounded", () => {
  const countBounded = new SteeringInbox(undefined, {
    maxQueuedInputs: 2,
    maxQueuedBytes: 100,
    maxInputBytes: 100,
  });
  countBounded.open(true);
  assert.equal(countBounded.enqueue("a"), true);
  assert.equal(countBounded.enqueue("b"), true);
  assert.throws(() => countBounded.enqueue("c"), /capacity exceeded/);
  assert.equal(countBounded.shiftQueued(), "a");
  assert.equal(
    countBounded.enqueue("c"),
    true,
    "draining must return both count and byte capacity",
  );

  const byteBounded = new SteeringInbox(undefined, {
    maxQueuedInputs: 10,
    maxQueuedBytes: 6,
    maxInputBytes: 4,
  });
  byteBounded.open(true);
  assert.equal(byteBounded.enqueue("中"), true);
  assert.equal(byteBounded.enqueue("文"), true);
  assert.throws(() => byteBounded.enqueue("a"), /capacity exceeded/);
  byteBounded.clear();
  assert.equal(byteBounded.enqueue("a"), false, "clear also closes the acceptance window");

  const itemBounded = new SteeringInbox(undefined, {
    maxQueuedInputs: 10,
    maxQueuedBytes: 100,
    maxInputBytes: 2,
  });
  itemBounded.open(true);
  assert.throws(() => itemBounded.enqueue("中"), /exceeds 2 bytes/);
});

test("SteeringInbox: 通知投递① 运行中且窗口开 → 通知队列（turn 边界注入）", () => {
  const inbox = new SteeringInbox(() => assert.fail("不应走 onIdle"));
  inbox.open(true);
  inbox.deliverNotice("done-1", true);
  assert.equal(inbox.hasNotices(), true);
  assert.equal(inbox.shiftNotice(), "done-1");
});

test("SteeringInbox: 通知投递② 空闲 → onIdle 出口（宿主自动发起 drive）", () => {
  const idle: string[] = [];
  const inbox = new SteeringInbox((text) => idle.push(text));
  inbox.deliverNotice("done-2", false);
  assert.deepEqual(idle, ["done-2"]);
  assert.equal(inbox.hasNotices(), false);
});

test("SteeringInbox: 运行中但窗口关（收尾窗口）不进通知队列，走空闲投递", () => {
  const idle: string[] = [];
  const inbox = new SteeringInbox((text) => idle.push(text));
  inbox.deliverNotice("done-3", true); // running 但从未 open
  assert.deepEqual(idle, ["done-3"]);
});

test("SteeringInbox: 通知投递③ 无 onIdle 出口时积压，promotePending 并入通知队列", () => {
  const inbox = new SteeringInbox();
  inbox.deliverNotice("p1", false);
  inbox.deliverNotice("p2", false);
  assert.equal(inbox.hasNotices(), false); // 在积压区，不在通知队列
  assert.equal(inbox.promotePending(), true);
  assert.equal(inbox.shiftNotice(), "p1");
  assert.equal(inbox.shiftNotice(), "p2");
  assert.equal(inbox.promotePending(), false);
});

test("SteeringInbox: flushLeftover 把没赶上 turn 边界的通知转 onIdle 投递", () => {
  const idle: string[] = [];
  const inbox = new SteeringInbox((text) => idle.push(text));
  inbox.open(true);
  inbox.deliverNotice("n1", true); // 进通知队列
  inbox.clear(); // send 收尾：关窗
  inbox.flushLeftover();
  assert.deepEqual(idle, ["n1"]);
  assert.equal(inbox.hasNotices(), false);
});

test("SteeringInbox: flushLeftover 无出口时落入积压，供下一次 send 注入", () => {
  const inbox = new SteeringInbox();
  inbox.open(true);
  inbox.deliverNotice("n2", true);
  inbox.clear();
  inbox.flushLeftover();
  assert.equal(inbox.hasNotices(), false);
  assert.equal(inbox.promotePending(), true);
  assert.equal(inbox.shiftNotice(), "n2");
});
