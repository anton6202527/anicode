/**
 * 把 @anicode/shared 的 Markdown AST 渲染成 DOM（textContent/createElement，无 innerHTML → 无 XSS）。
 * 解析逻辑共享，渲染各前端各自实现。
 */

// 走零依赖子路径，避免把 core 的 Node-only 依赖（Anthropic/OpenAI SDK）打进浏览器 bundle。
import { t } from "@anicode/core/i18n";
import { parseMarkdown, type MdBlock, type Span } from "@anicode/shared";

export function renderMarkdown(container: HTMLElement, text: string): void {
  for (const block of parseMarkdown(text)) container.append(renderBlock(block));
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
