/**
 * 把 @anicode/shared 的 Markdown AST 渲染成 React 元素（不用 dangerouslySetInnerHTML，无 XSS）。
 * 解析逻辑共享，渲染在各前端各自实现。
 */

import React, { useState } from "react";
import { t } from "@anicode/core";
import { parseMarkdown, type MdBlock, type Span } from "@anicode/shared";

export function Markdown({ text }: { text: string }) {
  return <>{parseMarkdown(text).map((block, i) => renderBlock(block, i))}</>;
}

function renderBlock(block: MdBlock, key: number): React.ReactNode {
  switch (block.kind) {
    case "code":
      return <CodeBlock key={key} lang={block.lang} code={block.code} />;
    case "heading": {
      const Tag = `h${Math.min(block.level + 2, 6)}` as keyof React.JSX.IntrinsicElements;
      return (
        <Tag key={key} className="md-h">
          {renderSpans(block.spans)}
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p key={key} className="md-p">
          {renderSpans(block.spans)}
        </p>
      );
    case "quote":
      return (
        <blockquote key={key} className="md-quote">
          {renderSpans(block.spans)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((spans, i) => <li key={i}>{renderSpans(spans)}</li>);
      return block.ordered ? (
        <ol key={key} className="md-ol">
          {items}
        </ol>
      ) : (
        <ul key={key} className="md-ul">
          {items}
        </ul>
      );
    }
  }
}

function renderSpans(spans: Span[]): React.ReactNode[] {
  return spans.map((span, i) => renderSpan(span, i));
}

function renderSpan(span: Span, key: number): React.ReactNode {
  switch (span.t) {
    case "text":
      return <React.Fragment key={key}>{span.value}</React.Fragment>;
    case "code":
      return (
        <code key={key} className="md-code">
          {span.value}
        </code>
      );
    case "strong":
      return <strong key={key}>{renderSpans(span.children)}</strong>;
    case "em":
      return <em key={key}>{renderSpans(span.children)}</em>;
    case "link":
      return (
        <a key={key} href={span.href} className="md-link" target="_blank" rel="noreferrer">
          {renderSpans(span.children)}
        </a>
      );
  }
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="md-codeblock">
      <div className="md-codebar">
        <span className="md-lang">{lang || "code"}</span>
        <button className="md-copy" onClick={copy}>
          {copied ? t("Copied", "已复制") : t("Copy", "复制")}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
