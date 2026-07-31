import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionHost } from "@anicode/core";
import { DebugLogger, withDebugLogging } from "./debug-log.js";

test("debug log: 默认只记内容长度并保持 SessionHost 行为", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-debug-log-"));
  const file = path.join(dir, "trace.jsonl");
  let disposed = false;
  let sendArgs: unknown[] = [];
  let undoArgs: unknown[] = [];
  const optionalCalls: string[] = [];
  const host: SessionHost = {
    async listSessions() {
      throw new Error("private host failure sk-super-secret-value");
    },
    async createSession(input) {
      return {
        id: "s1",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
        cwd: input.cwd,
        model: input.model,
        running: false,
      };
    },
    async open(_sessionId, listener) {
      listener({ type: "agent", event: { type: "text", text: "private answer" } });
      listener({
        type: "agent",
        event: {
          type: "tool_start",
          id: "tool-1",
          name: "bash",
          ruleKey: "curl -H 'Authorization: Basic very-secret-token' example.invalid",
        },
      });
      return {
        snapshot: {
          meta: {
            id: "s1",
            createdAt: "2026-07-14T00:00:00.000Z",
            updatedAt: "2026-07-14T00:00:00.000Z",
            cwd: "/work",
            model: "debug/demo",
          },
          messages: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          running: false,
          pendingPermissions: [],
        },
        close() {},
      };
    },
    async send(...args) {
      sendArgs = args;
    },
    async interrupt() {},
    async undo(...args) {
      undoArgs = args;
      return { restored: 0, deleted: 0 };
    },
    async answerPermission() {
      return true;
    },
    async forkSession(sessionId, opts) {
      optionalCalls.push(`fork:${sessionId}:${opts?.upToMessage}`);
      return {
        id: "forked",
        createdAt: "2026-07-14T00:00:00.000Z",
        updatedAt: "2026-07-14T00:00:00.000Z",
        cwd: "/work",
        model: "debug/demo",
        running: false,
      };
    },
    async compact(sessionId) {
      optionalCalls.push(`compact:${sessionId}`);
      return { compacted: true, beforeTokens: 10, afterTokens: 4 };
    },
    async setPermissionMode(sessionId, mode) {
      optionalCalls.push(`mode:${sessionId}:${mode}`);
    },
    async setPermissionProfile(sessionId, name) {
      optionalCalls.push(`profile:${sessionId}:${name}`);
      return "acceptEdits";
    },
    async listPermissionProfiles(sessionId) {
      optionalCalls.push(`profiles:${sessionId}`);
      return { default: { mode: "default" } };
    },
    dispose() {
      disposed = true;
    },
  };

  const wrapped = withDebugLogging(host, new DebugLogger(file));
  const seen: string[] = [];
  await wrapped.open("s1", (event) => seen.push(event.type));
  await wrapped.send("s1", "sk-this-must-not-appear", {
    model: "debug/once",
    idempotencyKey: "idem-1",
    traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
  });
  await wrapped.undo("s1", "cp-1", "both");
  await wrapped.forkSession?.("s1", { title: "private fork title", upToMessage: 3 });
  await wrapped.compact?.("s1");
  await wrapped.setPermissionMode?.("s1", "plan");
  assert.equal(await wrapped.setPermissionProfile?.("s1", "workspace"), "acceptEdits");
  assert.deepEqual(await wrapped.listPermissionProfiles?.("s1"), { default: { mode: "default" } });
  await assert.rejects(wrapped.listSessions(), /private host failure/);
  assert.equal(await wrapped.answerPermission("s1", "p1", "allow"), true);
  wrapped.dispose();

  const log = await fs.readFile(file, "utf8");
  assert.deepEqual(seen, ["agent", "agent"]);
  assert.equal(disposed, true);
  assert.deepEqual(sendArgs, [
    "s1",
    "sk-this-must-not-appear",
    {
      model: "debug/once",
      idempotencyKey: "idem-1",
      traceparent: "00-00000000000000000000000000000001-0000000000000001-01",
    },
  ]);
  assert.deepEqual(undoArgs, ["s1", "cp-1", "both"]);
  assert.deepEqual(optionalCalls, [
    "fork:s1:3",
    "compact:s1",
    "mode:s1:plan",
    "profile:s1:workspace",
    "profiles:s1",
  ]);
  assert.doesNotMatch(
    log,
    /private answer|sk-this-must-not-appear|very-secret-token|private host failure|super-secret-value/,
  );
  assert.match(log, /"ruleKeyChars":/);
  assert.match(log, /"kind":"session\.event"/);
  assert.match(log, /"kind":"host\.end"/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  await fs.rm(dir, { recursive: true, force: true });
});

test("debug log: trace 模式按字段脱敏、截断超长内容并轮转", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-debug-log-"));
  const file = path.join(dir, "trace.jsonl");
  const logger = new DebugLogger(file, true, { maxBytes: 512, maxFieldChars: 48 });

  logger.log("secret.fixture", {
    apiKey: "short-value-that-pattern-matching-alone-would-miss",
    nested: { authorization: "Basic hidden-basic-value" },
    command:
      "curl -H 'Authorization: Basic hidden-in-command' -H 'x-api-key: hidden-header' example.invalid",
    providerKey: "AIza0123456789012345678901234567890123456789",
    longText: "x".repeat(200),
  });
  const secretLog = await fs.readFile(file, "utf8");
  assert.doesNotMatch(
    secretLog,
    /short-value|hidden-basic|hidden-in-command|hidden-header|AIza012345/,
  );
  assert.match(secretLog, /\[REDACTED\]/);
  assert.match(secretLog, /truncated/);
  for (let i = 0; i < 12; i++) logger.log("rotation.fixture", { i, value: "y".repeat(80) });

  const current = await fs.readFile(file, "utf8");
  const rotated = await fs.readFile(`${file}.1`, "utf8");
  const combined = `${rotated}\n${current}`;
  assert.match(combined, /truncated/);
  for (const line of [...current.split("\n"), ...rotated.split("\n")].filter(Boolean)) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.ok((await fs.stat(file)).size <= 512);
  assert.ok((await fs.stat(`${file}.1`)).size <= 512);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  await fs.rm(dir, { recursive: true, force: true });
});
