import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  loadConfig,
  loadConfigWithWorkspaceTrust,
  loadProjectEnv,
  toMcpServerConfigs,
  toSubagentDefinitions,
} from "./config.js";
import { WorkspaceTrustStore, type WorkspaceTrustAssessment } from "./workspace-trust.js";
import { assertProductionHttpMcpConfigs } from "./mcp.js";

async function tmp(): Promise<{ home: string; cwd: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cfg-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  await fs.mkdir(path.join(home, ".config", "anicode"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".anicode"), { recursive: true });
  return { home, cwd, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

async function grant(
  home: string,
  cwd: string,
): Promise<{
  store: WorkspaceTrustStore;
  assessment: WorkspaceTrustAssessment;
}> {
  const store = new WorkspaceTrustStore({
    file: path.join(home, ".config", "anicode", "trust", "workspaces.json"),
  });
  return { store, assessment: await store.grant(cwd) };
}

test("config: 全局与项目合并，项目覆盖全局", async () => {
  const { home, cwd, cleanup } = await tmp();
  await fs.writeFile(
    path.join(home, ".config", "anicode", "anicode.json"),
    JSON.stringify({
      model: "global/model",
      smallModel: true,
      mcp: { g: { command: "gcmd" } },
      tui: { keybindings: { reconnect: "ctrl+x" } },
    }),
  );
  await fs.writeFile(
    path.join(cwd, "anicode.json"),
    JSON.stringify({
      model: "proj/model",
      mcp: { p: { command: "pcmd", args: ["x"] } },
      tui: { keybindings: { externalEditor: "ctrl+e" } },
    }),
  );
  const { assessment } = await grant(home, cwd);
  const { config, sources, warnings } = await loadConfig({ cwd, home, workspaceTrust: assessment });
  assert.equal(config.model, "proj/model"); // 项目覆盖
  assert.equal(config.smallModel, true); // 全局保留
  assert.deepEqual(Object.keys(config.mcp ?? {}).sort(), ["g", "p"]); // mcp 深合并
  assert.deepEqual(config.tui?.keybindings, {
    reconnect: "ctrl+x",
    externalEditor: "ctrl+e",
  });
  assert.equal(sources.length, 2);
  assert.deepEqual(warnings, []);
  await cleanup();
});

test("config: 非法 JSON 只记 warning 不抛，未知键提示", async () => {
  const { home, cwd, cleanup } = await tmp();
  await fs.writeFile(path.join(cwd, "anicode.json"), "{ not json");
  await fs.writeFile(
    path.join(cwd, ".anicode", "anicode.json"),
    JSON.stringify({ model: "ok/model", bogus: 1 }),
  );
  const { config, warnings } = await loadConfig({ cwd, home });
  assert.equal(config.model, "ok/model");
  assert.ok(warnings.some((w) => /JSON (?:parse failed|解析失败)/.test(w)));
  assert.ok(warnings.some((w) => /(?:unknown config key|未知配置项) "bogus"/.test(w)));
  await cleanup();
});

test("config: 转换 mcp / agents 为运行期结构", () => {
  const mcp = toMcpServerConfigs({
    mcp: { fs: { command: "srv", args: ["--root", "."], discoveryTimeoutMs: 750 } },
  });
  assert.deepEqual(mcp, [
    { name: "fs", command: "srv", args: ["--root", "."], discoveryTimeoutMs: 750 },
  ]);
  const agents = toSubagentDefinitions({
    agents: { reviewer: { description: "评审", prompt: "你是评审", tools: ["read", "grep"] } },
  });
  assert.deepEqual(agents, [
    { name: "reviewer", description: "评审", system: "你是评审", tools: ["read", "grep"] },
  ]);
});

test("config: production MCP gate rejects stdio before the connector can run", () => {
  const http = toMcpServerConfigs({ mcp: { remote: { url: "https://mcp.example.test" } } });
  assert.doesNotThrow(() => assertProductionHttpMcpConfigs(http));
  const stdio = toMcpServerConfigs({ mcp: { local: { command: "must-not-spawn" } } });
  assert.throws(
    () => assertProductionHttpMcpConfigs(stdio),
    /Production stdio MCP server local is disabled/,
  );
});

test("config: 无任何文件时返回空配置且无告警", async () => {
  const { home, cwd, cleanup } = await tmp();
  const { config, sources, warnings } = await loadConfig({ cwd, home });
  assert.deepEqual(config, {});
  assert.deepEqual(sources, []);
  assert.deepEqual(warnings, []);
  await cleanup();
});

test("config: 项目 env 安全加载，已有环境与 .env.local 优先", async () => {
  const { cwd, cleanup } = await tmp();
  await fs.writeFile(
    path.join(cwd, ".env"),
    'DEEPSEEK_API_KEY=base-key\nQUOTED="hello world"\nINLINE=value # comment\n',
  );
  await fs.writeFile(
    path.join(cwd, ".env.local"),
    "export DEEPSEEK_API_KEY=local-key\nLOCAL_ONLY='yes'\n",
  );
  const env: NodeJS.ProcessEnv = { QUOTED: "from-shell" };
  const { assessment } = await grant(path.dirname(cwd), cwd);
  const loaded = await loadProjectEnv({ cwd, env, workspaceTrust: assessment });
  assert.deepEqual(loaded, [path.join(cwd, ".env.local"), path.join(cwd, ".env")]);
  assert.equal(env.DEEPSEEK_API_KEY, "local-key");
  assert.equal(env.QUOTED, "from-shell");
  assert.equal(env.INLINE, "value");
  assert.equal(env.LOCAL_ONLY, "yes");
  await cleanup();
});

test("config: 未信任时完全不读取 env；控制面变量即使授信也永久拒绝", async () => {
  const { home, cwd, cleanup } = await tmp();
  await fs.writeFile(
    path.join(cwd, ".env"),
    [
      "DEEPSEEK_API_KEY=provider-key",
      "ANICODE_SANDBOX_FAIL_CLOSED=0",
      "AGENTX_BASH_SANDBOX=none",
      "NODE_OPTIONS=--import ./malicious.mjs",
      "PATH=/tmp/malicious-bin",
    ].join("\n"),
  );
  const blocked: { name: string; reason: string }[] = [];
  const untrustedEnv: NodeJS.ProcessEnv = {};
  const openDescriptor = Object.getOwnPropertyDescriptor(fs, "open");
  const readFileDescriptor = Object.getOwnPropertyDescriptor(fs, "readFile");
  assert.ok(openDescriptor && readFileDescriptor);
  let opened = false;
  const unexpectedRead = async () => {
    opened = true;
    throw new Error("untrusted project env must not be read");
  };
  Object.defineProperty(fs, "open", {
    ...openDescriptor,
    value: unexpectedRead,
  });
  Object.defineProperty(fs, "readFile", {
    ...readFileDescriptor,
    value: unexpectedRead,
  });
  try {
    assert.deepEqual(
      await loadProjectEnv({
        cwd,
        env: untrustedEnv,
        onBlocked: ({ name, reason }) => blocked.push({ name, reason }),
      }),
      [],
    );
  } finally {
    Object.defineProperty(fs, "open", openDescriptor);
    Object.defineProperty(fs, "readFile", readFileDescriptor);
  }
  assert.equal(opened, false);
  assert.deepEqual(untrustedEnv, {});
  assert.deepEqual(blocked, [], "env names must not be parsed or exposed before trust");

  const { assessment } = await grant(home, cwd);
  const trustedEnv: NodeJS.ProcessEnv = {};
  await loadProjectEnv({ cwd, env: trustedEnv, workspaceTrust: assessment });
  assert.equal(trustedEnv.DEEPSEEK_API_KEY, "provider-key");
  assert.equal(trustedEnv.ANICODE_SANDBOX_FAIL_CLOSED, undefined);
  assert.equal(trustedEnv.AGENTX_BASH_SANDBOX, undefined);
  assert.equal(trustedEnv.NODE_OPTIONS, undefined);
  assert.equal(trustedEnv.PATH, undefined);
  await cleanup();
});

test("config: user/project JSON 超限时有稳定告警并跳过", async () => {
  const { home, cwd, cleanup } = await tmp();
  try {
    const oversized = Buffer.alloc(4 * 1024 * 1024 + 1, 0x20);
    await fs.writeFile(path.join(home, ".config", "anicode", "anicode.json"), oversized);
    await fs.writeFile(path.join(cwd, "anicode.json"), oversized);
    const loaded = await loadConfig({ cwd, home });
    assert.deepEqual(loaded.config, {});
    assert.deepEqual(loaded.sources, []);
    assert.equal(loaded.warnings.length, 2);
    assert.ok(loaded.warnings.every((warning) => /4194304 byte limit/.test(warning)));
  } finally {
    await cleanup();
  }
});

test("config: 授信后 env 超限会在解析和注入前 fail closed", async () => {
  const { home, cwd, cleanup } = await tmp();
  try {
    const { assessment } = await grant(home, cwd);
    await fs.writeFile(path.join(cwd, ".env"), Buffer.alloc(4 * 1024 * 1024 + 1, 0x41));
    const env: NodeJS.ProcessEnv = {};
    assert.deepEqual(await loadProjectEnv({ cwd, env, workspaceTrust: assessment }), []);
    assert.deepEqual(env, {});
  } finally {
    await cleanup();
  }
});

test("config: profiles 配置档叠加与未知档警告；hooks 键合并", async () => {
  const { home, cwd, cleanup } = await tmp();
  await fs.writeFile(
    path.join(home, ".config", "anicode", "anicode.json"),
    JSON.stringify({
      model: "base/model",
      hooks: [{ event: "PreToolUse", command: "echo global" }],
      profiles: {
        cheap: { model: "cheap/model", smallModel: false },
        strict: { permissionProfile: "readonly" },
      },
    }),
  );
  await fs.writeFile(
    path.join(cwd, "anicode.json"),
    JSON.stringify({ hooks: [{ event: "Stop", command: "echo proj" }] }),
  );

  // 无 profile：主配置生效，hooks 拼接
  const { assessment } = await grant(home, cwd);
  const base = await loadConfig({ cwd, home, workspaceTrust: assessment });
  assert.equal(base.config.model, "base/model");
  assert.equal(base.config.hooks?.length, 2);

  // 选中 cheap：覆盖 model
  const cheap = await loadConfig({ cwd, home, profile: "cheap", workspaceTrust: assessment });
  assert.equal(cheap.config.model, "cheap/model");
  assert.equal(cheap.config.smallModel, false);
  assert.equal(cheap.config.profiles, undefined, "档位应被消费移除");
  assert.equal(cheap.warnings.length, 0);

  // 未知档：警告 + 主配置不变
  const bogus = await loadConfig({ cwd, home, profile: "nope", workspaceTrust: assessment });
  assert.equal(bogus.config.model, "base/model");
  assert.ok(bogus.warnings.some((w) => /nope/.test(w)));

  await cleanup();
});

test("config: permissions 规则跨层拼接去重，settings.local.json 参与合并", async () => {
  const { home, cwd, cleanup } = await tmp();
  await fs.writeFile(
    path.join(home, ".config", "anicode", "anicode.json"),
    JSON.stringify({ permissions: { deny: ["bash(rm *)"], allow: ["read"] } }),
  );
  await fs.writeFile(
    path.join(cwd, "anicode.json"),
    JSON.stringify({ permissions: { deny: ["bash(rm *)", "bash(sudo *)"] } }),
  );
  await fs.writeFile(
    path.join(cwd, ".anicode", "settings.local.json"),
    JSON.stringify({ permissions: { allow: ["bash(git status)"] } }),
  );
  const { assessment } = await grant(home, cwd);
  const { config, warnings } = await loadConfig({ cwd, home, workspaceTrust: assessment });
  assert.deepEqual(config.permissions?.deny, ["bash(rm *)", "bash(sudo *)"]); // 去重且都保留
  assert.deepEqual(config.permissions?.allow, ["read", "bash(git status)"]);
  assert.deepEqual(warnings, []);
  await cleanup();
});

test("config: 未信任时保留安全偏好并忽略项目执行配置", async () => {
  const { home, cwd, cleanup } = await tmp();
  await fs.writeFile(
    path.join(home, ".config", "anicode", "anicode.json"),
    JSON.stringify({
      model: "global/model",
      mcp: { global: { command: "global-mcp" } },
      permissions: { deny: ["bash(rm *)"] },
    }),
  );
  await fs.writeFile(
    path.join(cwd, "anicode.json"),
    JSON.stringify({
      model: "project/model",
      tui: { keybindings: { reconnect: "ctrl+x" } },
      mcp: { project: { command: "project-mcp" } },
      hooks: [{ event: "SessionStart", command: "touch should-not-run" }],
      lsp: { ts: { command: "project-lsp", extensions: [".ts"] } },
      agents: { injected: { description: "prompt injection" } },
      instructions: ["malicious.md"],
      permissionProfile: "full",
      permissions: { allow: ["bash"] },
      browser: { executablePath: "/tmp/malicious-browser" },
    }),
  );

  const loaded = await loadConfig({ cwd, home });
  assert.equal(loaded.config.model, "project/model");
  assert.deepEqual(loaded.config.tui?.keybindings, { reconnect: "ctrl+x" });
  assert.deepEqual(Object.keys(loaded.config.mcp ?? {}), ["global"]);
  assert.deepEqual(loaded.config.permissions, { deny: ["bash(rm *)"] });
  assert.equal(loaded.config.hooks, undefined);
  assert.equal(loaded.config.lsp, undefined);
  assert.equal(loaded.config.agents, undefined);
  assert.equal(loaded.config.instructions, undefined);
  assert.equal(loaded.config.permissionProfile, undefined);
  assert.equal(loaded.config.browser, undefined);
  assert.ok(
    loaded.warnings.some((warning) => /(?:untrusted workspace|未信任工作区)/.test(warning)),
  );
  await cleanup();
});

test("config: 高层 trust loader 在授信前后切换项目执行配置", async () => {
  const { home, cwd, cleanup } = await tmp();
  const file = path.join(cwd, "anicode.json");
  await fs.writeFile(file, JSON.stringify({ mcp: { project: { command: "server-v1" } } }));
  const store = new WorkspaceTrustStore({
    file: path.join(home, ".config", "anicode", "trust", "workspaces.json"),
  });

  const before = await loadConfigWithWorkspaceTrust({ cwd, home, trustStore: store });
  assert.equal(before.workspaceTrust.reason, "not-trusted");
  assert.equal(before.config.mcp, undefined);

  await store.grant(cwd);
  const trusted = await loadConfigWithWorkspaceTrust({ cwd, home, trustStore: store });
  assert.equal(trusted.workspaceTrust.trusted, true);
  assert.equal(trusted.config.mcp?.project && "command" in trusted.config.mcp.project, true);

  await fs.writeFile(file, JSON.stringify({ mcp: { project: { command: "server-v2" } } }));
  const changed = await loadConfigWithWorkspaceTrust({ cwd, home, trustStore: store });
  assert.equal(changed.workspaceTrust.reason, "execution-config-changed");
  assert.equal(changed.config.mcp, undefined);
  await cleanup();
});

test("permission-store: appendLocalAllowRules 创建/追加/去重且保留其他键", async () => {
  const { appendLocalAllowRules, localSettingsPath } = await import("./permission-store.js");
  const { cwd, cleanup } = await tmp();
  // 首次：文件不存在 → 创建
  assert.equal(await appendLocalAllowRules(cwd, ["bash(git status)"]), true);
  // 手写其他键 + 再追加：其他键保留、重复规则不再加
  const file = localSettingsPath(cwd);
  const cur = JSON.parse(await fs.readFile(file, "utf8"));
  cur.custom = { keep: 1 };
  await fs.writeFile(file, JSON.stringify(cur));
  assert.equal(await appendLocalAllowRules(cwd, ["bash(git status)", "web_fetch(*)"]), true);
  const after = JSON.parse(await fs.readFile(file, "utf8"));
  assert.deepEqual(after.permissions.allow, ["bash(git status)", "web_fetch(*)"]);
  assert.deepEqual(after.custom, { keep: 1 });
  // JSON 损坏 → 不覆盖用户文件
  await fs.writeFile(file, "{ broken");
  assert.equal(await appendLocalAllowRules(cwd, ["x(y)"]), false);
  assert.equal(await fs.readFile(file, "utf8"), "{ broken");
  await cleanup();
});
