/**
 * @文件引用：把消息里的 `@relative/path` 展开为「原文 + 被引用文件内容」，
 * 让用户不必手动粘贴文件。对齐 opencode 的 @-mention。
 *
 * 规则：
 *  - 仅识别位于行首或空白之后的 `@path`（避免误伤邮箱等 a@b）。
 *  - 路径相对 cwd 解析；读到才追加内容，读不到按原文保留并回报 missing。
 *  - 单文件截断到 100KB，避免炸 context。
 */
import { constants as fsConstants, promises as fs } from "node:fs";
import * as path from "node:path";
import { t } from "@anicode/core";

const MAX_BYTES = 100 * 1024;
const MENTION_RE = /(^|\s)@([^\s@]+)/g;

function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

async function readBoundedRegularFile(
  file: string,
): Promise<{ content: string; truncated: boolean }> {
  // O_NOFOLLOW closes the realpath→open symlink-swap window. O_NONBLOCK keeps a
  // workspace FIFO/device from hanging the interactive process during inspection.
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("mention target is not a regular file");
    const wanted = Math.min(MAX_BYTES + 1, Math.max(0, stat.size));
    const buffer = Buffer.alloc(wanted);
    let offset = 0;
    while (offset < wanted) {
      const { bytesRead } = await handle.read(buffer, offset, wanted - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const truncated = stat.size > MAX_BYTES || offset > MAX_BYTES;
    return {
      content: buffer.subarray(0, Math.min(offset, MAX_BYTES)).toString("utf8"),
      truncated,
    };
  } finally {
    await handle.close();
  }
}

export async function expandFileMentions(
  text: string,
  cwd: string,
): Promise<{ text: string; missing: string[] }> {
  const paths = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) paths.add(m[2]!);
  if (paths.size === 0) return { text, missing: [] };

  let canonicalCwd: string;
  try {
    canonicalCwd = await fs.realpath(cwd);
  } catch {
    return { text, missing: [...paths] };
  }

  const found: { rel: string; content: string }[] = [];
  const missing: string[] = [];
  for (const rel of paths) {
    const abs = path.resolve(canonicalCwd, rel);
    // 不允许逃逸出 cwd（避免 @../../etc/passwd 之类）。
    if (!isWithin(canonicalCwd, abs)) {
      missing.push(rel);
      continue;
    }
    try {
      const real = await fs.realpath(abs);
      if (!isWithin(canonicalCwd, real)) throw new Error("mention target escapes workspace");
      const { content, truncated } = await readBoundedRegularFile(real);
      found.push({
        rel,
        content: truncated
          ? `${content}\n${t("…(truncated, file exceeds 100KB)", "…（已截断，文件超过 100KB）")}`
          : content,
      });
    } catch {
      missing.push(rel);
    }
  }

  if (found.length === 0) return { text, missing };
  const blocks = found.map(({ rel, content }) => `=== ${rel} ===\n${content}`).join("\n\n");
  return {
    text: `${text}\n\n${t("Below is the content of the referenced files:", "以下是被引用文件的内容：")}\n${blocks}`,
    missing,
  };
}
