/**
 * Skills —— 渐进式能力加载（对齐 Claude Code / agentskills.io 开放标准的最小实现）。
 *
 * 一个 skill = 一个目录 + SKILL.md（YAML frontmatter: name/description + markdown 正文）。
 * 两级加载，正文不占常驻上下文：
 *   L1 启动时只把所有 skill 的 name+description（约百 token/个）注入 system 提示
 *   L2 模型判定相关时经 skill 工具按名加载正文（作为工具结果进入对话）
 *
 * 发现路径（前者被后者同名覆盖，项目级最优先）：
 *   ~/.claude/skills、~/.agents/skills、~/.config/opencode/skills（全局，跨工具生态）
 *   <cwd>/.claude/skills（项目级）
 *   调用方追加的 extraDirs
 * frontmatter 用共享的 YAML 子集解析（frontmatter.ts：块标量/列表/嵌套 map），零依赖。
 *
 * 自动检测（对齐 opencode）：读 frontmatter `metadata.requires.bins`，逐一在 PATH 上
 * 探测可执行文件，标注 `available`；缺依赖的技能仍会被发现，但在清单里明确标注「不可用」，
 * 免得模型盲目调用一个跑不起来的 CLI。
 */

import { promises as fs, constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FrontmatterValue } from "./frontmatter.js";
import type { Tool } from "./tools/tool.js";
import { ToolError } from "./tools/tool.js";
import { t } from "./i18n.js";
import { parseFrontmatter, stripFrontmatter, fmString, fmStringList } from "./frontmatter.js";

export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径（L2 加载正文用） */
  file: string;
  /** 技能所在目录（= dirname(file)），展示与定位附属资源用 */
  dir?: string;
  /** 发现该技能的根目录（~/.claude/skills 等），区分全局/项目来源 */
  sourceRoot?: string;
  /** frontmatter `allowed-tools`：技能宣称需要的工具子集（供上层裁决/提示用） */
  allowedTools?: string[];
  /** frontmatter `model`：技能建议使用的模型 */
  model?: string;
  /** frontmatter `metadata.requires.bins`：技能运行所需的可执行文件 */
  requiresBins?: string[];
  /** requiresBins 是否全部在 PATH 上就绪（无依赖声明时恒为 true） */
  available?: boolean;
}

const MAX_DESCRIPTION = 1024;

export interface SkillDiscoveryOptions {
  /** Defaults to true. Set false until Workspace Trust has been granted. */
  includeProject?: boolean;
}

/** 全局技能发现根（跨工具生态，按顺序后者覆盖前者）。 */
function globalSkillRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(home, ".config", "opencode", "skills"),
  ];
}

/** 探测某个可执行文件是否在 PATH 上（结果按 bin 名缓存，避免重复扫描）。 */
async function isExecutableOnPath(bin: string, cache: Map<string, boolean>): Promise<boolean> {
  const cached = cache.get(bin);
  if (cached !== undefined) return cached;
  const exts =
    process.platform === "win32"
      ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  // 含路径分隔符：当作直接路径校验；否则逐个 PATH 目录探测。
  const candidates = bin.includes(path.sep)
    ? [path.resolve(bin)]
    : dirs.map((d) => path.join(d, bin));
  let ok = false;
  outer: for (const base of candidates) {
    for (const ext of exts) {
      try {
        await fs.access(base + ext, fsConstants.X_OK);
        ok = true;
        break outer;
      } catch {
        /* 继续找下一个候选 */
      }
    }
  }
  cache.set(bin, ok);
  return ok;
}

/** 从 frontmatter 里取 `metadata.requires.bins`（嵌套 map → 列表）。 */
function readRequiresBins(fm: Record<string, FrontmatterValue>): string[] | undefined {
  const meta = fm["metadata"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
  const req = (meta as Record<string, FrontmatterValue>)["requires"];
  if (!req || typeof req !== "object" || Array.isArray(req)) return undefined;
  return fmStringList((req as Record<string, FrontmatterValue>)["bins"]);
}

/** 扫描默认目录，项目级同名覆盖用户级；标注 requires 与可用性。 */
export async function discoverSkills(
  cwd: string,
  extraDirs: string[] = [],
  options: SkillDiscoveryOptions = {},
): Promise<SkillMeta[]> {
  const dirs = [
    ...globalSkillRoots(),
    ...(options.includeProject === false
      ? []
      : [path.join(path.resolve(cwd), ".claude", "skills")]),
    ...extraDirs,
  ];
  const byName = new Map<string, SkillMeta>();
  const binCache = new Map<string, boolean>();
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
        const name = (fmString(fm["name"]) ?? entry).trim();
        const description = (fmString(fm["description"]) ?? "").trim().slice(0, MAX_DESCRIPTION);
        const allowedTools = fmStringList(fm["allowed-tools"] ?? fm["allowedTools"]);
        const model = fmString(fm["model"]);
        const requiresBins = readRequiresBins(fm);
        if (!name) continue;
        // 自动检测依赖：所有声明的 bin 都在 PATH 上才算可用；无声明恒可用。
        let available = true;
        if (requiresBins?.length) {
          for (const bin of requiresBins) {
            if (!(await isExecutableOnPath(bin, binCache))) {
              available = false;
              break;
            }
          }
        }
        byName.set(name, {
          name,
          description,
          file,
          dir: path.join(dir, entry),
          sourceRoot: dir,
          available,
          ...(allowedTools ? { allowedTools } : {}),
          ...(model ? { model } : {}),
          ...(requiresBins ? { requiresBins } : {}),
        });
      } catch {
        /* 无 SKILL.md，跳过 */
      }
    }
  }
  return [...byName.values()];
}

/** L1：注入 system 提示的技能清单（不可用技能追加依赖缺失标注） */
export function skillListPrompt(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  const lines = skills.map((s) => {
    const base = `- ${s.name}: ${s.description || t("(no description)", "（无描述）")}`;
    if (s.available === false && s.requiresBins?.length) {
      return `${base}${t(
        ` [unavailable: requires ${s.requiresBins.join(", ")} on PATH]`,
        `［不可用：需 PATH 上有 ${s.requiresBins.join("、")}］`,
      )}`;
    }
    return base;
  });
  return `${t(
    "# Available skills\nThe skills below can be loaded by name with the skill tool for full guidance. When a task matches a skill, load it before acting. Skills marked unavailable need a missing CLI — tell the user to install it instead of trying to run it:",
    "# 可用技能\n以下技能可用 skill 工具按名加载完整指引。当任务与某技能匹配时，先加载再动手。标注「不可用」的技能缺少所需 CLI——请提示用户安装，别硬跑：",
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
      // allowed-tools 以指引形式传达（frontmatter 声明的工具面约束）；
      // 硬性收窄工具集需要「技能激活期」状态机，当前工具模型下先做软约束。
      const toolsNote = meta.allowedTools?.length
        ? `\n${t(
            `(While following this skill, prefer using only these tools: ${meta.allowedTools.join(", ")})`,
            `（执行本技能期间，优先只使用这些工具：${meta.allowedTools.join("、")}）`,
          )}`
        : "";
      return `${t(
        `Below is the guidance for skill “${name}” (companion resources are relative to ${dir}):`,
        `以下是技能「${name}」的指引（附属资源相对目录 ${dir}）：`,
      )}${toolsNote}\n\n${body}`;
    },
  };
}
