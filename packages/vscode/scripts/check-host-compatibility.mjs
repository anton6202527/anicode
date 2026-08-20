#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_ESBUILD_TARGET,
  MINIMUM_EXTENSION_HOST_NODE_VERSION,
  MINIMUM_VSCODE_VERSION,
} from "./host-runtime-baseline.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const vscodeDirectory = path.resolve(scriptsDirectory, "..");

// Every builtin reachable from the host bundle must be reviewed against the minimum Extension
// Host. A newly introduced builtin fails closed until its availability is checked and it is added
// here. This is intentionally narrower than the current build machine's builtinModules list.
export const REVIEWED_BASELINE_BUILTINS = new Set([
  "node:assert",
  "node:async_hooks",
  "node:buffer",
  "node:child_process",
  "node:console",
  "node:crypto",
  "node:diagnostics_channel",
  "node:dns",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:http2",
  "node:https",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:perf_hooks",
  "node:process",
  "node:querystring",
  "node:readline",
  "node:sqlite",
  "node:stream",
  "node:string_decoder",
  "node:timers",
  "node:tls",
  "node:url",
  "node:util",
  "node:util/types",
  "node:worker_threads",
  "node:zlib",
]);

// node:sqlite was added in 22.5 but required --experimental-sqlite until 22.13. Extension Hosts
// cannot be assumed to start with that flag, so the unflagged version is the effective floor.
const BUILTIN_RUNTIME_FLOORS = new Map([["node:sqlite", "22.13.0"]]);
const BUILD_RUNTIME_BUILTINS = new Set(
  builtinModules.map((specifier) => specifier.replace(/^node:/, "")),
);

function parseVersion(value, label) {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function requireExact(value, expected, label) {
  if (value !== expected) {
    throw new Error(
      `${label} must be ${JSON.stringify(expected)}, received ${JSON.stringify(value)}`,
    );
  }
}

export function assertHostManifestCompatibility(manifest) {
  requireExact(manifest.engines?.vscode, `^${MINIMUM_VSCODE_VERSION}`, "engines.vscode");
  // Pin API types to the minimum host. A caret range silently installs the newest VS Code API and
  // lets code compile against APIs unavailable on the declared minimum version.
  requireExact(
    manifest.devDependencies?.["@types/vscode"],
    MINIMUM_VSCODE_VERSION,
    "devDependencies[@types/vscode]",
  );
  requireExact(
    manifest.devDependencies?.["@types/node"],
    MINIMUM_EXTENSION_HOST_NODE_VERSION,
    "devDependencies[@types/node]",
  );
}

export function assertHostTargetCompatibility(target = HOST_ESBUILD_TARGET) {
  const match = /^node(\d+)\.(\d+)$/.exec(target);
  if (!match) throw new Error(`Invalid Extension Host esbuild target: ${JSON.stringify(target)}`);
  const targetVersion = [Number(match[1]), Number(match[2]), 0];
  const runtimeVersion = parseVersion(
    MINIMUM_EXTENSION_HOST_NODE_VERSION,
    "minimum Extension Host Node version",
  );
  if (compareVersions(targetVersion, runtimeVersion) > 0) {
    throw new Error(
      `Extension Host target ${target} exceeds the minimum runtime ` +
        MINIMUM_EXTENSION_HOST_NODE_VERSION,
    );
  }
  const expected = `node${runtimeVersion[0]}.${runtimeVersion[1]}`;
  requireExact(target, expected, "Extension Host esbuild target");
}

export function extractNodeBuiltins(bundleSource) {
  const found = new Set(
    [...bundleSource.matchAll(/["'](node:[a-zA-Z0-9_./-]+)["']/g)].map((match) => match[1]),
  );
  // esbuild preserves both `node:fs` and historical bare `require("fs")` forms. Use the build
  // runtime's canonical builtin table to distinguish the latter from external npm packages, then
  // normalize both spellings through the same reviewed minimum-host allowlist.
  for (const match of bundleSource.matchAll(
    /(?:require|import)\(\s*["']([a-zA-Z0-9_./-]+)["']\s*\)/g,
  )) {
    const specifier = match[1];
    if (specifier && BUILD_RUNTIME_BUILTINS.has(specifier)) found.add(`node:${specifier}`);
  }
  return found;
}

export function assertHostBundleCompatibility(
  bundleSource,
  runtimeVersion = MINIMUM_EXTENSION_HOST_NODE_VERSION,
) {
  const parsedRuntime = parseVersion(runtimeVersion, "Extension Host Node version");
  for (const builtin of extractNodeBuiltins(bundleSource)) {
    if (!REVIEWED_BASELINE_BUILTINS.has(builtin)) {
      throw new Error(
        `Extension Host bundle contains unreviewed builtin ${builtin}; verify it against Node ` +
          `${MINIMUM_EXTENSION_HOST_NODE_VERSION} and update the compatibility allowlist`,
      );
    }
    const floor = BUILTIN_RUNTIME_FLOORS.get(builtin);
    if (
      floor &&
      compareVersions(parsedRuntime, parseVersion(floor, `${builtin} runtime floor`)) < 0
    ) {
      throw new Error(
        `${builtin} requires Node >=${floor}; configured runtime is ${runtimeVersion}`,
      );
    }
  }
}

export async function checkHostCompatibility({
  packageFile = path.join(vscodeDirectory, "package.json"),
  bundleFile = path.join(vscodeDirectory, "out", "extension.js"),
} = {}) {
  const [manifestSource, bundleSource] = await Promise.all([
    readFile(packageFile, "utf8"),
    readFile(bundleFile, "utf8"),
  ]);
  assertHostManifestCompatibility(JSON.parse(manifestSource));
  assertHostTargetCompatibility();
  assertHostBundleCompatibility(bundleSource);
  return {
    builtins: [...extractNodeBuiltins(bundleSource)].sort(),
    minimumNode: MINIMUM_EXTENSION_HOST_NODE_VERSION,
    minimumVscode: MINIMUM_VSCODE_VERSION,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkHostCompatibility();
  process.stdout.write(
    `Extension Host compatibility passed: VS Code >=${result.minimumVscode}, ` +
      `Node >=${result.minimumNode}, ${result.builtins.length} reviewed node: builtins\n`,
  );
}
