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

function setTestHome(home: string): () => void {
  const oldHome = process.env["HOME"];
  const oldUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  return () => {
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    if (oldUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = oldUserProfile;
  };
}

test("skills: 项目级同名 skill 覆盖用户级，并发现额外目录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-skills-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const extra = path.join(root, "extra");
  const restoreHome = setTestHome(home);

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
      dir: path.dirname(projectFile),
      sourceRoot: path.join(project, ".claude", "skills"),
      available: true,
    });
    assert.equal(found.find((skill) => skill.name === "extra")?.description, "extra version");
    assert.equal(found.filter((skill) => skill.name === "shared").length, 1);
  } finally {
    restoreHome();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skills: 自动检测 metadata.requires.bins，缺依赖标 available=false", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-skill-req-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const restoreHome = setTestHome(home);
  try {
    // node 一定在 PATH 上 → 可用；一个不存在的二进制 → 不可用；无 requires → 可用。
    await writeSkill(
      path.join(project, ".claude", "skills"),
      "needs-node",
      "---\nname: needs-node\ndescription: d\nmetadata:\n  requires:\n    bins: [node]\n---\nbody",
    );
    await writeSkill(
      path.join(project, ".claude", "skills"),
      "needs-missing",
      "---\nname: needs-missing\ndescription: d\nmetadata:\n  requires:\n    bins: [anicode-nope-xyz]\n---\nbody",
    );
    await writeSkill(
      path.join(project, ".claude", "skills"),
      "plain",
      "---\nname: plain\ndescription: d\n---\nbody",
    );

    const found = await discoverSkills(project);
    assert.equal(found.find((s) => s.name === "needs-node")?.available, true);
    assert.deepEqual(found.find((s) => s.name === "needs-node")?.requiresBins, ["node"]);
    assert.equal(found.find((s) => s.name === "needs-missing")?.available, false);
    assert.equal(found.find((s) => s.name === "plain")?.available, true);
    assert.equal(found.find((s) => s.name === "plain")?.requiresBins, undefined);
  } finally {
    restoreHome();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("skills: includeProject=false 排除项目 skill，保留用户级与显式额外目录", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-skill-trust-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const extra = path.join(root, "extra");
  const restoreHome = setTestHome(home);
  try {
    await writeSkill(
      path.join(home, ".claude", "skills"),
      "global",
      "---\nname: global\ndescription: global\n---\nbody",
    );
    await writeSkill(
      path.join(project, ".claude", "skills"),
      "project",
      "---\nname: project\ndescription: project\n---\nbody",
    );
    await writeSkill(extra, "extra", "---\nname: extra\ndescription: extra\n---\nbody");
    const found = await discoverSkills(project, [extra], { includeProject: false });
    assert.ok(found.some((skill) => skill.name === "global"));
    assert.ok(found.some((skill) => skill.name === "extra"));
    assert.equal(
      found.some((skill) => skill.name === "project"),
      false,
    );
  } finally {
    restoreHome();
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
