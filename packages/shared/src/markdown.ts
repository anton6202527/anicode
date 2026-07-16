/**
 * Markdown 解析器 —— 把文本解析成结构化 AST，供各前端各自渲染（React / DOM）。
 * 刻意精简，覆盖聊天最常见语法：围栏代码块、标题、列表、引用、段落，
 * 行内支持 `code` / **bold** / *italic* / [text](url)。不追求完整 CommonMark。
 */

export type Span =
  | { t: "text"; value: string }
  | { t: "code"; value: string }
  | { t: "strong"; children: Span[] }
  | { t: "em"; children: Span[] }
  | { t: "link"; href: string; children: Span[] };

export type MdBlock =
  | { kind: "code"; lang: string; code: string }
  | { kind: "heading"; level: number; spans: Span[] }
  | { kind: "paragraph"; spans: Span[] }
  | { kind: "list"; ordered: boolean; items: Span[][] }
  | { kind: "quote"; spans: Span[] };

export function parseMarkdown(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const lines = text.split("\n");
  let textBuf: string[] = [];
  let inCode = false;
  let lang = "";
  let codeBuf: string[] = [];

  const flushText = () => {
    if (textBuf.length) blocks.push(...parseTextBlocks(textBuf));
    textBuf = [];
  };

  for (const line of lines) {
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      if (inCode) {
        blocks.push({ kind: "code", lang, code: codeBuf.join("\n") });
        inCode = false;
        codeBuf = [];
        lang = "";
      } else {
        flushText();
        inCode = true;
        lang = fence[1]!.trim();
      }
      continue;
    }
    if (inCode) codeBuf.push(line);
    else textBuf.push(line);
  }
  if (inCode) blocks.push({ kind: "code", lang, code: codeBuf.join("\n") });
  flushText();
  return blocks;
}

function parseTextBlocks(lines: string[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: Span[][] } | null = null;

  const flushPara = () => {
    if (para.length) {
      blocks.push({ kind: "paragraph", spans: parseInline(para.join(" ")) });
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "heading", level: heading[1]!.length, spans: parseInline(heading[2]!) });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushPara();
      flushList();
      blocks.push({ kind: "quote", spans: parseInline(quote[1]!) });
      continue;
    }
    const ul = /^[-*+]\s+(.*)$/.exec(line);
    const ol = /^\d+\.\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(parseInline((ul ?? ol)![1]!));
      continue;
    }
    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let rest = text;
  const patterns: { re: RegExp; make: (m: RegExpExecArray) => Span }[] = [
    { re: /`([^`]+)`/, make: (m) => ({ t: "code", value: m[1]! }) },
    { re: /\*\*([^*]+)\*\*/, make: (m) => ({ t: "strong", children: parseInline(m[1]!) }) },
    {
      re: /(?:\*([^*]+)\*|_([^_]+)_)/,
      make: (m) => ({ t: "em", children: parseInline(m[1] ?? m[2] ?? "") }),
    },
    {
      re: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/,
      make: (m) => ({ t: "link", href: m[2]!, children: parseInline(m[1]!) }),
    },
  ];

  while (rest) {
    let best: { index: number; length: number; span: Span } | null = null;
    for (const p of patterns) {
      const m = p.re.exec(rest);
      if (m && (best === null || m.index < best.index)) {
        best = { index: m.index, length: m[0].length, span: p.make(m) };
      }
    }
    if (!best) {
      spans.push({ t: "text", value: rest });
      break;
    }
    if (best.index > 0) spans.push({ t: "text", value: rest.slice(0, best.index) });
    spans.push(best.span);
    rest = rest.slice(best.index + best.length);
  }
  return spans;
}
