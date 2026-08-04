#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditRepositoryInstallScripts } from "./audit-install-scripts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath;

function runNpm(args) {
  const command = npm ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const commandArgs = npm ? [npm, ...args] : args;
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`npm ${args.join(" ")} terminated by ${signal}`));
      else if (code === 0) resolve();
      else reject(new Error(`npm ${args.join(" ")} failed with exit code ${code ?? 1}`));
    });
  });
}

const approved = await auditRepositoryInstallScripts(root);
await runNpm(["audit", "signatures"]);
// npm ci ran with --ignore-scripts. Only the exact lockfile-reviewed package/version selectors may
// now execute lifecycle scripts; a new hasInstallScript node fails the audit before this command.
await runNpm(["rebuild", "--foreground-scripts", "--ignore-scripts=false", ...approved]);
