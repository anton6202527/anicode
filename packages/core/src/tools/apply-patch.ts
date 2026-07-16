/**
 * apply_patch —— 一次调用批量增/删/改多个文件（对齐 Codex 的 apply_patch 格式）。
 *
 * 相比多次 edit，紧凑的补丁格式在一次工具调用里表达跨文件改动，省 token、原子性更好。
 * 格式（Codex 风格 envelope）：
 *
 *   *** Begin Patch
 *   *** Add File: path/new.txt
 *   +第一行
 *   +第二行
 *   *** Update File: path/existing.ts
 *   @@ 可选定位上下文
 *    保持行（前导空格）
 *   -删除行
 *   +新增行
 *   *** Delete File: path/old.txt
 *   *** End Patch
 *
 * hunk 按内容定位（不依赖行号）：先精确匹配「保持+删除」块，失败退到按行去空白的模糊匹配，
 * 都失败抛反射式错误。解析与应用是纯函数，离线可测。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { Tool, ToolContext } from "./tool.js";
import { ToolError } from "./tool.js";
import { resolveInside } from "./fs.js";
import { t } from "../i18n.js";

export type PatchOp =
  | { kind: "add"; path: string; lines: string[] }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; hunks: Hunk[] };

/** 一个 hunk = 有序的行操作序列（keep/del/add）。 */
export interface Hunk {
  lines: { type: " " | "-" | "+"; text: string }[];
}

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DEL = "*** Delete File: ";
const UPD = "*** Update File: ";

/** 解析补丁 envelope 成操作列表。纯函数。 */
export function parsePatch(patch: string): PatchOp[] {
  const raw = patch.replace(/\r\n/g, "\n").split("\n");
  // 容忍前后空白行；必须有 Begin/End 包裹。
  let i = 0;
  while (i < raw.length && raw[i]!.trim() === "") i++;
  if (raw[i] !== BEGIN) throw new ToolError(`补丁缺少 "${BEGIN}" 头`);
  i++;
  const ops: PatchOp[] = [];
  while (i < raw.length) {
    const line = raw[i]!;
    if (line === END) return ops;
    if (line.startsWith(ADD)) {
      const p = line.slice(ADD.length).trim();
      i++;
      const lines: string[] = [];
      while (i < raw.length && !isHeader(raw[i]!)) {
        const l = raw[i]!;
        if (l.startsWith("+")) lines.push(l.slice(1));
        else if (l.trim() === "") lines.push("");
        else throw new ToolError(`Add File 内容行须以 "+" 开头: ${JSON.stringify(l)}`);
        i++;
      }
      ops.push({ kind: "add", path: p, lines });
    } else if (line.startsWith(DEL)) {
      ops.push({ kind: "delete", path: line.slice(DEL.length).trim() });
      i++;
    } else if (line.startsWith(UPD)) {
      const p = line.slice(UPD.length).trim();
      i++;
      const { hunks, next } = parseHunks(raw, i);
      ops.push({ kind: "update", path: p, hunks });
      i = next;
    } else if (line.trim() === "") {
      i++;
    } else {
      throw new ToolError(`无法识别的补丁行: ${JSON.stringify(line)}`);
    }
  }
  throw new ToolError(`补丁缺少 "${END}" 尾`);
}

function isHeader(line: string): boolean {
  return line === END || line.startsWith(ADD) || line.startsWith(DEL) || line.startsWith(UPD);
}

/** 从 start 开始解析若干 hunk，直到遇到下一个文件头或 End。 */
function parseHunks(raw: string[], start: number): { hunks: Hunk[]; next: number } {
  const hunks: Hunk[] = [];
  let i = start;
  let current: Hunk | null = null;
  const flush = () => {
    if (current && current.lines.length > 0) hunks.push(current);
    current = null;
  };
  while (i < raw.length && !isHeader(raw[i]!)) {
    const l = raw[i]!;
    if (l.startsWith("@@")) {
      flush();
      current = { lines: [] };
      i++;
      continue;
    }
    if (!current) current = { lines: [] };
    if (l.startsWith("+")) current.lines.push({ type: "+", text: l.slice(1) });
    else if (l.startsWith("-")) current.lines.push({ type: "-", text: l.slice(1) });
    else if (l.startsWith(" ")) current.lines.push({ type: " ", text: l.slice(1) });
    else if (l === "")
      current.lines.push({ type: " ", text: "" }); // 空行当作保持的空行
    else if (l.startsWith("\\")) {
      /* "\ No newline at end of file" 之类，忽略 */
    } else {
      throw new ToolError(`Update hunk 行须以 " " / "-" / "+" 开头: ${JSON.stringify(l)}`);
    }
    i++;
  }
  flush();
  if (hunks.length === 0) throw new ToolError("Update File 没有任何 hunk");
  return { hunks, next: i };
}

/** 把一组 hunk 应用到文件内容上。纯函数，返回新内容。 */
export function applyHunks(content: string, hunks: Hunk[]): string {
  const eol = content.includes("\n") ? "\n" : "\n";
  let lines = content.split("\n");
  // 记录尾部是否有换行：split 后若原文以 \n 结尾，最后会多一个空串。
  let searchFrom = 0;
  for (const hunk of hunks) {
    const oldBlock = hunk.lines.filter((l) => l.type !== "+").map((l) => l.text);
    const newBlock = hunk.lines.filter((l) => l.type !== "-").map((l) => l.text);
    const at = locateBlock(lines, oldBlock, searchFrom);
    if (at < 0) {
      const near = oldBlock.slice(0, 3).join("\\n");
      throw new ToolError(
        `Update 定位失败：在文件中找不到该 hunk 的上下文/删除块（前几行：${JSON.stringify(near)}）。` +
          `请用 read 查看当前文件后重出补丁。`,
      );
    }
    lines = [...lines.slice(0, at), ...newBlock, ...lines.slice(at + oldBlock.length)];
    searchFrom = at + newBlock.length;
  }
  return lines.join(eol);
}

/**
 * 在 lines 中从 from 起定位 block（连续子序列）。先精确，失败按行去空白模糊。
 * 命中返回起始下标；未命中返回 -1。要求唯一性由调用序保证（顺序前进）。
 */
function locateBlock(lines: string[], block: string[], from: number): number {
  if (block.length === 0) return Math.min(from, lines.length);
  const exact = find(lines, block, from, (a, b) => a === b);
  if (exact >= 0) return exact;
  return find(lines, block, from, (a, b) => a.trim() === b.trim());
}

function find(
  lines: string[],
  block: string[],
  from: number,
  eq: (a: string, b: string) => boolean,
): number {
  for (let i = Math.max(0, from); i + block.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < block.length; j++) {
      if (!eq(lines[i + j]!, block[j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/** 补丁影响的文件路径（用于权限规则匹配与摘要）。 */
export function patchPaths(patch: string): string[] {
  try {
    return parsePatch(patch).map((op) => op.path);
  } catch {
    return [];
  }
}

export const applyPatchTool: Tool = {
  readOnly: false,
  mutatesFiles: true,
  def: {
    name: "apply_patch",
    description: t(
      "Add/delete/modify multiple files in one patch (more compact and atomic than multiple edits). Patch format:\n" +
        "*** Begin Patch / *** Add File: p / *** Update File: p (@@ to locate + space=keep/-=delete/+=add) / " +
        "*** Delete File: p / *** End Patch. Hunks are located by content, not by line number.",
      "用一个补丁一次性增/删/改多个文件（比多次 edit 更紧凑、更原子）。补丁格式：\n" +
        "*** Begin Patch / *** Add File: p / *** Update File: p（@@ 定位 + 空格保持/-删除/+新增）/ " +
        "*** Delete File: p / *** End Patch。hunk 按内容定位，不依赖行号。",
    ),
    parameters: {
      type: "object",
      properties: {
        patch: {
          type: "string",
          description: t(
            "The full *** Begin Patch … *** End Patch text",
            "完整的 *** Begin Patch … *** End Patch 文本",
          ),
        },
      },
      required: ["patch"],
      additionalProperties: false,
    },
  },
  ruleKey: (i) => {
    const paths = patchPaths(String(i["patch"] ?? ""));
    return paths.length ? `apply_patch ${paths.join(", ")}` : "apply_patch";
  },
  ruleParts: (i) => patchPaths(String(i["patch"] ?? "")).map((p) => `apply_patch ${p}`),
  async run(input, ctx: ToolContext): Promise<string> {
    if (ctx.signal.aborted) throw new ToolError("会话已中断，补丁未应用");
    const ops = parsePatch(String(input["patch"] ?? ""));
    if (ops.length === 0) throw new ToolError("空补丁");
    // 先全部解析并 resolve 路径（越界立即失败，不留半应用状态的机会）。
    const resolved = await Promise.all(
      ops.map(async (op) => ({ op, abs: await resolveInside(ctx.cwd, op.path) })),
    );
    const summary: string[] = [];
    for (const { op, abs } of resolved) {
      if (ctx.signal.aborted) throw new ToolError("会话已中断，补丁未完成");
      if (op.kind === "add") {
        if (await exists(abs)) throw new ToolError(`Add File 目标已存在: ${op.path}`);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, op.lines.join("\n"), "utf8");
        summary.push(`新增 ${op.path}（${op.lines.length} 行）`);
      } else if (op.kind === "delete") {
        if (!(await exists(abs))) throw new ToolError(`Delete File 目标不存在: ${op.path}`);
        await fs.rm(abs, { force: true });
        summary.push(`删除 ${op.path}`);
      } else {
        let content: string;
        try {
          content = await fs.readFile(abs, "utf8");
        } catch {
          throw new ToolError(`Update File 目标不存在或不可读: ${op.path}`);
        }
        const updated = applyHunks(content, op.hunks);
        await fs.writeFile(abs, updated, "utf8");
        summary.push(`修改 ${op.path}（${op.hunks.length} 处）`);
      }
    }
    return `已应用补丁：\n${summary.join("\n")}`;
  },
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
