#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * electron-builder consumes these prefixes as implicit signing/notarization authority. Delete
 * them instead of assigning an empty string: CSC_LINK intentionally treats an empty string as a
 * configured value and can still enter its temporary-Keychain path.
 */
export const UNSIGNED_DESKTOP_ENV_PREFIXES = Object.freeze([
  "CSC_",
  "WIN_CSC_",
  "APPLE_",
  "SNAP_CSC_",
]);

export const UNSIGNED_DESKTOP_ENV_KEYS = Object.freeze([
  "ANICODE_CREDENTIAL_BACKEND",
  "ANICODE_DISABLE_OS_KEYCHAIN",
  "SNAPCRAFT_STORE_CREDENTIALS",
]);

export function unsignedDesktopEnvironment(source = process.env) {
  const environment = { ...source };
  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      UNSIGNED_DESKTOP_ENV_KEYS.includes(normalizedName) ||
      UNSIGNED_DESKTOP_ENV_PREFIXES.some((prefix) => normalizedName.startsWith(prefix))
    ) {
      delete environment[name];
    }
  }
  environment.ANICODE_CREDENTIAL_BACKEND = "memory";
  environment.ANICODE_DISABLE_OS_KEYCHAIN = "1";
  environment.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return Object.freeze(environment);
}

export function unsignedDesktopCommandPlan(directoryOnly = false) {
  return [
    ["exec", "--", "electron-vite", "build"],
    [
      "exec",
      "--",
      "electron-builder",
      ...(directoryOnly ? ["--dir"] : []),
      "--publish",
      "never",
      "-c.forceCodeSigning=false",
      "-c.mac.identity=null",
      "-c.mac.notarize=false",
      "-c.win.signExecutable=false",
    ],
  ];
}

async function executeNpm(args, { cwd, env }) {
  const npmCli = env.npm_execpath;
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd,
      env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`npm ${args.join(" ")} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) throw new Error(`npm ${args.join(" ")} failed with exit code ${exitCode}`);
}

export async function runUnsignedDesktopPackaging({
  directoryOnly = false,
  sourceEnvironment = process.env,
  execute = executeNpm,
} = {}) {
  const env = unsignedDesktopEnvironment(sourceEnvironment);
  for (const args of unsignedDesktopCommandPlan(directoryOnly)) {
    await execute(args, { cwd: appDirectory, env });
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--dir")) {
    throw new Error("Usage: node scripts/package-unsigned.mjs [--dir]");
  }
  await runUnsignedDesktopPackaging({ directoryOnly: args[0] === "--dir" });
}
