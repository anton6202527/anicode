/**
 * 任务矩阵自检（离线、无模型）：守住每个任务的两条不变量——
 *   1. 种子原样跑校验必须失败（任务不「白给」）；
 *   2. 应用 solution 参考解后校验必须通过（任务可解、校验正确）。
 * 缺工具链（python3/go）的任务跳过。新增任务若不满足不变量，这里第一时间报错。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChatMessage, Provider, StreamEvent } from "@anicode/core";
import { BUILTIN_TASKS } from "./tasks/builtin.js";
import { missingRequirements, runTask } from "./runner.js";
import type { EvalTask } from "./task.js";

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }
}

function runVerify(
  dir: string,
  verify: EvalTask["verify"],
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(verify.cmd, verify.args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const cap = (b: Buffer) => {
      if (out.length < 4096) out += b.toString();
    };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("error", (e) => resolve({ code: 127, out: String(e) }));
    child.on("close", (code) => resolve({ code: code ?? 1, out: out.trim() }));
  });
}

async function checkTask(task: EvalTask): Promise<string | null> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `anicode-selftest-${task.id}-`));
  try {
    await writeFiles(dir, task.files);
    const seed = await runVerify(dir, task.verify);
    if (seed.code === 0) return `${task.id}: 种子未经修改就通过了校验（任务白给）`;

    assert.ok(task.solution, `${task.id}: 缺 solution 参考解`);
    await writeFiles(dir, task.solution!);
    const solved = await runVerify(dir, task.verify);
    if (solved.code !== 0) return `${task.id}: 参考解未通过校验：${solved.out.slice(0, 300)}`;
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("任务矩阵规模与元数据", () => {
  assert.ok(BUILTIN_TASKS.length >= 100, `任务应 ≥100，现 ${BUILTIN_TASKS.length}`);
  const ids = new Set(BUILTIN_TASKS.map((t) => t.id));
  assert.equal(ids.size, BUILTIN_TASKS.length, "任务 id 不应重复");
  const langs = new Set(BUILTIN_TASKS.map((t) => t.lang));
  const kinds = new Set(BUILTIN_TASKS.map((t) => t.kind));
  for (const l of ["js", "ts", "py", "go"]) assert.ok(langs.has(l as never), `缺 ${l} 任务`);
  for (const k of ["implement", "fix", "debug", "refactor"])
    assert.ok(kinds.has(k as never), `缺 ${k} 类任务`);
});

test("每个任务：种子必失败、参考解必通过", async () => {
  const runnable = BUILTIN_TASKS.filter((t) => missingRequirements(t).length === 0);
  const skipped = BUILTIN_TASKS.length - runnable.length;
  if (skipped > 0) console.error(`  （缺工具链，跳过 ${skipped} 个任务的自检）`);
  const problems = (await Promise.all(runnable.map(checkTask))).filter(Boolean);
  assert.deepEqual(problems, []);
});

/** 每次 stream() 吐出脚本里的下一条 assistant 消息。 */
function scriptedProvider(scripts: ChatMessage[][]): Provider {
  let turn = 0;
  return {
    name: "scripted",
    async *stream(): AsyncIterable<StreamEvent> {
      const content = scripts[turn++]?.[0]?.content ?? [];
      const hasTool = content.some((p) => p.type === "tool_call");
      yield {
        type: "done",
        stopReason: hasTool ? "tool_use" : "end_turn",
        message: { role: "assistant", content },
        usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };
}

test("防作弊：agent 篡改 verify 脚本不算通过（跑校验前从种子恢复）", async () => {
  const addTask = BUILTIN_TASKS.find((t) => t.id === "implement-add")!;
  const provider = scriptedProvider([
    [
      {
        role: "assistant",
        content: [
          {
            type: "tool_call",
            id: "c1",
            name: "write",
            // 不修 math.mjs，反而把校验脚本改成永远通过——恢复机制应让它失败。
            args: { path: "verify.mjs", content: "console.log('ok');\n" },
          },
        ],
      },
    ],
    [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
  ]);
  const r = await runTask(addTask, { provider, model: "scripted", maxTurns: 5 });
  assert.equal(r.passed, false, "篡改 verify.mjs 不应骗过校验");
});
