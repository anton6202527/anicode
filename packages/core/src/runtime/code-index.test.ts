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
