/**
 * 文件系统工具：Read / Write / Edit / Glob / Grep。
 * 所有路径经 resolveInside() 强制约束在 cwd 内 —— 沙箱边界，防目录穿越。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Tool, ToolContext } from "./tool.js";
import { ToolError } from "./tool.js";
import { t } from "../i18n.js";
import { PatchSetService } from "../runtime/patchset.js";

const MAX_RESULTS = 200;
const MAX_READ_LINES = 5_000;
const MAX_READ_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_EDIT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SEARCH_FILES = 100_000;
const MAX_SEARCH_DIRECTORIES = 20_000;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_MS = 10_000;
const MAX_REGEX_CHARS = 512;
const MAX_REGEX_LINE_CHARS = 4_096;

/**
 * 把 model 给的路径解析为绝对路径，并确保**真实落点**在 cwd 内。
 * 两层校验：
 *   1. 字面路径前缀检查（挡 ../ 穿越）
 *   2. realpath 检查（挡符号链接逃逸 —— cwd 内一个指向外部的 symlink
 *      能骗过纯字符串检查，必须解析到真实文件系统位置再比对）
 * 对尚不存在的路径（write 新文件），realpath 其最深的已存在祖先目录。
 */
export async function resolveInside(cwd: string, p: unknown): Promise<string> {
  if (typeof p !== "string" || !p) throw new ToolError("path 必须是非空字符串");
  const root = path.resolve(cwd);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ToolError(`路径越界，禁止访问 cwd 之外: ${p}`);
  }

  const realRoot = await fs.realpath(root);
  // 找最深的已存在祖先并 realpath 它（新文件场景 abs 本身可能不存在）
  let probe = abs;
  let suffix = "";
  while (true) {
    try {
      const real = await fs.realpath(probe);
      const realTarget = suffix ? path.join(real, suffix) : real;
      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) {
        throw new ToolError(`路径越界（经符号链接指向 cwd 之外）: ${p}`);
      }
      return realTarget;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) throw new ToolError(`无法解析路径: ${p}`);
      suffix = suffix ? path.join(path.basename(probe), suffix) : path.basename(probe);
      probe = parent;
    }
  }
}

function rel(cwd: string, abs: string): string {
  return path.relative(cwd, abs) || ".";
}

function ensureActive(ctx: ToolContext): void {
  if (ctx.signal.aborted) throw new ToolError("会话已中断，文件操作未执行");
}

export const readTool: Tool = {
  readOnly: true,
  def: {
    name: "read",
    description: t(
      "Read a file's contents, returning text with line numbers. Optionally use offset/limit to read a large file in chunks. Also reads images (png/jpg/gif/webp) — when the model supports vision, the image itself is attached, so you can inspect screenshots, mockups, and diagrams directly.",
      "读取文件内容，返回带行号的文本。可选 offset/limit 分段读取大文件。也可读取图片（png/jpg/gif/webp）——模型支持视觉时会直接附上图片本体，可用于查看截图、设计稿与图表。",
    ),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: t("File path relative to cwd", "相对 cwd 的文件路径"),
        },
        offset: {
          type: "number",
          description: t("Starting line (1-based, default 1)", "起始行（1 起，默认 1）"),
        },
        limit: {
          type: "number",
          description: t(
            "Maximum number of lines to read (default 2000)",
            "最多读取行数（默认 2000）",
          ),
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["path"] ?? ""),
  async run(input, ctx: ToolContext) {
    ensureActive(ctx);
    const abs = await resolveInside(ctx.cwd, input["path"]);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(abs);
    } catch (e: any) {
      throw new ToolError(`读取失败: ${e?.code ?? e?.message ?? e}`);
    }
    if (!stat.isFile()) throw new ToolError(`读取失败: ${rel(ctx.cwd, abs)} 不是普通文件`);
    // 图片必须先于二进制判定：图片天然含 NUL，否则会被当成"二进制"拒读。
    const mediaType = imageMediaType(abs);
    if (mediaType) {
      if (stat.size > MAX_IMAGE_BYTES) {
        return imageTooLarge(mediaType, rel(ctx.cwd, abs), stat.size);
      }
      return readImage(await fs.readFile(abs), mediaType, rel(ctx.cwd, abs), ctx);
    }
    const offset = boundedPositiveInteger(input["offset"], 1, Number.MAX_SAFE_INTEGER);
    const limit = boundedPositiveInteger(input["limit"], 2_000, MAX_READ_LINES);
    const result = await readTextRange(abs, offset, limit, ctx.signal);
    if (result.binary) {
      return `(文件 ${rel(ctx.cwd, abs)} 看起来是二进制/非文本，${stat.size} 字节，未按文本读取)`;
    }
    if (result.lines.length === 0) {
      return result.truncated
        ? `(读取 ${rel(ctx.cwd, abs)} 达到 ${MAX_READ_SCAN_BYTES} 字节扫描上限，尚未到第 ${offset} 行)`
        : `(文件 ${rel(ctx.cwd, abs)} 在该范围内为空)`;
    }
    const width = String(offset + result.lines.length - 1).length;
    const body = result.lines
      .map((line, index) => `${String(offset + index).padStart(width)}\t${clampLine(line)}`)
      .join("\n");
    return result.truncated ? `${body}\n…（已达到本次读取的行数或字节上限）` : body;
  },
};

function boundedPositiveInteger(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(parsed)));
}

async function readTextRange(
  file: string,
  offset: number,
  limit: number,
  signal: AbortSignal,
): Promise<{ lines: string[]; binary: boolean; truncated: boolean }> {
  const handle = await fs.open(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const decoder = new StringDecoder("utf8");
  const lines: string[] = [];
  let pending = "";
  let position = 0;
  let lineNumber = 1;
  let eof = false;
  try {
    while (position < MAX_READ_SCAN_BYTES && lines.length < limit) {
      if (signal.aborted) throw new ToolError("会话已中断，文件读取未完成");
      const remaining = Math.min(buffer.length, MAX_READ_SCAN_BYTES - position);
      const { bytesRead } = await handle.read(buffer, 0, remaining, position);
      if (bytesRead === 0) {
        eof = true;
        break;
      }
      if (position === 0 && isBinary(buffer.subarray(0, Math.min(bytesRead, 8_192)))) {
        return { lines: [], binary: true, truncated: false };
      }
      position += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, "");
        pending = pending.slice(newline + 1);
        if (lineNumber >= offset) lines.push(line);
        lineNumber++;
        if (lines.length >= limit) break;
      }
    }
    if (eof && lines.length < limit) {
      pending += decoder.end();
      if (pending.length > 0 && lineNumber >= offset) lines.push(pending.replace(/\r$/, ""));
    }
    return {
      lines,
      binary: false,
      truncated: !eof || lines.length >= limit,
    };
  } finally {
    await handle.close();
  }
}

/** 各 provider 普遍支持的图片类型（Anthropic / OpenAI 交集）。 */
const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * 单图原始字节上限。provider 侧普遍限制约 5MB base64，而 base64 膨胀约 4/3，
 * 故原始上限取 ~3.7MB —— 超限宁可回一句说明，也不要整轮请求被拒。
 */
const MAX_IMAGE_BYTES = 3_700_000;

function imageMediaType(abs: string): string | undefined {
  return IMAGE_TYPES[path.extname(abs).toLowerCase()];
}

/**
 * 用魔数校验内容确实是该类型的图片。后缀是用户/仓库可控的数据，不能当事实：
 * 把一个文本文件命名成 .png 后 base64 发出去，provider 会拒掉**整轮请求**
 * （而不只是这一次工具调用），重试还会重放同样的坏历史 —— 会话就卡死了。
 */
function matchesImageMagic(buf: Buffer, mediaType: string): boolean {
  const startsWith = (...bytes: number[]): boolean =>
    buf.length >= bytes.length && bytes.every((b, i) => buf[i] === b);
  switch (mediaType) {
    case "image/png":
      return startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case "image/jpeg":
      return startsWith(0xff, 0xd8, 0xff);
    case "image/gif":
      return (
        buf.subarray(0, 6).toString("latin1") === "GIF87a" ||
        buf.subarray(0, 6).toString("latin1") === "GIF89a"
      );
    case "image/webp":
      // RIFF....WEBP
      return (
        buf.length >= 12 &&
        buf.subarray(0, 4).toString("latin1") === "RIFF" &&
        buf.subarray(8, 12).toString("latin1") === "WEBP"
      );
    default:
      return false;
  }
}

/**
 * 读图：模型支持视觉时把图片本体附给模型（经 ctx.attachImage），
 * 否则如实回一句文本说明 —— 让模型知道"这是张图但我看不到"，而不是收到乱码或静默失败。
 */
function readImage(buf: Buffer, mediaType: string, relPath: string, ctx: ToolContext): string {
  const kb = Math.round(buf.length / 1024);
  if (!matchesImageMagic(buf, mediaType)) {
    return t(
      `(${relPath} has an image extension but its content is not a valid ${mediaType}; not loaded as an image. Check the file — the extension may be wrong.)`,
      `(${relPath} 的后缀是图片，但内容不是合法的 ${mediaType}，未按图片加载。请确认该文件——后缀可能不对。)`,
    );
  }
  if (!ctx.modelSupportsImages || !ctx.attachImage) {
    return t(
      `(${relPath} is an image (${mediaType}, ${kb} KB), but the current model has no vision support, so its content was not loaded.)`,
      `(${relPath} 是图片（${mediaType}，${kb} KB），但当前模型不支持视觉，未加载图片内容。)`,
    );
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return t(
      `(${relPath} is an image (${mediaType}) but is too large at ${kb} KB (limit ${Math.round(MAX_IMAGE_BYTES / 1024)} KB); content not loaded. Shrink or crop it first.)`,
      `(${relPath} 是图片（${mediaType}），但 ${kb} KB 超过 ${Math.round(MAX_IMAGE_BYTES / 1024)} KB 上限，未加载内容。可先压缩或裁剪。)`,
    );
  }
  ctx.attachImage({ type: "image", mediaType, data: buf.toString("base64") });
  return t(
    `(Read image ${relPath} — ${mediaType}, ${kb} KB. The image itself is attached below.)`,
    `(已读取图片 ${relPath} —— ${mediaType}，${kb} KB。图片本体已附在下方。)`,
  );
}

function imageTooLarge(mediaType: string, relPath: string, bytes: number): string {
  const kb = Math.round(bytes / 1024);
  return t(
    `(${relPath} is an image (${mediaType}) but is too large at ${kb} KB (limit ${Math.round(MAX_IMAGE_BYTES / 1024)} KB); content not loaded. Shrink or crop it first.)`,
    `(${relPath} 是图片（${mediaType}），但 ${kb} KB 超过 ${Math.round(MAX_IMAGE_BYTES / 1024)} KB 上限，未加载内容。可先压缩或裁剪。)`,
  );
}

const MAX_LINE_CHARS = 2000;

/** 超长单行会挤爆上下文（如压缩后的 JS、data URI）；截断并标注原长度。 */
function clampLine(line: string): string {
  if (line.length <= MAX_LINE_CHARS) return line;
  return `${line.slice(0, MAX_LINE_CHARS)}…（本行共 ${line.length} 字符，已截断）`;
}

/** 采样前 8KB：含 NUL 字节判为二进制。 */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const writeTool: Tool = {
  readOnly: false,
  mutatesFiles: true,
  def: {
    name: "write",
    description: t(
      "Create or completely overwrite a file. Parent directories are created automatically.",
      "创建或完全覆盖一个文件。父目录会自动创建。",
    ),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: t("File path relative to cwd", "相对 cwd 的文件路径"),
        },
        content: { type: "string", description: t("Full file content", "文件完整内容") },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["path"] ?? ""),
  async run(input, ctx) {
    ensureActive(ctx);
    const abs = await resolveInside(ctx.cwd, input["path"]);
    const content = String(input["content"] ?? "");
    ensureActive(ctx);
    const service = new PatchSetService(ctx.cwd, { directCommit: "trusted-local" });
    const patchset = await service.prepare([{ path: abs, content }]);
    ensureActive(ctx);
    await service.apply(patchset);
    return `已写入 ${rel(ctx.cwd, abs)}（${content.length} 字符，PatchSet ${patchset.id}）`;
  },
};

export const editTool: Tool = {
  readOnly: false,
  mutatesFiles: true,
  def: {
    name: "edit",
    description: t(
      "Make an exact string replacement in a file. old_string must occur uniquely in the file (otherwise it errors), unless replace_all=true.",
      "在文件中做精确字符串替换。old_string 必须在文件中唯一出现（否则报错），除非 replace_all=true。",
    ),
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: t("File path relative to cwd", "相对 cwd 的文件路径"),
        },
        old_string: {
          type: "string",
          description: t("The original text to replace (must be unique)", "要替换的原文（需唯一）"),
        },
        new_string: { type: "string", description: t("The replacement text", "替换后的内容") },
        replace_all: {
          type: "boolean",
          description: t("Replace all occurrences (default false)", "替换全部出现（默认 false）"),
        },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["path"] ?? ""),
  async run(input, ctx) {
    ensureActive(ctx);
    const abs = await resolveInside(ctx.cwd, input["path"]);
    const oldStr = String(input["old_string"] ?? "");
    const newStr = String(input["new_string"] ?? "");
    const replaceAll = Boolean(input["replace_all"]);
    if (!oldStr) throw new ToolError("old_string 不能为空");

    let content: string;
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) throw new ToolError(`读取失败: ${rel(ctx.cwd, abs)} 不是普通文件`);
      if (stat.size > MAX_EDIT_FILE_BYTES) {
        throw new ToolError(
          `文件过大，edit 单次最多处理 ${MAX_EDIT_FILE_BYTES} 字节: ${rel(ctx.cwd, abs)}`,
        );
      }
      content = await fs.readFile(abs, "utf8");
    } catch (e: any) {
      if (e instanceof ToolError) throw e;
      throw new ToolError(`读取失败: ${e?.code ?? e}`);
    }

    const { updated, replaced, mode } = applyEdit(content, oldStr, newStr, replaceAll);
    ensureActive(ctx);
    const service = new PatchSetService(ctx.cwd, { directCommit: "trusted-local" });
    const patchset = await service.prepare([{ path: abs, content: updated }]);
    ensureActive(ctx);
    await service.apply(patchset);
    // mode=fuzzy 时提示模型这次靠空白容差匹配上了，下次可给更精确的 old_string。
    const note = mode === "fuzzy" ? "（按空白容差匹配）" : "";
    return `已修改 ${rel(ctx.cwd, abs)}（替换 ${replaced} 处${
      note ? " " + note : ""
    }，PatchSet ${patchset.id}）`;
  },
};

/**
 * 应用一次编辑：先精确匹配，失败再退到「按行去除首尾空白」的模糊匹配。
 * 都失败则抛出带「最接近片段」的反射式错误，让模型据此自我纠正（Aider 的关键经验：
 * 关掉这类自愈会让编辑错误率数倍上升）。
 */
export function applyEdit(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): { updated: string; replaced: number; mode: "exact" | "fuzzy" } {
  const exact = content.split(oldStr).length - 1;
  if (exact === 1 || (exact > 1 && replaceAll)) {
    const updated = replaceAll
      ? content.split(oldStr).join(newStr)
      : content.replace(oldStr, newStr);
    return { updated, replaced: replaceAll ? exact : 1, mode: "exact" };
  }
  if (exact > 1 && !replaceAll) {
    throw new ToolError(
      `old_string 出现 ${exact} 次，不唯一；请扩大上下文（多带几行）或用 replace_all`,
    );
  }

  // exact === 0：按行去空白模糊定位。
  const spans = locateFuzzy(content, oldStr);
  if (spans.length === 1 || (spans.length > 1 && replaceAll)) {
    // 从后往前替换，避免前面的替换改动后续 span 的偏移。
    let updated = content;
    const targets = replaceAll ? [...spans].reverse() : [spans[0]!];
    for (const s of targets) updated = updated.slice(0, s.start) + newStr + updated.slice(s.end);
    return { updated, replaced: targets.length, mode: "fuzzy" };
  }
  if (spans.length > 1 && !replaceAll) {
    throw new ToolError(
      `old_string 按空白容差匹配到 ${spans.length} 处，不唯一；请扩大上下文或用 replace_all`,
    );
  }

  const near = nearestSnippet(content, oldStr);
  throw new ToolError(
    "未找到 old_string（精确与空白容差均未命中）。" +
      (near
        ? `\n文件中最接近的片段是：\n<<<<<<<\n${near}\n>>>>>>>\n请据此修正 old_string 后重试。`
        : "请确认路径与内容，或先用 read 查看当前文件。"),
  );
}

/** 按行匹配：忽略每行首尾空白；返回命中在原文中的字符区间（保留原始缩进作被替换段）。 */
function locateFuzzy(content: string, oldStr: string): { start: number; end: number }[] {
  const oldLines = oldStr.split("\n").map((l) => l.trim());
  const lines = content.split("\n");
  const offsets: number[] = [];
  let pos = 0;
  for (const line of lines) {
    offsets.push(pos);
    pos += line.length + 1; // +1 为换行符
  }
  const n = oldLines.length;
  const spans: { start: number; end: number }[] = [];
  for (let i = 0; i + n <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (lines[i + j]!.trim() !== oldLines[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const last = i + n - 1;
      spans.push({ start: offsets[i]!, end: offsets[last]! + lines[last]!.length });
    }
  }
  return spans;
}

/** 找出与 old_string 首行最相似的行，返回其起始的等长窗口，供反射式错误展示。 */
function nearestSnippet(content: string, oldStr: string): string | null {
  const anchor = oldStr
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!anchor) return null;
  const lines = content.split("\n");
  const n = oldStr.split("\n").length;
  let best = { sim: 0, i: 0 };
  for (let i = 0; i < lines.length; i++) {
    const sim = diceSimilarity(lines[i]!.trim(), anchor);
    if (sim > best.sim) best = { sim, i };
  }
  if (best.sim < 0.4) return null; // 太不相似就别误导模型
  return lines.slice(best.i, best.i + n).join("\n");
}

/** Sørensen–Dice 二元组相似度（0~1），用于"你是不是想找这段"的模糊定位。 */
function diceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let overlap = 0;
  for (const [g, count] of ga) overlap += Math.min(count, gb.get(g) ?? 0);
  return (2 * overlap) / (a.length - 1 + (b.length - 1));
}

// ---------- Glob ----------

export const globTool: Tool = {
  readOnly: true,
  def: {
    name: "glob",
    description: t(
      "Find files by glob pattern (e.g. **/*.ts), returning a bounded list sorted by modification time, newest first. Skips common generated/vendor directories and never follows symlinks.",
      "按 glob 模式查找文件（如 **/*.ts），返回相对路径列表，按修改时间倒序（近期改动更可能相关）。" +
        "跳过 node_modules/.git/dist 等常见目录且不跟随符号链接；遍历有硬上限。",
    ),
    parameters: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: t("Glob pattern, e.g. src/**/*.ts", "glob 模式，如 src/**/*.ts"),
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["pattern"] ?? ""),
  async run(input, ctx) {
    const pattern = String(input["pattern"] ?? "");
    if (!pattern) throw new ToolError("pattern 不能为空");
    const root = path.resolve(ctx.cwd);

    const matches: WalkFile[] = [];
    const budget = newWalkBudget();
    await walk(root, root, globToRegExp(pattern), matches, ctx.signal, budget);
    matches.sort((a, b) => b.mtime - a.mtime);
    if (matches.length === 0) {
      return budget.truncated
        ? `(在有界扫描范围内无文件匹配 ${pattern}；仓库过大，结果可能不完整)`
        : `(无文件匹配 ${pattern})`;
    }
    const body = matches
      .slice(0, MAX_RESULTS)
      .map((m) => path.relative(root, m.path))
      .join("\n");
    return matches.length > MAX_RESULTS || budget.truncated
      ? `${body}\n…（超过 ${MAX_RESULTS} 个匹配，仅显示最近修改的部分）`
      : body;
  },
};

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage"]);

interface WalkFile {
  path: string;
  mtime: number;
  size: number;
}

interface WalkBudget {
  files: number;
  directories: number;
  deadline: number;
  truncated: boolean;
}

function newWalkBudget(): WalkBudget {
  return {
    files: 0,
    directories: 0,
    deadline: Date.now() + MAX_SEARCH_MS,
    truncated: false,
  };
}

function walkBudgetExhausted(budget: WalkBudget): boolean {
  const exhausted =
    budget.files >= MAX_SEARCH_FILES ||
    budget.directories >= MAX_SEARCH_DIRECTORIES ||
    Date.now() >= budget.deadline;
  if (exhausted) budget.truncated = true;
  return exhausted;
}

async function walk(
  root: string,
  dir: string,
  re: RegExp,
  out: WalkFile[],
  signal: AbortSignal,
  budget: WalkBudget,
): Promise<void> {
  if (signal.aborted) throw new ToolError("会话已中断，文件扫描未完成");
  if (walkBudgetExhausted(budget)) return;
  budget.directories++;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (signal.aborted) throw new ToolError("会话已中断，文件扫描未完成");
    if (walkBudgetExhausted(budget)) return;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE.has(e.name)) continue;
      await walk(root, abs, re, out, signal, budget);
    } else if (e.isFile()) {
      budget.files++;
      const relPath = path.relative(root, abs);
      if (re.test(relPath)) {
        try {
          const st = await fs.stat(abs);
          if (st.isFile()) out.push({ path: abs, mtime: st.mtimeMs, size: st.size });
        } catch {
          /* ignore */
        }
      }
    }
  }
}

function globToRegExp(pattern: string): RegExp {
  // 支持 **（跨目录）、*（单层）、? （单字符）
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
        if (pattern[i + 1] === "/") i++; // **/ 吞掉斜杠
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

// ---------- Grep ----------

type GrepMode = "content" | "files_with_matches" | "count";

export const grepTool: Tool = {
  readOnly: true,
  def: {
    name: "grep",
    description: t(
      "Search file contents with a bounded regular expression scan that skips binaries, symlinks and common generated/vendor directories. output_mode: content=file:line:content (default), files_with_matches=list matching files only, count=matches per file. Optionally: glob to limit files, path to limit to a subdirectory, ignore_case to ignore case, context to include surrounding lines (content mode only).",
      "在文件内容中用有硬资源上限的正则搜索（跳过二进制、符号链接和常见生成/依赖目录）。" +
        "output_mode: content=文件:行号:内容（默认）、files_with_matches=仅列命中文件、count=每文件命中数。" +
        "可选 glob 限定文件、path 限定子目录、ignore_case 忽略大小写、context 附带前后行（仅 content）。",
    ),
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: t("Regular expression", "正则表达式") },
        glob: {
          type: "string",
          description: t(
            "File glob to limit the search (e.g. *.ts)",
            "限定搜索的文件 glob（如 *.ts）",
          ),
        },
        path: {
          type: "string",
          description: t(
            "Subdirectory to limit the search (relative to cwd)",
            "限定搜索的子目录（相对 cwd）",
          ),
        },
        output_mode: {
          type: "string",
          enum: ["content", "files_with_matches", "count"],
          description: t("Output mode, default content", "输出模式，默认 content"),
        },
        ignore_case: {
          type: "boolean",
          description: t("Ignore case (default false)", "忽略大小写（默认 false）"),
        },
        context: {
          type: "number",
          description: t(
            "Number of surrounding lines to include in content mode (default 0)",
            "content 模式下附带的前后行数（默认 0）",
          ),
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => String(i["pattern"] ?? ""),
  isConcurrencySafe: () => true,
  async run(input, ctx) {
    const pattern = String(input["pattern"] ?? "");
    if (!pattern) throw new ToolError("pattern 不能为空");
    const mode = normalizeMode(input["output_mode"]);
    const ignoreCase = Boolean(input["ignore_case"]);
    const globFilter = input["glob"] ? String(input["glob"]) : undefined;
    const context =
      mode === "content" ? Math.max(0, Math.min(20, Number(input["context"]) || 0)) : 0;
    const root = path.resolve(ctx.cwd);
    // 子目录限定：约束在 cwd 内，防穿越。
    const searchDir = input["path"] ? await resolveInside(root, input["path"]) : root;

    return grepViaJs(pattern, {
      mode,
      ignoreCase,
      context,
      globFilter,
      root,
      searchDir,
      signal: ctx.signal,
    });
  },
};

function normalizeMode(v: unknown): GrepMode {
  return v === "files_with_matches" || v === "count" ? v : "content";
}

async function grepViaJs(
  pattern: string,
  o: {
    mode: GrepMode;
    ignoreCase: boolean;
    context: number;
    globFilter: string | undefined;
    root: string;
    searchDir: string;
    signal: AbortSignal;
  },
): Promise<string> {
  assertBoundedRegex(pattern);
  let re: RegExp;
  try {
    re = new RegExp(pattern, o.ignoreCase ? "i" : "");
  } catch (e: any) {
    throw new ToolError(`无效正则: ${e?.message ?? e}`);
  }
  const fileRe = o.globFilter ? globToRegExp(o.globFilter) : /.*/;
  const files: WalkFile[] = [];
  const budget = newWalkBudget();
  await walk(o.searchDir, o.searchDir, fileRe, files, o.signal, budget);

  const results: string[] = [];
  const counts: string[] = [];
  let scannedBytes = 0;
  outer: for (const f of files) {
    if (o.signal.aborted) throw new ToolError("会话已中断，文件搜索未完成");
    if (f.size > MAX_SEARCH_FILE_BYTES || scannedBytes + f.size > MAX_SEARCH_TOTAL_BYTES) {
      budget.truncated = true;
      if (scannedBytes + f.size > MAX_SEARCH_TOTAL_BYTES) break;
      continue;
    }
    let contents: Buffer;
    try {
      contents = await fs.readFile(f.path);
    } catch {
      continue; // 跳过二进制/不可读
    }
    scannedBytes += contents.length;
    if (isBinary(contents)) continue;
    const text = contents.toString("utf8");
    const relPath = path.relative(o.root, f.path);
    const lines = text.split("\n");
    let fileHits = 0;
    for (let i = 0; i < lines.length; i++) {
      const searchable = lines[i]!.slice(0, MAX_REGEX_LINE_CHARS);
      if (!re.test(searchable)) continue;
      fileHits++;
      if (o.mode === "files_with_matches") {
        results.push(relPath);
        continue outer; // 一命中即够，转下一个文件
      }
      if (o.mode === "content") {
        if (o.context > 0) {
          const from = Math.max(0, i - o.context);
          const to = Math.min(lines.length - 1, i + o.context);
          for (let j = from; j <= to; j++) {
            results.push(`${relPath}:${j + 1}:${lines[j]!.slice(0, 200)}`);
          }
          if (results.length >= MAX_RESULTS) {
            budget.truncated = true;
            break outer;
          }
        } else {
          results.push(`${relPath}:${i + 1}:${lines[i]!.slice(0, 200)}`);
          if (results.length >= MAX_RESULTS) {
            budget.truncated = true;
            break outer;
          }
        }
      }
    }
    if (o.mode === "count" && fileHits > 0) {
      counts.push(`${relPath}:${fileHits}`);
      if (counts.length >= MAX_RESULTS) {
        budget.truncated = true;
        break;
      }
    }
  }

  const selected = o.mode === "count" ? counts : results;
  if (!selected.length) {
    return budget.truncated
      ? `${emptyGrep(pattern, o.mode)}（扫描达到资源上限，结果可能不完整）`
      : emptyGrep(pattern, o.mode);
  }
  const body = selected.join("\n");
  return budget.truncated ? `${body}\n…（扫描达到资源上限，结果已截断）` : body;
}

function assertBoundedRegex(pattern: string): void {
  if (pattern.length > MAX_REGEX_CHARS) {
    throw new ToolError(`正则过长（最多 ${MAX_REGEX_CHARS} 字符）`);
  }
  // JavaScript RegExp has no deadline. Reject the common exponential-time constructs and
  // backtracking features rather than letting a repository-controlled line block the host loop.
  const nestedQuantifier =
    /\((?:[^()\\]|\\.)*(?:[+*]|\{\d*,?\d*\})(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{)/;
  const quantifiedAlternation = /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{)/;
  if (
    nestedQuantifier.test(pattern) ||
    quantifiedAlternation.test(pattern) ||
    /\\[1-9]/.test(pattern) ||
    /\(\?<([=!])/.test(pattern)
  ) {
    throw new ToolError("正则包含可能导致无界回溯的结构；请改用更简单的模式");
  }
}

function emptyGrep(pattern: string, mode: GrepMode): string {
  return mode === "content" ? `(无匹配 /${pattern}/)` : `(无文件匹配 /${pattern}/)`;
}
