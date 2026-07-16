/**
 * 权限引擎升级项测试：deny/ask 规则、acceptEdits 模式、
 * 复合命令拆分匹配、hookAllowed 的边界。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { globMatch, PermissionEngine, type PermissionRequest } from "./permission.js";
import { analyzeShellCommand, splitShellCommand, bashTool } from "./tools/bash.js";

function req(over: Partial<PermissionRequest>): PermissionRequest {
  return {
    toolName: "bash",
    input: {},
    ruleKey: "",
    toolCallId: "t1",
    signal: new AbortController().signal,
    ...over,
  };
}

test("权限: deny 规则压过 allowRules 和 bypass", async () => {
  const engine = new PermissionEngine({
    mode: "bypass",
    allowRules: ["Bash"],
    denyRules: ["Bash(rm *)"],
  });
  const d = await engine.check(req({ ruleKey: "rm -rf /", ruleParts: ["rm -rf /"] }));
  assert.equal(d.behavior, "deny");
  assert.match(d.message!, /deny 规则/);
  // 非命中项在 bypass 下照常放行
  const ok = await engine.check(req({ ruleKey: "ls", ruleParts: ["ls"] }));
  assert.equal(ok.behavior, "allow");
});

test("权限: glob 的 * 覆盖换行，不能用 quoted newline 绕过 deny", async () => {
  assert.equal(globMatch("rm *", "rm foo\nbar"), true);
  const engine = new PermissionEngine({ mode: "bypass", denyRules: ["Bash(rm *)"] });
  const d = await engine.check(req({ ruleKey: "rm foo\nbar" }));
  assert.equal(d.behavior, "deny");
});

test("权限: updatedInput + remember 不会记住原始动作", async () => {
  let confirmations = 0;
  const engine = new PermissionEngine({
    confirm: async () => {
      confirmations++;
      return {
        behavior: "allow",
        updatedInput: { command: "safe" },
        remember: true,
      };
    },
  });
  const request = req({ ruleKey: "danger", input: { command: "danger" } });
  const first = await engine.check(request);
  const second = await engine.check(request);
  assert.equal(first.remember, false);
  assert.equal(second.remember, false);
  assert.equal(confirmations, 2);
});

test("权限: ask 规则强制 confirm，即使只读工具", async () => {
  let confirmCalled = false;
  const engine = new PermissionEngine({
    readOnlyTools: ["read"],
    askRules: ["Read(secret*)"],
    confirm: async () => {
      confirmCalled = true;
      return { behavior: "allow" };
    },
  });
  const d = await engine.check(req({ toolName: "read", ruleKey: "secret.txt" }));
  assert.equal(d.behavior, "allow");
  assert.equal(confirmCalled, true, "ask 规则必须走 confirm");
  // 非命中的只读路径不问
  confirmCalled = false;
  await engine.check(req({ toolName: "read", ruleKey: "public.txt" }));
  assert.equal(confirmCalled, false);
});

test("权限: 显式 ask 规则在 bypass 模式下仍强制 confirm", async () => {
  let confirmCalled = false;
  const engine = new PermissionEngine({
    mode: "bypass",
    askRules: ["Bash(deploy *)"],
    confirm: async () => {
      confirmCalled = true;
      return { behavior: "deny" };
    },
  });
  const decision = await engine.check(req({ ruleKey: "deploy prod" }));
  assert.equal(confirmCalled, true);
  assert.equal(decision.behavior, "deny");
});

test("权限: acceptEdits 自动放行文件编辑类，bash 仍要问", async () => {
  const engine = new PermissionEngine({ mode: "acceptEdits", editTools: ["write", "edit"] });
  const w = await engine.check(req({ toolName: "write", ruleKey: "src/a.ts" }));
  assert.equal(w.behavior, "allow");
  const b = await engine.check(req({ toolName: "bash", ruleKey: "npm install" }));
  assert.equal(b.behavior, "deny"); // 无 confirm 的非交互环境 → deny
  assert.match(b.message!, /需要授权/);
});

test("权限: 复合命令逐段匹配 —— allow 要求每段命中", async () => {
  const engine = new PermissionEngine({ allowRules: ["Bash(git *)"] });
  // 全 git → 放行
  const ok = await engine.check(
    req({
      ruleKey: "git status && git log",
      ruleParts: splitShellCommand("git status && git log"),
    }),
  );
  assert.equal(ok.behavior, "allow");
  // 夹带 rm → 不能被 git 前缀放行
  const bad = await engine.check(
    req({
      ruleKey: "git status && rm -rf /",
      ruleParts: splitShellCommand("git status && rm -rf /"),
    }),
  );
  assert.equal(bad.behavior, "deny");
});

test("权限: hookAllowed 跳过 confirm，但压不过 deny/ask", async () => {
  const noConfirm = new PermissionEngine({});
  const allowed = await noConfirm.check(
    req({ toolName: "write", ruleKey: "a.ts", hookAllowed: true }),
  );
  assert.equal(allowed.behavior, "allow");

  const withDeny = new PermissionEngine({ denyRules: ["Write"] });
  const denied = await withDeny.check(
    req({ toolName: "write", ruleKey: "a.ts", hookAllowed: true }),
  );
  assert.equal(denied.behavior, "deny");

  const withAsk = new PermissionEngine({ askRules: ["Write"] }); // 无 confirm
  const asked = await withAsk.check(req({ toolName: "write", ruleKey: "a.ts", hookAllowed: true }));
  assert.equal(asked.behavior, "deny"); // 强制问但没人可问
});

test("splitShellCommand: 顶层操作符拆分，引号内不拆", () => {
  assert.deepEqual(splitShellCommand("git status && git log"), ["git status", "git log"]);
  assert.deepEqual(splitShellCommand('echo "a && b" && ls'), ['echo "a && b"', "ls"]);
  assert.deepEqual(splitShellCommand("cat f | grep x; pwd || ls"), [
    "cat f",
    "grep x",
    "pwd",
    "ls",
  ]);
  assert.deepEqual(splitShellCommand("ls"), ["ls"]);
  assert.deepEqual(splitShellCommand("git status & rm x\nprintf ok"), [
    "git status",
    "rm x",
    "printf ok",
  ]);
  assert.deepEqual(splitShellCommand("echo a\\;b && pwd"), ['echo "a;b"', "pwd"]);
});

test("bash: 真 shell 沙箱落地前一律串行", () => {
  assert.equal(bashTool.isConcurrencySafe!({ command: "ls -la | head -5" }), false);
  assert.equal(bashTool.isConcurrencySafe!({ command: "git status && git diff" }), false);
  assert.equal(bashTool.isConcurrencySafe!({ command: "npm install" }), false);
  assert.equal(bashTool.isConcurrencySafe!({ command: "ls && rm x" }), false);
});

test("权限: shell 后台操作符与复杂语法不能绕过细粒度 allow", async () => {
  const engine = new PermissionEngine({ allowRules: ["Bash(git *)"] });

  const background = analyzeShellCommand("git status & rm -rf /tmp/x");
  const d1 = await engine.check(
    req({
      ruleKey: "git status & rm -rf /tmp/x",
      ruleParts: background.parts,
      rulePartsComplete: background.complete,
    }),
  );
  assert.equal(d1.behavior, "deny");

  const substitution = analyzeShellCommand("git status $(rm -rf /tmp/x)");
  assert.equal(substitution.complete, false);
  const d2 = await engine.check(
    req({
      ruleKey: "git status $(rm -rf /tmp/x)",
      ruleParts: substitution.parts,
      rulePartsComplete: substitution.complete,
    }),
  );
  assert.equal(d2.behavior, "deny");
});

test("权限: 复杂 shell 在 bypass 下也压不过已配置 deny 规则", async () => {
  const engine = new PermissionEngine({ mode: "bypass", denyRules: ["Bash(rm *)"] });
  const analysis = analyzeShellCommand("echo $(rm -rf /tmp/x)");
  const decision = await engine.check(
    req({
      ruleKey: "echo $(rm -rf /tmp/x)",
      ruleParts: analysis.parts,
      rulePartsComplete: analysis.complete,
    }),
  );
  assert.equal(decision.behavior, "deny");
});

test("权限: 等价 rm 写法与命令包装器无法绕过 deny", async () => {
  const engine = new PermissionEngine({ mode: "bypass", denyRules: ["Bash(rm *)"] });
  const samples = [
    "rm\t-rf /tmp/x",
    '"rm" -rf /tmp/x',
    'r""m -rf /tmp/x',
    "r\\m -rf /tmp/x",
    "/bin/rm -rf /tmp/x",
    "env rm -rf /tmp/x",
    "command rm -rf /tmp/x",
    'bash -c "rm -rf /tmp/x"',
    "if true; then rm -rf /tmp/x; fi",
    "! rm -rf /tmp/x",
    "X=1 rm -rf /tmp/x",
  ];
  for (const command of samples) {
    const analysis = analyzeShellCommand(command);
    const decision = await engine.check(
      req({
        ruleKey: command,
        ruleParts: analysis.parts,
        rulePartsComplete: analysis.complete,
      }),
    );
    assert.equal(decision.behavior, "deny", command);
  }
});

test("权限: git 配置 alias 的任意命令入口不能命中 Bash(git *)", async () => {
  const command = 'git -c alias.pwn="!rm -rf /tmp/x" pwn';
  const analysis = analyzeShellCommand(command);
  assert.equal(analysis.complete, false);
  const engine = new PermissionEngine({ allowRules: ["Bash(git *)"] });
  const decision = await engine.check(
    req({
      ruleKey: command,
      ruleParts: analysis.parts,
      rulePartsComplete: analysis.complete,
    }),
  );
  assert.equal(decision.behavior, "deny");
});

test("权限: 同名可执行路径和双引号反斜杠不能冒充 allow 的命令", async () => {
  const engine = new PermissionEngine({ allowRules: ["Bash(git *)"] });
  for (const command of ["./malicious/git status", '"g\\\\it" status']) {
    const analysis = analyzeShellCommand(command);
    const decision = await engine.check(
      req({
        ruleKey: command,
        ruleParts: analysis.parts,
        rulePartsComplete: analysis.complete,
      }),
    );
    assert.equal(decision.behavior, "deny", command);
  }
});

test("权限: 计划模式只读放行、写/执行拒绝并给反射提示", async () => {
  const engine = new PermissionEngine({ mode: "plan" });
  // 只读工具放行
  const read = await engine.check(req({ toolName: "read", ruleKey: "a.ts" }));
  assert.equal(read.behavior, "allow");
  const grep = await engine.check(req({ toolName: "grep", ruleKey: "foo" }));
  assert.equal(grep.behavior, "allow");
  // 写/执行拒绝，理由引导模型转为规划
  const write = await engine.check(req({ toolName: "write", ruleKey: "a.ts" }));
  assert.equal(write.behavior, "deny");
  assert.match(write.message!, /计划模式|Plan mode/);
  const bash = await engine.check(req({ toolName: "bash", ruleKey: "npm i" }));
  assert.equal(bash.behavior, "deny");
});

test("权限: setMode 运行时切换，退出计划模式后写操作可走确认", async () => {
  let asked = 0;
  const engine = new PermissionEngine({
    mode: "plan",
    confirm: async () => {
      asked++;
      return { behavior: "allow" };
    },
  });
  assert.equal((await engine.check(req({ toolName: "write", ruleKey: "a.ts" }))).behavior, "deny");
  assert.equal(engine.getMode(), "plan");
  engine.setMode("default");
  const d = await engine.check(req({ toolName: "write", ruleKey: "a.ts" }));
  assert.equal(d.behavior, "allow");
  assert.equal(asked, 1, "退出计划模式后写操作应走 confirm");
});

test("权限: 计划模式下 deny 规则仍优先", async () => {
  const engine = new PermissionEngine({ mode: "plan", denyRules: ["Read(secret*)"] });
  const d = await engine.check(
    req({ toolName: "read", ruleKey: "secret.txt", ruleParts: ["secret.txt"] }),
  );
  assert.equal(d.behavior, "deny");
  assert.match(d.message!, /deny 规则/);
});
