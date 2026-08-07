import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  runUnsignedDesktopPackaging,
  unsignedDesktopCommandPlan,
} from "../packages/app/scripts/package-unsigned.mjs";
import { runVsixPackaging, vsixCommandArgs } from "../packages/vscode/scripts/package-vsix.mjs";

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const ciWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const rootPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workspacePackages = await Promise.all(
  (await readdir(new URL("../packages/", import.meta.url), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map(async (entry) =>
      JSON.parse(
        await readFile(new URL(`../packages/${entry.name}/package.json`, import.meta.url), "utf8"),
      ),
    ),
);
const cliPackage = JSON.parse(
  await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"),
);
const nvmrc = (await readFile(new URL("../.nvmrc", import.meta.url), "utf8")).trim();
const kubernetesManifest = await readFile(
  new URL("../deploy/remote-runtime/kubernetes.yaml", import.meta.url),
  "utf8",
);
const isolationVerifier = await readFile(
  new URL("../deploy/remote-runtime/verify-isolation.sh", import.meta.url),
  "utf8",
);
const verifyRelease = await readFile(
  new URL("../scripts/verify-release.mjs", import.meta.url),
  "utf8",
);
const smokeCliPackage = await readFile(
  new URL("../scripts/smoke-cli-package.mjs", import.meta.url),
  "utf8",
);
const refuseLocalPublish = await readFile(
  new URL("../scripts/refuse-local-publish.mjs", import.meta.url),
  "utf8",
);
const workflowSources = await Promise.all(
  (await readdir(new URL("../.github/workflows/", import.meta.url), { withFileTypes: true }))
    .filter(
      (entry) => entry.isFile() && (entry.name.endsWith(".yml") || entry.name.endsWith(".yaml")),
    )
    .map(async (entry) => ({
      name: entry.name,
      source: await readFile(
        new URL(`../.github/workflows/${entry.name}`, import.meta.url),
        "utf8",
      ),
    })),
);

function job(name, nextName) {
  const start = workflow.indexOf(`  ${name}:\n`);
  assert.notEqual(start, -1, `missing ${name} job`);
  const end = nextName ? workflow.indexOf(`  ${nextName}:\n`, start + 1) : workflow.length;
  assert.notEqual(end, -1, `missing ${nextName} job`);
  return workflow.slice(start, end);
}

function inlineRoleRules(document) {
  return [
    ...document.matchAll(
      /  - apiGroups: \[([^\n]*)\]\n    resources: \["([^"]+)"\]\n    verbs: \[([^\n]+)\]/g,
    ),
  ].map(([, apiGroups, resource, verbs]) => ({
    apiGroups,
    resource,
    verbs: [...verbs.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  }));
}

function assertOsKeychainDisabled(command, label) {
  assert.match(command, /(?:^|\s)ANICODE_CREDENTIAL_BACKEND=memory(?:\s|$)/, label);
  assert.match(command, /(?:^|\s)ANICODE_DISABLE_OS_KEYCHAIN=1(?:\s|$)/, label);
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
  const supportedNode = ">=22.15.0";
  assert.equal(nvmrc, "24");
  assert.equal(rootPackage.engines.node, supportedNode);
  assert.equal(cliPackage.engines.node, supportedNode);
  assert.equal(rootPackage.devEngines.runtime.version, supportedNode);
  assert.equal(rootPackage.devEngines.runtime.onFail, "warn");
  assert.equal(rootPackage.devEngines.packageManager.version, ">=10.9.2");
  assert.equal(rootPackage.devEngines.packageManager.onFail, "error");
  assert.match(ciWorkflow, /node: \["22\.15\.0", "24", "current"\]/);
  assert.match(ciWorkflow, /node-version: \$\{\{ matrix\.node \}\}/);
  assert.match(ciWorkflow, /if: matrix\.node == 'current'\n\s+run: npm run smoke:cli/);

  assert.match(rootPackage.scripts["dev:trust"], /trust grant --cwd \./);
  assert.match(rootPackage.scripts["dev:trust:status"], /trust status --cwd \./);
  assert.doesNotMatch(rootPackage.scripts["dev:tui"], /trust|grant/);
  assert.doesNotMatch(rootPackage.scripts["dev:tui:demo"], /trust|grant/);
});

test("tests and every release-gate child fail closed against the OS keychain", () => {
  assertOsKeychainDisabled(rootPackage.scripts.test, "root test must use memory credentials");
  assertOsKeychainDisabled(
    rootPackage.scripts["test:release-contract"],
    "release contract tests must disable the OS keychain",
  );
  assertOsKeychainDisabled(
    rootPackage.scripts["verify:release"],
    "release gate entrypoint must disable the OS keychain",
  );

  const testedWorkspaces = workspacePackages.filter((pkg) => pkg.scripts?.test);
  assert.ok(testedWorkspaces.length >= 6, "expected independently runnable workspace tests");
  for (const pkg of testedWorkspaces) {
    assertOsKeychainDisabled(pkg.scripts.test, `${pkg.name} test must disable the OS keychain`);
  }

  assert.match(
    verifyRelease,
    /ANICODE_CREDENTIAL_BACKEND:\s*"memory"[\s\S]*ANICODE_DISABLE_OS_KEYCHAIN:\s*"1"/,
  );
  assert.ok(
    (verifyRelease.match(/env:\s*releaseEnvironment/g) ?? []).length >= 2,
    "npm version probe and every release step must receive the isolated environment",
  );
  assert.ok(
    (smokeCliPackage.match(/ANICODE_DISABLE_OS_KEYCHAIN:\s*"1"/g) ?? []).length >= 2,
    "CLI smoke subprocesses and PTY subprocesses must hard-disable the OS keychain",
  );
});

test("local desktop packaging sanitizes every build phase and cannot sign or publish", async () => {
  const appPackage = workspacePackages.find((pkg) => pkg.name === "@anicode/app");
  assert.ok(appPackage, "missing @anicode/app package");
  for (const scriptName of ["pack", "dist"]) {
    const command = appPackage.scripts?.[scriptName];
    assert.equal(typeof command, "string", `missing app ${scriptName} script`);
    assertOsKeychainDisabled(command, `app ${scriptName} must disable the business keychain`);
    assert.match(command, /node scripts\/package-unsigned\.mjs/);
    assert.doesNotMatch(command, /&&|\belectron-builder\b|\belectron-vite\b/);
  }

  const hostileEnvironment = {
    PATH: "/test/bin",
    ANICODE_CREDENTIAL_BACKEND: "keychain",
    ANICODE_DISABLE_OS_KEYCHAIN: "0",
    CSC_IDENTITY_AUTO_DISCOVERY: "true",
    CSC_NAME: "Developer ID Application: must-not-be-used",
    CSC_LINK: "must-not-be-used",
    CSC_KEY_PASSWORD: "must-not-be-used",
    CSC_INSTALLER_LINK: "must-not-be-used",
    CSC_INSTALLER_KEY_PASSWORD: "must-not-be-used",
    CSC_KEYCHAIN: "/must-not-be-used.keychain",
    CSC_FOR_PULL_REQUEST: "true",
    CSC_FUTURE_SIGNING_AUTHORITY: "must-not-be-used",
    WIN_CSC_LINK: "must-not-be-used",
    WIN_CSC_KEY_PASSWORD: "must-not-be-used",
    WIN_CSC_FUTURE_SIGNING_AUTHORITY: "must-not-be-used",
    APPLE_ID: "must-not-be-used",
    APPLE_APP_SPECIFIC_PASSWORD: "must-not-be-used",
    APPLE_TEAM_ID: "must-not-be-used",
    APPLE_API_KEY: "/must-not-be-used.p8",
    APPLE_API_KEY_ID: "must-not-be-used",
    APPLE_API_ISSUER: "must-not-be-used",
    APPLE_KEYCHAIN: "/must-not-be-used.keychain",
    APPLE_KEYCHAIN_PROFILE: "must-not-be-used",
    APPLE_FUTURE_NOTARIZATION_AUTHORITY: "must-not-be-used",
    SNAP_CSC_LINK: "must-not-be-used",
    SNAP_CSC_FUTURE_SIGNING_AUTHORITY: "must-not-be-used",
    SNAPCRAFT_STORE_CREDENTIALS: "must-not-be-used",
    csc_link: "must-not-be-used-on-windows",
    Apple_Keychain_Profile: "must-not-be-used-on-windows",
    anicode_credential_backend: "keychain",
    anicode_disable_os_keychain: "0",
  };

  for (const directoryOnly of [false, true]) {
    const invocations = [];
    await runUnsignedDesktopPackaging({
      directoryOnly,
      sourceEnvironment: hostileEnvironment,
      execute: async (args, options) => void invocations.push({ args, ...options }),
    });
    assert.equal(invocations.length, 2, "build and packaging must be separate bounded children");
    assert.deepEqual(
      invocations.map(({ args }) => args),
      unsignedDesktopCommandPlan(directoryOnly),
    );
    assert.strictEqual(invocations[0].env, invocations[1].env);
    assert.ok(Object.isFrozen(invocations[0].env));
    assert.equal(invocations[0].env.PATH, hostileEnvironment.PATH);
    assert.equal(invocations[0].env.ANICODE_CREDENTIAL_BACKEND, "memory");
    assert.equal(invocations[0].env.ANICODE_DISABLE_OS_KEYCHAIN, "1");
    assert.equal(invocations[0].env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
    for (const name of Object.keys(hostileEnvironment)) {
      const normalizedName = name.toUpperCase();
      if (normalizedName === "CSC_IDENTITY_AUTO_DISCOVERY") {
        if (name !== normalizedName) assert.equal(invocations[0].env[name], undefined);
        continue;
      }
      if (["ANICODE_CREDENTIAL_BACKEND", "ANICODE_DISABLE_OS_KEYCHAIN"].includes(normalizedName)) {
        if (name !== normalizedName) assert.equal(invocations[0].env[name], undefined);
        continue;
      }
      if (
        /^(?:CSC_|WIN_CSC_|APPLE_|SNAP_CSC_)/.test(normalizedName) ||
        normalizedName === "SNAPCRAFT_STORE_CREDENTIALS"
      ) {
        assert.equal(invocations[0].env[name], undefined, `${name} must be deleted, not emptied`);
      }
    }

    const builderArgs = invocations[1].args;
    assert.ok(directoryOnly === builderArgs.includes("--dir"));
    assert.deepEqual(builderArgs.slice(builderArgs.indexOf("--publish"), -4), [
      "--publish",
      "never",
    ]);
    assert.ok(builderArgs.includes("-c.forceCodeSigning=false"));
    assert.ok(builderArgs.includes("-c.mac.identity=null"));
    assert.ok(builderArgs.includes("-c.mac.notarize=false"));
    assert.ok(builderArgs.includes("-c.win.signExecutable=false"));
  }
  assert.equal(hostileEnvironment.CSC_LINK, "must-not-be-used", "caller env must not mutate");
});

test("VSIX packaging cannot open keytar or inherit publisher credentials", async () => {
  const vscodePackage = workspacePackages.find((pkg) => pkg.name === "anicode-vscode");
  assert.ok(vscodePackage, "missing VSCode package");
  assertOsKeychainDisabled(
    vscodePackage.scripts.package,
    "VSIX package script must disable the business keychain",
  );
  assert.match(vscodePackage.scripts.package, /node scripts\/package-vsix\.mjs/);
  assert.match(workflow, /Package VSCode extension[\s\S]*?VSCE_STORE: file/);

  const hostileEnvironment = {
    PATH: "/test/bin",
    HOME: "/real/home",
    USERPROFILE: "C:\\real-home",
    VSCE_STORE: "keytar",
    VSCE_PAT: "must-not-be-used",
    GITHUB_TOKEN: "must-not-be-used",
    NODE_AUTH_TOKEN: "must-not-be-used",
    OPENAI_API_KEY: "must-not-be-used",
    DATABASE_URL: "must-not-be-used",
    NODE_OPTIONS: "--require must-not-be-used",
    anicode_disable_os_keychain: "0",
  };
  const invocations = [];
  await runVsixPackaging({
    args: ["--target", "darwin-arm64", "-o", "custom.vsix"],
    sourceEnvironment: hostileEnvironment,
    execute: async (args, options) => void invocations.push({ args, ...options }),
  });
  assert.equal(invocations.length, 1);
  const invocation = invocations[0];
  assert.deepEqual(
    invocation.args,
    vsixCommandArgs(["--target", "darwin-arm64", "-o", "custom.vsix"]),
  );
  assert.equal(invocation.env.PATH, hostileEnvironment.PATH);
  assert.notEqual(invocation.env.HOME, hostileEnvironment.HOME);
  assert.equal(invocation.env.HOME, invocation.env.USERPROFILE);
  assert.equal(invocation.env.VSCE_STORE, "file");
  assert.equal(invocation.env.ANICODE_CREDENTIAL_BACKEND, "memory");
  assert.equal(invocation.env.ANICODE_DISABLE_OS_KEYCHAIN, "1");
  for (const name of [
    "VSCE_PAT",
    "GITHUB_TOKEN",
    "NODE_AUTH_TOKEN",
    "OPENAI_API_KEY",
    "DATABASE_URL",
    "NODE_OPTIONS",
    "anicode_disable_os_keychain",
  ]) {
    assert.equal(invocation.env[name], undefined, `${name} must not reach vsce`);
  }
  assert.equal(hostileEnvironment.VSCE_PAT, "must-not-be-used", "caller env must not mutate");
});

test("ad-hoc workflow tests explicitly disable every OS credential-store path", () => {
  const adHocTestSteps = workflowSources.flatMap(({ name, source }) =>
    source
      .split(/(?=^      - )/m)
      .filter(
        (step) => /^\s*(?:- name:[^\n]*\n)?[\s\S]*?\brun:/m.test(step) && /--test\b/.test(step),
      )
      .map((step) => ({ name, step })),
  );
  assert.ok(adHocTestSteps.length > 0, "expected the real-eval catalog test to be audited");
  for (const { name, step } of adHocTestSteps) {
    assert.match(step, /ANICODE_CREDENTIAL_BACKEND:\s*memory/, `${name} ad-hoc test backend`);
    assert.match(step, /ANICODE_DISABLE_OS_KEYCHAIN:\s*"1"/, `${name} ad-hoc test guard`);
  }
});

test("Kubernetes controller RBAC exactly covers the two-phase Job and scoped Secret protocol", () => {
  const controllerRole = kubernetesManifest
    .split(/^---\s*$/m)
    .find(
      (document) =>
        /^kind: Role$/m.test(document) && /^  name: anicode-job-controller$/m.test(document),
    );
  assert.ok(controllerRole, "missing anicode-job-controller Role");
  const rules = inlineRoleRules(controllerRole);
  const jobs = rules.filter((rule) => rule.resource === "jobs");
  const secrets = rules.filter((rule) => rule.resource === "secrets");
  assert.equal(jobs.length, 1, "jobs must have one auditable RBAC rule");
  assert.deepEqual(jobs[0].verbs, ["create", "get", "list", "watch", "delete", "patch"]);
  assert.equal(secrets.length, 1, "secrets must have one auditable RBAC rule");
  assert.equal(secrets[0].apiGroups.trim(), '""');
  assert.deepEqual(secrets[0].verbs, ["create", "get", "delete"]);

  assert.match(isolationVerifier, /require_controller_permission "\$verb" jobs\.batch/);
  assert.match(isolationVerifier, /require_controller_permission "\$verb" secrets/);
  assert.match(isolationVerifier, /deny_controller_permission "\$verb" secrets/);
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

test("local npm publish entrypoints fail closed in favor of the OIDC artifact path", () => {
  assert.equal(rootPackage.scripts.release, "node scripts/refuse-local-publish.mjs");
  assert.equal(cliPackage.scripts.prepublishOnly, "node ../../scripts/refuse-local-publish.mjs");
  assert.doesNotMatch(rootPackage.scripts.release, /changeset publish|npm publish/);
  assert.match(refuseLocalPublish, /Direct local npm publishing is disabled/);
  assert.match(refuseLocalPublish, /process\.exitCode = 1/);
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
  assert.match(signingStep, /ANICODE_CREDENTIAL_BACKEND: memory/);
  assert.match(signingStep, /ANICODE_DISABLE_OS_KEYCHAIN: "1"/);
  assert.match(signingStep, /CSC_IDENTITY_AUTO_DISCOVERY: "true"/);
  assert.match(signingStep, /trap 'rm -f/);
  assert.match(signingStep, /npm exec .* electron-builder/);
  assert.doesNotMatch(signingStep, /npm run/);
  const unsignedStep = desktop.slice(
    desktop.indexOf("- name: Build unsigned"),
    desktop.indexOf("- name: Generate desktop checksums"),
  );
  assert.match(unsignedStep, /ANICODE_DISABLE_OS_KEYCHAIN: "1"/);
  assert.match(unsignedStep, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
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
