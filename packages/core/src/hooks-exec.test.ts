/**
 * 命令式 hooks：stdin 喂 payload、退出码/输出解释、超时、无效条目剔除。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { commandHook, commandHooksFromConfig, isHookEventName } from "./hooks-exec.js";
import { HookRunner } from "./hooks.js";

const payload = { event: "PreToolUse" as const, cwd: process.cwd(), toolName: "bash" };

test("命令 hook: stdout JSON 解析为 HookResult；stdin 收到 payload", async () => {
  const reg = commandHook({
    event: "PreToolUse",
    // 从 stdin 读 payload，校验字段后输出 JSON 决策
    command: `node -e '
      let s = "";
      process.stdin.on("data", (d) => (s += d));
      process.stdin.on("end", () => {
        const p = JSON.parse(s);
        if (p.hook_event_name !== "PreToolUse" || p.toolName !== "bash") process.exit(1);
        console.log(JSON.stringify({ decision: "allow", additionalContext: "来自命令hook" }));
      });
    '`,
  });
  const outcome = await new HookRunner([reg]).run(payload);
  assert.equal(outcome.allowed, true);
  assert.equal(outcome.additionalContext, "来自命令hook");
});

test("命令 hook: exit 2 = block，stderr 为理由", async () => {
  const reg = commandHook({
    event: "PreToolUse",
    command: `echo '危险命令，拒绝' 1>&2; exit 2`,
  });
  const outcome = await new HookRunner([reg]).run(payload);
  assert.equal(outcome.blocked, true);
  assert.match(outcome.reason ?? "", /危险命令/);
});

test("命令 hook: 非 JSON stdout 作为 additionalContext；其他退出码为无操作", async () => {
  const ctxReg = commandHook({ event: "UserPromptSubmit", command: `echo '当前分支: main'` });
  const out1 = await new HookRunner([ctxReg]).run({ event: "UserPromptSubmit", cwd: "." });
  assert.equal(out1.additionalContext, "当前分支: main");

  const failReg = commandHook({ event: "UserPromptSubmit", command: `echo oops; exit 3` });
  const out2 = await new HookRunner([failReg]).run({ event: "UserPromptSubmit", cwd: "." });
  assert.equal(out2.blocked, false);
  assert.equal(out2.additionalContext, undefined);
});

test("命令 hook: 超时按无操作处理（不挂死 loop）", async () => {
  const reg = commandHook({ event: "Stop", command: "sleep 30", timeoutMs: 200 });
  const start = Date.now();
  const outcome = await new HookRunner([reg]).run({ event: "Stop", cwd: "." });
  assert.ok(Date.now() - start < 5_000, "应在超时后立即返回");
  assert.equal(outcome.blocked, false);
});

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
