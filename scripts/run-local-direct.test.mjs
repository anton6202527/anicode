import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  LOCAL_DIRECT_BASE_URL,
  LOCAL_DIRECT_MODEL,
  REPOSITORY_ROOT,
  localDirectCommand,
  localDirectEnvironment,
  parseLocalDeepSeekKey,
  readLocalDeepSeekKey,
} from "./run-local-direct.mjs";

test("local direct dev reads only the exact DeepSeek key and overrides shell state", () => {
  const key = parseLocalDeepSeekKey(
    "ANICODE_CREDENTIAL_BACKEND=keychain\nDEEPSEEK_API_KEY='file-key'\nOTHER_SECRET=nope\n",
  );
  const env = localDirectEnvironment(
    { DEEPSEEK_API_KEY: "shell-key", ANICODE_CREDENTIAL_BACKEND: "keychain" },
    key,
    "/trusted/repository",
  );
  assert.equal(env.DEEPSEEK_API_KEY, "file-key");
  assert.equal(env.DEEPSEEK_BASE_URL, LOCAL_DIRECT_BASE_URL);
  assert.equal(env.ANICODE_CREDENTIAL_BACKEND, "memory");
  assert.equal(env.ANICODE_DISABLE_OS_KEYCHAIN, "1");
  assert.equal(env.ANICODE_DEV_DIRECT, "1");
  assert.equal(env.ANICODE_DEV_DEFAULT_MODEL, LOCAL_DIRECT_MODEL);
  assert.equal(env.ANICODE_DEV_WORKSPACE, "/trusted/repository");
  assert.equal(env.OTHER_SECRET, undefined);
});

test("local direct dev rejects missing, empty and duplicate DeepSeek keys", () => {
  assert.throws(() => parseLocalDeepSeekKey("OTHER=value\n"), /missing/);
  assert.throws(() => parseLocalDeepSeekKey("DEEPSEEK_API_KEY=\n"), /empty/);
  assert.throws(
    () => parseLocalDeepSeekKey("DEEPSEEK_API_KEY=one\nDEEPSEEK_API_KEY=two\n"),
    /exactly once/,
  );
});

test(
  "local direct dev refuses a symlinked .env",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "anicode-local-direct-"));
    try {
      const target = path.join(directory, "target.env");
      const link = path.join(directory, ".env");
      await writeFile(target, "DEEPSEEK_API_KEY=outside\n");
      await symlink(target, link);
      await assert.rejects(readLocalDeepSeekKey(link));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("local direct commands force direct DeepSeek for TUI and keep Electron in the app root", () => {
  const tui = localDirectCommand("tui", "/repo");
  assert.equal(tui.cwd, "/repo");
  assert.deepEqual(tui.args.slice(3, 5), ["--model", LOCAL_DIRECT_MODEL]);
  const app = localDirectCommand("app", REPOSITORY_ROOT);
  assert.equal(app.cwd, path.join(REPOSITORY_ROOT, "packages/app"));
  assert.equal(path.basename(app.args[0]), "electron-vite.js");
  assert.equal(app.args[1], ".");
  assert.throws(() => localDirectCommand("unknown", REPOSITORY_ROOT), /Usage/);
});
