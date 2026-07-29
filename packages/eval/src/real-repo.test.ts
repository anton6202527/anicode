import { test } from "node:test";
import assert from "node:assert/strict";
import { REAL_REPO_TASKS } from "./tasks/real-repo.generated.js";

test("real eval catalog: 280 个真实 PR 切片，核心语言均衡且无答案泄漏", () => {
  assert.equal(REAL_REPO_TASKS.length, 280);
  assert.equal(new Set(REAL_REPO_TASKS.map((task) => task.id)).size, 280);
  const counts = new Map<string, number>();
  for (const task of REAL_REPO_TASKS) {
    counts.set(task.language, (counts.get(task.language) ?? 0) + 1);
    assert.match(task.repo, /^[\w.-]+\/[\w.-]+$/);
    assert.match(task.baseCommit, /^[0-9a-f]{40}$/);
    assert.ok(task.prompt.length > 10);
    assert.ok(!("patch" in task), "catalog 不得携带 reference patch");
    assert.ok(!("testPatch" in task), "catalog 不得携带 hidden tests");
  }
  assert.equal(counts.get("python"), 40);
  assert.ok((counts.get("go") ?? 0) >= 39);
  assert.ok((counts.get("rust") ?? 0) >= 39);
  assert.ok((counts.get("java") ?? 0) >= 39);
  assert.ok(new Set(REAL_REPO_TASKS.map((task) => task.repo)).size >= 35);
});
