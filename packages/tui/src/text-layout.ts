import stringWidth from "string-width";

/**
 * Terminal text is indexed by UTF-16 offsets in React state, but every editing
 * operation must land on an extended grapheme boundary.  This keeps emoji ZWJ
 * sequences, combining marks, flags and Indic conjuncts intact.
 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export interface Grapheme {
  text: string;
  index: number;
  end: number;
  width: number;
}

export function graphemes(text: string): Grapheme[] {
  return [...graphemeSegmenter.segment(text)].map((part) => ({
    text: part.segment,
    index: part.index,
    end: part.index + part.segment.length,
    width: terminalWidth(part.segment),
  }));
}

export function terminalWidth(text: string): number {
  // Modern terminals overwhelmingly render East Asian Ambiguous glyphs (box
  // drawing, arrows) as one cell. Wide CJK and emoji remain two cells.
  return stringWidth(text, { ambiguousIsNarrow: true });
}

/** Clamp an arbitrary UTF-16 offset to the preceding grapheme boundary. */
export function clampGraphemeIndex(text: string, index: number): number {
  const target = Math.max(0, Math.min(index, text.length));
  if (target === text.length) return target;
  let boundary = 0;
  for (const part of graphemeSegmenter.segment(text)) {
    if (part.index > target) break;
    boundary = part.index;
  }
  return boundary;
}

export function previousGraphemeIndex(text: string, index: number): number {
  const target = clampGraphemeIndex(text, index);
  if (target <= 0) return 0;
  let previous = 0;
  for (const part of graphemeSegmenter.segment(text)) {
    if (part.index >= target) break;
    previous = part.index;
  }
  return previous;
}

export function nextGraphemeIndex(text: string, index: number): number {
  const target = Math.max(0, Math.min(index, text.length));
  for (const part of graphemeSegmenter.segment(text)) {
    const end = part.index + part.segment.length;
    if (end > target) return end;
  }
  return text.length;
}

/**
 * Take visible terminal columns [from, to).  A grapheme intersecting a window
 * boundary is represented by spaces so the surrounding layout cannot shift.
 */
export function sliceTerminalColumns(text: string, from: number, to: number): string {
  let column = 0;
  let output = "";
  for (const part of graphemes(text)) {
    const start = column;
    const end = start + part.width;
    column = end;
    if (end <= from || start >= to) continue;
    output +=
      start < from || end > to
        ? " ".repeat(Math.max(0, Math.min(end, to) - Math.max(start, from)))
        : part.text;
  }
  return output;
}

export function truncateTerminalWidth(text: string, max: number, ellipsis = "…"): string {
  if (terminalWidth(text) <= max) return text;
  if (max <= 0) return "";
  const ellipsisWidth = terminalWidth(ellipsis);
  if (ellipsisWidth > max) return "";
  let output = "";
  let width = 0;
  for (const part of graphemes(text)) {
    if (width + part.width > max - ellipsisWidth) break;
    output += part.text;
    width += part.width;
  }
  return output + ellipsis;
}
