import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { LspClient, LspPool, pickLspServer } from "./lsp.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "testutil", "fake-lsp-server.mjs");
const cfg = {
  command: process.execPath,
  args: [serverPath], // 纯 JS，任意 cwd 可跑（不依赖 tsx 解析）
  extensions: [".ts", ".tsx"],
};

test("LSP: 握手 → didOpen → 收到 publishDiagnostics", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-"));
  const file = path.join(dir, "a.ts");
  await fs.writeFile(file, "const x: number = 1;\nconst y = x;\nbad code here\n");
  const client = LspClient.start(dir, cfg);
  const diags = await client.diagnose(file, 3000);
  assert.equal(diags.length, 1);
  assert.equal(diags[0]!.severity, "error");
  assert.equal(diags[0]!.line, 3); // 0-based 2 → 1-based 3
  assert.equal(diags[0]!.column, 5);
  assert.match(diags[0]!.message, /类型不匹配/);
  client.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("LSP: diagnostics 工具格式化输出；未配置扩展名给出提示", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-"));
  await fs.writeFile(path.join(dir, "a.ts"), "x\n");
  const pool = new LspPool(dir, [cfg]);
  const tool = createDiagnosticsTool(pool);
  const ctx = { cwd: dir, signal: new AbortController().signal } as any;
  const out = await tool.run({ path: "a.ts" }, ctx);
  assert.match(out, /a\.ts:3:5 \[error\] 类型不匹配/);
  const none = await tool.run({ path: "readme.md" }, ctx);
  assert.match(none, /没有为 .md 配置语言服务器/);
  pool.closeAll();
  await fs.rm(dir, { recursive: true, force: true });
});

test("LSP: pickLspServer 按扩展名匹配（大小写不敏感）", () => {
  const s = pickLspServer([cfg], ".TS");
  assert.ok(s);
  assert.equal(pickLspServer([cfg], ".go"), undefined);
});
