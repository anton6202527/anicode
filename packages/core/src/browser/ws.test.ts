/**
 * WebSocket 帧编解码单测 —— 这是自研 CDP 传输最易错的一环，锁死三档长度、掩码、
 * 分片边界与握手 key 计算，防止改坏后连不上 Chrome 却难排查。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptKey, encodeTextFrame, decodeFrame } from "./ws.js";

const MASK = Buffer.from([0x12, 0x34, 0x56, 0x78]);

test("acceptKey: RFC 6455 标准向量", () => {
  // RFC 6455 §1.3 的样例：key → base64(sha1(key + GUID))。
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("编解码往返：小负载（<126）掩码帧", () => {
  const frame = encodeTextFrame("hello CDP", MASK);
  const d = decodeFrame(frame)!;
  assert.equal(d.fin, true);
  assert.equal(d.opcode, 0x1);
  assert.equal(d.payload.toString("utf8"), "hello CDP");
  assert.equal(d.size, frame.length);
});

test("编解码往返：16 位长度（126..65535）", () => {
  const text = "x".repeat(1000);
  const frame = encodeTextFrame(text, MASK);
  // 第二字节低 7 位应为 126（表示随后 2 字节才是真实长度）。
  assert.equal(frame[1]! & 0x7f, 126);
  const d = decodeFrame(frame)!;
  assert.equal(d.payload.toString("utf8"), text);
  assert.equal(d.size, frame.length);
});

test("编解码往返：64 位长度（>=65536）", () => {
  const text = "y".repeat(70000);
  const frame = encodeTextFrame(text, MASK);
  assert.equal(frame[1]! & 0x7f, 127);
  const d = decodeFrame(frame)!;
  assert.equal(d.payload.length, 70000);
  assert.equal(d.payload.toString("utf8"), text);
});

test("decodeFrame：数据不足返回 null（等待续包）", () => {
  const frame = encodeTextFrame("partial payload here", MASK);
  assert.equal(decodeFrame(frame.subarray(0, 1)), null, "头不足");
  assert.equal(decodeFrame(frame.subarray(0, frame.length - 3)), null, "负载不足");
});

test("decodeFrame：按 size 切分可连续解出多帧", () => {
  const a = encodeTextFrame("first", MASK);
  const b = encodeTextFrame("second", MASK);
  let buf = Buffer.concat([a, b]);
  const d1 = decodeFrame(buf)!;
  assert.equal(d1.payload.toString("utf8"), "first");
  buf = buf.subarray(d1.size);
  const d2 = decodeFrame(buf)!;
  assert.equal(d2.payload.toString("utf8"), "second");
  assert.equal(buf.subarray(d2.size).length, 0);
});

test("decodeFrame：服务端未掩码文本帧照解", () => {
  // 手工造一个未掩码帧：FIN=1 opcode=0x1，len=3，负载 "abc"。
  const frame = Buffer.from([0x81, 0x03, 0x61, 0x62, 0x63]);
  const d = decodeFrame(frame)!;
  assert.equal(d.opcode, 0x1);
  assert.equal(d.payload.toString("utf8"), "abc");
  assert.equal(d.size, 5);
});

test("decodeFrame：ping 帧（opcode 0x9）识别", () => {
  const frame = Buffer.from([0x89, 0x00]); // FIN + ping，空负载
  const d = decodeFrame(frame)!;
  assert.equal(d.opcode, 0x9);
  assert.equal(d.payload.length, 0);
});

test("decodeFrame：分片文本（FIN=0 + 续帧 0x0）各自解出、由调用方重组", () => {
  // 第一片：opcode=0x1 FIN=0 "he"（掩码）。
  const p1 = encodeTextFrame("he", MASK);
  p1[0] = 0x01; // 清掉 FIN 位
  // 续片：opcode=0x0 FIN=1 "llo"（掩码）。
  const p2 = encodeTextFrame("llo", MASK);
  p2[0] = 0x80; // FIN=1, opcode=0x0
  const d1 = decodeFrame(p1)!;
  const d2 = decodeFrame(p2)!;
  assert.equal(d1.fin, false);
  assert.equal(d1.opcode, 0x1);
  assert.equal(d2.fin, true);
  assert.equal(d2.opcode, 0x0);
  assert.equal(
    Buffer.concat([d1.payload, d2.payload]).toString("utf8"),
    "hello",
    "两片重组应还原原文",
  );
});
