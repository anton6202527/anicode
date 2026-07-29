// 构建两个 bundle：扩展主机（Node/CJS，external vscode）与 webview（浏览器/IIFE）。
// @anicode/core 及其 SDK 依赖一并打进主机 bundle，因此 .vsix 自包含。
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

const host = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "out/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  // VSIX is built per target platform. Copy the installed N-API artifacts next to the host
  // bundle and let esbuild rewrite the generated binding loader to those concrete files.
  loader: { ".node": "file" },
  assetNames: "native/[name]-[hash]",
};

const webview = {
  ...shared,
  entryPoints: ["src/webview/main.ts"],
  outfile: "out/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
};

if (watch) {
  const ctxHost = await esbuild.context(host);
  const ctxView = await esbuild.context(webview);
  await Promise.all([ctxHost.watch(), ctxView.watch()]);
  console.log("watching…");
} else {
  await Promise.all([esbuild.build(host), esbuild.build(webview)]);
}
