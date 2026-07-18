/**
 * 项目本地权限清单持久化 —— 对齐 Claude Code 的 .claude/settings.local.json。
 *
 * 文件：<cwd>/.anicode/settings.local.json，形如
 *   { "permissions": { "allow": ["bash(git status)", ...] } }
 *
 * 该文件同时是 loadConfig 的一个配置源（优先级最高），所以这里写入的
 * allow 规则下次会话自动生效。写入采用读-改-写 + tmp+rename 原子落盘，
 * 保留文件里用户手写的其他键。建议将该文件加入 .gitignore（个人授权清单）。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

export function localSettingsPath(cwd: string): string {
  return path.join(cwd, ".anicode", "settings.local.json");
}

interface LocalSettings {
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[] };
  [key: string]: unknown;
}

/**
 * 把规则追加进本地设置的 permissions.allow（去重）。
 * 文件不存在则创建；JSON 损坏时不覆盖用户文件，直接放弃（返回 false）。
 */
export async function appendLocalAllowRules(cwd: string, rules: string[]): Promise<boolean> {
  if (rules.length === 0) return true;
  const file = localSettingsPath(cwd);
  let settings: LocalSettings = {};
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    settings = parsed as LocalSettings;
  } catch (err) {
    // 文件缺失 → 从空对象开始；JSON 损坏 → 不动用户文件
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }
  const perms = (settings.permissions ??= {});
  const allow = (perms.allow ??= []);
  let changed = false;
  for (const rule of rules) {
    if (!allow.includes(rule)) {
      allow.push(rule);
      changed = true;
    }
  }
  if (!changed) return true;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + "\n", "utf8");
  await fs.rename(tmp, file);
  return true;
}
