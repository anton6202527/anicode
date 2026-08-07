import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  executeElectronKeychainRequest,
  validElectronKeychainRequest,
} from "./keychain-utility-protocol.js";

test("Electron Keychain utility rejects malformed paths before module loading", () => {
  let loads = 0;
  const load = () => {
    loads++;
    throw new Error("must not load");
  };
  for (const modulePath of ["relative/index.js", path.join(os.tmpdir(), "keyring.node")]) {
    const request = {
      version: 1,
      operation: "get",
      modulePath,
      service: "dev.anicode.test",
      key: "provider-key",
    };
    assert.equal(validElectronKeychainRequest(request), false);
    assert.deepEqual(executeElectronKeychainRequest(request, load), {
      version: 1,
      ok: false,
      code: "invalid_request",
    });
  }
  assert.equal(loads, 0);
});

test("Electron Keychain utility entry has no argv/env/temp/log credential channel", async () => {
  const source = await fs.readFile(path.join(__dirname, "keychain-utility-helper.ts"), "utf8");
  assert.doesNotMatch(source, /console\.|process\.argv|process\.env|writeFile|appendFile|mkdtemp/);
  assert.match(source, /\.parentPort/);
  assert.match(source, /ELECTRON_KEYCHAIN_MAX_MESSAGE_BYTES/);
});

test("Electron package keeps RunAsNode disabled and ships the utility/native boundary", async () => {
  const appRoot = path.resolve(__dirname, "../..");
  const [fuses, buildConfig, packageJson] = await Promise.all([
    fs.readFile(path.join(appRoot, "scripts", "after-pack.mjs"), "utf8"),
    fs.readFile(path.join(appRoot, "electron.vite.config.ts"), "utf8"),
    fs.readFile(path.join(appRoot, "package.json"), "utf8"),
  ]);
  assert.match(fuses, /\[FuseV1Options\.RunAsNode\]: false/);
  assert.match(buildConfig, /"keychain-utility-helper"/);
  assert.match(packageJson, /"asarUnpack"[\s\S]*@napi-rs\/keyring/);
});
