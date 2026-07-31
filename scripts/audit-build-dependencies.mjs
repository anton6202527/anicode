import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["audit", "--audit-level=high", "--json"], {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 20 * 1024 * 1024,
});

if (result.error) throw result.error;
if (result.status === 0) {
  process.stdout.write("Build dependency audit passed with no high-severity findings.\n");
  process.exit(0);
}

let report;
try {
  report = JSON.parse(result.stdout);
} catch {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

// CVE-2026-14257 was initially published with a single `5.0.8` patched range. The maintainer
// shipped compatible 1.x/2.x/3.x backports on 2026-07-30, but the advisory range still reports
// those versions as vulnerable. Permit only that exact stale advisory and only the audited
// backport versions; any new advisory or older nested copy still fails closed.
const staleAdvisory = "https://github.com/advisories/GHSA-mh99-v99m-4gvg";
const vulnerabilities = report.vulnerabilities ?? {};
const advisoryURLs = new Set();
const visited = new Set();
function collect(name) {
  if (visited.has(name)) return;
  visited.add(name);
  for (const item of vulnerabilities[name]?.via ?? []) {
    if (typeof item === "string") collect(item);
    else if (typeof item?.url === "string") advisoryURLs.add(item.url);
  }
}
for (const name of Object.keys(vulnerabilities)) collect(name);

const lock = JSON.parse(readFileSync(path.join(root, "package-lock.json"), "utf8"));
const braceNodes = vulnerabilities["brace-expansion"]?.nodes ?? [];
const minimumByMajor = new Map([
  [1, [1, 1, 18]],
  [2, [2, 1, 4]],
  [3, [3, 0, 6]],
  [5, [5, 0, 8]],
]);
function atLeastPatched(version) {
  const actual = String(version).split(".").slice(0, 3).map(Number);
  const minimum = minimumByMajor.get(actual[0]);
  if (!minimum || actual.some((part) => !Number.isInteger(part))) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

const unsafeNodes = braceNodes.filter((node) => !atLeastPatched(lock.packages?.[node]?.version));
const onlyKnownStaleAdvisory =
  advisoryURLs.size === 1 && advisoryURLs.has(staleAdvisory) && braceNodes.length > 0;
if (!onlyKnownStaleAdvisory || unsafeNodes.length > 0) {
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  if (unsafeNodes.length > 0) {
    process.stderr.write(`Unpatched brace-expansion nodes: ${unsafeNodes.join(", ")}\n`);
  }
  process.exit(result.status ?? 1);
}

process.stdout.write(
  `Build dependency audit passed: ignored stale ${staleAdvisory} metadata; all ${braceNodes.length} reported nodes use patched backports.\n`,
);
