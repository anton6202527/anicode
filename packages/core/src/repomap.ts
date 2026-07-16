/**
 * Repo map —— 给模型一张「代码地图」，替代盲目 grep（对齐 Aider 的 repo-map 思路，但零依赖）。
 *
 * 做法：扫描工作区源文件，用按语言的轻量正则抽出顶层符号（函数/类/接口/类型…）的签名行，
 * 再按「跨文件被引用的次数」给符号与文件排序（PageRank 的廉价近似：全局标识符词频），
 * 最后按 token 预算拼出一段 `<repo-map>` 注入 system。模型据此一眼看到项目骨架与关键符号
 * 所在文件，首次定位更准、更省 token。
 *
 * 纯函数 buildRepoMap(files, budget) 负责排序与渲染（离线可测）；
 * 异步 gatherRepoMap(cwd, opts) 负责走盘采集（跳过 node_modules/.git/产物目录，限量限大小）。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export interface RepoMapOptions {
  /** 注入预算（token 近似，1 token≈4 char）。默认 1500。 */
  tokenBudget?: number;
  /** 最多扫描的文件数（保护大仓库）。默认 2000。 */
  maxFiles?: number;
  /** 单文件读取上限（字节），超出跳过。默认 256KB。 */
  maxFileBytes?: number;
}

export interface SourceFile {
  path: string; // 相对 cwd
  content: string;
}

interface Symbol {
  name: string;
  sig: string;
}

const SOURCE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "out",
  "build",
  "release",
  "coverage",
  ".next",
  ".turbo",
  "vendor",
  "__pycache__",
]);

/** 各语言顶层定义的正则：捕获组 1 = 符号名；整行（trim）作为签名。 */
const PATTERNS: { ext: Set<string>; res: RegExp[] }[] = [
  {
    ext: new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]),
    res: [
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
      /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
      /^\s*export\s+interface\s+([A-Za-z_$][\w$]*)/,
      /^\s*export\s+type\s+([A-Za-z_$][\w$]*)/,
      /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
      /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
      /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    ],
  },
  {
    ext: new Set([".py"]),
    res: [/^\s*def\s+([A-Za-z_][\w]*)/, /^\s*class\s+([A-Za-z_][\w]*)/],
  },
  {
    ext: new Set([".go"]),
    res: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)/, /^\s*type\s+([A-Za-z_][\w]*)/],
  },
  {
    ext: new Set([".rs"]),
    res: [
      /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)/,
      /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_][\w]*)/,
    ],
  },
  {
    ext: new Set([".java"]),
    res: [
      /^\s*(?:public|private|protected)?\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][\w]*)/,
      /^\s*(?:public|private|protected)?\s*interface\s+([A-Za-z_][\w]*)/,
    ],
  },
];

/** 抽取一个文件的顶层符号（名 + 签名行）。纯函数。 */
export function extractSymbols(relPath: string, content: string): Symbol[] {
  const ext = path.extname(relPath);
  const group = PATTERNS.find((p) => p.ext.has(ext));
  if (!group) return [];
  const out: Symbol[] = [];
  const seen = new Set<string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.length > 400) continue; // 跳过压缩/超长行
    for (const re of group.res) {
      const m = re.exec(line);
      if (m) {
        const name = m[1]!;
        if (seen.has(name)) break;
        seen.add(name);
        // 签名 = 该行去尾部 { 与空白，压缩多空格，截断。
        const sig = line
          .trim()
          .replace(/\s*\{?\s*$/, "")
          .replace(/\s+/g, " ")
          .slice(0, 100);
        out.push({ name, sig });
        break;
      }
    }
  }
  return out;
}

const IDENT_RE = /[A-Za-z_$][\w$]*/g;

/** 全局标识符词频：跨文件被引用越多，符号越「重要」（PageRank 的廉价近似）。 */
function globalFrequency(files: SourceFile[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const f of files) {
    const ids = f.content.match(IDENT_RE);
    if (!ids) continue;
    for (const id of ids) freq.set(id, (freq.get(id) ?? 0) + 1);
  }
  return freq;
}

/**
 * 纯函数：把源文件集渲染成 `<repo-map>` 文本，按重要度排序、按 token 预算截断。
 * 无符号可抽的文件不进图。预算耗尽即停，并标注省略了多少文件。
 */
export function buildRepoMap(files: SourceFile[], opts: RepoMapOptions = {}): string {
  const budgetChars = (opts.tokenBudget ?? 1500) * 4;
  const freq = globalFrequency(files);

  const entries = files
    .map((f) => {
      const symbols = extractSymbols(f.path, f.content);
      // 文件内符号按被引用次数降序；文件重要度 = 其符号引用次数之和。
      symbols.sort((a, b) => (freq.get(b.name) ?? 0) - (freq.get(a.name) ?? 0));
      const importance = symbols.reduce((s, sym) => s + (freq.get(sym.name) ?? 0), 0);
      return { path: f.path, symbols, importance };
    })
    .filter((e) => e.symbols.length > 0)
    .sort((a, b) => b.importance - a.importance || a.path.localeCompare(b.path));

  if (entries.length === 0) return "";

  const lines: string[] = ["<repo-map>"];
  let used = lines[0]!.length;
  let shown = 0;
  for (const e of entries) {
    const block: string[] = [`${e.path}:`];
    for (const sym of e.symbols.slice(0, 12)) block.push(`  ${sym.sig}`);
    const text = block.join("\n");
    if (used + text.length + 1 > budgetChars && shown > 0) break;
    lines.push(text);
    used += text.length + 1;
    shown++;
  }
  const omitted = entries.length - shown;
  if (omitted > 0) lines.push(`… (+${omitted} more files)`);
  lines.push("</repo-map>");
  return lines.join("\n");
}

async function walk(dir: string, root: string, out: string[], maxFiles: number): Promise<void> {
  if (out.length >= maxFiles) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (out.length >= maxFiles) return;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
      await walk(full, root, out, maxFiles);
    } else if (ent.isFile() && SOURCE_EXT.has(path.extname(ent.name))) {
      out.push(full);
    }
  }
}

/** 采集工作区源文件并渲染 repo map。任何一步失败静默降级为空串。 */
export async function gatherRepoMap(cwd: string, opts: RepoMapOptions = {}): Promise<string> {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = opts.maxFileBytes ?? 256 * 1024;
  const abs: string[] = [];
  await walk(path.resolve(cwd), path.resolve(cwd), abs, maxFiles);

  const files: SourceFile[] = [];
  for (const file of abs) {
    try {
      const stat = await fs.stat(file);
      if (stat.size > maxBytes) continue;
      const content = await fs.readFile(file, "utf8");
      files.push({ path: path.relative(cwd, file), content });
    } catch {
      /* 跳过读不到的文件 */
    }
  }
  return buildRepoMap(files, opts);
}
