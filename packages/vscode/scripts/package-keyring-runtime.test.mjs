import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  keyringTarget,
  packageKeyringRuntime,
  resolveKeyringRuntimeArtifacts,
} from "./package-keyring-runtime.mjs";

test("keyringTarget rejects unsupported native targets and distinguishes Linux libc", () => {
  assert.equal(keyringTarget("darwin", "arm64"), "darwin-arm64");
  assert.equal(
    keyringTarget("linux", "x64", { header: { glibcVersionRuntime: "2.39" } }),
    "linux-x64-gnu",
  );
  assert.equal(
    keyringTarget("linux", "arm64", { header: {}, sharedObjects: ["/lib/ld-musl-aarch64.so.1"] }),
    "linux-arm64-musl",
  );
  assert.throws(() => keyringTarget("aix", "ppc64"), /Unsupported OS Keychain build target/);
});

test("packageKeyringRuntime copies a minimal current-platform runtime without loading it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-vsix-keyring-"));
  const outputDirectory = path.join(root, "out", "keyring");
  try {
    const artifacts = resolveKeyringRuntimeArtifacts();
    await fs.mkdir(outputDirectory, { recursive: true });
    await fs.writeFile(path.join(outputDirectory, "stale-platform-binding.node"), "stale");
    const result = await packageKeyringRuntime({ outputDirectory, artifacts });
    assert.equal(result.modulePath, path.join(outputDirectory, "index.js"));
    assert.equal(result.bindingPath, path.join(outputDirectory, path.basename(artifacts.binding)));
    assert.deepEqual(
      (await fs.readdir(outputDirectory)).sort(),
      ["LICENSE", "index.js", path.basename(artifacts.binding)].sort(),
    );
    assert.deepEqual(await fs.readFile(result.modulePath), await fs.readFile(artifacts.loader));
    assert.deepEqual(await fs.readFile(result.bindingPath), await fs.readFile(artifacts.binding));
    await assert.rejects(fs.access(path.join(outputDirectory, "stale-platform-binding.node")));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
