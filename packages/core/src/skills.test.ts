import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createSkillTool, discoverSkills, type SkillMeta } from "./skills.js";

async function writeSkill(root: string, dir: string, text: string): Promise<string> {
  const skillDir = path.join(root, dir);
  await fs.mkdir(skillDir, { recursive: true });
  const file = path.join(skillDir, "SKILL.md");
  await fs.writeFile(file, text, "utf8");
  return file;
}

test("skills: 项目级同名 skill 覆盖用户级，并发现额外目录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-skills-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const extra = path.join(root, "extra");
  const oldHome = process.env["HOME"];
  process.env["HOME"] = home;

  try {
    await writeSkill(
      path.join(home, ".claude", "skills"),
      "shared-user",
      "---\nname: shared\ndescription: user version\n---\nuser body",
    );
    const projectFile = await writeSkill(
      path.join(project, ".claude", "skills"),
      "shared-project",
      "---\nname: shared\ndescription: project version\n---\nproject body",
    );
    await writeSkill(
      extra,
      "extra-only",
      "---\nname: extra\ndescription: extra version\n---\nextra body",
    );

    const found = await discoverSkills(project, [extra]);
    const shared = found.find((skill) => skill.name === "shared");

    assert.deepEqual(shared, {
      name: "shared",
      description: "project version",
      file: projectFile,
    });
    assert.equal(found.find((skill) => skill.name === "extra")?.description, "extra version");
    assert.equal(found.filter((skill) => skill.name === "shared").length, 1);
  } finally {
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skills: skill 工具加载正文时剥离 YAML frontmatter", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-skill-tool-"));
  try {
    const file = await writeSkill(
      root,
      "demo",
      "---\nname: demo\ndescription: quoted metadata\n---\n# Demo Guide\n\nFollow this guide.",
    );
    const meta: SkillMeta = { name: "demo", description: "quoted metadata", file };
    const tool = createSkillTool([meta]);
    const content = await tool.run(
      { name: "demo" },
      { cwd: root, signal: new AbortController().signal },
    );

    assert.match(content, /# Demo Guide/);
    assert.match(content, /Follow this guide\./);
    assert.doesNotMatch(content, /^---$/m);
    assert.doesNotMatch(content, /^description:/m);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skills: skill 工具拒绝未知名称并列出可用项", async () => {
  const tool = createSkillTool([
    { name: "known", description: "known skill", file: "/unused/known/SKILL.md" },
  ]);

  await assert.rejects(
    () =>
      tool.run({ name: "missing" }, { cwd: "/tmp/project", signal: new AbortController().signal }),
    /未知技能: missing（可用: known）/,
  );
});
