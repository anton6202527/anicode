#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function installScriptEntries(lock) {
  return Object.entries(lock.packages ?? {})
    .filter(([, metadata]) => metadata?.hasInstallScript === true)
    .map(([location, metadata]) => {
      const name = location.slice(location.lastIndexOf("node_modules/") + "node_modules/".length);
      return {
        location,
        name,
        version: String(metadata.version ?? ""),
        resolved: String(metadata.resolved ?? ""),
        integrity: String(metadata.integrity ?? ""),
      };
    });
}

export function auditInstallScripts(manifest, lock) {
  const allowed = new Set(
    Object.entries(manifest.allowScripts ?? {})
      .filter(([, enabled]) => enabled === true)
      .map(([specifier]) => specifier),
  );
  const entries = installScriptEntries(lock);
  const observed = new Set(entries.map(({ name, version }) => `${name}@${version}`));
  const failures = [];

  for (const entry of entries) {
    const specifier = `${entry.name}@${entry.version}`;
    if (!allowed.has(specifier)) failures.push(`unapproved install script: ${specifier}`);
    if (!entry.resolved.startsWith("https://registry.npmjs.org/")) {
      failures.push(`${specifier} is not pinned to the npm registry`);
    }
    if (!/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity)) {
      failures.push(`${specifier} has no SHA-512 lockfile integrity`);
    }
  }
  for (const specifier of allowed) {
    if (!observed.has(specifier)) failures.push(`stale allowScripts entry: ${specifier}`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return entries.map(({ name, version }) => `${name}@${version}`).sort();
}

export async function auditRepositoryInstallScripts(root = repositoryRoot) {
  const [manifest, lock] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  return auditInstallScripts(manifest, lock);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const entries = await auditRepositoryInstallScripts();
  process.stdout.write(
    `Approved install-script packages (${entries.length}):\n${entries.join("\n")}\n`,
  );
}
