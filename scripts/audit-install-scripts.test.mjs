import assert from "node:assert/strict";
import { test } from "node:test";
import { auditInstallScripts } from "./audit-install-scripts.mjs";

const safeLock = {
  packages: {
    "node_modules/native": {
      version: "1.2.3",
      resolved: "https://registry.npmjs.org/native/-/native-1.2.3.tgz",
      integrity: "sha512-QUJDRA==",
      hasInstallScript: true,
    },
  },
};

test("install-script audit accepts an exact, integrity-pinned allowlist", () => {
  assert.deepEqual(auditInstallScripts({ allowScripts: { "native@1.2.3": true } }, safeLock), [
    "native@1.2.3",
  ]);
});

test("install-script audit fails closed for new or stale lifecycle packages", () => {
  assert.throws(() => auditInstallScripts({ allowScripts: {} }, safeLock), /unapproved/);
  assert.throws(
    () =>
      auditInstallScripts(
        { allowScripts: { "native@1.2.3": true, "removed@1.0.0": true } },
        safeLock,
      ),
    /stale/,
  );
});

test("install-script audit rejects non-registry or non-integrity artifacts", () => {
  const unsafe = structuredClone(safeLock);
  unsafe.packages["node_modules/native"].resolved = "https://example.test/native.tgz";
  unsafe.packages["node_modules/native"].integrity = "sha1-nope";
  assert.throws(
    () => auditInstallScripts({ allowScripts: { "native@1.2.3": true } }, unsafe),
    /not pinned.*\n.*SHA-512/s,
  );
});
