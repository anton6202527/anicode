import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ShellRegistry, bashOutputTool, killShellTool, shells } from "./shells.js";
import { bashTool } from "./bash.js";
import type { ToolContext } from "./tool.js";

function ctx(cwd: string): ToolContext {
  return { cwd, signal: new AbortController().signal };
}

async function scratch(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** 轮询等待条件成立，避免依赖固定 sleep 造成的偶发失败。 */
async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("ShellRegistry: 启动后台命令并增量读取输出", async () => {
  const dir = await scratch("anicode-shell-start-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "echo hello-bg",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "echo hello-bg"],
  });
  assert.match(id, /^bash_\d+$/);

  // 输出可能分多次到达，循环收敛
  let seen = "";
  await until(() => {
    seen += reg.read(id)?.chunk ?? "";
    return seen.includes("hello-bg");
  });
  assert.match(seen, /hello-bg/);
  reg.killAll();
});

test("ShellRegistry: 读取是增量的——读过的内容不再重复返回", async () => {
  const dir = await scratch("anicode-shell-incr-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "echo one",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "echo one"],
  });
  let first = "";
  await until(() => {
    first += reg.read(id)?.chunk ?? "";
    return first.includes("one");
  });
  // 再读：同样的内容不该重复出现（这正是上下文被吃光的根因）
  const second = reg.read(id)!;
  assert.equal(second.chunk, "", "已读内容不应重复返回");
  reg.killAll();
});

test("ShellRegistry: 退出码与状态被正确记录", async () => {
  const dir = await scratch("anicode-shell-exit-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "exit 3",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "exit 3"],
  });
  await until(() => reg.read(id)!.status === "exited");
  const r = reg.read(id)!;
  assert.equal(r.status, "exited");
  assert.equal(r.exitCode, 3);
  reg.killAll();
});

test("ShellRegistry: kill 能停掉长跑进程并标记 killed", async () => {
  const dir = await scratch("anicode-shell-kill-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "sleep 30",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "sleep 30"],
  });
  assert.equal(reg.read(id)!.status, "running");
  assert.equal(reg.kill(id), true);
  assert.equal(reg.read(id)!.status, "killed");
  assert.equal(reg.kill("bash_nope"), false);
  reg.killAll();
});

test("ShellRegistry: 未知 id 读取返回 null", () => {
  const reg = new ShellRegistry();
  assert.equal(reg.read("bash_missing"), null);
});

test("ShellRegistry: list 反映运行中的 shell", async () => {
  const dir = await scratch("anicode-shell-list-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "sleep 30",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "sleep 30"],
  });
  const list = reg.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]!.id, id);
  assert.equal(list[0]!.command, "sleep 30");
  assert.equal(list[0]!.status, "running");
  reg.killAll();
  assert.equal(reg.list().length, 0, "killAll 后应清空");
});

test("bash run_in_background 立即返回 shell id 而不阻塞", async () => {
  const dir = await scratch("anicode-bash-bg-");
  // sleep 30 若是前台会阻塞到超时；后台应立即返回。
  const started = Date.now();
  const out = await bashTool.run({ command: "sleep 30", run_in_background: true }, ctx(dir));
  assert.ok(Date.now() - started < 3000, "后台启动不应阻塞");
  const m = /bash_\d+/.exec(out);
  assert.ok(m, `返回内容应含 shell id: ${out}`);
  // 通过 kill_shell 工具清理
  const killed = await killShellTool.run({ shell_id: m![0] }, ctx(dir));
  assert.match(killed, /bash_\d+/);
  shells.killAll();
});

test("bash_output 工具读取后台输出并报告状态", async () => {
  const dir = await scratch("anicode-bashoutput-");
  const out = await bashTool.run({ command: "echo from-tool", run_in_background: true }, ctx(dir));
  const id = /bash_\d+/.exec(out)![0];
  let seen = "";
  for (let i = 0; i < 100 && !seen.includes("from-tool"); i++) {
    seen += await bashOutputTool.run({ bash_id: id }, ctx(dir));
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(seen, /from-tool/);
  shells.killAll();
});

test("bash_output 对未知 id 抛出可自纠的错误", async () => {
  const dir = await scratch("anicode-bashoutput-unknown-");
  await assert.rejects(() => bashOutputTool.run({ bash_id: "bash_9999" }, ctx(dir)), /bash_9999/);
});

test("bash_output filter 只保留匹配行", async () => {
  const dir = await scratch("anicode-bashoutput-filter-");
  const out = await bashTool.run(
    { command: "printf 'keep-me\\ndrop-this\\n'", run_in_background: true },
    ctx(dir),
  );
  const id = /bash_\d+/.exec(out)![0];
  // 首行是 "[status] <原命令>" 的状态头，必然含原命令文本；filter 作用于输出正文，
  // 因此只对去掉状态头之后的正文断言。
  let body = "";
  for (let i = 0; i < 100 && !body.includes("keep-me"); i++) {
    const raw = await bashOutputTool.run({ bash_id: id, filter: "keep" }, ctx(dir));
    body += raw.split("\n").slice(1).join("\n");
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(body, /keep-me/);
  assert.doesNotMatch(body, /drop-this/, "filter 应滤掉不匹配的输出行");
  shells.killAll();
});

test("bash_output 非法 filter 正则报错", async () => {
  const dir = await scratch("anicode-bashoutput-badre-");
  const out = await bashTool.run({ command: "echo x", run_in_background: true }, ctx(dir));
  const id = /bash_\d+/.exec(out)![0];
  await assert.rejects(() => bashOutputTool.run({ bash_id: id, filter: "([" }, ctx(dir)), /filter/);
  shells.killAll();
});

test("bash_output 与 kill_shell 是只读工具（可自动放行，不打断清理）", () => {
  assert.equal(bashOutputTool.readOnly, true);
  assert.equal(killShellTool.readOnly, true);
});

// ---------- 回归：容量与数据丢失 ----------

test("回归：已结束的 shell 占满上限后仍能启动新的（不会堵死 5 分钟）", async () => {
  const dir = await scratch("anicode-shell-cap-");
  const reg = new ShellRegistry();
  const ids: string[] = [];
  // 塞满 20 个秒退的 shell
  for (let i = 0; i < 20; i++) {
    ids.push(reg.start({ command: "true", cwd: dir, file: "/bin/bash", args: ["-c", "true"] }));
  }
  await until(() => ids.every((id) => reg.read(id)?.status !== "running"));
  // 读净输出后，第 21 个必须能起来：已结束的应被淘汰，而不是抛"上限"错误
  const extra = reg.start({ command: "true", cwd: dir, file: "/bin/bash", args: ["-c", "true"] });
  assert.match(extra, /^bash_\d+$/);
  reg.killAll();
});

test("回归：全部在运行时才报上限错，且 kill 后即可重试成功", async () => {
  const dir = await scratch("anicode-shell-cap2-");
  const reg = new ShellRegistry();
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    ids.push(
      reg.start({ command: "sleep 30", cwd: dir, file: "/bin/bash", args: ["-c", "sleep 30"] }),
    );
  }
  // 全在跑 → 应报错
  assert.throws(
    () => reg.start({ command: "true", cwd: dir, file: "/bin/bash", args: ["-c", "true"] }),
    /running|运行/,
  );
  // 按提示 kill 一个后，重试必须成功（否则提示就是空话）
  reg.kill(ids[0]!);
  const ok = reg.start({ command: "true", cwd: dir, file: "/bin/bash", args: ["-c", "true"] });
  assert.match(ok, /^bash_\d+$/);
  reg.killAll();
});

test("回归：filter 略过的行数被如实回报，不静默丢失", async () => {
  const dir = await scratch("anicode-shell-filtered-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "printf 'keep\\ndrop1\\ndrop2\\n'",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "printf 'keep\\ndrop1\\ndrop2\\n'"],
  });
  let r = reg.read(id, /keep/)!;
  for (let i = 0; i < 100 && !r.chunk.includes("keep"); i++) {
    await new Promise((res) => setTimeout(res, 20));
    r = reg.read(id, /keep/)!;
  }
  assert.match(r.chunk, /keep/);
  assert.ok(r.filtered > 0, "被 filter 略过的行数必须回报，而不是静默消失");
  reg.killAll();
});

test("回归：无输出时带 filter 读取不应凭空报出被略过的行", async () => {
  const dir = await scratch("anicode-shell-emptyfilter-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "sleep 30",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "sleep 30"],
  });
  const r = reg.read(id, /anything/)!;
  assert.equal(r.chunk, "");
  assert.equal(r.filtered, 0, "没有输出就不该报告任何行被略过（空串 split 的假行）");
  reg.killAll();
});

test("回归：末尾换行不会让略过行数多算一行", async () => {
  const dir = await scratch("anicode-shell-trailnl-");
  const reg = new ShellRegistry();
  const id = reg.start({
    command: "printf 'keep\\n'",
    cwd: dir,
    file: "/bin/bash",
    args: ["-c", "printf 'keep\\n'"],
  });
  let r = reg.read(id, /keep/)!;
  for (let i = 0; i < 100 && !r.chunk.includes("keep"); i++) {
    await new Promise((res) => setTimeout(res, 20));
    r = reg.read(id, /keep/)!;
  }
  assert.match(r.chunk, /keep/);
  assert.equal(r.filtered, 0, "唯一的一行匹配上了，末尾换行不应被算成被略过的行");
  reg.killAll();
});

test("回归：bash_output 在 filter 略过内容时给出明确提示", async () => {
  const dir = await scratch("anicode-bashoutput-note-");
  const out = await bashTool.run(
    { command: "printf 'keep\\nnoise1\\nnoise2\\n'", run_in_background: true },
    ctx(dir),
  );
  const id = /bash_\d+/.exec(out)![0];
  // 首行状态头会回显原命令（其中就含 "keep"），据此判断会在真输出到达前提前收敛 —— 只看正文。
  const bodyOf = (s: string) => s.split("\n").slice(1).join("\n");
  let text = "";
  for (let i = 0; i < 100; i++) {
    text = await bashOutputTool.run({ bash_id: id, filter: "keep" }, ctx(dir));
    if (bodyOf(text).includes("keep")) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(bodyOf(text), /keep/);
  assert.match(text, /略过|skipped/, "应提示有行被 filter 略过");
  shells.killAll();
});

test("ShellRegistry.write: 向 cat 进程写 stdin 并回显；end 发 EOF 使其退出", async () => {
  const dir = await scratch("anicode-shell-stdin-");
  const reg = new ShellRegistry();
  const id = reg.start({ command: "cat", cwd: dir, file: "/bin/cat", args: [] });
  assert.equal(reg.write(id, "你好 stdin\n"), true);
  let seen = "";
  await until(() => {
    const r = reg.read(id);
    if (r) seen += r.chunk;
    return seen.includes("你好 stdin");
  });
  reg.write(id, "", true); // EOF
  await until(() => {
    const r = reg.read(id);
    return (r?.status ?? "running") !== "running";
  });
  assert.equal(reg.write("bash_nonexistent", "x"), false);
  await fs.rm(dir, { recursive: true, force: true });
});

test("ShellRegistry.write: 已结束的 shell 报错", async () => {
  const dir = await scratch("anicode-shell-stdin-dead-");
  const reg = new ShellRegistry();
  const id = reg.start({ command: "true", cwd: dir, file: "/usr/bin/true", args: [] });
  await until(() => {
    const r = reg.read(id);
    return (r?.status ?? "running") !== "running";
  });
  assert.throws(() => reg.write(id, "x"), /不在运行|not running/);
  await fs.rm(dir, { recursive: true, force: true });
});

test("write_stdin / list_shells 工具：走共享注册表", async () => {
  const dir = await scratch("anicode-shell-tools2-");
  const { writeStdinTool, listShellsTool, startBackgroundShell } = await import("./shells.js");
  const c = ctx(dir);
  const started = startBackgroundShell("cat", { ...c, sandbox: "none" } as any);
  const id = /shell id: (bash_\d+)/.exec(started)![1]!;

  const listed = await listShellsTool.run({}, c);
  assert.match(listed, new RegExp(`${id} \\[running\\]`));

  const wrote = await writeStdinTool.run({ shell_id: id, input: "ping\n" }, c);
  assert.match(wrote, /5 字符|5 chars/);
  let seen = "";
  await until(() => {
    const r = shells.read(id);
    if (r) seen += r.chunk;
    return seen.includes("ping");
  });
  shells.kill(id);
  await assert.rejects(() => writeStdinTool.run({ shell_id: "bash_none", input: "x" }, c), /未知|Unknown/);
  await fs.rm(dir, { recursive: true, force: true });
});
