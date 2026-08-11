/**
 * 命令式 hooks：stdin 喂 payload、退出码/输出解释、超时、无效条目剔除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  commandHook,
  commandHooksFromConfig,
  isHookEventName,
  windowsCommandArguments,
} from "./hooks-exec.js";
import { HookExecutionBoundaryError, HookRunner } from "./hooks.js";
import {
  RuntimeTerminationError,
  type ExecutionRuntime,
  type IsolatedRunRequest,
} from "./runtime/isolated-runtime.js";
import { TransactionalExecutionRuntime } from "./runtime/transactional-runtime.js";

const payload = { event: "PreToolUse" as const, cwd: process.cwd(), toolName: "bash" };
const hookFixture = fileURLToPath(new URL("./testutil/fake-command-hook.mjs", import.meta.url));

function fixtureCommand(mode: string): string {
  return [process.execPath, hookFixture, mode].map(shellArg).join(" ");
}

function shellArg(value: string): string {
  if (process.platform === "win32") return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

test("命令 hook: Windows cmd 保留带空格 executable 的内层引号", () => {
  const command = '"C:\\Program Files\\node.exe" "D:\\hook fixtures\\hook.mjs" allow';
  assert.deepEqual(windowsCommandArguments(command), ["/d", "/s", "/c", `"${command}"`]);
});

test("命令 hook: stdout JSON 解析为 HookResult；stdin 收到 payload", async () => {
  const reg = commandHook({
    event: "PreToolUse",
    command: fixtureCommand("allow"),
  });
  const outcome = await new HookRunner([reg]).run(payload);
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.additionalContext, "来自命令hook");
});

test("命令 hook: exit 2 = block，stderr 为理由", async () => {
  const reg = commandHook({
    event: "PreToolUse",
    command: fixtureCommand("block"),
  });
  const outcome = await new HookRunner([reg]).run(payload);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason ?? "", /危险命令/);
});

test("命令 hook: 非 JSON stdout 作为 additionalContext；其他退出码为无操作", async () => {
  const ctxReg = commandHook({
    event: "UserPromptSubmit",
    command: fixtureCommand("context"),
  });
  const out1 = await new HookRunner([ctxReg]).run({ event: "UserPromptSubmit", cwd: "." });
  assert.equal(out1.additionalContext, "当前分支: main");

  const failReg = commandHook({ event: "UserPromptSubmit", command: fixtureCommand("noop") });
  const out2 = await new HookRunner([failReg]).run({ event: "UserPromptSubmit", cwd: "." });
  assert.equal(out2.blocked, false);
  assert.equal(out2.additionalContext, undefined);
});

test("命令 hook: 超时按无操作处理（不挂死 loop）", async () => {
  const reg = commandHook({ event: "Stop", command: fixtureCommand("hang"), timeoutMs: 200 });
  const start = Date.now();
  const outcome = await new HookRunner([reg]).run({ event: "Stop", cwd: "." });
  assert.ok(Date.now() - start < 5_000, "应在超时后立即返回");
  assert.equal(outcome.blocked, false);
});

test(
  "命令 hook: 超时会等待整棵进程树退出，孙进程不能延迟写入",
  { skip: process.platform === "win32" ? "requires POSIX shell process groups" : false },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-hook-tree-"));
    const marker = path.join(root, "orphan-marker");
    try {
      const reg = commandHook({
        event: "Stop",
        command: `(sleep 0.7; printf orphan > ${shellQuote(marker)}) & wait`,
        timeoutMs: 100,
      });
      await new HookRunner([reg]).run({ event: "Stop", cwd: root });
      await new Promise((resolve) => setTimeout(resolve, 800));
      await assert.rejects(fs.access(marker), /ENOENT/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);

test("commandHooksFromConfig: 无效条目剔除，合法条目生效", () => {
  const regs = commandHooksFromConfig([
    { event: "PreToolUse", matcher: "bash", command: "true" },
    { event: "NotAnEvent", command: "true" }, // 未知事件
    { event: "Stop", command: "" }, // 空命令
    null,
  ]);
  assert.equal(regs.length, 1);
  assert.equal(regs[0]!.event, "PreToolUse");
  assert.equal(regs[0]!.matcher, "bash");
  assert.equal(commandHooksFromConfig(undefined).length, 0);
  assert.ok(isHookEventName("SubagentStart"));
  assert.ok(!isHookEventName("Bogus"));
});

test("命令 hook: production runtime 通过 foreground run 收口 stdin、cwd 与策略", async () => {
  let captured: IsolatedRunRequest | undefined;
  const runtime: ExecutionRuntime = {
    async run(request) {
      captured = request;
      const input = JSON.parse(request.stdin ?? "") as { event?: string };
      return {
        exitCode: 0,
        output: JSON.stringify({ additionalContext: input.event }),
        timedOut: false,
        sandboxed: true,
        durationMs: 1,
      };
    },
  };
  const registration = commandHook(
    { event: "SessionStart", command: "untrusted-project-hook" },
    { executionRuntime: runtime },
  );
  const outcome = await new HookRunner([registration]).run({
    event: "SessionStart",
    cwd: process.cwd(),
  });
  assert.equal(outcome.additionalContext, "SessionStart");
  assert.equal(captured?.policy, "workspace-write");
  assert.equal(captured?.network, false);
  assert.equal(captured?.cwd, process.cwd());
  assert.equal(captured?.command, "untrusted-project-hook");
  assert.equal(captured?.includeTransactionSummary, false);
  assert.equal(
    (JSON.parse(captured?.stdin ?? "") as { hook_event_name?: string }).hook_event_name,
    "SessionStart",
  );
});

test("命令 hook: runtime without prepare still executes through run, never host spawn", async () => {
  let executed = false;
  const runtime: ExecutionRuntime = {
    async run() {
      executed = true;
      return {
        exitCode: 2,
        output: "runtime block",
        timedOut: false,
        sandboxed: true,
        durationMs: 1,
      };
    },
  };
  const registration = commandHook(
    { event: "SessionStart", command: "exit 2" },
    { executionRuntime: runtime },
  );
  const outcome = await new HookRunner([registration]).run({
    event: "SessionStart",
    cwd: process.cwd(),
  });
  assert.equal(outcome.blocked, true);
  assert.equal(outcome.reason, "runtime block");
  assert.equal(executed, true);
});

test("命令 hook: abort 不能吞 runtime termination proof failure，runner 持久熔断", async () => {
  const controller = new AbortController();
  let calls = 0;
  let started!: () => void;
  const didStart = new Promise<void>((resolve) => (started = resolve));
  let releaseCleanup!: () => void;
  const cleanupGate = new Promise<void>((resolve) => (releaseCleanup = resolve));
  const runtime: ExecutionRuntime = {
    async run(request) {
      calls++;
      started();
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      await cleanupGate;
      throw new RuntimeTerminationError();
    },
  };
  const runner = new HookRunner([
    commandHook({ event: "Stop", command: "project-hook" }, { executionRuntime: runtime }),
  ]);

  const running = runner.run({ event: "Stop", cwd: process.cwd(), signal: controller.signal });
  await didStart;
  controller.abort(new Error("cancel hook"));
  releaseCleanup();

  await assert.rejects(
    running,
    (error: unknown) =>
      error instanceof HookExecutionBoundaryError && error.cause instanceof RuntimeTerminationError,
  );
  await assert.rejects(
    runner.awaitIdle(),
    (error: unknown) =>
      error instanceof HookExecutionBoundaryError && error.cause instanceof RuntimeTerminationError,
  );
  await assert.rejects(
    runner.run({
      event: "Stop",
      cwd: process.cwd(),
      signal: AbortSignal.abort(new Error("already cancelled")),
    }),
    (error: unknown) => error instanceof HookExecutionBoundaryError,
  );
  assert.equal(calls, 1, "poisoned runner must not start another external command hook");
});

test("命令 hook: Transactional foreground commits writes without leaking PatchSet summary", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-hook-transaction-"));
  const delegate: ExecutionRuntime = {
    async run(request) {
      await fs.writeFile(path.join(request.cwd, "hook.txt"), "committed\n");
      return {
        exitCode: 0,
        output: JSON.stringify({ additionalContext: "clean hook output" }),
        timedOut: false,
        sandboxed: true,
        durationMs: 1,
      };
    },
  };
  try {
    const registration = commandHook(
      { event: "Stop", command: "project-hook" },
      { executionRuntime: new TransactionalExecutionRuntime(delegate) },
    );
    const outcome = await new HookRunner([registration]).run({ event: "Stop", cwd: root });
    assert.equal(outcome.additionalContext, "clean hook output");
    assert.doesNotMatch(outcome.additionalContext ?? "", /PatchSet/);
    assert.equal(await fs.readFile(path.join(root, "hook.txt"), "utf8"), "committed\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
