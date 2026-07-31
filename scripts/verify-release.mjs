#!/usr/bin/env node

import { spawn } from "node:child_process";

const steps = [
  "format:check",
  "lint",
  "typecheck",
  "codegen:check",
  "test",
  "audit:production",
  "audit:build",
  "audit:signatures",
  "smoke:cli",
  "build:app",
  "build:vscode",
  "size:check",
];

const npmCli = process.env.npm_execpath;

for (const script of steps) {
  process.stdout.write(`\n==> release gate: npm run ${script}\n`);
  const command = npmCli ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const args = npmCli ? [npmCli, "run", script] : ["run", script];
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`npm run ${script} terminated by ${signal}`));
      else resolve(code ?? 1);
    });
  });
  if (exitCode !== 0) process.exit(exitCode);
}
