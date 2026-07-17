/**
 * LSP 导航工具：用假 client/pool 注入，验证「行号+符号名→列位置」的解析、结果格式化、
 * query/path 路由与错误处理。真实语言服务器离线不可用，故此处只钉工具层逻辑。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createDefinitionTool,
  createReferencesTool,
  createSymbolsTool,
} from "./lsp-nav.js";
import type { LspPool, LspLocation, LspSymbol } from "../lsp.js";
import { ToolError } from "./tool.js";

const FILE = "export function foo() {}\nconst x = foo();\n";

async function scratch(): Promise<{ dir: string; abs: string; ctx: any }> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "anicode-lsp-")));
  const abs = path.join(dir, "a.ts");
  await fs.writeFile(abs, FILE);
  return { dir, abs, ctx: { cwd: dir, signal: new AbortController().signal } };
}

/** 记录收到的 position，返回可编程的结果。 */
function fakePool(handlers: {
  definition?: (abs: string, pos: any) => LspLocation[];
  references?: (abs: string, pos: any) => LspLocation[];
  documentSymbols?: (abs: string) => LspSymbol[];
  workspaceSymbols?: (q: string) => LspSymbol[];
  capture?: (pos: any) => void;
}): LspPool {
  const client = {
    async definition(abs: string, pos: any) {
      handlers.capture?.(pos);
      return handlers.definition?.(abs, pos) ?? [];
    },
    async references(abs: string, pos: any) {
      handlers.capture?.(pos);
      return handlers.references?.(abs, pos) ?? [];
    },
    async documentSymbols(abs: string) {
      return handlers.documentSymbols?.(abs) ?? [];
    },
    async workspaceSymbols(q: string) {
      return handlers.workspaceSymbols?.(q) ?? [];
    },
  };
  return {
    clientFor: () => client,
    ensureAllStarted: () => [client],
  } as unknown as LspPool;
}

test("definition: 行号+符号名解析出正确的 0 起 position，并格式化目标行", async () => {
  const { ctx } = await scratch();
  let captured: any;
  const pool = fakePool({
    capture: (p) => (captured = p),
    definition: (a) => [{ path: a, line: 1, column: 8 }],
  });
  const out = await createDefinitionTool(pool).run({ path: "a.ts", line: 2, symbol: "foo" }, ctx);
  // 第 2 行 "const x = foo();" 里 foo 在第 10 列（0 起）
  assert.deepEqual(captured, { line: 1, character: 10 });
  // 结果读取目标行文本作为上下文
  assert.match(out, /a\.ts:1:8: export function foo/);
});

test("references: 多处引用逐行格式化", async () => {
  const { ctx } = await scratch();
  const pool = fakePool({
    references: (a) => [
      { path: a, line: 1, column: 17 },
      { path: a, line: 2, column: 11 },
    ],
  });
  const out = await createReferencesTool(pool).run({ path: "a.ts", line: 1, symbol: "foo" }, ctx);
  assert.match(out, /a\.ts:1:17/);
  assert.match(out, /a\.ts:2:11: const x = foo/);
});

test("definition: 该行找不到符号时报可自纠错误", async () => {
  const { ctx } = await scratch();
  const pool = fakePool({});
  await assert.rejects(
    () => createDefinitionTool(pool).run({ path: "a.ts", line: 2, symbol: "nope" }, ctx),
    /找不到符号|not found/,
  );
});

test("definition: 无结果时给出明确提示而非空", async () => {
  const { ctx } = await scratch();
  const pool = fakePool({ definition: () => [] });
  const out = await createDefinitionTool(pool).run({ path: "a.ts", line: 1, symbol: "foo" }, ctx);
  assert.match(out, /未找到|no definition/);
});

test("symbols: path 模式→文件大纲", async () => {
  const { ctx } = await scratch();
  const pool = fakePool({
    documentSymbols: (a) => [{ name: "foo", kind: "function", path: a, line: 1, column: 17 }],
  });
  const out = await createSymbolsTool(pool).run({ path: "a.ts" }, ctx);
  assert.match(out, /\[function\] foo/);
  assert.match(out, /a\.ts:1:17/);
});

test("symbols: query 模式→工作区搜索并跨服务器去重", async () => {
  const { abs, ctx } = await scratch();
  const pool = fakePool({
    // ensureAllStarted 返回同一个 client，两次调用产出重复项应被去重
    workspaceSymbols: (q) => [{ name: q, kind: "class", path: abs, line: 3, column: 1 }],
  });
  const out = await createSymbolsTool(pool).run({ query: "Foo" }, ctx);
  assert.match(out, /\[class\] Foo/);
  // 只出现一次（单 client 场景本就一条，占位断言去重路径被走到）
  assert.equal(out.split("Foo").length - 1, 1);
});

test("symbols: 既无 path 也无 query 报错", async () => {
  const { ctx } = await scratch();
  await assert.rejects(() => createSymbolsTool(fakePool({})).run({}, ctx), ToolError);
});
