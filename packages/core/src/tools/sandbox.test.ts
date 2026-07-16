import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSeatbeltProfile,
  buildBubblewrapArgs,
  wrapWithSandbox,
  resolveSandboxPolicy,
  resolveSandboxNetwork,
  sandboxBinaryAvailable,
} from "./sandbox.js";

test("sandbox: workspace-write 只放行工作区+临时目录写入并断网", () => {
  const p = buildSeatbeltProfile({ policy: "workspace-write", cwd: "/proj/app" });
  assert.match(p, /\(allow default\)/);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/proj\/app"\)\)/);
  assert.match(p, /\(deny network\*\)/);
});

test("sandbox: read-only 不放行工作区写入", () => {
  const p = buildSeatbeltProfile({ policy: "read-only", cwd: "/proj/app" });
  assert.doesNotMatch(p, /subpath "\/proj\/app"/);
  assert.match(p, /\(deny network\*\)/);
  assert.match(p, /subpath "\/dev"/); // 仍允许写 /dev
});

test("sandbox: network=true 时不加断网规则", () => {
  const p = buildSeatbeltProfile({ policy: "workspace-write", cwd: "/x", network: true });
  assert.doesNotMatch(p, /deny network/);
});

test("sandbox: 路径含引号被转义，避免 SBPL 注入", () => {
  const p = buildSeatbeltProfile({ policy: "workspace-write", cwd: '/a"b' });
  assert.match(p, /subpath "\/a\\"b"/);
});

test("sandbox: readOnlySubpaths 的 deny 出现在工作区 allow 之后（last-match-wins 生效）", () => {
  const p = buildSeatbeltProfile({
    policy: "workspace-write",
    cwd: "/proj/app",
    readOnlySubpaths: ["/proj/app/.git"],
  });
  const allowAt = p.indexOf('(allow file-write* (subpath "/proj/app"))');
  const denyAt = p.indexOf('(deny file-write* (subpath "/proj/app/.git"))');
  assert.ok(allowAt >= 0 && denyAt >= 0, "两条规则都应存在");
  assert.ok(denyAt > allowAt, "deny 必须在 allow 之后，才能压过工作区放行");
});

test("sandbox: read-only 不发出 readOnlySubpaths（本就整盘只读，无需额外 deny）", () => {
  const p = buildSeatbeltProfile({
    policy: "read-only",
    cwd: "/proj/app",
    readOnlySubpaths: ["/proj/app/.git"],
  });
  assert.doesNotMatch(p, /\.git/);
});

test("sandbox(linux): bubblewrap 整盘只读 + 工作区可写 + .git 回只读 + 断网", () => {
  const args = buildBubblewrapArgs({
    policy: "workspace-write",
    cwd: "/proj/app",
    readOnlySubpaths: ["/proj/app/.git"],
    network: false,
  });
  const joined = args.join(" ");
  assert.match(joined, /--ro-bind \/ \//); // 整盘只读打底
  assert.ok(args.includes("--bind") && args.includes("/proj/app"), "工作区应可写 rebind");
  assert.match(joined, /--ro-bind-try \/proj\/app\/\.git \/proj\/app\/\.git/); // .git 回只读
  assert.ok(args.includes("--unshare-net"), "断网");
  assert.match(joined, /--chdir \/proj\/app/);
});

test("sandbox(linux): network=true 不 unshare-net；read-only 用私有 tmpfs 且无工作区可写", () => {
  const withNet = buildBubblewrapArgs({ policy: "workspace-write", cwd: "/x", network: true });
  assert.ok(!withNet.includes("--unshare-net"));

  const ro = buildBubblewrapArgs({ policy: "read-only", cwd: "/x", network: false });
  assert.ok(ro.includes("--tmpfs") && ro.includes("/tmp"), "read-only 给私有 tmpfs 作 scratch");
  // read-only 不应把工作区绑成可写。
  const idx = ro.indexOf("--bind");
  assert.ok(idx === -1, "read-only 不应出现可写 --bind");
});

test("sandbox: wrapWithSandbox 按平台选择 seatbelt/bwrap，none 或未知平台返回 null", () => {
  const mac = wrapWithSandbox("echo hi", { policy: "workspace-write", cwd: "/p" }, "darwin");
  assert.equal(mac!.file, "sandbox-exec");
  assert.deepEqual(mac!.args.slice(-3), ["/bin/bash", "-c", "echo hi"]);

  const lin = wrapWithSandbox("echo hi", { policy: "workspace-write", cwd: "/p" }, "linux");
  assert.equal(lin!.file, "bwrap");
  assert.deepEqual(lin!.args.slice(-3), ["/bin/bash", "-c", "echo hi"]);

  assert.equal(wrapWithSandbox("echo hi", { policy: "workspace-write", cwd: "/p" }, "win32"), null);
  assert.equal(wrapWithSandbox("echo hi", { policy: "none", cwd: "/p" }, "darwin"), null);
});

test("sandbox: resolveSandboxPolicy 显式优先，其次环境变量，默认收紧到 workspace-write", () => {
  assert.equal(resolveSandboxPolicy("read-only", {}), "read-only");
  assert.equal(
    resolveSandboxPolicy(undefined, { AGENTX_BASH_SANDBOX: "workspace-write" }),
    "workspace-write",
  );
  assert.equal(resolveSandboxPolicy(undefined, {}), "workspace-write"); // 默认不再是 none
  assert.equal(resolveSandboxPolicy("none", {}), "none"); // 显式关闭仍生效
  assert.equal(resolveSandboxPolicy("none", { AGENTX_BASH_SANDBOX: "read-only" }), "read-only");
});

test("sandbox: resolveSandboxNetwork 默认放行，AGENTX_SANDBOX_NETWORK=off 断网", () => {
  assert.equal(resolveSandboxNetwork({}), true);
  assert.equal(resolveSandboxNetwork({ AGENTX_SANDBOX_NETWORK: "off" }), false);
  assert.equal(resolveSandboxNetwork({ AGENTX_SANDBOX_NETWORK: "0" }), false);
  assert.equal(resolveSandboxNetwork({ AGENTX_SANDBOX_NETWORK: "on" }), true);
});

test("sandbox: sandboxBinaryAvailable 命中 PATH 中的可执行文件", () => {
  // /bin/sh 几乎必然存在且可执行；用自定义 env 避免污染默认缓存。
  assert.equal(sandboxBinaryAvailable("sh", { PATH: "/bin" }), true);
  assert.equal(sandboxBinaryAvailable("definitely-not-a-real-binary-xyz", { PATH: "/bin" }), false);
});
