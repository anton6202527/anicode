import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { resolveAppStartupPolicy } from "./startup-policy.js";

test("app startup: explicit repository development is direct-only", () => {
  assert.deepEqual(
    resolveAppStartupPolicy({
      isPackaged: false,
      processCwd: path.resolve("packages/app"),
      developmentDirect: true,
      developmentWorkspace: path.resolve("."),
      developmentDefaultModel: " deepseek/deepseek-v4-flash ",
    }),
    {
      cwd: path.resolve("."),
      cloudEnabled: false,
      loadProjectEnv: false,
      defaultModel: "deepseek/deepseek-v4-flash",
    },
  );
});

test("app startup: packaged hosts ignore development-only overrides", () => {
  assert.deepEqual(
    resolveAppStartupPolicy({
      isPackaged: true,
      processCwd: path.resolve("packaged-workspace"),
      developmentDirect: true,
      developmentWorkspace: path.resolve("hostile-development-workspace"),
      developmentDefaultModel: "custom/hostile",
    }),
    {
      cwd: path.resolve("packaged-workspace"),
      cloudEnabled: true,
      loadProjectEnv: true,
    },
  );
});

test("app startup: ordinary unpackaged launches retain existing Cloud behavior", () => {
  assert.deepEqual(
    resolveAppStartupPolicy({
      isPackaged: false,
      processCwd: path.resolve("packages/app"),
      developmentWorkspace: path.resolve("hostile-development-workspace"),
      developmentDefaultModel: "custom/hostile",
    }),
    {
      cwd: path.resolve("packages/app"),
      cloudEnabled: true,
      loadProjectEnv: true,
    },
  );
});

test("app startup: relative direct workspace cannot redirect the host", () => {
  assert.deepEqual(
    resolveAppStartupPolicy({
      isPackaged: false,
      processCwd: path.resolve("packages/app"),
      developmentDirect: true,
      developmentWorkspace: "../relative",
    }),
    {
      cwd: path.resolve("packages/app"),
      cloudEnabled: false,
      loadProjectEnv: false,
    },
  );
});
