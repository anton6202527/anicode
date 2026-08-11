import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSeatbeltProfile,
  buildBubblewrapArgs,
  wrapWithSandbox,
  resolveSandboxPolicy,
  resolveSandboxNetwork,
  sandboxBinaryAvailable,
  resolveSandboxBinary,
  sensitiveHostReadPaths,
  sandboxHostReadBoundary,
} from "./sandbox.js";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildShellSpawn } from "./shell-spawn.js";

test("sandbox: workspace-write 只放行工作区+临时目录写入并断网", () => {
  const p = buildSeatbeltProfile({ policy: "workspace-write", cwd: "/proj/app" });
  assert.match(p, /\(allow default\)/);
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\* \(subpath "\/proj\/app"\)\)/);
  assert.match(p, /\(deny network\*\)/);
});

test("sandbox: read-only 不放行工作区写入", () => {
  const p = buildSeatbeltProfile({ policy: "read-only", cwd: "/proj/app" });
  assert.doesNotMatch(p, /allow file-write[^\n]+subpath "\/proj\/app"/);
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
  for (const boundary of [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--new-session",
  ]) {
    assert.ok(args.includes(boundary), `${boundary} 必须存在`);
  }
  assert.match(joined, /--tmpfs \/run/);
  assert.match(joined, /--tmpfs \/tmp/);
  assert.match(joined, /--tmpfs \/var\/tmp/);
  assert.doesNotMatch(joined, /--bind(?:-try)? \/tmp \/tmp/);
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

test("shell spawn: Windows 不能把限制策略降级为裸 shell", () => {
  assert.throws(
    () => buildShellSpawn("echo hi", "workspace-write", process.cwd(), "win32"),
    /Sandbox policy workspace-write cannot be enforced on win32/,
  );
  assert.deepEqual(buildShellSpawn("echo hi", "none", process.cwd(), "win32"), {
    file: "/bin/bash",
    args: ["-c", "echo hi"],
  });
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

test("sandbox: resolveSandboxNetwork 默认拒绝，仅显式 on 放行", () => {
  assert.equal(resolveSandboxNetwork({}), false);
  assert.equal(resolveSandboxNetwork({ AGENTX_SANDBOX_NETWORK: "off" }), false);
  assert.equal(resolveSandboxNetwork({ AGENTX_SANDBOX_NETWORK: "0" }), false);
  assert.equal(resolveSandboxNetwork({ AGENTX_SANDBOX_NETWORK: "on" }), true);
});

test("sandbox: sandboxBinaryAvailable 命中 PATH 中的可执行文件", () => {
  // Use the current trusted Node installation so PATH lookup semantics stay covered on every OS.
  const binaryDirectory = path.dirname(process.execPath);
  assert.equal(
    sandboxBinaryAvailable(path.basename(process.execPath), { PATH: binaryDirectory }),
    true,
  );
  assert.equal(
    sandboxBinaryAvailable("definitely-not-a-real-binary-xyz", { PATH: binaryDirectory }),
    false,
  );
});

test("sandbox: 安全边界二进制不接受 PATH 前置的工作区伪造文件", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-fake-sandbox-"));
  const fake = path.join(root, "sandbox-exec");
  await fs.writeFile(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const resolved = resolveSandboxBinary("sandbox-exec", { PATH: root }, "darwin");
  assert.notEqual(resolved, fake);
  assert.ok(resolved === null || resolved === "/usr/bin/sandbox-exec");
  await fs.rm(root, { recursive: true, force: true });
});

test("sandbox: Seatbelt 显式拒绝读取宿主凭据文件和目录", () => {
  const p = buildSeatbeltProfile({
    policy: "workspace-write",
    cwd: "/Users/dev/project",
    deniedReadPaths: [
      { path: "/Users/dev/.ssh", kind: "directory" },
      { path: "/Users/dev/.npmrc", kind: "file" },
    ],
  });
  assert.match(p, /\(deny file-read\* \(subpath "\/Users\/dev\/\.ssh"\)\)/);
  assert.match(p, /\(deny file-read\* \(literal "\/Users\/dev\/\.npmrc"\)\)/);
});

test("sandbox: Seatbelt 拒绝 Keychain XPC，解释器无法绕过 Broker", () => {
  const p = buildSeatbeltProfile({
    policy: "workspace-write",
    cwd: "/Users/dev/project",
    network: true,
  });
  for (const service of [
    "com.apple.securityd.xpc",
    "com.apple.securityd.general",
    "com.apple.securityd.systemkeychain",
    "com.apple.security.XPCKeychainSandboxCheck",
  ]) {
    assert.match(
      p,
      new RegExp(`\\(deny mach-lookup \\(global-name "${service.replaceAll(".", "\\.")}"\\)\\)`),
    );
  }
});

test("sandbox(linux): bubblewrap 在工作区 rebind 后遮蔽宿主凭据", () => {
  const args = buildBubblewrapArgs({
    policy: "workspace-write",
    cwd: "/Users/dev",
    deniedReadPaths: [
      { path: "/Users/dev/.ssh", kind: "directory" },
      { path: "/Users/dev/.npmrc", kind: "file" },
    ],
  });
  const workspaceAt = args.indexOf("/Users/dev");
  const secretAt = args.lastIndexOf("/Users/dev/.ssh");
  assert.ok(secretAt > workspaceAt, "凭据遮蔽必须晚于工作区可写 rebind");
  assert.match(args.join(" "), /--tmpfs \/Users\/dev\/\.ssh/);
  assert.match(args.join(" "), /--ro-bind \/dev\/null \/Users\/dev\/\.npmrc/);
});

test("sandbox: sensitiveHostReadPaths 只返回存在路径并区分文件与目录", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-sensitive-home-"));
  await fs.mkdir(path.join(home, ".ssh"));
  await fs.writeFile(path.join(home, ".npmrc"), "token=secret\n");
  const paths = sensitiveHostReadPaths(home);
  const canonicalHome = await fs.realpath(home);
  assert.deepEqual(
    paths.map((item) => ({ path: path.relative(canonicalHome, item.path), kind: item.kind })),
    [
      { path: ".ssh", kind: "directory" },
      { path: ".npmrc", kind: "file" },
    ],
  );
  await fs.rm(home, { recursive: true, force: true });
});

test("sandbox: 真实 HOME 整体 deny，随后只回挂工作区，最后凭据路径再次 deny", () => {
  const p = buildSeatbeltProfile({
    policy: "workspace-write",
    cwd: "/Users/dev/work/app",
    hiddenReadRoots: ["/Users/dev"],
    readableRoots: ["/Users/dev/.nvm/versions"],
    deniedReadPaths: [{ path: "/Users/dev/work/app/.env", kind: "file" }],
  });
  const homeDeny = p.indexOf('(deny file-read* (subpath "/Users/dev"))');
  const workspaceAllow = p.indexOf('(allow file-read* (subpath "/Users/dev/work/app"))');
  const credentialDeny = p.indexOf('(deny file-read* (literal "/Users/dev/work/app/.env"))');
  assert.ok(homeDeny >= 0 && workspaceAllow > homeDeny && credentialDeny > workspaceAllow);
});

test("sandbox(linux): HOME tmpfs 先于工作区回挂，宿主其它项目不可见", () => {
  const args = buildBubblewrapArgs({
    policy: "workspace-write",
    cwd: "/home/dev/current",
    hiddenReadRoots: ["/home/dev"],
    readableRoots: ["/home/dev/.nvm/versions"],
  });
  const homeMask = args.indexOf("/home/dev");
  const workspaceBind = args.lastIndexOf("/home/dev/current");
  assert.ok(homeMask >= 0 && workspaceBind > homeMask);
  assert.match(args.join(" "), /--tmpfs \/home\/dev/);
});

test("sandbox: sandboxHostReadBoundary 仅回挂存在的工具链，不回挂配置目录", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-read-boundary-"));
  await fs.mkdir(path.join(home, ".nvm", "versions"), { recursive: true });
  await fs.mkdir(path.join(home, ".config", "gh"), { recursive: true });
  const boundary = sandboxHostReadBoundary(home);
  const canonicalHome = await fs.realpath(home);
  assert.deepEqual(boundary.hiddenReadRoots, [canonicalHome]);
  assert.deepEqual(boundary.readableRoots, [path.join(canonicalHome, ".nvm", "versions")]);
  await fs.rm(home, { recursive: true, force: true });
});
