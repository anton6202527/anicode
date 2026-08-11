/**
 * 把 @anicode/shared 的 Markdown AST 渲染成 DOM（textContent/createElement，无 innerHTML → 无 XSS）。
 * 解析逻辑共享，渲染各前端各自实现。
 */

// 走零依赖子路径，避免把 core 的 Node-only 依赖（Anthropic/OpenAI SDK）打进浏览器 bundle。
import { t } from "@anicode/core/i18n";
import { parseMarkdown, type MdBlock, type Span } from "@anicode/shared";

export function renderMarkdown(container: HTMLElement, text: string): void {
  container.append(markdownFragment(text));
}

function markdownFragment(text: string): DocumentFragment {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(text)) fragment.append(renderBlock(block));
  return fragment;
}

/**
 * Append-only renderer used while tokens stream. Completed paragraphs/code fences are committed
 * once; only the unfinished tail is parsed and replaced on the next animation frame.
 */
export class StreamingMarkdownRenderer {
  private value = "";
  private scanOffset = 0;
  private committedEnd = 0;
  private inCode = false;
  private tailNodes: Node[] = [];

  constructor(private readonly container: HTMLElement) {}

  render(text: string): void {
    if (text === this.value) return;
    if (!text.startsWith(this.value)) this.reset();
    this.value = text;

    let stableEnd = this.committedEnd;
    while (this.scanOffset < text.length) {
      const newline = text.indexOf("\n", this.scanOffset);
      if (newline < 0) break;
      const lineStart = this.scanOffset;
      const line = text.slice(lineStart, newline);
      this.scanOffset = newline + 1;
      if (/^```/.test(line)) {
        if (this.inCode) {
          this.inCode = false;
          stableEnd = this.scanOffset;
        } else {
          // The block before an opening fence cannot be affected by later fence contents.
          stableEnd = Math.max(stableEnd, lineStart);
          this.inCode = true;
        }
      } else if (!this.inCode && line.trim() === "") {
        stableEnd = this.scanOffset;
      }
    }

    for (const node of this.tailNodes) node.parentNode?.removeChild(node);
    this.tailNodes = [];
    if (stableEnd > this.committedEnd) {
      this.container.append(markdownFragment(text.slice(this.committedEnd, stableEnd)));
      this.committedEnd = stableEnd;
    }
    const tail = markdownFragment(text.slice(this.committedEnd));
    this.tailNodes = Array.from(tail.childNodes);
    this.container.append(tail);
  }

  private reset(): void {
    this.container.replaceChildren();
    this.value = "";
    this.scanOffset = 0;
    this.committedEnd = 0;
    this.inCode = false;
    this.tailNodes = [];
  }
}

function renderBlock(block: MdBlock): Node {
  switch (block.kind) {
    case "code":
      return codeBlock(block.lang, block.code);
    case "heading": {
      const h = document.createElement(`h${Math.min(block.level + 2, 6)}`);
      h.className = "md-h";
      appendSpans(h, block.spans);
      return h;
    }
    case "paragraph": {
      const p = document.createElement("p");
      p.className = "md-p";
      appendSpans(p, block.spans);
      return p;
    }
    case "quote": {
      const q = document.createElement("blockquote");
      q.className = "md-quote";
      appendSpans(q, block.spans);
      return q;
    }
    case "list": {
      const el = document.createElement(block.ordered ? "ol" : "ul");
      el.className = block.ordered ? "md-ol" : "md-ul";
      for (const spans of block.items) {
        const li = document.createElement("li");
        appendSpans(li, spans);
        el.append(li);
      }
      return el;
    }
  }
}

function appendSpans(parent: HTMLElement, spans: Span[]): void {
  for (const span of spans) parent.append(renderSpan(span));
}

function renderSpan(span: Span): Node {
  switch (span.t) {
    case "text":
      return document.createTextNode(span.value);
    case "code": {
      const el = document.createElement("code");
      el.className = "md-code";
      el.textContent = span.value;
      return el;
    }
    case "strong": {
      const el = document.createElement("strong");
      appendSpans(el, span.children);
      return el;
    }
    case "em": {
      const el = document.createElement("em");
      appendSpans(el, span.children);
      return el;
    }
    case "link": {
      const a = document.createElement("a");
      a.className = "md-link";
      a.href = span.href;
      appendSpans(a, span.children);
      return a;
    }
  }
}

function codeBlock(lang: string, code: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "md-codeblock";
  const bar = document.createElement("div");
  bar.className = "md-codebar";
  const label = document.createElement("span");
  label.className = "md-lang";
  label.textContent = lang || "code";
  const copy = document.createElement("button");
  copy.className = "md-copy";
  copy.textContent = t("Copy", "复制");
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(code).then(() => {
      copy.textContent = t("Copied", "已复制");
      setTimeout(() => (copy.textContent = t("Copy", "复制")), 1200);
    });
  });
  bar.append(label, copy);
  const pre = document.createElement("pre");
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  pre.append(codeEl);
  wrap.append(bar, pre);
  return wrap;
}
