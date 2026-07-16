/**
 * Skills —— 渐进式能力加载（对齐 Claude Code / agentskills.io 开放标准的最小实现）。
 *
 * 一个 skill = 一个目录 + SKILL.md（YAML frontmatter: name/description + markdown 正文）。
 * 两级加载，正文不占常驻上下文：
 *   L1 启动时只把所有 skill 的 name+description（约百 token/个）注入 system 提示
 *   L2 模型判定相关时经 skill 工具按名加载正文（作为工具结果进入对话）
 *
 * 发现路径：<cwd>/.claude/skills/<名字>/SKILL.md 与 ~/.claude/skills/<名字>/SKILL.md
 * （项目级优先，同名覆盖用户级）。frontmatter 解析只取顶层 `key: value` 行，
 * 不实现完整 YAML —— 够用且零依赖。
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool } from "./tools/tool.js";
import { ToolError } from "./tools/tool.js";
import { t } from "./i18n.js";

export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径（L2 加载正文用） */
  file: string;
}

const MAX_DESCRIPTION = 1024;

/** 扫描默认目录，项目级同名覆盖用户级 */
export async function discoverSkills(cwd: string, extraDirs: string[] = []): Promise<SkillMeta[]> {
  const dirs = [
    path.join(os.homedir(), ".claude", "skills"),
    path.join(path.resolve(cwd), ".claude", "skills"),
    ...extraDirs,
  ];
  const byName = new Map<string, SkillMeta>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const file = path.join(dir, entry, "SKILL.md");
      try {
        const text = await fs.readFile(file, "utf8");
        const fm = parseFrontmatter(text);
        const name = (fm["name"] ?? entry).trim();
        const description = (fm["description"] ?? "").trim().slice(0, MAX_DESCRIPTION);
        if (name) byName.set(name, { name, description, file });
      } catch {
        /* 无 SKILL.md，跳过 */
      }
    }
  }
  return [...byName.values()];
}

/** L1：注入 system 提示的技能清单 */
export function skillListPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map(
    (s) => `- ${s.name}: ${s.description || t("(no description)", "（无描述）")}`,
  );
  return `${t(
    "# Available skills\nThe skills below can be loaded by name with the skill tool for full guidance. When a task matches a skill, load it before acting:",
    "# 可用技能\n以下技能可用 skill 工具按名加载完整指引。当任务与某技能匹配时，先加载再动手：",
  )}\n${lines.join("\n")}`;
}

/** L2：skill 工具 —— 按名加载 SKILL.md 正文（剥离 frontmatter） */
export function createSkillTool(skills: SkillMeta[]): Tool {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return {
    readOnly: true,
    def: {
      name: "skill",
      description: t(
        "Load a skill's full guidance (the SKILL.md body). When a task matches a skill, load it first and follow its guidance.",
        "加载一个技能的完整指引（SKILL.md 正文）。任务与某技能匹配时先加载它，按其中的指引执行。",
      ),
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: t(
              `Skill name. Available: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
              `技能名。可用: ${skills.map((s) => s.name).join(", ") || "（无）"}`,
            ),
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    ruleKey: (i) => String(i["name"] ?? ""),
    async run(input) {
      const name = String(input["name"] ?? "");
      const meta = byName.get(name);
      if (!meta) {
        throw new ToolError(`未知技能: ${name}（可用: ${[...byName.keys()].join(", ") || "无"}）`);
      }
      const text = await fs.readFile(meta.file, "utf8");
      const body = stripFrontmatter(text).trim();
      const dir = path.dirname(meta.file);
      return `${t(
        `Below is the guidance for skill “${name}” (companion resources are relative to ${dir}):`,
        `以下是技能「${name}」的指引（附属资源相对目录 ${dir}）：`,
      )}\n\n${body}`;
    },
  };
}

// ---------- frontmatter ----------

function frontmatterBlock(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  return m ? m[1]! : null;
}

function parseFrontmatter(text: string): Record<string, string> {
  const block = frontmatterBlock(text);
  const out: Record<string, string> = {};
  if (!block) return out;
  for (const line of block.split(/\r?\n/)) {
    const m = /^(\w[\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}
