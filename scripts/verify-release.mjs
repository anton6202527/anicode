#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) throw new Error(`Cannot determine ${label} version from ${JSON.stringify(value)}`);
  return match.slice(1).map(Number);
}

function versionAtLeast(version, minimum) {
  for (let index = 0; index < minimum.length; index++) {
    if (version[index] !== minimum[index]) return version[index] > minimum[index];
  }
  return true;
}

function assertReleaseToolchain() {
  const node = parseVersion(process.versions.node, "Node.js");
  const supportedNode = (node[0] === 22 && versionAtLeast(node, [22, 15, 0])) || node[0] === 24;
  if (!supportedNode) {
    throw new Error(
      `Release gate requires Node.js 22.15+ or 24.x; current version is ${process.versions.node}`,
    );
  }

  const userAgentVersion = /(?:^|\s)npm\/(\d+\.\d+\.\d+)/.exec(
    process.env.npm_config_user_agent ?? "",
  )?.[1];
  const npmProbe = userAgentVersion
    ? undefined
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["--version"], {
        encoding: "utf8",
        windowsHide: true,
      });
  if (npmProbe && (npmProbe.error || npmProbe.status !== 0 || !npmProbe.stdout.trim())) {
    throw new Error("Release gate requires npm >=11.5.1 <12, but npm could not be executed", {
      cause: npmProbe?.error,
    });
  }
  const npmVersion = userAgentVersion ?? npmProbe.stdout;
  const npm = parseVersion(npmVersion, "npm");
  if (npm[0] !== 11 || !versionAtLeast(npm, [11, 5, 1])) {
    throw new Error(
      `Release gate requires npm >=11.5.1 <12; current version is ${npmVersion.trim()}`,
    );
  }
}

assertReleaseToolchain();

const steps = [
  "format:check",
  "lint",
  "typecheck",
  "codegen:check",
  "test:release-contract",
  "test",
  "audit:production",
  "audit:build",
  "audit:install-scripts",
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
