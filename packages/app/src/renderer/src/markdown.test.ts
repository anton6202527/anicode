/**
 * Markdown 渲染测试：用 renderToStaticMarkup 把 <Markdown> 渲成 HTML 断言。
 * 重点覆盖代码块、行内语法、列表，以及「绝不注入原始 HTML」的安全性。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./markdown.js";

function html(text: string): string {
  return renderToStaticMarkup(React.createElement(Markdown, { text }));
}

test("markdown: 围栏代码块渲染为 pre/code 并带语言标签", () => {
  const out = html("前言\n\n```ts\nconst x = 1\n```\n后语");
  assert.match(out, /md-codeblock/);
  assert.match(out, /<pre><code>const x = 1<\/code><\/pre>/);
  assert.match(out, />ts</);
  assert.match(out, /前言/);
  assert.match(out, /后语/);
});

test("markdown: 行内代码 / 粗体 / 链接", () => {
  const out = html("用 `npm test` 跑 **全部** 测试，见 [文档](https://example.com/doc)。");
  assert.match(out, /<code class="md-code">npm test<\/code>/);
  assert.match(out, /<strong>全部<\/strong>/);
  assert.match(out, /<a href="https:\/\/example\.com\/doc"[^>]*>文档<\/a>/);
});

test("markdown: 无序与有序列表", () => {
  const ul = html("- 一\n- 二");
  assert.match(ul, /<ul class="md-ul"><li>一<\/li><li>二<\/li><\/ul>/);
  const ol = html("1. 甲\n2. 乙");
  assert.match(ol, /<ol class="md-ol"><li>甲<\/li><li>乙<\/li><\/ol>/);
});

test("markdown: 标题按层级降级渲染", () => {
  const out = html("# 顶级标题");
  assert.match(out, /<h3 class="md-h">顶级标题<\/h3>/);
});

test("markdown: 绝不注入原始 HTML（防 XSS）", () => {
  const out = html("正常 <script>alert(1)</script> 与 <img src=x onerror=alert(2)>");
  assert.doesNotMatch(out, /<script>/);
  assert.doesNotMatch(out, /<img/);
  // 危险字符被转义为实体。
  assert.match(out, /&lt;script&gt;/);
});
