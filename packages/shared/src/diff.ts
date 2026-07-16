/**
 * 极简行级 diff（LCS）——用于把文件改动渲染成红绿行。纯函数，前端无关。
 */

export interface DiffLine {
  t: "add" | "del" | "ctx";
  text: string;
}

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.length ? oldText.split("\n") : [];
  const b = newText.length ? newText.split("\n") : [];

  // LCS 长度表。
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ t: "ctx", text: a[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ t: "del", text: a[i]! });
      i++;
    } else {
      out.push({ t: "add", text: b[j]! });
      j++;
    }
  }
  while (i < m) out.push({ t: "del", text: a[i++]! });
  while (j < n) out.push({ t: "add", text: b[j++]! });
  return out;
}

/** diff 统计：新增/删除行数。 */
export function diffStat(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.t === "add") added++;
    else if (l.t === "del") removed++;
  }
  return { added, removed };
}
