/**
 * checkpoint/undo 集成测试：会话在每轮用户输入前记工作区快照，undo 回滚文件改动。
 * 用脚本化 provider（无网络），会话目录为真实 git 仓库，session store 放仓库外避免自污染。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { SessionManager, type SessionEvent } from "./session-manager.js";
import { SessionStore } from "./session.js";
import type { Provider, StreamEvent } from "./types.js";

function plainProvider(): Provider {
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", text: "好的" };
      yield {
        type: "done",
        stopReason: "end_turn",
        message: { role: "assistant", content: [{ type: "text", text: "好的" }] },
        usage: { inputTokens: 5, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

async function gitRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ckpt-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  return dir;
}

test("checkpoint/undo: 记录快照事件并回滚本轮之后的文件改动", async () => {
  const repo = await gitRepo();
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ckpt-store-"));
  try {
    await fs.writeFile(path.join(repo, "f.txt"), "v1\n");
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

    const m = new SessionManager({
      store: new SessionStore(path.join(storeDir, "sessions")),
      resolveProvider: () => ({ provider: plainProvider(), model: "scripted" }),
      checkpoints: true,
      now: () => 1_700_000_000_000,
      rand: () => 0.5,
    });
    const s = await m.createSession({ cwd: repo, model: "scripted" });

    const events: SessionEvent[] = [];
    await m.open(s.id, (ev) => events.push(ev));
    await m.send(s.id, "改一下文件");

    // 本轮应广播一个 checkpoint（工作区在模型动手前 = v1 状态）。
    const ckpt = events.find(
      (e): e is Extract<SessionEvent, { type: "agent" }> =>
        e.type === "agent" && e.event.type === "checkpoint",
    );
    assert.ok(ckpt, "应收到 checkpoint 事件");
    assert.equal(m.listCheckpoints(s.id).length, 1);

    // 模拟「本轮之后」的文件改动：改 f.txt、增 new.txt。
    await fs.writeFile(path.join(repo, "f.txt"), "v2-messed\n");
    await fs.writeFile(path.join(repo, "new.txt"), "created this turn\n");

    const res = await m.undo(s.id);
    assert.ok(res.restored >= 1);
    assert.equal(await fs.readFile(path.join(repo, "f.txt"), "utf8"), "v1\n");
    assert.equal(
      await fs.access(path.join(repo, "new.txt")).then(
        () => true,
        () => false,
      ),
      false,
      "本轮新增文件应被撤销删除",
    );
    // undo 后该快照被消费，列表清空；再 undo 报错。
    assert.equal(m.listCheckpoints(s.id).length, 0);
    await assert.rejects(() => m.undo(s.id), /没有可撤销的快照/);

    const reverted = events.find((e) => e.type === "reverted");
    assert.ok(reverted, "应广播 reverted 事件");

    m.dispose();
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});

test("checkpoint/undo: 未启用 checkpoints 的会话 undo 报错、列表为空", async () => {
  const repo = await gitRepo();
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-ckpt-store-"));
  try {
    const m = new SessionManager({
      store: new SessionStore(path.join(storeDir, "sessions")),
      resolveProvider: () => ({ provider: plainProvider(), model: "scripted" }),
      now: () => 1_700_000_000_000,
      rand: () => 0.5,
    });
    const s = await m.createSession({ cwd: repo, model: "scripted" });
    await m.open(s.id, () => {});
    await m.send(s.id, "hi");
    assert.equal(m.listCheckpoints(s.id).length, 0);
    await assert.rejects(() => m.undo(s.id), /未启用工作区快照/);
    m.dispose();
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});
