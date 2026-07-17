/**
 * 权限档位（profile）测试：内置档位语义、规则叠加不洗掉基础 deny、
 * 直接 setMode 后档位名失效、Agent 层解析与未知档位报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { Agent } from "./agent.js";
import type { Provider } from "./types.js";
import {
  BUILTIN_PROFILES,
  PermissionEngine,
  type PermissionRequest,
} from "./permission.js";

function req(toolName: string, ruleKey = toolName): PermissionRequest {
  return {
    toolName,
    input: {},
    ruleKey,
    toolCallId: "c1",
    signal: new AbortController().signal,
  };
}

test("profile: 内置四档位模式映射正确", () => {
  assert.equal(BUILTIN_PROFILES.readonly!.mode, "plan");
  assert.equal(BUILTIN_PROFILES.default!.mode, "default");
  assert.equal(BUILTIN_PROFILES.workspace!.mode, "acceptEdits");
  assert.equal(BUILTIN_PROFILES.full!.mode, "auto");
});

test("profile: readonly 档位只放行只读工具，写/执行被拒", async () => {
  const engine = new PermissionEngine({ mode: "auto" });
  engine.applyProfile("readonly", BUILTIN_PROFILES.readonly!);
  assert.equal(engine.getProfile(), "readonly");
  assert.equal(engine.getMode(), "plan");
  assert.equal((await engine.check(req("read"))).behavior, "allow");
  assert.equal((await engine.check(req("write"))).behavior, "deny");
  assert.equal((await engine.check(req("bash", "rm -rf x"))).behavior, "deny");
});

test("profile: workspace 档位自动放行编辑类工具，bash 仍需确认", async () => {
  let confirmed = 0;
  const engine = new PermissionEngine({
    editTools: ["write", "edit"],
    confirm: async () => {
      confirmed++;
      return { behavior: "allow" };
    },
  });
  engine.applyProfile("workspace", BUILTIN_PROFILES.workspace!);
  assert.equal((await engine.check(req("write"))).behavior, "allow");
  assert.equal(confirmed, 0, "编辑类工具不应走 confirm");
  assert.equal((await engine.check(req("bash", "npm test"))).behavior, "allow");
  assert.equal(confirmed, 1, "bash 应走 confirm");
});

test("profile: 切档位不洗掉基础 deny 规则（deny 永远最高）", async () => {
  const engine = new PermissionEngine({ denyRules: ["Bash(rm *)"] });
  engine.applyProfile("full", BUILTIN_PROFILES.full!);
  assert.equal(engine.getMode(), "auto");
  assert.equal((await engine.check(req("bash", "rm -rf /tmp/x"))).behavior, "deny");
  assert.equal((await engine.check(req("bash", "git status"))).behavior, "allow");
});

test("profile: 档位自带规则叠加在基础之上，换档位即替换叠加层", async () => {
  const engine = new PermissionEngine({ allowRules: ["Bash(git status)"] });
  engine.applyProfile("ci", { mode: "default", allowRules: ["Bash(npm test)"] });
  assert.equal((await engine.check(req("bash", "npm test"))).behavior, "allow");
  assert.equal((await engine.check(req("bash", "git status"))).behavior, "allow"); // 基础仍在

  engine.applyProfile("default", BUILTIN_PROFILES.default!);
  // ci 档位的叠加 allow 已被替换；无 confirm → deny
  assert.equal((await engine.check(req("bash", "npm test"))).behavior, "deny");
  assert.equal((await engine.check(req("bash", "git status"))).behavior, "allow");
});

test("profile: 直接 setMode 后档位名失效（避免撒谎）", () => {
  const engine = new PermissionEngine({});
  engine.applyProfile("readonly", BUILTIN_PROFILES.readonly!);
  assert.equal(engine.getProfile(), "readonly");
  engine.setMode("default");
  assert.equal(engine.getProfile(), null);
  assert.equal(engine.getMode(), "default");
});

const stubProvider: Provider = {
  name: "stub",
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error("不应被调用");
  },
};

test("profile(Agent): 内置+自定义档位可切，未知档位名报错并列出可用项", () => {
  const agent = new Agent({
    provider: stubProvider,
    model: "stub",
    cwd: os.tmpdir(),
    projectMemory: false,
    injectEnv: false,
    permissionProfiles: {
      ci: { mode: "auto", description: "CI: auto-approve with deny rules" },
    },
  });
  // 内置档位
  assert.equal(agent.setPermissionProfile("readonly"), "plan");
  assert.equal(agent.getPermissionMode(), "plan");
  assert.equal(agent.getPermissionProfile(), "readonly");
  // 自定义档位
  assert.equal(agent.setPermissionProfile("ci"), "auto");
  assert.equal(agent.getPermissionProfile(), "ci");
  // 列表包含内置与自定义
  const names = Object.keys(agent.listPermissionProfiles());
  for (const n of ["readonly", "default", "workspace", "full", "ci"])
    assert.ok(names.includes(n), `缺 ${n}`);
  // 未知档位
  assert.throws(() => agent.setPermissionProfile("nope"), /nope|可用|Available/);
  // setPermissionMode（如 /plan）后档位名清空
  agent.setPermissionMode("default");
  assert.equal(agent.getPermissionProfile(), null);
});
