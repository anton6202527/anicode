import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TypedCodeGraph, extractTreeSitterSymbols } from "./typed-code-graph.js";
import type { LspPool } from "../lsp.js";

test("typed graph: Tree-sitter 多语言符号、跨文件引用、向量混检与增量复用", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-typed-graph-"));
  const graph = new TypedCodeGraph(root, { embeddingDimensions: 64 });
  try {
    await fs.writeFile(path.join(root, "user.ts"), "export class User { name = 'a' }\n");
    await fs.writeFile(
      path.join(root, "main.ts"),
      "import { User } from './user'; export const current = new User();\n",
    );
    await fs.writeFile(
      path.join(root, "main.py"),
      "class Account:\n    pass\n\ndef load_account():\n    return Account()\n",
    );
    await fs.writeFile(
      path.join(root, "main.go"),
      "package main\ntype Server struct{}\nfunc StartServer() {}\n",
    );
    await fs.writeFile(
      path.join(root, "main.rs"),
      "pub struct Engine;\npub fn start_engine() {}\n",
    );
    await fs.writeFile(path.join(root, "Main.java"), "class Main { void startService() {} }\n");
    const snapshot = await graph.refresh();
    assert.equal(snapshot.version, 4);
    assert.equal(Object.keys(snapshot.files).length, 6);
    assert.ok(snapshot.files["main.py"]?.symbols.some((symbol) => symbol.name === "Account"));
    assert.ok(snapshot.files["main.go"]?.symbols.some((symbol) => symbol.name === "StartServer"));
    assert.ok(snapshot.files["main.rs"]?.symbols.some((symbol) => symbol.name === "start_engine"));
    assert.ok(
      snapshot.files["Main.java"]?.symbols.some((symbol) => symbol.name === "startService"),
    );
    const hits = await graph.search("User current account", 4);
    assert.ok(hits.some((hit) => hit.path === "user.ts"));
    assert.ok(hits.some((hit) => hit.relatedPaths.includes("user.ts")));
    assert.ok(hits.find((hit) => hit.path === "user.ts")?.relatedPaths.includes("main.ts"));
    const userReferences = snapshot.files["main.ts"]?.references.filter(
      (reference) => reference.name === "User",
    );
    assert.ok(userReferences?.some((reference) => reference.kind === "import"));
    assert.ok(userReferences?.some((reference) => reference.kind === "call"));
    await graph.refresh();
    assert.equal(graph.stats.reused, 6);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.appendFile(path.join(root, "main.go"), "func StopServer() {}\n");
    await graph.refresh();
    assert.equal(graph.stats.parsed, 1);
    assert.equal(graph.stats.reused, 5);
    assert.ok(
      extractTreeSitterSymbols("x.py", "def hello():\n    pass\n").some(
        (item) => item.name === "hello",
      ),
    );

    const javaFile = path.join(root, "Main.java");
    const originalStat = await fs.stat(javaFile);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(javaFile, "class Main { void otherService() {} }\n");
    await fs.utimes(javaFile, originalStat.atime, originalStat.mtime);
    const afterSameStatEdit = await graph.refresh();
    assert.equal(graph.stats.parsed, 1, "ctime/inode guard catches same-size restored-mtime edits");
    assert.ok(
      afterSameStatEdit.files["Main.java"]?.symbols.some(
        (symbol) => symbol.name === "otherService",
      ),
    );
  } finally {
    await graph.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("typed graph: LSP definition 精确覆盖同名启发式引用边", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-typed-lsp-"));
  const target = path.join(root, "target.ts");
  const caller = path.join(root, "caller.ts");
  await fs.writeFile(target, "export function resolveUser() { return 1; }\n");
  await fs.writeFile(caller, "export const value = resolveUser();\n");
  const client = {
    documentSymbols: async () => [],
    definition: async () => [{ path: target, line: 1, column: 17 }],
  };
  const lspPool = {
    clientFor: () => client,
  } as unknown as LspPool;
  const graph = new TypedCodeGraph(root, { lspPool, embeddingDimensions: 32 });
  try {
    const snapshot = await graph.refresh();
    const reference = snapshot.files["caller.ts"]?.references.find(
      (item) => item.name === "resolveUser",
    );
    const targetSymbol = snapshot.files["target.ts"]?.symbols.find(
      (item) => item.name === "resolveUser",
    );
    assert.equal(reference?.resolution, "lsp");
    assert.deepEqual(reference?.targetSymbolIds, [targetSymbol?.id]);
    assert.ok(graph.stats.lspResolved >= 1);
  } finally {
    await graph.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("typed graph: target 迁移会失效并重建复用 caller 的 LSP 边", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-typed-lsp-invalidate-"));
  const firstTarget = path.join(root, "target.ts");
  const secondTarget = path.join(root, "target-new.ts");
  const caller = path.join(root, "caller.ts");
  await fs.writeFile(firstTarget, "export function resolveUser() { return 1; }\n");
  await fs.writeFile(caller, "export const value = resolveUser();\n");
  let definitionTarget = firstTarget;
  let callerDefinitions = 0;
  const client = {
    documentSymbols: async () => [],
    definition: async (file: string) => {
      if (file === caller) callerDefinitions++;
      return [{ path: definitionTarget, line: 1, column: 17 }];
    },
  };
  const graph = new TypedCodeGraph(root, {
    lspPool: { clientFor: () => client } as unknown as LspPool,
    embeddingDimensions: 32,
  });
  try {
    await graph.refresh();
    assert.ok(callerDefinitions > 0);
    callerDefinitions = 0;
    await fs.rename(firstTarget, secondTarget);
    definitionTarget = secondTarget;
    const snapshot = await graph.refresh();
    const target = snapshot.files["target-new.ts"]?.symbols.find(
      (symbol) => symbol.name === "resolveUser",
    );
    const reference = snapshot.files["caller.ts"]?.references.find(
      (item) => item.name === "resolveUser",
    );
    assert.equal(graph.stats.lspInvalidated, 1);
    assert.ok(callerDefinitions > 0, "cached dependent file was re-queried through LSP");
    assert.equal(reference?.resolution, "lsp");
    assert.deepEqual(reference?.targetSymbolIds, [target?.id]);
  } finally {
    await graph.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
