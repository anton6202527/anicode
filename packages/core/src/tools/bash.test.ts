/**
 * bash 前台执行的输出契约测试：
 * - 超时不是「无结果」：命令挂住前打印的内容必须如实回传（回归：旧实现只丢一句超时）；
 * - 超长输出保留头和尾：构建/测试的失败摘要几乎总在结尾，只留头部等于丢了最有用那段。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bashTool,
  systemCredentialStoreAccessReason,
  systemNetworkMutationReason,
} from "./bash.js";
import type { ToolContext } from "./tool.js";

function ctx(): ToolContext {
  return { cwd: process.cwd(), signal: new AbortController().signal };
}

test("bash: 超时返回终止前已捕获的输出（带 [timeout] 标记），而非丢弃", async () => {
  // 先写一大块（>管道缓冲，强制刷出）再挂 5s；1.5s 超时被 SIGKILL。
  // 用 node 保证跨平台可用，不依赖 python/coreutils。
  const command = `node -e "process.stdout.write('MARKER '.repeat(4000)); setTimeout(()=>{}, 5000)"`;
  const out = await bashTool.run({ command, timeout_ms: 1500 }, ctx());
  assert.match(out, /\[timeout 1500ms\]/);
  assert.match(out, /MARKER/); // 终止前的输出被保留下来
});

test("bash: 超长输出保留头与尾，中段截断（尾部摘要不丢）", async () => {
  const command = `node -e "process.stdout.write('HEADMARK\\n' + 'x'.repeat(60000) + '\\nTAILMARK\\n')"`;
  const out = await bashTool.run({ command }, ctx());
  assert.match(out, /\[exit 0\]/);
  assert.match(out, /HEADMARK/); // 头部保留
  assert.match(out, /TAILMARK/); // 尾部保留（回归：旧实现只留头部会丢掉这段）
  assert.match(out, /中段已截断/); // 明确的截断提示
});

test("bash: 空输出命令回报 (无输出) 与退出码", async () => {
  const out = await bashTool.run({ command: "true" }, ctx());
  assert.match(out, /\[exit 0\]/);
  assert.match(out, /无输出/);
});

test("bash: host network mutations are blocked even through common command wrappers", async () => {
  const mutations = [
    "networksetup -setwebproxy Wi-Fi 127.0.0.1 8080",
    "sudo -u root /usr/sbin/networksetup -setdnsservers Wi-Fi 1.1.1.1",
    "eval 'networksetup -setwebproxystate Wi-Fi off'",
    "sh -c 'route add default 10.0.0.1'",
    "ip route replace default via 10.0.0.1",
    "ifconfig en0 inet 10.0.0.2 netmask 255.255.255.0",
    "resolvectl dns eth0 1.1.1.1",
    "nmcli networking off",
    "pfctl -f /tmp/rules.conf",
    "iptables -F",
    "nft add rule inet filter output drop",
    "systemctl restart NetworkManager",
    "killall -HUP mDNSResponder",
    "echo nameserver 1.1.1.1 > /etc/resolv.conf",
    "sudo tee /etc/hosts",
    "Set-DnsClientServerAddress -InterfaceAlias Ethernet -ServerAddresses 1.1.1.1",
  ];
  for (const command of mutations) {
    assert.ok(systemNetworkMutationReason(command), command);
  }
  assert.throws(
    () => bashTool.run({ command: mutations[0] }, ctx()),
    /拒绝修改宿主网络配置|Refusing host network reconfiguration/,
  );
});

test("bash: read-only network diagnostics remain available", () => {
  const diagnostics = [
    "networksetup -getwebproxy Wi-Fi",
    "scutil --proxy",
    "route -n get default",
    "ifconfig en0",
    "ip route show",
    "resolvectl status",
    "nmcli connection show",
    "pfctl -sr",
    "iptables -L",
    "nft list ruleset",
    "netsh winhttp show proxy",
    "cat /etc/hosts | grep localhost",
  ];
  for (const command of diagnostics) {
    assert.equal(systemNetworkMutationReason(command), undefined, command);
  }
});

test("bash: host credential-store clients are blocked before spawn through supported wrappers", () => {
  const attempts = [
    "security find-generic-password -s anicode -w",
    "/usr/bin/security find-internet-password -s api.example.test -w",
    "LC_ALL=C security find-generic-password -s anicode -w",
    "env LC_ALL=C /usr/bin/security find-generic-password -s anicode -w",
    "command -- secret-tool lookup service anicode",
    "sudo -n /usr/bin/secret-tool search service anicode",
    "bash -lc 'security dump-keychain'",
    "sh -c '/usr/bin/secret-tool lookup service anicode'",
    "doas kwallet-query -r anicode kdewallet",
    "cmd /c cmdkey /list",
    "cmd.exe /c C:/Windows/System32/cmdkey.exe /list",
    "powershell -Command 'cmdkey.exe /list'",
  ];
  for (const command of attempts) {
    assert.ok(systemCredentialStoreAccessReason(command), command);
    assert.throws(
      () => bashTool.run({ command }, ctx()),
      /拒绝访问宿主凭据库|Refusing host credential-store access/,
      command,
    );
  }
});

test("bash: ordinary commands mentioning credential client names remain unchanged", () => {
  const ordinary = [
    "echo security",
    "printf '%s\\n' secret-tool",
    "env printf '%s\\n' security",
    "command printf '%s\\n' secret-tool",
    "bash -lc 'printf %s security'",
    "sudo -n printf '%s\\n' cmdkey",
    "rg 'kwallet-query|cmdkey' packages/core/src",
    "node -e \"console.log('security')\"",
  ];
  for (const command of ordinary) {
    assert.equal(systemCredentialStoreAccessReason(command), undefined, command);
  }
});
