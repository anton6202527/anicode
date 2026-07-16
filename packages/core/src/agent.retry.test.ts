import { test } from "node:test";
import assert from "node:assert/strict";
import { retryAfterMs } from "./agent.js";

test("retryAfterMs 解析秒数（Headers 实例）", () => {
  const err = { status: 429, headers: new Headers({ "retry-after": "5" }) };
  assert.equal(retryAfterMs(err), 5000);
});

test("retryAfterMs 解析秒数（普通对象 header）", () => {
  const err = { status: 429, headers: { "retry-after": "2" } };
  assert.equal(retryAfterMs(err), 2000);
});

test("retryAfterMs 解析 HTTP 日期", () => {
  const now = Date.parse("2026-07-15T00:00:00Z");
  const err = { headers: { "retry-after": "Wed, 15 Jul 2026 00:00:10 GMT" } };
  assert.equal(retryAfterMs(err, now), 10_000);
});

test("retryAfterMs 无 header 返回 null", () => {
  assert.equal(retryAfterMs({ status: 500 }), null);
  assert.equal(retryAfterMs(new Error("boom")), null);
  assert.equal(retryAfterMs(null), null);
});

test("retryAfterMs 负值/非法值返回 null", () => {
  assert.equal(retryAfterMs({ headers: { "retry-after": "-3" } }), null);
  assert.equal(retryAfterMs({ headers: { "retry-after": "soon" } }), null);
});
