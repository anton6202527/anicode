import { test } from "node:test";
import assert from "node:assert/strict";
import { isClientRequest } from "./protocol.js";

test("daemon protocol: accepts complete valid request shapes", () => {
  assert.equal(isClientRequest({ id: 0, method: "listSessions" }), true);
  assert.equal(isClientRequest({ id: 0, method: "listSessions", authToken: "a".repeat(32) }), true);
  assert.equal(isClientRequest({ id: 0, method: "listSessions", authToken: "bad\nvalue" }), false);
  assert.equal(
    isClientRequest({ id: 1, method: "discoverModels", providerId: "cliproxy.local-1" }),
    true,
  );
  assert.equal(
    isClientRequest({
      id: 1,
      method: "send",
      sessionId: "s_abc-123",
      text: "hello",
      model: "openai/gpt-5",
      idempotencyKey: "request-1",
      traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
    }),
    true,
  );
  assert.equal(
    isClientRequest({
      id: 2,
      method: "fork",
      sessionId: "s_abc",
      upToMessage: 0,
      model: "openai/gpt-5",
    }),
    true,
  );
});

test("daemon protocol: rejects malformed optional fields before dispatch", () => {
  const send = { id: 1, method: "send", sessionId: "s_abc", text: "hello" };
  assert.equal(isClientRequest({ ...send, model: { name: "unexpected" } }), false);
  assert.equal(isClientRequest({ ...send, idempotencyKey: 42 }), false);
  assert.equal(isClientRequest({ ...send, idempotencyKey: "x".repeat(257) }), false);
  assert.equal(isClientRequest({ ...send, traceparent: "" }), false);
  assert.equal(isClientRequest({ ...send, sessionId: "../escape" }), false);
  assert.equal(isClientRequest({ ...send, text: "" }), false);
});

test("daemon protocol: rejects negative indexes, ids and unbounded metadata", () => {
  assert.equal(isClientRequest({ id: -1, method: "listSessions" }), false);
  assert.equal(
    isClientRequest({ id: 1, method: "fork", sessionId: "s_abc", upToMessage: -1 }),
    false,
  );
  assert.equal(isClientRequest({ id: 1, method: "fork", sessionId: "s_abc", model: "" }), false);
  assert.equal(isClientRequest({ id: 1, method: "createSession", cwd: "/tmp", model: "" }), false);
  assert.equal(
    isClientRequest({ id: 1, method: "setPermissionProfile", sessionId: "s_abc", name: "" }),
    false,
  );
  assert.equal(
    isClientRequest({ id: 1, method: "discoverModels", providerId: "../cliproxy" }),
    false,
  );
  assert.equal(
    isClientRequest({ id: 1, method: "discoverModels", providerId: "x".repeat(129) }),
    false,
  );
});
