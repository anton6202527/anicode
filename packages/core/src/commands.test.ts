import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCommands, expandCommand } from "./commands.js";

async function tmp(): Promise<{ home: string; cwd: string; cleanup: () => Promise<void> }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-cmd-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "proj");
  await fs.mkdir(path.join(home, ".config", "anicode", "command"), { recursive: true });
  await fs.mkdir(path.join(cwd, ".anicode", "command"), { recursive: true });
  return { home, cwd, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("commands: 加载 frontmatter 描述与正文，项目同名覆盖全局", async () => {
  const { home, cwd } = await tmp();
  await fs.writeFile(
    path.join(home, ".config", "anicode", "command", "review.md"),
    "---\ndescription: 全局评审\n---\n全局模板",
  );
  await fs.writeFile(
    path.join(cwd, ".anicode", "command", "review.md"),
    "---\ndescription: 项目评审\n---\n评审 $ARGUMENTS",
  );
  await fs.writeFile(path.join(cwd, ".anicode", "command", "test.md"), "跑测试");
  const cmds = await loadCommands({ cwd, home });
  const review = cmds.find((c) => c.name === "review")!;
  assert.equal(review.description, "项目评审"); // 项目覆盖
  assert.equal(review.template, "评审 $ARGUMENTS");
  const t = cmds.find((c) => c.name === "test")!;
  assert.equal(t.description, "跑测试"); // 无 frontmatter → 取首行
});

test("commands: 展开 $ARGUMENTS 与定位参数", () => {
  const cmd = { name: "x", description: "", template: "第一个=$1 全部=$ARGUMENTS", source: "" };
  assert.equal(expandCommand(cmd, "alpha beta gamma"), "第一个=alpha 全部=alpha beta gamma");
  assert.equal(expandCommand(cmd, ""), "第一个= 全部=");
});
