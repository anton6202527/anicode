/**
 * @文件引用：把消息里的 `@relative/path` 展开为「原文 + 被引用文件内容」，
 * 让用户不必手动粘贴文件。对齐 opencode 的 @-mention。
 *
 * 规则：
 *  - 仅识别位于行首或空白之后的 `@path`（避免误伤邮箱等 a@b）。
 *  - 路径相对 cwd 解析；读到才追加内容，读不到按原文保留并回报 missing。
 *  - 单文件截断到 100KB，避免炸 context。
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";

const MAX_BYTES = 100 * 1024;
const MENTION_RE = /(^|\s)@([^\s@]+)/g;

export async function expandFileMentions(
  text: string,
  cwd: string,
): Promise<{ text: string; missing: string[] }> {
  const paths = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) paths.add(m[2]!);
  if (paths.size === 0) return { text, missing: [] };

  const found: { rel: string; content: string }[] = [];
  const missing: string[] = [];
  for (const rel of paths) {
    const abs = path.resolve(cwd, rel);
    // 不允许逃逸出 cwd（避免 @../../etc/passwd 之类）。
    if (!abs.startsWith(path.resolve(cwd) + path.sep) && abs !== path.resolve(cwd)) {
      missing.push(rel);
      continue;
    }
    try {
      const buf = await fs.readFile(abs);
      const truncated = buf.length > MAX_BYTES;
      const content = buf.subarray(0, MAX_BYTES).toString("utf8");
      found.push({ rel, content: truncated ? `${content}\n…（已截断，文件超过 100KB）` : content });
    } catch {
      missing.push(rel);
    }
  }

  if (found.length === 0) return { text, missing };
  const blocks = found
    .map(({ rel, content }) => `=== ${rel} ===\n${content}`)
    .join("\n\n");
  return { text: `${text}\n\n以下是被引用文件的内容：\n${blocks}`, missing };
}
