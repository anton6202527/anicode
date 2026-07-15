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
    async send() {},
    async interrupt() {},
    async answerPermission() {
      return true;
    },
    dispose() {
      disposed = true;
    },
  };

  const wrapped = withDebugLogging(host, new DebugLogger(file));
  const seen: string[] = [];
  await wrapped.open("s1", (event) => seen.push(event.type));
  await wrapped.send("s1", "sk-this-must-not-appear");
  await assert.rejects(wrapped.listSessions(), /private host failure/);
  assert.equal(await wrapped.answerPermission("s1", "p1", "allow"), true);
  wrapped.dispose();

  const log = await fs.readFile(file, "utf8");
  assert.deepEqual(seen, ["agent", "agent"]);
  assert.equal(disposed, true);
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
