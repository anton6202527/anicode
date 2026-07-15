/**
 * 自定义斜杠命令：从 markdown 文件加载「可复用的提示模板」，对齐 opencode 的
 * `.opencode/command/*.md`。每个文件是一条命令，文件名即命令名。
 *
 * 查找（项目覆盖全局，同名以项目为准）：
 *   <home>/.config/anicode/command/*.md   全局
 *   <cwd>/.anicode/command/*.md            项目
 *
 * 文件格式（frontmatter 可选）：
 *   ---
 *   description: 一句话说明
 *   ---
 *   正文提示模板，支持 $ARGUMENTS（整串）与 $1..$9（按空白切分的定位参数）。
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface CustomCommand {
  name: string;
  description: string;
  template: string;
  source: string;
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.replace(/^["']|["']$/g, "");
  }
  return { meta, body: text.slice(m[0].length) };
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? "";
}

async function readDir(dir: string): Promise<{ name: string; file: string }[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  return entries
    .filter((f) => f.toLowerCase().endsWith(".md"))
    .map((f) => ({ name: f.replace(/\.md$/i, ""), file: path.join(dir, f) }));
}

export async function loadCommands(
  opts: { cwd?: string; home?: string } = {},
): Promise<CustomCommand[]> {
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? os.homedir();
  // 后加入的覆盖先加入的同名项 → 全局在前、项目在后。
  const dirs = [
    path.join(home, ".config", "anicode", "command"),
    path.join(cwd, ".anicode", "command"),
  ];
  const byName = new Map<string, CustomCommand>();
  for (const dir of dirs) {
    for (const { name, file } of await readDir(dir)) {
      let text: string;
      try {
        text = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const { meta, body } = parseFrontmatter(text);
      byName.set(name, {
        name,
        description: meta["description"] || firstLine(body) || name,
        template: body.trim(),
        source: file,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 用参数展开命令模板：$ARGUMENTS=整串；$1..$9=按空白切分的定位参数；未提供的置空。 */
export function expandCommand(cmd: CustomCommand, args: string): string {
  const trimmed = args.trim();
  const parts = trimmed ? trimmed.split(/\s+/) : [];
  let out = cmd.template.replace(/\$ARGUMENTS\b/g, trimmed);
  out = out.replace(/\$([1-9])\b/g, (_, d: string) => parts[Number(d) - 1] ?? "");
  return out;
}
