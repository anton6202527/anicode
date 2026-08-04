import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const cliPackage = JSON.parse(
  await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
);
const nvmrc = (await readFile(new URL("../.nvmrc", import.meta.url), "utf8")).trim();

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextName} job`);
  return workflow.slice(start, end);
}

test("release installs never execute lifecycle scripts before the reviewed rebuild", () => {
  const installs = [...workflow.matchAll(/run: npm ci([^\n]*)/g)].map((match) => match[1]);
  assert.ok(installs.length >= 5);
  assert.ok(installs.every((args) => args.includes("--ignore-scripts")));
  assert.equal((workflow.match(/run: npm run rebuild:trusted/g) ?? []).length, installs.length - 1);
  const version = job("version-pr", "publish-npm");
  assert.doesNotMatch(version, /rebuild:trusted/);
  assert.match(version, /Install Changesets without lifecycle scripts/);
});

test("developer entrypoints advertise CI-tested Node lines and never auto-grant trust", () => {
  const supportedNode = ">=22.15.0 <23 || >=24.0.0 <25";
  assert.equal(nvmrc, "24");
  assert.equal(rootPackage.engines.node, supportedNode);
  assert.equal(cliPackage.engines.node, supportedNode);
  assert.equal(rootPackage.devEngines.runtime.version, supportedNode);
  assert.equal(rootPackage.devEngines.runtime.onFail, "warn");
  assert.equal(rootPackage.devEngines.packageManager.version, ">=10.9.2 <12");
  assert.equal(rootPackage.devEngines.packageManager.onFail, "error");

  assert.match(rootPackage.scripts["dev:trust"], /trust grant --cwd \./);
  assert.match(rootPackage.scripts["dev:trust:status"], /trust status --cwd \./);
  assert.doesNotMatch(rootPackage.scripts["dev:tui"], /trust|grant/);
  assert.doesNotMatch(rootPackage.scripts["dev:tui:demo"], /trust|grant/);
});

test("npm validation, version PR, and OIDC publication are separate trust domains", () => {
  const validation = job("npm", "version-pr");
  assert.match(validation, /contents: read/);
  assert.doesNotMatch(validation, /id-token: write|contents: write|pull-requests: write/);
  assert.match(validation, /npm run verify:release/);
  assert.match(validation, /npm pack .*--ignore-scripts/);
  assert.match(validation, /actions\/upload-artifact/);

  const version = job("version-pr", "publish-npm");
  assert.match(version, /contents: write/);
  assert.match(version, /pull-requests: write/);
  assert.doesNotMatch(version, /id-token: write/);
  assert.match(version, /commitMode: github-api/);

  const publish = job("publish-npm", "validate-release");
  assert.match(publish, /id-token: write/);
  assert.doesNotMatch(publish, /actions\/checkout|npm ci|npm run|node scripts\//);
  assert.match(publish, /actions\/download-artifact/);
  assert.match(publish, /npm publish .*--provenance --ignore-scripts/);
  assert.match(publish, /expected_files=.*package\/dist\/cli\.js/);
  assert.match(publish, /npm view .*dist\.integrity/);
  assert.match(publish, /already exists with different bytes/);
});

test("every release checkout disables persisted GitHub credentials", () => {
  const checkouts = workflow.split(/uses: actions\/checkout@/).slice(1);
  assert.ok(checkouts.length >= 5);
  for (const checkout of checkouts) {
    assert.match(checkout.slice(0, checkout.indexOf("\n\n")), /persist-credentials: false/);
  }
});

test("tag version mutation happens before the complete release gate", () => {
  const validation = job("validate-release", "vsix");
  assert.ok(validation.indexOf("Set release version before the release gate") > 0);
  assert.ok(
    validation.indexOf("Set release version before the release gate") <
      validation.indexOf("Validate tagged release candidate"),
  );
  assert.match(validation, /ref: \$\{\{ github\.sha \}\}/);
});

test("signing and notarization secrets exist only on the minimal signing step", () => {
  const desktop = job("desktop", "publish-desktop");
  const signing = desktop.indexOf("- name: Build and sign desktop installers");
  assert.ok(signing > 0);
  const prefix = desktop.slice(0, signing);
  assert.doesNotMatch(prefix, /secrets\.|CSC_LINK|APPLE_API_KEY/);
  const signingStep = desktop.slice(signing, desktop.indexOf("- name: Build unsigned", signing));
  assert.match(signingStep, /secrets\.MACOS_CSC_LINK/);
  assert.match(signingStep, /trap 'rm -f/);
  assert.match(signingStep, /npm exec .* electron-builder/);
  assert.doesNotMatch(signingStep, /npm run/);
  assert.doesNotMatch(desktop.slice(0, desktop.indexOf("steps:")), /\n    env:/);
});

test("OIDC publication jobs execute no checkout, dependency, or repository script", () => {
  for (const [name, next] of [
    ["publish-vsix", "desktop"],
    ["publish-desktop", undefined],
  ]) {
    const publish = job(name, next);
    assert.match(publish, /id-token: write/);
    assert.doesNotMatch(publish, /actions\/checkout|actions\/setup-node|npm |node scripts\//);
    assert.match(publish, /actions\/download-artifact/);
    assert.match(publish, /actions\/attest/);
  }
});
