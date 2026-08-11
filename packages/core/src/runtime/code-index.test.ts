import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { extractSymbols } from "../repomap.js";
import { IncrementalCodeIndex } from "./code-index.js";

test("CodeIndex: 增量复用、引用图与混合排序", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-index-"));
  try {
    await fs.writeFile(path.join(root, "auth.ts"), "export function credentialBroker() {}\n");
    await fs.writeFile(
      path.join(root, "caller.ts"),
      "export function login() { return credentialBroker(); }\n",
    );
    const options = { extractSymbols, indexFile: path.join(root, ".cache", "index.json") };
    const first = new IncrementalCodeIndex(root, options);
    await first.refresh();
    assert.equal(first.stats.parsed, 2);
    const hits = await first.search("credential broker");
    assert.equal(hits[0]?.path, "auth.ts");
    assert.ok(hits.some((hit) => hit.path === "caller.ts" && hit.graph > 0));

    const second = new IncrementalCodeIndex(root, options);
    await second.refresh();
    assert.equal(second.stats.reused, 2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(path.join(root, "caller.ts"), "export function login() { return 2; }\n");
    await second.refresh();
    assert.equal(second.stats.parsed, 1);
    assert.equal(second.stats.reused, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CodeIndex: 内存模式复用未变化文件且不写索引", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-index-memory-"));
  try {
    await fs.writeFile(path.join(root, "main.ts"), "export function main() {}\n");
    const indexFile = path.join(root, ".cache", "must-not-exist.json");
    const index = new IncrementalCodeIndex(root, {
      extractSymbols,
      indexFile,
      persist: false,
    });
    await index.refresh();
    assert.equal(index.stats.parsed, 1);
    await index.refresh();
    assert.equal(index.stats.parsed, 0);
    assert.equal(index.stats.reused, 1);
    await assert.rejects(() => fs.access(indexFile));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
