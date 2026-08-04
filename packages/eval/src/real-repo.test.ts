import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { REAL_REPO_TASKS } from "./tasks/real-repo.generated.js";
import {
  readCanonicalResolvedReport,
  redactedVerifierEvidence,
  runBoundedCommand,
} from "./real-repo.js";

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

test("real eval: evaluator output is represented by bounded redacted evidence", () => {
  const output = "provider-token=secret-value\nfull evaluator output";
  const evidence = redactedVerifierEvidence(output, false);
  assert.equal(evidence.evaluator, "swebench");
  assert.equal(evidence.category, "failed");
  assert.equal(evidence.outputChars, output.length);
  assert.match(evidence.outputSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(evidence).includes("secret-value"), false);
});

test("real eval: only accepts the exact harness report for the requested run and instance", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-real-report-"));
  const runId = "anicode-instance-1";
  const instanceId = "instance-1";
  const report = path.join(
    root,
    "logs",
    "run_evaluation",
    runId,
    "anicode",
    instanceId,
    "report.json",
  );
  try {
    await fs.mkdir(path.dirname(report), { recursive: true });
    await fs.mkdir(path.join(root, "repo"), { recursive: true });
    await fs.writeFile(path.join(root, "repo", "fake.json"), '{"resolved":true}', "utf8");
    await fs.writeFile(report, JSON.stringify({ [instanceId]: { resolved: false } }), "utf8");
    assert.equal(await readCanonicalResolvedReport(root, runId, instanceId), false);

    await fs.writeFile(report, JSON.stringify({ other: { resolved: true } }), "utf8");
    await assert.rejects(
      () => readCanonicalResolvedReport(root, runId, instanceId),
      /unexpected instance ID/,
    );

    await fs.writeFile(
      report,
      JSON.stringify({ [instanceId]: { resolved: true }, other: { resolved: true } }),
      "utf8",
    );
    await assert.rejects(
      () => readCanonicalResolvedReport(root, runId, instanceId),
      /unexpected instance ID/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real eval: bounded command kills a delayed grandchild before it can write", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-command-tree-"));
  const marker = path.join(root, "late-write.txt");
  const grandchild = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),300)`;
  const parent = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
  try {
    const result = await runBoundedCommand(process.execPath, ["-e", parent], {
      timeoutMs: 25,
      terminationGraceMs: 25,
    });
    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(() => fs.access(marker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("real eval: bounded command abort returns the same explicit timeout status", async () => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20);
  try {
    const result = await runBoundedCommand(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 5_000,
      terminationGraceMs: 25,
      signal: abort.signal,
    });
    assert.equal(result.code, 124);
    assert.equal(result.timedOut, true);
  } finally {
    clearTimeout(timer);
  }
});

test("real eval: successful parent exit reaps a background grandchild", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-command-success-tree-"));
  const marker = path.join(root, "late-write.txt");
  const grandchild = `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'late'),300)`;
  const parent = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});child.unref();`;
  try {
    const result = await runBoundedCommand(process.execPath, ["-e", parent]);
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await assert.rejects(() => fs.access(marker));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
