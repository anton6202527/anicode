/**
 * 插件目录发现：目录即插件，agents/skills/commands 子目录并入既有发现器。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverPlugins } from "./plugins.js";
import { discoverSubagents } from "./agents-fs.js";
import { loadCommands } from "./commands.js";

test("discoverPlugins: 项目级插件的 agents/commands 被既有发现器接住", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-plugins-"));
  const home = path.join(tmp, "home");
  const cwd = path.join(tmp, "proj");
  const plugin = path.join(cwd, ".anicode", "plugins", "myplugin");
  await fs.mkdir(path.join(plugin, "agents"), { recursive: true });
  await fs.mkdir(path.join(plugin, "commands"), { recursive: true });
  await fs.writeFile(
    path.join(plugin, "agents", "helper.md"),
    "---\nname: helper\ndescription: 插件里的 agent\n---\n你是插件 helper。",
  );
  await fs.writeFile(path.join(plugin, "commands", "deploy.md"), "部署当前项目到 $1 环境");

  const dirs = await discoverPlugins(cwd, home);
  assert.deepEqual(dirs.names, ["myplugin"]);
  assert.equal(dirs.agents.length, 1);
  assert.equal(dirs.commands.length, 1);
  assert.equal(dirs.skills.length, 0, "无 skills 子目录则不并入");

  const agents = await discoverSubagents(cwd, dirs.agents);
  assert.ok(agents.some((a) => a.name === "helper"));

  const commands = await loadCommands({ cwd, home, extraDirs: dirs.commands });
  const deploy = commands.find((c) => c.name === "deploy");
  assert.ok(deploy, "插件命令应被发现");

  // 项目级 .anicode/command 同名覆盖插件命令（项目在后）。
  await fs.mkdir(path.join(cwd, ".anicode", "command"), { recursive: true });
  await fs.writeFile(path.join(cwd, ".anicode", "command", "deploy.md"), "项目本地覆盖版");
  const commands2 = await loadCommands({ cwd, home, extraDirs: dirs.commands });
  assert.equal(commands2.filter((c) => c.name === "deploy").length, 1);

  await fs.rm(tmp, { recursive: true, force: true });
});

test("discoverPlugins: 无插件目录时安静返回空", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-noplug-"));
  const dirs = await discoverPlugins(tmp, path.join(tmp, "home"));
  assert.deepEqual(dirs, { names: [], agents: [], skills: [], commands: [] });
  await fs.rm(tmp, { recursive: true, force: true });
});

test("discoverPlugins: includeProject=false 只保留用户级插件", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-plugin-trust-"));
  const home = path.join(tmp, "home");
  const cwd = path.join(tmp, "project");
  try {
    await fs.mkdir(path.join(home, ".anicode", "plugins", "global", "commands"), {
      recursive: true,
    });
    await fs.mkdir(path.join(cwd, ".anicode", "plugins", "project", "commands"), {
      recursive: true,
    });
    const discovered = await discoverPlugins(cwd, home, { includeProject: false });
    assert.deepEqual(discovered.names, ["global"]);
    assert.ok(discovered.commands.every((dir) => dir.startsWith(home)));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
