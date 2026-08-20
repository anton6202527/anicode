import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  assertHostBundleCompatibility,
  assertHostManifestCompatibility,
  assertHostTargetCompatibility,
  extractNodeBuiltins,
} from "./check-host-compatibility.mjs";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

test("manifest and emitted syntax are pinned to the minimum Extension Host", () => {
  assert.doesNotThrow(() => assertHostManifestCompatibility(manifest));
  assert.doesNotThrow(() => assertHostTargetCompatibility());

  const stale = structuredClone(manifest);
  stale.engines.vscode = "^1.85.0";
  assert.throws(() => assertHostManifestCompatibility(stale), /engines\.vscode/);

  const floatingTypes = structuredClone(manifest);
  floatingTypes.devDependencies["@types/vscode"] = "^1.101.0";
  assert.throws(() => assertHostManifestCompatibility(floatingTypes), /@types\/vscode/);
});

test("bundle gate reviews every Node builtin and enforces feature floors", () => {
  const source = 'const fs = require("fs"); import("node:sqlite");';
  assert.deepEqual([...extractNodeBuiltins(source)].sort(), ["node:fs", "node:sqlite"]);
  assert.doesNotThrow(() => assertHostBundleCompatibility(source));
  assert.throws(
    () => assertHostBundleCompatibility('require("node:not-reviewed")'),
    /unreviewed builtin/,
  );
  assert.throws(() => assertHostBundleCompatibility(source, "22.12.0"), /requires Node >=22\.13/);
});
