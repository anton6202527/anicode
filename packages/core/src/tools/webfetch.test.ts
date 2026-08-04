import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { createWebFetchTool, webFetchTool, htmlToText } from "./webfetch.js";

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

test("webfetch: rejects declared oversized bodies and cancels without buffering", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull() {
        throw new Error("body must not be read");
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
  );
  const ctx = {
    cwd: "/",
    signal: new AbortController().signal,
    networkProxy: { fetch: async () => response },
  } as any;
  await assert.rejects(webFetchTool.run({ url: "https://example.com/large" }, ctx), /响应体过大/);
  assert.equal(cancelled, true);
});

test("webfetch: enforces the streamed byte ceiling and cancels chunked responses", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const ctx = {
    cwd: "/",
    signal: new AbortController().signal,
    networkProxy: { fetch: async () => response },
  } as any;
  await assert.rejects(webFetchTool.run({ url: "https://example.com/chunked" }, ctx), /响应体过大/);
  assert.equal(cancelled, true);
});

test("webfetch: clamps maxChars and cancels a plain-text stream once enough text arrived", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(120_000)));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "content-type": "text/plain" } },
  );
  const ctx = {
    cwd: "/",
    signal: new AbortController().signal,
    networkProxy: { fetch: async () => response },
  } as any;
  const output = await webFetchTool.run(
    { url: "https://example.com/text", maxChars: Number.POSITIVE_INFINITY },
    ctx,
  );
  assert.equal(output.length, 20_000 + "\n…（内容已截断）".length);
  assert.equal(cancelled, true);
});

test("webfetch: aborts fetch and reports a bounded timeout", async () => {
  const tool = createWebFetchTool({ timeoutMs: 5 });
  let aborted = false;
  const ctx = {
    cwd: "/",
    signal: new AbortController().signal,
    networkProxy: {
      fetch: async (_url: string | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(init.signal?.reason);
            },
            { once: true },
          );
        }),
    },
  } as any;
  await assert.rejects(tool.run({ url: "https://example.com/slow" }, ctx), /timeout after 5ms/);
  assert.equal(aborted, true);
});

test("webfetch: timeout also cancels a stalled response body", async () => {
  const tool = createWebFetchTool({ timeoutMs: 5 });
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        // Intentionally never produces a chunk.
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const ctx = {
    cwd: "/",
    signal: new AbortController().signal,
    networkProxy: { fetch: async () => response },
  } as any;
  await assert.rejects(tool.run({ url: "https://example.com/stalled-body" }, ctx), /timeout/);
  assert.equal(cancelled, true);
});
