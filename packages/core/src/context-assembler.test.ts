import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ContextAssembler,
  browserUsageProvider,
  skillsProvider,
  type ContextProvider,
  type ContextProviderCtx,
} from "./context-assembler.js";
import { ToolRegistry, type Tool } from "./tools/tool.js";

function ctx(tools = new ToolRegistry()): ContextProviderCtx {
  return { cwd: os.tmpdir(), tools, markReadOnly: () => {} };
}

test("ContextAssembler: 按注册顺序收集贡献段，null 被跳过", async () => {
  const make = (id: string, out: string | null): ContextProvider => ({
    id,
    contribute: async () => out,
  });
  const asm = new ContextAssembler([make("a", "A"), make("b", null), make("c", "C")]);
  assert.deepEqual(await asm.collect(ctx()), ["A", "C"]);
});

test("ContextAssembler: 并发采集纯 provider，同时保序返回", async () => {
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  let fastStarted = false;
  const asm = new ContextAssembler([
    {
      id: "slow",
      async contribute() {
        await slow;
        return "SLOW";
      },
    },
    {
      id: "fast",
      async contribute() {
        fastStarted = true;
        return "FAST";
      },
    },
  ]);

  const pending = asm.collectContributions(ctx());
  await Promise.resolve();
  assert.equal(fastStarted, true, "后续纯 provider 不应被前一个 I/O 阻塞");
  releaseSlow();
  assert.deepEqual(await pending, [
    { id: "slow", content: "SLOW" },
    { id: "fast", content: "FAST" },
  ]);
});

test("ContextAssembler: serial provider 形成副作用顺序栅栏", async () => {
  const order: string[] = [];
  const provider = (
    id: string,
    options: { serial?: boolean; wait?: Promise<void> } = {},
  ): ContextProvider => ({
    id,
    ...(options.serial ? { serial: true } : {}),
    async contribute() {
      order.push(`${id}:start`);
      await options.wait;
      order.push(`${id}:end`);
      return id;
    },
  });
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const asm = new ContextAssembler([
    provider("a", { wait }),
    provider("b", { serial: true }),
    provider("c"),
  ]);

  const pending = asm.collect(ctx());
  await Promise.resolve();
  assert.deepEqual(order, ["a:start"]);
  release();
  assert.deepEqual(await pending, ["a", "b", "c"]);
  assert.deepEqual(order, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("browserUsageProvider: 未注册 browser 工具时无贡献，注册后注入用法指引", async () => {
  const p = browserUsageProvider();
  assert.equal(await p.contribute(ctx()), null);

  const fakeBrowser: Tool = {
    def: { name: "browser", description: "x", parameters: { type: "object" } },
    readOnly: true,
    ruleKey: () => "browser",
    run: async () => "",
  };
  const tools = new ToolRegistry();
  tools.register(fakeBrowser);
  const out = await p.contribute(ctx(tools));
  assert.ok(out && out.includes("browser"));
});

/** 隔离用户级 ~/.claude/skills：把 HOME 指到干净目录（与 skills.test.ts 同法）。 */
function isolateHome(t: { after: (fn: () => void) => void }, home: string): void {
  const oldHome = process.env["HOME"];
  const oldUserProfile = process.env["USERPROFILE"];
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  t.after(() => {
    if (oldHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = oldHome;
    if (oldUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = oldUserProfile;
  });
}

test("skillsProvider: 副作用三件套 —— 注册 skill 工具 + 并入只读 + 返回清单", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-asm-skill-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  isolateHome(t, dir);
  await fs.mkdir(path.join(dir, "my-skill"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "my-skill", "SKILL.md"),
    "---\nname: my-skill\ndescription: 测试技能\n---\n正文",
    "utf8",
  );
  const tools = new ToolRegistry();
  const marked: string[] = [];
  const p = skillsProvider({ dirs: [dir] });
  const out = await p.contribute({
    cwd: dir,
    tools,
    markReadOnly: (names) => marked.push(...names),
  });
  assert.ok(out && out.includes("my-skill"));
  assert.ok(tools.get("skill"), "skill 工具应被注册");
  assert.deepEqual(marked, ["skill"]);
});

test("skillsProvider: 无技能可发现时无贡献、零副作用", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "anicode-asm-empty-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  isolateHome(t, dir);
  const tools = new ToolRegistry();
  const p = skillsProvider(true);
  const out = await p.contribute({ cwd: dir, tools, markReadOnly: () => assert.fail("零副作用") });
  assert.equal(out, null);
  assert.equal(tools.get("skill"), undefined);
});
