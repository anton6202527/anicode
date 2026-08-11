/**
 * isolation=worktree：子 agent 在 detached git worktree 中运行；
 * 无改动 → 自动清理；有改动 → 保留并在结论中报告路径。需要本机 git。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTaskTools, TaskRegistry } from "./subagent.js";
import { ToolRegistry, type ToolContext } from "./tools/tool.js";
import type { AgentOptions } from "./agent.js";

const execFileP = promisify(execFile);
const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-wt-test-"));
  const git = (...args: string[]) => execFileP("git", ["-C", dir, ...args]);
  await git("init");
  await git("config", "user.email", "t@t");
  await git("config", "user.name", "t");
  await fs.writeFile(path.join(dir, "a.txt"), "hello");
  await git("add", ".");
  await git("commit", "-m", "init");
  return dir;
}

function ctx(): ToolContext {
  return { cwd: "/x", signal: new AbortController().signal };
}

/** stub 子 agent：send 时执行 act(cwd)，结论固定。makeAgent 捕获 cwd。 */
function makeToolsWithChild(repo: string, act: (cwd: string) => Promise<void>) {
  const seen: { cwd?: string } = {};
  const tools = createTaskTools({
    makeAgent: (opts: AgentOptions) => {
      seen.cwd = opts.cwd;
      const messages: any[] = [];
      return {
        messages,
        totalUsage: { ...zero },
        // eslint-disable-next-line require-yield -- stub 子 agent 不产事件，只留结论
        async *send() {
          await act(opts.cwd);
          messages.push({ role: "assistant", content: [{ type: "text", text: "干完了" }] });
        },
      } as any;
    },
    provider: { name: "p", async *stream() {} },
    model: "m",
    cwd: repo,
    tools: new ToolRegistry(),
    registry: new TaskRegistry(),
    notifyTaskDone: () => {},
  });
  return { tools, seen };
}

test("worktree: 子 agent 跑在独立副本；无改动自动清理", async () => {
  const repo = await makeRepo();
  const { tools, seen } = makeToolsWithChild(repo, async () => {});
  const out = await tools.task.run(
    { description: "活", prompt: "p", isolation: "worktree" },
    ctx(),
  );
  assert.notEqual(seen.cwd, repo, "子 agent cwd 应是 worktree 而非主仓库");
  assert.ok(seen.cwd!.includes("anicode-worktrees"));
  await assert.rejects(() => fs.stat(seen.cwd!), "干净的 worktree 应被移除");
  assert.ok(!out.includes("worktree:"), "干净结束不该报告 worktree 路径");
  const { stdout } = await execFileP("git", ["-C", repo, "worktree", "list"]);
  assert.equal(stdout.trim().split("\n").length, 1, "worktree 登记应被清掉");
  await fs.rm(repo, { recursive: true, force: true });
});

test("worktree: 有改动则保留并在结论中报告路径", async () => {
  const repo = await makeRepo();
  const { tools, seen } = makeToolsWithChild(repo, async (cwd) => {
    await fs.writeFile(path.join(cwd, "new.txt"), "改动");
  });
  const out = await tools.task.run(
    { description: "活", prompt: "p", isolation: "worktree" },
    ctx(),
  );
  assert.match(out, /worktree/, "结论应报告 worktree 保留");
  assert.ok((await fs.stat(seen.cwd!)).isDirectory(), "有改动的 worktree 应保留");
  // 主仓库不受影响
  await assert.rejects(() => fs.stat(path.join(repo, "new.txt")));
  await execFileP("git", ["-C", repo, "worktree", "remove", "--force", seen.cwd!]);
  await fs.rm(repo, { recursive: true, force: true });
});

test("worktree: 非 git 目录报错且不产生记录泄漏", async () => {
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-plain-"));
  const { tools } = makeToolsWithChild(plain, async () => {});
  await assert.rejects(
    () => tools.task.run({ description: "活", prompt: "p", isolation: "worktree" }, ctx()),
    /worktree/,
  );
  await fs.rm(plain, { recursive: true, force: true });
});

test(
  "worktree: 创建副本不会执行仓库 post-checkout hook 或内容 filter",
  {
    skip: process.platform === "win32" ? "the hostile Git hook fixtures are POSIX scripts" : false,
  },
  async () => {
    const repo = await makeRepo();
    const marker = path.join(repo, "post-checkout-executed");
    const filterMarker = path.join(repo, "filter-executed");
    const hook = path.join(repo, ".git", "hooks", "post-checkout");
    await fs.writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    await fs.writeFile(path.join(repo, ".gitattributes"), "a.txt filter=evil\n");
    await execFileP("git", ["-C", repo, "add", ".gitattributes"]);
    await execFileP("git", ["-C", repo, "commit", "-qm", "attributes"]);
    const filter = path.join(repo, "evil-filter.sh");
    await fs.writeFile(filter, `#!/bin/sh\ntouch '${filterMarker}'\n/bin/cat\n`, { mode: 0o755 });
    for (const key of ["clean", "smudge", "process"]) {
      await execFileP("git", ["-C", repo, "config", `filter.evil.${key}`, filter]);
    }
    await execFileP("git", ["-C", repo, "config", "filter.evil.required", "true"]);
    const { tools } = makeToolsWithChild(repo, async () => {});
    try {
      await tools.task.run({ description: "活", prompt: "p", isolation: "worktree" }, ctx());
      await assert.rejects(() => fs.stat(marker));
      await assert.rejects(() => fs.stat(filterMarker));
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  },
);
