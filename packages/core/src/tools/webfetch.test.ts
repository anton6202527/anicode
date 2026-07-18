import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { webFetchTool, htmlToText } from "./webfetch.js";

test("webfetch: htmlToText 去标签/脚本、解实体、压空白", () => {
  const html =
    "<html><head><style>x{}</style></head><body><h1>标题</h1><script>bad()</script><p>正文 &amp; 内容</p></body></html>";
  const text = htmlToText(html);
  assert.match(text, /标题/);
  assert.match(text, /正文 & 内容/);
  assert.doesNotMatch(text, /bad\(\)/);
  assert.doesNotMatch(text, /<[^>]+>/);
});

test("webfetch: 抓取本地 HTTP 服务并转文本、拒绝非 http(s)", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end("<p>hello <b>world</b></p>");
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const ctx = { cwd: "/", signal: new AbortController().signal } as any;
  const out = await webFetchTool.run({ url: `http://127.0.0.1:${port}/` }, ctx);
  assert.match(out, /hello world/);
  await assert.rejects(webFetchTool.run({ url: "file:///etc/hosts" }, ctx), /仅支持 http/);
  server.close();
});

test("webfetch: htmlToText 结构化——标题/链接/列表/代码块/表格", () => {
  const html = [
    "<h2>安装</h2>",
    '<p>见 <a href="https://example.com/docs">文档</a> 与 <a href="#top">回到顶部</a></p>',
    "<ul><li>第一项</li><li>第二项</li></ul>",
    "<pre><code>npm install\n  indented()</code></pre>",
    "<table><tr><th>名称</th><th>值</th></tr><tr><td>a</td><td>1</td></tr></table>",
    "<img alt='示意图' src='x.png'>",
  ].join("\n");
  const text = htmlToText(html);
  assert.match(text, /## 安装/);
  assert.match(text, /\[文档\]\(https:\/\/example\.com\/docs\)/);
  assert.match(text, /回到顶部/); // 锚点链接只留文字
  assert.doesNotMatch(text, /\(#top\)/);
  assert.match(text, /- 第一项\n- 第二项/);
  assert.match(text, /```\nnpm install\n {2}indented\(\)\n```/); // pre 保留缩进
  assert.match(text, /名称 \| 值/);
  assert.match(text, /\[图片: 示意图\]/);
});

test("webfetch: htmlToText 十六进制实体与 noscript/svg 剔除", () => {
  const text = htmlToText("<noscript>启用JS</noscript><svg><path d='x'/></svg><p>&#x4f60;好</p>");
  assert.equal(text, "你好");
  assert.doesNotMatch(text, /启用JS/);
});
