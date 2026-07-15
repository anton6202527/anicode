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
