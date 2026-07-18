/**
 * 文件系统发现 subagents —— 对齐 Claude Code 的 .claude/agents/*.md。
 *
 * 一个 agent = 一个 markdown 文件：YAML frontmatter（name/description/tools/model/
 * maxTurns/readonly）+ 正文作为该子 agent 的 system 提示。
 *
 * 发现路径（后者同名覆盖前者）：
 *   1) ~/.claude/agents/*.md          用户级
 *   2) <cwd>/.claude/agents/*.md      项目级（Claude Code 兼容）
 *   3) <cwd>/.anicode/agents/*.md     anicode 原生
 *
 * 与 anicode.json 的 agents 配置互补：文件形态便于随仓库分发、逐个 review；
 * 程序化定义（config/API）优先级更高（在 createTaskTool 的合并序里排后）。
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter, stripFrontmatter, fmString, fmStringList } from "./frontmatter.js";
import type { SubagentDefinition } from "./subagent.js";

export async function discoverSubagents(
  cwd: string,
  extraDirs: string[] = [],
): Promise<SubagentDefinition[]> {
  const dirs = [
    path.join(os.homedir(), ".claude", "agents"),
    path.join(path.resolve(cwd), ".claude", "agents"),
    path.join(path.resolve(cwd), ".anicode", "agents"),
    ...extraDirs,
  ];
  const byName = new Map<string, SubagentDefinition>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".md")) continue;
      const file = path.join(dir, entry);
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const def = parseSubagentFile(entry, text);
      if (def) byName.set(def.name, def);
    }
  }
  return [...byName.values()];
}

/** 解析单个 agent markdown（文件名兜底 name）。无 description 视为无效，跳过。 */
export function parseSubagentFile(filename: string, text: string): SubagentDefinition | null {
  const fm = parseFrontmatter(text);
  const name = (fmString(fm["name"]) ?? path.basename(filename, ".md")).trim();
  const description = (fmString(fm["description"]) ?? "").trim();
  if (!name || !description) return null; // description 是模型选型依据，缺失=不可用
  const system = stripFrontmatter(text).trim();
  const tools = fmStringList(fm["tools"]);
  const disallowedTools = fmStringList(fm["disallowed-tools"] ?? fm["disallowedTools"]);
  const model = fmString(fm["model"]);
  const maxTurnsRaw = fmString(fm["maxTurns"] ?? fm["max-turns"]);
  const maxTurns = maxTurnsRaw !== undefined ? Number(maxTurnsRaw) : undefined;
  const readOnly = fmString(fm["readonly"] ?? fm["readOnly"]) === "true";
  return {
    name,
    description,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    ...(disallowedTools ? { disallowedTools } : {}),
    ...(model ? { model } : {}),
    ...(maxTurns !== undefined && Number.isFinite(maxTurns) && maxTurns > 0 ? { maxTurns } : {}),
    ...(readOnly ? { readOnly: true } : {}),
  };
}
