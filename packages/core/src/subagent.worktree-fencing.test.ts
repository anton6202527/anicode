import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createTaskTools, TaskRegistry, type PersistedTaskRecord } from "./subagent.js";
import { ToolRegistry, type ToolContext } from "./tools/tool.js";
import { MemoryWorkerQueueStore, WorktreeOwnership, type WorktreeLease } from "./runtime/worker.js";
import type { Agent, AgentOptions } from "./agent.js";

const execFileP = promisify(execFile);
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

function context(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

async function createRepoWorktree(prefix: string): Promise<{
  repo: string;
  worktree: string;
  cleanup: () => Promise<void>;
}> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-repo-`));
  const worktreeRoot = path.join(os.tmpdir(), "anicode-worktrees");
  const worktree = path.join(worktreeRoot, `${prefix}-${randomUUID()}`);
  await fs.mkdir(worktreeRoot, { recursive: true });
  await execFileP("git", ["init", repo]);
  await execFileP("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  await execFileP("git", ["-C", repo, "config", "user.name", "Test"]);
  await fs.writeFile(path.join(repo, "README.md"), "root\n");
  await execFileP("git", ["-C", repo, "add", "README.md"]);
  await execFileP("git", ["-C", repo, "commit", "-m", "init"]);
  await execFileP("git", ["-C", repo, "worktree", "add", "--detach", worktree]);
  return {
    repo,
    worktree,
    cleanup: async () => {
      await execFileP("git", ["-C", repo, "worktree", "remove", "--force", worktree]).catch(
        () => undefined,
      );
      await fs.rm(worktree, { recursive: true, force: true });
      await fs.rm(repo, { recursive: true, force: true });
    },
  };
}

test("worktree fencing: 两个 worker 都叫 t1 仍使用唯一 owner，旧 worker 不能并行恢复", async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-worktree-fence-repo-"));
  const worktreeRoot = path.join(os.tmpdir(), "anicode-worktrees");
  const worktree = path.join(worktreeRoot, `wt-fence-${randomUUID()}`);
  await fs.mkdir(worktreeRoot, { recursive: true });
  try {
    await execFileP("git", ["init", repo]);
    await execFileP("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileP("git", ["-C", repo, "config", "user.name", "Test"]);
    await fs.writeFile(path.join(repo, "README.md"), "root\n");
    await execFileP("git", ["-C", repo, "add", "README.md"]);
    await execFileP("git", ["-C", repo, "commit", "-m", "init"]);
    await execFileP("git", ["-C", repo, "worktree", "add", "--detach", worktree]);

    const persisted = (): PersistedTaskRecord => ({
      id: "t1",
      type: "general",
      description: "same local task id",
      status: "done",
      background: false,
      messages: [],
      usage: { ...zero },
      worktree,
      worktreeRemoved: false,
    });
    const ownership = new WorktreeOwnership(new MemoryWorkerQueueStore());
    const registry1 = new TaskRegistry([persisted()]);
    const registry2 = new TaskRegistry([persisted()]);
    let childStarted!: () => void;
    const didStart = new Promise<void>((resolve) => (childStarted = resolve));
    let finishChild!: () => void;
    const childGate = new Promise<void>((resolve) => (finishChild = resolve));
    const messages: unknown[] = [];
    const child = {
      messages,
      totalUsage: { ...zero },
      async *send() {
        childStarted();
        await childGate;
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: "finished" }],
        });
        yield* [];
      },
    } as unknown as Agent;
    let secondAgentBuilds = 0;
    const common = {
      provider: { name: "p", async *stream() {} },
      model: "m",
      cwd: repo,
      tools: new ToolRegistry(),
      worktreeOwnership: ownership,
      notifyTaskDone: () => undefined,
    };
    const first = createTaskTools({
      ...common,
      registry: registry1,
      makeAgent: (_options: AgentOptions) => child,
    });
    const second = createTaskTools({
      ...common,
      registry: registry2,
      makeAgent: (_options: AgentOptions) => {
        secondAgentBuilds++;
        return child;
      },
    });

    const firstRun = first.taskSend!.run({ id: "t1", message: "resume" }, context(repo));
    await didStart;
    const firstRecord = registry1.get("t1")!;
    assert.match(firstRecord.worktreeLeaseOwner!, /^subagent:/);
    assert.ok(Number.isSafeInteger(firstRecord.worktreeFencingToken));

    await assert.rejects(
      second.taskSend!.run({ id: "t1", message: "competing resume" }, context(repo)),
      /owned by subagent:/,
    );
    assert.equal(secondAgentBuilds, 0, "losing worker must fail before constructing/running Agent");
    assert.notEqual(
      registry2.get("t1")?.worktreeLeaseOwner,
      firstRecord.worktreeLeaseOwner,
      "session-local t1 must never be reused as the lease owner",
    );

    finishChild();
    assert.match(await firstRun, /finished/);
    assert.equal(registry1.get("t1")?.worktreeFencingToken, undefined);
  } finally {
    await execFileP("git", ["-C", repo, "worktree", "remove", "--force", worktree]).catch(
      () => undefined,
    );
    await fs.rm(worktree, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("worktree fencing: retained Agent 续话会重获 generation，命令 fence 动态读取新 token", async () => {
  const fixture = await createRepoWorktree("wt-resume-fence");
  try {
    const registry = new TaskRegistry([
      {
        id: "t1",
        type: "general",
        description: "retained dirty task",
        status: "done",
        background: false,
        messages: [],
        usage: { ...zero },
        worktree: fixture.worktree,
        worktreeRemoved: false,
      },
    ]);
    const ownership = new WorktreeOwnership(new MemoryWorkerQueueStore());
    let builtOptions: AgentOptions | undefined;
    let sends = 0;
    const fencedTokens: number[] = [];
    const messages: unknown[] = [];
    const child = {
      messages,
      totalUsage: { ...zero },
      async *send(_prompt: string, signal: AbortSignal) {
        sends++;
        const record = registry.get("t1")!;
        fencedTokens.push(record.worktreeFencingToken!);
        const fence = builtOptions?.internalBeforeToolExecution;
        assert.ok(fence, "worktree child must receive a final command fence");
        await fence({
          toolCallId: `call-${sends}`,
          toolName: "write",
          input: {},
          ruleKey: "write",
          signal,
        });
        await fs.writeFile(path.join(fixture.worktree, `dirty-${sends}.txt`), "dirty\n");
        messages.push({
          role: "assistant",
          content: [{ type: "text", text: `finished ${sends}` }],
        });
        yield* [];
      },
    } as unknown as Agent;
    let builds = 0;
    const taskTools = createTaskTools({
      provider: { name: "p", async *stream() {} },
      model: "m",
      cwd: fixture.repo,
      tools: new ToolRegistry(),
      worktreeOwnership: ownership,
      notifyTaskDone: () => undefined,
      registry,
      makeAgent: (options) => {
        builds++;
        builtOptions = options;
        return child;
      },
    });

    assert.match(
      await taskTools.taskSend!.run({ id: "t1", message: "first" }, context(fixture.repo)),
      /finished 1/,
    );
    assert.equal(registry.get("t1")?.worktreeLeaseOwner, undefined);
    assert.equal(registry.get("t1")?.worktreeFencingToken, undefined);

    assert.match(
      await taskTools.taskSend!.run({ id: "t1", message: "second" }, context(fixture.repo)),
      /finished 2/,
    );
    assert.equal(builds, 1, "resume must retain the Agent instead of rebuilding its context");
    assert.equal(sends, 2);
    assert.equal(fencedTokens.length, 2);
    assert.ok(fencedTokens[1]! > fencedTokens[0]!, "resume must use a fresh generation");
  } finally {
    await fixture.cleanup();
  }
});

test("worktree fencing: lease 被夺取后每命令重验阻止副作用并中止 drive", async () => {
  const fixture = await createRepoWorktree("wt-command-fence");
  let intruderLease: WorktreeLease | undefined;
  const ownership = new WorktreeOwnership(new MemoryWorkerQueueStore());
  try {
    const registry = new TaskRegistry([
      {
        id: "t1",
        type: "general",
        description: "stale command",
        status: "done",
        background: false,
        messages: [],
        usage: { ...zero },
        worktree: fixture.worktree,
        worktreeRemoved: false,
      },
    ]);
    let builtOptions: AgentOptions | undefined;
    let sideEffects = 0;
    const child = {
      messages: [] as unknown[],
      totalUsage: { ...zero },
      async *send(_prompt: string, signal: AbortSignal) {
        const record = registry.get("t1")!;
        await ownership.release(
          record.worktree!,
          record.worktreeLeaseOwner!,
          record.worktreeFencingToken!,
        );
        intruderLease = await ownership.acquire(record.worktree!, "intruder", 5 * 60_000);
        const fence = builtOptions?.internalBeforeToolExecution;
        assert.ok(fence);
        await fence({
          toolCallId: "stale-call",
          toolName: "write",
          input: {},
          ruleKey: "write",
          signal,
        });
        sideEffects++;
        await fs.writeFile(path.join(fixture.worktree, "must-not-exist.txt"), "unsafe\n");
        yield* [];
      },
    } as unknown as Agent;
    const taskTools = createTaskTools({
      provider: { name: "p", async *stream() {} },
      model: "m",
      cwd: fixture.repo,
      tools: new ToolRegistry(),
      worktreeOwnership: ownership,
      notifyTaskDone: () => undefined,
      registry,
      makeAgent: (options) => {
        builtOptions = options;
        return child;
      },
    });

    await taskTools.taskSend!.run({ id: "t1", message: "unsafe" }, context(fixture.repo));
    assert.equal(sideEffects, 0);
    await assert.rejects(fs.stat(path.join(fixture.worktree, "must-not-exist.txt")));
    assert.equal(registry.get("t1")?.status, "stopped");
    assert.match(registry.get("t1")?.error ?? "", /heartbeat|fencing|worktree/i);
  } finally {
    if (intruderLease) {
      await ownership
        .release(intruderLease.worktree, intruderLease.owner, intruderLease.fencingToken)
        .catch(() => undefined);
    }
    await fixture.cleanup();
  }
});
