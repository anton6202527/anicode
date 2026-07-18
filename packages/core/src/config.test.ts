import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, toMcpServerConfigs, toSubagentDefinitions } from "./config.js";

async function tmp(): Promise<{ home: string; cwd: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cfg-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  await fs.mkdir(path.join(home, ".config", "anicode"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".anicode"), { recursive: true });
  return { home, cwd, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("config: 全局与项目合并，项目覆盖全局", async () => {
  const { home, cwd, cleanup } = await tmp();
  await fs.writeFile(
    path.join(home, ".config", "anicode", "anicode.json"),
    JSON.stringify({ model: "global/model", smallModel: true, mcp: { g: { command: "gcmd" } } }),
  );
  await fs.writeFile(
    path.join(cwd, "anicode.json"),
    JSON.stringify({ model: "proj/model", mcp: { p: { command: "pcmd", args: ["x"] } } }),
  );
  const { config, sources, warnings } = await loadConfig({ cwd, home });
  assert.equal(config.model, "proj/model"); // 项目覆盖
  assert.equal(config.smallModel, true); // 全局保留
  assert.deepEqual(Object.keys(config.mcp ?? {}).sort(), ["g", "p"]); // mcp 深合并
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
  assert.ok(warnings.some((w) => /JSON 解析失败/.test(w)));
  assert.ok(warnings.some((w) => /未知配置项 "bogus"/.test(w)));
  await cleanup();
});

test("config: 转换 mcp / agents 为运行期结构", () => {
  const mcp = toMcpServerConfigs({ mcp: { fs: { command: "srv", args: ["--root", "."] } } });
  assert.deepEqual(mcp, [{ name: "fs", command: "srv", args: ["--root", "."] }]);
  const agents = toSubagentDefinitions({
    agents: { reviewer: { description: "评审", prompt: "你是评审", tools: ["read", "grep"] } },
  });
  assert.deepEqual(agents, [
    { name: "reviewer", description: "评审", system: "你是评审", tools: ["read", "grep"] },
  ]);
});

test("config: 无任何文件时返回空配置且无告警", async () => {
  const { home, cwd, cleanup } = await tmp();
  const { config, sources, warnings } = await loadConfig({ cwd, home });
  assert.deepEqual(config, {});
  assert.deepEqual(sources, []);
  assert.deepEqual(warnings, []);
  await cleanup();
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
  const base = await loadConfig({ cwd, home });
  assert.equal(base.config.model, "base/model");
  assert.equal(base.config.hooks?.length, 2);

  // 选中 cheap：覆盖 model
  const cheap = await loadConfig({ cwd, home, profile: "cheap" });
  assert.equal(cheap.config.model, "cheap/model");
  assert.equal(cheap.config.smallModel, false);
  assert.equal(cheap.config.profiles, undefined, "档位应被消费移除");
  assert.equal(cheap.warnings.length, 0);

  // 未知档：警告 + 主配置不变
  const bogus = await loadConfig({ cwd, home, profile: "nope" });
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
  const { config, warnings } = await loadConfig({ cwd, home });
  assert.deepEqual(config.permissions?.deny, ["bash(rm *)", "bash(sudo *)"]); // 去重且都保留
  assert.deepEqual(config.permissions?.allow, ["read", "bash(git status)"]);
  assert.deepEqual(warnings, []);
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
