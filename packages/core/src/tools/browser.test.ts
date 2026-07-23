/**
 * browser 工具测试：报告渲染（纯函数、离线、双语）与——在本机装了 Chrome 时——一次
 * 真·端到端集成（启动 headless Chrome、导航 data: 页、抓 console 错误、截图）。
 * 集成用例仅在能解析到 Chrome 时运行，否则跳过，保持默认套件在无浏览器环境下可跑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang, clearLangOverride } from "../i18n.js";
import { createBrowserTool, formatReport } from "./browser.js";
import { resolveChromePath, closeAllBrowsers, type NavigateResult } from "../browser/cdp.js";

const base = (over: Partial<NavigateResult> = {}): NavigateResult => ({
  finalUrl: "http://localhost:3000/",
  title: "My App",
  console: [],
  failedRequests: [],
  ...over,
});

test("formatReport: 干净页面给出 ✓ 通过（英文默认）", () => {
  setLang("en");
  try {
    const out = formatReport("http://localhost:3000/", base());
    assert.match(out, /Opened http:\/\/localhost:3000\//);
    assert.match(out, /"My App"/);
    assert.match(out, /✓ Loaded with no console errors/);
  } finally {
    clearLangOverride();
  }
});

test("formatReport: 有 console 错误与失败请求 → ✗ 并逐条列出", () => {
  setLang("en");
  try {
    const out = formatReport(
      "http://localhost:3000/",
      base({
        console: [
          { level: "error", text: "Uncaught TypeError: x is not a function", location: "app.js:12" },
          { level: "warning", text: "deprecated API" },
        ],
        failedRequests: [{ url: "http://localhost:3000/missing.js", error: "404" }],
      }),
    );
    assert.match(out, /✗ 1 console error\(s\), 1 failed request\(s\)/);
    assert.match(out, /✖ Uncaught TypeError: x is not a function {2}\(app\.js:12\)/);
    assert.match(out, /Console warnings \(1\)/);
    assert.match(out, /⚠ deprecated API/);
    assert.match(out, /✖ 404 http:\/\/localhost:3000\/missing\.js/);
  } finally {
    clearLangOverride();
  }
});

test("formatReport: 中文（zh）渲染", () => {
  setLang("zh");
  try {
    const out = formatReport("http://localhost:3000/", base({ title: "", console: [] }));
    assert.match(out, /已打开 http:\/\/localhost:3000\//);
    assert.match(out, /✓ 加载完成，无 console 错误/);
  } finally {
    clearLangOverride();
  }
});

test("formatReport: 选择器与脚本结果并入报告", () => {
  setLang("en");
  try {
    const found = formatReport("http://x/", base(), { selector: "#root", selectorFound: true });
    assert.match(found, /✓ Selector "#root" found/);
    const missing = formatReport("http://x/", base(), { selector: "#root", selectorFound: false });
    assert.match(missing, /✗ Selector "#root" not found/);
    const scripted = formatReport("http://x/", base(), { scriptValue: 42 });
    assert.match(scripted, /Script result: 42/);
    const errored = formatReport("http://x/", base(), { scriptError: "boom" });
    assert.match(errored, /Script error: boom/);
  } finally {
    clearLangOverride();
  }
});

test("browser 工具元数据：只读（自动放行）、必填 url、ruleKey 取 url", () => {
  const tool = createBrowserTool();
  assert.equal(tool.readOnly, true, "只读工具才会被权限引擎自动放行（默认免授权）");
  assert.equal(tool.def.name, "browser");
  assert.deepEqual((tool.def.parameters as any).required, ["url"]);
  assert.equal(tool.ruleKey({ url: "http://localhost:3000" }), "http://localhost:3000");
});

// —— 真·端到端：仅在本机可解析 Chrome 时运行 ——
let chromeAvailable = false;
try {
  resolveChromePath();
  chromeAvailable = true;
} catch {
  chromeAvailable = false;
}

test(
  "browser 工具端到端：headless 打开 data: 页，抓到 console 错误并回传截图",
  { skip: chromeAvailable ? false : "no Chrome/Chromium/Edge on this machine" },
  async () => {
    const tool = createBrowserTool();
    const html =
      "data:text/html," +
      encodeURIComponent(
        '<title>IT Page</title><h1 id="hi">hi</h1><script>console.error("kaboom")</script>',
      );
    const images: { type: string; mediaType: string; data: string }[] = [];
    const ctx = {
      cwd: process.cwd(),
      signal: new AbortController().signal,
      modelSupportsImages: true,
      attachImage: (i: any) => images.push(i),
    };
    setLang("en");
    try {
      const out = await tool.run({ url: html, selector: "#hi", timeoutMs: 10_000 }, ctx as any);
      assert.match(out, /IT Page/, "应抓到页面标题");
      assert.match(out, /kaboom/, "应抓到 console.error");
      assert.match(out, /✓ Selector "#hi" found/, "应等到选择器出现");
      assert.equal(images.length, 1, "应回传一张截图");
      assert.equal(images[0]!.mediaType, "image/png");
      assert.ok(images[0]!.data.length > 100, "截图 base64 应非空");
    } finally {
      clearLangOverride();
      closeAllBrowsers(); // 收尸缓存的浏览器，避免拖住测试进程句柄
    }
  },
);
