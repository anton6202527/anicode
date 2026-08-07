import assert from "node:assert/strict";
import { promises as fs, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  buildBrowserLaunchArguments,
  createPrivateBrowserAutomationProfile,
  isManagedBrowserAutomationProfile,
} from "./cdp.js";

const syntheticProfile = resolve(tmpdir(), "anicode-browser-policy-test");

test("browser launch policy: macOS uses only the disposable mock Keychain", () => {
  const args = buildBrowserLaunchArguments({
    platform: "darwin",
    userDataDir: syntheticProfile,
    extraArgs: ["--proxy-server=http://127.0.0.1:8329"],
  });

  assert.ok(args.includes("--use-mock-keychain"));
  assert.ok(!args.some((argument) => argument.startsWith("--password-store=")));
  assert.ok(
    args.indexOf("--proxy-server=http://127.0.0.1:8329") < args.indexOf("--use-mock-keychain"),
    "authoritative credential isolation must follow extensibility arguments",
  );
  assert.equal(args.at(-1), "about:blank");
});

test("browser launch policy: Linux keeps password storage inside the private profile", () => {
  const args = buildBrowserLaunchArguments({
    platform: "linux",
    userDataDir: syntheticProfile,
  });

  assert.ok(args.includes("--password-store=basic"));
  assert.ok(!args.includes("--use-mock-keychain"));
});

test("browser launch policy: Windows does not receive unsupported POSIX keyring switches", () => {
  const args = buildBrowserLaunchArguments({
    platform: "win32",
    userDataDir: syntheticProfile,
    headless: false,
  });

  assert.ok(!args.includes("--headless=new"));
  assert.ok(!args.includes("--use-mock-keychain"));
  assert.ok(!args.some((argument) => argument.startsWith("--password-store=")));
  assert.ok(args.includes(`--user-data-dir=${syntheticProfile}`));
});

test("browser launch policy: callers cannot redirect or weaken the automation boundary", () => {
  for (const argument of [
    "--password-store=gnome",
    "--profile-directory=Default",
    "--remote-debugging-address=0.0.0.0",
    "--remote-debugging-port=9222",
    "--use-mock-keychain=false",
    "--user-data-dir=/tmp/shared-profile",
  ]) {
    assert.throws(
      () =>
        buildBrowserLaunchArguments({
          platform: "darwin",
          userDataDir: syntheticProfile,
          extraArgs: [argument],
        }),
      /cannot override/,
    );
  }
  assert.throws(
    () =>
      buildBrowserLaunchArguments({
        userDataDir: syntheticProfile,
        extraArgs: ["https://example.com"],
      }),
    /must be Chromium switches/,
  );
  assert.throws(
    () => buildBrowserLaunchArguments({ userDataDir: "relative-profile" }),
    /absolute path/,
  );
});

test("browser automation profile: path is managed, private and disposable without Chrome", async () => {
  const profile = createPrivateBrowserAutomationProfile();
  try {
    assert.equal(isManagedBrowserAutomationProfile(profile), true);
    const stat = statSync(profile.directory);
    assert.equal(stat.isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal(stat.mode & 0o077, 0, "profile must not be accessible by group or other users");
      if (typeof process.getuid === "function") assert.equal(stat.uid, process.getuid());
    }

    assert.equal(
      isManagedBrowserAutomationProfile({
        parent: profile.parent,
        directory: join(profile.directory, "nested"),
      }),
      false,
    );
    assert.equal(
      isManagedBrowserAutomationProfile({
        parent: profile.parent,
        directory: join(profile.parent, "unrelated-profile"),
      }),
      false,
    );
  } finally {
    await fs.rm(profile.directory, { recursive: true, force: true });
  }
});
