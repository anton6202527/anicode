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

test("CodeIndex: broad symbol queries preserve deterministic forward and reverse references", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-index-wide-"));
  try {
    await Promise.all([
      fs.writeFile(path.join(root, "a.ts"), "export function alphaTarget() {}\n"),
      fs.writeFile(
        path.join(root, "b.ts"),
        "export function betaTarget() { return alphaTarget(); }\n",
      ),
      fs.writeFile(
        path.join(root, "c.ts"),
        "export function caller() { alphaTarget(); betaTarget(); }\n",
      ),
      fs.writeFile(path.join(root, "d.ts"), "export const result = alphaTarget();\n"),
    ]);
    const index = new IncrementalCodeIndex(root, {
      extractSymbols,
      indexFile: path.join(root, ".cache", "index.json"),
      persist: false,
    });
    await index.refresh();

    const hits = await index.search("target", 10);
    const byPath = new Map(hits.map((hit) => [hit.path, hit]));
    assert.deepEqual(byPath.get("a.ts")?.references, ["b.ts", "c.ts", "d.ts"]);
    assert.deepEqual(byPath.get("b.ts")?.references, ["a.ts", "c.ts"]);
    assert.ok((byPath.get("a.ts")?.graph ?? 0) > 0);
    assert.ok((byPath.get("c.ts")?.graph ?? 0) > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("CodeIndex: 当前 generation 可无 I/O 渲染，查询无关投影每代只构建一次", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-index-generation-"));
  try {
    const source = path.join(root, "main.ts");
    const index = new IncrementalCodeIndex(root, {
      extractSymbols,
      persist: false,
    });
    assert.equal(index.hasSnapshot(), false);
    assert.equal(await index.renderCurrent("main"), undefined);

    await fs.writeFile(source, "export function firstGeneration() {}\n");
    await index.refresh();
    assert.equal(index.generation, 1);
    assert.match((await index.renderCurrent("first")) ?? "", /firstGeneration/);
    await index.renderCurrent("unrelated second query");
    assert.equal(
      index.stats.projectionBuilds,
      1,
      "query-independent definitions/frequencies should be built once per generation",
    );

    await index.refresh();
    assert.equal(index.generation, 1, "metadata-identical refresh keeps the adopted generation");
    await index.renderCurrent("third query");
    assert.equal(index.stats.projectionBuilds, 1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(source, "export function secondGenerationWithLongerName() {}\n");
    await index.refresh();
    assert.equal(index.generation, 2);
    assert.match((await index.renderCurrent("second")) ?? "", /secondGenerationWithLongerName/);
    assert.equal(index.stats.projectionBuilds, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
