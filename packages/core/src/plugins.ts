/**
 * 插件目录发现 —— Claude Code plugins 的精简形态：一个目录捆绑一组扩展。
 *
 *   ~/.anicode/plugins/<name>/          用户级
 *   <cwd>/.anicode/plugins/<name>/      项目级（随仓库分发）
 *     ├── agents/*.md                   subagent 定义（同 .claude/agents 格式）
 *     ├── skills/<skill>/SKILL.md       技能（同 .claude/skills 格式）
 *     └── commands/*.md                 自定义斜杠命令（同 .anicode/command 格式）
 *
 * 本模块只发现目录，内容解析复用既有发现器（discoverSubagents/discoverSkills/
 * loadCommands 的 extraDirs 入口）——插件没有独立的清单文件/生命周期，刻意保持
 * 「目录即插件」的最小形态；同名覆盖规则沿用各发现器（后写入者胜，项目级在后）。
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface PluginDirs {
  /** 发现的插件名（目录名），用户级在前、项目级在后。 */
  names: string[];
  agents: string[];
  skills: string[];
  commands: string[];
}

export interface PluginDiscoveryOptions {
  /** Defaults to true. Set false until Workspace Trust has been granted. */
  includeProject?: boolean;
}

export async function discoverPlugins(
  cwd: string,
  home?: string,
  options: PluginDiscoveryOptions = {},
): Promise<PluginDirs> {
  const roots = [
    path.join(home ?? os.homedir(), ".anicode", "plugins"),
    ...(options.includeProject === false
      ? []
      : [path.join(path.resolve(cwd), ".anicode", "plugins")]),
  ];
  const out: PluginDirs = { names: [], agents: [], skills: [], commands: [] };
  for (const root of roots) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const dir = path.join(root, name);
      try {
        if (!(await fs.stat(dir)).isDirectory()) continue;
      } catch {
        continue;
      }
      out.names.push(name);
      for (const [kind, key] of [
        ["agents", "agents"],
        ["skills", "skills"],
        ["commands", "commands"],
      ] as const) {
        const sub = path.join(dir, kind);
        try {
          if ((await fs.stat(sub)).isDirectory()) out[key].push(sub);
        } catch {
          /* 无该子目录 */
        }
      }
    }
  }
  return out;
}
