import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEnv, gatherEnv, type EnvInfo } from "./env.js";

test("formatEnv 渲染基本环境块", () => {
  const info: EnvInfo = {
    cwd: "/work/proj",
    platform: "darwin",
    osVersion: "Darwin 25.5.0",
    date: "2026-07-15",
    isGitRepo: false,
  };
  const out = formatEnv(info);
  assert.match(out, /<env>/);
  assert.match(out, /工作目录: \/work\/proj/);
  assert.match(out, /今天日期: 2026-07-15/);
  assert.match(out, /是否 git 仓库: 否/);
  assert.doesNotMatch(out, /<git-status>/);
});

test("formatEnv 在 git 仓库下附带分支与状态块", () => {
  const info: EnvInfo = {
    cwd: "/work/proj",
    platform: "linux",
    osVersion: "Linux 6.0",
    date: "2026-07-15",
    isGitRepo: true,
    gitBranch: "main",
    gitStatus: " M src/a.ts",
    recentCommits: "abc feat: x",
  };
  const out = formatEnv(info);
  assert.match(out, /当前分支: main/);
  assert.match(out, /<git-status>/);
  assert.match(out, /工作区改动:/);
  assert.match(out, / M src\/a\.ts/);
  assert.match(out, /最近提交:/);
});

test("formatEnv git 仓库但无改动时标注干净", () => {
  const out = formatEnv({
    cwd: "/w",
    platform: "linux",
    osVersion: "Linux",
    date: "2026-07-15",
    isGitRepo: true,
    gitBranch: "main",
    recentCommits: "abc init",
  });
  assert.match(out, /工作区干净/);
});

test("gatherEnv 对非 git 目录静默降级", async () => {
  const out = await gatherEnv("/", new Date("2026-07-15T00:00:00Z"));
  assert.match(out, /<env>/);
  assert.match(out, /工作目录: \//);
});
