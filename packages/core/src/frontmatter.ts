/**
 * Markdown frontmatter 的 YAML 子集解析 —— skills（SKILL.md）与文件系统 agents
 * （.claude/agents/*.md）共用。
 *
 * 此前 skills 的 frontmatter 只认顶层 `key: value` 单行，导致 Claude Code 生态里
 * 常见的写法被静默丢弃：多行 description（`|` / `>` 块标量）、allowed-tools 列表、
 * metadata 嵌套 map。这里实现一个够用的 YAML 子集（零依赖，不是完整 YAML）：
 *
 *   - 标量：`key: value`，可带单/双引号；`true/false` 与数字保持字符串原样返回
 *     （调用方按需转换 —— frontmatter 的消费场景几乎都是字符串）
 *   - 块标量：`key: |` / `key: >`（含 `|-` `>-` 变体），后续更深缩进行为正文；
 *     `|` 保留换行，`>` 折叠为空格（段落间空行保留为换行）
 *   - 列表：行内 `key: [a, b]`，或块式后续 `- item` 行
 *   - 嵌套 map：`key:` 后跟更深缩进的 `sub: value` 行（可递归）
 *   - `#` 整行注释与空行跳过
 *
 * 超出子集的行不抛错，按字符串标量兜底 —— frontmatter 手写占多数，解析器
 * 宁可宽松也不能让一个技能因格式小瑕疵整个消失。
 */

export type FrontmatterValue = string | FrontmatterValue[] | { [key: string]: FrontmatterValue };

/** 提取 `--- … ---` 包裹的 frontmatter 块（无则 null）。 */
export function frontmatterBlock(text: string): string | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  return m ? m[1]! : null;
}

/** 去掉 frontmatter，返回正文。 */
export function stripFrontmatter(text: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.exec(text);
  return m ? text.slice(m[0].length) : text;
}

/** 解析 frontmatter 块为嵌套结构。传入 markdown 全文亦可（自动提取块）。 */
export function parseFrontmatter(text: string): Record<string, FrontmatterValue> {
  const block = text.startsWith("---") ? frontmatterBlock(text) : text;
  if (!block) return {};
  const lines = block.split(/\r?\n/);
  const { value } = parseMap(lines, 0, 0);
  return value;
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && line[i] === " ") i++;
  return i;
}

function isBlank(line: string): boolean {
  const s = line.trim();
  return s === "" || s.startsWith("#");
}

function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\(["\\nrt])/g, unescapeChar) : inner.replace(/''/g, "'");
  }
  // 去掉行尾注释：仅当 # 前有空白（`a#b` 是合法标量）
  const hash = / #.*$/.exec(s);
  return hash ? s.slice(0, hash.index).trim() : s;
}

function unescapeChar(_: string, c: string): string {
  return c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c;
}

/** 行内列表：[a, "b, c"] → 元素数组；容忍简单引号包裹。 */
function parseInlineList(s: string): string[] {
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() || out.length > 0) out.push(cur.trim());
  return out.filter((x) => x !== "");
}

/** 从 start 解析缩进 ≥ minIndent 的 map，返回值与消费到的下一行号。 */
function parseMap(
  lines: string[],
  start: number,
  minIndent: number,
): { value: Record<string, FrontmatterValue>; next: number } {
  const out: Record<string, FrontmatterValue> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const indent = indentOf(line);
    if (indent < minIndent) break;
    const m = /^([\w][\w .\-/]*?):(?:\s(.*))?$/.exec(line.trim());
    if (!m) {
      // 超出子集（如列表项出现在 map 层）：跳过该行，宽松不抛
      i++;
      continue;
    }
    const key = m[1]!.trim();
    const rest = (m[2] ?? "").trim();
    i++;
    if (rest === "" || rest === "|" || rest === ">" || /^[|>][+-]?$/.test(rest)) {
      if (rest.startsWith("|") || rest.startsWith(">")) {
        const r = parseBlockScalar(lines, i, indent, rest[0] === ">");
        out[key] = r.value;
        i = r.next;
        continue;
      }
      // 无值：看后续更深缩进是列表、map，还是空串
      const peek = nextContent(lines, i);
      if (peek !== null && indentOf(lines[peek]!) > indent) {
        if (lines[peek]!.trim().startsWith("- ") || lines[peek]!.trim() === "-") {
          const r = parseList(lines, peek, indentOf(lines[peek]!));
          out[key] = r.value;
          i = r.next;
        } else {
          const r = parseMap(lines, peek, indentOf(lines[peek]!));
          out[key] = r.value;
          i = r.next;
        }
      } else {
        out[key] = "";
      }
      continue;
    }
    if (rest.startsWith("[") && rest.endsWith("]")) {
      out[key] = parseInlineList(rest);
      continue;
    }
    out[key] = unquote(rest);
  }
  return { value: out, next: i };
}

function nextContent(lines: string[], from: number): number | null {
  for (let i = from; i < lines.length; i++) {
    if (!isBlank(lines[i]!)) return i;
  }
  return null;
}

function parseList(
  lines: string[],
  start: number,
  itemIndent: number,
): { value: string[]; next: number } {
  const out: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }
    const indent = indentOf(line);
    const trimmed = line.trim();
    if (indent !== itemIndent || !(trimmed.startsWith("- ") || trimmed === "-")) break;
    out.push(unquote(trimmed === "-" ? "" : trimmed.slice(2)));
    i++;
  }
  return { value: out, next: i };
}

/** 块标量：读取比 keyIndent 更深缩进的后续行。fold=true（>）折叠换行为空格。 */
function parseBlockScalar(
  lines: string[],
  start: number,
  keyIndent: number,
  fold: boolean,
): { value: string; next: number } {
  const body: string[] = [];
  let contentIndent = -1;
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      body.push("");
      i++;
      continue;
    }
    const indent = indentOf(line);
    if (indent <= keyIndent) break;
    if (contentIndent < 0) contentIndent = indent;
    body.push(line.slice(Math.min(indent, contentIndent)));
    i++;
  }
  // 去掉尾部空行（对齐 YAML clip 语义的近似）
  while (body.length > 0 && body[body.length - 1] === "") body.pop();
  const value = fold
    ? body
        .map((l) => (l === "" ? "\n" : l))
        .join(" ")
        .replace(/ ?\n ?/g, "\n")
    : body.join("\n");
  return { value, next: i };
}

// ---------- 取值便捷函数（frontmatter 消费方几乎都要「字符串或字符串列表」） ----------

export function fmString(v: FrontmatterValue | undefined): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** 列表或逗号分隔字符串 → string[]。 */
export function fmStringList(v: FrontmatterValue | undefined): string[] | undefined {
  if (Array.isArray(v)) {
    const items = v.filter((x): x is string => typeof x === "string" && x !== "");
    return items.length > 0 ? items : undefined;
  }
  if (typeof v === "string" && v.trim() !== "") {
    const items = v
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}
