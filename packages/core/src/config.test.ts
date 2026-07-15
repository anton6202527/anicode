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
