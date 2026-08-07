#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vsceCli = require.resolve("@vscode/vsce/vsce");
const vscodeDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGING_SECRET_NAME =
  /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY|COOKIE|DSN)$/i;
const PACKAGING_DENIED_ENV = new Set([
  "DATABASE_URL",
  "NODE_AUTH_TOKEN",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NPM_CONFIG_USERCONFIG",
  "VSCE_PAT",
]);
const PACKAGING_OVERRIDDEN_ENV = new Set([
  "ANICODE_CREDENTIAL_BACKEND",
  "ANICODE_DISABLE_OS_KEYCHAIN",
  "APPDATA",
  "HOME",
  "LOCALAPPDATA",
  "USERPROFILE",
  "VSCE_STORE",
  "XDG_CONFIG_HOME",
]);

/** Build a child-only environment which cannot select keytar or inherit publisher credentials. */
export function vsixPackagingEnvironment(source, isolatedHome) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (
      PACKAGING_DENIED_ENV.has(normalized) ||
      PACKAGING_OVERRIDDEN_ENV.has(normalized) ||
      PACKAGING_SECRET_NAME.test(normalized)
    ) {
      delete environment[name];
    }
  }
  environment.HOME = isolatedHome;
  environment.USERPROFILE = isolatedHome;
  environment.XDG_CONFIG_HOME = path.join(isolatedHome, "config");
  environment.APPDATA = path.join(isolatedHome, "appdata");
  environment.LOCALAPPDATA = path.join(isolatedHome, "local-appdata");
  environment.VSCE_STORE = "file";
  environment.ANICODE_CREDENTIAL_BACKEND = "memory";
  environment.ANICODE_DISABLE_OS_KEYCHAIN = "1";
  return Object.freeze(environment);
}

export function vsixCommandArgs(args = []) {
  const outputConfigured = args.some(
    (arg) => arg === "-o" || arg === "--out" || arg.startsWith("--out="),
  );
  return [
    vsceCli,
    "package",
    ...(args.includes("--no-dependencies") ? [] : ["--no-dependencies"]),
    ...args,
    ...(outputConfigured ? [] : ["-o", "anicode.vsix"]),
  ];
}

async function executeVsce(args, { cwd, env }) {
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`VSIX packaging terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`VSIX packaging failed with exit code ${exitCode}`);
}

export async function runVsixPackaging({
  args = [],
  sourceEnvironment = process.env,
  execute = executeVsce,
} = {}) {
  const isolatedHome = await mkdtemp(path.join(tmpdir(), "anicode-vsix-home-"));
  try {
    await Promise.all(
      ["config", "appdata", "local-appdata"].map((name) =>
        mkdir(path.join(isolatedHome, name), { mode: 0o700 }),
      ),
    );
    const env = vsixPackagingEnvironment(sourceEnvironment, isolatedHome);
    await execute(vsixCommandArgs(args), { cwd: vscodeDirectory, env });
  } finally {
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  await runVsixPackaging({ args: process.argv.slice(2) });
}
