import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExecutionRuntime, IsolatedRunRequest } from "./isolated-runtime.js";
import { Verifier } from "./verifier.js";

async function fixtureWorkspace(prefix: string): Promise<string> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(cwd, "source.ts"), "export const value = 1;\n");
  return cwd;
}

test("Verifier: configured checks fail closed when no ExecutionRuntime is injected", async (t) => {
  const cwd = await fixtureWorkspace("anicode-verifier-missing-");
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const report = await new Verifier({
    policy: { checks: [{ id: "would-run", command: "touch", args: ["unexpected"] }] },
  }).verify({ cwd });
  assert.equal(report.status, "failed");
  assert.match(report.checks[0]?.reason ?? "", /raw process fallback is forbidden/);
});

test("Verifier: commands use the isolated workspace runtime with sanitized offline input", async (t) => {
  const cwd = await fixtureWorkspace("anicode-verifier-input-");
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let request: IsolatedRunRequest | undefined;
  const runtime: ExecutionRuntime = {
    async run(input) {
      request = input;
      await fs.writeFile(path.join(input.cwd, "source.ts"), "malicious verifier write\n");
      return { exitCode: 0, output: "ok", timedOut: false, sandboxed: true, durationMs: 1 };
    },
  };
  const previous = process.env.ANICODE_VERIFIER_TEST_SECRET;
  process.env.ANICODE_VERIFIER_TEST_SECRET = "must-not-leak";
  try {
    const report = await new Verifier({
      executionRuntime: runtime,
      policy: {
        checks: [{ id: "quoted", command: "tool name", args: ["a b", "x'y"] }],
      },
    }).verify({ cwd });
    assert.equal(report.status, "passed");
    assert.equal(request?.policy, "workspace-write");
    assert.equal(request?.network, false);
    assert.equal(request?.env?.ANICODE_VERIFIER_TEST_SECRET, undefined);
    assert.equal(request?.command, `'tool name' 'a b' 'x'\\''y'`);
    assert.notEqual(request?.cwd, cwd);
    assert.equal(
      await fs.readFile(path.join(cwd, "source.ts"), "utf8"),
      "export const value = 1;\n",
    );
    assert.equal(report.workspaceRevisionBefore, report.workspaceRevisionAfter);
  } finally {
    if (previous === undefined) delete process.env.ANICODE_VERIFIER_TEST_SECRET;
    else process.env.ANICODE_VERIFIER_TEST_SECRET = previous;
  }
});

test("Verifier: a required check skipped behind an optional failure still fails the report", async (t) => {
  const cwd = await fixtureWorkspace("anicode-verifier-dependency-");
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const runtime: ExecutionRuntime = {
    async run(input) {
      return {
        exitCode: input.command.includes("optional-fail") ? 2 : 0,
        output: "",
        timedOut: false,
        sandboxed: true,
        durationMs: 1,
      };
    },
  };
  const report = await new Verifier({
    executionRuntime: runtime,
    policy: {
      checks: [
        { id: "optional", command: "optional-fail", required: false },
        { id: "required", command: "required-check", dependencies: ["optional"] },
      ],
    },
  }).verify({ cwd });
  assert.equal(report.checks.find((check) => check.id === "required")?.status, "skipped");
  assert.equal(report.status, "failed");
});

test("Verifier: no applicable checks is failed evidence, not a successful skip", async () => {
  const report = await new Verifier({
    executionRuntime: {
      async run() {
        throw new Error("must not run");
      },
    },
  }).verify({ cwd: process.cwd(), changedFiles: ["src/a.ts"] });
  assert.equal(report.status, "failed");
  assert.equal(report.checks.length, 0);
  assert.match(report.summary, /No applicable verification evidence/);
});

test("Verifier: optional-only checks cannot satisfy the completion gate", async () => {
  let ran = false;
  const report = await new Verifier({
    executionRuntime: {
      async run() {
        ran = true;
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 1 };
      },
    },
    policy: { checks: [{ id: "lint", command: "lint", required: false }] },
  }).verify({ cwd: process.cwd() });
  assert.equal(report.status, "failed");
  assert.equal(ran, false);
  assert.match(report.summary, /No required verification evidence/);
});

test("Verifier: all checks share one disposable clone", async (t) => {
  const cwd = await fixtureWorkspace("anicode-verifier-single-clone-");
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const staged = new Set<string>();
  let active = 0;
  let maxActive = 0;
  const report = await new Verifier({
    executionRuntime: {
      async run(request) {
        staged.add(request.cwd);
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 1 };
      },
    },
    policy: {
      checks: [
        { id: "one", command: "one" },
        { id: "two", command: "two" },
      ],
    },
  }).verify({ cwd });
  assert.equal(report.status, "passed");
  assert.equal(staged.size, 1);
  assert.notEqual([...staged][0], cwd);
  assert.equal(maxActive, 1);
});

test("Verifier: a real-workspace edit during checks invalidates revision evidence", async (t) => {
  const cwd = await fixtureWorkspace("anicode-verifier-revision-");
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const report = await new Verifier({
    executionRuntime: {
      async run() {
        await fs.writeFile(path.join(cwd, "source.ts"), "external concurrent edit\n");
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 1 };
      },
    },
    policy: { checks: [{ id: "pass", command: "pass" }] },
  }).verify({ cwd });
  assert.equal(report.status, "failed");
  assert.notEqual(report.workspaceRevisionBefore, report.workspaceRevisionAfter);
  assert.match(
    report.checks.find((check) => check.id === "anicode.workspace-revision")?.reason ?? "",
    /Workspace changed during verification/,
  );
});

test("Verifier: cancellation during revision capture starts no checks", async (t) => {
  const cwd = await fixtureWorkspace("anicode-verifier-revision-abort-");
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  let ran = false;
  const controller = new AbortController();
  controller.abort(new Error("cancel evidence"));
  const report = await new Verifier({
    executionRuntime: {
      async run() {
        ran = true;
        return { exitCode: 0, output: "", timedOut: false, sandboxed: true, durationMs: 1 };
      },
    },
    policy: { checks: [{ id: "pass", command: "pass" }] },
  }).verify({ cwd, signal: controller.signal });
  assert.equal(report.status, "cancelled");
  assert.equal(ran, false);
});
